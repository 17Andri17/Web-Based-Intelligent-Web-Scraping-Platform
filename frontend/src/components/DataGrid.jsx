import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import useDialog from "./useDialog";
import {
  buildColumns, buildView, toggleSort,
  formatCellValue, isEmptyValue, hasUntrimmedWhitespace,
} from "../utils/dataGrid";
import { profileColumns, findIssues, isIncompleteRow, duplicateRows } from "../utils/columnProfile";
import { loadGridView, saveGridView } from "../utils/gridPrefs";
import "../styles/DataGrid.css";

/* =====================================================================
   DataGrid — one sortable, filterable table for scraped rows.

   This replaces three unrelated table renderers that disagreed on
   everything. The job it is built for is not "display data" but "tell me
   whether this scrape is right", which is why the defaults lean towards
   showing damage: an empty cell is labelled rather than left blank, and
   whitespace the extraction should have trimmed is marked, because both
   are invisible until they reach a CSV and by then it's too late.

   The pure model (sorting, filtering, column discovery, type sniffing,
   profiling) lives in utils/dataGrid.js and utils/columnProfile.js so its
   semantics can be tested without a DOM. The server runs a port of the same
   rules, and shared/datagrid-vectors.json holds them to it — a dataset must
   not change its story depending on which side of the size threshold it
   happens to fall.

   Props:
     rows      array of record objects — everything happens in the browser
     source    async pager for datasets too large to ship whole:
                 fetchPage({ q, filters, sorts, columns, issue, limit, offset })
                   → { rows, rowKeys, columns, profiles, issues,
                       total, unfilteredTotal }
                 fetchRow(rowKey) → the full, unprojected record (optional)
               Supply one or the other, never both.
     maxRows   client-mode render cap; beyond it the grid shows the first N
               and says so
     viewKey   stable id for this table; its column arrangement, density,
               page size and sort are remembered under it (utils/gridPrefs)
     label     what produced these rows, so an empty table can name it
     onViewChange(view)  the current filter/sort, for an export that has to
               reproduce what is on screen

   Keyboard: Tab reaches the rows, arrows walk them, Enter opens one,
   Ctrl/Cmd+C copies one, `/` jumps to the search box, Escape closes the
   row detail (via useDialog's stack, so the panel behind stays open).
   ===================================================================== */

const MAX_ROWS   = 5000;
const PAGE_SIZES = [50, 100, 250, 500];
const EMPTY_ROWS = [];

/* Typing must not fire a request per keystroke, but a click should not wait.
   So only the two text-driven inputs are debounced; sorting, paging and
   column changes go straight out. */
const TYPING_DEBOUNCE_MS = 250;

function useDebounced(value, ms) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (!ms) { setSettled(value); return undefined; }
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export default function DataGrid({
  rows, source = null, maxRows = MAX_ROWS, onViewChange = null,
  viewKey = null, label = null,
}) {
  /* Two ways in. `rows` is an array already in memory and everything happens
     in the browser — instant, and what the overwhelming majority of scrapes
     get. `source` is an async pager for datasets too large to ship whole, and
     the server does the same filtering, sorting and profiling using a port of
     the very same rules (see backend/services/datasetView.service.js). The
     grid below this line does not care which it got. */
  const isServer = !!source;

  // The saved layout for this table, read once. Arrangement only — nothing
  // that changes which rows exist comes back on its own. See gridPrefs.js.
  const saved = useRef(loadGridView(viewKey)).current || {};

  const [sorts,       setSorts]       = useState(saved.sorts || []);
  const [query,       setQuery]       = useState("");
  const [filters,     setFilters]     = useState({});
  const [showFilters, setShowFilters] = useState(false);
  const [hidden,      setHidden]      = useState(saved.hidden || {});
  const [order,       setOrder]       = useState(saved.order || []);
  const [density,     setDensity]     = useState(saved.density || "compact");
  const [pageSize,    setPageSize]    = useState(saved.pageSize || 100);
  const [page,        setPage]        = useState(0);
  const [selected,    setSelected]    = useState(null);   // the row in the drawer
  const [colsOpen,    setColsOpen]    = useState(false);
  const [dragId,      setDragId]      = useState(null);
  const [focusIssue,  setFocusIssue]  = useState(null);   // 'incomplete' | 'duplicates'
  const [flashed,     setFlashed]     = useState(null);   // column briefly highlighted
  const [cursor,      setCursor]      = useState(-1);     // keyboard row, index into the page
  const [copied,      setCopied]      = useState(null);   // transient "Copied" acknowledgement
  const [filterMenu,  setFilterMenu]  = useState(null);   // column whose operator menu is open
  const scrollRef  = useRef(null);
  const flashTimer = useRef(null);
  const copyTimer  = useRef(null);
  const searchRef  = useRef(null);
  const bodyRef    = useRef(null);

  // Persist the arrangement whenever it changes. Small and infrequent, so it
  // writes straight through rather than debouncing.
  useEffect(() => {
    if (!viewKey) return;
    saveGridView(viewKey, { order, hidden, density, pageSize, sorts });
  }, [viewKey, order, hidden, density, pageSize, sorts]);

  const all = isServer ? EMPTY_ROWS : (Array.isArray(rows) ? rows : EMPTY_ROWS);

  /* A run can publish tens of thousands of rows and they all arrive in
     browser memory. Rendering the lot would lock the tab for a preview
     nobody scrolls to the end of, so the grid takes the first N and says
     what it did — a silent truncation is how the old preview hid the
     problem. Sorting and filtering apply to what is loaded.
     Server mode has no such cap: it never holds more than a page. */
  const capped    = useMemo(() => (all.length > maxRows ? all.slice(0, maxRows) : all), [all, maxRows]);
  const truncated = !isServer && all.length > capped.length;

  const clientColumns = useMemo(() => buildColumns(capped), [capped]);

  /* Profiles are computed over every LOADED row, never over the visible
     page — a fill rate describing 100 rows out of 4,000 reads as
     authoritative and isn't. Memoised on the data, so paging, sorting and
     filtering never recompute it. The server computes the same thing the
     same way, over the whole dataset. */
  const clientProfiles = useMemo(() => profileColumns(capped, clientColumns), [capped, clientColumns]);
  const clientIssues   = useMemo(
    () => findIssues(capped, clientColumns, clientProfiles),
    [capped, clientColumns, clientProfiles]
  );

  // What the server last sent back. Rows are kept across a reload so the
  // table can dim rather than blank while the next page is in flight.
  const [remote, setRemote] = useState({
    rows: [], rowKeys: [], columns: [], profiles: {}, issues: [],
    total: 0, unfilteredTotal: 0, loading: !!source, error: null,
  });

  const columns  = isServer ? remote.columns  : clientColumns;
  const profiles = isServer ? remote.profiles : clientProfiles;
  const issues   = isServer ? remote.issues   : clientIssues;

  const types = useMemo(() => {
    const out = {};
    for (const id of columns) out[id] = profiles[id]?.type;
    return out;
  }, [columns, profiles]);

  /* Column order and visibility are derived, never stored as a snapshot of
     the column list. A run that is still going can grow new columns
     mid-stream; deriving means a new column simply appears at the end
     instead of resetting everything the user has set up. */
  const ordered = useMemo(() => {
    const known = new Set(columns);
    const head  = order.filter(id => known.has(id));
    const seen  = new Set(head);
    return [...head, ...columns.filter(id => !seen.has(id))];
  }, [columns, order]);

  const visible = useMemo(() => ordered.filter(id => !hidden[id]), [ordered, hidden]);

  // Columns that vanished between runs must not keep filtering or sorting.
  const activeFilters = useMemo(() => {
    const out = {};
    for (const [id, expr] of Object.entries(filters)) {
      if (columns.includes(id) && String(expr ?? "").trim()) out[id] = expr;
    }
    return out;
  }, [filters, columns]);
  const activeSorts = useMemo(() => sorts.filter(s => columns.includes(s.id)), [sorts, columns]);

  const sparseIssue = issues.find(i => i.kind === "sparse");

  // The set of duplicated rows is only worth computing when it's being used.
  const dupeSet = useMemo(
    () => (focusIssue === "duplicates" ? duplicateRows(capped, columns) : null),
    [focusIssue, capped, columns]
  );

  /* An issue chip narrows to rows rather than to a column value, which no
     column filter can express — hence the whole-row predicate. */
  const rowFilter = useMemo(() => {
    if (focusIssue === "incomplete" && sparseIssue?.rowColumns?.length) {
      return (row) => isIncompleteRow(row, sparseIssue.rowColumns);
    }
    if (focusIssue === "duplicates" && dupeSet) return (row) => dupeSet.has(row);
    return null;
  }, [focusIssue, sparseIssue, dupeSet]);

  const clientView = useMemo(
    () => (isServer ? EMPTY_ROWS
      : buildView(capped, { filters: activeFilters, query, searchColumns: visible, sorts: activeSorts, types, rowFilter })),
    [isServer, capped, activeFilters, query, visible, activeSorts, types, rowFilter]
  );

  // Columns where the scrape got nothing at all — the one-click declutter.
  const emptyColumns = useMemo(
    () => columns.filter(id => profiles[id]?.total > 0 && profiles[id]?.filled === 0),
    [columns, profiles]
  );

  const total     = isServer ? remote.total : clientView.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage  = Math.min(page, pageCount - 1);
  const start     = safePage * pageSize;
  // The server already sliced; the client still has to.
  const pageRows  = isServer ? remote.rows : clientView.slice(start, start + pageSize);

  // A filter or a page change can shrink the page out from under the
  // keyboard cursor; keep it on a row that exists.
  useEffect(() => {
    setCursor(c => (c < 0 ? c : Math.min(c, pageRows.length - 1)));
  }, [pageRows.length]);

  const filterCount = Object.keys(activeFilters).length + (query.trim() ? 1 : 0) + (focusIssue ? 1 : 0);
  const isFiltered  = filterCount > 0;
  const grandTotal  = isServer ? remote.unfilteredTotal : capped.length;

  /* ── Server fetch ───────────────────────────────────────────────────
     Typing is debounced; everything else fires at once. `columns` is only
     sent once the user has actually hidden something — sending the full
     list on the first response would change the request and cost a second
     round-trip for no payload saving. */
  const debouncedQuery   = useDebounced(query, isServer ? TYPING_DEBOUNCE_MS : 0);
  const debouncedFilters = useDebounced(activeFilters, isServer ? TYPING_DEBOUNCE_MS : 0);
  const hiddenCount      = Object.keys(hidden).length;
  const columnsParam     = hiddenCount > 0 ? visible.join(",") : "";

  const requestKey = JSON.stringify({
    q: debouncedQuery.trim(), filters: debouncedFilters, sorts: activeSorts,
    columns: columnsParam, issue: focusIssue, limit: pageSize, offset: start,
  });

  /* What the grid is currently showing, minus the page. An export offered
     alongside it has to be able to produce the same rows — downloading
     something different from what is on screen is a bug report waiting to
     happen — and only the owner of the export button can wire that up. */
  const reportedView = JSON.stringify({
    q: debouncedQuery.trim(), filters: debouncedFilters, sorts: activeSorts,
    columns: columnsParam, issue: focusIssue,
  });
  useEffect(() => {
    if (onViewChange) onViewChange(JSON.parse(reportedView));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportedView]);

  // Only the newest request may write state; a slow one that lands late must
  // not overwrite the page the user is already looking at.
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!source) return undefined;
    const seq = ++requestSeq.current;
    let alive = true;
    setRemote(prev => ({ ...prev, loading: true, error: null }));

    Promise.resolve(source.fetchPage(JSON.parse(requestKey)))
      .then(res => {
        if (!alive || seq !== requestSeq.current) return;
        setRemote({
          rows: res.rows || [],
          rowKeys: res.rowKeys || [],
          columns: res.columns || [],
          profiles: res.profiles || {},
          issues: res.issues || [],
          total: res.total || 0,
          unfilteredTotal: res.unfilteredTotal ?? res.total ?? 0,
          loading: false,
          error: null,
        });
      })
      .catch(err => {
        if (!alive || seq !== requestSeq.current) return;
        setRemote(prev => ({ ...prev, loading: false, error: err?.message || "Could not load this page" }));
      });

    return () => { alive = false; };
    // requestKey is the serialised form of every dependency above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, requestKey]);

  // ── actions ──────────────────────────────────────────────────────────
  const onSort = useCallback((id, additive) => {
    setSorts(prev => toggleSort(prev, id, additive));
    setPage(0);
  }, []);

  const setFilter = useCallback((id, value) => {
    setFilters(prev => ({ ...prev, [id]: value }));
    setPage(0);
  }, []);

  const toggleColumn = useCallback((id) => {
    setHidden(prev => {
      const next = { ...prev };
      if (next[id]) delete next[id]; else next[id] = true;
      return next;
    });
  }, []);

  const moveColumn = useCallback((id, delta) => {
    setOrder(() => {
      const list = [...ordered];
      const from = list.indexOf(id);
      const to   = from + delta;
      if (from < 0 || to < 0 || to >= list.length) return list;
      list.splice(to, 0, list.splice(from, 1)[0]);
      return list;
    });
  }, [ordered]);

  const dropColumn = useCallback((targetId) => {
    setOrder(() => {
      const list = [...ordered];
      const from = list.indexOf(dragId);
      const to   = list.indexOf(targetId);
      if (from < 0 || to < 0 || from === to) return list;
      list.splice(to, 0, list.splice(from, 1)[0]);
      return list;
    });
    setDragId(null);
  }, [ordered, dragId]);

  const resetAll = useCallback(() => {
    setSorts([]); setQuery(""); setFilters({}); setShowFilters(false);
    setHidden({}); setOrder([]); setPage(0); setSelected(null); setFocusIssue(null);
    setCursor(-1); setFilterMenu(null);
  }, []);

  /* ── Copying ────────────────────────────────────────────────────────
     Scraped data exists to be pasted somewhere else, so getting it out
     should not require an export and a spreadsheet. Rows and columns copy
     in the shapes a spreadsheet expects: tab-separated across, newline
     down. `note` is what the acknowledgement says — always with a count,
     because in server mode "the column" means the loaded page and the
     number is what tells you so. */
  const flashCopied = useCallback((note) => {
    setCopied(note);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1800);
  }, []);

  const copyText = useCallback(async (text, note) => {
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(note);
    } catch (_) {
      flashCopied("Copy blocked by the browser");
    }
  }, [flashCopied]);

  const copyRow = useCallback((row) => {
    const cells = visible.map(id => formatCellValue(row[id]).replace(/\s+/g, " "));
    copyText(visible.join("\t") + "\n" + cells.join("\t"), "Row copied");
  }, [visible, copyText]);

  /* Client mode copies the whole filtered view; server mode can only copy
     what it has, which is the loaded page. The count in the acknowledgement
     is what makes the difference visible instead of surprising. */
  const copyColumn = useCallback((id) => {
    const from = isServer ? pageRows : clientView;
    const values = from.map(r => formatCellValue(r[id]).replace(/\s+/g, " "));
    copyText(values.join("\n"), `Copied ${values.length} value${values.length === 1 ? "" : "s"}`);
  }, [isServer, pageRows, clientView, copyText]);

  /* ── Keyboard ───────────────────────────────────────────────────────
     A table you can only drive with a mouse is a table you scroll rather
     than read. Rows carry a roving tabindex so Tab reaches the data and
     the arrows walk it; `/` jumps to the search box the way it does in
     every other tool that has one.

     Everything here no-ops while the focus is in a text field, or the
     filter row would be unusable — typing "desk" would page the table. */
  const moveCursor = useCallback((next) => {
    if (pageRows.length === 0) return;
    const clamped = Math.max(0, Math.min(next, pageRows.length - 1));
    setCursor(clamped);
    const el = bodyRef.current?.querySelector(`tr[data-i="${clamped}"]`);
    el?.focus({ preventScroll: false });
  }, [pageRows.length]);

  const onKeyDown = useCallback((e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select";

    if (e.key === "/" && !typing) {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }
    if (typing) return;

    if (e.key === "ArrowDown")  { e.preventDefault(); moveCursor(cursor + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveCursor(cursor - 1); }
    else if (e.key === "Home")    { e.preventDefault(); moveCursor(0); }
    else if (e.key === "End")     { e.preventDefault(); moveCursor(pageRows.length - 1); }
    else if (e.key === "Enter" && cursor >= 0 && pageRows[cursor]) {
      e.preventDefault();
      setSelected({ row: pageRows[cursor], index: start + cursor + 1, rowKey: remote.rowKeys[cursor] });
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && cursor >= 0 && pageRows[cursor]) {
      // Only when nothing is selected — a real text selection should copy
      // itself, not be hijacked into copying the whole row.
      if (String(window.getSelection() || "") === "") {
        e.preventDefault();
        copyRow(pageRows[cursor]);
      }
    }
  }, [cursor, pageRows, start, remote.rowKeys, moveCursor, copyRow]);

  const clearFilters = useCallback(() => {
    setFilters({}); setQuery(""); setFocusIssue(null); setPage(0);
  }, []);

  // Narrow to the rows behind an issue chip; clicking the active one clears it.
  const focusOn = useCallback((kind) => {
    setFocusIssue(prev => (prev === kind ? null : kind));
    setPage(0);
  }, []);

  /* A column named in a chip may be off-screen behind a horizontal scroll,
     so bring it into view and mark it for a moment. Deliberately NOT a
     filter or a hide: the chip's job is to point at the column, and what to
     do about it is the user's call. */
  const revealColumn = useCallback((id) => {
    if (hidden[id]) {
      setHidden(prev => { const next = { ...prev }; delete next[id]; return next; });
    }
    setFlashed(id);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashed(null), 1600);
    // Timeout, not an animation frame: this only needs to run after React has
    // committed the column being visible again, and rAF never fires in a
    // background tab.
    setTimeout(() => {
      const th = scrollRef.current?.querySelector(`th[data-col="${CSS.escape(id)}"]`);
      th?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }, 0);
  }, [hidden]);

  // ── nothing tabular to show ──────────────────────────────────────────
  /* An empty state that names the thing that came back empty. "No data" is
     true of every empty table in the world and tells you nothing; the step
     label is what you go and look at. */
  if (columns.length === 0) {
    if (isServer && remote.loading) return <div className="dg-blank">Loading…</div>;
    if (isServer && remote.error) {
      return <div className="dg-blank dg-blank-err">{remote.error}</div>;
    }
    const named = label ? <strong>{label}</strong> : "This step";
    return (
      <div className="dg-blank">
        {(isServer ? remote.total === 0 : all.length === 0)
          ? <>{named} produced no rows. Check its selector still matches the page.</>
          : <>The rows {named} produced have no fields to show as columns.</>}
      </div>
    );
  }

  const sortFor = (id) => activeSorts.find(s => s.id === id);
  const sortRank = (id) => (activeSorts.length > 1 ? activeSorts.findIndex(s => s.id === id) + 1 : 0);

  return (
    <div className={`dg dg-${density}`} onKeyDown={onKeyDown}>
      {/* ── Toolbar ───────────────────────────────────────────────── */}
      <div className="dg-toolbar">
        <label className="dg-search">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search rows"
            aria-label="Search all visible columns"
            onChange={e => { setQuery(e.target.value); setPage(0); }}
          />
        </label>

        <button
          type="button"
          className={`dg-btn ${showFilters ? "on" : ""}`}
          aria-pressed={showFilters}
          onClick={() => setShowFilters(v => !v)}
        >
          <FilterIcon /> Filters
          {filterCount > 0 && <span className="dg-count">{filterCount}</span>}
        </button>

        <div className="dg-pop-host">
          <button
            type="button"
            className="dg-btn"
            aria-expanded={colsOpen}
            onClick={() => setColsOpen(v => !v)}
          >
            <ColumnsIcon /> Columns
            <span className="dg-count">{visible.length}/{columns.length}</span>
          </button>

          {colsOpen && (
            <>
              <div className="dg-pop-catch" onClick={() => setColsOpen(false)} />
              <div className="dg-pop" role="group" aria-label="Show, hide and reorder columns">
                <div className="dg-pop-head">
                  <span>Columns</span>
                  <span className="dg-pop-actions">
                    {emptyColumns.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setHidden(prev => {
                          const next = { ...prev };
                          emptyColumns.forEach(id => { next[id] = true; });
                          return next;
                        })}
                      >
                        Hide {emptyColumns.length} empty
                      </button>
                    )}
                    <button type="button" onClick={() => setHidden({})}>Show all</button>
                  </span>
                </div>

                <ul className="dg-pop-list">
                  {ordered.map((id, i) => (
                    <li
                      key={id}
                      className={`dg-pop-row ${dragId === id ? "dragging" : ""}`}
                      draggable
                      onDragStart={() => setDragId(id)}
                      onDragEnd={() => setDragId(null)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={() => dropColumn(id)}
                    >
                      <label>
                        <input
                          type="checkbox"
                          checked={!hidden[id]}
                          onChange={() => toggleColumn(id)}
                        />
                        <span className="dg-pop-name">{id}</span>
                        {emptyColumns.includes(id)
                          ? <span className="dg-pop-tag">empty</span>
                          : profiles[id]?.constant
                            ? <span className="dg-pop-tag">constant</span>
                            : null}
                      </label>
                      <span className="dg-pop-move">
                        <button type="button" aria-label={`Copy the ${id} column`}
                          title={isServer ? "Copy this column, for the rows loaded" : "Copy this column"}
                          onClick={() => copyColumn(id)}>⧉</button>
                        <button type="button" aria-label={`Move ${id} earlier`}
                          disabled={i === 0} onClick={() => moveColumn(id, -1)}>↑</button>
                        <button type="button" aria-label={`Move ${id} later`}
                          disabled={i === ordered.length - 1} onClick={() => moveColumn(id, 1)}>↓</button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>

        <span className="dg-spacer" />

        <div className="dg-seg" role="group" aria-label="Row height">
          <button type="button" aria-pressed={density === "compact"}
            onClick={() => setDensity("compact")}>Compact</button>
          <button type="button" aria-pressed={density === "roomy"}
            onClick={() => setDensity("roomy")}>Roomy</button>
        </div>

        <button type="button" className="dg-btn" onClick={resetAll}>Reset</button>
      </div>

      <IssueStrip
        issues={issues}
        /* The size of the whole dataset, not of what is loaded: in server
           mode only a page is in memory, and the strip must still speak for
           everything behind it. */
        rowCount={grandTotal}
        focusIssue={focusIssue}
        onFocus={focusOn}
        onReveal={revealColumn}
      />

      {/* ── Grid ──────────────────────────────────────────────────── */}
      <div className={`dg-scroll${isServer && remote.loading ? " is-loading" : ""}`} ref={scrollRef}>
        <table className="dg-table">
          <thead>
            <tr>
              <th className="dg-num" scope="col"><span className="dg-sr">Row</span></th>
              {visible.map((id, ci) => {
                const s = sortFor(id);
                const rank = sortRank(id);
                const p = profiles[id] || {};
                return (
                  <th
                    key={id}
                    scope="col"
                    data-col={id}
                    className={[ci === 0 ? "dg-pin" : "", flashed === id ? "dg-flash" : ""].filter(Boolean).join(" ") || undefined}
                    aria-sort={s ? (s.dir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    {/* Fixed-height wrapper: the filter row sticks directly
                        under this, so the header's parts have to add up to
                        --dg-head-h exactly rather than approximately. */}
                    <div className="dg-th-wrap">
                      <button
                        type="button"
                        className="dg-th"
                        onClick={e => onSort(id, e.shiftKey)}
                        title="Click to sort · Shift-click to add to the sort"
                      >
                        <span className="dg-th-name">{id}</span>
                        <span className="dg-th-kind">{p.constant ? "constant" : p.type}</span>
                        {s && <span className="dg-th-arrow">{s.dir === "asc" ? "▲" : "▼"}</span>}
                        {rank > 0 && <span className="dg-th-rank">{rank}</span>}
                        {/* Any gap at all colours the number, so a column with
                            one missing value in ten thousand still reads as
                            different from a complete one at a glance. */}
                        <span className={`dg-th-fill${p.empty > 0 ? " has-gaps" : ""}`}>
                          {p.empty > 0 && <span className="dg-gap-dot" aria-hidden="true" />}
                          {p.fillPct}%
                        </span>
                      </button>
                      <FillBar id={id} profile={p} onShowGaps={setFilter} showFilters={setShowFilters} />
                    </div>
                  </th>
                );
              })}
            </tr>

            {showFilters && (
              <tr className="dg-filters">
                <td className="dg-num" />
                {visible.map((id, ci) => (
                  <td key={id} className={ci === 0 ? "dg-pin" : undefined}>
                    <FilterCell
                      id={id}
                      type={types[id]}
                      value={filters[id] ?? ""}
                      active={!!activeFilters[id]}
                      open={filterMenu === id}
                      onOpen={() => setFilterMenu(m => (m === id ? null : id))}
                      onClose={() => setFilterMenu(null)}
                      onChange={(v) => setFilter(id, v)}
                    />
                  </td>
                ))}
              </tr>
            )}
          </thead>

          <tbody ref={bodyRef}>
            {pageRows.map((row, i) => (
              <tr
                key={start + i}
                data-i={i}
                /* Roving tabindex: one row is in the tab order at a time, so
                   Tab reaches the data and the arrows walk it from there. */
                tabIndex={(cursor < 0 ? i === 0 : cursor === i) ? 0 : -1}
                className={cursor === i ? "dg-cursor" : undefined}
                aria-selected={selected?.row === row}
                onFocus={() => setCursor(i)}
                onClick={() => { setCursor(i); setSelected({ row, index: start + i + 1, rowKey: remote.rowKeys[i] }); }}
                title="Open this row · Ctrl+C to copy it"
              >
                <td className="dg-num">{start + i + 1}</td>
                {visible.map((id, ci) => (
                  <td
                    key={id}
                    className={[
                      ci === 0 ? "dg-pin" : "",
                      flashed === id ? "dg-flash" : "",
                      profiles[id]?.constant ? "dg-constcol" : "",
                    ].filter(Boolean).join(" ") || undefined}
                  >
                    <Cell value={row[id]} type={types[id]} />
                  </td>
                ))}
              </tr>
            ))}

            {pageRows.length === 0 && (
              <tr className="dg-norows">
                <td colSpan={visible.length + 1}>
                  No rows match these filters.
                  <button type="button" className="dg-link" onClick={clearFilters}>Clear filters</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Footer ────────────────────────────────────────────────── */}
      <div className="dg-foot">
        <span className="dg-foot-info">
          <b>{total.toLocaleString()}</b>
          {/* "1 of 500 rows" — the noun agrees with the number nearest it,
              which when filtered is the grand total, not the match count. */}
          {isFiltered ? ` of ${grandTotal.toLocaleString()}` : ""}
          {` row${(isFiltered ? grandTotal : total) === 1 ? "" : "s"}`}
          {isFiltered && ` · ${filterCount} filter${filterCount === 1 ? "" : "s"}`}
          {truncated && (
            <span className="dg-warn" title={`This run produced ${all.length.toLocaleString()} rows; the preview loads the first ${maxRows.toLocaleString()}. Export for the full set.`}>
              {" "}· first {maxRows.toLocaleString()} of {all.length.toLocaleString()}
            </span>
          )}
          {/* Say which world you are in: someone debugging a filter that feels
              slow should not have to guess whether it is a round-trip. */}
          {isServer && <span className="dg-mode" title="This dataset is filtered and sorted on the server">{" "}· server-side</span>}
          {isServer && remote.error && <span className="dg-warn">{" "}· {remote.error}</span>}
          {copied && <span className="dg-copied" role="status">{" "}· {copied}</span>}
        </span>

        <label className="dg-pagesize">
          Rows
          <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(0); }}>
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>

        <span className="dg-pager">
          <button type="button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>‹ Prev</button>
          <span className="dg-range">
            {total === 0 ? "0" : `${(start + 1).toLocaleString()}–${Math.min(start + pageSize, total).toLocaleString()}`}
          </span>
          <button type="button" disabled={start + pageSize >= total} onClick={() => setPage(safePage + 1)}>Next ›</button>
        </span>
      </div>

      {selected && (
        <RowDrawer
          row={selected.row}
          columns={ordered}
          hidden={hidden}
          index={selected.index}
          /* In server mode the page may have arrived projected and clipped,
             so the drawer — whose entire job is showing the whole value —
             re-fetches the record in full. */
          fetchFull={isServer && selected.rowKey != null && source.fetchRow
            ? () => source.fetchRow(selected.rowKey)
            : null}
          onCopy={copyText}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/* ─── Filter cell ───────────────────────────────────────────────────────
   The filter box understands a small operator language, and a language
   nobody can see is a language nobody uses. "Is empty" in particular is
   the single most useful filter on scraped data — it is how you get from
   "some prices are missing" to "these fourteen rows" — and it was reachable
   only by typing a bare `=` or knowing the fill bar was clickable.

   So the operators get a menu. Picking one writes its syntax into the box,
   which answers the immediate question and teaches the shorthand for next
   time. */
const FILTER_OPS = [
  { label: "Contains…",   expr: "",     hint: "text" },
  { label: "Is empty",    expr: "=",    hint: "nothing was scraped" },
  { label: "Is not empty", expr: "!=",  hint: "anything at all" },
  { label: "Exactly…",    expr: '""',   hint: "whole value" },
];
const NUMERIC_OPS = [
  { label: "Greater than…", expr: ">",  hint: "e.g. >100" },
  { label: "Less than…",    expr: "<",  hint: "e.g. <100" },
];

function FilterCell({ id, type, value, active, open, onOpen, onClose, onChange }) {
  const inputRef = useRef(null);
  const numeric = type === "number" || type === "money" || type === "date";
  const ops = numeric ? FILTER_OPS.concat(NUMERIC_OPS) : FILTER_OPS;

  const pick = (op) => {
    onChange(op.expr);
    onClose();
    /* Land the caret where the value goes: inside the quotes for an exact
       match, after the operator for a comparison. A timeout rather than an
       animation frame — this only needs to be after React has committed the
       new value, and rAF does not fire at all in a background tab. */
    setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const at = op.expr === '""' ? 1 : op.expr.length;
      try { el.setSelectionRange(at, at); } catch (_) { /* type=search on old engines */ }
    }, 0);
  };

  return (
    <div className="dg-filtercell">
      <input
        ref={inputRef}
        value={value}
        className={active ? "active" : undefined}
        placeholder={numeric ? ">100" : "contains…"}
        aria-label={`Filter ${id}`}
        onChange={e => onChange(e.target.value)}
      />
      <button
        type="button"
        className="dg-filterop"
        aria-label={`Filter options for ${id}`}
        aria-expanded={open}
        title="Filter options"
        onClick={onOpen}
      >⌄</button>

      {open && (
        <>
          <div className="dg-pop-catch" onClick={onClose} />
          <div className="dg-opmenu" role="menu">
            {ops.map(op => (
              <button key={op.label} type="button" role="menuitem" onClick={() => pick(op)}>
                <span className="dg-opmenu-label">{op.label}</span>
                <code>{op.expr || "abc"}</code>
                <span className="dg-opmenu-hint">{op.hint}</span>
              </button>
            ))}
            {value && (
              <button type="button" role="menuitem" className="dg-opmenu-clear"
                onClick={() => { onChange(""); onClose(); }}>
                Clear this filter
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Fill bar ──────────────────────────────────────────────────────────
   The one signal worth a permanent place under every header. Green is what
   the scrape got, red is what it missed, and clicking the red jumps
   straight to those rows — "which 14 products lost their price?" in one
   click rather than a scroll and a squint.

   A constant column is drawn amber across the full width instead: it is
   100% filled, so a fill bar would call it perfect while it is very
   probably a selector that matched a page banner. */
function FillBar({ id, profile, onShowGaps, showFilters }) {
  const { fillPct = 0, filled = 0, total = 0, empty = 0, constant } = profile;

  if (constant) {
    return (
      <div className="dg-bar" title={`Every one of the ${filled} filled rows has the same value — usually a selector that matched something outside the repeating row.`}>
        <span className="dg-bar-const" style={{ width: "100%" }} />
      </div>
    );
  }
  if (empty === 0) {
    return (
      <div className="dg-bar" title={`All ${total} rows have a value`}>
        <span className="dg-bar-ok" style={{ width: "100%" }} />
      </div>
    );
  }
  return (
    <button
      type="button"
      className="dg-bar dg-bar-btn"
      title={`${empty} of ${total} rows are missing ${id} — click to see them`}
      aria-label={`${id} is missing on ${empty} of ${total} rows; show them`}
      onClick={() => { showFilters(true); onShowGaps(id, "="); }}
    >
      <span className="dg-bar-ok" style={{ width: `${fillPct}%` }} />
      {/* CSS gives this a minimum width: one missing row in ten thousand is
          0.01% of the bar, which rounds to no pixels and no warning. */}
      <span className="dg-bar-gap" style={{ width: `${100 - fillPct}%` }} />
    </button>
  );
}

/* ─── Issue strip ───────────────────────────────────────────────────────
   The profile, rolled up to what someone should actually do something
   about. Capped at the four kinds on purpose — a strip nobody can scan in
   one glance is a strip nobody reads.

   The all-clear chip earns its place: confirming the scrape looks right is
   the thing people opened this panel for, and silence doesn't say it. */
function IssueStrip({ issues, rowCount, focusIssue, onFocus, onReveal }) {
  if (rowCount === 0) return null;

  const sparse   = issues.find(i => i.kind === "sparse");
  const constant = issues.find(i => i.kind === "constant");
  const mixed    = issues.find(i => i.kind === "mixed");
  const dupes    = issues.find(i => i.kind === "duplicates");

  if (issues.length === 0) {
    return (
      <div className="dg-issues">
        <span className="dg-chip ok"><i />No gaps, duplicates or constant columns</span>
      </div>
    );
  }

  const names = (cols) => cols.slice(0, 3).join(", ") + (cols.length > 3 ? ` +${cols.length - 3}` : "");

  return (
    <div className="dg-issues">
      {sparse && sparse.rows > 0 && (
        <button
          type="button"
          className={`dg-chip bad ${focusIssue === "incomplete" ? "on" : ""}`}
          aria-pressed={focusIssue === "incomplete"}
          title={`Columns with gaps: ${sparse.columns.join(", ")}`}
          onClick={() => onFocus("incomplete")}
        >
          <i />{sparse.rows.toLocaleString()} row{sparse.rows === 1 ? "" : "s"} missing a value
          <b>{names(sparse.rowColumns)}</b>
        </button>
      )}

      {/* A column empty on EVERY row has no rows to show, so it reads as a
          column fault rather than a row one. */}
      {sparse && sparse.rows === 0 && (
        <button type="button" className="dg-chip bad" onClick={() => onReveal(sparse.columns[0])}>
          <i />{sparse.columns.length} empty column{sparse.columns.length === 1 ? "" : "s"}
          <b>{names(sparse.columns)}</b>
        </button>
      )}

      {constant && (
        <button
          type="button"
          className="dg-chip warn"
          title="One value repeated down the whole column — usually a selector that matched a page-level element instead of something inside each row. Click to jump to it."
          onClick={() => onReveal(constant.columns[0])}
        >
          <i />identical on {constant.everywhere ? "every row" : "every filled row"}
          <b>{names(constant.columns)}</b>
        </button>
      )}

      {mixed && (
        <button
          type="button"
          className="dg-chip warn"
          title="The values in this column don't agree about what they are — often two different elements matched by one selector. Click to jump to it."
          onClick={() => onReveal(mixed.columns[0])}
        >
          <i />mixed value types<b>{names(mixed.columns)}</b>
        </button>
      )}

      {dupes && (
        <button
          type="button"
          className={`dg-chip warn ${focusIssue === "duplicates" ? "on" : ""}`}
          aria-pressed={focusIssue === "duplicates"}
          title="Rows captured more than once — what a pagination loop revisiting a page looks like."
          onClick={() => onFocus("duplicates")}
        >
          <i />{dupes.rows.toLocaleString()} duplicate rows
        </button>
      )}
    </div>
  );
}

/* ─── One cell ──────────────────────────────────────────────────────────
   Empty is labelled, not left blank: a blank cell and a cell holding a
   space look identical, and the difference is the whole question. */
function Cell({ value, type }) {
  if (isEmptyValue(value)) return <span className="dg-empty">empty</span>;
  const text  = formatCellValue(value);
  const messy = hasUntrimmedWhitespace(value);
  return (
    <span
      className={`dg-v dg-v-${type}${messy ? " dg-messy" : ""}`}
      title={messy ? `Untrimmed whitespace around: ${text.trim()}` : text}
    >
      {text.replace(/\s+/g, " ")}
    </span>
  );
}

/* ─── Row detail ────────────────────────────────────────────────────────
   The full record, untruncated, including the columns hidden from the
   table — a field you hid is still a field the scrape produced.

   Built on useDialog so Escape peels this off first and leaves the run
   panel behind it open; that layering is exactly what the hook's stack is
   for, and focus returns to the row on close. */
function RowDrawer({ row, columns, hidden, index, onClose, fetchFull = null, onCopy = null }) {
  const { overlayProps, dialogProps } = useDialog({ open: true, onClose });
  const [full, setFull] = useState(null);
  const [fullErr, setFullErr] = useState(null);

  useEffect(() => {
    if (!fetchFull) return undefined;
    let alive = true;
    Promise.resolve(fetchFull())
      .then(r => { if (alive && r) setFull(r); })
      .catch(e => { if (alive) setFullErr(e?.message || "Could not load the full record"); });
    return () => { alive = false; };
    // One fetch per opened row; the drawer is remounted for the next one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show the page's copy immediately, then swap in the unclipped one.
  const shown = full || row;

  return (
    <div className="dg-drawer-scrim" {...overlayProps}>
      <aside className="dg-drawer" {...dialogProps} aria-label={`Row ${index} detail`}>
        <div className="dg-drawer-head">
          <h4>Row {index.toLocaleString()}</h4>
          <button type="button" className="dg-drawer-close" onClick={onClose} aria-label="Close row">
            <XIcon />
          </button>
        </div>
        {/* tabIndex makes the scroll region reachable by keyboard — a long
            record is otherwise unscrollable without a mouse, since the close
            button is the only focusable thing in here. */}
        <dl className="dg-drawer-body" tabIndex={0}>
          {fullErr && <div className="dg-drawer-note">{fullErr}</div>}
          {columns.map(id => (
            <div key={id} className={`dg-field${hidden[id] ? " is-hidden" : ""}`}>
              <dt>
                {id}
                {hidden[id] && <span className="dg-field-tag">hidden</span>}
                {/* The drawer holds the whole, unclipped value, which makes
                    it the one honest place to copy a cell from. */}
                {onCopy && !isEmptyValue(shown[id]) && (
                  <button
                    type="button"
                    className="dg-field-copy"
                    aria-label={`Copy ${id}`}
                    title={`Copy ${id}`}
                    onClick={() => onCopy(formatCellValue(shown[id]), `${id} copied`)}
                  >⧉</button>
                )}
              </dt>
              <dd>
                {isEmptyValue(shown[id])
                  ? <span className="dg-empty">empty</span>
                  : formatCellValue(shown[id])}
              </dd>
            </div>
          ))}
        </dl>
      </aside>
    </div>
  );
}

/* ─── Icons ─── */
function SearchIcon()  { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>; }
function FilterIcon()  { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>; }
function ColumnsIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="15" y1="4" x2="15" y2="20"/></svg>; }
function XIcon()       { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>; }

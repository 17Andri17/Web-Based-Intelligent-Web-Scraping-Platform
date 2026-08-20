import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { workflowsApi } from "../api/client";
import DataGrid from "./DataGrid";
import useDialog from "./useDialog";
import "../styles/DatasetPanel.css";

/* =====================================================================
   DatasetPanel — a workflow's extracted rows, at whichever scope you ask
   for.

   Opens on the LATEST run, because after a scrape finishes the question is
   almost always "did this one come out right?" and a union across months
   of history buries the run you just watched. The picker offers any other
   run, and "All runs" for the accumulated view.

   The two scopes are genuinely different things, not a filter:

     one run    exactly what that run produced, in order, NOT de-duplicated
                — a pagination loop that revisited page 1 has to still look
                wrong — and with no first/last-seen, which would be the same
                three values on every row.
     all runs   unioned and de-duplicated across retained runs, with when
                each row was first and last seen and how many runs it
                appeared in.

   The union is computed on read by the backend (over results_json), so it
   works retroactively and needs no new storage — but that also means
   "first seen" and "times seen" are over *retained* runs only. The header
   states how many runs were considered.

   The table itself is DataGrid in server mode: filtering, sorting and
   profiling all happen on the backend, over the whole dataset rather than
   the visible page, using a port of the very same rules the grid applies
   in the browser for smaller data.

   Full-height on purpose. It used to be a small modal opened from inside
   another modal, which is no space at all for a table that can be thirty
   columns wide.

   Props:
     open, onClose
     workflowId, workflowName    required
     showToast(msg, type)
   ===================================================================== */

const PAGE_CELL_MAX = 300;   // clip long values server-side; the drawer refetches
const WHOLE_ROW = "__row__";
const ALL_RUNS = "all";

export default function DatasetPanel({ open, onClose, workflowId, workflowName, showToast }) {
  // Focus trap, Escape, focus restore, scroll lock, backdrop semantics.
  // Nested inside the grid's row drawer, the hook's stack means Escape peels
  // the drawer off first and this panel second.
  const { overlayProps, dialogProps } = useDialog({ open, onClose });

  // Requested output/key. Deliberately the REQUESTED values, not the ones the
  // server echoes back: adopting the echo would change the fetch identity and
  // cost a second round-trip every time the panel opens.
  const [output,  setOutput]  = useState(null);
  const [keyReq,  setKeyReq]  = useState(undefined);   // undefined = server default
  /* Which run is on screen. undefined lets the server pick, which means the
     latest — after a scrape finishes, "did THIS one come out right?" is
     almost always the question, and a union across months of history buries
     the run you just watched. "all" is the accumulate-everything view. */
  const [runSel,  setRunSel]  = useState(undefined);

  // What the last response told us about the dataset, for the selectors.
  const [meta, setMeta] = useState({
    outputs: [], keyOptions: [], keyField: null, runsConsidered: 0, output: null,
    runs: [], run: null,
  });
  const [downloading, setDownloading] = useState(null);

  // The grid reports its filter/sort so the download can reproduce it.
  const viewRef = useRef({});
  const onViewChange = useCallback((v) => { viewRef.current = v; }, []);

  // Reset when the panel opens for a different workflow.
  useEffect(() => {
    if (!open) return;
    setOutput(null);
    setKeyReq(undefined);
    setRunSel(undefined);
    setMeta({
      outputs: [], keyOptions: [], keyField: null, runsConsidered: 0, output: null,
      runs: [], run: null,
    });
  }, [open, workflowId]);

  // Translate the grid's view params into the endpoint's query string. Shared
  // by the page fetch and by both exports, so they cannot disagree.
  const viewQuery = useCallback((v = {}) => {
    const p = {};
    if (output != null) p.output = output;
    if (runSel !== undefined) p.run = runSel;
    // A dedupe key only means anything when rows are being accumulated.
    if (runSel === "all" && keyReq !== undefined) p.key = keyReq === null ? WHOLE_ROW : keyReq;
    if (v.q) p.q = v.q;
    if (v.filters && Object.keys(v.filters).length) p.filter = JSON.stringify(v.filters);
    if (v.sorts && v.sorts.length) p.sort = v.sorts.map(s => `${s.id}:${s.dir}`).join(",");
    if (v.columns) p.columns = v.columns;
    if (v.issue) p.issue = v.issue;
    return p;
  }, [output, keyReq, runSel]);

  /* The grid's data source. Memoised on what actually changes the dataset —
     the workflow, the list and the dedupe key — so a re-render does not
     re-fetch, and changing one of the three does. */
  const source = useMemo(() => ({
    async fetchPage(v) {
      const res = await workflowsApi.dataset(workflowId, {
        ...viewQuery(v),
        limit: v.limit,
        offset: v.offset,
        cellMax: PAGE_CELL_MAX,
      });

      // The selectors live out here, so keep them fed from the same response
      // rather than spending a second request on them.
      setMeta({
        outputs: res.outputs || [],
        keyOptions: res.keyOptions || [],
        keyField: res.keyField ?? null,
        runsConsidered: res.runsConsidered ?? 0,
        output: res.output ?? null,
        runs: res.runs || [],
        run: res.run ?? null,
      });

      return {
        rows: (res.rows || []).map(flatten),
        rowKeys: (res.rows || []).map(r => r.key),
        columns: (res.columns || []).concat(res.meta || []),
        profiles: res.profiles || {},
        issues: res.issues || [],
        total: res.total || 0,
        unfilteredTotal: res.unfilteredTotal ?? res.total ?? 0,
      };
    },
    async fetchRow(rowKey) {
      const res = await workflowsApi.dataset(workflowId, { ...viewQuery(), rowKey });
      return res.row ? flatten(res.row) : null;
    },
  }), [workflowId, viewQuery]);

  const download = async (fmt) => {
    setDownloading(fmt);
    try {
      // The same filter and sort the grid is showing — an export that quietly
      // ignored them would be the one thing worse than no export.
      const blob = await workflowsApi.datasetDownloadBlob(workflowId, fmt, viewQuery(viewRef.current));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `dataset-${workflowId}.${fmt}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast?.(`✗ ${err?.response?.data?.error || err.message}`, "error");
    } finally {
      setDownloading(null);
    }
  };

  if (!open) return null;

  const selectedKeyValue = keyReq === null ? WHOLE_ROW : (keyReq ?? meta.keyField ?? WHOLE_ROW);
  const hasOutputs = meta.outputs.length > 0;
  const effectiveRun = runSel === undefined ? meta.run : runSel;
  const isUnion = effectiveRun === ALL_RUNS;
  const shownRun = isUnion ? null : meta.runs.find(r => r.id === effectiveRun) || null;

  return (
    <div className="ds-overlay" {...overlayProps}>
      <div className="ds-panel" {...dialogProps}>
        <header className="ds-head">
          <div className="ds-head-titles">
            <h2>{isUnion ? "Data across runs" : "Run data"}</h2>
            <span className="ds-head-sub">
              {workflowName}
              {isUnion
                ? meta.runsConsidered > 0 && (
                    <> · unioned and de-duplicated over the last {meta.runsConsidered} run{meta.runsConsidered === 1 ? "" : "s"}</>
                  )
                : shownRun && <> · run #{shownRun.id}, {relTime(shownRun.startedAt)}</>}
            </span>
          </div>

          <div className="ds-head-controls">
            {meta.runs.length > 0 && (
              <label className="ds-control">
                <span>Showing</span>
                <select
                  value={runSel === undefined ? String(meta.run ?? "") : String(runSel)}
                  onChange={e => setRunSel(e.target.value === ALL_RUNS ? ALL_RUNS : Number(e.target.value))}
                >
                  {meta.runs.map((r, i) => (
                    <option key={r.id} value={String(r.id)}>
                      {i === 0 ? "Latest run" : `Run #${r.id}`} · {relTime(r.startedAt)}
                      {r.partial ? " (partial)" : ""}
                    </option>
                  ))}
                  <option value={ALL_RUNS}>All runs (accumulated)</option>
                </select>
              </label>
            )}

            {meta.outputs.length > 1 && (
              <label className="ds-control">
                <span>List</span>
                <select value={output ?? meta.output ?? ""} onChange={e => setOutput(e.target.value)}>
                  {meta.outputs.map(o => (
                    <option key={o.key} value={o.key}>{o.key} ({o.latestCount} latest)</option>
                  ))}
                </select>
              </label>
            )}

            {isUnion && meta.keyOptions.length > 0 && (
              <label className="ds-control">
                <span>Unique by</span>
                <select
                  value={selectedKeyValue}
                  onChange={e => setKeyReq(e.target.value === WHOLE_ROW ? null : e.target.value)}
                >
                  {meta.keyOptions.map(c => <option key={c} value={c}>{c}</option>)}
                  <option value={WHOLE_ROW}>Whole row (exact duplicates only)</option>
                </select>
              </label>
            )}

            {hasOutputs && (
              <span className="ds-downloads">
                <button className="ds-btn ds-xlsx" onClick={() => download("xlsx")} disabled={!!downloading}>
                  {downloading === "xlsx" ? "…" : "Excel"}
                </button>
                <button className="ds-btn" onClick={() => download("csv")} disabled={!!downloading}>
                  {downloading === "csv" ? "…" : "CSV"}
                </button>
              </span>
            )}

            <button className="ds-close" onClick={onClose} aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>

        <div className="ds-body">
          {/* Keyed on the REQUESTED list, not the resolved one: switching
              lists is a different table with different columns and should
              start clean, but the server resolving the default on the first
              response must not remount and re-fetch. */}
          <DataGrid
            key={`${workflowId}:${output ?? ""}`}
            source={source}
            onViewChange={onViewChange}
            label={output ?? meta.output ?? undefined}
            viewKey={`ds:${workflowId}:${output ?? ""}`}
          />
        </div>
      </div>
    </div>
  );
}

/* Timestamps come from the DB as UTC, sometimes without the marker — the same
   normalisation the rest of the app applies before parsing. */
function relTime(iso) {
  if (!iso) return "unknown time";
  const d = new Date(/T/.test(iso) ? iso : (String(iso).replace(" ", "T") + "Z"));
  const t = d.getTime();
  if (Number.isNaN(t)) return "unknown time";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

/* The endpoint keeps rows nested — { key, data, …provenance } — because that
   is the shape its other callers already read. The grid wants one flat
   record, with the provenance sortable and filterable like any other column. */
function flatten(r) {
  return {
    ...r.data,
    "First seen": r.firstSeenAt,
    "Last seen": r.lastSeenAt,
    "Times seen": r.timesSeen,
  };
}

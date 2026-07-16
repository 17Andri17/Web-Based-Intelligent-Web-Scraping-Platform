import React, { useState, useEffect, useRef, useCallback } from "react";
import { createAction } from "../workflow/stepFactory";
import { generatePaginationSteps } from "./PaginationDetector";
import { ACTION_TYPES } from "../actions/actionTypes";
import "../styles/QuickScrapeWizard.css";

/* =====================================================================
   QuickScrapeWizard
   The guided "point-and-click → get a table" flow. It orchestrates the
   capabilities that already exist (navigate, similar-element selection,
   AI field detection, pagination detection) into one linear path a
   non-technical user can follow, then hands the finished steps back to
   the editor.

   Deliberately NON-modal: it docks in a corner so the streamed page
   stays clickable (the user picks the list by clicking it).

   Openable at ANY moment (toolbar button) and state-aware: it syncs to
   what's already going on — a page that's already loaded marks the
   navigation step as done, an existing multi-selection is picked up as
   the list. Columns can be renamed or added manually, and several lists
   can be captured in one run ("Add another list").

   Props:
     open, onClose
     socket                   Socket.IO handle (emit/listen)
     currentPageUrl           live URL of the streamed page
     selection                the current inspector selection (main.jsx);
                              a multi-selection carries commonSelector/matchCount
     onNavigate(url)          drive the streamed browser to a URL
     onSetMode('selection'|'navigation')
     onApplySteps(steps, meta) commit the built steps to the workflow
     showToast(msg, type)
   ===================================================================== */

const STEPS = ["Page", "Pick the list", "Columns", "More pages"];

export default function QuickScrapeWizard({
  open, onClose, socket, currentPageUrl, selection,
  onNavigate, onSetMode, onApplySteps, showToast,
}) {
  const [idx, setIdx]           = useState(0);
  const [url, setUrl]           = useState("");
  const [listName, setListName] = useState("");
  const [fields, setFields]     = useState([]);      // [{name, selector, kind, attribute, sampleValue, include, manual}]
  // Lists already completed in this run ("Add another list").
  // [{ name, containerSelector, selectorType, fallbackSelectors, fields }]
  const [lists, setLists]       = useState([]);
  const [aiBusy, setAiBusy]     = useState(false);
  const [aiError, setAiError]   = useState(null);
  const [pgBusy, setPgBusy]     = useState(false);
  const [pgSuggestion, setPgSuggestion] = useState(null);
  const [includePg, setIncludePg]       = useState(true);
  // Manual "add column" mini-form on the Columns step.
  const [newCol, setNewCol] = useState(null); // { name, selector, kind, attribute } | null
  const reqRef = useRef(null);
  // Which page the wizard state was built against + whether the last run
  // was applied. Both trigger a fresh start on reopen; otherwise reopening
  // resumes exactly where the user left off ("update to what's going on").
  const lastPageRef = useRef(null);
  const appliedRef  = useRef(false);

  // Sync to the live session each time the wizard opens.
  useEffect(() => {
    if (!open) return;
    const pageChanged = (currentPageUrl || "") !== (lastPageRef.current ?? "");
    lastPageRef.current = currentPageUrl || "";
    if (appliedRef.current || pageChanged) {
      appliedRef.current = false;
      setLists([]); setFields([]); setListName("");
      setAiBusy(false); setAiError(null);
      setPgBusy(false); setPgSuggestion(null); setIncludePg(true);
      setNewCol(null);
      // Already on a page → navigation is done, jump straight to picking
      // (and put the toolbar in Select mode so clicking picks the list).
      setIdx(currentPageUrl ? 1 : 0);
      if (currentPageUrl) setTimeout(() => onSetMode && onSetMode("selection"), 0);
    } else if (currentPageUrl) {
      // Resuming on the same page: keep everything, just never show the
      // URL step again for a navigation that already happened.
      setIdx(i => (i === 0 ? 1 : i));
    }
    setUrl(currentPageUrl || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the URL field in step with the live page while on step 0.
  useEffect(() => {
    if (open && idx === 0 && currentPageUrl) setUrl(currentPageUrl);
  }, [open, idx, currentPageUrl]);

  const container = selection && selection.isMultiSelection ? selection : null;

  // ── AI field detection results ────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const onResult = (payload) => {
      if (!reqRef.current || payload.requestId !== reqRef.current) return;
      setAiBusy(false);
      if (!payload.ok || !Array.isArray(payload.fields) || payload.fields.length === 0) {
        setAiError(payload.error || "Couldn't detect columns automatically — add them below.");
        return;
      }
      setAiError(null);
      // Keep any manually added columns; AI results fill in around them.
      setFields(prev => {
        const manual = prev.filter(f => f.manual);
        const detected = payload.fields.map(f => ({
          name: f.name,
          selector: f.selector || "",
          kind: f.kind || "text",
          attribute: f.attribute || null,
          sampleValue: f.sampleValue != null ? String(f.sampleValue) : "",
          include: true,
        }));
        return [...detected, ...manual];
      });
      if (payload.name && !listName) setListName(payload.name);
    };
    socket.on("aiExtractListFieldsResult", onResult);
    return () => socket.off("aiExtractListFieldsResult", onResult);
  }, [socket, listName]);

  // ── Pagination detection results ──────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const onPg = ({ suggestions }) => {
      setPgBusy(false);
      const top = Array.isArray(suggestions) && suggestions.length ? suggestions[0] : null;
      setPgSuggestion(top);
      setIncludePg(!!top);
    };
    socket.on("paginationDetected", onPg);
    return () => socket.off("paginationDetected", onPg);
  }, [socket]);

  const goToPage = useCallback(() => {
    const u = url.trim();
    if (!u) return;
    onNavigate(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    setIdx(1);
    // Prime the page for picking: switch to Select mode for the user.
    setTimeout(() => onSetMode && onSetMode("selection"), 400);
  }, [url, onNavigate, onSetMode]);

  const detectFields = useCallback(() => {
    if (!socket || !container) return;
    const requestId = `wiz_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    reqRef.current = requestId;
    setAiBusy(true); setAiError(null); setIdx(2);
    socket.emit("aiExtractListFields", {
      containerSelector: container.commonSelector,
      selectorType: "css",
      hint: "",
      existingFields: {},
      requestId,
    });
  }, [socket, container]);

  // Skip the AI: land on the Columns step with whatever's there (usually
  // empty) and let the user add columns by hand.
  const manualFields = useCallback(() => {
    if (!container) return;
    setAiError(null);
    setIdx(2);
  }, [container]);

  const detectPagination = useCallback(() => {
    if (!socket) { setIdx(3); return; }
    setPgBusy(true); setPgSuggestion(null); setIdx(3);
    socket.emit("detectPagination");
  }, [socket]);

  // Freeze the in-progress list (selection + chosen columns) into a plain
  // config object — the live selection gets cleared when picking the next one.
  const buildCurrentListConfig = useCallback(() => {
    if (!container) return null;
    const chosen = fields.filter(f => f.include && f.name && f.name.trim());
    const fieldsObj = {};
    for (const f of chosen) {
      fieldsObj[f.name.trim()] = {
        selector: f.selector || "",
        kind: f.kind || "text",
        attribute: f.kind === "attr" ? (f.attribute || null) : null,
      };
    }
    return {
      name: (listName && listName.trim()) || `Items ${lists.length + 1}`,
      containerSelector: container.commonSelector,
      selectorType: "css",
      fallbackSelectors: container.fallbackSelectors || [],
      fields: fieldsObj,
    };
  }, [container, fields, listName, lists.length]);

  // "Add another list": save the current one, clear the selection and go
  // back to picking. All saved lists are built together at the end.
  const addAnotherList = useCallback(() => {
    const cfg = buildCurrentListConfig();
    if (!cfg) return;
    setLists(ls => [...ls, cfg]);
    setListName(""); setFields([]); setAiError(null); setNewCol(null);
    socket?.emit("resetSelection");
    onSetMode && onSetMode("selection");
    setIdx(1);
    showToast && showToast(`✓ "${cfg.name}" saved — pick the next list`, "success");
  }, [buildCurrentListConfig, socket, onSetMode, showToast]);

  const removeSavedList = useCallback((i) => {
    setLists(ls => ls.filter((_, j) => j !== i));
  }, []);

  const finish = useCallback(() => {
    const cfgs = [...lists];
    const current = buildCurrentListConfig();
    if (current) cfgs.push(current);
    if (cfgs.length === 0) return;

    const listSteps = cfgs.map(cfg => {
      const step = createAction(ACTION_TYPES.EXTRACT_LIST, {
        containerSelector: cfg.containerSelector,
        selectorType: cfg.selectorType,
        fallbackSelectors: cfg.fallbackSelectors,
        fields: cfg.fields,
      }, {});
      step.label = cfg.name;
      return step;
    });

    let steps;
    if (includePg && pgSuggestion) {
      const pgStep = generatePaginationSteps(pgSuggestion);
      if (pgStep) {
        pgStep.body = listSteps;   // run every extraction on every page
        steps = [pgStep];
      } else {
        steps = listSteps;
      }
    } else {
      steps = listSteps;
    }
    appliedRef.current = true;
    onApplySteps(steps, { startUrl: currentPageUrl || url });
  }, [lists, buildCurrentListConfig, includePg, pgSuggestion, onApplySteps, currentPageUrl, url]);

  if (!open) return null;

  const includedCount = fields.filter(f => f.include).length;
  const totalLists = lists.length + (container ? 1 : 0);
  const railDone = (i) => i < idx || (i === 0 && !!currentPageUrl);

  // Compact "page is set" banner reused on steps 1-3.
  const pageLine = currentPageUrl ? (
    <div className="qsw-pageline">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#3fb950" strokeWidth="2.5"><polyline points="20,6 9,17 4,12"/></svg>
      <span className="qsw-pageline-url" title={currentPageUrl}>{currentPageUrl}</span>
      <button className="qsw-linkbtn" onClick={() => setIdx(0)}>change</button>
    </div>
  ) : null;

  const savedChips = lists.length > 0 && (
    <div className="qsw-listchips">
      {lists.map((l, i) => (
        <span key={i} className="qsw-listchip" title={`${Object.keys(l.fields).length} columns · ${l.containerSelector}`}>
          {l.name}
          <button onClick={() => removeSavedList(i)} title="Remove this list" aria-label={`Remove ${l.name}`}>×</button>
        </span>
      ))}
    </div>
  );

  return (
    <div className="qsw">
      <div className="qsw-head">
        <div className="qsw-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="13,2 3,14 12,14 11,22 21,10 12,10"/>
          </svg>
          Quick Scrape
        </div>
        <button className="qsw-close" onClick={onClose} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* Progress rail */}
      <div className="qsw-rail">
        {STEPS.map((s, i) => (
          <div key={s} className={`qsw-rail-step ${i === idx ? "active" : ""} ${railDone(i) ? "done" : ""}`}>
            <span className="qsw-rail-dot">{railDone(i) ? "✓" : i + 1}</span>
            <span className="qsw-rail-label">{s}</span>
          </div>
        ))}
      </div>

      <div className="qsw-body">
        {/* Step 0 — URL */}
        {idx === 0 && (
          <>
            <p className="qsw-lead">Which page has the list you want?</p>
            <input
              className="qsw-input"
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => e.key === "Enter" && goToPage()}
              placeholder="example.com/products"
              autoFocus
            />
            <div className="qsw-actions">
              {currentPageUrl && (
                <button className="qsw-btn ghost" onClick={() => setIdx(1)}>Stay on this page</button>
              )}
              <button className="qsw-btn primary" onClick={goToPage} disabled={!url.trim()}>Go to page</button>
            </div>
          </>
        )}

        {/* Step 1 — pick the list */}
        {idx === 1 && (
          <>
            <p className="qsw-lead">{lists.length > 0 ? "Click one item of the next list." : "Click one item in the list you want."}</p>
            {pageLine}
            {savedChips}
            <ol className="qsw-hints">
              <li>Make sure the toolbar is on <strong>Select</strong> mode.</li>
              <li>Click a single item — one product, job, or row.</li>
              <li>We'll highlight all the similar items automatically.</li>
            </ol>
            {container ? (
              <div className="qsw-found">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#3fb950" strokeWidth="2.5"><polyline points="20,6 9,17 4,12"/></svg>
                Found <strong>{container.matchCount}</strong> similar items.
              </div>
            ) : selection ? (
              <div className="qsw-waiting">
                One item selected — now click one of the <strong>amber-highlighted</strong> items to grab the whole list.
              </div>
            ) : (
              <div className="qsw-waiting">Waiting for you to click an item…</div>
            )}
            <div className="qsw-actions">
              {!currentPageUrl && <button className="qsw-btn ghost" onClick={() => setIdx(0)}>Back</button>}
              <button className="qsw-btn ghost" onClick={manualFields} disabled={!container} title="Skip auto-detection and add columns by hand">
                Choose columns myself
              </button>
              <button className="qsw-btn primary" onClick={detectFields} disabled={!container}>Detect columns →</button>
            </div>
          </>
        )}

        {/* Step 2 — columns */}
        {idx === 2 && (
          <>
            <p className="qsw-lead">Pick and name the columns for this table.</p>
            {savedChips}
            <label className="qsw-namelabel">Table name
              <input className="qsw-input" value={listName} onChange={e => setListName(e.target.value)} placeholder="e.g. Products" />
            </label>
            {aiBusy ? (
              <div className="qsw-waiting">✨ Detecting columns…</div>
            ) : (
              <>
                {aiError && <div className="qsw-error">{aiError}</div>}
                <div className="qsw-fields">
                  {fields.length === 0 && !aiError && (
                    <div className="qsw-waiting">No columns yet — add one below.</div>
                  )}
                  {fields.map((f, i) => (
                    <div key={i} className="qsw-field">
                      <input type="checkbox" checked={f.include}
                        onChange={e => setFields(fs => fs.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))} />
                      <input
                        className="qsw-field-nameinput"
                        value={f.name}
                        onChange={e => setFields(fs => fs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                        placeholder="column name"
                        title={f.selector ? `Selector: ${f.selector}` : "Uses the item itself"}
                      />
                      {f.sampleValue
                        ? <span className="qsw-field-sample" title={f.sampleValue}>{f.sampleValue.slice(0, 40)}</span>
                        : f.manual && <span className="qsw-field-sample qsw-field-sample--manual" title={f.selector || "the item itself"}>manual</span>}
                    </div>
                  ))}
                </div>

                {/* Manual column mini-form */}
                {newCol ? (
                  <div className="qsw-addcol">
                    <div className="qsw-addcol-row">
                      <input className="qsw-input" value={newCol.name} placeholder="Column name (e.g. price)"
                        autoFocus
                        onChange={e => setNewCol(c => ({ ...c, name: e.target.value }))} />
                    </div>
                    <div className="qsw-addcol-row">
                      <input className="qsw-input qsw-mono" value={newCol.selector}
                        placeholder="Selector inside the item — e.g. .price (empty = the item itself)"
                        onChange={e => setNewCol(c => ({ ...c, selector: e.target.value }))} />
                    </div>
                    <div className="qsw-addcol-row">
                      <select className="qsw-select" value={newCol.kind}
                        onChange={e => setNewCol(c => ({ ...c, kind: e.target.value }))}>
                        <option value="text">Text</option>
                        <option value="attr">Attribute (href, src…)</option>
                      </select>
                      {newCol.kind === "attr" && (
                        <input className="qsw-input qsw-mono" value={newCol.attribute} placeholder="attribute, e.g. href"
                          onChange={e => setNewCol(c => ({ ...c, attribute: e.target.value }))} />
                      )}
                    </div>
                    <div className="qsw-addcol-row qsw-addcol-actions">
                      <button className="qsw-btn ghost" onClick={() => setNewCol(null)}>Cancel</button>
                      <button className="qsw-btn primary"
                        disabled={!newCol.name.trim() || (newCol.kind === "attr" && !newCol.attribute.trim())}
                        onClick={() => {
                          setFields(fs => [...fs, {
                            name: newCol.name.trim(),
                            selector: newCol.selector.trim(),
                            kind: newCol.kind,
                            attribute: newCol.kind === "attr" ? newCol.attribute.trim() : null,
                            sampleValue: "",
                            include: true,
                            manual: true,
                          }]);
                          setNewCol(null);
                        }}>Add column</button>
                    </div>
                  </div>
                ) : (
                  <button className="qsw-linkbtn qsw-addcol-open"
                    onClick={() => setNewCol({ name: "", selector: "", kind: "text", attribute: "" })}>
                    + Add a column manually
                  </button>
                )}
              </>
            )}
            <div className="qsw-actions">
              <button className="qsw-btn ghost" onClick={() => setIdx(1)}>Back</button>
              <button className="qsw-btn ghost" onClick={addAnotherList} disabled={aiBusy || !container}
                title="Save this table and pick another list on the same page">
                + Another list
              </button>
              <button className="qsw-btn primary" onClick={detectPagination} disabled={aiBusy}>Next: more pages →</button>
            </div>
          </>
        )}

        {/* Step 3 — pagination */}
        {idx === 3 && (
          <>
            <p className="qsw-lead">Does the list continue over more pages?</p>
            {savedChips}
            {pgBusy ? (
              <div className="qsw-waiting">Checking for pagination…</div>
            ) : pgSuggestion ? (
              <label className="qsw-pg">
                <input type="checkbox" checked={includePg} onChange={e => setIncludePg(e.target.checked)} />
                <span>
                  Yes — scrape more pages automatically
                  <span className="qsw-pg-kind">
                    {pgSuggestion.type === "url_param" ? "Detected: page-by-page URLs"
                      : pgSuggestion.type === "infinite_scroll" ? "Detected: infinite scroll"
                      : pgSuggestion.type === "load_more" ? "Detected: a “load more” button"
                      : "Detected: a “next” button"}
                  </span>
                </span>
              </label>
            ) : (
              <div className="qsw-waiting">No extra pages detected — we'll scrape this page only.</div>
            )}
            <div className="qsw-actions">
              <button className="qsw-btn ghost" onClick={() => setIdx(2)}>Back</button>
              <button className="qsw-btn primary" onClick={finish} disabled={!container && lists.length === 0}>
                Build scraper{totalLists > 1 ? ` (${totalLists} tables)` : ""}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="qsw-foot">
        {idx >= 2 && container && (
          <span>
            {includedCount} column{includedCount !== 1 ? "s" : ""} · {container.matchCount} items
            {lists.length > 0 ? ` · ${lists.length + 1} tables` : ""}
            {includePg && pgSuggestion ? " · multi-page" : ""}
          </span>
        )}
        {idx >= 2 && !container && lists.length > 0 && (
          <span>{lists.length} table{lists.length !== 1 ? "s" : ""} saved{includePg && pgSuggestion ? " · multi-page" : ""}</span>
        )}
      </div>
    </div>
  );
}

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

const STEPS = ["Page", "Pick the list", "Columns", "More pages", "Done"];

export default function QuickScrapeWizard({
  open, onClose, socket, currentPageUrl, selection,
  onNavigate, onSetMode, onApplySteps, showToast,
}) {
  const [idx, setIdx]           = useState(0);
  const [url, setUrl]           = useState("");
  const [listName, setListName] = useState("");
  const [fields, setFields]     = useState([]);      // [{name, selector, kind, attribute, sampleValue, include}]
  const [aiBusy, setAiBusy]     = useState(false);
  const [aiError, setAiError]   = useState(null);
  const [pgBusy, setPgBusy]     = useState(false);
  const [pgSuggestion, setPgSuggestion] = useState(null);
  const [includePg, setIncludePg]       = useState(true);
  const reqRef = useRef(null);

  // Reset everything each time the wizard opens.
  useEffect(() => {
    if (open) {
      setIdx(0); setUrl(currentPageUrl || ""); setListName("");
      setFields([]); setAiBusy(false); setAiError(null);
      setPgBusy(false); setPgSuggestion(null); setIncludePg(true);
    }
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
        setAiError(payload.error || "Couldn't detect columns automatically. You can still add them in the editor.");
        return;
      }
      setAiError(null);
      setFields(payload.fields.map(f => ({
        name: f.name,
        selector: f.selector || "",
        kind: f.kind || "text",
        attribute: f.attribute || null,
        sampleValue: f.sampleValue != null ? String(f.sampleValue) : "",
        include: true,
      })));
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

  const detectPagination = useCallback(() => {
    if (!socket) { setIdx(3); return; }
    setPgBusy(true); setPgSuggestion(null); setIdx(3);
    socket.emit("detectPagination");
  }, [socket]);

  const finish = useCallback(() => {
    if (!container) return;
    const chosen = fields.filter(f => f.include && f.name);
    const fieldsObj = {};
    for (const f of chosen) {
      fieldsObj[f.name] = { selector: f.selector || "", kind: f.kind || "text", attribute: f.kind === "attr" ? (f.attribute || null) : null };
    }
    const listStep = createAction(ACTION_TYPES.EXTRACT_LIST, {
      containerSelector: container.commonSelector,
      selectorType: "css",
      fallbackSelectors: container.fallbackSelectors || [],
      fields: fieldsObj,
    }, {});
    listStep.label = (listName && listName.trim()) || "Items";

    let steps;
    if (includePg && pgSuggestion) {
      const pgStep = generatePaginationSteps(pgSuggestion);
      if (pgStep) {
        pgStep.body = [listStep];   // run the extraction on every page
        steps = [pgStep];
      } else {
        steps = [listStep];
      }
    } else {
      steps = [listStep];
    }
    onApplySteps(steps, { startUrl: currentPageUrl || url });
  }, [container, fields, listName, includePg, pgSuggestion, onApplySteps, currentPageUrl, url]);

  if (!open) return null;

  const includedCount = fields.filter(f => f.include).length;

  return (
    <div className="qsw">
      <div className="qsw-head">
        <div className="qsw-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
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
          <div key={s} className={`qsw-rail-step ${i === idx ? "active" : ""} ${i < idx ? "done" : ""}`}>
            <span className="qsw-rail-dot">{i < idx ? "✓" : i + 1}</span>
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
              <button className="qsw-btn primary" onClick={goToPage} disabled={!url.trim()}>Go to page</button>
            </div>
          </>
        )}

        {/* Step 1 — pick the list */}
        {idx === 1 && (
          <>
            <p className="qsw-lead">Click one item in the list you want.</p>
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
            ) : (
              <div className="qsw-waiting">Waiting for you to click an item…</div>
            )}
            <div className="qsw-actions">
              <button className="qsw-btn ghost" onClick={() => setIdx(0)}>Back</button>
              <button className="qsw-btn primary" onClick={detectFields} disabled={!container}>Detect columns →</button>
            </div>
          </>
        )}

        {/* Step 2 — columns */}
        {idx === 2 && (
          <>
            <p className="qsw-lead">These are the columns we found.</p>
            <label className="qsw-namelabel">Table name
              <input className="qsw-input" value={listName} onChange={e => setListName(e.target.value)} placeholder="e.g. Products" />
            </label>
            {aiBusy ? (
              <div className="qsw-waiting">✨ Detecting columns…</div>
            ) : aiError ? (
              <div className="qsw-error">{aiError}</div>
            ) : (
              <div className="qsw-fields">
                {fields.length === 0 && <div className="qsw-waiting">No columns detected — you can add them in the editor.</div>}
                {fields.map((f, i) => (
                  <label key={i} className="qsw-field">
                    <input type="checkbox" checked={f.include}
                      onChange={e => setFields(fs => fs.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))} />
                    <span className="qsw-field-name">{f.name}</span>
                    {f.sampleValue && <span className="qsw-field-sample" title={f.sampleValue}>{f.sampleValue.slice(0, 40)}</span>}
                  </label>
                ))}
              </div>
            )}
            <div className="qsw-actions">
              <button className="qsw-btn ghost" onClick={() => setIdx(1)}>Back</button>
              <button className="qsw-btn primary" onClick={detectPagination} disabled={aiBusy}>Next: more pages →</button>
            </div>
          </>
        )}

        {/* Step 3 — pagination */}
        {idx === 3 && (
          <>
            <p className="qsw-lead">Does the list continue over more pages?</p>
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
              <button className="qsw-btn primary" onClick={finish} disabled={!container}>Build scraper</button>
            </div>
          </>
        )}
      </div>

      <div className="qsw-foot">
        {idx >= 2 && container && (
          <span>{includedCount} column{includedCount !== 1 ? "s" : ""} · {container.matchCount} items{includePg && pgSuggestion ? " · multi-page" : ""}</span>
        )}
      </div>
    </div>
  );
}

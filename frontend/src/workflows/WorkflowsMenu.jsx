import React, { useEffect, useState, useRef, useMemo } from "react";
import { workflowsApi, schedulesApi } from "../api/client";
import ScheduleEditor from "../runs/ScheduleEditor";
import RunsHistory from "../runs/RunsHistory";
import DatasetPanel from "../components/DatasetPanel";
import MonitorEditor from "../components/MonitorEditor";
import SheetDeliveryEditor from "../components/SheetDeliveryEditor";

/**
 * Modal for saving the current workflow and opening / deleting saved ones.
 *
 * Props:
 *   open                — bool
 *   onClose             — () => void
 *   currentSteps        — workflow steps array
 *   currentMeta         — { startUrl, viewportWidth, viewportHeight } | undefined
 *   currentWorkflowId   — number | null (the workflow currently loaded, if any)
 *   currentName         — string (suggested default save name)
 *   onLoaded(workflow)  — called after a successful open
 *   onSaved(workflow)   — called after create/update
 *   showToast(msg,type) — optional
 */
export default function WorkflowsMenu({
  open, onClose, currentSteps, currentMeta,
  currentWorkflowId, currentName,
  onLoaded, onSaved, showToast,
}) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [name, setName] = useState(currentName || "");
  const [busy, setBusy] = useState(false);

  // Schedule + history modals, opened per workflow row
  const [scheduleFor, setScheduleFor] = useState(null);   // { id, name } | null
  const [historyFor,  setHistoryFor]  = useState(null);   // { id, name } | null
  const [dataFor,     setDataFor]     = useState(null);   // { id, name } | null
  const [monitorFor,  setMonitorFor]  = useState(null);   // { id, name } | null
  const [sheetFor,    setSheetFor]    = useState(null);   // { id, name } | null
  const fileInputRef = useRef(null);                      // hidden import file picker
  // Map workflowId → { isActive, intervalMinutes } so we can show a small
  // badge next to scheduled workflows in the list.
  const [scheduleByWf, setScheduleByWf] = useState({});
  const [query, setQuery] = useState("");                 // name filter

  useEffect(() => { if (open) setName(currentName || ""); }, [open, currentName]);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await workflowsApi.list();
      setList(items);
      // Best-effort enrich with schedule status — we don't fail the whole
      // refresh if this errors. The schedules endpoint scopes to user_id
      // server-side, so listing is safe.
      try {
        const schedules = await schedulesApi.list();
        const map = {};
        for (const s of schedules) map[s.workflowId] = s;
        setScheduleByWf(map);
      } catch (_) { /* ignore */ }
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open) refresh(); }, [open]);

  // Name filter — a saved-workflow list gets long, and scrolling to find one
  // was the slowest thing in this panel. Must sit above the `open` early
  // return: every hook has to run on every render.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(wf => (wf.name || "").toLowerCase().includes(q));
  }, [list, query]);

  if (!open) return null;

  const handleSaveNew = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const wf = await workflowsApi.create(name.trim(), currentSteps, currentMeta || null);
      onSaved?.(wf);
      showToast?.(`✓ Saved as "${wf.name}"`, "success");
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateCurrent = async () => {
    if (!currentWorkflowId) return;
    setBusy(true);
    setError(null);
    try {
      const wf = await workflowsApi.update(currentWorkflowId, name.trim() || currentName, currentSteps, currentMeta || null);
      onSaved?.(wf);
      showToast?.(`✓ Updated "${wf.name}"`, "success");
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = async (id) => {
    setBusy(true);
    setError(null);
    try {
      const wf = await workflowsApi.get(id);
      onLoaded?.(wf);
      showToast?.(`✓ Opened "${wf.name}"`, "success");
      onClose?.();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id, deletedName) => {
    if (!confirm(`Delete workflow "${deletedName}"? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await workflowsApi.remove(id);
      showToast?.(`✓ Deleted "${deletedName}"`, "success");
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async (id, wfName) => {
    try {
      const blob = await workflowsApi.exportBlob(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(wfName || "workflow").replace(/[^a-zA-Z0-9-_ ]+/g, "").trim().replace(/\s+/g, "-") || "workflow"}.workflow.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast?.(`✗ ${err?.response?.data?.error || err.message}`, "error");
    }
  };

  const handleDuplicate = async (id) => {
    setBusy(true); setError(null);
    try {
      const copy = await workflowsApi.duplicate(id);
      showToast?.(`✓ Duplicated → "${copy.name}"`, "success");
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  // Import from a chosen .json file: parse, POST, refresh.
  const handleImportFile = async (file) => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const text = await file.text();
      let envelope;
      try { envelope = JSON.parse(text); }
      catch { throw new Error("That file isn't valid JSON."); }
      const res = await workflowsApi.importFromEnvelope(envelope);
      let msg = `✓ Imported "${res.workflow.name}"`;
      if (res.createdCustomActions?.length) msg += ` (+${res.createdCustomActions.length} custom action${res.createdCustomActions.length === 1 ? "" : "s"})`;
      showToast?.(msg, "success");
      if (res.subflowRefs > 0) showToast?.("Note: this workflow calls subflows — make sure those workflows also exist in your account.", "loop");
      await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally { setBusy(false); }
  };

  const canSave = currentSteps && currentSteps.length > 0;

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal wf-modal-lg" onClick={e => e.stopPropagation()}>
        <div className="wf-header">
          <div className="wf-header-titles">
            <h2>Workflows</h2>
            {list.length > 0 && (
              <span className="wf-header-sub">{list.length} saved</span>
            )}
          </div>
          <div className="wf-header-actions">
            <button className="wf-ghost-btn" onClick={() => fileInputRef.current?.click()} disabled={busy}
                    title="Create a workflow from an exported .json file">
              Import…
            </button>
            <button className="wf-close" onClick={onClose} aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; handleImportFile(f); }}
          />
        </div>

        <div className="wf-body">
          <div className="wf-section-title">Save current workflow</div>
          <div className="wf-save-row">
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={canSave ? "Workflow name…" : "Build a workflow before saving"}
              disabled={!canSave}
            />
            {currentWorkflowId ? (
              <>
                <button className="wf-save-btn" onClick={handleUpdateCurrent} disabled={!canSave || busy}>
                  Update
                </button>
                <button className="wf-ghost-btn" onClick={handleSaveNew} disabled={!canSave || !name.trim() || busy} title="Save a new copy">
                  Save as new
                </button>
              </>
            ) : (
              <button className="wf-save-btn" onClick={handleSaveNew} disabled={!canSave || !name.trim() || busy}>
                Save
              </button>
            )}
          </div>

          {error && <div className="wf-error">{error}</div>}

          <div className="wf-section-head">
            <div className="wf-section-title">Your saved workflows</div>
          </div>
          {list.length > 5 && (
            <input
              className="wf-search"
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search workflows…"
            />
          )}
          {loading ? (
            <div className="wf-empty">Loading…</div>
          ) : list.length === 0 ? (
            <div className="wf-empty">
              No saved workflows yet. Build one in the editor and save it above,
              or <strong>Import…</strong> an exported <code>.json</code> file.
            </div>
          ) : filtered.length === 0 ? (
            <div className="wf-empty">No workflows match "{query}".</div>
          ) : (
            <div className="wf-list">
              {filtered.map(wf => (
                <WorkflowRow
                  key={wf.id}
                  wf={wf}
                  busy={busy}
                  isCurrent={wf.id === currentWorkflowId}
                  schedule={scheduleByWf[wf.id]}
                  onOpen={() => handleOpen(wf.id)}
                  onData={() => setDataFor({ id: wf.id, name: wf.name })}
                  onHistory={() => setHistoryFor({ id: wf.id, name: wf.name })}
                  onSchedule={() => setScheduleFor({ id: wf.id, name: wf.name })}
                  onMonitor={() => setMonitorFor({ id: wf.id, name: wf.name })}
                  onSheets={() => setSheetFor({ id: wf.id, name: wf.name })}
                  onDuplicate={() => handleDuplicate(wf.id)}
                  onExport={() => handleExport(wf.id, wf.name)}
                  onDelete={() => handleDelete(wf.id, wf.name)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Per-workflow Schedule modal */}
      <ScheduleEditor
        open={!!scheduleFor}
        onClose={() => { setScheduleFor(null); refresh(); }}
        workflowId={scheduleFor?.id}
        workflowName={scheduleFor?.name}
        showToast={showToast}
      />

      {/* Per-workflow cross-run Data modal */}
      <DatasetPanel
        open={!!dataFor}
        onClose={() => setDataFor(null)}
        workflowId={dataFor?.id}
        workflowName={dataFor?.name}
        showToast={showToast}
      />

      {/* Per-workflow change-monitoring modal */}
      <MonitorEditor
        open={!!monitorFor}
        onClose={() => setMonitorFor(null)}
        workflowId={monitorFor?.id}
        workflowName={monitorFor?.name}
        showToast={showToast}
      />

      {/* Per-workflow Google Sheets delivery modal */}
      <SheetDeliveryEditor
        open={!!sheetFor}
        onClose={() => setSheetFor(null)}
        workflowId={sheetFor?.id}
        workflowName={sheetFor?.name}
        showToast={showToast}
      />

      {/* Per-workflow Runs history modal */}
      <RunsHistory
        open={!!historyFor}
        onClose={() => setHistoryFor(null)}
        workflowId={historyFor?.id}
        workflowName={historyFor?.name}
        showToast={showToast}
        onAppliedPatch={(updatedWorkflow) => {
          // If this is the workflow the user has open in the editor, refresh
          // it through the same onLoaded handler so steps in the canvas
          // update to the patched version.
          if (currentWorkflowId === updatedWorkflow.id) {
            onLoaded?.(updatedWorkflow);
          }
          refresh();
        }}
      />
    </div>
  );
}

// Roughly the height of the overflow menu — used only to decide which way it
// opens, so an approximation is fine.
const MENU_HEIGHT = 180;

/* ── One saved workflow ───────────────────────────────────────────────────
   The name owns its own line so it is always readable, whatever else the row
   carries. Open is the primary action; the four things you reach for while
   working (Data, History, Schedule, Monitor) are icons; the rest live behind
   the ⋯ menu, so the row never grows wide enough to need scrolling. */
function WorkflowRow({
  wf, busy, isCurrent, schedule,
  onOpen, onData, onHistory, onSchedule, onMonitor,
  onSheets, onDuplicate, onExport, onDelete,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuUp, setMenuUp] = useState(false);
  const menuBtnRef = useRef(null);
  const scheduled = schedule && schedule.isActive;

  const pick = (fn) => () => { setMenuOpen(false); fn(); };

  // The list scrolls, so a menu on one of the last rows would open past the
  // bottom edge — measure once on open and flip it upward when it won't fit.
  const toggleMenu = () => {
    if (!menuOpen && menuBtnRef.current) {
      const btn = menuBtnRef.current.getBoundingClientRect();
      const scroller = menuBtnRef.current.closest(".wf-body");
      const limit = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
      setMenuUp(limit - btn.bottom < MENU_HEIGHT);
    }
    setMenuOpen(v => !v);
  };

  return (
    <div className="wf-item">
      <div className="info">
        <span className="name">
          <span className="label" title={wf.name}>{wf.name}</span>
          {isCurrent  && <span className="wf-badge current">current</span>}
          {scheduled && (
            <span className="wf-badge sched" title={`Runs automatically every ${schedule.intervalMinutes} min`}>
              {schedule.intervalMinutes ? `every ${prettyInterval(schedule.intervalMinutes)}` : "scheduled"}
            </span>
          )}
        </span>
        <span className="meta">Updated {formatDate(wf.updatedAt)}</span>
      </div>

      <div className="actions">
        <button className="wf-save-btn" onClick={onOpen} disabled={busy}>Open</button>

        <IconAction label="Data"     onClick={onData}     disabled={busy}>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        </IconAction>
        <IconAction label="Run history" onClick={onHistory} disabled={busy}>
          <circle cx="12" cy="12" r="9"/><polyline points="12,7 12,12 15.5,14"/>
        </IconAction>
        <IconAction label="Schedule" onClick={onSchedule} disabled={busy} on={scheduled}>
          <rect x="3" y="4.5" width="18" height="16" rx="2"/><line x1="3" y1="9.5" x2="21" y2="9.5"/>
          <line x1="8" y1="2.5" x2="8" y2="6.5"/><line x1="16" y1="2.5" x2="16" y2="6.5"/>
        </IconAction>
        <IconAction label="Monitor for changes" onClick={onMonitor} disabled={busy}>
          <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>
        </IconAction>

        <div className="wf-menu-wrap">
          <button
            ref={menuBtnRef}
            className="wf-icon-btn"
            onClick={toggleMenu}
            disabled={busy}
            aria-label={`More actions for ${wf.name}`}
            aria-expanded={menuOpen}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/>
            </svg>
          </button>
          {menuOpen && (
            <>
              {/* Click-away catcher — the row itself must stay clickable. */}
              <div style={{ position: "fixed", inset: 0, zIndex: 45 }} onClick={() => setMenuOpen(false)} />
              <div className={`wf-menu ${menuUp ? "up" : ""}`}>
                <button className="wf-menu-item" onClick={pick(onSheets)}>Google Sheets delivery…</button>
                <button className="wf-menu-item" onClick={pick(onDuplicate)}>Duplicate</button>
                <button className="wf-menu-item" onClick={pick(onExport)}>Export as JSON</button>
                <div className="wf-menu-sep" />
                <button className="wf-menu-item danger" onClick={pick(onDelete)}>Delete</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Icon button whose accessible name and tooltip are the same word, so the
// compact row stays discoverable.
function IconAction({ label, onClick, disabled, on, children }) {
  return (
    <button
      className={`wf-icon-btn ${on ? "on" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

function prettyInterval(m) {
  if (m % 1440 === 0) return `${m / 1440}d`;
  if (m % 60 === 0)   return `${m / 60}h`;
  return `${m}m`;
}

function formatDate(s) {
  if (!s) return "";
  // SQLite returns 'YYYY-MM-DD HH:MM:SS' in UTC; show locally.
  const d = new Date(s.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

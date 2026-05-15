import React, { useEffect, useState } from "react";
import { workflowsApi, schedulesApi } from "../api/client";
import ScheduleEditor from "../runs/ScheduleEditor";
import RunsHistory from "../runs/RunsHistory";

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
  // Map workflowId → { isActive, intervalMinutes } so we can show a small
  // badge next to scheduled workflows in the list.
  const [scheduleByWf, setScheduleByWf] = useState({});

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

  const canSave = currentSteps && currentSteps.length > 0;

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal" onClick={e => e.stopPropagation()}>
        <div className="wf-header">
          <h2>Workflows</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
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
                <button className="wf-save-btn" onClick={handleSaveNew} disabled={!canSave || !name.trim() || busy} title="Save a new copy">
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

          <div className="wf-section-title">Your saved workflows</div>
          {loading ? (
            <div className="wf-empty">Loading…</div>
          ) : list.length === 0 ? (
            <div className="wf-empty">No saved workflows yet.</div>
          ) : (
            <div className="wf-list">
              {list.map(wf => {
                const sch = scheduleByWf[wf.id];
                return (
                  <div className="wf-item" key={wf.id}>
                    <div className="info">
                      <span className="name">
                        {wf.name}{wf.id === currentWorkflowId ? " (current)" : ""}
                        {sch && sch.isActive && (
                          <span title={`Scheduled — every ${sch.intervalMinutes} min`}
                                style={{ marginLeft: 8, fontSize: 10, padding: "1px 6px",
                                         border: "1px solid #4f9cf966", color: "#4f9cf9",
                                         borderRadius: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
                            ⏱ {prettyInterval(sch.intervalMinutes)}
                          </span>
                        )}
                      </span>
                      <span className="meta">Updated {formatDate(wf.updatedAt)}</span>
                    </div>
                    <div className="actions">
                      <button onClick={() => handleOpen(wf.id)} disabled={busy}>Open</button>
                      <button onClick={() => setHistoryFor({ id: wf.id, name: wf.name })} disabled={busy}>History</button>
                      <button onClick={() => setScheduleFor({ id: wf.id, name: wf.name })} disabled={busy}>Schedule</button>
                      <button className="danger" onClick={() => handleDelete(wf.id, wf.name)} disabled={busy}>Delete</button>
                    </div>
                  </div>
                );
              })}
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

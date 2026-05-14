import React, { useEffect, useState } from "react";
import { workflowsApi } from "../api/client";

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

  useEffect(() => { if (open) setName(currentName || ""); }, [open, currentName]);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await workflowsApi.list();
      setList(items);
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
              {list.map(wf => (
                <div className="wf-item" key={wf.id}>
                  <div className="info">
                    <span className="name">{wf.name}{wf.id === currentWorkflowId ? " (current)" : ""}</span>
                    <span className="meta">Updated {formatDate(wf.updatedAt)}</span>
                  </div>
                  <div className="actions">
                    <button onClick={() => handleOpen(wf.id)} disabled={busy}>Open</button>
                    <button className="danger" onClick={() => handleDelete(wf.id, wf.name)} disabled={busy}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDate(s) {
  if (!s) return "";
  // SQLite returns 'YYYY-MM-DD HH:MM:SS' in UTC; show locally.
  const d = new Date(s.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

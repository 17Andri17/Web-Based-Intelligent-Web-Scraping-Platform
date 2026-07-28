import React, { useEffect, useState, useCallback } from "react";
import { workflowsApi } from "../api/client";
import "../styles/MonitorEditor.css";

/* =====================================================================
   MonitorEditor
   Per-workflow "Watch for changes" configuration + recent change feed.

   When enabled, each successful run is diffed against the previous one
   (row-level add / remove / change, keyed the same way the Data view
   dedupes) and the summary is stored on the run. A run.changed webhook
   fires when something actually changed — subscribe an endpoint (ntfy /
   Slack / Discord / your own) to run.changed to get pinged.

   Which list is watched and how rows are matched default to the same
   choices as the Data view, so "changes" line up with what you see there.
   The list/key options are populated from the dataset endpoint.

   Props:
     open, onClose
     workflowId, workflowName    required
     showToast(msg, type)
   ===================================================================== */

const AUTO = "auto";          // let the backend default the key
const WHOLE_ROW = "__row__";  // match on the entire row

export default function MonitorEditor({ open, onClose, workflowId, workflowName, showToast }) {
  const [loading, setLoading] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);

  const [exists, setExists]   = useState(false);   // a monitor row is saved
  const [enabled, setEnabled] = useState(false);
  const [outputKey, setOutputKey] = useState("");  // "" = primary/auto
  const [keyMode, setKeyMode] = useState(AUTO);     // AUTO | WHOLE_ROW | column
  const [outputs, setOutputs] = useState([]);       // [{ key, fields }]
  const [changes, setChanges] = useState([]);

  const refresh = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true); setError(null);
    try {
      // Monitor config + change feed, and the dataset outputs for the pickers.
      const [mon, ds] = await Promise.all([
        workflowsApi.getMonitor(workflowId),
        workflowsApi.dataset(workflowId, { limit: 1 }).catch(() => ({ outputs: [] })),
      ]);
      setOutputs(ds.outputs || []);
      setChanges(mon.changes || []);
      const m = mon.monitor;
      setExists(!!m);
      setEnabled(m ? m.isActive : false);
      setOutputKey(m && m.outputKey ? m.outputKey : "");
      setKeyMode(m == null || m.keyField == null ? AUTO : (m.keyField === "" ? WHOLE_ROW : m.keyField));
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => { if (open) refresh(); /* eslint-disable-next-line */ }, [open, workflowId]);

  if (!open) return null;

  // Columns available as a dedupe key for the chosen output (or the first one).
  const activeOutput = outputs.find(o => o.key === outputKey) || outputs[0] || null;
  const columns = activeOutput ? (activeOutput.fields || []) : [];

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = { isActive: enabled };
      if (outputKey) body.outputKey = outputKey;
      // AUTO → omit (backend defaults); WHOLE_ROW → ""; else the column name.
      if (keyMode === WHOLE_ROW) body.keyField = "";
      else if (keyMode !== AUTO) body.keyField = keyMode;
      await workflowsApi.saveMonitor(workflowId, body);
      setExists(true);
      showToast?.(enabled ? "✓ Watching this workflow for changes" : "✓ Monitoring paused", "success");
      refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Stop watching "${workflowName}" for changes?`)) return;
    setBusy(true); setError(null);
    try {
      await workflowsApi.removeMonitor(workflowId);
      setExists(false); setEnabled(false);
      showToast?.("✓ Monitoring removed", "success");
      refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal mon-modal" onClick={e => e.stopPropagation()}>
        <div className="wf-header">
          <h2>Monitor "{workflowName}"</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="wf-body">
          {loading ? (
            <div className="wf-empty">Loading…</div>
          ) : (
            <>
              <label className="mon-toggle">
                <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={busy} />
                <span>Watch this workflow for changes between runs</span>
              </label>

              <div className={`mon-explain ${enabled ? "on" : ""}`}>
                {enabled
                  ? <>After each run, we compare the data to the previous run and record what was <strong>added</strong>, <strong>removed</strong>, or <strong>changed</strong>. Subscribe a webhook to <code>run.changed</code> to get notified.</>
                  : <>Turn this on to track how a page's data changes over time — new listings, price changes, removed items.</>}
              </div>

              <div className="wf-section-title">Which list to watch</div>
              <select className="mon-select" value={outputKey} onChange={e => setOutputKey(e.target.value)} disabled={!enabled || busy}>
                <option value="">Primary list (automatic)</option>
                {outputs.map(o => (
                  <option key={o.key} value={o.key}>{o.key}</option>
                ))}
              </select>

              <div className="wf-section-title">Match rows by</div>
              <select className="mon-select" value={keyMode} onChange={e => setKeyMode(e.target.value)} disabled={!enabled || busy}>
                <option value={AUTO}>Automatic (recommended)</option>
                <option value={WHOLE_ROW}>Whole row (any field differs = a new row)</option>
                {columns.map(c => (
                  <option key={c} value={c}>Unique by "{c}"</option>
                ))}
              </select>
              <div className="mon-hint">
                A stable id (product id, URL, SKU) gives the cleanest change tracking. "Automatic" picks one for you.
              </div>

              {error && <div className="wf-error">{error}</div>}

              <div className="mon-actions">
                {exists && (
                  <button className="wf-save-btn mon-remove" onClick={remove} disabled={busy}>Remove</button>
                )}
                <button className="wf-save-btn mon-save" onClick={save} disabled={busy}>
                  {exists ? "Save changes" : "Start monitoring"}
                </button>
              </div>

              {/* Recent change feed */}
              <div className="wf-section-title" style={{ marginTop: 18 }}>Recent changes</div>
              {changes.length === 0 ? (
                <div className="mon-feed-empty">
                  No changes recorded yet. Changes appear here after the workflow runs at least twice while monitored.
                </div>
              ) : (
                <div className="mon-feed">
                  {changes.map(c => <ChangeRow key={c.runId} change={c} />)}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ChangeRow({ change }) {
  const s = change.summary;
  const counts = s?.counts || {};
  const baseline = s?.baseline;
  return (
    <div className="mon-feed-row">
      <span className="mon-feed-when">{formatDate(change.at)}</span>
      {baseline ? (
        <span className="mon-feed-baseline">baseline · {counts.after ?? 0} rows</span>
      ) : (
        <span className="mon-feed-counts">
          {counts.added   > 0 && <span className="mon-chip add">+{counts.added} new</span>}
          {counts.changed > 0 && <span className="mon-chip chg">~{counts.changed} changed</span>}
          {counts.removed > 0 && <span className="mon-chip del">−{counts.removed} removed</span>}
          {!(counts.added || counts.changed || counts.removed) && <span className="mon-chip none">no change</span>}
        </span>
      )}
    </div>
  );
}

function formatDate(s) {
  if (!s) return "";
  const d = new Date(/T/.test(s) ? s : (String(s).replace(" ", "T") + "Z"));
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

import React, { useEffect, useState, useCallback } from "react";
import { workflowsApi } from "../api/client";
import "../styles/MonitorEditor.css";

/* =====================================================================
   SheetDeliveryEditor
   Per-workflow "Send results to Google Sheets". After each successful
   run, the chosen output list is appended to the sheet (a header row is
   written first when the tab is empty).

   Auth is a single instance-wide Google service account
   (GOOGLE_SERVICE_ACCOUNT_JSON on the server). The user shares their
   sheet with that account's e-mail — which this panel shows — and no
   per-user credentials are handled in the browser.

   Props:
     open, onClose
     workflowId, workflowName    required
     showToast(msg, type)
   ===================================================================== */

export default function SheetDeliveryEditor({ open, onClose, workflowId, workflowName, showToast }) {
  const [loading, setLoading] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);

  const [exists, setExists]   = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [spreadsheet, setSpreadsheet] = useState("");
  const [sheetName, setSheetName]     = useState("Sheet1");
  const [outputKey, setOutputKey]     = useState("");   // "" = primary
  const [outputs, setOutputs] = useState([]);
  const [svc, setSvc]         = useState({ configured: false, email: null });
  const [lastStatus, setLastStatus] = useState(null);
  const [lastSentAt, setLastSentAt] = useState(null);

  const refresh = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true); setError(null);
    try {
      const [res, ds] = await Promise.all([
        workflowsApi.getSheet(workflowId),
        workflowsApi.dataset(workflowId, { limit: 1 }).catch(() => ({ outputs: [] })),
      ]);
      setOutputs(ds.outputs || []);
      setSvc(res.serviceAccount || { configured: false, email: null });
      const s = res.sheet;
      setExists(!!s);
      setEnabled(s ? s.isActive : true);
      setSpreadsheet(s ? s.spreadsheetId : "");
      setSheetName(s ? (s.sheetName || "Sheet1") : "Sheet1");
      setOutputKey(s && s.outputKey ? s.outputKey : "");
      setLastStatus(s ? s.lastStatus : null);
      setLastSentAt(s ? s.lastSentAt : null);
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => { if (open) refresh(); /* eslint-disable-next-line */ }, [open, workflowId]);

  if (!open) return null;

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const saved = await workflowsApi.saveSheet(workflowId, {
        isActive: enabled,
        spreadsheet: spreadsheet.trim(),
        sheetName: sheetName.trim() || "Sheet1",
        outputKey: outputKey || null,
      });
      setExists(true);
      setLastStatus(saved.lastStatus);
      setLastSentAt(saved.lastSentAt);
      showToast?.(enabled ? "✓ Google Sheets delivery on" : "✓ Delivery paused", "success");
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Stop sending "${workflowName}" results to Google Sheets?`)) return;
    setBusy(true); setError(null);
    try {
      await workflowsApi.removeSheet(workflowId);
      setExists(false); setEnabled(false);
      showToast?.("✓ Sheet delivery removed", "success");
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
          <h2>Google Sheets — "{workflowName}"</h2>
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
              {!svc.configured && (
                <div className="wf-error" style={{ marginBottom: 12 }}>
                  No Google service account is configured on the server. Set
                  {" "}<code>GOOGLE_SERVICE_ACCOUNT_JSON</code> in the backend environment to enable delivery.
                  You can still save settings; they'll take effect once it's configured.
                </div>
              )}

              <label className="mon-toggle">
                <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={busy} />
                <span>Append each successful run's results to a Google Sheet</span>
              </label>

              {svc.email && (
                <div className="mon-explain on">
                  Share your sheet with this service account (as an <strong>Editor</strong>), then paste the sheet link below:
                  <div style={{ marginTop: 6 }}><code>{svc.email}</code></div>
                </div>
              )}

              <div className="wf-section-title">Google Sheet link or ID</div>
              <input
                className="mon-select"
                value={spreadsheet}
                onChange={e => setSpreadsheet(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…/edit"
                disabled={!enabled || busy}
              />

              <div className="wf-section-title">Tab name</div>
              <input
                className="mon-select"
                value={sheetName}
                onChange={e => setSheetName(e.target.value)}
                placeholder="Sheet1"
                disabled={!enabled || busy}
              />
              <div className="mon-hint">The tab (worksheet) to append to. Defaults to “Sheet1”.</div>

              <div className="wf-section-title">Which list to send</div>
              <select className="mon-select" value={outputKey} onChange={e => setOutputKey(e.target.value)} disabled={!enabled || busy}>
                <option value="">Primary list (automatic)</option>
                {outputs.map(o => <option key={o.key} value={o.key}>{o.key}</option>)}
              </select>
              <div className="mon-hint">
                A header row is written automatically when the tab is empty; later runs append below it.
              </div>

              {lastStatus && (
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 12 }}>
                  Last delivery: {lastStatus}{lastSentAt ? ` (${formatDate(lastSentAt)})` : ""}
                </div>
              )}

              {error && <div className="wf-error" style={{ marginTop: 10 }}>{error}</div>}

              <div className="mon-actions">
                {exists && <button className="wf-save-btn mon-remove" onClick={remove} disabled={busy}>Remove</button>}
                <button className="wf-save-btn mon-save" onClick={save} disabled={busy || (enabled && !spreadsheet.trim())}>
                  {exists ? "Save changes" : "Turn on delivery"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDate(s) {
  if (!s) return "";
  const d = new Date(/T/.test(s) ? s : (String(s).replace(" ", "T") + "Z"));
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

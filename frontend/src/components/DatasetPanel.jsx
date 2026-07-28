import React, { useEffect, useState, useCallback } from "react";
import { workflowsApi } from "../api/client";
import "../styles/DatasetPanel.css";

/* =====================================================================
   DatasetPanel
   Per-workflow "Data across runs" view: the workflow's extracted rows,
   accumulated and de-duplicated across its recent successful runs, with
   when each row was first/last seen and how many runs it appeared in.

   The dataset is computed on read by the backend (unioning results_json
   across retained runs), so it works retroactively and needs no new
   storage — but that also means "first seen" and "times seen" are over
   *retained* runs only. The footer states how many runs were considered.

   Props:
     open, onClose
     workflowId, workflowName    required
     showToast(msg, type)
   ===================================================================== */

const PAGE_SIZE = 100;
const WHOLE_ROW = "__row__";

export default function DatasetPanel({ open, onClose, workflowId, workflowName, showToast }) {
  const [data, setData]       = useState(null);   // full API payload for current view
  const [outputs, setOutputs] = useState([]);
  const [output, setOutput]   = useState(null);   // selected output key
  const [keyField, setKeyField] = useState(undefined); // undefined = "let backend default"
  const [offset, setOffset]   = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const load = useCallback(async (opts = {}) => {
    if (!workflowId) return;
    setLoading(true); setError(null);
    try {
      const params = { limit: PAGE_SIZE, offset: opts.offset ?? 0 };
      if (opts.output != null) params.output = opts.output;
      if (opts.keyField !== undefined) params.key = opts.keyField === null ? WHOLE_ROW : opts.keyField;
      const res = await workflowsApi.dataset(workflowId, params);
      setData(res);
      setOutputs(res.outputs || []);
      setOutput(res.output ?? null);
      // Backend echoes the key it actually used (null = whole-row) — adopt it
      // so the selector reflects reality on first load and after a change.
      setKeyField(res.keyField === undefined ? undefined : res.keyField);
      setOffset(res.offset ?? 0);
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
      setData(null); setOutputs([]);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  // (Re)load whenever the panel opens for a workflow.
  useEffect(() => {
    if (open) { setData(null); setKeyField(undefined); setOffset(0); load({ offset: 0 }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workflowId]);

  if (!open) return null;

  const changeOutput = (key) => { setOutput(key); load({ output: key, offset: 0 }); };
  const changeKey    = (val) => {
    // val is a column name, or WHOLE_ROW for the whole-row option.
    const kf = val === WHOLE_ROW ? null : val;
    setKeyField(kf);
    load({ output, keyField: kf, offset: 0 });
  };
  const gotoOffset = (o) => load({ output, keyField: keyField === undefined ? undefined : keyField, offset: o });

  const download = async (fmt) => {
    try {
      const params = {};
      if (output != null) params.output = output;
      if (keyField !== undefined) params.key = keyField === null ? WHOLE_ROW : keyField;
      const blob = await workflowsApi.datasetDownloadBlob(workflowId, fmt, params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `dataset-${workflowId}.${fmt}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast?.(`✗ ${err?.response?.data?.error || err.message}`, "error");
    }
  };

  const columns = data?.columns || [];
  const rows    = data?.rows || [];
  const total   = data?.total || 0;
  const hasData = rows.length > 0 || total > 0;
  const runsConsidered = data?.runsConsidered ?? 0;
  const selectedKeyValue = keyField === null ? WHOLE_ROW : (keyField ?? data?.keyField ?? WHOLE_ROW);

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal ds-modal" onClick={e => e.stopPropagation()}>
        <div className="wf-header">
          <h2>Data — {workflowName}</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="wf-save-btn" onClick={() => gotoOffset(offset)} disabled={loading} style={{ padding: "4px 10px" }}>
              {loading ? "…" : "Refresh"}
            </button>
            <button className="wf-close" onClick={onClose} aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        <div className="wf-body ds-body">
          {/* Controls */}
          <div className="ds-controls">
            {outputs.length > 1 && (
              <label className="ds-control">
                <span>List</span>
                <select value={output ?? ""} onChange={e => changeOutput(e.target.value)} disabled={loading}>
                  {outputs.map(o => (
                    <option key={o.key} value={o.key}>{o.key} ({o.latestCount} latest)</option>
                  ))}
                </select>
              </label>
            )}
            {hasData && (
              <label className="ds-control">
                <span>Unique by</span>
                <select value={selectedKeyValue} onChange={e => changeKey(e.target.value)} disabled={loading}>
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                  <option value={WHOLE_ROW}>Whole row (exact duplicates only)</option>
                </select>
              </label>
            )}
            <div className="ds-controls-spacer" />
            {hasData && (
              <div className="ds-downloads">
                <button className="wf-save-btn ds-xlsx" onClick={() => download("xlsx")} disabled={loading}>Excel (.xlsx)</button>
                <button className="wf-save-btn" onClick={() => download("csv")} disabled={loading}>CSV</button>
              </div>
            )}
          </div>

          {error && <div className="wf-error">{error}</div>}

          {/* Table / states */}
          {!error && !loading && !hasData && (
            <div className="ds-empty">
              <div className="ds-empty-emoji">🗃️</div>
              <h3>No data yet</h3>
              <p>Run this workflow to collect a list, then its rows accumulate here across every run.</p>
            </div>
          )}

          {!error && hasData && (
            <>
              <div className="ds-tablewrap">
                <table className="ds-table">
                  <thead>
                    <tr>
                      {columns.map(c => (
                        <th key={c} className={c === (keyField ?? data?.keyField) ? "ds-keycol" : undefined}>
                          {c}{c === (keyField ?? data?.keyField) ? " 🔑" : ""}
                        </th>
                      ))}
                      <th className="ds-meta">First seen</th>
                      <th className="ds-meta">Last seen</th>
                      <th className="ds-meta ds-meta-num">Times seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.key || i}>
                        {columns.map(c => (
                          <td key={c} title={cellTitle(r.data[c])}>{cell(r.data[c])}</td>
                        ))}
                        <td className="ds-meta">{relTime(r.firstSeenAt)}</td>
                        <td className="ds-meta">{relTime(r.lastSeenAt)}</td>
                        <td className="ds-meta ds-meta-num">{r.timesSeen}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pager */}
              <div className="ds-foot">
                <span className="ds-foot-info">
                  {total.toLocaleString()} unique row{total === 1 ? "" : "s"} across {runsConsidered} run{runsConsidered === 1 ? "" : "s"}
                  {keyField == null && data?.keyField == null ? " · de-duped on the whole row" : ""}
                </span>
                <span className="ds-pager">
                  <button className="wf-save-btn" disabled={loading || offset === 0}
                    onClick={() => gotoOffset(Math.max(0, offset - PAGE_SIZE))} style={{ padding: "4px 10px" }}>‹ Prev</button>
                  <span className="ds-pager-range">
                    {total === 0 ? "0" : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}`} of {total}
                  </span>
                  <button className="wf-save-btn" disabled={loading || offset + PAGE_SIZE >= total}
                    onClick={() => gotoOffset(offset + PAGE_SIZE)} style={{ padding: "4px 10px" }}>Next ›</button>
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Render a cell value compactly; objects/arrays as JSON.
function cell(v) {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}
function cellTitle(v) {
  if (v == null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

// Compact relative time; the timestamps come from the DB (UTC).
function relTime(iso) {
  if (!iso) return "—";
  const d = new Date(/T/.test(iso) ? iso : (String(iso).replace(" ", "T") + "Z"));
  const t = d.getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

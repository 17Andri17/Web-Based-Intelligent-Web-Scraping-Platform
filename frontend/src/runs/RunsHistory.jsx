import React, { useEffect, useState } from "react";
import { runsApi, workflowsApi } from "../api/client";

/* =====================================================================
   RunsHistory
   Modal showing the run history for a single workflow:
     - list of runs (status, duration, error category, trigger)
     - detail panel: AI summary, repairs, results download, logs view
     - "apply auto-fix" button for runs that produced a patched workflow

   Props:
     open, onClose
     workflowId, workflowName
     showToast(msg, type)
     onAppliedPatch(updatedWorkflow)   called when the user adopts a fix
   ===================================================================== */

export default function RunsHistory({ open, onClose, workflowId, workflowName, showToast, onAppliedPatch }) {
  const [runs,    setRuns]    = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail,  setDetail]  = useState(null);     // full run incl. results, repairs
  const [logs,    setLogs]    = useState(null);
  const [tab,     setTab]     = useState("summary"); // 'summary' | 'data' | 'logs' | 'repairs'

  const refresh = async () => {
    if (!workflowId) return;
    setLoading(true); setError(null);
    try {
      const list = await runsApi.list(workflowId);
      setRuns(list);
      if (list.length && !selectedId) setSelectedId(list[0].id);
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (open) refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, workflowId]);

  // Auto-refresh every 5s while a run is in progress
  useEffect(() => {
    if (!open) return;
    const anyRunning = runs.some(r => r.status === "running");
    if (!anyRunning) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runs]);

  // Load detail when selection changes
  useEffect(() => {
    if (!open || !selectedId) { setDetail(null); setLogs(null); return; }
    let alive = true;
    (async () => {
      try {
        const d = await runsApi.get(selectedId);
        if (alive) setDetail(d);
      } catch (err) {
        if (alive) setError(err?.response?.data?.error || err.message);
      }
    })();
    return () => { alive = false; };
  }, [open, selectedId]);

  // Lazy-load logs only when the logs tab opens
  useEffect(() => {
    if (!open || tab !== "logs" || !selectedId || logs) return;
    let alive = true;
    (async () => {
      try {
        const l = await runsApi.logs(selectedId);
        if (alive) setLogs(l);
      } catch (err) { if (alive) setError(err?.response?.data?.error || err.message); }
    })();
    return () => { alive = false; };
  }, [open, tab, selectedId, logs]);

  // Reset logs cache when switching runs
  useEffect(() => { setLogs(null); setTab("summary"); }, [selectedId]);

  if (!open) return null;

  const downloadBlob = async (fmt) => {
    if (!detail) return;
    try {
      const blob = await runsApi.downloadDataBlob(detail.id, fmt);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url;
      a.download = `run-${detail.id}.${fmt}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast?.(`✗ ${err?.response?.data?.error || err.message}`, "error");
    }
  };

  const adoptPatch = async () => {
    if (!detail) return;
    if (!confirm("Replace your saved workflow's steps with the AI-repaired version? You can undo via the Workflows menu (re-open the original).")) return;
    try {
      const wf = await runsApi.applyPatch(detail.id);
      const full = await workflowsApi.get(wf.id);
      showToast?.(`✓ Workflow "${full.name}" updated with auto-fix`, "success");
      onAppliedPatch?.(full);
    } catch (err) {
      showToast?.(`✗ ${err?.response?.data?.error || err.message}`, "error");
    }
  };

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 1000, width: "92vw", maxHeight: "85vh" }}>
        <div className="wf-header">
          <h2>History — {workflowName}</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="wf-save-btn" onClick={refresh} disabled={loading} style={{ padding: "4px 10px" }}>
              {loading ? "…" : "Refresh"}
            </button>
            <button className="wf-close" onClick={onClose} aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        <div className="wf-body" style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 12, height: "70vh" }}>
          {/* ── runs list ────────────────────────────────────────────── */}
          <div style={{ overflowY: "auto", borderRight: "1px solid var(--border-soft, #2a2a2a)", paddingRight: 8 }}>
            {error && <div className="wf-error">{error}</div>}
            {!loading && runs.length === 0 && (
              <div className="wf-empty">No runs yet. Hit ▶ to execute the workflow.</div>
            )}
            {runs.map(r => (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className="wf-item"
                style={{
                  display: "block", width: "100%", textAlign: "left", marginBottom: 6,
                  background: selectedId === r.id ? "var(--accent-soft, #1a2a4a)" : undefined,
                  border: "1px solid " + (selectedId === r.id ? "var(--accent-primary, #4f9cf9)" : "var(--border-soft, #2a2a2a)"),
                  borderRadius: 6, padding: "8px 10px", cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <StatusBadge status={r.status} />
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{r.trigger}</span>
                </div>
                <div style={{ fontSize: 12, marginTop: 4 }}>{formatDate(r.startedAt)}</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                  {formatDuration(r.durationMs)}
                  {r.errorCategory && <> · <span style={{ color: "#e89a4f" }}>{r.errorCategory}</span></>}
                  {r.retryCount > 0 && <> · {r.retryCount} retr{r.retryCount === 1 ? "y" : "ies"}</>}
                </div>
              </button>
            ))}
          </div>

          {/* ── detail panel ─────────────────────────────────────────── */}
          <div style={{ overflowY: "auto", paddingRight: 8 }}>
            {!detail ? (
              <div className="wf-empty">Select a run to see details.</div>
            ) : (
              <>
                {/* tabs */}
                <div style={{ display: "flex", gap: 4, marginBottom: 10, borderBottom: "1px solid var(--border-soft, #2a2a2a)" }}>
                  <DetailTab name="summary" tab={tab} setTab={setTab}>Summary</DetailTab>
                  <DetailTab name="data"    tab={tab} setTab={setTab} disabled={!detail.hasResults}>Data</DetailTab>
                  <DetailTab name="repairs" tab={tab} setTab={setTab} disabled={!detail.repairs || detail.repairs.length === 0}>
                    AI Repairs{detail.repairs?.length ? ` (${detail.repairs.length})` : ""}
                  </DetailTab>
                  <DetailTab name="logs"    tab={tab} setTab={setTab}>Logs</DetailTab>
                </div>

                {tab === "summary" && (
                  <Summary detail={detail} onDownloadJson={() => downloadBlob("json")} onDownloadCsv={() => downloadBlob("csv")} onAdopt={adoptPatch} />
                )}
                {tab === "data" && <ResultsView results={detail.results} />}
                {tab === "repairs" && <RepairsView repairs={detail.repairs} />}
                {tab === "logs" && <LogsView logs={logs} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Subcomponents ─────────────────────────────────────────────────── */

function DetailTab({ name, tab, setTab, disabled, children }) {
  const active = tab === name;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setTab(name)}
      style={{
        background: "transparent", color: active ? "var(--accent-primary, #4f9cf9)" : "var(--text-secondary)",
        border: "none", borderBottom: "2px solid " + (active ? "var(--accent-primary, #4f9cf9)" : "transparent"),
        padding: "6px 10px", cursor: disabled ? "not-allowed" : "pointer", fontSize: 13, opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Summary({ detail, onDownloadJson, onDownloadCsv, onAdopt }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        <Stat label="Status"    value={<StatusBadge status={detail.status} />} />
        <Stat label="Trigger"   value={detail.trigger} />
        <Stat label="Started"   value={formatDate(detail.startedAt)} />
        <Stat label="Duration"  value={formatDuration(detail.durationMs)} />
        {detail.retryCount > 0 && <Stat label="Retries" value={detail.retryCount} />}
      </div>

      {detail.aiSummary && (
        <Note label="Analysis" tone={
          detail.status === "success" ? "ok" : detail.status === "needs_review" ? "warn" : "err"
        }>
          {detail.aiSummary}
        </Note>
      )}

      {detail.failedStep && (
        <Note label="Failing step" tone="warn">
          <div style={{ fontFamily: "monospace", fontSize: 12 }}>
            {detail.failedStep.label || "(no label)"} <span style={{ opacity: 0.7 }}>· {detail.failedStep.type}</span>
          </div>
        </Note>
      )}

      {detail.errorMessage && (
        <Note label="Error" tone="err">
          <code style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{detail.errorMessage}</code>
        </Note>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {detail.hasResults && (
          <>
            <button className="wf-save-btn" onClick={onDownloadJson}>Download data (JSON)</button>
            <button className="wf-save-btn" onClick={onDownloadCsv}>Download data (CSV)</button>
          </>
        )}
        {detail.hasPatchedSteps && (
          <button className="wf-save-btn"
                  onClick={onAdopt}
                  style={{ background: "var(--accent-primary, #4f9cf9)", color: "#fff" }}>
            Adopt AI-repaired workflow
          </button>
        )}
      </div>
    </div>
  );
}

function ResultsView({ results }) {
  if (!results) return <div className="wf-empty">No data captured for this run.</div>;
  const keys = Object.keys(results);
  return (
    <div>
      {keys.map(k => (
        <details key={k} style={{ marginBottom: 10 }} open={keys.length === 1}>
          <summary style={{ cursor: "pointer", padding: "6px 8px", background: "var(--bg-elev, #161616)", borderRadius: 4 }}>
            <strong>{k}</strong>
            <span style={{ color: "var(--text-secondary)", marginLeft: 8, fontSize: 11 }}>
              {Array.isArray(results[k]) ? `${results[k].length} item${results[k].length === 1 ? "" : "s"}` :
               typeof results[k] === "object" ? "object" : "scalar"}
            </span>
          </summary>
          <pre style={{ fontSize: 11, maxHeight: 300, overflow: "auto", background: "var(--bg, #0e0e0e)", padding: 8, marginTop: 6 }}>
            {JSON.stringify(results[k], null, 2)}
          </pre>
        </details>
      ))}
    </div>
  );
}

function RepairsView({ repairs }) {
  if (!repairs || repairs.length === 0) return <div className="wf-empty">No AI repairs were attempted on this run.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {repairs.map(r => (
        <div key={r.id} style={{
          border: "1px solid " + (r.verified ? "#3ea66f" : r.applied ? "#e89a4f" : "#a44"),
          borderRadius: 6, padding: 10, fontSize: 12,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <strong>Attempt #{r.attempt} · {r.stepType}</strong>
            <span style={{
              fontSize: 11,
              color: r.verified ? "#3ea66f" : r.applied ? "#e89a4f" : "#a44",
            }}>
              {r.llmError ? `LLM error: ${r.llmError}` :
               r.verified ? "verified" : r.applied ? "applied (not yet verified)" : "rejected"}
              {r.confidence ? ` · ${r.confidence}` : ""}
            </span>
          </div>
          {r.errorMessage && (
            <div style={{ marginBottom: 6, color: "var(--text-secondary)" }}>
              <em>Original error:</em> {r.errorMessage}
            </div>
          )}
          {r.suggestedParams && (
            <details>
              <summary style={{ cursor: "pointer" }}>Proposed patch</summary>
              <pre style={{ fontSize: 11, background: "var(--bg, #0e0e0e)", padding: 8, marginTop: 6 }}>
{JSON.stringify(r.suggestedParams, null, 2)}
              </pre>
            </details>
          )}
          {r.explanation && (
            <div style={{ marginTop: 6, color: "var(--text-secondary)" }}>{r.explanation}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function LogsView({ logs }) {
  if (!logs) return <div className="wf-empty">Loading logs…</div>;
  if (logs.length === 0) return <div className="wf-empty">No log lines.</div>;
  return (
    <div style={{ background: "var(--bg, #0e0e0e)", padding: 8, fontSize: 11, fontFamily: "monospace", maxHeight: "60vh", overflow: "auto" }}>
      {logs.map(l => (
        <div key={l.seq} style={{ color: l.level === "error" ? "#e6776a" : "var(--text-secondary, #ccc)", whiteSpace: "pre-wrap" }}>
          {l.line}
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 10, textTransform: "uppercase", color: "var(--text-secondary)", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 13, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Note({ label, tone, children }) {
  const color = tone === "ok" ? "#3ea66f" : tone === "warn" ? "#e89a4f" : tone === "err" ? "#e6776a" : "var(--text-secondary)";
  return (
    <div style={{ borderLeft: `3px solid ${color}`, paddingLeft: 10, fontSize: 13 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", color, letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    running:      { label: "running",      color: "#4f9cf9" },
    success:      { label: "success",      color: "#3ea66f" },
    error:        { label: "error",        color: "#e6776a" },
    needs_review: { label: "needs review", color: "#e89a4f" },
    cancelled:    { label: "cancelled",    color: "#888"    },
  };
  const m = map[status] || { label: status, color: "#888" };
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 10,
      background: m.color + "22", color: m.color, border: `1px solid ${m.color}55`, textTransform: "uppercase", letterSpacing: 0.5,
    }}>
      {m.label}
    </span>
  );
}

function formatDate(s) {
  if (!s) return "—";
  const d = new Date(/T/.test(s) ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

function formatDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000), s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

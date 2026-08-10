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
    if (!confirm("Replace your saved workflow's steps with the AI-repaired version? You can roll back from any run in this history.")) return;
    try {
      const wf = await runsApi.applyPatch(detail.id);
      const full = await workflowsApi.get(wf.id);
      showToast?.(`✓ Workflow "${full.name}" updated with auto-fix`, "success");
      onAppliedPatch?.(full);
    } catch (err) {
      showToast?.(`✗ ${err?.response?.data?.error || err.message}`, "error");
    }
  };

  const restoreVersion = async () => {
    if (!detail) return;
    if (!confirm("Roll the workflow back to the exact version this run executed? Your current steps will be replaced (you can restore another run's version later).")) return;
    try {
      const wf = await runsApi.restore(detail.id);
      const full = await workflowsApi.get(wf.id);
      showToast?.(`✓ Workflow "${full.name}" rolled back to run #${detail.id}'s version`, "success");
      onAppliedPatch?.(full);
    } catch (err) {
      showToast?.(`✗ ${err?.response?.data?.error || err.message}`, "error");
    }
  };

  // Continue a run that stopped early. The server starts it in the background
  // and answers with the new run id, so we just refresh the list and let the
  // normal in-progress polling take over.
  const resumeRun = async (runId) => {
    try {
      const r = await runsApi.resume(runId);
      showToast?.(`✓ ${r.message || "Resuming run"}`, "success");
      await refresh();
    } catch (err) {
      showToast?.(`✗ ${err?.response?.data?.error || err.message}`, "error");
    }
  };

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal wf-modal-xl" onClick={e => e.stopPropagation()}>
        <div className="wf-header">
          <div className="wf-header-titles"><h2>Run history</h2><span className="wf-header-sub">{workflowName}</span></div>
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
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {r.versionId != null && <span title="Workflow version this run executed" style={{ marginRight: 6, opacity: 0.8 }}>v{r.versionId}</span>}
                    {r.trigger}
                  </span>
                </div>
                <div style={{ fontSize: 12, marginTop: 4 }}>{formatDate(r.startedAt)}</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                  {formatDuration(r.durationMs)}
                  {r.errorCategory && <> · <span style={{ color: "#e89a4f" }}>{r.errorCategory}</span></>}
                  {r.retryCount > 0 && <> · {r.retryCount} retr{r.retryCount === 1 ? "y" : "ies"}</>}
                </div>
                <ChangeBadge summary={r.changeSummary} />
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
                  <Summary detail={detail}
                    onDownloadJson={() => downloadBlob("json")}
                    onDownloadCsv={() => downloadBlob("csv")}
                    onDownloadCsvZip={() => downloadBlob("csv.zip")}
                    onDownloadXlsx={() => downloadBlob("xlsx")}
                    onAdopt={adoptPatch} onRestore={restoreVersion} onResume={resumeRun} />
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

// Compact change-monitoring badge for a run row / detail. Shows +new ~changed
// −removed vs the previous run, or a "baseline" pill for the first run.
function ChangeBadge({ summary }) {
  if (!summary) return null;
  const c = summary.counts || {};
  const chip = { fontSize: 10, padding: "1px 6px", borderRadius: 8, whiteSpace: "nowrap" };
  if (summary.baseline) {
    return (
      <div style={{ marginTop: 4 }}>
        <span style={{ ...chip, color: "#8b949e", border: "1px solid #8b949e44" }}>baseline · {c.after ?? 0} rows</span>
      </div>
    );
  }
  const any = (c.added || 0) + (c.changed || 0) + (c.removed || 0) > 0;
  return (
    <div style={{ marginTop: 4, display: "flex", gap: 5, flexWrap: "wrap" }}>
      {c.added   > 0 && <span style={{ ...chip, color: "#3fb950", border: "1px solid #3fb95055", background: "#3fb9501a" }}>+{c.added} new</span>}
      {c.changed > 0 && <span style={{ ...chip, color: "#d29922", border: "1px solid #d2992255", background: "#d299221a" }}>~{c.changed} changed</span>}
      {c.removed > 0 && <span style={{ ...chip, color: "#f85149", border: "1px solid #f8514955", background: "#f851491a" }}>−{c.removed} removed</span>}
      {!any && <span style={{ ...chip, color: "#8b949e", border: "1px solid #8b949e44" }}>no change</span>}
    </div>
  );
}

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

function Summary({ detail, onDownloadJson, onDownloadCsv, onDownloadCsvZip, onDownloadXlsx, onAdopt, onRestore, onResume }) {
  // Whether this run can be continued rather than re-run. Asked lazily, and
  // only for runs that stopped early — a successful run has nothing to resume.
  const [resumeState, setResumeState] = useState(null);
  const [resuming, setResuming] = useState(false);
  const canAsk = detail.status === "partial" || detail.status === "error" || detail.status === "cancelled";

  useEffect(() => {
    let cancelled = false;
    setResumeState(null);
    if (!canAsk) return;
    runsApi.resumeInfo(detail.id)
      .then(info => { if (!cancelled) setResumeState(info); })
      .catch(() => { if (!cancelled) setResumeState(null); });
    return () => { cancelled = true; };
  }, [detail.id, canAsk]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        <Stat label="Status"    value={<StatusBadge status={detail.status} />} />
        <Stat label="Trigger"   value={detail.trigger} />
        <Stat label="Started"   value={formatDate(detail.startedAt)} />
        <Stat label="Duration"  value={formatDuration(detail.durationMs)} />
        {detail.rowsCaptured > 0 && <Stat label="Rows kept" value={detail.rowsCaptured.toLocaleString()} />}
        {detail.retryCount > 0 && <Stat label="Retries" value={detail.retryCount} />}
        {detail.versionId != null && <Stat label="Version" value={`v${detail.versionId}`} />}
        {detail.parentRunId != null && <Stat label="Resumed from" value={`#${detail.parentRunId}`} />}
      </div>

      {detail.status === "partial" && (
        <Note label="Partial run" tone="warn">
          This run stopped before finishing, but the {detail.rowsCaptured ? detail.rowsCaptured.toLocaleString() : ""} row(s)
          it had already captured were saved and are downloadable below.
          {resumeState && resumeState.resumable
            ? ` You can continue it — ${resumeState.items.toLocaleString()} item(s) already done will be skipped.`
            : resumeState && resumeState.reason ? ` ${resumeState.reason}` : ""}
        </Note>
      )}

      {detail.aiSummary && (
        <Note label="Analysis" tone={
          detail.status === "success" ? "ok"
            : (detail.status === "needs_review" || detail.status === "partial") ? "warn"
            : "err"
        }>
          {detail.aiSummary}
        </Note>
      )}

      {detail.changeSummary && (
        <Note label="Changes since last run" tone="ok">
          <ChangeBadge summary={detail.changeSummary} />
          {!detail.changeSummary.baseline && detail.changeSummary.sample?.changed?.length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 6 }}>
              Changed fields: {[...new Set(detail.changeSummary.sample.changed.flatMap(c => c.fields || []))].slice(0, 8).join(", ")}
            </div>
          )}
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
        {resumeState && resumeState.resumable && (
          <button className="wf-save-btn"
                  disabled={resuming}
                  onClick={async () => { setResuming(true); try { await onResume(detail.id); } finally { setResuming(false); } }}
                  style={{ background: "var(--accent-primary, #4f9cf9)", color: "#fff" }}
                  title={`Continue this run — the ${resumeState.items} item(s) it already captured will be skipped`}>
            {resuming ? "Resuming…" : `▶ Resume (skip ${resumeState.items.toLocaleString()} done)`}
          </button>
        )}
        {detail.hasResults && (
          <>
            <button className="wf-save-btn" onClick={onDownloadXlsx}
                    style={{ background: "var(--accent-success, #3fb950)", color: "#fff" }}>Download Excel (.xlsx)</button>
            <button className="wf-ghost-btn" onClick={onDownloadCsvZip}
                    title="One properly-formed CSV per table, zipped — the right choice when a run captures more than one table">
              CSV per table (.zip)
            </button>
            <button className="wf-ghost-btn" onClick={onDownloadCsv}
                    title="All tables concatenated into one file, separated by # headings">
              Single CSV
            </button>
            <button className="wf-save-btn" onClick={onDownloadJson}>Download data (JSON)</button>
          </>
        )}
        {detail.hasPatchedSteps && (
          <button className="wf-save-btn"
                  onClick={onAdopt}
                  style={{ background: "var(--accent-primary, #4f9cf9)", color: "#fff" }}>
            Adopt AI-repaired workflow
          </button>
        )}
        {detail.versionId != null && (
          <button className="wf-save-btn"
                  onClick={onRestore}
                  title={`Roll the workflow back to the version run #${detail.id} executed (v${detail.versionId})`}>
            ↩ Restore this version
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
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
            <strong style={{ display: "flex", alignItems: "center", gap: 6 }}>
              Attempt #{r.attempt} · {r.stepType}
              {r.repairKind && <RepairKindChip kind={r.repairKind} />}
            </strong>
            <span style={{
              fontSize: 11,
              color: r.verified ? "#3ea66f" : r.applied ? "#e89a4f" : "#a44",
              textAlign: "right",
            }}>
              {r.llmError ? `LLM error: ${r.llmError}` :
               r.repairKind === "manual" ? "manual action needed" :
               r.verified ? "verified" : r.applied ? "applied (not yet verified)" : "rejected"}
              {r.confidence ? ` · ${r.confidence}` : ""}
              {r.autoAdopted && <span style={{ color: "#3ea66f" }}> · auto-adopted</span>}
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
          {r.evidence && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--text-secondary)" }}>
                Verification evidence (checked against the live page, no AI)
              </summary>
              <pre style={{ fontSize: 11, background: "var(--bg, #0e0e0e)", padding: 8, marginTop: 6, overflow: "auto" }}>
{JSON.stringify(r.evidence, null, 2)}
              </pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

const REPAIR_KIND_LABELS = {
  selector:      { label: "selector fix",  color: "#4f9cf9" },
  "field-drop":  { label: "field dropped", color: "#e89a4f" },
  "remove-step": { label: "step removed",  color: "#e89a4f" },
  manual:        { label: "needs you",     color: "#e0556a" },
};

function RepairKindChip({ kind }) {
  const k = REPAIR_KIND_LABELS[kind] || { label: kind, color: "#888" };
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em",
      padding: "1px 6px", borderRadius: 8, color: k.color,
      border: `1px solid ${k.color}`, background: "transparent",
    }}>
      {k.label}
    </span>
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
    // Stopped early but kept what it captured — the results ARE viewable.
    partial:      { label: "partial",      color: "#e89a4f" },
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

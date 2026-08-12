import React, { useState, useMemo, useEffect } from "react";
import { workflowsApi } from "../api/client";
import { parseBulkRows } from "../utils/bulkInputs";
import "../styles/MonitorEditor.css";
import useDialog from "./useDialog";

/* =====================================================================
   RunInputsDialog
   Trigger background runs of a saved workflow with per-run variable
   overrides. Two modes:
     • "One run"  — fill the workflow's variables and run once.
     • "Many runs" — paste a list / CSV and run once per row.

   Runs are enqueued and executed headless by the API worker (the same
   path as scheduled and /v1 runs), so self-healing, monitoring, sheets
   delivery and webhooks all apply. Progress shows in Run history.

   Props:
     open, onClose
     workflowId, workflowName    required (must be a SAVED workflow)
     variables                   [{ name, value, type, description }]
     showToast(msg, type)
     onQueued(count)             optional — after runs are enqueued
   ===================================================================== */

export default function RunInputsDialog({ open, onClose, workflowId, workflowName, variables = [], showToast, onQueued }) {
  // Focus trap, Escape, focus restore, scroll lock, backdrop semantics.
  const { overlayProps, dialogProps } = useDialog({ open, onClose });
  const [mode, setMode]   = useState("single"); // 'single' | 'bulk'
  const [single, setSingle] = useState({});     // varName -> value
  const [text, setText]   = useState("");
  const [columnVar, setColumnVar] = useState(""); // single-column target
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setMode("single");
    setSingle(Object.fromEntries(variables.map(v => [v.name, v.value ?? ""])));
    setText(""); setError(null);
    setColumnVar(variables[0]?.name || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workflowId]);

  const parsed = useMemo(
    () => parseBulkRows(text, { variables, columnVar: columnVar || undefined }),
    [text, variables, columnVar]
  );

  if (!open) return null;

  const runSingle = async () => {
    // Include only variables the user gave a non-empty value; the rest fall
    // back to their defaults at run time.
    const inputs = {};
    for (const v of variables) {
      const val = single[v.name];
      if (val !== undefined && val !== "") inputs[v.name] = String(val);
    }
    await enqueue([inputs]);
  };

  const runBulk = async () => {
    if (parsed.error) { setError(parsed.error); return; }
    if (!parsed.rows.length) { setError("Nothing to run — paste at least one line."); return; }
    await enqueue(parsed.rows);
  };

  const enqueue = async (rows) => {
    setBusy(true); setError(null);
    try {
      const { created } = await workflowsApi.bulkRun(workflowId, rows);
      showToast?.(`✓ Queued ${created} run${created === 1 ? "" : "s"} — watch progress in History`, "success");
      onQueued?.(created);
      onClose?.();
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const noVars = variables.length === 0;

  return (
    <div className="wf-overlay" {...overlayProps}>
      <div className="wf-modal mon-modal" {...dialogProps}>
        <div className="wf-header">
          <h2>Run "{workflowName}"</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="wf-body">
          {/* Mode tabs */}
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            <button className="wf-save-btn" style={tabStyle(mode === "single")} onClick={() => setMode("single")}>One run</button>
            <button className="wf-save-btn" style={tabStyle(mode === "bulk")} onClick={() => setMode("bulk")} disabled={noVars} title={noVars ? "Add workflow variables to run in bulk" : undefined}>
              Many runs from a list
            </button>
          </div>

          {noVars && (
            <div className="mon-explain" style={{ marginBottom: 12 }}>
              This workflow has no variables. It will run with its saved settings.
              Add variables (in the Workflow panel) to parameterize runs.
            </div>
          )}

          {mode === "single" ? (
            <>
              {variables.map(v => (
                <div key={v.name} style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 13, display: "block", marginBottom: 4 }}>
                    {v.name}
                    {v.description && <span style={{ color: "var(--text-secondary)", marginLeft: 6, fontSize: 12 }}>{v.description}</span>}
                  </label>
                  <input
                    className="mon-select"
                    value={single[v.name] ?? ""}
                    onChange={e => setSingle(s => ({ ...s, [v.name]: e.target.value }))}
                    placeholder={v.value != null && v.value !== "" ? `default: ${v.value}` : "value"}
                  />
                </div>
              ))}
              {error && <div className="wf-error" style={{ marginTop: 6 }}>{error}</div>}
              <div className="mon-actions">
                <button className="wf-save-btn mon-save" onClick={runSingle} disabled={busy}>
                  {busy ? "Starting…" : "Run once"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="mon-hint" style={{ marginBottom: 8 }}>
                Paste one input per line, or a CSV whose header row names your variables
                ({variables.map(v => v.name).join(", ")}). One run starts per line.
              </div>

              {/* Single-column target picker (only relevant when not using a CSV header) */}
              {parsed.mode !== "csv" && variables.length > 1 && (
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 13, marginRight: 8 }}>Each line fills:</label>
                  <select className="mon-select" style={{ width: "auto", display: "inline-block" }}
                          value={columnVar} onChange={e => setColumnVar(e.target.value)}>
                    {variables.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
                  </select>
                </div>
              )}

              <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder={variables.length > 1
                  ? `${variables.map(v => v.name).join(",")}\nvalue1,value2\nvalue3,value4`
                  : "https://example.com/a\nhttps://example.com/b"}
                rows={8}
                style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
              />

              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>
                {parsed.rows.length > 0
                  ? <>Will start <strong>{parsed.rows.length}</strong> run{parsed.rows.length === 1 ? "" : "s"}
                      {parsed.mode === "csv" ? ` (CSV columns: ${parsed.columns.join(", ")})` : ` (each line → “${parsed.target}”)`}.
                      {" "}First: <code>{JSON.stringify(parsed.rows[0])}</code></>
                  : "Paste a list above to preview the runs."}
              </div>

              {error && <div className="wf-error" style={{ marginTop: 8 }}>{error}</div>}
              <div className="mon-actions">
                <button className="wf-save-btn mon-save" onClick={runBulk} disabled={busy || parsed.rows.length === 0}>
                  {busy ? "Queuing…" : `Run ${parsed.rows.length || ""} time${parsed.rows.length === 1 ? "" : "s"}`.trim()}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function tabStyle(active) {
  return {
    background: active ? "var(--accent-primary, var(--accent-primary))" : "transparent",
    color: active ? "var(--text-on-accent)" : "var(--text-secondary)",
  };
}

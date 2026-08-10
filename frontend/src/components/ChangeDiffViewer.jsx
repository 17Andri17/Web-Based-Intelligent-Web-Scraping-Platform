import React, { useCallback, useEffect, useMemo, useState } from "react";
import { workflowsApi } from "../api/client";
import "../styles/ChangeDiffViewer.css";

/* =====================================================================
   ChangeDiffViewer
   "What actually changed?" for a monitored workflow.

   The monitor stores a bounded summary on each run; this view asks the
   backend for the *full* diff instead (GET /workflows/:id/diff), so it
   can show every changed row with its old and new value, and can compare
   any two runs — including ones that predate monitoring being enabled.

   Three buckets, each a real table:
     Changed — one card per row, field | before | after
     Added   — the new rows in full
     Removed — the rows that disappeared, in full

   Props:
     open, onClose
     workflowId, workflowName   required
     initialRunId               run to open on (default: latest)
     showToast(msg, type)
   ===================================================================== */

const WHOLE_ROW = "__row__";
const BUCKETS = [
  { id: "changed", label: "Changed", tone: "chg" },
  { id: "added",   label: "Added",   tone: "add" },
  { id: "removed", label: "Removed", tone: "del" },
];

export default function ChangeDiffViewer({
  open, onClose, workflowId, workflowName, initialRunId, showToast,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [data, setData]       = useState(null);

  // Selection — null means "let the backend default it".
  const [runId, setRunId]         = useState(initialRunId ?? null);
  const [baseRunId, setBaseRunId] = useState(null);
  const [output, setOutput]       = useState(null);
  const [keyMode, setKeyMode]     = useState(null);

  const [bucket, setBucket] = useState("changed");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState({});   // changed-row key → show whole row

  // Reset to "latest vs previous" every time the modal is opened, so it never
  // reopens showing a stale comparison from a different run.
  useEffect(() => {
    if (!open) return;
    setRunId(initialRunId ?? null);
    setBaseRunId(null);
    setOutput(null);
    setKeyMode(null);
    setBucket("changed");
    setFilter("");
    setExpanded({});
  }, [open, initialRunId, workflowId]);

  const load = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true); setError(null);
    try {
      const params = {};
      if (runId != null)     params.runId = runId;
      if (baseRunId != null) params.baseRunId = baseRunId;
      if (output != null)    params.output = output;
      if (keyMode != null)   params.key = keyMode;
      setData(await workflowsApi.diff(workflowId, params));
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [workflowId, runId, baseRunId, output, keyMode]);

  useEffect(() => { if (open) load(); }, [open, load]);

  if (!open) return null;

  const diff    = data?.diff || null;
  const counts  = diff?.counts || {};
  const runs    = data?.runs || [];
  const outputs = data?.outputs || [];
  // The backend echoes what it actually used, so the pickers show the real
  // choice even while ours are still null ("automatic").
  const activeOutput = data?.output || "";
  const activeKey    = data?.keyField === "" ? WHOLE_ROW : (data?.keyField || "");
  const columns = outputs.find(o => o.key === activeOutput)?.fields || [];

  const rows = diff ? diff[bucket] || [] : [];
  const visible = filterRows(rows, bucket, filter);

  const copyJson = () => {
    if (!diff) return;
    const payload = { output: activeOutput, keyField: data.keyField, counts, [bucket]: rows };
    navigator.clipboard?.writeText(JSON.stringify(payload, null, 2))
      .then(() => showToast?.(`✓ Copied ${rows.length} ${bucket} row${rows.length === 1 ? "" : "s"} as JSON`, "success"))
      .catch(() => showToast?.("✗ Couldn't copy to the clipboard", "error"));
  };

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal wf-modal-xl diff-modal" onClick={e => e.stopPropagation()}>
        <div className="wf-header">
          <div className="wf-header-titles">
            <h2>Changes</h2>
            <span className="wf-header-sub">{workflowName}</span>
          </div>
          <button className="wf-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* ── What is being compared ─────────────────────────────────── */}
        <div className="diff-controls">
          <div className="diff-compare">
            <label>
              <span>Before</span>
              <select
                value={data?.base?.id ?? ""}
                onChange={e => setBaseRunId(e.target.value === "" ? null : Number(e.target.value))}
                disabled={loading || runs.length === 0}
              >
                {!data?.base && <option value="">— no earlier run —</option>}
                {runs.map(r => (
                  <option key={r.id} value={r.id}>Run #{r.id} · {formatDate(r.finishedAt || r.startedAt)}</option>
                ))}
              </select>
            </label>
            <span className="diff-arrow" aria-hidden="true">→</span>
            <label>
              <span>After</span>
              <select
                value={data?.run?.id ?? ""}
                onChange={e => { setRunId(Number(e.target.value)); setBaseRunId(null); }}
                disabled={loading || runs.length === 0}
              >
                {runs.map(r => (
                  <option key={r.id} value={r.id}>Run #{r.id} · {formatDate(r.finishedAt || r.startedAt)}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="diff-compare">
            <label>
              <span>List</span>
              <select value={activeOutput} onChange={e => setOutput(e.target.value)} disabled={loading || outputs.length === 0}>
                {outputs.map(o => <option key={o.key} value={o.key}>{o.key}</option>)}
              </select>
            </label>
            <label>
              <span>Match rows by</span>
              <select value={activeKey} onChange={e => setKeyMode(e.target.value)} disabled={loading}>
                <option value={WHOLE_ROW}>Whole row</option>
                {columns.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="wf-body diff-body">
          {error && <div className="wf-error">{error}</div>}

          {loading ? (
            <div className="wf-empty">Comparing runs…</div>
          ) : !diff ? (
            <div className="wf-empty">
              {runs.length === 0
                ? "This workflow hasn't produced a successful run with data yet."
                : "This run has no list of rows to compare."}
            </div>
          ) : (
            <>
              {!data.base && (
                <div className="diff-note">
                  This is the earliest run with data — there's nothing before it to compare against,
                  so every row counts as new.
                </div>
              )}

              {/* ── Headline numbers ────────────────────────────────── */}
              <div className="diff-stats">
                <Stat tone="add"  value={counts.added}     label="added" />
                <Stat tone="chg"  value={counts.changed}   label="changed" />
                <Stat tone="del"  value={counts.removed}   label="removed" />
                <Stat tone="same" value={counts.unchanged} label="unchanged" />
                <div className="diff-totals">
                  {counts.before} row{counts.before === 1 ? "" : "s"} before
                  <span className="diff-arrow-sm">→</span>
                  {counts.after} row{counts.after === 1 ? "" : "s"} after
                </div>
              </div>

              {/* ── Which fields move the most ──────────────────────── */}
              {diff.fieldStats?.length > 0 && (
                <div className="diff-fields">
                  <div className="wf-section-title">Fields that changed</div>
                  <div className="diff-field-bars">
                    {diff.fieldStats.map(f => (
                      <button
                        key={f.field}
                        className={`diff-field-bar ${filter === f.field ? "active" : ""}`}
                        onClick={() => { setBucket("changed"); setFilter(filter === f.field ? "" : f.field); }}
                        title={`Show the ${f.rows} row${f.rows === 1 ? "" : "s"} where "${f.field}" changed`}
                      >
                        <span className="fill" style={{ width: `${pct(f.rows, diff.fieldStats[0].rows)}%` }} />
                        <span className="name">{f.field}</span>
                        <span className="count">{f.rows}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Bucket tabs + filter ────────────────────────────── */}
              <div className="diff-tabs">
                {BUCKETS.map(b => (
                  <button
                    key={b.id}
                    className={`diff-tab ${b.tone} ${bucket === b.id ? "active" : ""}`}
                    onClick={() => { setBucket(b.id); setFilter(""); }}
                    disabled={!counts[b.id]}
                  >
                    {b.label}
                    <span className="diff-tab-count">{counts[b.id] ?? 0}</span>
                  </button>
                ))}
                <div className="diff-tools">
                  <input
                    className="diff-filter"
                    type="search"
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder="Filter rows…"
                  />
                  <button className="wf-ghost-btn" onClick={copyJson} disabled={rows.length === 0}>Copy JSON</button>
                </div>
              </div>

              {diff.truncated?.[bucket] && (
                <div className="diff-note">
                  Showing the first {rows.length} of {counts[bucket]} {bucket} rows.
                </div>
              )}

              {/* ── The rows ────────────────────────────────────────── */}
              {rows.length === 0 ? (
                <div className="wf-empty">Nothing {bucket} between these two runs.</div>
              ) : visible.length === 0 ? (
                <div className="wf-empty">No {bucket} rows match "{filter}".</div>
              ) : bucket === "changed" ? (
                <div className="diff-changed-list">
                  {visible.map((c, i) => (
                    <ChangedRow
                      key={`${c.key}-${i}`}
                      change={c}
                      expanded={!!expanded[c.key]}
                      onToggle={() => setExpanded(e => ({ ...e, [c.key]: !e[c.key] }))}
                    />
                  ))}
                </div>
              ) : (
                <RowTable rows={visible} tone={bucket === "added" ? "add" : "del"} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── One changed row: the fields that moved, old value → new value ────────── */
function ChangedRow({ change, expanded, onToggle }) {
  const before = change.before || {};
  const after  = change.after || {};
  const changedFields = change.fields || [];
  // Expanded shows every field so a change can be read in the context of the
  // whole row; collapsed shows only what actually moved.
  const shown = expanded
    ? [...new Set([...Object.keys(before), ...Object.keys(after)])]
    : changedFields;

  return (
    <div className="diff-row-card">
      <div className="diff-row-head">
        <span className="diff-row-key" title={change.key}>{change.key}</span>
        <span className="diff-row-fields">
          {changedFields.map(f => <span className="diff-chip" key={f}>{f}</span>)}
        </span>
        <button className="wf-ghost-btn" onClick={onToggle}>
          {expanded ? "Only changes" : "Whole row"}
        </button>
      </div>
      <table className="diff-table">
        <thead>
          <tr><th className="col-field">Field</th><th>Before</th><th>After</th></tr>
        </thead>
        <tbody>
          {shown.map(f => {
            const moved = changedFields.includes(f);
            return (
              <tr key={f} className={moved ? "moved" : "same"}>
                <td className="col-field">{f}</td>
                <td className="col-before"><Value v={before[f]} tone={moved ? "del" : null} /></td>
                <td className="col-after"><Value v={after[f]} tone={moved ? "add" : null} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Added / removed rows as a plain table, tinted by bucket ──────────────── */
function RowTable({ rows, tone }) {
  const columns = useMemo(() => {
    const seen = [];
    for (const r of rows) {
      for (const k of Object.keys(r || {})) if (!seen.includes(k)) seen.push(k);
    }
    return seen;
  }, [rows]);

  return (
    <div className="diff-table-wrap">
      <table className={`diff-table diff-rows ${tone}`}>
        <thead>
          <tr>
            <th className="col-num">#</th>
            {columns.map(c => <th key={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="col-num">{i + 1}</td>
              {columns.map(c => <td key={c}><Value v={r?.[c]} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Value({ v, tone }) {
  if (v === undefined || v === null || v === "") {
    return <span className="diff-empty-val">{v === "" ? "(empty)" : "(none)"}</span>;
  }
  const text = typeof v === "object" ? JSON.stringify(v) : String(v);
  return <span className={`diff-val ${tone || ""}`} title={text}>{text}</span>;
}

function Stat({ tone, value, label }) {
  const n = value ?? 0;
  return (
    <div className={`diff-stat ${tone} ${n === 0 ? "zero" : ""}`}>
      <span className="n">{tone === "add" ? "+" : tone === "del" ? "−" : tone === "chg" ? "~" : ""}{n}</span>
      <span className="l">{label}</span>
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

// Free-text filter across whatever the bucket holds — for changed rows that
// includes the key, the field names, and both the old and the new values, so
// searching "19.99" finds the row whose price used to be 19.99.
function filterRows(rows, bucket, filter) {
  const q = filter.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(r => {
    if (bucket === "changed") {
      return [r.key, ...(r.fields || []), ...Object.values(r.before || {}), ...Object.values(r.after || {})]
        .some(v => stringify(v).includes(q));
    }
    return Object.values(r || {}).some(v => stringify(v).includes(q));
  });
}

function stringify(v) {
  if (v == null) return "";
  return (typeof v === "object" ? JSON.stringify(v) : String(v)).toLowerCase();
}

function pct(n, max) {
  if (!max) return 0;
  return Math.max(6, Math.round((n / max) * 100));
}

function formatDate(s) {
  if (!s) return "";
  const d = new Date(/T/.test(s) ? s : (String(s).replace(" ", "T") + "Z"));
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

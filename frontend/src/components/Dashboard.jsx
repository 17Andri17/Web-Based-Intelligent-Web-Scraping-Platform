import React, { useEffect, useState, useMemo, useCallback } from "react";
import { workflowsApi, runsApi, schedulesApi } from "../api/client";
import "../styles/Dashboard.css";

/* =====================================================================
   Dashboard — the landing screen after login.

   Shows every saved workflow as a card with its latest run status, when
   it last ran, and when it will next run (if scheduled). A "Needs
   attention" strip surfaces workflows whose most recent run failed or
   needs review, so problems are visible without opening each workflow's
   history.

   Props:
     open
     userName
     onNewScrape()            start the guided Quick Scrape wizard
     onNewBlank()             start an empty workflow in the editor
     onOpenWorkflow(id)       load a workflow into the editor
     onManageWorkflows()      open the full Workflows menu (rename/delete/…)
     showToast(msg, type)
     reloadKey                bump to force a data refresh
   ===================================================================== */

const STATUS_META = {
  success:      { label: "Succeeded",    cls: "ok",     dot: "#3fb950" },
  running:      { label: "Running",      cls: "run",    dot: "#4f9cf9" },
  queued:       { label: "Queued",       cls: "run",    dot: "#4f9cf9" },
  needs_review: { label: "Needs review", cls: "warn",   dot: "#d29922" },
  error:        { label: "Failed",       cls: "err",    dot: "#f85149" },
  cancelled:    { label: "Cancelled",    cls: "muted",  dot: "#8b949e" },
};

export default function Dashboard({
  open, userName, onNewScrape, onNewBlank, onOpenWorkflow, onManageWorkflows, showToast, reloadKey,
}) {
  const [workflows, setWorkflows] = useState([]);
  const [runs, setRuns]           = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading]     = useState(false);
  const [err, setErr]             = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [wf, rn, sc] = await Promise.all([
        workflowsApi.list().catch(() => []),
        runsApi.list().catch(() => []),
        schedulesApi.list().catch(() => []),
      ]);
      setWorkflows(wf || []);
      setRuns(rn || []);
      setSchedules(sc || []);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) refresh(); }, [open, reloadKey, refresh]);

  // Latest run per workflow id (runs come newest-first from the API).
  const latestByWorkflow = useMemo(() => {
    const m = new Map();
    for (const r of runs) {
      if (!m.has(r.workflowId)) m.set(r.workflowId, r);
    }
    return m;
  }, [runs]);

  const scheduleByWorkflow = useMemo(() => {
    const m = new Map();
    for (const s of schedules) m.set(s.workflowId, s);
    return m;
  }, [schedules]);

  const cards = useMemo(() => workflows.map(w => ({
    ...w,
    latest: latestByWorkflow.get(w.id) || null,
    schedule: scheduleByWorkflow.get(w.id) || null,
  })), [workflows, latestByWorkflow, scheduleByWorkflow]);

  const needsAttention = useMemo(
    () => cards.filter(c => c.latest && (c.latest.status === "needs_review" || c.latest.status === "error")),
    [cards]
  );

  if (!open) return null;

  return (
    <div className="dash">
      <div className="dash-inner">
        {/* Hero / primary CTA */}
        <div className="dash-hero">
          <div>
            <h1 className="dash-title">Welcome{userName ? `, ${userName}` : ""}</h1>
            <p className="dash-subtitle">Build a scraper by pointing and clicking — or open one you already made.</p>
          </div>
          <div className="dash-hero-actions">
            <button className="dash-cta primary" onClick={onNewScrape}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              Scrape a page
            </button>
            <button className="dash-cta ghost" onClick={onNewBlank}>
              Start from blank
            </button>
          </div>
        </div>

        {/* Needs attention */}
        {needsAttention.length > 0 && (
          <div className="dash-attention">
            <div className="dash-attention-head">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              Needs attention ({needsAttention.length})
            </div>
            <div className="dash-attention-list">
              {needsAttention.map(c => (
                <button key={c.id} className="dash-attention-item" onClick={() => onOpenWorkflow(c.id)}>
                  <span className="dash-attention-name">{c.name}</span>
                  <span className="dash-attention-msg">
                    {c.latest.aiSummary || (c.latest.status === "error" ? "Last run failed" : "Last run needs review")}
                  </span>
                  <span className="dash-attention-open">Open →</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Workflow grid */}
        <div className="dash-section-head">
          <h2>Your workflows {workflows.length > 0 && <span className="dash-count">{workflows.length}</span>}</h2>
          {workflows.length > 0 && (
            <button className="dash-link" onClick={onManageWorkflows}>Manage all…</button>
          )}
        </div>

        {loading ? (
          <div className="dash-empty">Loading…</div>
        ) : err ? (
          <div className="dash-empty dash-error">{err}</div>
        ) : cards.length === 0 ? (
          <div className="dash-empty-state">
            <div className="dash-empty-illustration">🕸️</div>
            <h3>No workflows yet</h3>
            <p>Enter a page you want data from and let the platform detect the list for you.</p>
            <button className="dash-cta primary" onClick={onNewScrape}>Scrape your first page</button>
          </div>
        ) : (
          <div className="dash-grid">
            {cards.map(c => {
              const st = c.latest ? (STATUS_META[c.latest.status] || STATUS_META.muted) : null;
              return (
                <div key={c.id} className="dash-card" onClick={() => onOpenWorkflow(c.id)} role="button" tabIndex={0}
                  onKeyDown={e => { if (e.key === "Enter") onOpenWorkflow(c.id); }}>
                  <div className="dash-card-top">
                    <span className="dash-card-name" title={c.name}>{c.name}</span>
                    {st && (
                      <span className={`dash-status dash-status--${st.cls}`}>
                        <span className="dash-status-dot" style={{ background: st.dot }} />
                        {st.label}
                      </span>
                    )}
                  </div>
                  <div className="dash-card-meta">
                    {c.latest
                      ? <span>Last run {relTime(c.latest.finishedAt || c.latest.startedAt)}</span>
                      : <span className="dash-muted">Never run yet</span>}
                    {c.schedule && c.schedule.isActive && c.schedule.nextRunAt && (
                      <span className="dash-next">· Next {relTime(c.schedule.nextRunAt)}</span>
                    )}
                  </div>
                  <div className="dash-card-actions" onClick={e => e.stopPropagation()}>
                    <button className="dash-card-btn" onClick={() => onOpenWorkflow(c.id)}>Open</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// Compact relative time ("3m ago", "2h ago", "just now", or a date).
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

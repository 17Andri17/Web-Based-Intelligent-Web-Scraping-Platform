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
     onNewScrape()            start a new scraper in the editor
     onOpenWorkflow(id)       load a workflow into the editor
     onManageWorkflows()      open the full Workflows menu (rename/delete/…)
     showToast(msg, type)
     reloadKey                bump to force a data refresh

     onStartTour()            run the guided walkthrough from the beginning
     onResumeTour()           continue a tour that was left part-way (or null)
     tourProgress             { idx, total } of a part-finished tour, or null
     tourCompleted            the user has finished the tour before
     tourPromptDismissed      the user waved away the first-run prompt
     onDismissTourPrompt()    remember that dismissal
   ===================================================================== */

const STATUS_META = {
  success:      { label: "Succeeded",    cls: "ok",     dot: "var(--accent-success)" },
  running:      { label: "Running",      cls: "run",    dot: "var(--accent-primary)" },
  queued:       { label: "Queued",       cls: "run",    dot: "var(--accent-primary)" },
  needs_review: { label: "Needs review", cls: "warn",   dot: "var(--accent-warning)" },
  error:        { label: "Failed",       cls: "err",    dot: "var(--accent-danger)" },
  cancelled:    { label: "Cancelled",    cls: "muted",  dot: "var(--text-secondary)" },
  // Stopped early (crash / timeout / cancel) but kept the rows it had already
  // captured. Data is usable; the run just isn't complete.
  partial:      { label: "Partial",      cls: "warn",   dot: "var(--accent-warning)" },
  muted:        { label: "Unknown",      cls: "muted",  dot: "var(--text-secondary)" },
};

export default function Dashboard({
  open, userName, onNewScrape, onOpenWorkflow, onManageWorkflows, showToast, reloadKey,
  openWorkflow = null, onResumeEditing, onWatchRun, onBrowseTemplates, onOpenData,
  onStartTour, onResumeTour, tourProgress = null, tourCompleted = false,
  tourPromptDismissed = false, onDismissTourPrompt,
}) {
  const [workflows, setWorkflows] = useState([]);
  const [runs, setRuns]           = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [activeRuns, setActiveRuns] = useState([]);
  const [loading, setLoading]     = useState(false);
  const [err, setErr]             = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [wf, rn, sc, act] = await Promise.all([
        workflowsApi.list().catch(() => []),
        runsApi.list().catch(() => []),
        schedulesApi.list().catch(() => []),
        runsApi.active().catch(() => []),
      ]);
      setWorkflows(wf || []);
      setRuns(rn || []);
      setSchedules(sc || []);
      setActiveRuns(act || []);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) refresh(); }, [open, reloadKey, refresh]);

  // Keep the running/queued badges honest while the dashboard is on screen —
  // a scheduled run can start, and a running one finish, with this tab idle.
  // Only the cheap /active call is polled; the full refresh is not.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(async () => {
      try { setActiveRuns((await runsApi.active()) || []); } catch (_) { /* offline */ }
    }, 4000);
    return () => clearInterval(t);
  }, [open]);

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

  // A tour left part-way through can be picked up where it stopped. Step 0
  // isn't "in progress" — that's just an unstarted tour.
  const canResumeTour = !!(onResumeTour && tourProgress && tourProgress.idx > 0);
  const tourStepLabel = canResumeTour && tourProgress.total
    ? `step ${Math.min(tourProgress.idx + 1, tourProgress.total)} of ${tourProgress.total}`
    : null;
  // The first-run nudge: only for someone with nothing built who hasn't
  // already done the tour or waved the prompt away. Waits for the workflow
  // list to actually load, so it can't flash before the data arrives.
  const showTourPrompt =
    !!onStartTour && !loading && !err && workflows.length === 0 &&
    !tourCompleted && !tourPromptDismissed;

  if (!open) return null;

  return (
    <div className="dash">
      <div className="dash-inner">
        {/* Currently-open scraper — quick way back into the editor */}
        {openWorkflow && onResumeEditing && (
          <button className="dash-resume" onClick={onResumeEditing}>
            <span className="dash-resume-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
              </svg>
            </span>
            <span className="dash-resume-body">
              <span className="dash-resume-label">
                {openWorkflow.restored ? "Recovered from your last session" : "Currently editing"}
              </span>
              <span className="dash-resume-name">
                {openWorkflow.name}
                {!openWorkflow.saved && <span className="dash-resume-tag">unsaved</span>}
                {openWorkflow.isTour && <span className="dash-resume-tag">practice</span>}
              </span>
              <span className="dash-resume-meta">
                {openWorkflow.stepCount} step{openWorkflow.stepCount === 1 ? "" : "s"}
                {openWorkflow.url ? ` · ${prettyUrl(openWorkflow.url)}` : ""}
              </span>
            </span>
            <span className="dash-resume-cta">
              Back to editor
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <polyline points="9,18 15,12 9,6"/>
              </svg>
            </span>
          </button>
        )}

        {/* Hero / primary CTA */}
        <div className="dash-hero">
          <div>
            <h1 className="dash-title">Welcome{userName ? `, ${userName}` : ""}</h1>
            <p className="dash-subtitle">Build a scraper by pointing and clicking — or open one you already made.</p>
          </div>
          {/* One way to start building. (These used to be two buttons —
              "Scrape a page" and "Start from blank" — that ran identical
              code, so the choice was a decision with no consequence.) */}
          <div className="dash-hero-actions">
            <button className="dash-cta primary" onClick={onNewScrape}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              New scraper
            </button>
            {onBrowseTemplates && (
              <button className="dash-cta ghost" onClick={onBrowseTemplates}
                title="Ready-made scrapers with the tricky parts already wired up">
                📋 Start from a template
              </button>
            )}
            {/* The tour stays reachable forever, not just on an empty
                account — people come back for it long after their first day. */}
            {canResumeTour ? (
              <button className="dash-cta ghost" onClick={onResumeTour}
                title={`Pick the walkthrough back up at ${tourStepLabel || "where you left it"}`}>
                🧭 Resume the tour{tourStepLabel ? ` · ${tourStepLabel}` : ""}
              </button>
            ) : onStartTour && (
              <button className="dash-cta ghost" onClick={onStartTour}
                title="A short guided walkthrough on a practice shop">
                🧭 {tourCompleted ? "Replay the tour" : "Take the tour"}
              </button>
            )}
          </div>
        </div>

        {/* First-run: ask outright, rather than hoping the ghost button in
            the hero gets noticed by someone who has never seen the app. */}
        {showTourPrompt && (
          <div className="dash-tour-prompt">
            <span className="dash-tour-prompt-icon" aria-hidden="true">🧭</span>
            <div className="dash-tour-prompt-body">
              <strong>New here? Let's build one together.</strong>
              <span>
                A short guided walkthrough on a practice shop — you'll build and run a
                real scraper in a few minutes. Nothing you do in it is saved to your account.
              </span>
            </div>
            <div className="dash-tour-prompt-actions">
              <button className="dash-cta primary" onClick={onStartTour}>Show me how</button>
              <button className="dash-link" onClick={onDismissTourPrompt}>No thanks</button>
            </div>
          </div>
        )}

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
            <div className="dash-section-links">
              {/* The data a scraper collects is the reason it exists — it gets
                  a first-class way in, not a 16px icon three modals deep. */}
              {onOpenData && <button className="dash-link" onClick={onOpenData}>View all data</button>}
              <button className="dash-link" onClick={onManageWorkflows}>Manage all…</button>
            </div>
          )}
        </div>

        {loading ? (
          <div className="dash-empty">Loading…</div>
        ) : err ? (
          <div className="dash-empty dash-error">{err}</div>
        ) : cards.length === 0 ? (
          <div className="dash-empty-state">
            <div className="dash-empty-illustration">🕸️</div>
            <h3>No scrapers yet</h3>
            <p>Enter a page you want data from and let the platform detect the list for you.</p>
            <div className="dash-empty-actions">
              <button className="dash-cta primary" onClick={onNewScrape}>Scrape your first page</button>
              {onBrowseTemplates && (
                <button className="dash-cta ghost" onClick={onBrowseTemplates}>Start from a template</button>
              )}
            </div>
            {/* Only when the prompt above isn't already asking — otherwise
                the same offer would appear twice on one screen. */}
            {!showTourPrompt && onStartTour && (
              <button className="dash-link" onClick={canResumeTour ? onResumeTour : onStartTour}>
                {canResumeTour ? "…or pick the tour back up" : "…or walk through it with a guided tour"}
              </button>
            )}
          </div>
        ) : (
          <div className="dash-grid">
            {cards.map(c => {
              const st = c.latest ? (STATUS_META[c.latest.status] || STATUS_META.muted) : null;
              // A run of this workflow that is still going. Clicking the card
              // then means "show me what it's doing", not "open the editor" —
              // opening the editor while a run is in flight is almost never
              // what the user wanted, and it used to also fire a page load.
              const live = activeRuns.find(r => r.workflowId === c.id);
              const openCard = () => (live ? onWatchRun(live.id) : onOpenWorkflow(c.id));
              return (
                <div key={c.id} className="dash-card" onClick={openCard} role="button" tabIndex={0}
                  onKeyDown={e => { if (e.key === "Enter") openCard(); }}>
                  <div className="dash-card-top">
                    <span className="dash-card-name" title={c.name}>{c.name}</span>
                    {live ? (
                      <span className="dash-status dash-status--run">
                        <span className="dash-status-dot dash-status-dot--pulse" style={{ background: "var(--accent-primary)" }} />
                        {live.status === "queued" ? "Queued" : "Running"}
                      </span>
                    ) : st && (
                      <span className={`dash-status dash-status--${st.cls}`}>
                        <span className="dash-status-dot" style={{ background: st.dot }} />
                        {st.label}
                      </span>
                    )}
                  </div>
                  <div className="dash-card-meta">
                    {live
                      ? <span>Started {relTime(live.startedAt || live.queuedAt)}
                          {live.rowsCaptured > 0 ? ` · ${live.rowsCaptured.toLocaleString()} rows so far` : ""}</span>
                      : c.latest
                        ? <span>Last run {relTime(c.latest.finishedAt || c.latest.startedAt)}</span>
                        : <span className="dash-muted">Never run yet</span>}
                    {!live && c.schedule && c.schedule.isActive && c.schedule.nextRunAt && (
                      <span className="dash-next">· Next {relTime(c.schedule.nextRunAt)}</span>
                    )}
                  </div>
                  <ChangeLine summary={c.latest?.changeSummary} />
                  <div className="dash-card-actions" onClick={e => e.stopPropagation()}>
                    {live && (
                      <button className="dash-card-btn dash-card-btn--primary" onClick={() => onWatchRun(live.id)}>
                        View progress
                      </button>
                    )}
                    <button className="dash-card-btn" onClick={() => onOpenWorkflow(c.id)}>
                      {live ? "Edit" : "Open"}
                    </button>
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

// One-line change indicator on a workflow card — only when the latest run
// recorded a real change (baseline and no-change runs stay quiet so the card
// isn't noisy).
function ChangeLine({ summary }) {
  if (!summary || summary.baseline) return null;
  const c = summary.counts || {};
  const parts = [];
  if (c.added   > 0) parts.push(`+${c.added} new`);
  if (c.changed > 0) parts.push(`~${c.changed} changed`);
  if (c.removed > 0) parts.push(`−${c.removed} removed`);
  if (parts.length === 0) return null;
  return <div className="dash-card-change">{parts.join(" · ")}</div>;
}

// Host + short path for the resume banner ("example.com/products").
function prettyUrl(u) {
  if (!u) return "";
  try {
    const x = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    const p = x.pathname.replace(/\/$/, "");
    return (x.hostname.replace(/^www\./, "") + p).slice(0, 48);
  } catch { return String(u).slice(0, 48); }
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

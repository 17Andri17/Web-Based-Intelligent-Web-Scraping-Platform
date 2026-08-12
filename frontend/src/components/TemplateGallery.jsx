import React, { useEffect, useState, useMemo } from "react";
import { workflowsApi } from "../api/client";
import "../styles/TemplateGallery.css";
import useDialog from "./useDialog";

/* =====================================================================
   TemplateGallery — ready-made starting points.

   The templates are deliberately site-agnostic: what a beginner can't
   assemble alone is the STRUCTURE (a pagination container wrapped around
   an extraction, a list paired with a per-row detail pass), not the
   selectors — those only exist on their own page. So each card sells the
   shape and carries a short checklist of what to point at afterwards.

   Picking one runs the normal workflow-import path server-side and hands
   the new workflow back to the caller to open in the editor.

   Props:
     open
     onClose()
     onUsed(workflow, template)   the new workflow + the template it came from
     showToast(msg, type)
   ===================================================================== */

export default function TemplateGallery({ open, onClose, onUsed, showToast }) {
  // Focus trap, Escape, focus restore, scroll lock, backdrop semantics.
  const { overlayProps, dialogProps } = useDialog({ open, onClose });
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading]     = useState(false);
  const [err, setErr]             = useState(null);
  const [busyId, setBusyId]       = useState(null);
  const [expanded, setExpanded]   = useState(null);   // template id showing its checklist

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true); setErr(null);
    workflowsApi.templates()
      .then(list => { if (alive) setTemplates(Array.isArray(list) ? list : []); })
      .catch(e => { if (alive) setErr(e?.response?.data?.error || e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open]);

  // Group by category so the list reads as a small menu rather than a wall.
  const groups = useMemo(() => {
    const m = new Map();
    for (const t of templates) {
      const k = t.category || "Other";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    }
    return [...m.entries()];
  }, [templates]);

  const use = async (t) => {
    setBusyId(t.id);
    try {
      const out = await workflowsApi.useTemplate(t.id);
      onUsed?.(out.workflow, t);
    } catch (e) {
      showToast?.(`✗ Couldn't start from that template: ${e?.response?.data?.error || e.message}`, "error");
    } finally {
      setBusyId(null);
    }
  };

  if (!open) return null;

  return (
    <div className="wf-overlay" {...overlayProps}>
      <div className="wf-modal tg-modal" {...dialogProps}>
        <div className="wf-header">
          <h2>Start from a template</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="wf-body">
          <p className="tg-intro">
            Each one is a working shape with the tricky parts already wired up —
            the looping, the paging, the per-row detail pass. You point it at
            your own page and pick what to collect.
          </p>

          {loading ? (
            <div className="wf-empty">Loading templates…</div>
          ) : err ? (
            <div className="wf-empty dash-error">{err}</div>
          ) : templates.length === 0 ? (
            <div className="wf-empty">No templates available.</div>
          ) : (
            groups.map(([category, items]) => (
              <div key={category} className="tg-group">
                <div className="tg-group-title">{category}</div>
                <div className="tg-grid">
                  {items.map(t => {
                    const isOpen = expanded === t.id;
                    return (
                      <div key={t.id} className={`tg-card ${isOpen ? "tg-card--open" : ""}`}>
                        <div className="tg-card-head">
                          <span className="tg-icon" aria-hidden="true">{t.icon}</span>
                          <span className="tg-name">{t.name}</span>
                          <span className="tg-steps">{t.stepCount} step{t.stepCount === 1 ? "" : "s"}</span>
                        </div>
                        <p className="tg-summary">{t.summary}</p>

                        {isOpen && Array.isArray(t.setup) && t.setup.length > 0 && (
                          <ol className="tg-setup">
                            {t.setup.map((s, i) => <li key={i}>{s}</li>)}
                          </ol>
                        )}

                        <div className="tg-card-actions">
                          <button
                            className="wf-save-btn"
                            onClick={() => use(t)}
                            disabled={busyId != null}
                          >
                            {busyId === t.id ? "Creating…" : "Use this"}
                          </button>
                          <button
                            className="dash-link"
                            onClick={() => setExpanded(isOpen ? null : t.id)}
                            aria-expanded={isOpen}
                          >
                            {isOpen ? "Hide steps" : "What do I fill in?"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* A template-derived workflow arrives with empty selectors on purpose, so the
   editor would otherwise look broken. This keeps the template's checklist in
   view until the user dismisses it. */
export function TemplateSetupBanner({ guide, onDismiss }) {
  if (!guide || !Array.isArray(guide.setup) || guide.setup.length === 0) return null;
  return (
    <div className="tg-banner">
      <div className="tg-banner-head">
        <strong>Started from “{guide.name}” — three things to point at your page:</strong>
        <button className="tg-banner-close" onClick={onDismiss} aria-label="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <ol className="tg-banner-list">
        {guide.setup.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
    </div>
  );
}

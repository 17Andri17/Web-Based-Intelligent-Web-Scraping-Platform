import React from "react";
import "../styles/GuidedCoach.css";

/* =====================================================================
   GuidedCoach — the first-scrape guide.

   Unlike a wizard, this does NOT re-implement anything. It coaches the
   user through the REAL controls (URL bar → Select toggle → canvas click
   → Inspector → Run → Data), auto-advancing as it observes the live
   editor state. It teaches the actual UI, so the second scrape needs no
   guide — and it docks over the canvas, never on top of the sidebar.

   The parent (main.jsx) computes the current step from live state with
   `coachStepIndex()` and highlights the matching control by adding the
   `coach-spotlight` class. This component is otherwise presentational,
   plus optional "do it for me" actions that drive real handlers.

   Props:
     open, onClose
     stepIndex                 0..STEPS.length (== length means "done")
     onFocusUrl()              focus the real URL input
     onSelectMode()            switch the toolbar to Select mode
     onOpenInspector()         reveal the Inspector sidebar tab
     onRun()                   run the workflow
     onOpenData()              open the Data tab
   ===================================================================== */

export const COACH_STEPS = [
  {
    key: "url",
    title: "Enter a page to scrape",
    hint: "Type or paste a web address in the bar at the top and press Go.",
    target: "url",
    action: { label: "Focus the address bar", handler: "onFocusUrl" },
  },
  {
    key: "select",
    title: "Turn on Select mode",
    hint: 'Switch the toolbar from Navigate to "Select" so clicking picks elements instead of following links.',
    target: "mode",
    action: { label: "Switch to Select", handler: "onSelectMode" },
  },
  {
    key: "pick",
    title: "Click one item in the list",
    hint: "Click a single item — one product, row, or card. We'll highlight all the similar ones automatically.",
    target: "canvas",
  },
  {
    key: "columns",
    title: "Add and name your columns",
    hint: "In the Inspector on the right, add the list and pick the columns you want (title, price, link…).",
    target: "sidebar",
    action: { label: "Open the Inspector", handler: "onOpenInspector" },
  },
  {
    key: "run",
    title: "Run your scraper",
    hint: "Press Run to execute the workflow and collect the data from the page.",
    target: "run",
    action: { label: "Run now", handler: "onRun" },
  },
];

// Which step the user is on, derived purely from live editor state. Returns
// COACH_STEPS.length when every step is satisfied (the "done" state).
export function coachStepIndex({ pageLoaded, mode, hasSelection, hasList, hasRun }) {
  if (!pageLoaded) return 0;
  if (mode !== "selection") return 1;
  if (!hasSelection) return 2;
  if (!hasList) return 3;
  if (!hasRun) return 4;
  return COACH_STEPS.length; // done
}

export default function GuidedCoach({
  open, onClose, stepIndex,
  onFocusUrl, onSelectMode, onOpenInspector, onRun, onOpenData,
}) {
  if (!open) return null;

  const handlers = { onFocusUrl, onSelectMode, onOpenInspector, onRun, onOpenData };
  const done = stepIndex >= COACH_STEPS.length;
  const step = done ? null : COACH_STEPS[stepIndex];

  return (
    <div className="gc" role="dialog" aria-label="Getting started guide">
      <div className="gc-head">
        <div className="gc-title">
          <span className="gc-badge">
            {done ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20,6 9,17 4,12"/></svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"/><circle cx="12" cy="12" r="3"/></svg>
            )}
          </span>
          {done ? "You've got it!" : "Getting started"}
        </div>
        <button className="gc-close" onClick={onClose} aria-label="Close guide">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* Progress dots */}
      <div className="gc-progress">
        {COACH_STEPS.map((s, i) => (
          <span key={s.key} className={`gc-dot ${i < stepIndex ? "done" : ""} ${i === stepIndex ? "active" : ""}`} />
        ))}
      </div>

      {done ? (
        <div className="gc-body">
          <p className="gc-hint">
            That's the whole loop — enter a page, select a list, name columns, run, and read the data.
            You can save it, schedule it, or turn on change monitoring from the Workflows menu.
          </p>
          <div className="gc-actions">
            <button className="gc-btn ghost" onClick={onClose}>Close</button>
            <button className="gc-btn primary" onClick={() => { onOpenData?.(); onClose?.(); }}>See my data</button>
          </div>
        </div>
      ) : (
        <div className="gc-body">
          <div className="gc-step-line">Step {stepIndex + 1} of {COACH_STEPS.length}</div>
          <div className="gc-step-title">{step.title}</div>
          <p className="gc-hint">{step.hint}</p>
          <div className="gc-actions">
            <button className="gc-btn ghost" onClick={onClose}>Skip guide</button>
            {step.action && (
              <button className="gc-btn primary" onClick={() => handlers[step.action.handler]?.()}>
                {step.action.label}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

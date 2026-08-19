import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import Modal from "./Modal";
import "../styles/ConfirmDialog.css";

/* =====================================================================
   ConfirmDialog — the app's own confirmation, replacing window.confirm.

   Nineteen native confirm()/alert() calls sat behind actions like deleting a
   workflow or rolling back a run. They're OS chrome dropped into a carefully
   styled app, they can't be themed, they can't say which button is the
   dangerous one, and on some browsers a user can suppress them entirely —
   which silently turns "are you sure?" into "yes".

   Exposed as a promise so call sites read almost exactly as they did:

       if (!(await confirm({ ... }))) return;

   That keeps the guard where the decision is made instead of shattering each
   one into open/onConfirm/onCancel state.

   ── More than two answers ────────────────────────────────────────────────
   Pass `choices` and the same call becomes a small menu that resolves to the
   chosen `value` instead of a boolean:

       const pick = await confirm({
         title: "…",
         choices: [
           { value: "all",  label: "…", detail: "…", primary: true },
           { value: "none", label: "…" },
         ],
       });

   Some decisions genuinely have three answers, and the alternative — asking
   two yes/no questions in a row, or picking one for the user and hoping — is
   worse than asking once. Dismissing (Escape, backdrop, Cancel) still
   resolves `false`, so callers can tell "changed their mind" from any real
   choice, and the boolean form is completely unchanged.
   ===================================================================== */

const ConfirmContext = createContext(null);

/** `confirm(options) => Promise<boolean>` from anywhere under the provider. */
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    // A missing provider must not silently approve destructive actions.
    throw new Error("useConfirm() requires <ConfirmProvider> above it");
  }
  return ctx;
}

export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null);
  const resolveRef = useRef(null);
  const confirmBtnRef = useRef(null);

  const confirm = useCallback((options) => {
    // A bare string is the common case; accept it as the message.
    const opts = typeof options === "string" ? { message: options } : (options || {});
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setRequest({
        title: opts.title || "Are you sure?",
        message: opts.message || "",
        detail: opts.detail || null,
        confirmLabel: opts.confirmLabel || "Confirm",
        cancelLabel: opts.cancelLabel || "Cancel",
        danger: !!opts.danger,
        choices: Array.isArray(opts.choices) && opts.choices.length ? opts.choices : null,
      });
    });
  }, []);

  const settle = useCallback((value) => {
    setRequest(null);
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(value);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={!!request}
        // Escape and the backdrop mean "no" — the safe answer, and the same
        // thing the native dialog did.
        onClose={() => settle(false)}
        title={request?.title}
        modalClassName="cfm-modal"
        // Focus starts on Confirm so Enter completes the action, but the
        // dangerous variant starts on Cancel instead: a reflexive Enter should
        // never be what deletes something.
        initialFocusRef={request?.danger ? undefined : confirmBtnRef}
      >
        {request?.message && <p className="cfm-message">{request.message}</p>}
        {request?.detail && <p className="cfm-detail">{request.detail}</p>}

        {request?.choices ? (
          /* Each answer is its own button with its own consequence spelled
             out, rather than a radio list plus an OK the user has to find.
             One click, one outcome. */
          <div className="cfm-choices">
            {request.choices.map((c, i) => (
              <button
                key={c.value ?? i}
                ref={c.primary ? confirmBtnRef : undefined}
                className={`cfm-choice ${c.primary ? "cfm-choice--primary" : ""}`}
                onClick={() => settle(c.value)}
              >
                <span className="cfm-choice-label">{c.label}</span>
                {c.detail && <span className="cfm-choice-detail">{c.detail}</span>}
              </button>
            ))}
          </div>
        ) : (
          <div className="cfm-actions">
            <button className="wf-ghost-btn" onClick={() => settle(false)}>
              {request?.cancelLabel}
            </button>
            <button
              ref={confirmBtnRef}
              className={`wf-save-btn ${request?.danger ? "cfm-danger" : ""}`}
              onClick={() => settle(true)}
            >
              {request?.confirmLabel}
            </button>
          </div>
        )}
      </Modal>
    </ConfirmContext.Provider>
  );
}

import { useEffect, useId, useRef } from "react";

/* =====================================================================
   useDialog — the behaviour every modal in this app was missing.

   Modal.jsx is the primitive for new dialogs, but the app already had two
   dozen hand-rolled ones across four overlay conventions, several with
   bespoke chrome (the execution bottom-sheet, the API sources panel, the
   pagination detector). Rewriting all of their markup would be a large,
   silent-breakage-prone diff for no user-visible gain — what users actually
   need is the BEHAVIOUR, and that can be adopted in two lines without
   touching a single element.

   So this hook owns the behaviour and Modal simply consumes it. Adopting it
   elsewhere:

       const { overlayProps, dialogProps } = useDialog({ open, onClose });
       ...
       <div className="xx-overlay" {...overlayProps}>
         <div className="xx-panel" {...dialogProps}>

   What that buys, for every dialog:
     • Escape closes it — the topmost one only, so nested dialogs peel off
       one at a time instead of all collapsing at once.
     • Focus moves in, is trapped while open, and returns to whatever opened
       it. Without this a keyboard user can enter a dialog and never leave.
     • role="dialog" + aria-modal so it is announced as a dialog.
     • Backdrop click closes it — but only a click that both starts AND ends
       on the backdrop, so finishing a text selection on the overlay doesn't
       dismiss the thing you were reading.
     • The page behind stops scrolling.
   ===================================================================== */

/* Open dialogs, oldest first. Escape and the scroll lock are global
   concerns, so they're coordinated here rather than by each dialog guessing
   whether it happens to be on top. */
const stack = [];

function lockScroll() {
  if (stack.length !== 1) return;              // something below already locked it
  document.body.dataset.prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
}
function unlockScroll() {
  if (stack.length !== 0) return;              // a dialog is still open beneath
  document.body.style.overflow = document.body.dataset.prevOverflow || "";
  delete document.body.dataset.prevOverflow;
}

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

// `offsetParent` is null throughout a position:fixed subtree — which is where
// every dialog lives — so visibility is measured by whether it renders a box.
const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

export function focusableIn(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter(el => isVisible(el) && !el.hasAttribute("inert"));
}

export default function useDialog({
  open,
  onClose,
  closeOnBackdrop = true,
  closeOnEscape = true,
  initialFocusRef,
  labelledBy,
} = {}) {
  const dialogRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const tokenRef = useRef(null);
  // Where the current mouse gesture began. A drag that starts inside the
  // dialog and ends on the backdrop is a text selection, not a dismissal.
  const pressOnBackdropRef = useRef(false);
  const fallbackId = useId();

  useEffect(() => {
    if (!open) return;
    const token = {};
    tokenRef.current = token;
    stack.push(token);
    lockScroll();
    return () => {
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
      tokenRef.current = null;
      unlockScroll();
    };
  }, [open]);

  // Move focus in on open; put it back on close.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement;
    const raf = requestAnimationFrame(() => {
      const target = initialFocusRef?.current || focusableIn(dialogRef.current)[0] || dialogRef.current;
      try { target?.focus({ preventScroll: true }); } catch (_) {}
    });
    return () => {
      cancelAnimationFrame(raf);
      const el = restoreFocusRef.current;
      // Only if it's still in the document — a dialog that deleted the row
      // which opened it shouldn't throw focus into a detached node.
      if (el && el.isConnected && typeof el.focus === "function") {
        try { el.focus({ preventScroll: true }); } catch (_) {}
      }
    };
  }, [open, initialFocusRef]);

  // Escape + Tab containment, topmost dialog only.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (stack.length === 0 || stack[stack.length - 1] !== tokenRef.current) return;
      if (e.key === "Escape") {
        if (!closeOnEscape) return;
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusableIn(dialogRef.current);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      const inside = dialogRef.current && dialogRef.current.contains(active);
      if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose, closeOnEscape]);

  const overlayProps = {
    onMouseDown: (e) => { pressOnBackdropRef.current = e.target === e.currentTarget; },
    onClick: (e) => {
      if (!closeOnBackdrop) return;
      // Both ends of the gesture must be the backdrop itself.
      if (e.target === e.currentTarget && pressOnBackdropRef.current) onClose?.();
      pressOnBackdropRef.current = false;
    },
  };

  const dialogProps = {
    ref: dialogRef,
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": labelledBy || undefined,
    tabIndex: -1,
    // The dialog is inside the overlay, so a click here would otherwise reach
    // the backdrop handler. Callers no longer need their own stopPropagation.
    onMouseDown: (e) => { e.stopPropagation(); pressOnBackdropRef.current = false; },
    onClick: (e) => { e.stopPropagation(); },
  };

  return { dialogRef, overlayProps, dialogProps, titleId: labelledBy || fallbackId };
}

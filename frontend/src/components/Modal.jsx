import React, { useId } from "react";
import { createPortal } from "react-dom";
import useDialog from "./useDialog";

/* =====================================================================
   Modal — the standard dialog shell.

   Renders the shared .wf-overlay / .wf-modal chrome and gets all of its
   behaviour (focus trap, Escape, focus restore, scroll lock, backdrop
   semantics, aria) from useDialog, which existing hand-rolled dialogs adopt
   directly without changing their markup. One implementation, two ways in.

   Portalled to <body> so a dialog can never be clipped by an ancestor's
   overflow or transform, and so stacking is decided here rather than by
   where the component happens to sit in the tree.
   ===================================================================== */

export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = "md",                 // md | lg | xl
  overlayClassName = "wf-overlay",
  modalClassName = "",
  bodyClassName = "wf-body",
  unstyledBody = false,        // children replace the whole modal interior
  closeOnBackdrop = true,
  closeOnEscape = true,
  showClose = true,
  initialFocusRef,
  footer,
  children,
  labelledBy,
}) {
  const generatedId = useId();
  const titleId = labelledBy || (title ? generatedId : undefined);

  const { overlayProps, dialogProps } = useDialog({
    open, onClose, closeOnBackdrop, closeOnEscape, initialFocusRef, labelledBy: titleId,
  });

  if (!open) return null;

  const sizeClass = size === "lg" ? "wf-modal-lg" : size === "xl" ? "wf-modal-xl" : "";

  return createPortal(
    <div className={overlayClassName} {...overlayProps}>
      <div className={`wf-modal ${sizeClass} ${modalClassName}`.trim()} {...dialogProps}>
        {title && (
          <div className="wf-header">
            {subtitle ? (
              <div className="wf-header-titles">
                <h2 id={titleId}>{title}</h2>
                <span className="wf-header-sub">{subtitle}</span>
              </div>
            ) : (
              <h2 id={titleId}>{title}</h2>
            )}
            {showClose && (
              <button className="wf-close" onClick={onClose} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        )}

        {unstyledBody ? children : <div className={bodyClassName}>{children}</div>}

        {footer && <div className="wf-footer">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

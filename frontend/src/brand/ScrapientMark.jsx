import React from "react";

/* ===========================================================================
   The Scrapient mark.

   A bracket enclosing three descending rules with a check-in-a-circle at the
   corner: structured content being read, and confirmed. The bracket is the
   page, the rules are extracted fields, and the check is the thing that makes
   this product different — a fix that was verified rather than guessed.

   Drawn with currentColor so it inherits wherever it sits (sidebar, auth
   card, landing hero) instead of needing a variant per surface. `bg` fills
   the notch behind the badge so the rules don't show through it; it defaults
   to the app's primary background and is overridden on coloured surfaces.
   ========================================================================= */
export default function ScrapientMark({ size = 32, bg = "var(--bg-primary)", title, className = "" }) {
  return (
    <svg
      className={`brand-mark ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title || undefined}
    >
      {title ? <title>{title}</title> : null}
      {/* The page */}
      <rect
        x="2.6" y="2.6" width="26.8" height="26.8" rx="5.5"
        stroke="currentColor" strokeWidth="2.2"
      />
      {/* Extracted fields, descending — the shape of a scraped record */}
      <path
        d="M8.4 11.2h15.2M8.4 16h9.6M8.4 20.8h6"
        stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
      />
      {/* Verified badge, knocked out of the rules behind it */}
      <circle cx="23" cy="21.4" r="6.2" fill={bg} />
      <circle cx="23" cy="21.4" r="4.6" stroke="currentColor" strokeWidth="2.2" />
      <path
        d="M20.9 21.4l1.5 1.5 2.8-2.9"
        stroke="currentColor" strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

import { useState } from "react";
import { createControl } from "../workflow/stepFactory";
import { CONTROL_TYPES } from "../workflow/controlDefinitions";
import useDialog from "./useDialog";

// ─── Type metadata ────────────────────────────────────────────────────────────

const TYPE_INFO = {
  next_button: {
    icon: "→",
    label: "Next Button",
    color: "var(--accent-primary)",
    bg: "rgba(88,166,255,0.1)",
    border: "rgba(88,166,255,0.25)",
    description: "Collects data page by page, clicking Next until no more pages exist.",
    loopLabel: "While has next page",
  },
  page_numbers: {
    icon: "#",
    label: "Page Numbers",
    color: "var(--accent-purple)",
    bg: "rgba(163,113,247,0.1)",
    border: "rgba(163,113,247,0.25)",
    description: "Navigates through numbered pages by clicking the Next link in pagination.",
    loopLabel: "While next page exists",
  },
  load_more: {
    icon: "+",
    label: "Load More Button",
    color: "var(--accent-success)",
    bg: "rgba(63,185,80,0.1)",
    border: "rgba(63,185,80,0.25)",
    description: "Clicks 'Load More' repeatedly, collecting all newly revealed items on the same page.",
    loopLabel: "While load-more button exists",
  },
  infinite_scroll: {
    icon: "↕",
    label: "Infinite Scroll",
    color: "var(--accent-warning)",
    bg: "rgba(210,153,34,0.1)",
    border: "rgba(210,153,34,0.25)",
    description: "Scrolls to the bottom repeatedly, collecting content as it loads.",
    loopLabel: "While more content loads",
  },
  url_param: {
    icon: "🔗",
    label: "URL Pages (navigate)",
    color: "var(--accent-teal)",
    bg: "rgba(45,212,191,0.1)",
    border: "rgba(45,212,191,0.28)",
    description: "Each page is its own URL (…?page=2, /page/2). Navigates page-by-page — the most reliable strategy — for a set number of pages.",
    loopLabel: "Repeat for N pages",
  },
};

// ─── Confidence bar ───────────────────────────────────────────────────────────

function ConfidenceBar({ value, color }) {
  const pct = Math.round(value * 100);
  return (
    <div className="pd-confidence">
      <div className="pd-conf-bar">
        <div className="pd-conf-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="pd-conf-label">{pct}%</span>
    </div>
  );
}

// ─── Build a native pagination container for each detected type ───────────────
//
// These map onto the dedicated PAGINATE_* control blocks. All of the looping /
// stop logic lives in the code generator, so the step the user sees is a clean
// container with one "run on each page" body and a handful of simple
// parameters — no While + If/Break + click/wait machinery to untangle.

// `baseUrlRaw` is the url the workflow will actually navigate to, with any
// `{{variable}}` still in it. The detector runs in the browser and can only
// report the CONCRETE url that loaded, so a workflow parameterised on
// `{{targetUrl}}` would otherwise get a pagination pattern hard-wired to
// whatever sample value was previewed.
export function generatePaginationSteps(suggestion, baseUrlRaw) {
  const { type, selector, containerSelector, hasNextButton } = suggestion;

  // URL-based pagination → PAGINATE_URL. Stitch the detected before/after
  // fragments into a {n} pattern and seed the content selector from the
  // results container so the loop knows when it has run out of pages.
  if (type === "url_param") {
    const before   = suggestion.urlBefore || "";
    const after    = suggestion.urlAfter || "";
    // startPage is the CURRENT page's number — the loop scrapes it first
    // (no navigation) and only then advances to nextPage, nextPage+1, …. The
    // detector reports the NEXT page it found, so the current page is one less.
    const startPage = Number.isFinite(suggestion.startPage)
      ? suggestion.startPage
      : (Number.isFinite(suggestion.nextPage) ? Math.max(1, suggestion.nextPage - 1) : 1);
    // Rebuild the template on the workflow's own (possibly variable-bearing)
    // url when the detected one is just its resolved form.
    const { before: b2, after: a2 } = rebaseTemplate(before, after, baseUrlRaw);
    return createControl(CONTROL_TYPES.PAGINATE_URL, {
      urlPattern: `${b2}{n}${a2}`,
      contentSelector: containerSelector || selector || "",
      startPage,
      step: 1,
      delay: 1500,
    });
  }

  // Infinite scroll → PAGINATE_SCROLL (no selector needed).
  if (type === "infinite_scroll") {
    return createControl(CONTROL_TYPES.PAGINATE_SCROLL, {
      scrollDelay: 1500,
      maxNoChange: 3,
    });
  }

  // Everything else (next button, load more, numbered pages with a Next link)
  // → PAGINATE_BUTTON. We use the detected selector as the main one; the user
  // can add fallback selectors in the editor.
  // Numbered pages WITHOUT a Next link fall back to the same container —
  // the detector's `selector` is the best available next-link guess.
  void hasNextButton;
  return createControl(CONTROL_TYPES.PAGINATE_BUTTON, {
    selector: selector || "",
    delay: 2000,
  });
}

// Swap the concrete origin+path of a detected pagination template for the raw
// url the workflow uses, so `{{var}}` survives. Only the part BEFORE the page
// number is rebased — the query/suffix after it is pagination structure, not
// something the variable should cover.
function rebaseTemplate(before, after, baseUrlRaw) {
  if (!baseUrlRaw || !baseUrlRaw.includes("{{")) return { before, after };
  // The raw url minus any query string is the stable prefix to graft on.
  const rawPrefix = baseUrlRaw.split("?")[0].replace(/\/$/, "");
  // Everything in `before` after the concrete path is pagination syntax
  // (e.g. "?page="), which we keep verbatim.
  const q = before.indexOf("?");
  if (q === -1) return { before, after };
  return { before: rawPrefix + before.slice(q), after };
}

// ─── Suggestion card ──────────────────────────────────────────────────────────

function SuggestionCard({ suggestion, onAdd, baseUrlRaw }) {
  const [added, setAdded] = useState(false);
  const info = TYPE_INFO[suggestion.type] || {};

  const handleAdd = () => {
    const step = generatePaginationSteps(suggestion, baseUrlRaw);
    if (step) {
      onAdd(step, suggestion.type);
      setAdded(true);
    }
  };

  return (
    <div className="pd-card" style={{ "--card-color": info.color, "--card-bg": info.bg, "--card-border": info.border }}>
      <div className="pd-card-header">
        <span className="pd-type-icon">{info.icon}</span>
        <div className="pd-card-title">
          <span className="pd-type-label">{info.label}</span>
          <ConfidenceBar value={suggestion.confidence} color={info.color} />
        </div>
        <button
          data-tour="pagination-add"
          className={`pd-add-btn ${added ? "pd-add-btn--added" : ""}`}
          onClick={handleAdd}
          disabled={added}
        >
          {added ? (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20,6 9,17 4,12"/>
              </svg>
              Added
            </>
          ) : (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add to Workflow
            </>
          )}
        </button>
      </div>

      <p className="pd-card-desc">{info.description}</p>

      {suggestion.previewText && (
        <div className="pd-preview">
          <span className="pd-preview-label">Found:</span>
          <span className="pd-preview-val">"{suggestion.previewText}"</span>
        </div>
      )}

      {suggestion.selector && (
        <code className="pd-selector">{suggestion.selector}</code>
      )}

      <div className="pd-loop-hint">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="17,1 21,5 17,9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>
          <polyline points="7,23 3,19 7,15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
        </svg>
        {suggestion.type === "url_param"
          ? <>Adds a <strong>URL Pages</strong> block that navigates page-by-page and stops automatically when a page has no items — just drop your extraction steps <strong>inside</strong> it.</>
          : suggestion.type === "infinite_scroll"
          ? <>Adds an <strong>Infinite Scroll</strong> block that loads everything, then runs your extraction steps <strong>inside</strong> it once.</>
          : <>Adds a <strong>Click Button</strong> block that paginates until the button is gone — drop your extraction steps <strong>inside</strong> it to run on every page.</>}
      </div>
    </div>
  );
}

// ─── Manual selection card ────────────────────────────────────────────────────

function ManualCard({ type, onSelect, isWaiting, onAdd }) {
  const isButton = type === 'button';
  const info = isButton
    ? { icon: "👆", label: "Pick a Pagination Button", color: "var(--accent-primary)",
        desc: "Click any button or link that loads the next page or more items." }
    : { icon: "↕",  label: "Use Infinite Scroll",      color: "var(--accent-warning)",
        desc: "Generates a scroll loop — no element selection needed." };

  if (!isButton && onAdd) {
    return (
      <div className="pd-manual-card" style={{"--mc": info.color}}>
        <span className="pd-manual-icon">{info.icon}</span>
        <div className="pd-manual-info">
          <span className="pd-manual-label">{info.label}</span>
          <span className="pd-manual-desc">{info.desc}</span>
        </div>
        <button className="pd-manual-btn" onClick={onAdd}>Add Loop</button>
      </div>
    );
  }

  return (
    <div className="pd-manual-card" style={{"--mc": info.color}}>
      <span className="pd-manual-icon">{info.icon}</span>
      <div className="pd-manual-info">
        <span className="pd-manual-label">{info.label}</span>
        <span className="pd-manual-desc">
          {isWaiting ? "Click the element in the browser…" : info.desc}
        </span>
      </div>
      {isWaiting ? (
        <span className="pd-manual-waiting">
          <span className="pd-pulse"/>Waiting…
        </span>
      ) : (
        <button className="pd-manual-btn" onClick={onSelect}>
          {isButton ? "Select element" : "Add Loop"}
        </button>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PaginationDetector({ isDetecting, suggestions, error, manualWaiting, onDetect, onClose, onAdd, onManualButton, onManualInfinite, baseUrlRaw }) {
  // Focus trap, Escape, focus restore, scroll lock, backdrop semantics.
  // No `open` prop — mounted conditionally, so it derives its own state.
  const showing = isDetecting || suggestions !== null;
  const { overlayProps, dialogProps } = useDialog({ open: showing, onClose });
  if (!showing) return null;

  return (
    <div className="pd-overlay" {...overlayProps}>
      <div className="pd-panel" {...dialogProps}>
        {/* Header */}
        <div className="pd-header">
          <div className="pd-header-left">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9,18 15,12 9,6"/>
            </svg>
            <h2>Pagination Detection</h2>
          </div>
          <button className="pd-close" onClick={onClose} title="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Content */}
        {isDetecting ? (
          <div className="pd-loading">
            <div className="pd-spinner" />
            <p>Scanning page for pagination patterns…</p>
          </div>
        ) : error ? (
          <div className="pd-error">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p>Could not scan page: {error}</p>
          </div>
        ) : suggestions.length === 0 ? (
          <div className="pd-empty">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <p>No pagination patterns auto-detected.</p>
            <span>Select manually below, or navigate to a results page and scan again.</span>
            <button className="pd-retry-btn" onClick={onDetect}>Scan again</button>
            <div className="pd-manual-section" style={{width:"100%", marginTop:8}}>
              <ManualCard type="button" isWaiting={manualWaiting === 'button'} onSelect={onManualButton} />
              <ManualCard type="infinite" onAdd={onManualInfinite} />
            </div>
          </div>
        ) : (
          <>
            <p className="pd-intro">
              Found {suggestions.length} pagination pattern{suggestions.length !== 1 ? "s" : ""}.
              Select one to add a pagination loop to your workflow.
            </p>
            <div className="pd-cards">
              {suggestions.map((s, i) => (
                <SuggestionCard key={i} suggestion={s} onAdd={onAdd} baseUrlRaw={baseUrlRaw} />
              ))}
            </div>
            <div className="pd-manual-section">
              <div className="pd-manual-title">or select manually</div>
              <ManualCard type="button" isWaiting={manualWaiting === 'button'} onSelect={onManualButton} />
              <ManualCard type="infinite" onAdd={onManualInfinite} />
            </div>
            <div className="pd-footer">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              After adding, drop your data-extraction steps <strong>inside</strong> the pagination block so they run on every page. The loop stops on its own when there are no more pages.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
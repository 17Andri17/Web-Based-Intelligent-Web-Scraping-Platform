import { useState } from "react";
import { createAction, createControl } from "../workflow/stepFactory";
import { CONTROL_TYPES } from "../workflow/controlDefinitions";
import { ACTION_TYPES } from "../actions/actionTypes";

// ─── Type metadata ────────────────────────────────────────────────────────────

const TYPE_INFO = {
  next_button: {
    icon: "→",
    label: "Next Button",
    color: "#58a6ff",
    bg: "rgba(88,166,255,0.1)",
    border: "rgba(88,166,255,0.25)",
    description: "Collects data page by page, clicking Next until no more pages exist.",
    loopLabel: "While has next page",
  },
  page_numbers: {
    icon: "#",
    label: "Page Numbers",
    color: "#a371f7",
    bg: "rgba(163,113,247,0.1)",
    border: "rgba(163,113,247,0.25)",
    description: "Navigates through numbered pages by clicking the Next link in pagination.",
    loopLabel: "While next page exists",
  },
  load_more: {
    icon: "+",
    label: "Load More Button",
    color: "#3fb950",
    bg: "rgba(63,185,80,0.1)",
    border: "rgba(63,185,80,0.25)",
    description: "Clicks 'Load More' repeatedly, collecting all newly revealed items on the same page.",
    loopLabel: "While load-more button exists",
  },
  infinite_scroll: {
    icon: "↕",
    label: "Infinite Scroll",
    color: "#d29922",
    bg: "rgba(210,153,34,0.1)",
    border: "rgba(210,153,34,0.25)",
    description: "Scrolls to the bottom repeatedly, collecting content as it loads.",
    loopLabel: "While more content loads",
  },
  url_param: {
    icon: "🔗",
    label: "URL Pages (navigate)",
    color: "#2dd4bf",
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

// ─── Generate WHILE loop steps for each pagination type ───────────────────────

function generatePaginationSteps(suggestion) {
  const { type, selector, containerSelector, hasNextButton } = suggestion;

  // URL-based pagination → a REPEAT loop that navigates page-by-page. The
  // body extracts the CURRENT page (user drags their steps to the top), then
  // builds the next page's URL from the loop index and navigates + waits.
  if (type === "url_param") {
    const before  = suggestion.urlBefore || "";
    const after   = suggestion.urlAfter || "";
    const nextPage = Number.isFinite(suggestion.nextPage) ? suggestion.nextPage : 2;
    const pages   = 5; // default; user can change "Number of repetitions"

    const loop = createControl(CONTROL_TYPES.REPEAT, { count: pages, indexVar: "i" });
    loop.label = TYPE_INFO.url_param.loopLabel;
    loop.meta  = { kind: "pagination", strategy: "url_param" };

    const infra = (step) => { step.meta = { infrastructure: true }; return step; };
    // _next_page_url = "<before>" + (nextPage + i) + "<after>"
    const setUrl = infra(createAction(ACTION_TYPES.SET_VARIABLE, {
      name: "_next_page_url",
      value: `${JSON.stringify(before)} + (${nextPage} + i) + ${JSON.stringify(after)}`,
    }));
    setUrl.label = "Build next page URL";
    const navigate = infra(createAction(ACTION_TYPES.NAVIGATE, { url: "{{_next_page_url}}" }));
    navigate.label = "Go to next page";
    const wait = infra(createAction(ACTION_TYPES.WAIT, { duration: 2000 }));
    wait.label = "Wait for next page to load";

    loop.body = [setUrl, navigate, wait];
    return loop;
  }

  // WHILE control wrapper — tagged with meta.kind = 'pagination' so the
  // Workflow tab can render it as a single "Pagination" block by default
  // and tuck the IF/BREAK/click/wait machinery behind an "Advanced
  // controls" toggle that only technical users need to open.
  const makeWhile = (expression, maxIterations, bodySteps) => {
    const loop = createControl(CONTROL_TYPES.WHILE, {
      expression,
      maxIterations,
    });
    loop.label = TYPE_INFO[type]?.loopLabel || "Pagination loop";
    loop.body  = bodySteps;
    loop.meta  = { kind: 'pagination', strategy: type };
    return loop;
  };

  // Auto-generated infrastructure step — marked so the Workflow tab can
  // hide it in the simplified pagination view. The data is preserved
  // verbatim, so advanced users (and code-gen) see the real thing.
  const infra = (step) => { step.meta = { infrastructure: true }; return step; };

  const makeClick = (sel) => infra(createAction(ACTION_TYPES.CLICK_ELEMENT, { selector: sel }));
  const makeWait  = (ms)  => infra(createAction(ACTION_TYPES.WAIT,          { duration: ms }));
  const makeScroll = () => createAction(ACTION_TYPES.SCROLL_PAGE, { direction: "bottom" });

  // Build a do-while loop body: each iteration extracts the CURRENT page,
  // then checks whether more pages exist, then clicks the next-page link.
  // The IF check is positioned *before* the click so that on the last page
  // we extract once and break out cleanly — without it, a plain WHILE
  // either misses the first page (check + click runs before extract) or
  // misses the last page (extract runs only when there's still a "next").
  //
  // Steps returned: [breakIf, click, wait]. The user drags their extraction
  // steps to the TOP of the loop body — see the hint card under each
  // suggestion. The loop's WHILE expression is just `true`; the break is
  // gated by `breakWhen` (a JS expression that's truthy on the last page).
  const makeDoWhileBody = (breakWhen, click, wait) => {
    const breakIf = createControl(CONTROL_TYPES.IF, { expression: breakWhen });
    breakIf.label = "Stop when last page reached";
    breakIf.then  = [infra(createAction(ACTION_TYPES.BREAK_LOOP, {}))];
    breakIf.else  = [];
    breakIf.meta  = { infrastructure: true };
    return [breakIf, click, wait];
  };

  switch (type) {
    case "next_button": {
      const click = makeClick(selector); click.label = "Click next page";
      const wait  = makeWait(2000);      wait.label  = "Wait for next page to load";
      return makeWhile(
        "true", 500,
        makeDoWhileBody(`(await page.$(\`${selector}\`)) === null`, click, wait)
      );
    }

    case "page_numbers": {
      // When the detector found a Next link inside the numbered pagination,
      // treat it exactly like next_button.
      if (hasNextButton) {
        const click = makeClick(selector); click.label = "Click next page";
        const wait  = makeWait(2000);      wait.label  = "Wait for next page to load";
        return makeWhile(
          "true", 500,
          makeDoWhileBody(`(await page.$(\`${selector}\`)) === null`, click, wait)
        );
      }

      // No Next button — only numbered links. We can't use a single
      // static selector because each iteration needs a different number.
      // The "find and mark" eval runs inside the container, identifies
      // the active page, locates the link whose number is one greater,
      // and tags it with `data-pagi-target="1"`. The body's click then
      // targets that marker; a fresh marker is placed each iteration.
      //
      // We invert it for the break condition — when no `n+1` link
      // exists we're on the last page, so the IF fires and breaks.
      const container = containerSelector || selector;
      const findAndMark = [
        `await page.evaluate((sel) => {`,
        `  const c = document.querySelector(sel);`,
        `  if (!c) return false;`,
        `  c.querySelectorAll('[data-pagi-target]').forEach(el => el.removeAttribute('data-pagi-target'));`,
        `  const active = c.querySelector('[aria-current="page"],.active,[class~="active"],.current,[class~="current"],[class*="--active"],[class*="is-active"]');`,
        `  let curN = NaN;`,
        `  if (active) {`,
        `    const t = (active.innerText || active.textContent || '').trim();`,
        `    if (/^\\d+$/.test(t)) curN = parseInt(t, 10);`,
        `  }`,
        `  if (!Number.isFinite(curN)) {`,
        `    const m = location.href.match(/[?&](?:page|paged|pg|pagenum|pageno|p)=(\\d+)/i) || location.pathname.match(/\\/(\\d+)\\/?$/);`,
        `    if (m) curN = parseInt(m[1], 10);`,
        `  }`,
        `  if (!Number.isFinite(curN)) curN = 1;`,
        `  const links = Array.from(c.querySelectorAll('a,button,[role="button"]'))`,
        `    .map(a => {`,
        `      const t = (a.innerText || a.textContent || '').trim();`,
        `      return /^\\d+$/.test(t) ? { a, n: parseInt(t, 10) } : null;`,
        `    })`,
        `    .filter(Boolean);`,
        `  if (!links.length) return false;`,
        `  const target = links.find(x => x.n === curN + 1)`,
        `             || links.filter(x => x.n > curN).sort((a, b) => a.n - b.n)[0];`,
        `  if (!target) return false;`,
        `  target.a.setAttribute('data-pagi-target', '1');`,
        `  return true;`,
        `}, ${JSON.stringify(container)})`,
      ].join("\n");
      const click = makeClick('[data-pagi-target="1"]'); click.label = "Click next numbered page";
      const wait  = makeWait(2000);                      wait.label  = "Wait for next page to load";
      return makeWhile(
        "true", 500,
        makeDoWhileBody(`!(${findAndMark})`, click, wait)
      );
    }

    case "load_more": {
      // WHILE selector exists → click load more → wait → [YOUR EXTRACTIONS]
      const click  = makeClick(selector);
      click.label  = "Click load more";
      const wait   = makeWait(2000);
      wait.label   = "Wait for content to load";
      return makeWhile(`await page.$(\`${selector}\`) !== null`, 200, [click, wait]);
    }

    case "infinite_scroll": {
      // WHILE more content keeps loading → scroll to bottom + scrollIntoView
      // last item → wait. Both strategies ensure IntersectionObserver-based
      // and scroll-event-based loaders fire.
      const scroll  = makeScroll();
      scroll.label  = "Scroll to bottom of page";
      const wait    = makeWait(2000);
      wait.label    = "Wait for new content to load";
      return makeWhile(
        // Enter on the first pass, then keep looping only while the page keeps
        // GROWING. We compare the live scrollHeight to the height recorded on
        // the previous pass (stored on the page's window) — that's what
        // actually detects "more content loaded". The old check asked whether
        // we could still scroll right after jumping to the bottom, which is
        // always false the instant after scrollTo(…scrollHeight), so the loop
        // body never ran.
        [
          `await page.evaluate(() => {`,
          `  const ITEM_SEL = 'li,article,[class*="item"],[class*="card"],[class*="result"],[class*="product"]';`,
          `  const items = document.querySelectorAll(ITEM_SEL);`,
          `  if (items.length) items[items.length-1].scrollIntoView({ block:'end', behavior:'instant' });`,
          `  window.scrollTo(0, document.body.scrollHeight);`,
          `  const prev = window.__infScrollPrevH;`,
          `  const h = document.body.scrollHeight;`,
          `  window.__infScrollPrevH = h;`,
          `  return prev === undefined || h > prev + 50;`,
          `})`,
        ].join("\n"),
        200,
        [scroll, wait]
      );
    }

    default:
      return null;
  }
}

// ─── Suggestion card ──────────────────────────────────────────────────────────

function SuggestionCard({ suggestion, onAdd }) {
  const [added, setAdded] = useState(false);
  const info = TYPE_INFO[suggestion.type] || {};

  const handleAdd = () => {
    const step = generatePaginationSteps(suggestion);
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
          ? <>Adds a <strong>Repeat N times</strong> loop that navigates page-by-page — drag your extraction steps to the <strong>top</strong> of the loop body, and set how many pages to visit.</>
          : <>Adds a <strong>While</strong> loop — drag your extraction steps to the <strong>top</strong> of the loop body, above the "Stop" check</>}
      </div>
    </div>
  );
}

// ─── Manual selection card ────────────────────────────────────────────────────

function ManualCard({ type, onSelect, isWaiting, onAdd }) {
  const isButton = type === 'button';
  const info = isButton
    ? { icon: "👆", label: "Pick a Pagination Button", color: "#58a6ff",
        desc: "Click any button or link that loads the next page or more items." }
    : { icon: "↕",  label: "Use Infinite Scroll",      color: "#d29922",
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

export default function PaginationDetector({ isDetecting, suggestions, error, manualWaiting, onDetect, onClose, onAdd, onManualButton, onManualInfinite }) {
  if (!isDetecting && suggestions === null) return null;

  return (
    <div className="pd-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pd-panel">
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
                <SuggestionCard key={i} suggestion={s} onAdd={onAdd} />
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
              After adding, drag your data extraction steps to the <strong>top</strong> of the loop body — above the "Stop" check — so the first AND last pages are both captured.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
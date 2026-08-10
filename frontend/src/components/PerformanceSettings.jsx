import React from "react";
import "../styles/ApiKeysMenu.css";

/*
  Performance settings — per-workflow speed switches (workflow.meta.performance).

  These matter most on big jobs: thousands of detail pages, where every
  per-page saving is multiplied by the row count. Each one is OFF by default so
  a workflow that already works keeps behaving exactly as it did — speed is
  opted into, never applied silently.

  Backend: backend/workflow/workflowCodegen.js (resolvePerf) and
  backend/browser/resourceBlock.js.
*/

const OPTIONS = [
  {
    key: "blockResources",
    title: "Skip images, fonts and video",
    detail:
      "Extraction reads the DOM, never the pixels. On a typical product page these are most of the bytes " +
      "and a large share of the load time. Ad and analytics requests are dropped too. Extracting an image " +
      "URL still works — the attribute is in the HTML either way.",
    caution: "Turn off if the site lazy-loads content in response to images actually loading.",
  },
  {
    key: "blockStylesheets",
    title: "Also skip stylesheets",
    detail:
      "Goes further and drops CSS. Selector-based extraction does not need it.",
    caution: "Turn off if the page relies on layout to trigger loading, or you extract by visible styling.",
    requires: "blockResources",
  },
  {
    key: "httpFirst",
    title: "Skip the browser when the page doesn't need it",
    detail:
      "Many detail pages are plain HTML — the data is already in the source, and running a whole browser to " +
      "read it is wasted work. This fetches those pages directly instead, which is far faster and uses so " +
      "little memory that you can raise the pages-at-once setting well beyond what tabs allow. " +
      "It is checked, not assumed: the first page is scraped both ways and compared, and if the results " +
      "differ at all the run quietly uses the browser for everything.",
    caution: "Only applies to loops that just read the page. Anything that clicks, scrolls or types keeps using the browser.",
  },
  {
    key: "smartWait",
    title: "Continue as soon as the data appears",
    detail:
      "Instead of waiting for every last image and ad frame to finish, each page continues the moment the " +
      "element being extracted exists. Usually faster and more reliable — waiting for the data beats " +
      "guessing that it has arrived. If the element never shows up it falls back to waiting for the full " +
      "page load, so it can't do worse than before.",
  },
];

const numStyle = {
  width: 80, padding: "4px 6px", fontSize: 12,
  background: "var(--bg-secondary)", color: "var(--text-primary, inherit)",
  border: "1px solid var(--border-muted)", borderRadius: 4,
};

// Keep a typed value inside the range the backend will accept, so the UI never
// shows a number the run won't actually honour.
function clampInt(raw, min, max, dflt) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

export default function PerformanceSettings({ open, onClose, value, onChange }) {
  if (!open) return null;

  const perf = value || {};
  const set = (key, on) => {
    const next = { ...perf, [key]: on };
    // Stylesheet blocking is meaningless on its own — it rides on the request
    // interception the main switch installs. Keep the two coherent rather than
    // letting a user save a combination that silently does nothing.
    if (key === "blockResources" && !on) next.blockStylesheets = false;
    if (key === "blockStylesheets" && on) next.blockResources = true;
    onChange(next);
  };

  const anyOn = OPTIONS.some(o => perf[o.key]);

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal ca-modal" onClick={e => e.stopPropagation()}>
        <div className="wf-header">
          <h2>Speed</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="wf-body">
          <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 0, lineHeight: 1.6 }}>
            Options for large scrapes. Each one changes how pages are fetched, so they start off — turn them
            on when you are scraping many pages and want the run to finish sooner. Settings are saved with
            this workflow.
          </p>

          {OPTIONS.map(opt => {
            const on = !!perf[opt.key];
            const blocked = opt.requires && !perf[opt.requires];
            return (
              <label
                key={opt.key}
                style={{
                  display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 0",
                  borderTop: "1px solid var(--border-muted)", cursor: blocked ? "default" : "pointer",
                  opacity: blocked ? 0.55 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={blocked}
                  onChange={e => set(opt.key, e.target.checked)}
                  style={{ marginTop: 3, flex: "0 0 auto" }}
                />
                <span>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{opt.title}</span>
                  <span style={{ display: "block", fontSize: 11.5, color: "var(--text-secondary)", marginTop: 4, lineHeight: 1.55 }}>
                    {opt.detail}
                  </span>
                  {opt.caution && (
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", marginTop: 5, fontStyle: "italic" }}>
                      {opt.caution}
                    </span>
                  )}
                  {blocked && (
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", marginTop: 5 }}>
                      Needs “Skip images, fonts and video” first.
                    </span>
                  )}
                </span>
              </label>
            );
          })}

          <div style={{ borderTop: "1px solid var(--border-muted)", paddingTop: 14, marginTop: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Scrape several pages at once</div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.55, marginBottom: 10 }}>
              Applies to loops that open one page per item — a subflow over a list of URLs, or For-Each-Row
              opening each row&rsquo;s link. Rows always come back in their original order, however many run at
              once. Leave at 1 to scrape one page at a time, as before.
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 12, width: 150 }}>Pages at once</span>
              <input
                type="number" min={1} max={16} step={1}
                value={perf.concurrency ?? 1}
                onChange={e => onChange({ ...perf, concurrency: clampInt(e.target.value, 1, 16, 1) })}
                style={numStyle}
              />
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                1 – 16 ·{" "}
                {perf.httpFirst
                  ? "pages fetched without a browser cost almost nothing, so go higher"
                  : "each one uses a browser tab (~50-80 MB)"}
              </span>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 12, width: 150 }}>Max requests / second</span>
              <input
                type="number" min={0} max={100} step={1}
                value={perf.requestsPerSecond ?? 0}
                onChange={e => onChange({ ...perf, requestsPerSecond: clampInt(e.target.value, 0, 100, 0) })}
                style={numStyle}
              />
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                0 = no limit · shared across all pages, not per page
              </span>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12, width: 150 }}>Random extra delay</span>
              <input
                type="number" min={0} max={10000} step={50}
                value={perf.jitterMs ?? 0}
                onChange={e => onChange({ ...perf, jitterMs: clampInt(e.target.value, 0, 10000, 0) })}
                style={numStyle}
              />
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                ms · up to this much, so requests aren&rsquo;t perfectly regular
              </span>
            </label>

            {(perf.concurrency ?? 1) > 4 && !(perf.requestsPerSecond > 0) && (
              <div style={{ fontSize: 11.5, color: "#d29922", marginTop: 10, lineHeight: 1.55 }}>
                {perf.concurrency} pages at once with no rate limit is a lot of traffic for one site. Consider
                setting a requests/second cap, or routing through a proxy pool.
              </div>
            )}
          </div>

          <div style={{
            marginTop: 14, padding: "10px 12px", borderRadius: 6,
            background: "var(--bg-secondary)",
            fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.6,
          }}>
            {anyOn
              ? "If a run starts returning empty fields after changing these, turn them back off — that tells you the site depends on what was being skipped."
              : "Nothing enabled: pages load exactly as they do today."}
            <br />
            Partial results are always kept: if a run is cancelled, times out or crashes, the rows captured
            up to that point are saved and the run is marked “Partial”.
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <button className="modal-btn primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}

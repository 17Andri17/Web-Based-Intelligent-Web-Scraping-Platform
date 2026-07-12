import { useState } from "react";

// ─── Auth-tier + verification metadata ─────────────────────────────────────────

const AUTH_INFO = {
  open:    { label: "Open — no auth",     color: "#3fb950", bg: "rgba(63,185,80,0.12)",  border: "rgba(63,185,80,0.3)" },
  session: { label: "Session cookies",    color: "#58a6ff", bg: "rgba(88,166,255,0.12)", border: "rgba(88,166,255,0.3)" },
  bearer:  { label: "Token / API key",    color: "#d29922", bg: "rgba(210,153,34,0.12)", border: "rgba(210,153,34,0.3)" },
  signed:  { label: "Signed (HMAC)",      color: "#f85149", bg: "rgba(248,81,73,0.12)",  border: "rgba(248,81,73,0.3)" },
  unknown: { label: "Unknown auth",       color: "#8b949e", bg: "rgba(139,148,158,0.12)",border: "rgba(139,148,158,0.3)" },
};

// Maps the backend verification object → a badge. `null` means not run.
function verificationBadge(v) {
  if (!v || !v.verification) return null;
  switch (v.verification) {
    case "open-verified": return { text: "✓ Verified — no auth needed", cls: "as-verif--open", title: v.note };
    case "verified":      return { text: "✓ Verified — uses your session", cls: "as-verif--session", title: v.note };
    case "blocked":       return { text: "⚠ Guarded", cls: "as-verif--blocked", title: v.note };
    case "unverified":    return { text: "Not verified", cls: "as-verif--unknown", title: v.note };
    default:              return null;
  }
}

function ConfidenceBar({ value, color }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <div className="as-confidence">
      <div className="as-conf-bar"><div className="as-conf-fill" style={{ width: `${pct}%`, background: color }} /></div>
      <span className="as-conf-label">{pct}%</span>
    </div>
  );
}

// ─── Copy-to-clipboard button ───────────────────────────────────────────────────

function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`as-copy-btn ${copied ? "as-copy-btn--done" : ""}`}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch (_) {}
      }}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

// ─── Source card ────────────────────────────────────────────────────────────────

function SourceCard({ source }) {
  const [open, setOpen] = useState(false);
  const auth = AUTH_INFO[source.authTier] || AUTH_INFO.unknown;
  const verif = verificationBadge(source.verification);
  const pageParams = (source.queryParams || []).filter((p) => p.role === "pagination");
  const fields = (source.recordShape && source.recordShape.fields) || [];

  return (
    <div className="as-card" style={{ "--card-color": auth.color, "--card-bg": auth.bg, "--card-border": auth.border }}>
      <div className="as-card-header">
        <span className="as-method">{source.method}</span>
        <span className="as-path" title={source.url}>{source.path}</span>
        <ConfidenceBar value={source.confidence} color={auth.color} />
      </div>

      <div className="as-badges">
        <span className="as-auth-badge" style={{ color: auth.color, background: auth.bg, borderColor: auth.border }}>
          {auth.label}
        </span>
        {verif && <span className={`as-verif ${verif.cls}`} title={verif.title}>{verif.text}</span>}
        {source.matchedValues > 0 && (
          <span className="as-match" title="Scraped values found in this response">
            {source.matchedValues}/{source.totalSampleValues} values matched
          </span>
        )}
        {source.occurrences > 1 && <span className="as-occ">called ×{source.occurrences}</span>}
      </div>

      <p className="as-summary">{source.summary}</p>

      {fields.length > 0 && (
        <div className="as-fields">
          {fields.slice(0, 12).map((f) => <code key={f} className="as-field-chip">{f}</code>)}
          {fields.length > 12 && <span className="as-field-more">+{fields.length - 12}</span>}
        </div>
      )}

      {pageParams.length > 0 && (
        <div className="as-paging">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <polyline points="9,18 15,12 9,6" />
          </svg>
          Paginate by <code>{pageParams.map((p) => p.name).join(", ")}</code> — increment to walk every page.
        </div>
      )}

      {source.authSignals && source.authSignals.length > 0 && (
        <div className="as-auth-signals">Auth detected via: {source.authSignals.join(", ")}</div>
      )}

      <button className="as-expand" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide request details" : "Show request & code"}
      </button>

      {open && (
        <div className="as-details">
          <div className="as-detail-row">
            <span className="as-detail-label">URL</span>
            <code className="as-url">{source.url}</code>
          </div>
          <div className="as-snippet">
            <div className="as-snippet-head"><span>fetch()</span><CopyButton text={source.fetchSnippet} label="Copy" /></div>
            <pre>{source.fetchSnippet}</pre>
          </div>
          <div className="as-snippet">
            <div className="as-snippet-head"><span>cURL</span><CopyButton text={source.curl} label="Copy" /></div>
            <pre>{source.curl}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main panel ─────────────────────────────────────────────────────────────────

export default function ApiSourcesPanel({ isAnalyzing, sources, error, capturedCount, consideredCount, onAnalyze, onClose }) {
  if (!isAnalyzing && sources === null) return null;

  return (
    <div className="as-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="as-panel">
        <div className="as-header">
          <div className="as-header-left">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 7h16M4 12h16M4 17h10" /><circle cx="19" cy="17" r="2" />
            </svg>
            <h2>API Discovery</h2>
          </div>
          <button className="as-close" onClick={onClose} title="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {isAnalyzing ? (
          <div className="as-loading">
            <div className="as-spinner" />
            <p>Analyzing captured network calls…</p>
          </div>
        ) : error ? (
          <div className="as-error">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p>Could not analyze: {error}</p>
            <button className="as-retry-btn" onClick={onAnalyze}>Try again</button>
          </div>
        ) : sources.length === 0 ? (
          <div className="as-empty">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <p>No data API detected on this page.</p>
            <span>
              {capturedCount > 0
                ? `Watched ${capturedCount} network call${capturedCount === 1 ? "" : "s"}, but none clearly returned the page's data. Interact with the page (search, scroll, open an item) to trigger its API, then analyze again. This page may also render its data server-side, in which case scraping the DOM is the way to go.`
                : "No XHR/fetch calls captured yet. Navigate or interact with the page to trigger its API, then analyze again."}
            </span>
            <button className="as-retry-btn" onClick={onAnalyze}>Analyze again</button>
          </div>
        ) : (
          <>
            <p className="as-intro">
              Found {sources.length} candidate API{sources.length !== 1 ? "s" : ""} the page calls for its data
              {typeof consideredCount === "number" ? ` (from ${capturedCount} captured call${capturedCount === 1 ? "" : "s"})` : ""}.
              Using these directly is faster and more stable than scraping the rendered page.
            </p>
            <div className="as-cards">
              {sources.map((s) => <SourceCard key={s.id} source={s} />)}
            </div>
            <div className="as-footer">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              These are the site's own private endpoints. They can change without notice, and using them may fall under the site's terms of service — verify before relying on one in production.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

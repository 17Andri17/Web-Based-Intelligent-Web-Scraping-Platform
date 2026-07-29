import React, { useEffect, useState, useRef } from "react";
import "../styles/SelectorDebugger.css";

/* =====================================================================
   SelectorDebugger
   "Why does this selector match 0 elements?" — test a CSS/XPath selector
   against the LIVE page and get a plain-language diagnosis: match count,
   how many are visible, a sample of what matched, and — when nothing
   matches — which part of the selector is the culprit (progressive
   relaxation) or whether it's hidden / inside an iframe.

   Talks to the backend `debugSelector` socket handler; the diagnosis is
   computed server-side (services/selectorDebug) against the user's
   current streamed page.

   Props:
     open, onClose
     socket
     initialSelector, initialType   optional prefill (e.g. from a step field)
   ===================================================================== */

const VERDICT_META = {
  ok:      { label: "Looks good",         color: "#3fb950", icon: "✓" },
  hidden:  { label: "Matches, but hidden", color: "#d29922", icon: "◐" },
  iframe:  { label: "Inside an iframe",    color: "#d29922", icon: "▤" },
  partial: { label: "Partly wrong",        color: "#e89a4f", icon: "◑" },
  none:    { label: "No match",            color: "#f85149", icon: "✕" },
};

export default function SelectorDebugger({ open, onClose, socket, initialSelector = "", initialType = "css" }) {
  const [selector, setSelector] = useState(initialSelector);
  const [type, setType]         = useState(initialType === "xpath" ? "xpath" : "css");
  const [busy, setBusy]         = useState(false);
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState(null);
  const inputRef = useRef(null);

  // Prefill + focus each time it opens.
  useEffect(() => {
    if (!open) return;
    setSelector(initialSelector || "");
    setType(initialType === "xpath" ? "xpath" : "css");
    setResult(null); setError(null); setBusy(false);
    setTimeout(() => inputRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Socket result listener.
  useEffect(() => {
    if (!socket) return;
    const onResult = (payload) => {
      setBusy(false);
      if (!payload || !payload.ok) { setError(payload?.error || "Couldn't test the selector."); setResult(null); return; }
      setError(null);
      setResult(payload);
    };
    socket.on("debugSelectorResult", onResult);
    return () => socket.off("debugSelectorResult", onResult);
  }, [socket]);

  if (!open) return null;

  const test = () => {
    const sel = selector.trim();
    if (!sel) { setError("Enter a selector to test."); return; }
    if (!socket) { setError("Not connected to the live page."); return; }
    setBusy(true); setError(null); setResult(null);
    socket.emit("debugSelector", { selector: sel, selectorType: type });
  };

  const vm = result ? (VERDICT_META[result.verdict] || VERDICT_META.none) : null;

  return (
    <div className="wf-overlay" onClick={onClose}>
      <div className="wf-modal sd-modal" onClick={e => e.stopPropagation()}>
        <div className="wf-header">
          <h2>Selector debugger</h2>
          <button className="wf-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="wf-body">
          <div className="sd-hint">
            Test a selector against the page in the Live Browser tab. If it matches nothing,
            we'll tell you which part is wrong.
          </div>

          <div className="sd-input-row">
            <select className="sd-type" value={type} onChange={e => setType(e.target.value)}>
              <option value="css">CSS</option>
              <option value="xpath">XPath</option>
            </select>
            <input
              ref={inputRef}
              className="sd-input"
              value={selector}
              onChange={e => setSelector(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") test(); }}
              placeholder={type === "xpath" ? "//div[@class='product']" : ".product-card .price"}
              spellCheck={false}
            />
            <button className="sd-test" onClick={test} disabled={busy || !selector.trim()}>
              {busy ? "Testing…" : "Test"}
            </button>
          </div>

          {error && <div className="wf-error" style={{ marginTop: 10 }}>{error}</div>}

          {result && (
            <div className="sd-result">
              <div className="sd-verdict" style={{ color: vm.color, borderColor: vm.color + "55", background: vm.color + "14" }}>
                <span className="sd-verdict-icon">{vm.icon}</span>
                <span className="sd-verdict-label">{vm.label}</span>
              </div>

              {result.messages?.map((m, i) => (
                <div key={i} className="sd-message">{m}</div>
              ))}

              {/* Suggestions (partial matches) — click to adopt into the box */}
              {result.suggestions?.length > 0 && (
                <div className="sd-suggestions">
                  <div className="sd-sub-title">Parts that DO match — click to try one:</div>
                  {result.suggestions.map((s, i) => (
                    <button key={i} className="sd-suggestion" onClick={() => { setSelector(s.selector); setType("css"); setTimeout(test, 0); }}>
                      <code>{s.selector}</code>
                      <span className="sd-suggestion-count">{s.count} match{s.count === 1 ? "" : "es"}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Sample of matched elements */}
              {result.samples?.length > 0 && (
                <div className="sd-samples">
                  <div className="sd-sub-title">Matched elements (first {result.samples.length}):</div>
                  {result.samples.map((s, i) => (
                    <div key={i} className="sd-sample">
                      <code className="sd-sample-tag">
                        &lt;{s.tag}{s.id ? `#${s.id}` : ""}{s.classes?.length ? "." + s.classes.join(".") : ""}&gt;
                      </code>
                      {!s.visible && <span className="sd-sample-hidden" title="Not visible on screen">hidden</span>}
                      {s.text && <span className="sd-sample-text">{s.text}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

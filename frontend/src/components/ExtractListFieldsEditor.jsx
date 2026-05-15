import React, { useEffect, useMemo, useRef, useState } from "react";

/* =====================================================================
   ExtractListFieldsEditor
   ---------------------------------------------------------------------
   The fields editor for an EXTRACT_LIST step. Each field is a record:
     { selector: string, kind: 'text'|'attr'|'html', attribute?: string }
   stored under params.fields[fieldName].

   Backward compat: this component accepts (and migrates on first edit)
   the legacy string-only shape `params.fields = { name: 'selector' }`.

   Features:
     - add / remove / rename / edit field rows
     - per-row "kind" picker (text / attribute / html) with attribute input
     - AI auto-detect button with a natural-language hint textarea
     - live sample value next to each field (filled after AI verification
       or after the existing previewStep socket round-trip)

   Props:
     value             — { name: spec | string } map (params.fields)
     onChange(newMap)  — emit updated fields map back to the step
     containerSelector — current params.containerSelector (read-only here)
     selectorType      — 'css' | 'xpath'
     socket            — socket.io client (for AI + sample HTML)
     previewRows       — array of preview row objects from backend (latest
                         previewStep response for this step), used to fill
                         in sample values per field
   ===================================================================== */

export default function ExtractListFieldsEditor({
  value, onChange,
  containerSelector,
  selectorType = "css",
  socket,
  previewRows,
}) {
  // ── Normalise the incoming value once so the rest of the component sees
  // a single uniform shape. We never persist this normalised form back
  // unless the user actually edits something — keeps git diffs minimal.
  const normalised = useMemo(() => normaliseFields(value), [value]);

  // ── AI state ──────────────────────────────────────────────────────────
  const [hint, setHint]           = useState("");
  const [aiBusy, setAiBusy]       = useState(false);
  const [aiError, setAiError]     = useState(null);
  const [aiNote, setAiNote]       = useState(null);     // explanation + counts
  const [aiRejected, setAiRejected] = useState([]);     // proposals dropped during verify
  // Sample values keyed by field name — filled from AI verification or
  // from the latest previewRows snapshot.
  const [aiSamples, setAiSamples] = useState({});

  // Track the latest pending AI request so we can correlate the async
  // response with the right invocation (in case the user clicks twice).
  const pendingRequestId = useRef(null);

  // Listen for the AI response from the backend.
  useEffect(() => {
    if (!socket) return;
    const onResult = (payload) => {
      if (pendingRequestId.current && payload.requestId !== pendingRequestId.current) return;
      pendingRequestId.current = null;
      setAiBusy(false);

      if (!payload.ok) {
        setAiError(formatAiError(payload));
        setAiNote(null);
        setAiRejected([]);
        return;
      }

      const fields  = payload.fields  || [];
      const dropped = payload.rejected || [];

      // Merge AI fields into the current map. Don't clobber a name the
      // user has already defined — append "_2" / "_3" if there's a clash.
      const next = { ...normalised };
      const samples = { ...aiSamples };
      for (const f of fields) {
        const name = uniqueName(f.name, next);
        next[name] = pickSpec(f);
        samples[name] = f.sampleValue;
      }
      onChange(next);
      setAiSamples(samples);
      // Count where each field came from (ai vs heuristic) so the user
      // can tell when the LLM failed and the fallback kicked in.
      const heurCount = fields.filter(f => f.source === 'heuristic').length;
      const aiCount   = fields.length - heurCount;
      setAiNote({
        explanation: payload.explanation || "",
        count: fields.length,
        sampleCount: payload.sampleCount || 0,
        verifyError: payload.verificationError || null,
        aiCount, heurCount,
        source: payload.source || (heurCount > 0 && aiCount === 0 ? 'heuristic' : 'ai'),
        aiError: payload.aiOk === false ? (payload.aiError || `(${payload.aiCode || 'AI failed'})`) : null,
      });
      setAiRejected(dropped);
      setAiError(null);
    };
    socket.on("aiExtractListFieldsResult", onResult);
    return () => socket.off("aiExtractListFieldsResult", onResult);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, normalised]);

  // Refresh sample values from previewRows whenever they come in.
  useEffect(() => {
    if (!Array.isArray(previewRows) || previewRows.length === 0) return;
    const first = previewRows[0] || {};
    setAiSamples(prev => {
      const next = { ...prev };
      for (const name of Object.keys(normalised)) {
        const v = first[name];
        if (v !== undefined) {
          next[name] = v == null ? null : String(v).slice(0, 200);
        }
      }
      return next;
    });
  }, [previewRows, normalised]);

  // ── Auto-detect handler ───────────────────────────────────────────────
  const handleAutoDetect = () => {
    setAiError(null);
    setAiNote(null);
    setAiRejected([]);
    if (!socket) {
      setAiError("Not connected to the backend.");
      return;
    }
    if (!containerSelector || !String(containerSelector).trim()) {
      setAiError("Set a container selector first.");
      return;
    }
    setAiBusy(true);
    const requestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    pendingRequestId.current = requestId;
    socket.emit("aiExtractListFields", {
      containerSelector,
      selectorType,
      hint,
      existingFields: Object.fromEntries(Object.keys(normalised).map(k => [k, true])),
      requestId,
    });
  };

  // ── Field row helpers ────────────────────────────────────────────────
  const updateField = (name, patch) => {
    const next = { ...normalised, [name]: { ...normalised[name], ...patch } };
    // Switching away from "attr" clears the attribute name.
    if (patch.kind && patch.kind !== "attr") next[name].attribute = null;
    onChange(next);
  };

  const renameField = (oldName, newNameRaw) => {
    const newName = sanitiseFieldName(newNameRaw);
    if (!newName || newName === oldName) return;
    if (normalised[newName]) return; // refuse to clobber
    const next = {};
    for (const k of Object.keys(normalised)) {
      next[k === oldName ? newName : k] = normalised[k];
    }
    onChange(next);
    setAiSamples(prev => {
      const np = { ...prev };
      if (np[oldName] !== undefined) { np[newName] = np[oldName]; delete np[oldName]; }
      return np;
    });
  };

  const removeField = (name) => {
    const next = { ...normalised };
    delete next[name];
    onChange(next);
  };

  const addBlankField = () => {
    const name = uniqueName("field", normalised);
    onChange({ ...normalised, [name]: { selector: "", kind: "text", attribute: null } });
  };

  // ── Render ────────────────────────────────────────────────────────────
  const fieldNames = Object.keys(normalised);

  return (
    <div className="elfe-root">
      {/* AI panel */}
      <div className="elfe-ai">
        <div className="elfe-ai-header">
          <span className="elfe-ai-badge">AI</span>
          <strong>Auto-detect fields</strong>
          <span className="elfe-ai-sub">
            Analyses the first matching item and proposes named fields with selectors.
          </span>
        </div>
        <textarea
          className="elfe-ai-hint"
          rows={2}
          placeholder='Optional hint, e.g. "I want the product title, price, image URL and link — ignore the rating stars."'
          value={hint}
          onChange={e => setHint(e.target.value)}
          disabled={aiBusy}
        />
        <div className="elfe-ai-actions">
          <button
            type="button"
            className="elfe-btn elfe-btn--primary"
            onClick={handleAutoDetect}
            disabled={aiBusy || !containerSelector}
            title={!containerSelector ? "Set a container selector first" : "Run AI auto-detect"}
          >
            {aiBusy ? "Analysing…" : "✨ Auto-detect fields"}
          </button>
          {aiNote && (
            <span className="elfe-ai-note">
              Added {aiNote.count} field{aiNote.count === 1 ? "" : "s"} from sample of {aiNote.sampleCount} item{aiNote.sampleCount === 1 ? "" : "s"}.
              {aiNote.heurCount > 0 && aiNote.aiCount > 0 && ` (${aiNote.aiCount} from AI + ${aiNote.heurCount} from heuristics)`}
              {aiNote.heurCount > 0 && aiNote.aiCount === 0 && ` (all from the built-in heuristic detector)`}
            </span>
          )}
        </div>
        {aiError && <div className="elfe-ai-error">{aiError}</div>}
        {aiNote?.aiError && (
          <div className="elfe-ai-warn">
            AI didn't return usable suggestions: {aiNote.aiError}. The heuristic detector picked up basic fields instead — review and adjust.
          </div>
        )}
        {aiNote?.explanation && <div className="elfe-ai-expl">{aiNote.explanation}</div>}
        {aiNote?.verifyError && <div className="elfe-ai-warn">Live verification failed: {aiNote.verifyError}. Fields shown without sample values.</div>}
        {aiRejected.length > 0 && (
          <details className="elfe-ai-rejected">
            <summary>{aiRejected.length} suggestion{aiRejected.length === 1 ? "" : "s"} dropped during verification</summary>
            <ul>
              {aiRejected.map((r, i) => (
                <li key={i}><code>{r.name}</code> ({r.selector}) — {r.reason}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* Fields list */}
      <div className="elfe-fields">
        <div className="elfe-fields-header">
          <span>Fields ({fieldNames.length})</span>
          <button type="button" className="elfe-btn elfe-btn--ghost" onClick={addBlankField}>+ Add field</button>
        </div>

        {fieldNames.length === 0 ? (
          <div className="elfe-empty">
            No fields yet. Click <strong>Auto-detect fields</strong> above or add one manually.
          </div>
        ) : (
          <div className="elfe-rows">
            {fieldNames.map(name => {
              const f = normalised[name];
              const sample = aiSamples[name];
              return (
                <div key={name} className="elfe-row">
                  <div className="elfe-row-top">
                    <input
                      className="elfe-name"
                      value={name}
                      onChange={e => { /* renames happen on blur */ }}
                      onBlur={e => renameField(name, e.target.value)}
                      title="Field name (snake_case)"
                    />
                    <select
                      className="elfe-kind"
                      value={f.kind}
                      onChange={e => updateField(name, { kind: e.target.value })}
                    >
                      <option value="text">text</option>
                      <option value="attr">attribute</option>
                      <option value="html">innerHTML</option>
                    </select>
                    {f.kind === "attr" && (
                      <input
                        className="elfe-attr"
                        value={f.attribute || ""}
                        placeholder="href / src / data-id"
                        onChange={e => updateField(name, { attribute: e.target.value })}
                      />
                    )}
                    <button
                      type="button"
                      className="elfe-row-remove"
                      onClick={() => removeField(name)}
                      title="Remove"
                    >×</button>
                  </div>
                  <input
                    className="elfe-selector"
                    value={f.selector || ""}
                    placeholder="CSS selector relative to the container, e.g. .price"
                    onChange={e => updateField(name, { selector: e.target.value })}
                  />
                  {sample !== undefined && (
                    <div className="elfe-sample" title={sample == null ? "no value" : String(sample)}>
                      <span className="elfe-sample-label">sample:</span>
                      {sample == null
                        ? <span className="elfe-sample-empty">(not found)</span>
                        : <span className="elfe-sample-val">{truncate(String(sample), 140)}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function normaliseFields(value) {
  if (!value || typeof value !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v == null) continue;
    if (typeof v === "string") {
      out[k] = { selector: v, kind: "text", attribute: null };
    } else if (typeof v === "object") {
      const kind = v.kind === "attr" || v.kind === "attribute" ? "attr"
                 : v.kind === "html" ? "html"
                 : "text";
      out[k] = {
        selector: typeof v.selector === "string" ? v.selector : "",
        kind,
        attribute: kind === "attr" && typeof v.attribute === "string" ? v.attribute : null,
      };
    }
  }
  return out;
}

function pickSpec(f) {
  return {
    selector: typeof f.selector === "string" ? f.selector : "",
    kind:     f.kind === "attr" || f.kind === "html" ? f.kind : "text",
    attribute: f.kind === "attr" && typeof f.attribute === "string" ? f.attribute : null,
  };
}

function sanitiseFieldName(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, "")
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function uniqueName(base, existing) {
  const safe = sanitiseFieldName(base) || "field";
  if (!existing[safe]) return safe;
  for (let i = 2; i < 1000; i++) {
    const cand = `${safe}_${i}`;
    if (!existing[cand]) return cand;
  }
  return `${safe}_${Math.random().toString(36).slice(2, 6)}`;
}

function formatAiError(payload) {
  if (!payload) return "Unknown AI error";
  const code = payload.code || "";
  switch (code) {
    case "NO_API_KEY":
      return "AI is not configured on the server (set LLM_API_KEY). You can still add fields manually.";
    case "NO_SELECTOR":
      return "Container selector is empty.";
    case "NO_PAGE":
      return "No active browser page — navigate to the target URL first.";
    case "NO_SAMPLE":
      return payload.error || "No matching element on the live page.";
    case "BAD_JSON":
    case "BAD_FIELDS":
      return "The AI didn't return a usable suggestion. Try a more specific hint and re-run.";
    case "LLM_FAIL":
    default:
      return payload.error || `AI request failed (${code || "unknown"}).`;
  }
}

function truncate(s, n) {
  if (s == null) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

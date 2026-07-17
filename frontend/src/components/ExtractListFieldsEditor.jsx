import React, { useEffect, useMemo, useRef, useState } from "react";
import TransformPipelineEditor from "./TransformPipelineEditor";
import { hasPipeline } from "../workflow/fieldTransforms";

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
  pickActive = false,
  onStartPick,
  onStopPick,
  onName,            // (titleCaseName) → set the step label (no-op if already named)
  aiBusyExternal = false, // an AI request started elsewhere (inspector) is in flight for this step
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

  // ── Browser-pick state ────────────────────────────────────────────────
  // pickActive is owned by the parent (lifted to AppShell so the mode
  // survives the Workflow → Live Browser tab switch). We only keep the
  // transient pending-pick + name here.
  const [pendingPick, setPendingPick] = useState(null); // field info from browser
  const [pickName, setPickName]       = useState("");
  // Extractable choices for the pending pick (text / attributes / html) and
  // the one currently selected. Clicking a link doesn't always mean "give me
  // the href" — the user decides what to extract before confirming.
  const [pickOptions, setPickOptions] = useState([]);
  const [pickOption,  setPickOption]  = useState(null);
  // True once the user typed in the name input — stop auto-suggesting then.
  const pickNameEditedRef             = useRef(false);
  // Which field's clean/split pipeline editor is expanded.
  const [openClean, setOpenClean]     = useState(null);
  const pickNameRef                   = useRef(null);
  const pickActiveRef                 = useRef(pickActive);
  useEffect(() => { pickActiveRef.current = pickActive; }, [pickActive]);
  // Clear any stale pending-pick card when picking is turned off.
  useEffect(() => { if (!pickActive) setPendingPick(null); }, [pickActive]);

  // Listen for the AI response from the backend.
  useEffect(() => {
    if (!socket) return;
    const onResult = (payload) => {
      // Only handle responses to OUR request — other requesters (e.g. the
      // element inspector's "Add with AI prompt") apply their own results;
      // processing them here too would double-merge the fields.
      if (payload.requestId !== pendingRequestId.current) return;
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
      // Auto-name the whole Extract List step with the AI's Title Case table
      // name ("Product Listings"), so the user doesn't have to. The parent
      // only applies it when the step isn't already named.
      if (payload.name && typeof onName === "function") onName(payload.name);
      // Count where each field came from (ai vs heuristic vs rescued AI)
      // so the user can tell when the LLM failed, when a fallback kicked
      // in, and when the AI's intent was salvaged with the heuristic's
      // working selector.
      const heurCount   = fields.filter(f => f.source === 'heuristic').length;
      const rescueCount = fields.filter(f => f.source === 'ai+heuristic').length;
      const aiCount     = fields.filter(f => f.source === 'ai').length + rescueCount;
      setAiNote({
        explanation: payload.explanation || "",
        count: fields.length,
        sampleCount: payload.sampleCount || 0,
        verifyError: payload.verificationError || null,
        aiCount, heurCount, rescueCount,
        source: payload.source || (heurCount > 0 && aiCount === 0 ? 'heuristic' : 'ai'),
        aiError: payload.aiOk === false ? (payload.aiError || `(${payload.aiCode || 'AI failed'})`) : null,
      });
      setAiRejected(dropped);
      setAiError(null);
    };
    socket.on("aiExtractListFieldsResult", onResult);
    return () => socket.off("aiExtractListFieldsResult", onResult);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, normalised, onName]);

  // Listen for field picks from the browser (list-field-pick mode).
  useEffect(() => {
    if (!socket) return;
    const onBrowserEvent = (data) => {
      if (data.type !== 'listFieldPicked') return;
      if (!pickActiveRef.current) return; // not this editor's pick session
      // Build the what-to-extract choices. Older payloads (no options array)
      // degrade to a single choice — the inferred default.
      const options = Array.isArray(data.options) && data.options.length
        ? data.options
        : [{ kind: data.kind || 'text', attribute: data.attribute || null, sample: data.sampleValue }];
      const defKind = data.kind || 'text';
      const defAttr = data.attribute || null;
      const def = options.find(o => (o.kind || 'text') === defKind && (o.attribute || null) === defAttr) || options[0];
      setPendingPick(data);
      setPickOptions(options);
      setPickOption(def);
      pickNameEditedRef.current = false;
      setPickName(uniqueName(sanitiseFieldName(data.suggestedName || data.tag || "field"), normalised));
      setTimeout(() => { pickNameRef.current?.focus(); pickNameRef.current?.select(); }, 40);
    };
    socket.on("browserEvent", onBrowserEvent);
    return () => socket.off("browserEvent", onBrowserEvent);
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

  // Persist a field's clean/split pipeline. Undefined values are dropped so a
  // field with no transforms stays a plain { selector, kind, attribute }.
  const setPipeline = (name, { transforms, split }) => {
    const spec = { ...normalised[name] };
    if (transforms && transforms.length) spec.transforms = transforms; else delete spec.transforms;
    if (split) spec.split = split; else delete spec.split;
    onChange({ ...normalised, [name]: spec });
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

  // ── Browser-pick handlers ─────────────────────────────────────────────
  // Start/stop are owned by the parent (AppShell): it flips the live-browser
  // tab into view, keeps this editor mounted, and toggles the page-side mode.
  const startPicking = () => {
    if (!containerSelector) return;
    setPendingPick(null);
    onStartPick && onStartPick(serialiseMarkerFields(normalised));
  };

  // While picking, keep the on-page "already captured" markers in sync with
  // the field list (confirming a pick, renaming or deleting a field all
  // update the badges on every container item immediately).
  useEffect(() => {
    if (!socket || !pickActive) return;
    socket.emit("updateListFieldMarkers", { fields: serialiseMarkerFields(normalised) });
  }, [socket, pickActive, normalised]);

  const stopPicking = () => {
    setPendingPick(null);
    onStopPick && onStopPick();
  };

  // Switch what the pending pick extracts (text vs a specific attribute vs
  // html). Re-suggests the field name unless the user already typed one.
  const choosePickOption = (opt) => {
    setPickOption(opt);
    if (!pickNameEditedRef.current) {
      setPickName(uniqueName(suggestNameForOption(opt, pendingPick), normalised));
    }
  };

  const confirmPickedField = () => {
    if (!pendingPick) return;
    const opt = pickOption
      || { kind: pendingPick.kind || "text", attribute: pendingPick.attribute || null, sample: pendingPick.sampleValue };
    const raw  = sanitiseFieldName(pickName) || sanitiseFieldName(pendingPick.suggestedName) || "field";
    const name = uniqueName(raw, normalised);
    const spec = {
      // An option can target a different element than the one clicked (e.g.
      // the enclosing <a> for its href) — then it carries its own selector.
      // '' is valid and means "the container element itself".
      selector:  typeof opt.selector === "string" ? opt.selector : pendingPick.relativeSelector,
      kind:      opt.kind === "attr" || opt.kind === "html" ? opt.kind : "text",
      attribute: opt.kind === "attr" ? (opt.attribute || null) : null,
    };
    onChange({ ...normalised, [name]: spec });
    setAiSamples(prev => ({ ...prev, [name]: opt.sample ?? pendingPick.sampleValue ?? null }));
    setPendingPick(null);
    setPickName("");
    // Stay in pick mode so the user can keep picking more fields.
  };

  // ── Render ────────────────────────────────────────────────────────────
  const fieldNames = Object.keys(normalised);

  return (
    <div className="elfe-root">
      {/* AI request kicked off from the element inspector is still running —
          fields will appear here the moment it answers. */}
      {aiBusyExternal && (
        <div className="elfe-ai-external-busy">
          <span className="elfe-ai-spinner" />
          ✨ AI is analysing a sample item and detecting fields… they'll appear below shortly.
        </div>
      )}

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
          <div className="elfe-fields-header-btns">
            <button
              type="button"
              className={`elfe-btn ${pickActive ? "elfe-btn--pick-active" : "elfe-btn--pick"}`}
              onClick={pickActive ? stopPicking : startPicking}
              disabled={!containerSelector}
              title={!containerSelector ? "Set a container selector first" : "Click elements inside the containers to add them as fields"}
            >
              {pickActive ? "× Stop picking" : "🎯 Pick from page"}
            </button>
            <button type="button" className="elfe-btn elfe-btn--ghost" onClick={addBlankField}>+ Add field</button>
          </div>
        </div>

        {/* Pick-mode instruction banner */}
        {pickActive && !pendingPick && (
          <div className="elfe-pick-banner">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>
              <line x1="12" y1="3" x2="12" y2="1"/><line x1="12" y1="21" x2="12" y2="23"/>
              <line x1="3" y1="12" x2="1" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
            </svg>
            <span className="elfe-pick-banner-text">
              Click any element <strong>inside</strong> the highlighted containers on the page — it will be added as a field here.
            </span>
          </div>
        )}

        {/* Pending pick — choose what to extract, name it, confirm */}
        {pendingPick && (
          <div className="elfe-pick-pending">
            <div className="elfe-pick-meta">
              <span className="elfe-pick-tag-name">&lt;{pendingPick.tag || "el"}&gt;</span>
              <code className="elfe-pick-sel">
                {typeof pickOption?.selector === "string"
                  ? (pickOption.selector || "(the item itself)")
                  : pendingPick.relativeSelector}
              </code>
            </div>
            {pickOptions.length > 1 && (
              <div className="elfe-pick-options">
                <span className="elfe-pick-opt-label">Extract:</span>
                <div className="elfe-pick-opt-chips">
                  {pickOptions.map((o, i) => {
                    const selected = pickOption === o;
                    return (
                      <button
                        key={i}
                        type="button"
                        className={`elfe-pick-opt ${o.kind}${selected ? " is-selected" : ""}`}
                        onClick={() => choosePickOption(o)}
                        title={(o.fromAncestor ? "From the enclosing link. " : "")
                          + (o.sample ? `Sample: ${truncate(o.sample, 120)}` : "No value in the clicked item")}
                      >
                        {o.kind === "text" ? "text" : o.kind === "html" ? "HTML" : `@${o.attribute}`}
                        {o.fromAncestor ? " ↖" : ""}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="elfe-pick-sample-row">
              <span className={`elfe-pick-kind-tag ${pickOption?.kind || pendingPick.kind || "text"}`}>
                {pickOption?.kind === "attr" ? `@${pickOption.attribute}`
                  : pickOption?.kind === "html" ? "HTML" : "text"}
              </span>
              <span className="elfe-pick-sample-val">
                {pickOption?.sample ? truncate(pickOption.sample, 90) : <em>(empty in the clicked item)</em>}
              </span>
            </div>
            <div className="elfe-pick-name-row">
              <span className="elfe-pick-name-label">Field name:</span>
              <input
                ref={pickNameRef}
                className="elfe-pick-name-input"
                value={pickName}
                onChange={e => { pickNameEditedRef.current = true; setPickName(e.target.value); }}
                onKeyDown={e => {
                  if (e.key === "Enter") confirmPickedField();
                  if (e.key === "Escape") setPendingPick(null);
                }}
                placeholder="field_name"
                spellCheck={false}
              />
              <button type="button" className="elfe-btn elfe-btn--primary elfe-pick-confirm-btn" onClick={confirmPickedField}>
                Add
              </button>
              <button type="button" className="elfe-btn elfe-pick-discard-btn" onClick={() => setPendingPick(null)} title="Discard this pick">
                ✕
              </button>
            </div>
            {pendingPick.worksInSiblings === false && (
              <div className="elfe-pick-warn">
                ⚠ This selector may not resolve in all containers — review and adjust the selector if needed.
              </div>
            )}
          </div>
        )}

        {fieldNames.length === 0 ? (
          <div className="elfe-empty">
            No fields yet. Click <strong>Auto-detect fields</strong> above, <strong>pick from page</strong>, or add one manually.
          </div>
        ) : (
          <div className="elfe-rows">
            {fieldNames.map(name => {
              const f = normalised[name];
              const sample = aiSamples[name];
              return (
                <div key={name} className="elfe-row">
                  {/* Row header: name grows/shrinks, controls stay pinned right
                      so nothing wraps awkwardly at narrow widths. */}
                  <div className="elfe-row-top">
                    <FieldNameInput name={name} onRename={renameField} />
                    <select
                      className="elfe-kind"
                      value={f.kind}
                      onChange={e => updateField(name, { kind: e.target.value })}
                      title="What to extract from the matched element"
                    >
                      <option value="text">text</option>
                      <option value="attr">attribute</option>
                      <option value="html">innerHTML</option>
                    </select>
                    <button
                      type="button"
                      className={`elfe-clean-toggle ${hasPipeline(f) ? "is-active" : ""} ${openClean === name ? "is-open" : ""}`}
                      onClick={() => setOpenClean(openClean === name ? null : name)}
                      title="Clean / split this field"
                    >
                      ✨<span className="elfe-clean-word"> Clean</span>{hasPipeline(f) ? " ●" : ""}
                    </button>
                    <button
                      type="button"
                      className="elfe-row-remove"
                      onClick={() => removeField(name)}
                      title="Remove this field"
                    >×</button>
                  </div>
                  {f.kind === "attr" && (
                    <input
                      className="elfe-attr"
                      value={f.attribute || ""}
                      placeholder="attribute name — href / src / data-id"
                      onChange={e => updateField(name, { attribute: e.target.value })}
                    />
                  )}
                  <input
                    className="elfe-selector"
                    value={f.selector || ""}
                    placeholder="CSS selector relative to the container, e.g. .price"
                    onChange={e => updateField(name, { selector: e.target.value })}
                  />
                  {openClean === name && (
                    <div className="elfe-clean-panel">
                      <TransformPipelineEditor
                        fieldName={name}
                        transforms={f.transforms}
                        split={f.split}
                        sample={sample}
                        onChange={(pipeline) => setPipeline(name, pipeline)}
                      />
                    </div>
                  )}
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

/* ── FieldNameInput — local state so the user can actually type ───────── */

function FieldNameInput({ name, onRename }) {
  const [val, setVal] = useState(name);
  // Sync if the parent committed a rename that changed the key
  useEffect(() => { setVal(name); }, [name]);
  return (
    <input
      className="elfe-name"
      value={val}
      onChange={e => setVal(e.target.value)}
      onBlur={() => onRename(name, val)}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
      title="Field name (snake_case)"
    />
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
      // Preserve the per-field clean/split pipeline so it survives edits.
      if (Array.isArray(v.transforms) && v.transforms.length) out[k].transforms = v.transforms;
      if (v.split && typeof v.split === "object")             out[k].split = v.split;
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

// Flatten the fields map into what the page-side marker painter needs.
function serialiseMarkerFields(map) {
  return Object.entries(map || {}).map(([name, f]) => ({
    name,
    selector:  f.selector || "",
    kind:      f.kind || "text",
    attribute: f.attribute || null,
  }));
}

// Suggest a field name for a pick option — mirrors the injected script's
// heuristics so switching options re-suggests something sensible.
function suggestNameForOption(opt, pick) {
  if (opt?.kind === "attr" && opt.attribute) {
    if (opt.attribute === "href") return "link";
    if (opt.attribute === "src" || opt.attribute === "srcset") return "image";
    return opt.attribute.replace(/-/g, "_");
  }
  // text / html — reuse the page's suggestion when it was text-based,
  // otherwise fall back to tag semantics.
  if (pick && (pick.kind || "text") === "text" && pick.suggestedName) return pick.suggestedName;
  const semantics = { h1: "title", h2: "title", h3: "title", h4: "subtitle",
                      p: "description", time: "date", span: "value",
                      img: "image", a: "link", button: "button" };
  return semantics[pick?.tag] || pick?.tag || "field";
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

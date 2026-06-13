'use strict';

const llm        = require('./llm.service');
const verify     = require('./healingVerify');
const validators = require('./healingValidators');
const PARSE      = require('./llmJson');

/* ===========================================================================
   healing.service
   ---------------------------------------------------------------------------
   The brain of self-healing. Given a broken extraction step, its captured
   page snapshot, and what it *used* to extract, it stages a repair:

     1. ANALYSE  — is a fix possible at all, or has the data genuinely gone /
                   the page changed beyond a selector swap? (AI, advisory)
     2. REPAIR   — for a list: fix the WHOLE-LIST selector first (often the
                   container is fine and only inner item selectors moved),
                   then fix each item field one-by-one. The LLM only proposes;
                   every candidate is VERIFIED against the real snapshot DOM
                   and its sample values are judged by deterministic, AI-free
                   validators before being accepted.
     3. DECIDE   — a field whose data has disappeared is dropped (the rest of
                   the step is kept); if nothing can be safely verified, we
                   refuse to guess and escalate to manual review.

   The pipeline owns the end-to-end re-run + commit policy; this service owns
   the per-selector analysis and returns a fully-verified proposal (or a
   "manual" verdict) — it never mutates the saved workflow itself.

   Public API:
     healStep({ step, verdict, snapshotHtml, pageUrl, historySamples, log })
       → see OUTCOME shapes below.
   ========================================================================= */

const MIN_LIST_CONTAINERS = 2;   // a "list" should match at least this many
const FIELD_SAMPLE_SIZE   = 8;   // containers surveyed per field
const STRONG_VALID_RATE   = 0.8; // fill/validity needed for "high" confidence

/* OUTCOME shapes returned to the pipeline:

   { outcome: 'patch',  newParams, droppedFields:[name], confidence, explanation, evidence }
       Apply newParams to the step (list → container + fields rewritten;
       single → selector rewritten). For FOR_EACH_ELEMENTS, newParams carries
       a `__childPatches` map and `__dropChildIds` list the pipeline applies.

   { outcome: 'remove-step', reason, explanation }
       The step's target genuinely disappeared and nothing remains to extract.

   { outcome: 'manual', reason, explanation, evidence }
       No fix could be verified safely — escalate to the user.
*/

async function healStep(args) {
  const { step } = args;
  if (!step || !step.type) return manual('no step to heal', 'No step information was available.');
  if (!llm.isConfigured()) return manual('LLM not configured', 'AI assistance is unavailable (set LLM_API_KEY).', 'NO_API_KEY');
  if (!args.snapshotHtml) return manual('no snapshot', 'No page snapshot was captured at the time of failure, so the page could not be analysed.');

  // EXTRACT_TABLE is collection-shaped (its records are rows) but it has no
  // per-row container/field selectors we can verify the way a list does — a
  // single-selector swap can't be checked for "is this actually a table with
  // rows", so a wrong guess could be wrongly marked "verified". Per the
  // notify-don't-mis-repair principle, escalate tables to manual review.
  if (step.type === 'EXTRACT_TABLE') {
    return manual('table repair not supported',
      'This table captured no rows. Automatic table repair is not supported — re-select the table in the editor. The platform will not guess a table selector, to avoid capturing the wrong data.');
  }

  const shape = normalizeListShape(step);
  if (shape.isList) return healList({ ...args, shape });
  return healSingle(args);
}

/* =========================================================================
   LIST HEALING (EXTRACT_LIST + FOR_EACH_ELEMENTS)
   ========================================================================= */

async function healList(args) {
  const { shape, snapshotHtml, historySamples, verdict, log = noop } = args;

  return withSnapshotOrManual(snapshotHtml, async (page) => {
    const evidence = { container: null, fields: {} };

    // ── Step 1: the whole-list selector first ──────────────────────────────
    let containerSelector = shape.containerSelector;
    let containerType     = shape.selectorType || 'css';

    let cont = await verify.verifyContainerSelector(page, {
      selector: containerSelector, type: containerType, minCount: MIN_LIST_CONTAINERS,
    });
    log(`  · list selector "${truncate(containerSelector, 80)}" → ${cont.count} match(es)`);

    if (!cont.ok) {
      // Container moved — ask the LLM for candidates and verify each in order.
      const proposed = await proposeContainerSelectors({
        snapshotHtml, current: containerSelector, fields: shape.fields, label: shape.label,
      });
      if (!proposed.ok) {
        return manual('list selector unrecoverable',
          `The list no longer matches and no replacement could be proposed (${proposed.error || 'AI unavailable'}).`,
          proposed.code, evidence);
      }
      let chosen = null;
      for (const cand of proposed.selectors) {
        const v = await verify.verifyContainerSelector(page, { selector: cand.value, type: cand.type || 'css', minCount: MIN_LIST_CONTAINERS });
        log(`  · candidate list selector "${truncate(cand.value, 80)}" → ${v.count} match(es)`);
        if (v.ok) { chosen = { value: cand.value, type: cand.type || 'css', count: v.count }; break; }
      }
      if (!chosen) {
        return manual('list selector unrecoverable',
          'The list structure changed too much: none of the proposed replacement selectors matched a repeating group on the page. Manual review needed.',
          undefined, evidence);
      }
      containerSelector = chosen.value;
      containerType     = chosen.type;
      cont = { ok: true, count: chosen.count };
    }
    evidence.container = { selector: containerSelector, type: containerType, count: cont.count, changed: containerSelector !== shape.containerSelector };

    // ── Step 2: each item field, one by one ────────────────────────────────
    const keptFields    = [];   // resolved field specs (possibly remapped)
    const droppedFields = [];   // genuinely-disappeared fields we removed
    const manualFields  = [];   // present-but-unverifiable: left as-is, flagged
    let   verifiedCount = 0;     // fields we could actually confirm (kept or remapped)
    let   anyLowConfidence = false;

    // Which fields does the runtime say were empty across all rows? Those are
    // the ones to repair. Fields not flagged are assumed fine, but we still
    // re-verify them against the (possibly new) container to be safe.
    const brokenSet = new Set(verdict && verdict.brokenFields ? verdict.brokenFields : []);

    // Verify all current field selectors against the (new) container at once.
    const baseline = await verify.verifyListFields(page, {
      containerSelector, type: containerType, fields: shape.fields, sampleSize: FIELD_SAMPLE_SIZE,
    });
    if (baseline.error) {
      return manual('verification failed', `Could not verify item fields: ${baseline.error}`, undefined, evidence);
    }

    for (const field of shape.fields) {
      const rec = baseline.fields[field.name] || { samples: [], hitCount: 0, surveyed: 0 };
      const judged = validators.assessFieldSamples(field, rec.samples);
      evidence.fields[field.name] = { selector: rec.selector ?? field.selector, quality: judged.quality, presence: judged.presence, reasons: judged.reasons, changed: false };

      const stillWorks = judged.ok && (!brokenSet.has(field.name));

      if (stillWorks) {
        keptFields.push({ ...field, selector: rec.rescuedToSelf ? '' : rec.selector });
        verifiedCount++;
        continue;
      }

      // This field needs attention — propose a replacement relative selector.
      const repaired = await repairField({
        page, containerSelector, containerType, field,
        sampleHtml: await firstContainerHtml(page, containerSelector, containerType),
        historySamples: historySamples && historySamples[field.name],
        log,
      });

      if (repaired.outcome === 'remap') {
        keptFields.push({ ...field, selector: repaired.selector, kind: repaired.kind || field.kind, attribute: repaired.attribute ?? field.attribute });
        evidence.fields[field.name] = { selector: repaired.selector, quality: repaired.quality, presence: repaired.presence, reasons: [], changed: true };
        verifiedCount++;
        if (repaired.quality < STRONG_VALID_RATE) anyLowConfidence = true;
      } else if (repaired.outcome === 'drop') {
        droppedFields.push(field.name);
        evidence.fields[field.name] = { selector: null, quality: 0, presence: 0, reasons: ['disappeared'], dropped: true };
        log(`  · field "${field.name}" appears to have disappeared — dropping it (keeping the rest).`);
      } else {
        // Ambiguous — data may still be present but we can't verify a safe
        // selector. Do NOT guess and do NOT sink the whole step: keep the
        // field's CURRENT selector (it returns empty, never the WRONG value)
        // and flag it for the user to finish by hand. Everything we could
        // verify is still healed and will capture data.
        keptFields.push({ ...field });
        manualFields.push(field.name);
        evidence.fields[field.name] = { selector: field.selector, quality: 0, presence: 0, reasons: ['unverifiable'], manual: true };
        anyLowConfidence = true;
        log(`  · field "${field.name}" could not be safely re-mapped — left unchanged and flagged for manual review (the rest of the step is still healed).`);
      }
    }

    if (keptFields.length === 0) {
      return removeStepOutcome('all item fields disappeared',
        'Every field this list extracted has disappeared from the page; the step can no longer collect anything.');
    }
    if (verifiedCount === 0) {
      // The list was found again, but not a SINGLE field could be verified —
      // capturing rows of empty values isn't useful and isn't safe to trust.
      return manual('no fields verifiable',
        'The list was located again but none of its item fields could be verified against the page. Manual review needed.',
        undefined, evidence);
    }

    // Confidence is high only when the container is intact (or cleanly
    // re-found), every kept field validated well, and nothing was left for
    // manual review. Any unresolved field forces a proposal (medium) so the
    // fix is never auto-written to the saved workflow.
    const confidence = (manualFields.length === 0 && !anyLowConfidence && cont.count >= MIN_LIST_CONTAINERS) ? 'high' : 'medium';
    const explanation = buildListExplanation({ evidence, droppedFields, manualFields, confidence });

    return {
      outcome: 'patch',
      newParams: buildListParams(args.step, shape, { containerSelector, containerType, keptFields, droppedFields }),
      droppedFields,
      manualFields,
      confidence,
      explanation,
      evidence,
    };
  }, args);
}

// Verify a single field, proposing & checking replacement selectors. Returns
// { outcome:'remap', selector, kind, attribute, validRate } |
// { outcome:'drop' } | { outcome:'ambiguous' }.
async function repairField({ page, containerSelector, containerType, field, sampleHtml, historySamples, log }) {
  const proposal = await proposeFieldSelector({ sampleHtml, field, historySamples });
  if (proposal.ok) {
    for (const cand of proposal.candidates) {
      const fieldSpec = { name: field.name, selector: cand.selector, kind: cand.kind || field.kind, attribute: cand.attribute ?? field.attribute };
      const v = await verify.verifyListFields(page, {
        containerSelector, type: containerType, fields: [fieldSpec], sampleSize: FIELD_SAMPLE_SIZE,
      });
      const rec = v.fields && v.fields[field.name];
      if (!rec) continue;
      const judged = validators.assessFieldSamples(fieldSpec, rec.samples);
      log(`  · field "${field.name}" candidate "${truncate(cand.selector, 60)}" → quality ${judged.quality.toFixed(2)} presence ${judged.presence.toFixed(2)}`);
      if (judged.ok) {
        return { outcome: 'remap', selector: rec.rescuedToSelf ? '' : cand.selector, kind: fieldSpec.kind, attribute: fieldSpec.attribute, quality: judged.quality, presence: judged.presence };
      }
    }
  }
  // No candidate validated. If the model judged the field absent from the
  // sample item, treat it as a clean drop; otherwise it's ambiguous.
  if (proposal.ok && proposal.disappeared) return { outcome: 'drop' };
  if (!proposal.ok && proposal.code === 'DISAPPEARED') return { outcome: 'drop' };
  return { outcome: 'ambiguous' };
}

/* =========================================================================
   SINGLE-ELEMENT HEALING (EXTRACT_TEXT / ATTRIBUTE / HTML / TABLE)
   ========================================================================= */

async function healSingle(args) {
  const { step, snapshotHtml, historySamples, log = noop } = args;
  const params = step.params || {};
  const kind = singleKind(step.type);
  const attribute = step.type === 'EXTRACT_ATTRIBUTE' ? (params.attribute || null) : null;

  return withSnapshotOrManual(snapshotHtml, async (page) => {
    const proposal = await proposeSingleSelector({
      snapshotHtml, step, historySamples,
    });
    if (!proposal.ok) {
      if (proposal.code === 'DISAPPEARED') {
        return removeStepOutcome('element disappeared', `The element "${step.label || step.type}" is no longer present on the page.`);
      }
      return manual('no proposal', `Could not propose a replacement selector (${proposal.error || 'AI unavailable'}).`, proposal.code);
    }

    for (const cand of proposal.candidates) {
      const v = await verify.verifySingleSelector(page, { selector: cand.selector, type: cand.type || 'css', kind, attribute });
      if (!v.ok) continue;
      const judged = validators.validateValue({ name: step.label || step.type, kind, attribute }, v.sampleValue);
      log(`  · "${step.label || step.type}" candidate "${truncate(cand.selector, 60)}" → ${v.count} match, value ${judged.ok ? 'OK' : 'rejected: ' + judged.reason}`);
      if (judged.ok) {
        const confidence = (cand.type === 'css' && v.count === 1) ? 'high' : 'medium';
        return {
          outcome: 'patch',
          newParams: { selector: cand.selector, selectorType: cand.type || 'css', fallbackSelectors: candidateFallbacks(proposal.candidates, cand) },
          droppedFields: [],
          confidence,
          explanation: `Re-pointed "${step.label || step.type}" to "${cand.selector}" (verified it resolves and returns a sensible value).`,
          evidence: { single: { selector: cand.selector, count: v.count, sampleValue: truncate(v.sampleValue, 120) } },
        };
      }
    }

    if (proposal.disappeared) {
      return removeStepOutcome('element disappeared', `The element "${step.label || step.type}" appears to have been removed from the page.`);
    }
    return manual('no verifiable selector',
      `Proposed selectors for "${step.label || step.type}" did not resolve to a sensible value. Refusing to guess — manual review needed.`);
  }, args);
}

/* =========================================================================
   LLM PROPOSALS
   ========================================================================= */

async function proposeContainerSelectors({ snapshotHtml, current, fields, label }) {
  const sys = [
    'You repair a broken web-scraping list selector. The page HTML changed and the previous container selector no longer matches the repeating items.',
    'Return ONE JSON object only: {"selectors":[{"value":"<css>","type":"css"}],"confidence":"high|medium|low"}.',
    'Each selector must match the REPEATING ITEM container (multiple sibling items), not a single element. Prefer stable anchors (data-*, semantic tags, classes); avoid hashed/random class names. Provide 1-4 candidates best-first.',
  ].join('\n');
  const user = [
    `Previous (now broken) list/container selector: ${current || '(none)'}`,
    label ? `List label: ${label}` : '',
    fields && fields.length ? `Item fields previously extracted: ${fields.map(f => f.name).join(', ')}` : '',
    '',
    'Current page HTML (scripts/styles removed):',
    '```html', truncate(snapshotHtml, 42000), '```',
    '',
    'Return the JSON object only.',
  ].filter(Boolean).join('\n');

  const res = await llm.safeChat({ system: sys, user, temperature: 0.1, maxTokens: 500, timeoutMs: 30000 });
  if (!res.ok) return { ok: false, error: res.error, code: res.code };
  const obj = PARSE.parse(res.text);
  const arr = obj && Array.isArray(obj.selectors) ? obj.selectors : null;
  if (!arr) return { ok: false, error: 'no selectors in AI output', code: 'BAD_JSON' };
  const selectors = arr
    .map(s => (typeof s === 'string' ? { value: s, type: 'css' } : s))
    .filter(s => s && typeof s.value === 'string' && s.value.trim())
    .map(s => ({ value: s.value.trim(), type: s.type === 'xpath' ? 'xpath' : 'css' }))
    .slice(0, 5);
  if (!selectors.length) return { ok: false, error: 'no usable selectors', code: 'BAD_JSON' };
  return { ok: true, selectors, confidence: obj.confidence };
}

async function proposeFieldSelector({ sampleHtml, field, historySamples }) {
  const sys = [
    'You repair ONE broken field selector inside a repeating list item. You are given the CURRENT HTML of one sample item.',
    'Return ONE JSON object only: {"candidates":[{"selector":"<css relative to item>","kind":"text|attr|html","attribute":"<only if attr>"}],"disappeared":true|false,"confidence":"high|medium|low"}.',
    'Selectors are CSS relative to the item (never start with html/body). Use "" to read from the item element itself. If the value clearly no longer exists in this item, set "disappeared":true and return an empty candidates array.',
    'Avoid hashed/random class names. Provide 1-3 candidates best-first.',
  ].join('\n');
  const hist = Array.isArray(historySamples) && historySamples.length
    ? `\nThis field PREVIOUSLY contained values like: ${historySamples.slice(0, 4).map(v => JSON.stringify(truncate(String(v), 60))).join(', ')}`
    : '';
  const user = [
    `Field to repair: name="${field.name}" kind="${field.kind || 'text'}"${field.attribute ? ` attribute="${field.attribute}"` : ''}`,
    `Previous (now empty) selector: ${field.selector || '(the item itself)'}`,
    hist,
    '',
    'Sample item HTML:',
    '```html', truncate(sampleHtml || '', 16000), '```',
    '',
    'Return the JSON object only.',
  ].join('\n');

  const res = await llm.safeChat({ system: sys, user, temperature: 0.1, maxTokens: 400, timeoutMs: 30000 });
  if (!res.ok) return { ok: false, error: res.error, code: res.code };
  const obj = PARSE.parse(res.text);
  if (!obj) return { ok: false, error: 'bad JSON', code: 'BAD_JSON' };
  if (obj.disappeared === true && (!Array.isArray(obj.candidates) || obj.candidates.length === 0)) {
    return { ok: false, code: 'DISAPPEARED', disappeared: true };
  }
  const candidates = (Array.isArray(obj.candidates) ? obj.candidates : [])
    .filter(c => c && typeof c.selector === 'string')
    .map(c => ({
      selector: cleanRelative(c.selector),
      kind: c.kind === 'attr' || c.kind === 'attribute' ? 'attr' : c.kind === 'html' ? 'html' : 'text',
      attribute: typeof c.attribute === 'string' ? c.attribute.trim() : null,
    }))
    .slice(0, 4);
  if (!candidates.length) return { ok: false, error: 'no candidates', code: 'NO_CANDIDATES', disappeared: !!obj.disappeared };
  return { ok: true, candidates, disappeared: !!obj.disappeared };
}

async function proposeSingleSelector({ snapshotHtml, step, historySamples }) {
  const sys = [
    'You repair a broken selector for a single extraction step in a web-scraping workflow. The page HTML changed and the previous selector no longer matches.',
    'Return ONE JSON object only: {"candidates":[{"selector":"<css>","type":"css"}],"disappeared":true|false,"confidence":"high|medium|low"}.',
    'If the target element clearly no longer exists on the page, set "disappeared":true with an empty candidates array. Prefer stable anchors; avoid hashed/random classes. 1-4 candidates best-first.',
  ].join('\n');
  const hist = Array.isArray(historySamples) && historySamples.length
    ? `\nThis step PREVIOUSLY extracted values like: ${historySamples.slice(0, 4).map(v => JSON.stringify(truncate(String(v), 60))).join(', ')}`
    : '';
  const p = step.params || {};
  const user = [
    `Step: ${step.type}${step.label ? ` (label "${step.label}")` : ''}`,
    `Previous (broken) selector: ${p.selector || '(none)'}`,
    step.type === 'EXTRACT_ATTRIBUTE' ? `Attribute extracted: ${p.attribute || ''}` : '',
    hist,
    '',
    'Current page HTML (scripts/styles removed):',
    '```html', truncate(snapshotHtml, 42000), '```',
    '',
    'Return the JSON object only.',
  ].filter(Boolean).join('\n');

  const res = await llm.safeChat({ system: sys, user, temperature: 0.1, maxTokens: 500, timeoutMs: 30000 });
  if (!res.ok) return { ok: false, error: res.error, code: res.code };
  const obj = PARSE.parse(res.text);
  if (!obj) return { ok: false, error: 'bad JSON', code: 'BAD_JSON' };
  if (obj.disappeared === true && (!Array.isArray(obj.candidates) || obj.candidates.length === 0)) {
    return { ok: false, code: 'DISAPPEARED', disappeared: true };
  }
  const candidates = (Array.isArray(obj.candidates) ? obj.candidates : [])
    .filter(c => c && typeof c.selector === 'string' && c.selector.trim())
    .map(c => ({ selector: c.selector.trim(), type: c.type === 'xpath' ? 'xpath' : 'css' }))
    .slice(0, 5);
  if (!candidates.length) return { ok: false, error: 'no candidates', code: 'NO_CANDIDATES', disappeared: !!obj.disappeared };
  return { ok: true, candidates, disappeared: !!obj.disappeared };
}

/* =========================================================================
   SHAPE NORMALISATION + PATCH BUILDING
   ========================================================================= */

// Normalise EXTRACT_LIST and FOR_EACH_ELEMENTS into one shape so both heal
// through the same list logic.
function normalizeListShape(step) {
  const p = step.params || {};
  if (step.type === 'EXTRACT_LIST') {
    const rawFields = p.fields || {};
    const fields = Object.entries(rawFields).map(([name, v]) => {
      if (typeof v === 'string') return { name, selector: v, kind: 'text', attribute: null, ref: { kind: 'list-field' } };
      const kind = v && (v.kind === 'attr' || v.kind === 'attribute') ? 'attr' : v && v.kind === 'html' ? 'html' : 'text';
      return { name, selector: (v && v.selector) || '', kind, attribute: kind === 'attr' ? (v && v.attribute) || null : null, ref: { kind: 'list-field' } };
    });
    return { isList: true, type: 'EXTRACT_LIST', label: step.label || '', containerSelector: p.containerSelector || '', selectorType: p.selectorType || 'css', fields };
  }
  if (step.type === 'FOR_EACH_ELEMENTS') {
    // Each extraction child step (label = field name) becomes a "field".
    const fields = [];
    for (const child of step.body || []) {
      if (!child || child.kind === 'control') continue;
      if (!/^EXTRACT_/.test(child.type)) continue;
      const cp = child.params || {};
      const kind = child.type === 'EXTRACT_ATTRIBUTE' ? 'attr' : child.type === 'EXTRACT_HTML' ? 'html' : 'text';
      const sel = cp.selector === ':scope' ? '' : (cp.selector || '');
      fields.push({ name: child.label || child.type, selector: sel, kind, attribute: kind === 'attr' ? (cp.attribute || null) : null, ref: { kind: 'child-step', stepId: child.id } });
    }
    return { isList: true, type: 'FOR_EACH_ELEMENTS', label: step.label || '', containerSelector: p.selector || '', selectorType: 'css', fields };
  }
  return { isList: false };
}

// Build the patch payload the pipeline applies. For EXTRACT_LIST we return a
// full params object (container + fields). For FOR_EACH_ELEMENTS we return a
// directive object the pipeline uses to patch the loop selector + child steps.
function buildListParams(step, shape, { containerSelector, containerType, keptFields, droppedFields }) {
  if (shape.type === 'EXTRACT_LIST') {
    const fields = {};
    for (const f of keptFields) {
      fields[f.name] = f.kind === 'attr'
        ? { selector: f.selector, kind: 'attr', attribute: f.attribute }
        : { selector: f.selector, kind: f.kind };
    }
    return {
      ...(step.params || {}),
      containerSelector,
      selectorType: containerType,
      fields,
    };
  }
  // FOR_EACH_ELEMENTS: directives for the pipeline.
  const childPatches = {};
  for (const f of keptFields) {
    if (f.ref && f.ref.kind === 'child-step') {
      childPatches[f.ref.stepId] = { selector: f.selector || ':scope' };
    }
  }
  const dropChildIds = [];
  for (const name of droppedFields) {
    const f = shape.fields.find(x => x.name === name);
    if (f && f.ref && f.ref.kind === 'child-step') dropChildIds.push(f.ref.stepId);
  }
  return {
    __forEach: true,
    selector: containerSelector,
    __childPatches: childPatches,
    __dropChildIds: dropChildIds,
  };
}

/* =========================================================================
   SMALL HELPERS
   ========================================================================= */

function singleKind(type) {
  return type === 'EXTRACT_ATTRIBUTE' ? 'attr' : type === 'EXTRACT_HTML' ? 'html' : 'text';
}

function candidateFallbacks(all, chosen) {
  return all.filter(c => c !== chosen).slice(0, 3).map(c => ({ value: c.selector, type: c.type || 'css' }));
}

async function firstContainerHtml(page, containerSelector, type) {
  return page.evaluate((sel, t) => {
    const isXPath = t === 'xpath' || sel.startsWith('/') || sel.startsWith('(');
    let first = null;
    try {
      if (isXPath) first = document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      else first = document.querySelector(sel);
    } catch (_) {}
    if (!first) return '';
    const clone = first.cloneNode(true);
    clone.querySelectorAll('script,style,svg,noscript').forEach(n => n.remove());
    let html = clone.outerHTML || '';
    return html.length > 16000 ? html.slice(0, 16000) : html;
  }, containerSelector, type).catch(() => '');
}

function buildListExplanation({ evidence, droppedFields, manualFields, confidence }) {
  const parts = [];
  if (evidence.container && evidence.container.changed) {
    parts.push(`Re-pointed the list selector to "${evidence.container.selector}" (${evidence.container.count} items).`);
  } else if (evidence.container) {
    parts.push(`List selector still matches (${evidence.container.count} items).`);
  }
  const remapped = Object.entries(evidence.fields).filter(([, v]) => v.changed && !v.dropped).map(([k]) => k);
  if (remapped.length) parts.push(`Re-mapped field(s): ${remapped.join(', ')}.`);
  if (droppedFields && droppedFields.length) parts.push(`Dropped disappeared field(s): ${droppedFields.join(', ')}.`);
  if (manualFields && manualFields.length) parts.push(`Left for manual review (couldn't verify a safe selector): ${manualFields.join(', ')}.`);
  parts.push(`Confidence: ${confidence} (verified against the live snapshot DOM).`);
  return parts.join(' ');
}

function cleanRelative(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^[>+~]\s*/, '').replace(/^&\s*/, '').replace(/^(?:html|body)\s+/i, '');
  return s.trim();
}

async function withSnapshotOrManual(html, fn, args) {
  const result = await verify.withSnapshot(html, fn);
  // withSnapshot signals its OWN failure (browser unavailable, bad content)
  // with a bare { error } and no `outcome`. A real verdict from fn always
  // carries `outcome`, so we only treat the former as a manual escalation —
  // never mistake a legitimate outcome that happens to mention an error.
  if (result && result.error && !result.outcome) {
    return manual('verification unavailable', `Could not analyse the page snapshot: ${result.error}`);
  }
  return result;
}

function manual(reason, explanation, code, evidence) {
  return { outcome: 'manual', reason, explanation, code: code || null, evidence: evidence || null };
}
function removeStepOutcome(reason, explanation) {
  return { outcome: 'remove-step', reason, explanation };
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function noop() {}

module.exports = { healStep, normalizeListShape };

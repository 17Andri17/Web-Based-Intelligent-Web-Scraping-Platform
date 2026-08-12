'use strict';

const { RUNTIME_SRC: FIELD_TRANSFORM_RUNTIME, __ftHasPipeline } = require('./fieldTransforms');
const { buildCodegenConsentHelper } = require('../browser/consent');
const { buildCodegenResourceBlockHelper } = require('../browser/resourceBlock');
const { buildCodegenPoolHelper } = require('../browser/pagePool');
const { buildCodegenHttpExtractHelper, httpEligibleSteps } = require('./httpExtract');
const { buildCodegenCaptchaHelper } = require('../browser/captcha');
const { buildCodegenStealthHelper, getProxyLaunchArgs, PROXY_WEBRTC_GUARD_SCRIPT } = require('../browser/stealthCore');

// ─── Extraction action types (steps that produce named data) ──────────────
const EXTRACTION_TYPES = new Set([
  'EXTRACT_TEXT', 'EXTRACT_ATTRIBUTE', 'EXTRACT_HTML',
  'EXTRACT_TABLE', 'EXTRACT_LIST', 'EXTRACT_JSON', 'COLLECT_LIST',
  // Calls the site's own data API (discovered by the API Discovery module)
  // instead of scraping the DOM. Like EXTRACT_JSON it reads structured data,
  // not selectors, so it's excluded from HEALABLE_EXTRACTION_TYPES below.
  'EXTRACT_API',
]);

// Extraction types whose "0 records / empty fields" outcome the self-healing
// pipeline knows how to repair (selector-based). EXTRACT_JSON is excluded: it
// reads structured data, not DOM selectors, so a selector swap can't fix it.
const HEALABLE_EXTRACTION_TYPES = new Set([
  'EXTRACT_TEXT', 'EXTRACT_ATTRIBUTE', 'EXTRACT_HTML', 'EXTRACT_TABLE', 'EXTRACT_LIST',
]);

// ─── Build the JS literal for the selectors array passed to runtime helpers ──
// params must have: selector (string), selectorType ('css'|'xpath'),
//                   fallbackSelectors ([{value,type}] or [string] for back-compat)
function selectorList(params, declaredVars) {
  const primary = {
    value: params.selector || '',
    type:  params.selectorType || 'css',
  };

  const fallbacks = (params.fallbackSelectors || []).map(f => {
    // Support both legacy string format and new {value,type} format
    if (typeof f === 'string') return { value: f, type: 'css' };
    return { value: f.value || '', type: f.type || 'css' };
  });

  const all = [primary, ...fallbacks].filter(s => s.value);
  // Build the array literal manually so any selector that references a
  // workflow variable via {{name}} becomes a template literal at codegen
  // time (instead of being JSON-escaped as plain text). Non-interpolated
  // strings still come out as standard JSON.
  const items = all.map(s =>
    `{ value: ${qStr(s.value, declaredVars)}, type: ${JSON.stringify(s.type)} }`
  );
  return '[' + items.join(', ') + ']';
}

/* ─── Smart-wait lookahead ─────────────────────────────────────────────────
   Which selector should a navigation wait for?

   Every navigation currently uses waitUntil:'load', which blocks until the
   LAST subresource lands — images, fonts, ad iframes — and then extraction
   runs immediately with no wait of its own (there is not one waitForSelector
   in the generated code). That is the worst of both worlds: slow, because it
   waits for bytes nothing reads, and racy, because 'load' firing does not
   mean the data is in the DOM. Some share of the "step captured nothing"
   failures the healing pipeline exists to repair are this race.

   So: navigate on domcontentloaded and wait for the selector the NEXT
   extraction actually uses. Faster and strictly more reliable — but only when
   we can identify that selector with confidence, hence how conservative this
   walk is. No selector found ⇒ the caller keeps waitUntil:'load' exactly as
   before.

   Steps that change the page end the search: waiting on the current page for
   something only a LATER page shows would hang until the timeout. Loop bodies
   that run on the current page are descended into (the extraction after a
   navigation is very often the first step inside a following loop); bodies
   that run on a different page — a subflow, or a For-Each-Row that opens each
   row's link — are not. */
const PAGE_CHANGING_TYPES = new Set([
  'NAVIGATE', 'GO_BACK', 'RELOAD_PAGE', 'OPEN_NEW_TAB', 'SWITCH_TAB',
  'CLICK_ELEMENT', 'SUBMIT_FORM', 'RUN_SUBFLOW', 'PRESS_KEY',
]);

// Loop types whose body executes against the page we just navigated to.
const SAME_PAGE_BODY_TYPES = new Set([
  'FOR_EACH', 'FOR_EACH_ELEMENTS', 'REPEAT', 'WHILE', 'TRY_CATCH', 'IF',
  'PAGINATE_URL', 'PAGINATE_CLICK', 'PAGINATE_SCROLL',
]);

// The selector params an extraction step waits on, by type.
function extractionSelectorParams(step) {
  const p = step.params || {};
  if (step.type === 'EXTRACT_LIST')  return { selector: p.containerSelector, selectorType: p.selectorType, fallbackSelectors: p.fallbackSelectors };
  if (step.type === 'EXTRACT_TABLE') return { selector: p.selector || p.tableSelector, selectorType: p.selectorType, fallbackSelectors: p.fallbackSelectors };
  return { selector: p.selector, selectorType: p.selectorType, fallbackSelectors: p.fallbackSelectors };
}

/**
 * Walk forward from `fromIndex` and return the selector-list literal of the
 * first extraction that will run on the page being navigated to, or null when
 * it can't be determined safely.
 */
function lookaheadExtractionSelectors(steps, fromIndex, declaredVars) {
  const walk = (list, start) => {
    for (let i = start; i < (list || []).length; i++) {
      const s = list[i];
      if (!s || !s.type) continue;

      if (HEALABLE_EXTRACTION_TYPES.has(s.type)) {
        const sp = extractionSelectorParams(s);
        if (!sp.selector || !String(sp.selector).trim()) return null;
        return selectorList(sp, declaredVars);
      }
      // A For-Each-Row that opens a link runs its body on a DIFFERENT page, so
      // its selectors say nothing about the page we just navigated to. (The
      // param is `openUrlField` — see the FOR_EACH_ROW generator.)
      if (s.type === 'FOR_EACH_ROW' && s.params && s.params.openUrlField) return null;
      if (SAME_PAGE_BODY_TYPES.has(s.type) || s.type === 'FOR_EACH_ROW') {
        const inner = walk(s.body, 0);
        if (inner) return inner;
      }
      if (PAGE_CHANGING_TYPES.has(s.type)) return null;
    }
    return null;
  };
  return walk(steps, fromIndex);
}

/* ─── Per-item loop scheduling + resume ────────────────────────────────────
   Shared by the three loops that walk a list of detail pages: RUN_SUBFLOW
   iterate, RUN_SUBFLOW enrich, and FOR_EACH_ROW in link-open mode. */

// Workers for this step. A per-step `advanced.concurrency` beats the workflow
// default, so one heavy loop can be throttled without slowing the rest.
function concurrencyFor(step, ctx) {
  const raw = Number(step && step.advanced && step.advanced.concurrency);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return (ctx.perf && ctx.perf.concurrency) || 1;
}

/**
 * Code that applies a resume payload before a loop runs: restore the rows the
 * previous run captured, then drop the items it already finished.
 *
 * `urlOf` is an expression over `_u` (the list element) yielding the same URL
 * string the loop reports via __iterDone — the two must agree or resume either
 * re-scrapes everything or skips too much.
 */
function resumeSkipCode({ listVar, outVar, stepId, urlOf, pad = '  ' }) {
  if (!stepId) return '';
  return [
    `${pad}{`,
    `${pad}  const _rs = __resumeFor(${JSON.stringify(stepId)});`,
    `${pad}  if (_rs) {`,
    `${pad}    const _seen = new Set(_rs.urls || []);`,
    `${pad}    for (const _rr of (_rs.rows || [])) ${outVar}.push(_rr);`,
    `${pad}    const _before = ${listVar}.length;`,
    `${pad}    ${listVar} = ${listVar}.filter((_u) => !_seen.has(${urlOf}));`,
    `${pad}    console.log('↻ Resume: skipping ' + (_before - ${listVar}.length) + ' already-captured item(s); restored ' + (_rs.rows || []).length + ' row(s).');`,
    `${pad}  }`,
    // Sharding rides the same filter: this run takes only its slice of the
    // list. Applied AFTER resume so a shard can also be resumed.
    `${pad}  {`,
    `${pad}    const _pre = ${listVar}.length;`,
    `${pad}    ${listVar} = ${listVar}.filter((_u) => __inShard(${urlOf}));`,
    `${pad}    if (${listVar}.length !== _pre) console.log('⑃ Shard: handling ' + ${listVar}.length + ' of ' + _pre + ' item(s).');`,
    `${pad}  }`,
    `${pad}}`,
  ].join('\n');
}

// ─── Indent helper ────────────────────────────────────────────────────────
const indent = (code, levels = 1) =>
  code.split('\n').map(line => '  '.repeat(levels) + line).join('\n');

// ─── String / interpolation helpers ──────────────────────────────────────
// q(s) keeps the existing call-site semantics (`JSON.stringify` of a
// string-or-falsy). qStr replaces `{{name}}` (or `{{path.like.this}}`,
// or `{{table[*].column}}`) patterns inside a string param with a JS
// expression — the generator emits a template literal so the references
// resolve at runtime.
//
// Syntax accepted inside {{…}}:
//   {{name}}                   → ${name}
//   {{name.nested.field}}      → ${name.nested.field}
//   {{table[*]}}               → ${(table || [])}
//   {{table[*].column}}        → ${(table || []).map(_x => _x.column)}
//   {{table[*].col.sub}}       → ${(table || []).map(_x => _x.col.sub)}
//
// The `[*]` star says "iterate over the array and take this column from
// each row" — i.e. project a column out of a list-of-objects variable.
//
// IMPORTANT — names may contain spaces. A captured table can be labelled
// "Escape Room Listings" and a column can be "unit price". The runtime
// JS *variable* for such a name is its sanitised identifier
// (`toJsIdent`, e.g. `Escape_Room_Listings`), while runtime object keys
// (columns) keep the exact original text, so a spaced column is read with
// bracket access (`_x["unit price"]`). The parser below resolves both:
//   {{Escape Room Listings}}          → Escape_Room_Listings
//   {{Escape Room Listings[*].link}}  → (Escape_Room_Listings || []).map(_x => _x.link)
//   {{rooms[*].unit price}}           → (rooms || []).map(_x => _x["unit price"])
//
// A `{{…}}` whose contents don't parse as a reference (e.g. it contains
// nested braces) is left as literal text so users aren't accidentally
// interpolating arbitrary braces.
//
// Both helpers escape backticks / existing ${...} sequences so the
// generated code stays well-formed even when the user types tricky text.
const VAR_RX = /\{\{\s*([^{}]+?)\s*\}\}/g;
const IDENT_RX = /^[a-zA-Z_$][\w$]*$/;

// Resolve a variable NAME (the "root" of a reference) to the JS identifier
// it was declared under. Already-valid identifiers are kept verbatim so
// loop variables like `_url` / `item` / `index` (declared literally, NOT
// through toJsIdent) still resolve. Names with spaces / punctuation are
// mapped through toJsIdent — the exact same transform used when the
// captured-output alias / workflow variable was declared.
function rootToIdent(name) {
  const n = String(name).trim();
  return IDENT_RX.test(n) ? n : toJsIdent(n);
}

// Build a member-access chain for a dotted path. Plain-identifier segments
// use dot access; anything else (spaces, punctuation) uses bracket access
// with the EXACT original key, because runtime rows are keyed by the field
// name as authored.
function pathToAccess(segments) {
  return segments
    .map(seg => (IDENT_RX.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`))
    .join('');
}

// Parse the inside of a `{{…}}` (already trimmed) into { root, star, path }.
// Grammar:  ROOT ('[*]')? ('.' SEG)*   where ROOT/SEG may contain spaces
// but not '.', '[' or ']'. Returns null when the text isn't a reference.
function parseRef(inner) {
  const m = /^([^.[\]]+?)\s*(\[\*\])?\s*((?:\.[^.[\]]+)*)$/.exec(inner);
  if (!m) return null;
  const root = m[1].trim();
  if (!root) return null;
  const path = m[3]
    ? m[3].split('.').slice(1).map(s => s.trim()).filter(Boolean)
    : [];
  return { root, star: !!m[2], path };
}

// Turn the inside of a `{{…}}` into the JS expression it references, or
// null when it isn't a valid reference.
function refExpr(inner) {
  const p = parseRef(inner);
  if (!p) return null;
  const rootJs = rootToIdent(p.root);
  const access = pathToAccess(p.path);
  if (p.star) {
    return p.path.length
      ? `(${rootJs} || []).map(_x => _x${access})`
      : `(${rootJs} || [])`;
  }
  return rootJs + access;
}

function qStr(s /* declaredVars kept for back-compat — no longer used */) {
  if (typeof s !== 'string') return JSON.stringify(s == null ? '' : String(s));
  if (!s.includes('{{')) return JSON.stringify(s);

  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
  let matched = false;
  const interpolated = escaped.replace(VAR_RX, (full, inner) => {
    const expr = refExpr(inner.trim());
    if (expr == null) return full;   // not a reference → keep literal
    matched = true;
    return '${' + expr + '}';
  });
  // No resolvable reference inside → emit the plain string unchanged.
  return matched ? '`' + interpolated + '`' : JSON.stringify(s);
}

// Extract a JS EXPRESSION out of a string that's "essentially a template
// reference" — i.e. exactly `{{var[*].something}}` (with optional
// whitespace). Used for fields that should evaluate to an array / object
// at runtime, not a string. Returns null if `s` isn't a pure template
// reference — callers can fall back to literal-array parsing or default
// to `[]`.
function qExpr(s) {
  if (typeof s !== 'string') return null;
  const m = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/.exec(s);
  if (!m) return null;
  return refExpr(m[1].trim());
}

// Convert a user-typed "JS expression" field (FOR_EACH source, IF
// expression, WHILE expression, REPEAT count, …) into a safe inlined
// expression. Behaviour:
//   - empty                       → fallback
//   - "{{var}} < 5"               → "var < 5"           (textual subst)
//   - "{{products[*].link}}"      → "(products || []).map(_x => _x.link)"
//   - "{{Escape Room Listings}}"  → "Escape_Room_Listings"
//   - "someVar.length > 0"        → "someVar.length > 0" (raw JS, untouched)
//
// We do TEXTUAL substitution rather than wrapping in a template literal
// because these fields are spliced directly into JS expression contexts
// (the body of `if (...)`, `while ((...))`, `for (... < N; ...)` etc.) —
// a string literal there would always be truthy, hiding the user's
// intent. The surrounding text is treated as JS source, so users can
// freely mix variables with operators.
function jsExpr(s, fallback) {
  if (typeof s !== 'string') return fallback;
  const t = s.trim();
  if (!t) return fallback;
  if (!t.includes('{{')) return t;          // already raw JS
  return t.replace(VAR_RX, (full, inner) => {
    const expr = refExpr(inner.trim());
    return expr == null ? full : expr;
  });
}

const q = (s) => JSON.stringify(s || '');
const num = (n, fallback = 0) => (typeof n === 'number' ? n : fallback);

// A container-relative FIELD selector may be CSS or XPath. XPath is
// recognised by a leading '/', '//', './', './/' or '(' — plain CSS never
// starts that way, so no per-field type flag is needed anywhere. Kept in sync
// with _isXPathSel() in browser/inject/SelectorTool.js.
function isXPathSelector(sel) {
  if (typeof sel !== 'string') return false;
  const s = sel.replace(/^\s+/, '');
  return s[0] === '/' || s[0] === '(' || (s[0] === '.' && s[1] === '/');
}

// In-page resolver injected into EXTRACT_LIST / COLLECT_LIST evaluate closures
// so a per-item field selector resolves whether it is CSS or a container-
// relative XPath. `__relChild('', el)` / a falsy selector means "the container
// itself". Emitted as source text — it runs in the browser, not in Node.
/* Normalise an EXTRACT_LIST / COLLECT_LIST `fields` map into two views:
     evalFields — what the extraction itself needs (selector / kind / attribute)
     postFields — the same plus per-field clean/split pipelines, which run
                  Node-side after the raw values come back
   Factored out so the browser path and the HTTP path read fields through the
   SAME definition. Two copies would eventually disagree, and the whole
   HTTP-mode safety argument rests on the two paths meaning the same thing. */
function normaliseListFields(rawFields) {
  const evalFields = {};
  const postFields = {};
  let hasPipeline = false;
  for (const [name, v] of Object.entries(rawFields || {})) {
    if (v == null) continue;
    let spec;
    if (typeof v === 'string') {
      spec = { selector: v, kind: 'text', attribute: null };
    } else if (typeof v === 'object') {
      const kind = v.kind === 'attr' || v.kind === 'attribute' ? 'attr'
                 : v.kind === 'html' ? 'html'
                 : 'text';
      spec = {
        selector: typeof v.selector === 'string' ? v.selector : '',
        kind,
        attribute: kind === 'attr' && typeof v.attribute === 'string' ? v.attribute : null,
      };
      if (Array.isArray(v.transforms) && v.transforms.length) spec.transforms = v.transforms;
      if (v.split && typeof v.split === 'object')             spec.split = v.split;
    } else {
      continue;
    }
    evalFields[name] = { selector: spec.selector, kind: spec.kind, attribute: spec.attribute };
    postFields[name] = spec;
    if (__ftHasPipeline(spec)) hasPipeline = true;
  }
  return { evalFields, postFields, hasPipeline };
}

const REL_CHILD_FN = `
      const __isX = (s) => { if (typeof s !== 'string') return false; s = s.replace(/^\\s+/, ''); return s[0] === '/' || s[0] === '(' || (s[0] === '.' && s[1] === '/'); };
      const __relChild = (root, s) => {
        if (!s) return root;
        if (__isX(s)) { try { return document.evaluate(s, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (_) { return null; } }
        try { return root.querySelector(s); } catch (_) { return null; }
      };`;

/* =========================================================================
   ACTION CODE GENERATORS
   Each returns a string of JS (no surrounding async wrapper).
   `varName`  = unique output variable (e.g. extracttext_ab12)
   `label`    = user-visible step name (falsy if unnamed)
   ========================================================================= */

function genAction(step, ctx) {
  const { type, params = {}, advanced = {}, outputVar, label } = step;
  const varName = outputVar || `_step_${ctx.nextId()}`;
  const isExtraction = EXTRACTION_TYPES.has(type);

  // Shadow the module-level `q` so every string param emitted in this
  // step's generated code automatically supports `{{var}}` interpolation
  // against the workflow's declared variables.
  const q = (s) => qStr(s, ctx.declaredVars);
  const selList = (p) => selectorList(p, ctx.declaredVars);

  // How long an extraction step waits for its selector to appear before giving
  // up and returning an empty value. The default keeps runs snappy — a value
  // that's already rendered is read with zero delay (resolveElementSoft's fast
  // path) and only a slow/lazy element incurs the wait — while still tolerating
  // content that lands a beat after load. Users who need a longer (or zero)
  // window set it per step via the "Wait for element" advanced field.
  const EXTRACT_GRACE_DEFAULT = 4000;
  const grace = () => Math.max(0, num(advanced.waitTimeout, EXTRACT_GRACE_DEFAULT));

  // Wrap a single-element extraction expression in its cleaning pipeline.
  // List extraction cleans per field via __ftMaterializeRow; a Get Text / Get
  // Attribute / Get HTML step has one value (or an array of them when
  // multiple=true), so it uses __ftCleanAny. Returns the expression untouched
  // when no ops are configured, so unchanged workflows generate identical code.
  const cleanSingle = (expr, p) => {
    const ops = Array.isArray(p.transforms) ? p.transforms.filter(o => o && typeof o === 'object') : [];
    if (ops.length === 0) return expr;
    return `__ftCleanAny(${expr}, ${JSON.stringify(ops)})`;
  };

  // ── ForEach element context ─────────────────────────────────────────────
  // When inside a FOR_EACH_ELEMENTS loop that has extractions, generate
  // element-relative code using `el.$eval(selector)` instead of page-level
  // helpers, and populate the row object instead of __results__.
  const feCtx = ctx.forEachEl; // { elVar, rowVar, hasExtractions } | undefined
  if (feCtx && feCtx.hasExtractions && isExtraction) {
    const fieldKey = (label && label.trim()) ? label : type.toLowerCase().replace('extract_', '');
    const sel = params.selector || '';
    const isSelf = sel === ':scope' || sel === '';
    const isX = isXPathSelector(sel);
    // Resolve a relative XPath field against the loop element (context node),
    // returning null when it doesn't match. `${feCtx.elVar}` is an ElementHandle.
    const xpChild = `(e, s) => { try { return document.evaluate(s, e, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (_) { return null; } }`;

    switch (type) {
      case 'EXTRACT_TEXT': {
        const expr = isSelf
          ? `await ${feCtx.elVar}.evaluate(e => (e.textContent || '').trim()).catch(() => '')`
          : isX
            ? `await ${feCtx.elVar}.evaluate((e, s) => { const n = (${xpChild})(e, s); return n ? (n.textContent || '').trim() : ''; }, ${q(sel)}).catch(() => '')`
            : `await ${feCtx.elVar}.$eval(${q(sel)}, e => (e.textContent || '').trim()).catch(() => '')`;
        return `${feCtx.rowVar}[${JSON.stringify(fieldKey)}] = ${cleanSingle(expr, params)};\n`;
      }
      case 'EXTRACT_ATTRIBUTE': {
        const attr = params.attribute || '';
        const expr = isSelf
          ? `await ${feCtx.elVar}.evaluate((e, a) => e.getAttribute(a) || '', ${q(attr)}).catch(() => '')`
          : isX
            ? `await ${feCtx.elVar}.evaluate((e, s, a) => { const n = (${xpChild})(e, s); return n ? (n.getAttribute(a) || '') : ''; }, ${q(sel)}, ${q(attr)}).catch(() => '')`
            : `await ${feCtx.elVar}.$eval(${q(sel)}, (e, a) => e.getAttribute(a) || '', ${q(attr)}).catch(() => '')`;
        return `${feCtx.rowVar}[${JSON.stringify(fieldKey)}] = ${cleanSingle(expr, params)};\n`;
      }
      case 'EXTRACT_HTML': {
        const prop = params.mode === 'outer' ? 'outerHTML' : 'innerHTML';
        const expr = isSelf
          ? `await ${feCtx.elVar}.evaluate(e => e.${prop}).catch(() => '')`
          : isX
            ? `await ${feCtx.elVar}.evaluate((e, s) => { const n = (${xpChild})(e, s); return n ? n.${prop} : ''; }, ${q(sel)}).catch(() => '')`
            : `await ${feCtx.elVar}.$eval(${q(sel)}, e => e.${prop}).catch(() => '')`;
        return `${feCtx.rowVar}[${JSON.stringify(fieldKey)}] = ${cleanSingle(expr, params)};\n`;
      }
      default:
        // Other extraction types (TABLE, LIST, JSON) fall through to page-level
        break;
    }
  }

  // ── HTTP mode ───────────────────────────────────────────────────────────
  // The same step list is compiled TWICE for an HTTP-eligible subflow: once
  // against puppeteer, once against a fetched+parsed document. Reusing the
  // generator (rather than writing a second one) is what keeps the two paths
  // honestly comparable — the store/alias bookkeeping below is shared, so only
  // the read differs, which is exactly what verification is testing.
  const httpMode = !!ctx.httpMode;

  // ── Standard (page-level) code ──────────────────────────────────────────
  let store = '';
  if (isExtraction && !feCtx?.hasExtractions) {
    // "Include in final output" — when false the step still creates the
    // JS variable so other steps can consume it (e.g. a list of links
    // used for iteration), but the data is omitted from __results__. The
    // typical use case: extract product links → iterate via RUN_SUBFLOW
    // → final JSON contains only the per-product detail records, not
    // the raw links list.
    const includeInOutput = advanced.includeInOutput !== false;
    const key = (label && label.trim()) ? label : `extracted_${varName}`;
    const jkey = JSON.stringify(key);
    // Record which result key this extraction feeds, against the TOP-LEVEL
    // step currently being generated (this one, or the loop containing it).
    // That mapping is what lets a resume restore a finished step's output
    // instead of re-scraping to rebuild it — see stepResumeGuard.
    if (includeInOutput && ctx.topOutputs) ctx.topOutputs.add(key);
    if (includeInOutput) {
      if (ctx.inLoop) {
        // Inside a loop (WHILE / REPEAT / pagination): accumulate into an
        // array instead of overwriting, so every iteration's rows are kept.
        store = `  if (!__results__[${jkey}]) __results__[${jkey}] = [];\n`
              + `  if (Array.isArray(${varName})) __results__[${jkey}].push(...${varName});\n`
              + `  else if (${varName} !== null && ${varName} !== undefined) __results__[${jkey}].push(${varName});\n`;
      } else {
        store = `  __results__[${jkey}] = ${varName};\n`;
      }
    }
    // Mirror the named result into a JS variable with the same name, so
    // subsequent steps (FOR_EACH source, RUN_SUBFLOW url, …) can refer to
    // it directly as `products` instead of `__results__["products"]`.
    // We collect aliases in ctx.capturedAliases — the top-level generator
    // emits a single `let <name>;` declaration per alias so the var is
    // visible across try/catch/loop scopes.
    if (label && label.trim()) {
      const alias = toJsIdent(label.trim());
      if (alias && !ctx.declaredVars?.has(alias)) {
        if (ctx.capturedAliases) ctx.capturedAliases.add(alias);
        // Restoring a finished step means restoring the JS alias too — later
        // steps read `products`, not `__results__["products"]`.
        if (includeInOutput && ctx.topAliases) ctx.topAliases.set(alias, key);
        if (ctx.inLoop) {
          // CRITICAL for "paginate a list, THEN enrich it": inside a loop the
          // alias must ACCUMULATE across iterations too, not just hold the
          // last one. Otherwise a later step reading `${alias}` (e.g.
          // RUN_SUBFLOW enrich's source table) would only see the final
          // page's rows. Mirror the __results__[key] accumulation above.
          if (includeInOutput) {
            // __results__[key] is already the full accumulated array — point
            // the alias at it so both stay in sync.
            store += `  ${alias} = __results__[${jkey}];\n`;
          } else {
            store += `  if (!Array.isArray(${alias})) ${alias} = [];\n`
                  +  `  if (Array.isArray(${varName})) ${alias}.push(...${varName});\n`
                  +  `  else if (${varName} !== null && ${varName} !== undefined) ${alias}.push(${varName});\n`;
          }
        } else {
          store += `  ${alias} = ${varName};\n`;
        }
      }
    }

    // Emit record-count / field-fill stats so the execution pipeline can
    // detect a step that "succeeded" but captured nothing and trigger
    // self-healing. Only for selector-repairable extraction types.
    // Skipped in HTTP mode: that path is a candidate being verified, not the
    // run's outcome, so its counts must not drive empty-result healing.
    if (!httpMode && HEALABLE_EXTRACTION_TYPES.has(type) && step.id) {
      const statsKey = (label && label.trim()) ? label : `extracted_${varName}`;
      store += `  await __emitStepStats(page, { stepId: ${JSON.stringify(step.id)}, type: ${JSON.stringify(type)}, label: ${JSON.stringify(label || '')}, key: ${JSON.stringify(statsKey)}, multiple: ${!!params.multiple} }, ${varName});\n`;
    }

    // Check-point after every extraction so a linear (loop-free) workflow that
    // dies later still leaves behind what it had already captured. Throttled
    // internally, so this is nearly free. Not in HTTP mode — those results are
    // per-item and reach the root only once the item is committed.
    if (!httpMode) store += `  __checkpoint();\n`;
  }

  // HTTP mode handles only the pure-DOM extraction types; a body containing
  // anything else is rejected at compile time (httpEligibleSteps), so reaching
  // here with another type would be a bug rather than a fallback case.
  if (httpMode) {
    const hxSels = selList(params);
    switch (type) {
      case 'EXTRACT_TEXT':
        return `const ${varName} = ${cleanSingle(`__hxText(__$, ${hxSels}, ${!!params.multiple})`, params)};\n` + store;
      case 'EXTRACT_ATTRIBUTE':
        return `const ${varName} = ${cleanSingle(`__hxAttr(__$, ${hxSels}, ${q(params.attribute)}, ${!!params.multiple})`, params)};\n` + store;
      case 'EXTRACT_HTML':
        return `const ${varName} = ${cleanSingle(`__hxHtml(__$, ${hxSels}, ${params.mode === 'outer'})`, params)};\n` + store;
      case 'EXTRACT_TABLE': {
        const tblSels = selList({
          selector: params.selector || 'table',
          selectorType: params.selectorType || 'css',
          fallbackSelectors: params.fallbackSelectors || [],
        });
        return `const ${varName} = __hxTable(__$, ${tblSels}, ${params.hasHeader !== false});\n` + store;
      }
      case 'EXTRACT_LIST': {
        const { evalFields, postFields, hasPipeline } = normaliseListFields(params.fields || {});
        const listSels = selList({
          selector: params.containerSelector,
          selectorType: params.selectorType || 'css',
          fallbackSelectors: params.fallbackSelectors || [],
        });
        const post = hasPipeline
          ? `.map(_row => __ftMaterializeRow(_row, ${JSON.stringify(postFields)}))`
          : '';
        return `const ${varName} = __hxList(__$, ${listSels}, ${JSON.stringify(evalFields)})${post};\n` + store;
      }
      default:
        return `// ⚠ ${type} is not available over HTTP — this body should not have been HTTP-eligible\n`;
    }
  }

  switch (type) {

    // ── Navigation ───────────────────────────────────────────────────────
    case 'NAVIGATE': {
      // "Editor only" navigation: the step exists to anchor the live editor
      // on a page (start URL) but the actual run is driven entirely by the
      // other workflow steps — emit nothing but a note.
      if (advanced.skipOnRun) {
        return `// Navigation to ${params.url || '(unset)'} skipped — marked editor-only\n`;
      }
      // Per-step cookie-consent preference: 'accept' (default) | 'reject' | 'off'.
      const consentPref = advanced.consent || 'accept';
      const consentCall = consentPref === 'off'
        ? ''
        : `\nawait dismissConsent(page, ${JSON.stringify(consentPref)});`;
      // Per-step CAPTCHA handling: 'auto' (default — detect, wait out
      // interstitials, solve if a provider is configured, else flag & continue)
      // or 'off'. Never fails the navigation itself; a hard failure is opt-in
      // via the explicit SOLVE_CAPTCHA step (onUnsolved:'fail').
      const captchaPref = advanced.captcha || 'auto';
      const captchaCall = captchaPref === 'off'
        ? ''
        : `\nawait solveCaptcha(page, { onUnsolved: 'continue', stepLabel: ${JSON.stringify(label || 'navigate')} });`;
      // Smart wait: only when the workflow opted in, the step hasn't pinned its
      // own waitUntil, and we could actually identify what the next extraction
      // reads. Any of those missing ⇒ unchanged waitUntil:'load' behaviour.
      const navTimeout = num(advanced.timeout, execOf(ctx).navTimeoutMs);
      const smartSels = (ctx.perf && ctx.perf.smartWait && !advanced.waitUntil)
        ? (ctx.__lookaheadSelectors || null)
        : null;
      if (smartSels) {
        return `
// Navigate (smart wait: ready when the data is, not when the last image is)
await page.goto(${q(params.url)}, {
  waitUntil: 'domcontentloaded',
  timeout: ${navTimeout},
});
await smartWaitFor(page, ${smartSels}, ${navTimeout});${consentCall}${captchaCall}
`.trim() + '\n';
      }
      return `
// Navigate
await page.goto(${q(params.url)}, {
  waitUntil: ${q(advanced.waitUntil || 'load')},
  timeout: ${navTimeout},
});${consentCall}${captchaCall}
`.trim() + '\n';
    }

    case 'GO_BACK': return `await page.goBack({ waitUntil: ${q(advanced.waitUntil || 'load')} });\n`;

    case 'RELOAD_PAGE': return `await page.reload({ waitUntil: ${q(advanced.waitUntil || 'load')} });\n`;

    case 'OPEN_NEW_TAB': return `
{
  const _newPage = await __openPage(browser);
  await _newPage.goto(${q(params.url)}, { waitUntil: 'load' });
  page = _newPage;
  await dismissConsent(page);
  await solveCaptcha(page, { onUnsolved: 'continue', stepLabel: 'open new tab' });
}
`.trim() + '\n';

    case 'SWITCH_TAB': return `
{
  const _pages = await browser.pages();
  if (${num(params.tabIndex, 0)} < _pages.length) {
    page = _pages[${num(params.tabIndex, 0)}];
    await page.bringToFront();
  }
}
`.trim() + '\n';

    // ── Interaction ──────────────────────────────────────────────────────
    case 'CLICK_ELEMENT': {
      const sels = selList(params);
      const timeout = num(advanced.timeout, 10000);
      if (advanced.waitForNavigation) {
        return `
// Click: ${params.selector}
await Promise.all([
  page.waitForNavigation({ timeout: ${timeout} }),
  waitForAny(page, ${sels}, ${timeout}).then(el => el.click()),
]);
`.trim() + '\n';
      }
      return `
// Click: ${params.selector}
{
  const _el = await waitForAny(page, ${sels}, ${timeout});
  await _el.click();
}
`.trim() + '\n';
    }

    case 'DISMISS_COOKIE_BANNER': {
      // Cookie banners are legitimately absent when consent was already
      // stored (repeat visit, persisted profile) — this step must NEVER
      // fail the workflow, so it clicks-if-present instead of waiting-then-
      // throwing like CLICK_ELEMENT.
      const hasSel = !!(params.selector || (params.fallbackSelectors || []).length);
      const timeout = num(advanced.timeout, 8000);
      if (!hasSel) {
        return `
// Close cookie banner (automatic detection — skipped silently when absent)
await dismissConsent(page);
`.trim() + '\n';
      }
      const autoFallback = advanced.autoFallback !== false;
      return `
// Close cookie banner: ${params.selector} (click if present — never fails)
{
  let _closed = await clickIfPresent(page, ${selList(params)}, ${timeout});${autoFallback ? `
  // Selector didn't match (banner redesign?) → try automatic detection.
  if (!_closed) _closed = await dismissConsent(page);` : ''}
  console.log(_closed
    ? '🍪 Cookie banner closed.'
    : '🍪 Cookie banner not found — already consented or not shown; continuing.');
}
`.trim() + '\n';
    }

    case 'SOLVE_CAPTCHA': {
      // Explicit "there should be a captcha here — deal with it" step.
      // Detect → wait out interstitials → solve via the configured provider
      // (CAPTCHA_PROVIDER/CAPTCHA_API_KEY) → inject the token. onUnsolved:
      //   'fail'     — throw (routes to needs_review) when it can't be solved
      //   'continue' — log + carry on (default)
      const onUnsolved = advanced.onUnsolved === 'fail' ? 'fail' : 'continue';
      const maxWaitMs = num(advanced.maxWaitMs, 25000);
      return `
// Solve CAPTCHA if present
await solveCaptcha(page, { onUnsolved: ${JSON.stringify(onUnsolved)}, maxWaitMs: ${maxWaitMs}, stepLabel: ${JSON.stringify(label || 'solve captcha')} });
`.trim() + '\n';
    }

    case 'HOVER_ELEMENT': return `
{
  const _el = await waitForAny(page, ${selList(params)}, ${num(advanced.timeout, 10000)});
  await _el.hover();
}
`.trim() + '\n';

    case 'TYPE_TEXT': return `
{
  const _el = await waitForAny(page, ${selList(params)}, 10000);
  ${params.clearFirst !== false ? `await page.evaluate(el => { el.value = ''; }, _el);` : ''}
  await _el.type(${q(params.text)}, { delay: ${num(advanced.delay, 0)} });
  ${params.pressEnter ? `await page.keyboard.press('Enter');` : ''}
}
`.trim() + '\n';

    case 'CLEAR_INPUT': return `
{
  const _el = await resolveElement(page, ${selList(params)});
  if (_el) await page.evaluate(el => { el.value = ''; }, _el);
}
`.trim() + '\n';

    case 'PRESS_KEY': {
      const count = num(advanced.count, 1);
      if (params.selector) {
        return `
{
  const _el = await resolveElement(page, ${selList(params)});
  if (_el) for (let _i = 0; _i < ${count}; _i++) await _el.press(${q(params.key)});
}
`.trim() + '\n';
      }
      return `for (let _i = 0; _i < ${count}; _i++) await page.keyboard.press(${q(params.key)});\n`;
    }

    case 'SCROLL_TO_ELEMENT': return `
{
  const _el = await waitForAny(page, ${selList(params)}, 10000);
  await page.evaluate((el, b) => el.scrollIntoView({ behavior: b, block: 'center' }), _el, ${q(advanced.behavior || 'auto')});
}
`.trim() + '\n';

    case 'SCROLL_PAGE': {
      const dir = params.direction || 'down';
      const amount = num(params.amount, 500);
      const scriptMap = {
        down:   `window.scrollBy({ top: ${amount}, behavior: 'auto' })`,
        up:     `window.scrollBy({ top: ${-amount}, behavior: 'auto' })`,
        bottom: `window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' })`,
        top:    `window.scrollTo({ top: 0, behavior: 'auto' })`,
      };
      return `await page.evaluate(() => { ${scriptMap[dir] || scriptMap.down}; });\n`;
    }

    case 'UPLOAD_FILE': return `
{
  const _fileInput = await resolveElement(page, ${selList(params)});
  if (_fileInput) await _fileInput.uploadFile(${q(params.filePath)});
}
`.trim() + '\n';

    // ── Flow control (leaf variants used inside generated code) ──────────
    case 'WAIT': return `await new Promise(r => setTimeout(r, ${num(params.duration, 1000)}));\n`;

    case 'WAIT_FOR_SELECTOR': return `
await waitForAny(page, ${selList(params)}, ${num(advanced.timeout, execOf(ctx).navTimeoutMs)}, { reveal: false });
`.trim() + '\n';

    case 'WAIT_FOR_NAVIGATION': return `
await page.waitForNavigation({ waitUntil: ${q(advanced.waitUntil || 'load')}, timeout: ${num(advanced.timeout, execOf(ctx).navTimeoutMs)} });
`.trim() + '\n';

    case 'BREAK_LOOP': return `break;\n`;

    // ── Extraction ───────────────────────────────────────────────────────
    case 'EXTRACT_TEXT': {
      const sels = selList(params);
      const g = grace();
      const code = params.multiple
        ? `const ${varName} = ${cleanSingle(`await evalOnElements(page, ${sels}, el => el.textContent.trim(), ${g})`, params)};\n`
        : `const ${varName} = ${cleanSingle(`await evalOnElement(page, ${sels}, el => el.textContent.trim(), ${g}).catch(() => null)`, params)};\n`;
      return code + store;
    }

    case 'EXTRACT_ATTRIBUTE': {
      const sels = selList(params);
      const attr = q(params.attribute);
      const g = grace();
      // Wait (softly) for the element/elements to appear, then read the
      // attribute. Closures are used because page.evaluate only forwards one
      // extra arg to the browser-side fn.
      const raw = params.multiple
        ? `await (async () => { const _els = await resolveElementsSoft(page, ${sels}, ${g}); return Promise.all(_els.map(el => page.evaluate((e, a) => e.getAttribute(a), el, ${attr}))); })()`
        : `await (async () => { const _el = await resolveElementSoft(page, ${sels}, ${g}); return _el ? page.evaluate((e, a) => e.getAttribute(a), _el, ${attr}) : null; })()`;
      return `const ${varName} = ${cleanSingle(raw, params)};\n` + store;
    }

    case 'EXTRACT_HTML': {
      const prop = params.mode === 'outer' ? 'outerHTML' : 'innerHTML';
      const raw = `await evalOnElement(page, ${selList(params)}, el => el.${prop}, ${grace()}).catch(() => null)`;
      return `
const ${varName} = ${cleanSingle(raw, params)};
${store}`.trim() + '\n';
    }

    case 'EXTRACT_TABLE': return `
const ${varName} = await (async () => {
  const _tbl = await resolveElementSoft(page, ${selList({ selector: params.selector || 'table', selectorType: params.selectorType || 'css', fallbackSelectors: params.fallbackSelectors || [] })}, ${grace()});
  if (!_tbl) return null;
  return page.evaluate((table, hasHeader) => {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (hasHeader && rows.length > 0) {
      const headers = Array.from(rows[0].querySelectorAll('th,td')).map(c => c.textContent.trim());
      return rows.slice(1).map(row => {
        const cells = Array.from(row.querySelectorAll('td,th')).map(c => c.textContent.trim());
        return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? null]));
      });
    }
    return rows.map(r => Array.from(r.querySelectorAll('td,th')).map(c => c.textContent.trim()));
  }, _tbl, ${params.hasHeader !== false});
})();
${store}`.trim() + '\n';

    case 'EXTRACT_LIST': {
      // Normalise the user's `fields` object into a uniform rich shape so
      // both the legacy string form `{ title: '.title' }` and the new
      // AI-friendly object form `{ title: { selector, kind, attribute } }`
      // produce identical runtime code.
      const rawFields = params.fields || {};
      // `evalFields` carries only what the in-page extraction needs
      // (selector/kind/attribute). `postFields` additionally carries the
      // per-field clean/split pipelines, which run Node-side after the raw
      // values come back (custom JS, regex split, …).
      const { evalFields, postFields, hasPipeline } = normaliseListFields(rawFields);
      const fieldsJson = JSON.stringify(evalFields);
      const sels = selList({
        selector: params.containerSelector,
        selectorType: params.selectorType || 'css',
        fallbackSelectors: params.fallbackSelectors || [],
      });
      // Only emit the post-processing map when at least one field configures a
      // transform or split — keeps the generated code minimal otherwise.
      const postProcess = hasPipeline
        ? `.then(_rows => _rows.map(_row => __ftMaterializeRow(_row, ${JSON.stringify(postFields)})))`
        : '';
      return `
const ${varName} = await (async () => {
  const _containers = await resolveElementsSoft(page, ${sels}, ${grace()});
  return Promise.all(_containers.map(container =>
    page.evaluate((el, fields) => {${REL_CHILD_FN}
      const item = {};
      for (const [name, spec] of Object.entries(fields)) {
        const sel = spec.selector || '';
        // Empty selector means "use the container itself" (useful for
        // attribute extraction off the row element). A selector starting with
        // '/', './' or '(' is treated as a container-relative XPath.
        const child = __relChild(el, sel);
        if (!child) { item[name] = null; continue; }
        if (spec.kind === 'attr' && spec.attribute) {
          item[name] = child.getAttribute(spec.attribute);
        } else if (spec.kind === 'html') {
          item[name] = (child.innerHTML || '').trim();
        } else {
          item[name] = (child.textContent || '').trim();
        }
      }
      return item;
    }, container, ${fieldsJson})
  ))${postProcess};
})();
${store}`.trim() + '\n';
    }

    case 'COLLECT_LIST': {
      // Same field model as EXTRACT_LIST, but the rows are harvested WHILE
      // scrolling and de-duped by key — see harvestWhileScrolling. Handles
      // infinite-scroll and virtualized/recycling lists.
      const rawFields = params.fields || {};
      const evalFields = {};
      const postFields = {};
      let hasPipeline = false;
      for (const [name, v] of Object.entries(rawFields)) {
        if (v == null) continue;
        let spec;
        if (typeof v === 'string') {
          spec = { selector: v, kind: 'text', attribute: null };
        } else if (typeof v === 'object') {
          const kind = v.kind === 'attr' || v.kind === 'attribute' ? 'attr'
                     : v.kind === 'html' ? 'html'
                     : 'text';
          spec = {
            selector: typeof v.selector === 'string' ? v.selector : '',
            kind,
            attribute: kind === 'attr' && typeof v.attribute === 'string' ? v.attribute : null,
          };
          if (Array.isArray(v.transforms) && v.transforms.length) spec.transforms = v.transforms;
          if (v.split && typeof v.split === 'object')             spec.split = v.split;
        } else {
          continue;
        }
        evalFields[name] = { selector: spec.selector, kind: spec.kind, attribute: spec.attribute };
        postFields[name] = spec;
        if (__ftHasPipeline(spec)) hasPipeline = true;
      }
      const fieldsJson = JSON.stringify(evalFields);
      const containerExpr = q(params.containerSelector || '');   // supports {{var}}
      const scrollExpr    = q(params.scrollContainer || '');
      const keyJson = JSON.stringify((params.keyField && String(params.keyField).trim()) || '');
      const optsJson = JSON.stringify(scrollAccuracyOpts(params, advanced, {
        legacyDelay: num(advanced.scrollDelay, 1200),
        legacyNoNew: Math.max(1, num(advanced.maxNoNew, 3)),
        maxScrolls:  num(advanced.maxScrolls, 300),
      }));
      const postProcess = hasPipeline
        ? `.then(_rows => _rows.map(_row => __ftMaterializeRow(_row, ${JSON.stringify(postFields)})))`
        : '';
      const code = `const ${varName} = await harvestWhileScrolling(page, ${containerExpr}, ${fieldsJson}, ${keyJson}, ${scrollExpr}, ${optsJson})${postProcess};\n`;
      return code + store;
    }

    case 'EXTRACT_JSON': {
      let extractCode;
      if (params.source === 'variable') {
        extractCode = `await page.evaluate(() => window[${q(params.variableName)}])`;
      } else if (params.source === 'selector') {
        extractCode = `await page.$eval(${q(params.scriptSelector)}, el => JSON.parse(el.textContent))`;
      } else {
        extractCode = `await page.$eval('script[type="application/ld+json"]', el => JSON.parse(el.textContent))`;
      }
      const pathCode = params.jsonPath
        ? '.' + params.jsonPath.split('.').map(k => `${k}`).join('.')
        : '';
      return `
const ${varName} = (await ${extractCode}.catch(() => null))${pathCode};
${store}`.trim() + '\n';
    }

    // Calls the site's own data API directly (discovered by the API Discovery
    // module). Emits a fetch() — with an optional pagination loop that walks a
    // page/offset param until a page comes back empty — and plucks the JSON
    // collection out of the response. Values support {{var}} interpolation.
    case 'EXTRACT_API': {
      const method  = String(params.method || 'GET').toUpperCase();
      const headers = (params.headers && typeof params.headers === 'object') ? params.headers : {};
      const hasBody = !['GET', 'HEAD'].includes(method) && params.body != null && params.body !== '';
      // Build the headers object literal, running each value through q() so a
      // captured token can be swapped for a {{secret}} the user sets later.
      const headersLit = '{ ' + Object.entries(headers)
        .filter(([k]) => k && k.toLowerCase() !== 'content-length')
        .map(([k, v]) => `${JSON.stringify(k)}: ${q(String(v))}`)
        .join(', ') + ' }';
      const bodyLit = hasBody ? q(String(params.body)) : 'undefined';
      // Dot-path pluck of the collection within the response (e.g. "data.items").
      const pathArr = params.jsonPath
        ? JSON.stringify(String(params.jsonPath).split('.').filter(Boolean))
        : '[]';
      const pluck = `(${pathArr}).reduce((o, k) => (o == null ? o : o[k]), _json)`;

      const paginate  = !!params.paginate && !!params.pageParam;
      const fetchInit = `{ method: ${JSON.stringify(method)}, headers: ${headersLit}${hasBody ? `, body: ${bodyLit}` : ''} }`;

      if (!paginate) {
        return `
const ${varName} = await (async () => {
  await __rateGate();
  const _res = await __apiFetch(${q(params.url)}, ${fetchInit});
  if (!_res.ok) throw new Error('API request failed: ' + _res.status + ' ${method} ' + ${q(params.url)});
  const _json = await _res.json();
  return ${pluck};
})();
${store}`.trim() + '\n';
      }

      const paramIn   = params.pageParamIn === 'body' ? 'body' : 'query';
      const startPage = num(params.startPage, 1);
      const pageStep  = num(params.pageStep, 1);
      const maxPages  = num(params.maxPages, 50);
      const stopEmpty = params.stopWhenEmpty !== false;
      // For body pagination we set the param on a parsed copy of the JSON body;
      // for query pagination we set it on the URL's searchParams.
      const buildReq = paramIn === 'body'
        ? `
    let _bodyObj = {};
    try { _bodyObj = ${hasBody ? bodyLit : '"{}"'} ? JSON.parse(${hasBody ? bodyLit : '"{}"'}) : {}; } catch (_) { _bodyObj = {}; }
    _bodyObj[${q(params.pageParam)}] = _p;
    const _url = ${q(params.url)};
    const _init = { method: ${JSON.stringify(method)}, headers: ${headersLit}, body: JSON.stringify(_bodyObj) };`
        : `
    const _u = new URL(${q(params.url)});
    _u.searchParams.set(${q(params.pageParam)}, String(_p));
    const _url = _u.href;
    const _init = ${fetchInit};`;

      // Walking an API is the one place a single step can be a whole scrape:
      // 50 pages × 100 records is 5,000 rows from one step. So it gets the same
      // treatment as the per-item loops — paced, check-pointed page by page,
      // and reporting progress — rather than being an opaque blocking call
      // whose output only exists if it runs to completion.
      const apiIdJson = JSON.stringify(step.id || '');
      // Publish the pages fetched so far, under the same key `store` will use
      // at the end. Without this a run that dies on page 48 of 50 reports
      // nothing at all — precisely the loss check-pointing exists to prevent.
      // Guarded like `store`: omitted when the step is excluded from output.
      // The __checkpoint call is dropped from downloaded scripts by the
      // existing line filter (stripDownloadInstrumentation); the assignment
      // itself is real behaviour and harmless there.
      const apiPartialPublish = (advanced.includeInOutput !== false)
        ? `    __results__[${JSON.stringify((label && label.trim()) ? label : `extracted_${varName}`)}] = _all.slice();\n`
          + `    __checkpoint();\n`
        : '';
      return `
const ${varName} = await (async () => {
  const _all = [];
  ${apiIdJson ? `__emitMark('ITER_START', {stepId: ${apiIdJson}, total: ${maxPages}});` : ''}
  let _p = ${startPage};
  for (let _i = 0; _i < ${maxPages}; _i++, _p += ${pageStep}) {${buildReq}
    await __rateGate();
    const _res = await __apiFetch(_url, _init);
    if (!_res.ok) break;
    const _json = await _res.json();
    const _data = ${pluck};
    const _items = Array.isArray(_data) ? _data : (_data == null ? [] : [_data]);
    ${stopEmpty ? 'if (_items.length === 0) break;' : ''}
    _all.push(..._items);
    ${apiIdJson ? `__emitMark('ITER_TICK', {stepId: ${apiIdJson}, index: _i});` : ''}
${apiPartialPublish}  }
  ${apiIdJson ? `__emitMark('ITER_END', {stepId: ${apiIdJson}});` : ''}
  return _all;
})();
${store}`.trim() + '\n';
    }

    // ── Data handling ────────────────────────────────────────────────────
    case 'SET_VARIABLE': return `let ${params.name || '_var'} = ${params.value || 'null'};\n`;

    case 'TRANSFORM_DATA': {
      const src = params.source || '_undefined';
      const out = params.outputVar || `_${src}_transformed`;
      const ops = {
        trim:         `${src} = String(${src}).trim()`,
        uppercase:    `${src} = String(${src}).toUpperCase()`,
        lowercase:    `${src} = String(${src}).toLowerCase()`,
        replace:      `${src} = String(${src}).split(${q(params.searchValue)}).join(${q(params.replaceValue || '')})`,
        replaceRegex: `${src} = String(${src}).replace(new RegExp(${q(params.searchValue)}, ${q(advanced.regexFlags || 'g')}), ${q(params.replaceValue || '')})`,
        split:        `${src} = String(${src}).split(${q(params.searchValue)})`,
        join:         `${src} = Array.isArray(${src}) ? ${src}.join(${q(params.searchValue || '')}) : String(${src})`,
        toNumber:     `${src} = Number(${src})`,
        custom:       `${src} = ((value) => (${params.customExpression || 'value'}))(${src})`,
      };
      return `${ops[params.operation] || `/* unknown transform: ${params.operation} */`};\n`;
    }

    case 'APPEND_TO_LIST': return `
if (!Array.isArray(${params.listName})) ${params.listName} = [];
${params.listName}.push(${params.item || 'null'});
`.trim() + '\n';

    case 'SAVE_DATA': {
      if (params.format === 'webhook') {
        return `
await fetch(${q(params.destination)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${params.source || 'null'}) });
`.trim() + '\n';
      }
      // Resolve a relative destination against WS_EXPORT_DIR (set by the
      // platform runner to backend/data/exports) or the current working
      // directory (for a downloaded standalone script). Create the parent
      // directory first — the previous code did a bare writeFileSync, so a
      // relative path like "./output/results.json" threw ENOENT (no output/
      // in the tmp cwd) and a bare "./results.json" vanished into the OS temp
      // dir. Log the absolute path so the file is always findable.
      const saveResolved = (contentExpr) => `
{
  const _p = require('path'), _fs = require('fs');
  const _dest = _p.isAbsolute(${q(params.destination)}) ? ${q(params.destination)} : _p.resolve(process.env.WS_EXPORT_DIR || process.cwd(), ${q(params.destination)});
  _fs.mkdirSync(_p.dirname(_dest), { recursive: true });
  _fs.writeFileSync(_dest, ${contentExpr}, 'utf8');
  console.log('💾 Saved data to ' + _dest);
}
`.trim() + '\n';
      if (params.format === 'csv') {
        return saveResolved(`(() => {
    const _rows = Array.isArray(${params.source}) ? ${params.source} : [${params.source}];
    const _headers = Object.keys(_rows[0] || {});
    return [_headers.join(','), ..._rows.map(r => _headers.map(h => JSON.stringify(r[h] ?? '')).join(','))].join('\\n');
  })()`);
      }
      return saveResolved(`JSON.stringify(${params.source || 'null'}, null, 2)`);
    }

    // ── Custom action (user-defined) ─────────────────────────────────────
    case 'CUSTOM_ACTION': {
      const actionId = params.actionId;
      const def = ctx.customActions?.[actionId];
      if (!def) {
        return `throw new Error(${q(`Custom action ${actionId} is not available (was it deleted?)`)});\n`;
      }
      const userInputs = params.inputs || {};
      // Build inputs object: each declared input renders as a literal.
      // Allow inputs to be plain JS expressions via {{expr}} for power users;
      // otherwise the value is JSON-stringified verbatim.
      const inputEntries = (def.inputs || []).map((inp) => {
        const raw = userInputs[inp.name];
        let expr;
        if (typeof raw === 'string' && raw.startsWith('{{') && raw.endsWith('}}')) {
          expr = raw.slice(2, -2);
        } else {
          expr = JSON.stringify(raw === undefined ? null : raw);
        }
        return `  ${JSON.stringify(inp.name)}: ${expr}`;
      }).join(',\n');

      const resultKey = (label && label.trim()) ? label : def.name;
      const fnVar  = `_ca_fn_${ctx.nextId()}`;
      const outVar = `_ca_out_${ctx.nextId()}`;
      // The action body is wrapped as an async arrow taking the documented context.
      // `log` mirrors console.log so the executor's child process surfaces it.
      const userCode = def.code || 'return undefined;';
      return [
        `// Custom action: ${def.name}`,
        `{`,
        `  const ${fnVar} = async ({ inputs, page, fetch, log }) => {`,
        indent(userCode, 2),
        `  };`,
        `  const ${outVar} = await ${fnVar}({`,
        `    inputs: {`,
        inputEntries,
        `    },`,
        `    page,`,
        `    fetch: (typeof fetch !== 'undefined' ? fetch : (...a) => import('node-fetch').then(m => m.default(...a))),`,
        `    log: (...args) => console.log('[${def.name}]', ...args),`,
        `  });`,
        ctx.inLoop
          ? `  if (!__results__[${JSON.stringify(resultKey)}]) __results__[${JSON.stringify(resultKey)}] = [];\n  __results__[${JSON.stringify(resultKey)}].push(${outVar});`
          : `  __results__[${JSON.stringify(resultKey)}] = ${outVar};`,
        `}`,
        ``,
      ].join('\n');
    }

    // ── Run another saved workflow as a subflow ─────────────────────────
    // The subflow is inlined: we open a fresh puppeteer page, navigate
    // to the (interpolated) URL, then run the subflow's steps with
    // `page` shadowed to the new page. Its collected __results__ get
    // merged back into the parent's __results__ under the configured
    // outputVar key. Inside a loop this naturally produces an array of
    // per-iteration result objects (one per visited URL).
    case 'RUN_SUBFLOW': {
      const subflowId = params.workflowId;
      const subflows  = ctx.subflows || {};
      const sub       = subflows[subflowId];
      if (!sub) {
        return `// ⚠ Subflow #${subflowId} is unavailable (was it deleted, or did a recursion cycle prevent it from being inlined?)\nconsole.warn(${JSON.stringify(`Subflow ${subflowId} unavailable — skipping`)});\n`;
      }
      const outKey   = (params.outputVar && String(params.outputVar).trim())
                    || (label && label.trim())
                    || sub.name
                    || `subflow_${subflowId}`;
      // A subflow loop that ran to completion is restorable like any other
      // step: on resume its rows come back and it doesn't re-walk the list.
      if (ctx.topOutputs) ctx.topOutputs.add(outKey);

      // Generate the subflow's step code with its OWN context. We pass
      // through declaredVars + customActions + subflows so the subflow
      // can reuse the same workflow variables and itself reference other
      // subflows. visitedSubflows blocks cycles.
      const subCtx = {
        nextId: ctx.nextId,
        declaredVars: ctx.declaredVars,
        customActions: ctx.customActions,
        subflows: ctx.subflows,
        visitedSubflows: new Set(ctx.visitedSubflows || []),
        capturedAliases: new Set(),   // subflow gets its own alias scope
        perf: ctx.perf,
        exec: ctx.exec,               // navigation strategy is workflow-wide
      };
      subCtx.visitedSubflows.add(String(subflowId));

      // ── Input variables & self-navigation ────────────────────────────────
      // A subflow's declared workflow variables (sub.meta.variables). Any of
      // them flagged `input` can be supplied per-invocation from the parent via
      // params.inputs = { <varName>: <expression> }. This is how one subflow,
      // authored on a single concrete URL, gets re-run against many targets:
      // the parent maps a list column into the subflow's input variable and the
      // subflow references it as {{var}} (e.g. Navigate to {{base_url}}/reviews).
      const subVars  = Array.isArray(sub.meta && sub.meta.variables) ? sub.meta.variables : [];
      const inputMap = (params.inputs && typeof params.inputs === 'object' && !Array.isArray(params.inputs))
        ? params.inputs : {};
      // selfNavigate: keep the subflow's own NAVIGATE steps and DON'T have the
      // parent pre-open a URL. Lets the subflow visit several derived pages
      // (base, base/reviews, …) built from its seeded input variables, instead
      // of the parent forcing exactly one page per invocation.
      const selfNav  = !!params.selfNavigate;

      // When inlining a subflow, its FIRST step is almost always a pinned
      // NAVIGATE to the URL it was authored on. Unless the subflow is driving
      // its own navigation (selfNavigate), the parent already opens _subPage at
      // the URL the user wants (single mode) or the current iteration's URL, so
      // re-navigating to the authored URL would just throw the work away —
      // strip that leading NAVIGATE. With selfNavigate we KEEP it: it's what
      // takes _subPage to the first (input-variable-derived) page.
      const rawSubSteps = sub.steps || [];
      const subSteps = (
        !selfNav
        && rawSubSteps.length > 0
        && rawSubSteps[0]
        && rawSubSteps[0].kind === 'action'
        && rawSubSteps[0].type === 'NAVIGATE'
      ) ? rawSubSteps.slice(1) : rawSubSteps;
      // iterate + enrich both nest the subflow one extra level deep (inside a
      // `for` loop), so they share the deeper indentation; single mode is one
      // level shallower.
      const subNested = params.mode === 'iterate' || params.mode === 'enrich';
      const subCode  = genStepList(subSteps, subCtx, subNested ? 5 : 4);
      const seedIndent = subNested ? '        ' : '      ';
      const subAliasDecls = subCtx.capturedAliases.size === 0 ? '' :
        Array.from(subCtx.capturedAliases).map(a => seedIndent + `let ${a};`).join('\n');
      // Re-declare the subflow's own variables inside its inlined closure (the
      // parent's top-level `let`s are the PARENT's variables, not the sub's).
      // Input variables are seeded from the parent mapping expression — string
      // semantics (qStr), so "{{row.url}}/reviews" and a plain literal both
      // work and it evaluates in the parent's scope via closure (e.g. `row`).
      // Others fall back to their sample value. Names already produced as a
      // captured-output alias inside the subflow are skipped (no double `let`).
      // In the PER-ROW modes (enrich / iterate) the subflow runs once per row, so
      // an input written as a whole COLUMN — {{Some List[*].link}} — is a
      // mistake: it seeds EVERY invocation with the joined value of all rows
      // ("/a,/b,/c"), and any URL built from it is garbage. The user meant the
      // current row's cell, which the surrounding loop already exposes as `row`.
      // Rewrite it — but only when the column belongs to the list being walked,
      // so a deliberate reference to a DIFFERENT table is left alone.
      const perRow = params.mode === 'enrich' || params.mode === 'iterate';
      const rowSourceName = String(params.mode === 'enrich' ? (params.sourceList || '') : (params.urlList || ''))
        .replace(/^\s*\{\{\s*/, '').replace(/\s*\}\}\s*$/, '')
        .replace(/\[\s*\*\s*\][\s\S]*$/, '').trim();
      const COLUMN_RX = /^\s*\{\{\s*([^{}[\]]+?)\s*\[\s*\*\s*\]\s*\.\s*([A-Za-z_$][\w$]*)\s*\}\}\s*$/;
      const scopeToRow = (expr) => {
        if (!perRow || typeof expr !== 'string') return expr;
        const m = expr.match(COLUMN_RX);
        if (!m) return expr;
        if (rowSourceName && m[1].trim() !== rowSourceName) return expr;
        return '{{row.' + m[2] + '}}';
      };

      const subVarSeeds = subVars.map(v => {
        if (!v || typeof v !== 'object') return null;
        const ident = toJsIdent(v.name);
        if (!ident || subCtx.capturedAliases.has(ident)) return null;
        const rawExpr = inputMap[v.name];
        const mapExpr = scopeToRow(rawExpr);
        const seed = (typeof mapExpr === 'string' && mapExpr.trim())
          ? qStr(mapExpr)
          : renderVariableLiteral(v);
        const note = mapExpr !== rawExpr
          ? `${seedIndent}// Input "${v.name}" was mapped to a whole column (${String(rawExpr).trim()}) —\n` +
            `${seedIndent}// scoped to the current row so each invocation gets its own value.\n`
          : '';
        return `${note}${seedIndent}let ${ident} = ${seed};`;
      }).filter(Boolean).join('\n');
      // Combined declarations injected at the top of the subflow closure.
      const subDecls = [subAliasDecls, subVarSeeds].filter(Boolean).join('\n');

      const safeSubName = (sub.name || 'unnamed').replace(/\*\//g, '*\\/');
      const timeoutMs   = num(advanced.timeout, execOf(ctx).navTimeoutMs);
      const concurrencyExpr = concurrencyFor(step, ctx);

      /* ── HTTP-first candidate ──────────────────────────────────────────
         When the subflow body is nothing but CSS extraction, the same body is
         ALSO compiled against fetched HTML. Both versions ship; which one runs
         is decided at runtime by scraping the first item both ways and
         comparing (see __hxSameResult). Only offered where the parent supplies
         the URL — a self-navigating subflow drives its own browser steps and
         has no single page to fetch. */
      const httpCandidate = (ctx.perf && ctx.perf.httpFirst && !selfNav)
        ? httpEligibleSteps(subSteps)
        : { eligible: false, reason: 'not enabled' };
      let httpBody = '';
      if (httpCandidate.eligible) {
        const httpCtx = {
          nextId: ctx.nextId,
          declaredVars: ctx.declaredVars,
          customActions: ctx.customActions,
          subflows: ctx.subflows,
          visitedSubflows: new Set(subCtx.visitedSubflows),
          capturedAliases: new Set(),
          perf: ctx.perf,
        exec: ctx.exec,
          httpMode: true,
        };
        httpBody = genStepList(subSteps, httpCtx, subNested ? 5 : 4);
      }
      // Runs the HTTP body over a fetched document; null means "couldn't fetch"
      // (never "no data"), so the caller can fall back rather than record a miss.
      const httpRunner = httpCandidate.eligible ? [
        `  const _httpRun_${subflowId} = async (_url) => {`,
        `    const _html = await __hxFetch(_url);`,
        `    if (_html == null) return null;`,
        `    const __$ = __hxLoad(_html);`,
        `    const __results__ = {};`,
        subDecls,
        `    try {`,
        httpBody,
        `    } catch (err) {`,
        `      console.error(${JSON.stringify(`Subflow ${outKey} HTTP extraction error:`)}, err && err.message);`,
        `      return null;`,
        `    }`,
        `    __results__._sourceUrl = String(_url);`,
        `    return __results__;`,
        `  };`,
        `  const _httpState_${subflowId} = { mode: 'undecided', gate: null };`,
      ].join('\n') : '';

      // Smart wait for the per-item navigation. This is the highest-value
      // instance of it by far: an iterate/enrich subflow performs ONE of these
      // per URL, so on a run over thousands of detail pages the saving is
      // multiplied by the row count. The selector comes from the subflow's own
      // first extraction — exactly the data each page is opened for.
      const subSmartSels = (ctx.perf && ctx.perf.smartWait)
        ? lookaheadExtractionSelectors(sub.steps || [], 0, ctx.declaredVars)
        : null;
      const subNav = (pageVar, urlExpr, pad = '      ') => subSmartSels
        ? `${pad}await ${pageVar}.goto(${urlExpr}, { waitUntil: 'domcontentloaded', timeout: ${timeoutMs} });\n`
          + `${pad}await smartWaitFor(${pageVar}, ${subSmartSels}, ${timeoutMs});`
        : `${pad}await ${pageVar}.goto(${urlExpr}, { waitUntil: 'load', timeout: ${timeoutMs} });`;

      // ── iterate mode: walk a list of URLs ────────────────────────────
      if (params.mode === 'iterate') {
        const itemVar = params.itemVar && /^[a-zA-Z_$][\w$]*$/.test(params.itemVar)
          ? params.itemVar : '_url';
        // Prefer the cleaner JS expression form (e.g. `(products || []).map(_x => _x.link)`)
        // for fields written as a single {{table[*].column}}. Falls back
        // to the template-literal `String(...)` form for hand-written
        // arrays / mixed expressions.
        const listExpr = qExpr(params.urlList || '') || `(${qStr(params.urlList || '')})`;
        const subIdJson = JSON.stringify(step.id || '');
        return [
          `// Subflow (iterate): ${safeSubName} (id ${subflowId})`,
          `{`,
          `  const _urls = ${listExpr};`,
          `  let _urlList = Array.isArray(_urls) ? _urls : [];`,
          `  if (!__results__[${JSON.stringify(outKey)}]) __results__[${JSON.stringify(outKey)}] = [];`,
          `  const _out = __results__[${JSON.stringify(outKey)}];`,
          // Resume: drop URLs a previous run already captured and pre-load its
          // rows, so a resumed run picks up exactly where the last one stopped.
          resumeSkipCode({ listVar: '_urlList', outVar: '_out', stepId: step.id, urlOf: 'String(_u)' }),
          httpRunner,
          `  __emitMark('ITER_START', {stepId: ${subIdJson}, total: _urlList.length, outKey: ${JSON.stringify(outKey)}});`,
          // One task per URL; the scheduler decides sequential vs pooled and
          // keeps `_out` in source order either way (browser/pagePool.js).
          `  await __iterateInto(browser, _urlList.length, _out, ${concurrencyExpr}, ${subIdJson}, async (_i, _getPage) => {`,
          `    const ${itemVar} = _urlList[_i];`,
          `    const row = ${itemVar};`,
          `    if (${itemVar} == null || ${itemVar} === '') return [];`,
          // Both runners close over this iteration's `row`, which the subflow's
          // seeded input variables reference — so they're built per item rather
          // than once for the loop.
          `    const _browserRun = async () => {`,
          `      const _subPage = await _getPage();`,
          // selfNavigate: the subflow's own Navigate steps drive _subPage from
          // the seeded input variables; otherwise open the iteration's URL here.
          selfNav ? `      // (self-navigate: the subflow opens its own page[s])`
                  : subNav('_subPage', `String(${itemVar})`),
          selfNav ? `` : `      await dismissConsent(_subPage);`,
          `      const _subResults = await (async (page) => {`,
          `        const __results__ = {};`,
          `        let __currentStep__ = null;`,
          subDecls,
          `        try {`,
          subCode,
          `        } catch (err) {`,
          `          console.error(${JSON.stringify(`Subflow ${outKey} iteration error:`)}, err && err.message);`,
          `        }`,
          `        return __results__;`,
          `      })(_subPage);`,
          selfNav ? `      try { _subResults._sourceUrl = _subPage.url(); } catch (_) {}`
                  : `      _subResults._sourceUrl = String(${itemVar});`,
          `      return _subResults;`,
          `    };`,
          `    try {`,
          httpCandidate.eligible
            ? `      const _subResults = await __hxDispatch(_httpState_${subflowId}, String(${itemVar}), () => _httpRun_${subflowId}(String(${itemVar})), _browserRun);`
            : `      const _subResults = await _browserRun();`,
          `      return [_subResults];`,
          `    } catch (err) {`,
          `      console.error(${JSON.stringify(`Subflow ${outKey} failed on URL`)}, ${itemVar}, '—', err && err.message);`,
          // null, not [] — the scheduler must not record a failed item as
          // finished, or a resume would skip a page that was never captured.
          `      return null;`,
          `    }`,
          `  }, (_i) => String(_urlList[_i] == null ? '' : _urlList[_i]));`,
          `  __emitMark('ITER_END', {stepId: ${subIdJson}});`,
          `}`,
          ``,
        ].filter(Boolean).join('\n');
      }

      // ── enrich mode: walk a TABLE's rows, open each row's link, and ──
      //    merge the per-page subflow results back into that same row ────
      // This is the "scrape a list, then drill into each item's detail
      // page and fold the details back into the list" pattern. Unlike
      // iterate mode (which produces a parallel array you'd have to join
      // by URL yourself), enrich emits ONE table whose rows are the source
      // rows augmented with the detail fields.
      if (params.mode === 'enrich') {
        // The source table. Use jsExpr (like a FOR_EACH source) so BOTH the
        // `{{products}}` reference form and a bare `products` variable name
        // resolve to the JS variable — not a string literal.
        const rowsExpr  = jsExpr(params.sourceList || '', '[]');
        const urlFieldJson = JSON.stringify((params.urlField && String(params.urlField).trim()) || 'link');
        const baseUrlExpr  = qStr(params.baseUrl || '');   // '' when unset
        const optsJson = JSON.stringify({
          strategy:     params.mergeStrategy || 'flat',
          detailField:  (params.detailField  && String(params.detailField).trim())  || 'detail',
          prefix:       (params.detailPrefix && String(params.detailPrefix))         || 'detail_',
          explodeField: (params.explodeField && String(params.explodeField).trim()) || '',
        });
        const subIdJson = JSON.stringify(step.id || '');
        return [
          `// Subflow (enrich rows): ${safeSubName} (id ${subflowId})`,
          `{`,
          `  const _srcRows = ${rowsExpr};`,
          `  let _rows = Array.isArray(_srcRows) ? _srcRows : [];`,   // let: resume filters it
          `  const _enrichBase = ${baseUrlExpr};`,
          // Accumulate straight into __results__ rather than into a local that
          // is only assigned across at the end. Same final array, but now the
          // rows are observable to __checkpoint WHILE the loop runs — which is
          // the whole point for an enrich over thousands of detail pages.
          // Assigned (not ||=) so a re-run of this step resets, exactly as the
          // previous end-of-loop assignment did.
          `  __results__[${JSON.stringify(outKey)}] = [];`,
          `  const _out = __results__[${JSON.stringify(outKey)}];`,
          // One definition of "this row's URL", used by BOTH the resume filter
          // and the task. If these two ever disagreed, a resume would either
          // re-scrape everything or skip rows it never captured.
          selfNav
            ? `  const _hrefOf = () => '';`
            : `  const _hrefOf = (_r) => {\n`
            + `    let _h = (_r && typeof _r === 'object' && !Array.isArray(_r)) ? _r[${urlFieldJson}] : null;\n`
            + `    if (_h == null || _h === '') return '';\n`
            + `    _h = String(_h);\n`
            + `    if (_enrichBase && !/^https?:\\/\\//i.test(_h)) { try { _h = new URL(_h, _enrichBase).href; } catch (_) {} }\n`
            + `    return _h;\n`
            + `  };`,
          selfNav ? '' : resumeSkipCode({ listVar: '_rows', outVar: '_out', stepId: step.id, urlOf: '_hrefOf(_u)' }),
          httpRunner,
          `  __emitMark('ITER_START', {stepId: ${subIdJson}, total: _rows.length, outKey: ${JSON.stringify(outKey)}});`,
          `  await __iterateInto(browser, _rows.length, _out, ${concurrencyExpr}, ${subIdJson}, async (_i, _getPage) => {`,
          `    const _row = (_rows[_i] && typeof _rows[_i] === 'object' && !Array.isArray(_rows[_i])) ? _rows[_i] : { value: _rows[_i] };`,
          `    const row = _row;`,
          // ── link-open path (default): open the row's link column on _subPage
          //    and strip the subflow's own leading Navigate. ──
          selfNav ? `    const _href = '';` : `    const _href = _hrefOf(_row);`,
          selfNav ? `` : `    // No link on this row → keep the row as-is (don't drop data).`,
          selfNav ? `` : `    if (!_href) return [Object.assign({}, _row)];`,
          `    let _subResults = {};`,
          `    const _browserRun = async () => {`,
          `      const _subPage = await _getPage();`,
          // selfNavigate: the subflow's Navigate steps (built from seeded input
          // variables) open the page[s] themselves — the parent opens nothing.
          selfNav ? `      // (self-navigate: the subflow opens its own page[s])`
                  : subNav('_subPage', '_href'),
          selfNav ? `` : `      await dismissConsent(_subPage);`,
          `      const _r = await (async (page) => {`,
          `        const __results__ = {};`,
          `        let __currentStep__ = null;`,
          subDecls,
          `        try {`,
          subCode,
          `        } catch (err) {`,
          `          console.error(${JSON.stringify(`Subflow ${outKey} enrich error:`)}, err && err.message);`,
          `        }`,
          `        return __results__;`,
          `      })(_subPage);`,
          selfNav ? `      try { _r._sourceUrl = _subPage.url(); } catch (_) {}`
                  : `      _r._sourceUrl = _href;`,
          `      return _r;`,
          `    };`,
          `    try {`,
          httpCandidate.eligible
            ? `      _subResults = await __hxDispatch(_httpState_${subflowId}, _href, () => _httpRun_${subflowId}(_href), _browserRun);`
            : `      _subResults = await _browserRun();`,
          `    } catch (err) {`,
          `      console.error(${JSON.stringify(`Subflow ${outKey} failed on URL`)}, _href, '—', err && err.message);`,
          // The source row is still emitted (dropping it would lose data the
          // parent list already had), but the item is NOT recorded as
          // finished, so a resume revisits this detail page.
          `      return { __failed: true, rows: __enrichRows(_row, {}, ${optsJson}) };`,
          `    }`,
          `    // Merge the detail results back into this row (one or more output`,
          `    // rows, depending on the chosen strategy — see __enrichRows).`,
          `    return __enrichRows(_row, _subResults, ${optsJson});`,
          `  }, (_i) => _hrefOf(_rows[_i]));`,
          `  __emitMark('ITER_END', {stepId: ${subIdJson}});`,
          `}`,
          ``,
        ].filter(Boolean).join('\n');
      }

      // ── single mode: one URL, one subflow invocation ─────────────────
      const subUrl = q(params.url || '');
      const mergeBlock = ctx.inLoop
        ? `      if (!__results__[${JSON.stringify(outKey)}]) __results__[${JSON.stringify(outKey)}] = [];\n` +
          `      __results__[${JSON.stringify(outKey)}].push(_subResults);`
        : `      __results__[${JSON.stringify(outKey)}] = _subResults;`;

      return [
        `// Subflow: ${safeSubName} (id ${subflowId})`,
        `{`,
        `  const _subUrl = ${subUrl};`,
        `  const _subPage = await __openPage(browser);`,
        `  try {`,
        // selfNavigate: the subflow's own Navigate steps open the page(s); the
        // parent doesn't pre-open _subUrl (which is optional in that case).
        selfNav ? `    // (self-navigate: the subflow opens its own page[s])`
                : subNav('_subPage', '_subUrl', '    '),
        selfNav ? `` : `    await dismissConsent(_subPage);`,
        `    const _subResults = await (async (page) => {`,
        `      const __results__ = {};`,
        `      let __currentStep__ = null;`,
        subDecls,
        `      try {`,
        subCode,
        `      } catch (err) {`,
        `        console.error(${JSON.stringify(`Subflow ${outKey} step error:`)}, err && err.message);`,
        `      }`,
        `      return __results__;`,
        `    })(_subPage);`,
        mergeBlock,
        `  } catch (err) {`,
        `    console.error(${JSON.stringify(`Subflow ${outKey} failed:`)}, err && err.message);`,
        `  } finally {`,
        `    try { await _subPage.close(); } catch (_) {}`,
        `  }`,
        `}`,
        ``,
      ].join('\n');
    }

    default:
      return `// ⚠ Unhandled action: ${type}\n`;
  }
}

/* =========================================================================
   CONTROL BLOCK CODE GENERATORS
   ========================================================================= */

function genControl(step, ctx, depth) {
  const { type, params = {} } = step;
  const indentLevel = depth;

  switch (type) {

    case 'IF': {
      // Accept {{var}} interpolation in user-typed expressions — see jsExpr.
      const expr = jsExpr(params.expression, 'false');
      const thenCode = genStepList(step.then || [], ctx, depth + 1);
      const elseCode = genStepList(step.else || [], ctx, depth + 1);
      return `if (${expr}) {\n${thenCode}} else {\n${elseCode}}\n`;
    }

    case 'FOR_EACH': {
      // jsExpr converts a pure {{products[*].link}} reference into the
      // matching JS expression so the user can drop a variable reference
      // straight in. Falls back to the historical "raw JS" mode for
      // anything else.
      const src    = jsExpr(params.source, '[]');
      const item   = params.itemVar  || 'item';
      const idx    = params.indexVar || 'index';
      // Set inLoop so RUN_SUBFLOW / extraction inside the body accumulate
      // results into an array per iteration instead of overwriting.
      const body   = genStepList(step.body || [], { ...ctx, inLoop: true }, depth + 1);
      // Iteration markers let the live "Flow" tab show "N/M iterations"
      // for each running loop. ITER_START gives the total upfront so the
      // UI can render a progress bar; ITER_TICK fires each iteration.
      const stepIdJson = JSON.stringify(step.id || '');
      return `{\n  const _src = ${src};\n  const _arr = Array.isArray(_src) ? _src : (_src || []);\n  __emitMark('ITER_START', {stepId: ${stepIdJson}, total: _arr.length});\n  for (let ${idx} = 0; ${idx} < _arr.length; ${idx}++) {\n    __emitMark('ITER_TICK', {stepId: ${stepIdJson}, index: ${idx}});\n    __checkpoint();\n    const ${item} = _arr[${idx}];\n${body}  }\n  __emitMark('ITER_END', {stepId: ${stepIdJson}});\n}\n`;
    }

    case 'FOR_EACH_ELEMENTS': {
      // Use qStr so `{{var}}` inside the selector resolves to the
      // workflow variable at runtime instead of being passed through as
      // literal text.
      const sel    = qStr(params.selector || '', ctx.declaredVars);
      const idxVar = params.indexVar || 'i';
      const elsVar = `_els_${ctx.nextId()}`;
      const elVar  = `_el_${ctx.nextId()}`;

      // Detect extraction steps in the body (top level of body only)
      const bodySteps = step.body || [];
      const hasExtractions = bodySteps.some(
        s => s.kind !== 'control' && EXTRACTION_TYPES.has(s.type)
      );

      const rowVar     = `_row_${ctx.nextId()}`;
      const resultsVar = `_rows_${ctx.nextId()}`;
      const resultsKey = (step.label && step.label.trim()) ? step.label : 'results';

      // Push forEach element context so genAction generates element-relative code
      const prevCtx = ctx.forEachEl;
      ctx.forEachEl = { elVar, rowVar, hasExtractions };
      // Mark inLoop so subflows / non-extraction-row steps in the body
      // accumulate per-iteration results instead of overwriting.
      const body = genStepList(bodySteps, { ...ctx, inLoop: true, forEachEl: ctx.forEachEl }, depth + 1);
      ctx.forEachEl = prevCtx;

      // Same "Include in final output" semantics as standalone
      // extractions — the JS alias is still emitted so the rows are
      // usable downstream even if the user opts out of putting the
      // table in the results JSON.
      const includeInOutput = (step.advanced && step.advanced.includeInOutput) !== false;
      const rkey = JSON.stringify(resultsKey);
      const aliasName = step.label && step.label.trim() ? toJsIdent(step.label.trim()) : '';
      const wantAlias = aliasName && !ctx.declaredVars?.has(aliasName);
      if (wantAlias && ctx.capturedAliases) ctx.capturedAliases.add(aliasName);

      // Writeback into __results__ and mirror the rows into a JS-visible
      // alias so downstream steps can reference the table as `<label>` (e.g.
      // a RUN_SUBFLOW enrich source). When THIS loop is itself nested inside
      // another loop (e.g. a Pagination step), accumulate across the outer
      // iterations instead of overwriting — otherwise only the last page's
      // rows survive (the "only the last page got enriched" bug).
      const writebackLines = includeInOutput
        ? (ctx.inLoop
            ? [`if (!__results__[${rkey}]) __results__[${rkey}] = [];`, `__results__[${rkey}].push(...${resultsVar});`]
            : [`__results__[${rkey}] = ${resultsVar};`])
        : [`// (${resultsKey}: kept as JS variable only — excluded from results JSON)`];
      const aliasLines = !wantAlias ? []
        : (includeInOutput
            ? (ctx.inLoop ? [`${aliasName} = __results__[${rkey}];`] : [`${aliasName} = ${resultsVar};`])
            : (ctx.inLoop
                ? [`if (!Array.isArray(${aliasName})) ${aliasName} = [];`, `${aliasName}.push(...${resultsVar});`]
                : [`${aliasName} = ${resultsVar};`]));

      // Iteration markers (see FOR_EACH for the rationale).
      const feIdJson = JSON.stringify(step.id || '');
      if (hasExtractions) {
        return [
          `const ${resultsVar} = [];`,
          `{`,
          `  const ${elsVar} = await page.$$(${sel});`,
          `  __emitMark('ITER_START', {stepId: ${feIdJson}, total: ${elsVar}.length});`,
          `  for (let ${idxVar} = 0; ${idxVar} < ${elsVar}.length; ${idxVar}++) {`,
          `    __emitMark('ITER_TICK', {stepId: ${feIdJson}, index: ${idxVar}});`,
        `    __checkpoint();`,
          `    const ${elVar} = ${elsVar}[${idxVar}];`,
          `    const ${rowVar} = { _index: ${idxVar} + 1 };`,
          body.trimEnd(),
          `    ${resultsVar}.push(${rowVar});`,
          `  }`,
          `  __emitMark('ITER_END', {stepId: ${feIdJson}});`,
          `}`,
          ...writebackLines,
          ...aliasLines,
          // Record-count / field-fill stats for the loop's rows → drives
          // self-healing when the loop selector (or an inner field) breaks.
          (step.id
            ? `await __emitStepStats(page, { stepId: ${JSON.stringify(step.id)}, type: "FOR_EACH_ELEMENTS", label: ${JSON.stringify(resultsKey)}, key: ${JSON.stringify(resultsKey)}, multiple: true }, ${resultsVar});`
            : ''),
          ``,
        ].join('\n');
      }

      return [
        `{`,
        `  const ${elsVar} = await page.$$(${sel});`,
        `  __emitMark('ITER_START', {stepId: ${feIdJson}, total: ${elsVar}.length});`,
        `  for (let ${idxVar} = 0; ${idxVar} < ${elsVar}.length; ${idxVar}++) {`,
        `    __emitMark('ITER_TICK', {stepId: ${feIdJson}, index: ${idxVar}});`,
        `    __checkpoint();`,
        `    const ${elVar} = ${elsVar}[${idxVar}];`,
        body.trimEnd(),
        `  }`,
        `  __emitMark('ITER_END', {stepId: ${feIdJson}});`,
        `}`,
        ``,
      ].join('\n');
    }

    // ── For Each Row (enrich a table with inline steps) ──────────────────
    // The no-subflow twin of RUN_SUBFLOW "enrich": iterate a table's rows,
    // run the body steps for each row (optionally after opening the row's
    // link on a fresh page), and merge the body's named results back into
    // that row via __enrichRows. The body runs in its OWN __results__ scope
    // (exactly like an inlined subflow) so named extraction steps become the
    // columns that get merged in. Row columns are reachable in the body as
    // `{{row.column}}` (or whatever `itemVar` is named).
    case 'FOR_EACH_ROW': {
      const src       = jsExpr(params.source || '', '[]');
      const itemVar   = /^[a-zA-Z_$][\w$]*$/.test(params.itemVar || '')  ? params.itemVar  : 'row';
      const idxVar    = /^[a-zA-Z_$][\w$]*$/.test(params.indexVar || '') ? params.indexVar : 'index';
      const openField = (params.openUrlField && String(params.openUrlField).trim()) || '';
      const baseUrlExpr = qStr(params.baseUrl || '');
      const timeoutMs = num(params.timeout, 30000);
      const optsJson  = JSON.stringify({
        strategy:     params.mergeStrategy || 'flat',
        detailField:  (params.detailField  && String(params.detailField).trim())  || 'detail',
        prefix:       (params.detailPrefix && String(params.detailPrefix))         || 'detail_',
        explodeField: (params.explodeField && String(params.explodeField).trim()) || '',
      });
      const outKey = (params.outputVar && String(params.outputVar).trim())
                  || (step.label && step.label.trim())
                  || 'enriched_rows';
      const idJson = JSON.stringify(step.id || '');
      const uid    = ctx.nextId();

      // Body → own alias scope, own __results__, NOT inLoop (each row's
      // extractions are captured fresh, then merged).
      const subCtx = {
        nextId: ctx.nextId, declaredVars: ctx.declaredVars,
        customActions: ctx.customActions, subflows: ctx.subflows,
        visitedSubflows: new Set(ctx.visitedSubflows || []),
        capturedAliases: new Set(),
        perf: ctx.perf,
        exec: ctx.exec,
      };
      const bodyCode = genStepList(step.body || [], subCtx, depth + 1);
      const bodyAliasDecls = subCtx.capturedAliases.size === 0 ? '' :
        Array.from(subCtx.capturedAliases).map(a => `        let ${a};`).join('\n');
      // What the body's first extraction reads — the wait target for the
      // per-row detail page (link-open mode only; current-page mode does not
      // navigate, so there is nothing to wait on).
      const rowSmartSels = (ctx.perf && ctx.perf.smartWait)
        ? lookaheadExtractionSelectors(step.body || [], 0, ctx.declaredVars)
        : null;

      // Expose the enriched table as a JS alias too (so you can chain another
      // FOR_EACH_ROW / FOR_EACH off it), mirroring FOR_EACH_ELEMENTS.
      if (ctx.topOutputs) ctx.topOutputs.add(outKey);
      const aliasName = toJsIdent(outKey);
      const aliasLine = (aliasName && !ctx.declaredVars?.has(aliasName))
        ? (ctx.capturedAliases && ctx.capturedAliases.add(aliasName),
           ctx.topAliases && ctx.topAliases.set(aliasName, outKey),
           `  ${aliasName} = _out_${uid};`)
        : '';

      // The shared per-row body IIFE — assigns into the pre-declared
      // _body_<uid>. `page` is shadowed to whichever page we run the row on.
      const runBody = (pageArg, indent) => [
        `${indent}_body_${uid} = await (async (page) => {`,
        `${indent}  const __results__ = {};`,
        `${indent}  let __currentStep__ = null;`,
        bodyAliasDecls,
        `${indent}  try {`,
        bodyCode,
        `${indent}  } catch (err) {`,
        `${indent}    console.error(${JSON.stringify(`For Each Row "${outKey}" body error:`)}, err && err.message);`,
        `${indent}  }`,
        `${indent}  return __results__;`,
        `${indent}})(${pageArg});`,
      ].filter(Boolean).join('\n');

      const rowDecl = `    const ${itemVar} = (_arr_${uid}[${idxVar}] && typeof _arr_${uid}[${idxVar}] === 'object' && !Array.isArray(_arr_${uid}[${idxVar}])) ? _arr_${uid}[${idxVar}] : { value: _arr_${uid}[${idxVar}] };`;
      const mergeLine = `    for (const _er_${uid} of __enrichRows(${itemVar}, _body_${uid}, ${optsJson})) _out_${uid}.push(_er_${uid});`;

      if (openField) {
        return [
          `{`,
          `  // For Each Row (enrich): open each row's link, run steps, merge back`,
          `  const _rows_${uid} = ${src};`,
          `  let _arr_${uid} = Array.isArray(_rows_${uid}) ? _rows_${uid} : (_rows_${uid} || []);`,  // let: resume filters it
          `  const _base_${uid} = ${baseUrlExpr};`,
          // Accumulate in place so rows are visible to __checkpoint DURING the
          // loop (see the same note on RUN_SUBFLOW enrich). Same final array.
          `  __results__[${JSON.stringify(outKey)}] = [];`,
          `  const _out_${uid} = __results__[${JSON.stringify(outKey)}];`,
          // Single definition of "this row's URL" — shared by the resume filter
          // and the task so the two can't drift (see RUN_SUBFLOW enrich).
          `  const _hrefOf_${uid} = (_r) => {`,
          `    let _h = (_r && typeof _r === 'object' && !Array.isArray(_r)) ? _r[${JSON.stringify(openField)}] : null;`,
          `    if (_h == null || _h === '') return '';`,
          `    _h = String(_h);`,
          `    if (_base_${uid} && !/^https?:\\/\\//i.test(_h)) { try { _h = new URL(_h, _base_${uid}).href; } catch (_) {} }`,
          `    return _h;`,
          `  };`,
          resumeSkipCode({ listVar: `_arr_${uid}`, outVar: `_out_${uid}`, stepId: step.id, urlOf: `_hrefOf_${uid}(_u)` }),
          `  __emitMark('ITER_START', {stepId: ${idJson}, total: _arr_${uid}.length, outKey: ${JSON.stringify(outKey)}});`,
          `  await __iterateInto(browser, _arr_${uid}.length, _out_${uid}, ${concurrencyFor(step, ctx)}, ${idJson}, async (${idxVar}, _getPage_${uid}) => {`,
          rowDecl,
          `    let _body_${uid} = {};`,
          `    const _href_${uid} = _hrefOf_${uid}(${itemVar});`,
          `    if (!_href_${uid}) return [Object.assign({}, ${itemVar})];`,
          `    const _rowPage_${uid} = await _getPage_${uid}();`,
          `    try {`,
          // Smart wait on the per-row detail page — same reasoning as the
          // subflow enrich path: one navigation per row, so the saving scales
          // with the table size. Selector comes from the body's first extraction.
          ...(rowSmartSels
            ? [`      await _rowPage_${uid}.goto(_href_${uid}, { waitUntil: 'domcontentloaded', timeout: ${timeoutMs} });`,
               `      await smartWaitFor(_rowPage_${uid}, ${rowSmartSels}, ${timeoutMs});`]
            : [`      await _rowPage_${uid}.goto(_href_${uid}, { waitUntil: 'load', timeout: ${timeoutMs} });`]),
          `      await dismissConsent(_rowPage_${uid});`,
          runBody(`_rowPage_${uid}`, '      '),
          `      _body_${uid}._sourceUrl = _href_${uid};`,
          `    } catch (err) {`,
          `      console.error(${JSON.stringify(`For Each Row "${outKey}" failed on URL`)}, _href_${uid}, '—', err && err.message);`,
          // Keep the source row, but don't record the item as finished.
          `      return { __failed: true, rows: __enrichRows(${itemVar}, {}, ${optsJson}) };`,
          `    }`,
          `    return __enrichRows(${itemVar}, _body_${uid}, ${optsJson});`,
          `  }, (${idxVar}) => _hrefOf_${uid}(_arr_${uid}[${idxVar}]));`,
          `  __emitMark('ITER_END', {stepId: ${idJson}});`,
          aliasLine,
          `}`,
          ``,
        ].filter(Boolean).join('\n');
      }

      // Current-page mode: no navigation — the body runs on the page as-is
      // (e.g. type a row value into search, click, extract), results merged
      // back into the row.
      return [
        `{`,
        `  // For Each Row (enrich): run steps per row on the current page, merge back`,
        `  const _rows_${uid} = ${src};`,
        `  const _arr_${uid} = Array.isArray(_rows_${uid}) ? _rows_${uid} : (_rows_${uid} || []);`,
        // In-place accumulation — see the link-open branch above.
        `  __results__[${JSON.stringify(outKey)}] = [];`,
        `  const _out_${uid} = __results__[${JSON.stringify(outKey)}];`,
        `  __emitMark('ITER_START', {stepId: ${idJson}, total: _arr_${uid}.length});`,
        `  for (let ${idxVar} = 0; ${idxVar} < _arr_${uid}.length; ${idxVar}++) {`,
        `    __emitMark('ITER_TICK', {stepId: ${idJson}, index: ${idxVar}});`,
        rowDecl,
        `    let _body_${uid} = {};`,
        `    try {`,
        runBody(`page`, '      '),
        `    } catch (err) {`,
        `      console.error(${JSON.stringify(`For Each Row "${outKey}" body error:`)}, err && err.message);`,
        `    }`,
        mergeLine,
        `    __checkpoint();`,
        `  }`,
        `  __emitMark('ITER_END', {stepId: ${idJson}});`,
        aliasLine,
        `}`,
        ``,
      ].filter(Boolean).join('\n');
    }


    case 'WHILE': {
      const expr = jsExpr(params.expression, 'false');
      const max  = num(params.maxIterations, 1000);
      const body = genStepList(step.body || [], { ...ctx, inLoop: true }, depth + 1);
      // Emit ITER_START/TICK/END markers like FOR_EACH so the Flow tab
      // can show the running iteration counter. `total: 0` signals
      // "unknown upfront" — the UI renders just the index when there's
      // no denominator.
      const stepIdJson = JSON.stringify(step.id || '');
      return `{
  let _whileGuard = 0;
  __emitMark('ITER_START', {stepId: ${stepIdJson}, total: 0});
  while ((${expr}) && _whileGuard < ${max}) {
    __emitMark('ITER_TICK', {stepId: ${stepIdJson}, index: _whileGuard});
    __checkpoint();
    _whileGuard++;
${body}  }
  __emitMark('ITER_END', {stepId: ${stepIdJson}});
}
`.trim() + '\n';
    }

    case 'REPEAT': {
      // num() doesn't understand {{var}} — when the user typed an
      // interpolation it would silently fall back to 10. Route through
      // jsExpr so `{{max_pages}}` resolves to the variable at runtime.
      const countRaw = (params.count === undefined || params.count === null) ? '' : String(params.count);
      const count = countRaw.includes('{{')
        ? jsExpr(countRaw, '10')
        : num(params.count, 10);
      const idx   = params.indexVar || 'i';
      const body  = genStepList(step.body || [], { ...ctx, inLoop: true }, depth + 1);
      // Emit ITER_START/TICK/END markers like the other loops so the live
      // "Flow" tab shows the running "N / M iterations" counter for REPEAT too.
      const stepIdJson = JSON.stringify(step.id || '');
      return `{
  const _rep_total = ${count};
  __emitMark('ITER_START', {stepId: ${stepIdJson}, total: _rep_total});
  for (let ${idx} = 0; ${idx} < _rep_total; ${idx}++) {
    __emitMark('ITER_TICK', {stepId: ${stepIdJson}, index: ${idx}});
    __checkpoint();
${body}  }
  __emitMark('ITER_END', {stepId: ${stepIdJson}});
}
`.trim() + '\n';
    }

    // ── Pagination: Infinite Scroll ──────────────────────────────────────
    // Scroll to the bottom repeatedly until the page stops growing for
    // `maxNoChange` consecutive scrolls, THEN run the body once against the
    // fully-loaded page. Body keeps the parent's inLoop semantics (it runs a
    // single time here, so a top-level scroll extraction just overwrites).
    case 'PAGINATE_SCROLL': {
      // Runs on the shared scroll engine (exhaustScroll → harvestWhileScrolling).
      // The old loop here teleported to document.body.scrollHeight and waited a
      // fixed delay, which skipped IntersectionObserver sentinels and gave up
      // whenever the site was slower than the guess — the two things that made
      // record counts vary between runs. It also only measured document.body,
      // so pages that scroll inside a div never advanced at all.
      const body   = genStepList(step.body || [], ctx, depth + 1);
      const idJson = JSON.stringify(step.id || '');
      const scrollExpr = qStr(params.scrollContainer || '', ctx.declaredVars);
      // A control step keeps everything on `params` (it has no `advanced` bag),
      // so the shared options builder reads its knobs from there.
      const optsJson = JSON.stringify(scrollAccuracyOpts(params, params, {
        legacyDelay: num(params.scrollDelay, 1500),
        legacyNoNew: Math.max(1, num(params.maxNoChange, 3)),
        maxScrolls:  num(params.maxIterations, 100) * 10,  // now counts scroll steps, not full-page jumps
      }));
      return `{
  // Pagination — Infinite Scroll
  __emitMark('ITER_START', {stepId: ${idJson}, total: 0});
  await exhaustScroll(page, ${scrollExpr}, ${optsJson});
  __emitMark('ITER_END', {stepId: ${idJson}});
${body}}
`;
    }

    // ── Pagination: Click a button (Next / Load more) ─────────────────────
    // Run the body on the current page, then click the next button (trying
    // the fallback selectors in order). Stops the moment no button resolves.
    // Body accumulates per-page results (inLoop = true).
    case 'PAGINATE_BUTTON': {
      const sels   = selectorList({
        selector: params.selector || '',
        selectorType: params.selectorType || 'css',
        fallbackSelectors: params.fallbackSelectors || [],
      }, ctx.declaredVars);
      const delay  = num(params.delay, 2000);
      const max    = num(params.maxIterations, 200);
      const body   = genStepList(step.body || [], { ...ctx, inLoop: true }, depth + 1);
      const idJson = JSON.stringify(step.id || '');
      return `{
  // Pagination — Click Button
  let _pageGuard = 0;
  __emitMark('ITER_START', {stepId: ${idJson}, total: 0});
  while (_pageGuard < ${max}) {
    __emitMark('ITER_TICK', {stepId: ${idJson}, index: _pageGuard});
    __checkpoint();
    _pageGuard++;
${body}    const _nextBtn = await resolveElement(page, ${sels});
    if (!_nextBtn) break;
    try {
      await _nextBtn.click();
    } catch (_) { break; }
    await new Promise(r => setTimeout(r, ${delay}));
  }
  __emitMark('ITER_END', {stepId: ${idJson}});
}
`;
    }

    // ── Pagination: URL pages (incrementing) ──────────────────────────────
    // A while-loop (NOT a fixed for-loop): build the next page's URL from the
    // pattern, navigate, and stop as soon as the page has none of the desired
    // elements — so it adapts automatically when the page count changes.
    case 'PAGINATE_URL': {
      const pattern   = params.urlPattern || '';
      const startPage = num(params.startPage, 1);
      const stepInc   = num(params.step, 1) || 1;
      const delay     = num(params.delay, 1500);
      const max       = num(params.maxIterations, 500);
      const body      = genStepList(step.body || [], { ...ctx, inLoop: true }, depth + 1);
      const idJson    = JSON.stringify(step.id || '');
      // Splice `{n}` placeholders with the live page number. Each literal
      // chunk still supports {{variable}} interpolation via qStr.
      const urlExpr = pattern.includes('{n}')
        ? pattern.split('{n}').map(p => qStr(p)).join(' + _pageNo + ')
        : qStr(pattern);
      const hasContentSel = !!(params.contentSelector && String(params.contentSelector).trim());
      const contentSels = selectorList({
        selector: params.contentSelector || '',
        selectorType: 'css',
        fallbackSelectors: [],
      }, ctx.declaredVars);
      const contentCheck = hasContentSel
        ? `    const _hasContent = await resolveElement(page, ${contentSels});\n` +
          `    if (!_hasContent) break;  // no desired elements → past the last page\n`
        : `    // (no content selector set — relying on the safety cap to stop)\n`;
      // The body runs on the CURRENT page first (the start URL is page 1),
      // THEN we navigate to the next page. So the original page is scraped
      // without a redundant re-navigation, and navigation only ever advances
      // to page 2, 3, …. The content check guards the freshly-loaded page so
      // we break before extracting an empty page.
      return `{
  // Pagination — URL Pages (while-loop; scrapes the current page first, then
  // advances page-by-page until a page has none of the desired elements)
  let _pageNo = ${startPage}, _urlGuard = 0;
  // "Scrape the current page first" only holds if we are actually ON the
  // pattern's first page. Inside a subflow the parent may have opened a
  // DIFFERENT page (e.g. it opened /room while this loop paginates
  // /room/reviews) — the first iteration would then extract from the wrong
  // page, and with a low page cap that is the only iteration, so the step
  // silently returns nothing. Compare paths (not the query) so an ordinary
  // "?page=1 vs no query" start is still scraped in place without a
  // redundant re-navigation.
  try {
    const _wantUrl = ${urlExpr};
    const _cur = new URL(page.url()), _want = new URL(_wantUrl);
    const _norm = (p) => p.replace(/\\/+$/, '');
    if (_cur.origin !== _want.origin || _norm(_cur.pathname) !== _norm(_want.pathname)) {
      await page.goto(_wantUrl, { waitUntil: 'load', timeout: 30000 });
      await dismissConsent(page);
      await new Promise(r => setTimeout(r, ${delay}));
    }
  } catch (_) { /* unparseable url → just scrape where we are */ }
  __emitMark('ITER_START', {stepId: ${idJson}, total: 0});
  while (_urlGuard < ${max}) {
    __emitMark('ITER_TICK', {stepId: ${idJson}, index: _urlGuard});
    __checkpoint();
    _urlGuard++;
${body}    _pageNo += ${stepInc};
    const _pageUrl = ${urlExpr};
    try {
      await page.goto(_pageUrl, { waitUntil: 'load', timeout: 30000 });
    } catch (_) { break; }
    await dismissConsent(page);
    await new Promise(r => setTimeout(r, ${delay}));
${contentCheck}  }
  __emitMark('ITER_END', {stepId: ${idJson}});
}
`;
    }

    case 'TRY_CATCH': {
      const errVar = params.errorVar || 'error';
      const tryCode   = genStepList(step.try   || [], ctx, depth + 1);
      const catchCode = genStepList(step.catch || [], ctx, depth + 1);
      return `try {\n${tryCode}} catch (${errVar}) {\n  console.error('Caught:', ${errVar}.message);\n${catchCode}}\n`;
    }

    default:
      return `// ⚠ Unhandled control: ${type}\n`;
  }
}

/* =========================================================================
   STEP LIST (recursive)
   Each emitted step is preceded by a STEP_BEGIN marker so the runner can
   tell which step was active when an exception is thrown. The marker is a
   single line `STEP_BEGIN:{json}` on stdout (parsed by the runner). The
   __currentStep__ assignment also lets the main catch handler include the
   failing step in its STEP_ERROR dump.
   ========================================================================= */
function stepMarker(step) {
  const info = {
    id:    step.id    || null,
    type:  step.type  || null,
    kind:  step.kind  || 'action',
    label: step.label || '',
  };
  // Routed through __emitMark so a step running inside a parallel worker is
  // tagged with its lane — otherwise N workers executing the same subflow body
  // all report the same step ids and the parent can't tell them apart.
  return `__currentStep__ = ${JSON.stringify(info)};\n__emitMark('STEP_BEGIN', ${JSON.stringify(info)});\n`;
}

/* Wrap a finished top-level step so a resume restores its output instead of
   re-running it.

   The motivating shape: paginate three pages to collect 30 links, then walk
   those links with a subflow. If the run dies during the subflow, the links
   are already captured — regenerating them costs three page loads and proves
   nothing. Restoring the saved value and skipping straight to the remaining
   links is both faster and more faithful to what the interrupted run saw.

   Applied ONLY to top-level steps that produced output. A step with nothing
   captured can't be restored, and re-running it (a navigation, a login) is
   both cheap and the safe default — so those always execute again. */
function stepResumeGuard(step, body, outputs, aliases, clean) {
  // A downloaded script has no platform to resume into, so it gets the plain
  // step code rather than a guard that can only ever take the else branch.
  if (clean) return body;
  const id = step && step.id;
  if (!id || !outputs || outputs.size === 0) {
    return body + (id ? `__stageStepDone(${JSON.stringify(id)});\n` : '');
  }
  const restore = [];
  for (const key of outputs) {
    restore.push(`  __results__[${JSON.stringify(key)}] = __resumeValue(${JSON.stringify(key)});`);
  }
  for (const [alias, key] of aliases) {
    restore.push(`  ${alias} = __results__[${JSON.stringify(key)}];`);
  }
  const name = (step.label && step.label.trim()) || step.type;
  return [
    `if (__resumeStepDone(${JSON.stringify(id)})) {`,
    ...restore,
    `  console.log(${JSON.stringify(`↻ Resume: "${name}" already finished last time — restored its data instead of re-running it.`)});`,
    `} else {`,
    body.replace(/\n(?=.)/g, '\n  ').replace(/^(?=.)/, '  '),
    `  __stageStepDone(${JSON.stringify(id)});`,
    `}`,
    ``,
  ].join('\n');
}

function genStepList(steps, ctx, depth = 0, isRoot = false) {
  const pad = '  '.repeat(depth);
  return steps.map((step, i) => {
    const marker = stepMarker(step);
    // Collect this top-level step's outputs while its code (and any loop body
    // inside it) is generated, so the guard knows what to restore.
    if (isRoot) { ctx.topOutputs = new Set(); ctx.topAliases = new Map(); }
    // Smart wait needs to know what the NEXT extraction reads, which only the
    // enclosing list can see. Computed here and handed to the step through ctx
    // (generation is synchronous and depth-first, so NAVIGATE consumes it
    // immediately); cleared afterwards so it can never leak to another step.
    if (step.type === 'NAVIGATE' && ctx.perf && ctx.perf.smartWait) {
      ctx.__lookaheadSelectors = lookaheadExtractionSelectors(steps, i + 1, ctx.declaredVars);
    }
    let raw = step.kind === 'control'
      ? genControl(step, ctx, depth)
      : genAction(step, ctx);
    ctx.__lookaheadSelectors = null;
    // Time the step. Deliberately two bare statements rather than a wrapping
    // block: steps declare `const`s that later steps read, so introducing a
    // scope here would break the workflow. Both lines are standalone, so the
    // download filter can strip them cleanly.
    if (!ctx.clean && step.id) {
      const tVar = `__ts_${ctx.nextId()}`;
      raw = `const ${tVar} = Date.now();\n${raw}`
          + `__stepTime(${JSON.stringify(step.id)}, Date.now() - ${tVar});\n`;
    }
    if (isRoot) {
      raw = stepResumeGuard(step, raw, ctx.topOutputs, ctx.topAliases, ctx.clean);
      ctx.topOutputs = null;
      ctx.topAliases = null;
    }
    const combined = marker + raw;
    return combined.split('\n').map(l => (l.trim() ? pad + l : l)).join('\n');
  }).join('');
}

/* =========================================================================
   DOWNLOAD (CLEAN) MODE HELPERS
   When a user downloads the workflow as a standalone script we strip the
   platform-only instrumentation — per-step / per-iteration log markers and
   the self-healing snapshot machinery — so the file is short and readable.
   The in-platform run path keeps everything (it needs the markers for the
   live Flow tab and the snapshots for self-healing).
   ========================================================================= */

// Self-healing / progress helpers — included ONLY for in-platform runs.
const INSTRUMENTATION_HELPERS_SRC = `/**
 * Snapshot a cleaned version of the page's HTML, useful as context to an
 * LLM-based workflow repair step.
 */
async function __snapshotPageHtml(page) {
  if (!page) return null;
  try {
    return await page.evaluate(() => {
      try {
        const root = document.documentElement.cloneNode(true);
        root.querySelectorAll('head, script, style, noscript, link, meta, template, svg').forEach(n => n.remove());
        root.querySelectorAll('*').forEach(el => {
          for (const a of Array.from(el.attributes || [])) {
            if (a.name.startsWith('on')) el.removeAttribute(a.name);
            if (a.name === 'src' && /^data:/i.test(a.value)) el.setAttribute('src', '[data-uri-removed]');
          }
        });
        let html = root.outerHTML || '';
        const LIMIT = 60000;
        if (html.length > LIMIT) html = html.slice(0, LIMIT) + '...[truncated]';
        return html;
      } catch (_) { return null; }
    });
  } catch (_) { return null; }
}

function __extractionStats(v) {
  if (Array.isArray(v)) {
    const fields = {};
    for (const row of v) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        for (const k of Object.keys(row)) {
          if (k === '_index') continue;
          const val = row[k];
          if (!fields[k]) fields[k] = { nonEmpty: 0, total: 0 };
          fields[k].total++;
          if (val != null && String(val).trim() !== '') fields[k].nonEmpty++;
        }
      }
    }
    return { count: v.length, fields };
  }
  return { count: (v == null || (typeof v === 'string' && v.trim() === '')) ? 0 : 1, fields: {} };
}

function __suspiciousStats(st, isCollection) {
  if (!st) return false;
  const c = st.count || 0;
  if (isCollection ? c <= 1 : c === 0) return true;
  for (const k of Object.keys(st.fields || {})) {
    const f = st.fields[k];
    if (f && f.total > 0 && f.nonEmpty === 0) return true;
  }
  return false;
}

function __safeUrl(page) { try { return page.url(); } catch (_) { return null; } }

async function __emitStepStats(page, info, value) {
  try {
    const st = __extractionStats(value);
    if (__suspiciousStats(st, Array.isArray(value))) {
      const html = await __snapshotPageHtml(page);
      console.log('STEP_SNAPSHOT:' + JSON.stringify({ stepId: info.stepId, url: __safeUrl(page), html: html }));
    }
    console.log('STEP_RESULT:' + JSON.stringify(Object.assign({}, info, { count: st.count, fields: st.fields })));
  } catch (_) {}
}

/* ── Durable partial results ───────────────────────────────────────────────
   Everything a run captures used to live ONLY here, in this process's memory,
   and was serialised exactly once — the single WORKFLOW_RESULTS: line at the
   end. A crash / timeout / OOM / cancel anywhere before that lost the lot. On
   a job spanning thousands of detail pages that is hours of work gone.

   Now the parent accumulates these deltas as they arrive, so the data is out
   of this process long before it dies — which is why it survives even SIGKILL.

   DELTAS, not snapshots: re-emitting the whole result set every iteration
   would be O(n²) stdout on a run with thousands of rows. Array keys send only
   their new tail; scalars only when they change.

   __rootResults is captured once by run() so that call sites nested inside a
   subflow closure — which shadows __results__ with its own object — still
   checkpoint the ROOT results, never the subflow's private ones. A subflow's
   rows land in the root right after its closure returns, so the next
   checkpoint picks them up. */
let __rootResults = null;
const __sentCounts  = Object.create(null);   // key → array elements already sent
const __sentScalars = Object.create(null);   // key → last encoding sent
let __lastCheckpointMs = 0;
const __CHECKPOINT_MS = 1500;

/* ── "Done" means SAVED ────────────────────────────────────────────────────
   Completed items and completed steps are staged here and only leave the
   process inside a RESULT_CHUNK — the same message that carries their rows.

   They used to be announced the instant a task returned, independently of the
   data. That is a data-loss bug on resume: the parent could be told "these 3
   URLs are finished" while only the first one's row had actually made it out,
   so the resume skipped two items whose data was never stored. Staging them
   here means the ledger and the rows are published together or not at all —
   if the run dies in between, BOTH are lost and the resume re-scrapes those
   items, which is the safe direction to be wrong in. */
const __pendingItems = Object.create(null);  // stepId → [url] finished + committed
let   __pendingSteps = [];                   // [stepId] whole steps finished

/* ── Per-step timing ───────────────────────────────────────────────────────
   Measured inside the generated code rather than inferred from the gap
   between STEP_BEGIN markers, because under parallelism those interleave
   across workers and can't be attributed to anything.

   Both a count and a total are kept, which is what lets the UI say the right
   thing in each place: a step that ran once reports its duration, a step
   inside a loop ran N times and reports the average, and the loop itself ran
   once and reports the whole thing. */
const __stepTimes = Object.create(null);     // stepId → { n, ms }
function __stepTime(id, ms) {
  if (!id) return;
  const e = __stepTimes[id] || (__stepTimes[id] = { n: 0, ms: 0 });
  e.n += 1;
  e.ms += ms;
}

/* ── Worker lane context ───────────────────────────────────────────────────
   When a loop runs N workers, all N execute the SAME subflow body, so every
   marker they emit carries the same step ids. A nested loop's counter then
   reads as one sequence when it is really N interleaved ones — the "11, 6, 2,
   4, 12…" jumping — and tells you nothing about any of them.

   AsyncLocalStorage carries which lane the currently-executing code belongs
   to, without threading a parameter through every generated call. Markers
   emitted inside a worker are tagged with it, so the parent can keep the lanes
   apart instead of overwriting one with another. */
const __laneStore = new (require('async_hooks').AsyncLocalStorage)();
function __inLane(owner, lane, item, fn) {
  return __laneStore.run({ owner: owner, lane: lane, item: item }, fn);
}

// Emit a structured marker, tagged with the worker lane when inside one.
function __emitMark(kind, obj) {
  try {
    const s = __laneStore.getStore();
    if (s) { obj.owner = s.owner; obj.lane = s.lane; obj.item = s.item; }
    console.log(kind + ':' + JSON.stringify(obj));
  } catch (_) {}
}

function __stageItemDone(stepId, url) {
  if (!stepId || url == null || url === '') return;
  (__pendingItems[stepId] || (__pendingItems[stepId] = [])).push(String(url));
}
function __stageStepDone(stepId) {
  if (stepId) __pendingSteps.push(String(stepId));
}

function __checkpoint(force) {
  try {
    if (!__rootResults) return;
    const now = Date.now();
    if (!force && now - __lastCheckpointMs < __CHECKPOINT_MS) return;
    __lastCheckpointMs = now;
    const delta = {};
    let has = false;
    for (const k of Object.keys(__rootResults)) {
      const v = __rootResults[k];
      if (Array.isArray(v)) {
        const sent = __sentCounts[k] || 0;
        if (v.length > sent) {
          delta[k] = { append: v.slice(sent) };
          __sentCounts[k] = v.length;
          has = true;
        } else if (v.length < sent) {
          // Shrank ⇒ the array was replaced wholesale (a step re-ran and reset
          // it). Resend in full so the parent doesn't keep stale rows. A
          // replacement of equal-or-greater length isn't detectable here and
          // is accepted: on a clean finish WORKFLOW_RESULTS is authoritative,
          // and partial data is best-effort by definition.
          delta[k] = { set: v.slice() };
          __sentCounts[k] = v.length;
          has = true;
        }
      } else if (v !== null && v !== undefined) {
        const enc = JSON.stringify(v);
        if (__sentScalars[k] !== enc) {
          delta[k] = { set: v };
          __sentScalars[k] = enc;
          has = true;
        }
      }
    }
    // Drain the ledger INTO this chunk. Reading __rootResults and the staged
    // ledger in one synchronous pass is what makes them consistent: anything
    // staged is already in the results above, because a slot commits its rows
    // before staging its url.
    const doneItems = {};
    let hasDone = false;
    for (const k of Object.keys(__pendingItems)) {
      if (__pendingItems[k].length) { doneItems[k] = __pendingItems[k]; __pendingItems[k] = []; hasDone = true; }
    }
    const doneSteps = __pendingSteps;
    if (doneSteps.length) { __pendingSteps = []; hasDone = true; }

    // Timings ride along whole rather than as a delta — one entry per step is
    // a few hundred bytes at most, so the parent can simply take the latest.
    const hasTimes = Object.keys(__stepTimes).length > 0;

    if (has || hasDone || hasTimes) {
      console.log('RESULT_CHUNK:' + JSON.stringify({
        rows: has ? delta : undefined,
        doneItems: hasDone && Object.keys(doneItems).length ? doneItems : undefined,
        doneSteps: doneSteps.length ? doneSteps : undefined,
        times: hasTimes ? __stepTimes : undefined,
      }));
    }
  } catch (_) {}
}

/* Graceful cancel: the parent sends SIGTERM and only escalates to SIGKILL
   after a grace window, so flush the tail of the data first. Belt-and-braces
   — the parent already holds everything up to the last checkpoint. */
process.on('SIGTERM', () => {
  try { __checkpoint(true); } catch (_) {}
  process.exit(143);
});`;

/* =========================================================================
   ENRICH RUNTIME — merge a subflow's per-page results back into a source row
   -------------------------------------------------------------------------
   Used by RUN_SUBFLOW "enrich" mode. Lives in BOTH platform and downloaded
   scripts (it's behaviour, not instrumentation), so it is included on demand
   — only when the generated code actually references __enrichRows.

   Returns an ARRAY of output rows. Every strategy yields exactly one row
   except "explode", which denormalises a one-to-many: it emits one output
   row per item of a chosen list field (parent columns copied down). This is
   the answer to "what do I do when the detail page itself has a list?":
     • flat   → list stays as a nested array in one column (default)
     • nest   → the whole detail object goes under one column
     • prefix → detail columns added with a prefix (avoids name clashes)
     • explode→ list becomes multiple flat rows
   ========================================================================= */
const ENRICH_RUNTIME_SRC = `/**
 * Merge a subflow's collected results (\`sub\`) into a source table row
 * (\`row\`) and return the resulting output row(s). See codegen header for the
 * strategy semantics.
 */
function __enrichRows(row, sub, opts) {
  opts = opts || {};
  const strategy = opts.strategy || 'flat';
  const base = (row && typeof row === 'object' && !Array.isArray(row)) ? row : {};
  // The subflow attaches bookkeeping keys to its own __results__; don't leak
  // them into the merged row as data columns (keep _sourceUrl though — it's
  // useful provenance and callers can drop it if they want).
  const detail = {};
  for (const k of Object.keys(sub || {})) {
    if (k === '_index') continue;
    detail[k] = sub[k];
  }
  if (strategy === 'nest') {
    const out = Object.assign({}, base);
    out[opts.detailField || 'detail'] = detail;
    return [out];
  }
  if (strategy === 'prefix') {
    const out = Object.assign({}, base);
    const p = opts.prefix || 'detail_';
    for (const k of Object.keys(detail)) out[p + k] = detail[k];
    return [out];
  }
  if (strategy === 'explode') {
    // Pick the list to explode: the named field, else the first array value.
    let listKey = opts.explodeField || '';
    if (!listKey || !Array.isArray(detail[listKey])) {
      for (const k of Object.keys(detail)) { if (Array.isArray(detail[k])) { listKey = k; break; } }
    }
    const list = listKey ? detail[listKey] : null;
    // Everything that ISN'T the exploded list rides along on every output row.
    const rest = Object.assign({}, base);
    for (const k of Object.keys(detail)) { if (k !== listKey) rest[k] = detail[k]; }
    // Empty / missing list → keep a single row so the source row isn't lost.
    if (!Array.isArray(list) || list.length === 0) return [rest];
    return list.map(item =>
      (item && typeof item === 'object' && !Array.isArray(item))
        ? Object.assign({}, rest, item)                       // object item → its keys become columns
        : Object.assign({}, rest, { [listKey || 'item']: item }) // scalar item → single column
    );
  }
  // flat (default): detail keys become columns on the row; any list value
  // simply stays a nested array in its column.
  return [Object.assign({}, base, detail)];
}`;

/* Build the scroll-engine options shared by COLLECT_LIST and PAGINATE_SCROLL.

   Accuracy mode is ON by default — it is what makes a run reproducible, and a
   scrape that quietly returns a different number of records each time is worse
   than a slow one. Untick "Accuracy mode" to get the old fast-but-approximate
   behaviour, which the same engine reproduces from these parameters.

   `legacy*` are the pre-existing per-step settings; they only take effect when
   accuracy mode is off, so turning it off restores the previous timings exactly. */
function scrollAccuracyOpts(params, advanced, { legacyDelay, legacyNoNew, maxScrolls }) {
  const a = advanced || {};
  const accuracy = a.scrollAccuracy !== false;
  const overlapRaw = Number(a.scrollOverlap);
  const trimmed = (v) => (v && String(v).trim()) || '';
  return {
    accuracy,
    // Legacy timing knobs (used verbatim when accuracy is off).
    scrollDelay: legacyDelay,
    maxNoNew:    legacyNoNew,
    maxScrolls,
    overlap: (Number.isFinite(overlapRaw) && overlapRaw >= 0 && overlapRaw < 0.95) ? overlapRaw : 0.35,
    // Accuracy knobs.
    stepPx:        Math.max(24, num(a.scrollStepPx, 250)),
    settleQuietMs: Math.max(50, num(a.settleQuietMs, 500)),
    settleMaxMs:   Math.max(500, num(a.settleMaxMs, 30000)),
    maxPasses:     Math.max(1, num(a.verifyPasses, 3)),
    debug:         a.debugScrolling === true,
    // Page-provided completion signals.
    loadingSelector:  trimmed(a.loadingSelector),
    endSelector:      trimmed(a.endSelector),
    expectedSelector: trimmed(a.expectedCountSelector),
  };
}

/* =========================================================================
   HARVEST RUNTIME — collect a list WHILE scrolling (infinite / virtual lists)
   -------------------------------------------------------------------------
   Used by the COLLECT_LIST action. Extracts the currently-rendered items on
   every scroll step and de-dupes by a key, so it works even when the page
   RECYCLES rows out of the DOM once they scroll out of view (virtualized
   lists) — a single end-of-page query would miss almost everything there.
   Included on demand in both platform and downloaded scripts.
   ========================================================================= */
const HARVEST_RUNTIME_SRC = `/**
 * Collect a repeating list while scrolling — built for accuracy first.
 *   page         – puppeteer page
 *   containerSel – CSS selector for each repeating item
 *   fields       – { name: { selector, kind:'text'|'attr'|'html', attribute } }
 *   keyField     – field to de-dupe on ('' → intrinsic row id, else whole row)
 *   scrollSel    – scroll container selector ('' → scroll the window)
 *   opts         – { accuracy, scrollDelay, maxNoNew, maxScrolls, overlap,
 *                    stepPx, settleQuietMs, settleMaxMs, bottomWaitsMs,
 *                    maxPasses, loadingSelector, endSelector, expectedSelector }
 *
 * WHY THIS IS NOT A SIMPLE LOOP
 * Three things silently lose records on real infinite-scroll pages:
 *   1. Jumping the scroll position. Most sites load more via an
 *      IntersectionObserver on a sentinel near the list end. The browser only
 *      fires those callbacks when intersection state changes BETWEEN FRAMES, so
 *      a one-assignment jump over the sentinel can be missed entirely and the
 *      next batch never loads. We therefore TRAVERSE every scroll distance in
 *      small steps with a rAF yield between them (accuracy mode).
 *   2. Waiting a fixed number of milliseconds. If the site's fetch is slower
 *      than the guess, the harvest sees nothing new and starts counting toward
 *      "done" — so the record count tracks network latency and varies run to
 *      run. We instead settle on real signals: zero in-flight requests AND no
 *      DOM mutations for a quiet window.
 *   3. Giving up at the bottom too early. We escalate patience (1s→2s→4s…) and
 *      JIGGLE between tries — scroll up and back down — because a loader that
 *      already fired at this position will only fire again on a NEW crossing.
 *
 * How it knows it's "done" (strongest → weakest):
 *   1. expectedSelector  → a total shown on the page ("340 results"); stop when
 *      collected ≥ that number, and REPORT if we fall short.
 *   2. endSelector       → an explicit "no more results" element appears.
 *   3. bottom-stable     → at the bottom, the full patience ladder elapsed with
 *      no new items AND no growth in scroll height.
 * Then, in accuracy mode, it VERIFIES: return to the top and sweep again. A
 * pass that adds nothing proves the previous pass saw everything reachable;
 * a pass that adds something proves it did not, and we sweep again.
 *
 * Emits COLLECT_SUMMARY with { collected, expected, complete, reason, passes,
 * verified }. Returns the de-duplicated items in first-seen order.
 */
async function harvestWhileScrolling(page, containerSel, fields, keyField, scrollSel, opts) {
  opts = opts || {};
  // Accuracy mode is the default. accuracy:false reproduces the old fast
  // behaviour by degrading the same engine's parameters — one code path.
  const accurate    = opts.accuracy !== false;
  const legacyDelay = Math.max(0, opts.scrollDelay || 1200);
  const maxNoNew    = Math.max(1, opts.maxNoNew || 3);
  const maxScrolls  = opts.maxScrolls || 300;
  const overlap     = (typeof opts.overlap === 'number' && opts.overlap >= 0 && opts.overlap < 0.95) ? opts.overlap : 0.35;
  const stepPx      = Math.max(24, opts.stepPx || 250);
  const settleQuiet = Math.max(50, opts.settleQuietMs || 500);
  const settleMax   = Math.max(500, opts.settleMaxMs || 30000);
  const loadingSel  = opts.loadingSelector || '';
  const endSel      = opts.endSelector || '';
  const expectSel   = opts.expectedSelector || '';
  // Escalating patience at the bottom (accuracy) vs a flat retry count (legacy).
  const ladder = accurate
    ? (Array.isArray(opts.bottomWaitsMs) && opts.bottomWaitsMs.length ? opts.bottomWaitsMs : [1000, 2000, 4000, 8000, 15000])
    : new Array(maxNoNew).fill(legacyDelay);
  const maxPasses = accurate ? Math.max(1, opts.maxPasses || 3) : 1;
  // Per-step trace. Turn on with the "Debug scrolling" advanced option when a
  // page collects fewer records than it should — each line shows where the
  // scroller actually got to, so a stall is visible instead of guessed at.
  const dbg = !!opts.debug;

  const seen = new Set();
  const out  = [];
  let dupInBatch = 0;     // proof that whole-row de-duping is collapsing records
  let lastGrowth = 0;     // px the page grew on the last load — sizes the back-off
  let totalGrowth = 0;    // px added since the sweep began — bounds it
  let stuck = false;      // the scroll container never moved

  // ── Network activity tracker ────────────────────────────────────────────
  // Passive listeners (no interception), so nothing about the page changes.
  let inflight = 0;
  let netAt = Date.now();
  const onReq  = () => { inflight++; netAt = Date.now(); };
  const onDone = () => { inflight = Math.max(0, inflight - 1); netAt = Date.now(); };
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  const disposeNet = () => {
    try {
      page.removeListener('request', onReq);
      page.removeListener('requestfinished', onDone);
      page.removeListener('requestfailed', onDone);
    } catch (_) {}
  };

  // ── DOM mutation probe (page side) ──────────────────────────────────────
  // Re-installed on demand: a navigation wipes it.
  const installProbe = () => page.evaluate(() => {
    if (window.__hvProbe) return;
    window.__hvMutAt = Date.now();
    var mo = new MutationObserver(function () { window.__hvMutAt = Date.now(); });
    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
    window.__hvProbe = mo;
  }).catch(() => {});
  const domIdleFor = () => page.evaluate(() => Date.now() - (window.__hvMutAt || 0)).catch(() => 1e9);

  // A short wait for the browser to RENDER what the scroll just revealed —
  // enough for a virtualized list to paint its new rows. Deliberately not the
  // full network settle: doing that after every scroll step is what made the
  // sweep crawl. Real load-waiting happens at the bottom, where it matters.
  const renderTick = async () => {
    if (!accurate) { await new Promise(r => setTimeout(r, legacyDelay)); return; }
    await new Promise(r => setTimeout(r, 60));
    const t0 = Date.now();
    while (Date.now() - t0 < 900) {
      if (await domIdleFor() >= 80) return;
      await new Promise(r => setTimeout(r, 50));
    }
  };

  const present = (sel) => sel
    ? page.evaluate(s => !!document.querySelector(s), sel).catch(() => false)
    : Promise.resolve(false);

  // Wait until the page is genuinely quiet: no in-flight requests, no DOM
  // mutations, no loading indicator — each for settleQuiet ms. Returns false
  // if the hard cap was hit (page never went quiet), which is reported.
  const settle = async () => {
    if (!accurate) { await new Promise(r => setTimeout(r, legacyDelay)); return true; }
    await installProbe();
    const t0 = Date.now();
    while (Date.now() - t0 < settleMax) {
      await new Promise(r => setTimeout(r, 100));
      if (inflight > 0) continue;
      if (Date.now() - netAt < settleQuiet) continue;
      if (loadingSel && await present(loadingSel)) continue;
      if (await domIdleFor() < settleQuiet) continue;
      return true;
    }
    return false;
  };

  // ── Extraction ──────────────────────────────────────────────────────────
  // __hvKey is an INTRINSIC row identity (id / data-* / first link href). It
  // survives virtualization — unlike a DOM index — and distinguishes two rows
  // whose visible text happens to match, which a whole-row hash cannot.
  const extractVisible = () => page.evaluate((sel, fieldMap) => {
    const __isX = (s) => { if (typeof s !== 'string') return false; s = s.replace(/^\\s+/, ''); return s[0] === '/' || s[0] === '(' || (s[0] === '.' && s[1] === '/'); };
    const __relChild = (root, s) => {
      if (!s) return root;
      if (__isX(s)) { try { return document.evaluate(s, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (_) { return null; } }
      try { return root.querySelector(s); } catch (_) { return null; }
    };
    const __identity = (el) => {
      try {
        var a = el.id || el.getAttribute('data-id') || el.getAttribute('data-key')
             || el.getAttribute('data-item-id') || el.getAttribute('data-testid')
             || el.getAttribute('data-index') || el.getAttribute('data-sku');
        if (a) return 'a:' + a;
        var link = el.matches && el.matches('a[href]') ? el : el.querySelector('a[href]');
        if (link) { var h = link.getAttribute('href'); if (h) return 'h:' + h; }
      } catch (_) {}
      return null;
    };
    return Array.from(document.querySelectorAll(sel)).map(el => {
      const item = {};
      for (const [name, spec] of Object.entries(fieldMap)) {
        const s = spec.selector || '';
        const child = __relChild(el, s);
        if (!child) { item[name] = null; continue; }
        if (spec.kind === 'attr' && spec.attribute) item[name] = child.getAttribute(spec.attribute);
        else if (spec.kind === 'html') item[name] = (child.innerHTML || '').trim();
        else item[name] = (child.textContent || '').trim();
      }
      const id = __identity(el);
      if (id) item.__hvKey = id;
      return item;
    });
  }, containerSel, fields);

  const keyOf = (row) => {
    if (keyField && row && Object.prototype.hasOwnProperty.call(row, keyField)) {
      const v = row[keyField];
      if (v != null && String(v).trim() !== '') return 'k:' + String(v);
    }
    if (row && row.__hvKey) return row.__hvKey;
    return JSON.stringify(row);
  };

  const harvest = async () => {
    let added = 0, rows = [];
    try { rows = await extractVisible(); } catch (_) { rows = []; }
    const batch = new Set();
    for (const row of rows) {
      const k = keyOf(row);
      // Two rows on screen AT THE SAME TIME sharing a key proves the key is not
      // unique — real records are being merged away. Surfaced in the summary.
      if (batch.has(k)) dupInBatch++; else batch.add(k);
      if (seen.has(k)) continue;
      seen.add(k);
      if (row && row.__hvKey !== undefined) delete row.__hvKey;
      out.push(row); added++;
    }
    return added;
  };

  // ── Scrolling ───────────────────────────────────────────────────────────
  // Advance by one OVERLAPPING window (so consecutive harvests overlap and no
  // band of a virtualized list is skipped), but TRAVERSE that distance in small
  // rAF-separated steps so every sentinel gets an intersecting frame.
  const scrollBy = (deltaFactor) => page.evaluate(async (sSel, ov, px, smooth, factor) => {
    const t = sSel ? document.querySelector(sSel) : null;
    const view = t ? t.clientHeight : window.innerHeight;
    const getMax = () => t ? t.scrollHeight : (document.scrollingElement || document.documentElement || document.body).scrollHeight;
    const getPos = () => t ? t.scrollTop : (window.scrollY || 0);
    const setPos = (v) => { if (t) t.scrollTop = v; else window.scrollTo(0, v); };
    if (sSel && !t) return { missing: true, atBottom: false, moved: false, max: 0, view: 0, fits: false };
    // CSS smooth scrolling turns every position assignment into an ANIMATION.
    // The scraper would then advance ~30px per step instead of a viewport, read
    // its own position wrong, and burn the whole scroll budget a fifth of the
    // way down the page. Force instant scrolling for the duration of the run.
    try {
      (t ? [t] : [document.documentElement, document.body]).forEach(function (e) {
        if (e && e.style) e.style.scrollBehavior = 'auto';
      });
    } catch (_) {}
    // Yield a frame, but never hang: requestAnimationFrame is paused entirely in
    // a backgrounded or non-composited tab (which is how the platform often runs
    // the page), and a traversal that waits forever on it would stall the run.
    const frame = () => new Promise(r => {
      let done = false;
      const fin = () => { if (!done) { done = true; r(); } };
      try { requestAnimationFrame(fin); } catch (_) {}
      setTimeout(fin, 250);
    });
    const before = getPos();
    const span = Math.max(40, Math.round(view * (1 - ov))) * (factor || 1);
    // The furthest a scroller can actually go is scrollHeight - clientHeight;
    // clamping to scrollHeight would walk the traversal past reachable ground.
    const limit = Math.max(0, getMax() - view);
    const target = Math.max(0, Math.min(before + span, limit));
    if (smooth && Math.abs(target - before) > px) {
      const dir = target > before ? 1 : -1;
      let p = before;
      while ((dir > 0 && p < target) || (dir < 0 && p > target)) {
        p = dir > 0 ? Math.min(p + px, target) : Math.max(p - px, target);
        setPos(p);
        await frame();
      }
    } else {
      setPos(target);
    }
    const after = getPos();
    const max = getMax();
    return {
      atBottom: (after + view >= max - 2) || (after <= before + 1 && factor > 0),
      moved: Math.abs(after - before) > 1,
      max, view, before, after,
      fits: max <= view + 2,      // nothing to scroll: content fits the viewport
      missing: false,
    };
  }, scrollSel, overlap, stepPx, accurate, deltaFactor);

  const scrollToTop = () => page.evaluate(async (sSel, px, smooth) => {
    const t = sSel ? document.querySelector(sSel) : null;
    const setPos = (v) => { if (t) t.scrollTop = v; else window.scrollTo(0, v); };
    const getPos = () => t ? t.scrollTop : (window.scrollY || 0);
    if (!smooth) { setPos(0); return; }
    const frame = () => new Promise(r => {
      let done = false;
      const fin = () => { if (!done) { done = true; r(); } };
      try { requestAnimationFrame(fin); } catch (_) {}
      setTimeout(fin, 250);
    });
    // Traverse upward too — some lists lazy-load on upward crossings as well.
    let p = getPos();
    while (p > 0) { p = Math.max(0, p - px * 4); setPos(p); await frame(); }
  }, scrollSel, stepPx, accurate).catch(() => {});

  const scrollHeight = () => page.evaluate((sSel) => {
    const t = sSel ? document.querySelector(sSel) : null;
    return t ? t.scrollHeight : (document.scrollingElement || document.documentElement || document.body).scrollHeight;
  }, scrollSel).catch(() => 0);

  // Scroll to an ABSOLUTE position, traversed in steps so every band between
  // here and there gets a frame (a lazy-load trigger can sit anywhere).
  const scrollTo = (y) => page.evaluate(async (sSel, target, px, smooth) => {
    const t = sSel ? document.querySelector(sSel) : null;
    const setPos = (v) => { if (t) t.scrollTop = v; else window.scrollTo(0, v); };
    const getPos = () => t ? t.scrollTop : (window.scrollY || 0);
    try {
      (t ? [t] : [document.documentElement, document.body]).forEach(function (e) {
        if (e && e.style) e.style.scrollBehavior = 'auto';
      });
    } catch (_) {}
    const frame = () => new Promise(r => {
      let done = false;
      const fin = () => { if (!done) { done = true; r(); } };
      try { requestAnimationFrame(fin); } catch (_) {}
      setTimeout(fin, 250);
    });
    if (!smooth) { setPos(target); return getPos(); }
    let p = getPos();
    const dir = target > p ? 1 : -1;
    while ((dir > 0 && p < target) || (dir < 0 && p > target)) {
      p = dir > 0 ? Math.min(p + px, target) : Math.max(p - px, target);
      setPos(p);
      await frame();
    }
    return getPos();
  }, scrollSel, Math.max(0, Math.round(y)), stepPx, accurate).catch(() => 0);

  // Re-walk the TAIL of the page slowly, pausing at each stop.
  //
  // Sitting at the very bottom is not enough: the element that triggers the next
  // load is often well ABOVE the page end (on lock.me it sits 809px above it, so
  // at the bottom it is off-screen and never fires). Backing off by a fixed
  // amount is a guess that can miss by pixels. Instead, cover the whole final
  // stretch — every position in the last ~2.5 viewports gets real viewport time,
  // so a trigger anywhere in that band is seen. Stops as soon as content grows.
  //
  // How far back it goes ESCALATES with each failed attempt, because the right
  // distance is unknowable up front: a batch that added 8000px moved the trigger
  // 8000px away from where we are standing.
  //
  // It never goes back further than the page has GROWN, though. Everything added
  // since this sweep began lies inside the last totalGrowth px; anything above
  // that was already walked on the way down and cannot hold a trigger we have
  // not already crossed. Re-walking from the top would burn a lot of time to
  // cover ground that is provably uninteresting.
  const tailSweep = async (attempt) => {
    const m = await metrics();
    if (!m.view || m.max <= m.view) return false;
    const bottom = Math.max(0, m.max - m.view);
    const a = attempt || 0;
    const back = a === 0 ? m.view * 1.5
               : a === 1 ? m.view * 3
               : a === 2 ? Math.max(m.view * 6, lastGrowth)
               : Math.max(m.view * 6, totalGrowth);   // never past what grew
    const start = Math.max(0, bottom - back);
    // Keep the number of stops bounded when the span is huge (a whole page).
    const stride = Math.max(Math.round(m.view * 0.5), Math.ceil((bottom - start) / 40));
    for (let y = start; y <= bottom; y += stride) {
      const landed = await scrollTo(y);
      // If the scroller will not move at all there is no point walking the rest
      // of the tail — every stop would be the same position.
      if (y > start + stride && Math.abs(landed - y) > m.view && landed === 0) return false;
      await new Promise(r => setTimeout(r, 220));
      if (await scrollHeight() > m.max + 8) return true;   // something loaded
    }
    await scrollTo(bottom);
    await new Promise(r => setTimeout(r, 220));
    return (await scrollHeight()) > m.max + 8;
  };

  // Current geometry, read fresh. The first sense reading goes stale as soon as
  // content loads, and the "is this list actually short?" verdict must be made
  // on what the page looks like NOW, not on what it looked like before waiting.
  const metrics = () => page.evaluate((sSel) => {
    const t = sSel ? document.querySelector(sSel) : null;
    const view = t ? t.clientHeight : window.innerHeight;
    const max = t ? t.scrollHeight : (document.scrollingElement || document.documentElement || document.body).scrollHeight;
    return { view, max, fits: max <= view + 2, pos: t ? t.scrollTop : (window.scrollY || 0) };
  }, scrollSel).catch(() => ({ view: 0, max: 0, fits: false, pos: 0 }));

  // First number in the expected-total element ("Showing 1–20 of 340" → 340;
  // takes the largest number so "1-20 of 340" resolves to the total).
  const expected = expectSel ? await page.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) return null;
    const nums = (el.textContent || '').replace(/[,\\.\\s]/g, '').match(/\\d+/g);
    if (!nums) return null;
    return nums.map(Number).reduce((a, b) => Math.max(a, b), 0);
  }, expectSel).catch(() => null) : null;

  // ── One downward sweep, from wherever we are to the end of the list ──────
  const sweepDown = async (isVerify) => {
    let reason = 'safety-cap';
    let everMoved = false;
    let noProgress = 0;
    for (let i = 0; i < maxScrolls; i++) {
      if (expected != null && out.length >= expected) return 'reached-expected-total';
      if (await present(endSel)) return 'end-marker';

      let sense = { atBottom: false, moved: false, fits: false, missing: false };
      try { sense = await scrollBy(1); } catch (_) {}

      if (sense.missing) { stuck = true; return 'scroll-container-missing'; }
      // NEVER conclude anything from the first step. An infinite-scroll page
      // very often starts with barely one screen of content, so the first
      // attempt cannot move and the content "fits" — concluding there is
      // nothing to scroll would end the run before a single batch had loaded.
      // Whether the page is genuinely short, genuinely stuck, or just has not
      // loaded yet is decided AFTER the patience ladder below, which gives
      // lazy loading a real chance to produce something.
      if (dbg) console.log('SCROLL_STEP:' + JSON.stringify({
        i, pos: sense.after, was: sense.before, max: sense.max, view: sense.view,
        moved: sense.moved, atBottom: sense.atBottom, fits: sense.fits, have: out.length,
      }));
      if (sense.moved) { everMoved = true; noProgress = 0; }
      else if (!sense.atBottom) {
        // Asked to move and nothing happened, but we are not at the end either:
        // the site is fighting the scroll (hijacked wheel, snap points, a
        // rewritten position). Jump straight to the bottom rather than spending
        // the whole step budget inching forward.
        if (++noProgress >= 2) { await scrollBy(99); noProgress = 0; }
      }

      await renderTick();
      if (await harvest() > 0) continue;
      if (!sense.atBottom) continue;    // mid-list quiet step: keep going

      // Only now, at the end of the content, is it worth waiting for the
      // network and the DOM to genuinely go quiet.
      const settled = await settle();
      if (await harvest() > 0) continue;

      // At the bottom with nothing new. Escalate patience, and re-arm the
      // loader between tries — an IntersectionObserver that already fired here
      // will not fire again without a fresh crossing.
      let recovered = false;
      const hBefore = await scrollHeight();
      let attempt = 0;
      // A page that has never scrolled AND still fits cannot be waiting on a
      // scroll-triggered loader, so it only gets the first few rungs — enough
      // for a slow async render, without making every short list cost the full
      // ladder. Anything that has scrolled gets the whole budget.
      const fitsNow = (await metrics()).fits;
      const rungs = (!everMoved && fitsNow) ? ladder.slice(0, 3) : ladder;
      for (const wait of rungs) {
        if (accurate && await tailSweep(attempt++)) { recovered = true; break; }
        await new Promise(r => setTimeout(r, wait));
        await settle();
        if (await harvest() > 0) { recovered = true; break; }
        // Growth means content IS arriving even though no new key surfaced yet
        // (it may be below us, or we are not harvesting at all — exhaustScroll).
        // Checked per rung, not just after the ladder: otherwise every batch of
        // a long list would cost the ladder's whole budget.
        const hNow = await scrollHeight();
        if (hNow > hBefore + 8) {
          lastGrowth = Math.max(lastGrowth, hNow - hBefore);
          totalGrowth += hNow - hBefore;
          recovered = true; break;
        }
        if (await present(endSel)) return 'end-marker';
      }
      if (recovered) continue;
      if (dbg) console.log('SCROLL_LADDER_EXHAUSTED:' + JSON.stringify({
        i, everMoved, have: out.length, height: await scrollHeight(),
      }));
      // Ladder exhausted with no growth. NOW it is safe to say why we stopped.
      if (!everMoved) {
        const m = await metrics();
        // Content fits and never needed to scroll: complete, not a failure.
        if (m.fits) return 'no-scroll-needed';
        // Content overflows but the element refuses to scroll — a misconfigured
        // Scroll container. Reported loudly rather than mistaken for the end.
        stuck = true;
        return 'scroll-container-stuck';
      }
      return settled ? 'bottom-stable' : 'settle-timeout';
    }
    return reason;
  };

  await installProbe();
  await harvest();                        // whatever is on screen before scrolling
  let reason = await sweepDown(false);

  // ── Verification passes ─────────────────────────────────────────────────
  // A pass that adds nothing proves the previous one saw everything reachable.
  let passes = 1;
  let verified = false;
  if (!stuck && reason !== 'reached-expected-total') {
    while (passes < maxPasses) {
      const before = out.length;
      await scrollToTop();
      await settle();
      await harvest();
      await sweepDown(true);
      passes++;
      if (out.length === before) { verified = true; break; }
    }
  } else if (reason === 'reached-expected-total') {
    verified = true;
  }

  disposeNet();
  try { await page.evaluate(() => { if (window.__hvProbe) { window.__hvProbe.disconnect(); delete window.__hvProbe; } }); } catch (_) {}

  const complete = expected != null
    ? out.length >= expected
    : (!stuck && reason !== 'safety-cap' && reason !== 'settle-timeout' && (verified || reason === 'no-scroll-needed' || maxPasses === 1));
  // A page that stops growing may simply not be an infinite-scroll page at all.
  // Look for a real "next page" link — if one exists, scrolling was never going
  // to load anything and the user needs a pagination step instead. Saying so is
  // the difference between a confusing "success" and an actionable answer.
  let nextPageHref = null;
  try {
    nextPageHref = await page.evaluate(() => {
      const cur = Number(new URLSearchParams(location.search).get('page') || 1);
      const links = Array.from(document.querySelectorAll('a[href]'));
      const rel = links.find(a => (a.getAttribute('rel') || '').toLowerCase() === 'next');
      if (rel) return rel.href;
      for (const a of links) {
        const m = (a.getAttribute('href') || '').match(/[?&]page=(\d+)/);
        if (m && Number(m[1]) > cur) return a.href;
      }
      const byText = links.find(a => /next|następn|nastepn|weiter|siguiente|suivant/i.test(a.textContent || ''));
      return byText ? byText.href : null;
    });
  } catch (_) {}

  if (opts.silent) return out;
  try {
    const ofExp = expected != null ? (' of ' + expected + ' expected') : '';
    if (stuck) {
      console.log('✗ Collect List: the scroll container ' +
        (reason === 'scroll-container-missing'
          ? 'selector matched no element'
          : 'never moved, so nothing could load') +
        ' — collected only ' + out.length + ' item(s)' + ofExp +
        '. Check the "Scroll container" setting (leave it empty to scroll the page itself).');
    } else if (complete) {
      console.log('✓ Collect List: collected ' + out.length + ' item(s)' + ofExp +
        ' (' + reason + (verified ? ', verified over ' + passes + ' pass(es)' : '') + ').');
    } else {
      console.log('⚠ Collect List may be INCOMPLETE — collected ' + out.length + ' item(s)' + ofExp +
        ' (' + reason + ', ' + passes + ' pass(es)). ' +
        (reason === 'settle-timeout'
          ? 'The page kept loading past the settle timeout — raise it, or the site may be streaming continuously.'
          : reason === 'safety-cap'
            ? 'Raise "Max scroll steps", or set an expected-total / end-of-list selector to confirm completeness.'
            : expected != null
              ? 'The page reported more items than were collected.'
              : 'A verification pass was still finding new items — raise "Verification passes".'));
    }
    if (nextPageHref && !stuck) {
      console.log('⚠ Collect List: this page has a NEXT-PAGE link (' + nextPageHref + '), so it is ' +
        'paginated rather than infinite-scroll — scrolling can never load the rest. Use a ' +
        '"More pages — Numbered web addresses" or "More pages — Click Next" step with an Extract List ' +
        'inside it, instead of collecting while scrolling.');
    }
    if (dupInBatch > 0) {
      console.log('⚠ Collect List: ' + dupInBatch + ' row(s) on screen shared an identity, so distinct records ' +
        'were merged. Set a "Key field" (a unique id / URL / SKU column) to stop losing them.');
    }
    // Machine-readable twin (suppressed from the platform log; kept for tools).
    console.log('COLLECT_SUMMARY:' + JSON.stringify({
      collected: out.length,
      expected: expected == null ? undefined : expected,
      complete, reason, passes, verified,
      nextPageHref: nextPageHref || undefined,
      duplicateKeyRows: dupInBatch || undefined,
    }));
  } catch (_) {}
  return out;
}

/**
 * Scroll to the very end of a page (or container) WITHOUT collecting anything —
 * used by PAGINATE_SCROLL, whose body extracts from the fully-loaded DOM once
 * this returns. It reuses the harvester's engine rather than re-implementing a
 * cruder loop, so it gets the same continuous traversal (no teleporting past an
 * IntersectionObserver sentinel), the same network+DOM idle settling instead of
 * a fixed guess, and the same escalating patience with jiggle at the bottom.
 *
 * Passing a selector that is valid but matches nothing reduces the sweep's
 * "did anything new appear?" test to pure scroll-height growth — exactly the
 * right stop condition when nothing is being harvested along the way. One pass:
 * there is no per-window state to verify, the DOM is read afterwards.
 */
async function exhaustScroll(page, scrollSel, opts) {
  await harvestWhileScrolling(page, '__hv_nothing__', {}, '', scrollSel,
    Object.assign({}, opts || {}, { silent: true, maxPasses: 1 }));
}`;


// Remove the per-step / per-iteration marker lines and the stats calls from
// generated step code. Every such marker is emitted as its own standalone
// line, so a line-level filter is exact and safe.
function stripDownloadInstrumentation(code) {
  const DROP = [
    /^\s*__emitMark\('(?:STEP_BEGIN|ITER_START|ITER_TICK|ITER_END)'/,
    /^\s*console\.log\('STEP_BEGIN:/,
    /^\s*console\.log\('ITER_(?:START|TICK|END):/,
    /^\s*__currentStep__\s*=/,
    /^\s*let __currentStep__\s*=\s*null;\s*$/,
    /^\s*await __emitStepStats\(/,
    /^\s*__checkpoint\(/,
    /^\s*__stageStepDone\(/,
    /^\s*const __ts_[a-z0-9]+ = Date\.now\(\);\s*$/,
    /^\s*__stepTime\(/,
  ];
  return code.split('\n').filter(l => !DROP.some(rx => rx.test(l))).join('\n');
}

/* A NAVIGATE immediately followed by another NAVIGATE has no observable
   effect — nothing runs between the two page loads. The classic shape is
   the pinned start-URL step plus the user's own first navigation right
   after it. Drop the redundant leading one(s) so runs and downloaded
   scripts navigate once. Conservative on purpose: only root-level leading
   pairs, and never across an attached follower (e.g. a Close Cookie
   Banner glued to the first navigation still runs before the second). */
function pruneRedundantLeadingNavigations(steps) {
  const out = [...(steps || [])];
  while (
    out.length >= 2 &&
    out[0]?.type === 'NAVIGATE' && !out[0]?.advanced?.skipOnRun &&
    out[1]?.type === 'NAVIGATE' && !out[1]?.attach
  ) {
    out.shift();
  }
  return out;
}

/* =========================================================================
   PERFORMANCE SETTINGS  (workflow.meta.performance)
   -------------------------------------------------------------------------
   Everything here changes how a page is fetched or waited on, so every switch
   defaults OFF: an existing saved workflow must keep behaving exactly as it
   did until its owner opts in. `WS_*` env vars move the INSTANCE default for
   an operator who wants a whole deployment fast by default; the per-workflow
   value always wins over the env var.

     blockResources   — skip images / media / fonts / trackers (browser/resourceBlock.js)
     blockStylesheets — also skip CSS (needs blockResources)
     smartWait        — navigate on domcontentloaded + wait for the selector the
                        next extraction actually needs, instead of waiting for
                        every subresource via 'load'
     concurrency      — parallel workers for per-item loops (1 = sequential,
                        which is the historical behaviour)
     requestsPerSecond— global pacing cap shared by all workers (0 = unlimited)
     jitterMs         — random extra delay per request, so pacing isn't
                        perfectly regular
   ========================================================================= */
// Hard ceiling on workers. Each holds a Chrome tab (~50-80MB), so an
// unbounded value entered in the UI would OOM the box rather than go faster.
// WS_MAX_CONCURRENCY lets an operator raise it for a well-resourced server.
const CONCURRENCY_HARD_MAX = (() => {
  const n = Number(process.env.WS_MAX_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 16;
})();

function envFlag(name) {
  const v = process.env[name];
  if (v == null || v === '') return false;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function envNum(name) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/* =========================================================================
   EXECUTION SETTINGS  (workflow.meta.execution)
   -------------------------------------------------------------------------
   Reliability knobs, as opposed to the speed switches above. These exist for
   the case the platform's defaults are wrong for one particular site:

     navTimeoutMs     — how long a page load may take before the step fails.
                        Used only where a step has no timeout of its own, so
                        an individually-tuned step still wins.
     connectionRetries— how many times a network-level failure is retried
                        before the run gives up (read by executionPipeline).
     healing          — self-healing on/off. Off makes a run DETERMINISTIC:
                        it will fail rather than quietly rewrite a selector,
                        which is what you want when the output feeds something
                        downstream and a silent change is worse than a gap.
     deviceProfile    — pin the browser fingerprint instead of picking one at
                        random per run. 'auto' (default) rotates.

   Deliberately NOT a free-text user-agent field: each profile is a
   *consistent* set (UA + platform + GPU + client hints + navigator
   overrides). Overriding the UA string alone leaves the rest disagreeing
   with it, which is a stronger bot signal than the default — so the control
   is which profile, not which string.
   ========================================================================= */
const EXECUTION_DEFAULTS = {
  navTimeoutMs: 30000,
  connectionRetries: 2,
  healing: true,
  deviceProfile: 'auto',
};

// Defensive read: a context built before `exec` existed (or a caller that
// hand-rolls one) falls back to the defaults rather than throwing.
function execOf(ctx) {
  return (ctx && ctx.exec) || EXECUTION_DEFAULTS;
}

function resolveExecution(meta) {
  const e = (meta && typeof meta.execution === 'object' && meta.execution) || {};
  const int = (key, dflt, min, max) => {
    const n = Math.floor(Number(e[key]));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
  };
  return {
    navTimeoutMs:      int('navTimeoutMs', EXECUTION_DEFAULTS.navTimeoutMs, 1000, 600000),
    connectionRetries: int('connectionRetries', EXECUTION_DEFAULTS.connectionRetries, 0, 10),
    // Only an explicit `false` disables it — an older workflow with no
    // execution block keeps healing, which is the historical behaviour.
    healing:           e.healing !== false,
    deviceProfile:     typeof e.deviceProfile === 'string' && e.deviceProfile
                         ? e.deviceProfile : EXECUTION_DEFAULTS.deviceProfile,
  };
}

function resolvePerf(meta) {
  const p = (meta && typeof meta.performance === 'object' && meta.performance) || {};
  const pick = (key, envName) => (p[key] === undefined ? envFlag(envName) : !!p[key]);
  const pickNum = (key, envName, dflt) => {
    const raw = p[key] === undefined || p[key] === null || p[key] === ''
      ? envNum(envName)
      : Number(p[key]);
    return Number.isFinite(raw) && raw >= 0 ? raw : dflt;
  };
  return {
    blockResources:    pick('blockResources',   'WS_BLOCK_RESOURCES'),
    blockStylesheets:  pick('blockStylesheets', 'WS_BLOCK_STYLESHEETS'),
    smartWait:         pick('smartWait',        'WS_SMART_WAIT'),
    httpFirst:         pick('httpFirst',        'WS_HTTP_FIRST'),
    concurrency:       Math.max(1, Math.min(
                         Math.floor(pickNum('concurrency', 'WS_CONCURRENCY', 1)) || 1,
                         CONCURRENCY_HARD_MAX)),
    requestsPerSecond: pickNum('requestsPerSecond', 'WS_REQUESTS_PER_SECOND', 0),
    jitterMs:          Math.floor(pickNum('jitterMs', 'WS_JITTER_MS', 0)),
  };
}

/* =========================================================================
   MAIN EXPORT: generateCode(workflow) → string
   workflow = { steps: [...], meta: { startUrl, viewport } }
   ========================================================================= */
function generateCode(workflow, options = {}) {
  // clean = "download" mode: strip platform-only instrumentation so the
  // standalone script is short and readable.
  const clean    = !!options.clean;
  const steps    = pruneRedundantLeadingNavigations(workflow.steps || []);
  const startUrl = workflow.meta?.startUrl || null;
  const vpW      = workflow.meta?.viewportWidth  || 1280;
  const vpH      = workflow.meta?.viewportHeight || 720;
  const variables = Array.isArray(workflow.meta?.variables) ? workflow.meta.variables : [];
  // Resolved, credentials-included proxy config — attached by
  // executionPipeline.service.js (interactive/scheduled runs) or
  // server.js's downloadCode handler (which omits it; see the `clean`
  // branch below). { protocol, host, port, username?, password? } | null.
  const proxy = workflow.proxy || null;
  // Performance switches for this workflow (all default off — see resolvePerf).
  const perf = resolvePerf(workflow.meta);
  const exec = resolveExecution(workflow.meta);

  // Picked fresh on every call — generateCode() runs once per execution
  // (see runner.service.js), so scheduled/repeated runs of the same
  // workflow each get their own device profile instead of all presenting
  // an identical fingerprint. See backend/browser/stealthCore.js.
  const stealth = buildCodegenStealthHelper(exec.deviceProfile);
  // Real credentials are only safe to embed for a platform-run script — it's
  // written to a temp file and deleted immediately after the run (see
  // runner.service.js). A downloaded (`clean`) script can end up anywhere,
  // so it never gets literal proxy details — see the SCRAPER_PROXY_SERVER
  // env-var block spliced into the launch template below instead.
  const proxyLaunchArgs = (!clean && proxy) ? getProxyLaunchArgs(proxy) : [];
  const launchArgs = [...stealth.launchArgs, ...proxyLaunchArgs];

  // Render user-defined workflow variables as `let` declarations at the
  // top of run(). Names are sanitised JS identifiers; values are JSON-
  // encoded according to the variable's declared type. Booleans accept
  // the strings "true"/"false"; numbers fall back to 0 on parse failure;
  // json accepts any parseable JSON, otherwise the string literal.
  const variablesCode = renderVariableDeclarations(variables);
  // Set of declared JS identifiers — used by qStr / selectorList during
  // step codegen to interpolate `{{name}}` references in string params.
  const declaredVars = new Set();
  for (const v of variables) {
    const id = toJsIdent(v && v.name);
    if (id) declaredVars.add(id);
  }

  // ID counter for unique variable names when outputVar is missing
  let idCounter = 0;
  const ctx = {
    nextId: () => (idCounter++).toString(36),
    declaredVars,
    customActions: workflow.customActions || {},
    // Map of {workflowId → { name, steps, meta }} for any subflow
    // referenced from this workflow (or transitively from a subflow). The
    // backend's server.js resolves this map before invoking generateCode.
    subflows: workflow.subflows || {},
    // Tracks subflow ids currently being inlined so a self-reference or
    // a → b → a cycle stops at the first repeat with a clear comment.
    visitedSubflows: new Set([String(workflow.id || workflow.meta?.workflowId || '__root__')]),
    // Collected during step codegen — every named extraction step's
    // label becomes a top-level `let <name>;` declaration so the data
    // it captures is visible to subsequent steps as a JS variable.
    capturedAliases: new Set(),
    // Per-workflow performance switches (see resolvePerf). Read by NAVIGATE
    // to decide its wait strategy; passed down to subflow/loop contexts so a
    // nested navigation makes the same choice as a top-level one.
    perf,
    // Per-workflow reliability settings (see resolveExecution): navigation
    // timeout, connection retries, self-healing on/off, pinned fingerprint.
    exec,
    // Download mode — suppresses platform-only scaffolding that a line-level
    // filter can't remove (the multi-line resume guard).
    clean,
  };

  // isRoot: only top-level steps get a resume guard (see stepResumeGuard).
  let stepCode = genStepList(steps, ctx, 2, true);
  if (clean) stepCode = stripDownloadInstrumentation(stepCode);

  // ── Conditional prelude / wrapper pieces ────────────────────────────────
  // Only inline the field-transform runtime when a step actually uses it,
  // and the self-healing instrumentation only for in-platform runs.
  // Either entry point pulls in the runtime: list rows go through
  // materializeRow, single extractions through cleanAny.
  const usesFieldRuntime = /__ft(?:MaterializeRow|CleanAny)\(/.test(stepCode);
  const fieldRuntimeSrc = usesFieldRuntime
    ? `\n// ─── Field transform runtime (clean / split per-field pipelines) ──────────\n${FIELD_TRANSFORM_RUNTIME}\n`
    : '';
  // Enrich runtime is behaviour (not instrumentation): include it in BOTH
  // platform + downloaded scripts, but only when a RUN_SUBFLOW "enrich" step
  // actually emitted a call to it.
  const usesEnrichRuntime = /__enrichRows\(/.test(stepCode);
  const enrichRuntimeSrc = usesEnrichRuntime
    ? `\n// ─── Enrich runtime (merge subflow detail results back into list rows) ────\n${ENRICH_RUNTIME_SRC}\n`
    : '';
  // Harvest runtime (COLLECT_LIST) — behaviour, included in both modes on demand.
  const usesHarvestRuntime = /(?:harvestWhileScrolling|exhaustScroll)\(/.test(stepCode);
  const harvestRuntimeSrc = usesHarvestRuntime
    ? `\n// ─── Harvest runtime (collect a list while scrolling; virtual lists) ──────\n${HARVEST_RUNTIME_SRC}\n`
    : '';
  const instrumentationSrc = clean ? '' : `\n${INSTRUMENTATION_HELPERS_SRC}\n`;
  // Cookie-consent auto-dismiss helper — always included so every navigation
  // (initial, pagination, subflow, new tab) clears CMP banners. Honours the
  // SCRAPER_CONSENT env var ('accept' default | 'reject' | 'off').
  const consentHelperSrc = buildCodegenConsentHelper();
  // Request blocking — emitted for downloaded scripts too (it's behaviour, not
  // instrumentation), and a no-op helper when the workflow hasn't opted in.
  const resourceBlockSrc = buildCodegenResourceBlockHelper({
    enabled: perf.blockResources,
    blockStylesheets: perf.blockStylesheets,
  });
  // CAPTCHA detection + (opt-in) solving helper. Always inlined so NAVIGATE
  // auto-handling and the SOLVE_CAPTCHA step work; the machine-readable
  // CAPTCHA_DETECTED marker is only emitted for in-platform runs (!clean) so
  // downloaded scripts stay quiet.
  const captchaHelperSrc = buildCodegenCaptchaHelper(!clean);
  const currentStepDecl = clean ? '' : '  let __currentStep__ = null;\n';
  // Point the checkpoint runtime at the ROOT results object (see __checkpoint).
  const rootResultsDecl = clean ? '' : '  __rootResults = __results__;\n';
  const workflowResultsMarker = clean
    ? ''
    : `    console.log('\\nWORKFLOW_RESULTS:' + JSON.stringify(__results__));\n`;
  // Commented-out save-to-file helpers, included only in a downloaded
  // (clean) script so the user can switch on JSON or CSV export by
  // uncommenting — no extra dependencies needed.
  const saversSnippet = clean
    ? `
  // ─── Save results to a file (uncomment what you need) ──────────────────
  // const fs = require('fs');
  //
  // // → JSON: write everything to one file
  // fs.writeFileSync('results.json', JSON.stringify(__results__, null, 2));
  //
  // // → CSV: one .csv per result set that is a list of rows
  // for (const [name, rows] of Object.entries(__results__)) {
  //   if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== 'object') continue;
  //   const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  //   const esc = (v) => {
  //     const s = v === null || v === undefined ? '' : String(v);
  //     return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  //   };
  //   const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\\n');
  //   fs.writeFileSync(name + '.csv', csv);
  // }
`
    : '';
  const catchBody = clean
    ? `    console.error('❌ Workflow error:', err.message);
    process.exitCode = 1;`
    : `    console.error('❌ Workflow error:', err.message);
    // Flush the tail before reporting the failure: a step that throws halfway
    // through a 5,000-URL loop still captured everything up to that point.
    try { __checkpoint(true); } catch (_) {}
    try {
      const __html__ = await __snapshotPageHtml(page);
      const __payload__ = {
        step: __currentStep__,
        message: err && err.message ? String(err.message) : String(err),
        stack: err && err.stack ? String(err.stack).split('\\n').slice(0, 8).join('\\n') : '',
        url: (() => { try { return page.url(); } catch (_) { return null; } })(),
        html: __html__,
      };
      console.log('STEP_ERROR:' + JSON.stringify(__payload__));
    } catch (_) {}
    process.exitCode = 1;`;
  const headerDoc = clean
    ? `/**
 * Web-scraping script generated by WebScraper.
 *
 * Setup:  npm i puppeteer-extra puppeteer-extra-plugin-stealth puppeteer
 * Run:    node workflow.js
 */`
    : `/**
 * Generated by WebScraper — ${new Date().toISOString()}
 * Run:  node workflow.js
 */`;

  // Now that step codegen is done, ctx.capturedAliases holds every alias
  // we need to declare. Render them as `let <name>;` lines at the top of
  // run() so assignments inside try / loop / catch blocks land on
  // function-scoped slots that subsequent steps can read.
  const capturedAliasesCode = ctx.capturedAliases.size === 0 ? '' :
    '\n  // ─── Captured outputs (from named extraction steps) ──────────\n' +
    Array.from(ctx.capturedAliases).map(a => `  let ${a};`).join('\n') +
    '\n  // ─────────────────────────────────────────────────────────────';

  // ── Proxy: launch-arg suffix, page.authenticate(), WebRTC guard ────────
  // Non-clean (platform-run): real values, computed above into launchArgs
  // already — nothing extra needed for the args array itself here.
  // Clean (download): never embed literal proxy details (see the comment
  // by `proxyLaunchArgs` above) — read them from env vars at the
  // downloaded script's own runtime instead.
  const launchArgsCode = clean
    ? `${JSON.stringify(launchArgs, null, 6).replace(/\n/g, '\n    ')}.concat(process.env.SCRAPER_PROXY_SERVER ? ['--proxy-server=' + process.env.SCRAPER_PROXY_SERVER, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : [])`
    : JSON.stringify(launchArgs, null, 6).replace(/\n/g, '\n    ');

  /* Proxy setup now lives inside __openPage (browser/pagePool.js) rather than
     being applied once to the first page in run(). That is a fix, not just a
     move: every tab a run opens goes through a proxy, but only the first one
     was ever authenticated, so an authenticated proxy silently failed on every
     subflow / per-row detail page. Centralising the page factory means the
     100th tab is set up exactly like the 1st. */
  let proxyAuthCode = '';
  if (clean) {
    proxyAuthCode = `  // Proxy support: set SCRAPER_PROXY_SERVER (e.g. "http://host:port" or
  // "socks5://host:port") to route through a proxy, and — if it needs
  // auth — SCRAPER_PROXY_USERNAME / SCRAPER_PROXY_PASSWORD. SOCKS5 proxy
  // auth isn't supported by Chrome itself (page.authenticate() only
  // answers HTTP(S) proxy challenges).
  if (process.env.SCRAPER_PROXY_USERNAME) {
    await _p.authenticate({ username: process.env.SCRAPER_PROXY_USERNAME, password: process.env.SCRAPER_PROXY_PASSWORD || '' });
  }
`;
  } else if (proxy && proxy.username) {
    proxyAuthCode = `  await _p.authenticate(${JSON.stringify({ username: proxy.username, password: proxy.password || '' })});\n`;
  }

  // WebRTC's own STUN-based IP discovery doesn't go through --proxy-server —
  // see PROXY_WEBRTC_GUARD_SCRIPT's comment in stealthCore.js.
  let proxyWebRtcGuardCode = '';
  if (clean) {
    proxyWebRtcGuardCode = `  if (process.env.SCRAPER_PROXY_SERVER) {
    await _p.evaluateOnNewDocument(${JSON.stringify(PROXY_WEBRTC_GUARD_SCRIPT)});
  }\n`;
  } else if (proxy) {
    proxyWebRtcGuardCode = `  await _p.evaluateOnNewDocument(${JSON.stringify(PROXY_WEBRTC_GUARD_SCRIPT)});\n`;
  }

  // Only inlined when some subflow actually compiled an HTTP path — it pulls
  // in cheerio, which a browser-only script has no reason to require.
  const httpExtractSrc = perf.httpFirst
    ? buildCodegenHttpExtractHelper({ userAgent: stealth.profile && stealth.profile.userAgent })
    : '';

  const poolHelperSrc = buildCodegenPoolHelper({
    instrument: !clean,
    proxyAuth: proxyAuthCode,
    proxyWebRtc: proxyWebRtcGuardCode,
    requestsPerSecond: perf.requestsPerSecond,
    jitterMs: perf.jitterMs,
  });

  return `#!/usr/bin/env node
'use strict';

${headerDoc}

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
${stealth.source}

/**
 * Try each selector in order; return the first ElementHandle that resolves.
 * selectors = [{ value: string, type: 'css'|'xpath' }, ...]
 */
async function resolveElement(page, selectors) {
  for (const { value, type } of selectors) {
    try {
      const selector =
        type === 'xpath'
          ? \`::-p-xpath(\${value})\`
          : value;
      const el = await page.$(selector);
      if (el) return el;
    } catch (_) {}
  }
  return null;
}

/**
 * Same as resolveElement but returns ALL matching handles for the first
 * selector that yields at least one result.
 */
async function resolveElements(page, selectors) {
  for (const { value, type } of selectors) {
    try {
      const selector =
        type === 'xpath'
          ? \`::-p-xpath(\${value})\`
          : value;

      const els = await page.$$(selector);
      if (els && els.length > 0) return els;
    } catch (_) {}
  }
  return [];
}

/**
 * "Soft" resolve for extraction: return the element the instant it's present
 * (no wait when the page is already rendered), otherwise poll — WITHOUT
 * scrolling — until it appears or \`graceMs\` elapses, then return null. Never
 * throws and never fails the step: a missing element yields an empty value,
 * which is the right default for extraction (an absent field is data, not an
 * error). Pass graceMs = 0 to disable waiting entirely (the pre-existing
 * "read what's there right now" behaviour).
 */
async function resolveElementSoft(page, selectors, graceMs = 0) {
  let el = await resolveElement(page, selectors);
  if (el || graceMs <= 0) return el;
  const deadline = Date.now() + graceMs;
  while (!el && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 120));
    el = await resolveElement(page, selectors);
  }
  return el;
}

/**
 * List counterpart of resolveElementSoft — waits (without scrolling) for the
 * first selector to match at least one element, up to graceMs, then returns
 * whatever it has ([] if still nothing). Never throws.
 */
async function resolveElementsSoft(page, selectors, graceMs = 0) {
  let els = await resolveElements(page, selectors);
  if (els.length || graceMs <= 0) return els;
  const deadline = Date.now() + graceMs;
  while (!els.length && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 120));
    els = await resolveElements(page, selectors);
  }
  return els;
}

/**
 * Wait until any selector in the list appears within timeout ms.
 * Returns the ElementHandle of the first match found.
 * Throws if nothing resolves in time.
 *
 * opts.reveal (default true): if the element isn't in the DOM yet, progressively
 * scroll the page down between polls to trigger lazy-rendered / below-the-fold
 * content, and once found, scroll it into the centre of the viewport (and wait
 * briefly for it to settle) so a subsequent click/hover/type lands on a visible,
 * stable element. Pass { reveal: false } for a pure wait that must not scroll.
 */
/**
 * Smart wait: return as soon as the data we're about to extract is present,
 * instead of waiting for every last subresource of the page.
 *
 * Used with goto(waitUntil:'domcontentloaded'). Cannot be slower or less
 * reliable than the waitUntil:'load' it replaces — if the selector never
 * appears on the fast path it falls back to waiting for the load event and
 * polls once more, so the worst case is the old behaviour plus a poll.
 * Never throws: a genuinely absent element is data (an empty field), and the
 * empty-result healing pipeline is what handles that.
 */
async function smartWaitFor(page, selectors, timeout = 15000) {
  if (!selectors || !selectors.length) return false;
  if (await resolveElementSoft(page, selectors, timeout)) return true;
  try {
    await page.waitForFunction('document.readyState === "complete"', { timeout: 5000 });
  } catch (_) {}
  return !!(await resolveElement(page, selectors));
}

async function waitForAny(page, selectors, timeout = 10000, opts = {}) {
  const reveal = opts.reveal !== false;
  const deadline = Date.now() + timeout;
  let lastErr, atBottom = false;
  while (Date.now() < deadline) {
    for (const { value, type } of selectors) {
      try {
        const el = type === 'xpath'
          ? (await page.$x(value))[0]
          : await page.$(value);
        if (el) {
          if (reveal) await scrollIntoViewSafe(page, el);
          return el;
        }
      } catch (e) { lastErr = e; }
    }
    // Not found yet: nudge the page down ~one viewport to surface lazy content.
    // Once we hit the bottom we stop scrolling but keep polling until timeout.
    if (reveal && !atBottom) {
      try {
        atBottom = await page.evaluate(() => {
          const before = window.scrollY;
          window.scrollTo(0, Math.min(before + Math.round(window.innerHeight * 0.9), document.body.scrollHeight));
          return window.scrollY <= before + 1; // didn't move → already at the bottom
        });
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 200));
  }
  const tried = selectors.map(s => \`[\${s.type}] \${s.value}\`).join(', ');
  throw new Error(\`waitForAny: none matched within \${timeout}ms. Tried: \${tried}\`);
}

/**
 * Centre an element in the viewport and wait until its position is stable (two
 * consecutive frames with the same rect) so we don't act on it mid-animation.
 * Best-effort — never throws.
 */
async function scrollIntoViewSafe(page, el) {
  try {
    await el.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
  } catch (_) {
    try { await el.evaluate(e => e.scrollIntoView()); } catch (__) {}
  }
  try {
    let prev = null;
    for (let i = 0; i < 5; i++) {
      const box = await el.boundingBox().catch(() => null);
      if (box && prev && Math.abs(box.y - prev.y) < 1 && Math.abs(box.x - prev.x) < 1) break;
      prev = box;
      await new Promise(r => setTimeout(r, 80));
    }
  } catch (_) {}
}

/**
 * Click the first selector that resolves to a VISIBLE element in ANY frame,
 * polling until timeout. Never throws — used for cookie banners and other
 * "dismiss if present" elements that may legitimately not exist (e.g.
 * consent already stored from a previous visit). Returns true if clicked.
 */
async function clickIfPresent(page, selectors, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let frames = [];
    try { frames = page.frames(); } catch (_) { try { frames = [page.mainFrame()]; } catch (_2) { frames = []; } }
    for (const frame of frames) {
      for (const { value, type } of selectors) {
        try {
          const sel = type === 'xpath' ? \`::-p-xpath(\${value})\` : value;
          const el = await frame.$(sel);
          if (!el) continue;
          const vis = await el.evaluate(e => {
            const r = e.getBoundingClientRect();
            const s = getComputedStyle(e);
            return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden';
          }).catch(() => false);
          if (!vis) continue;
          try { await el.evaluate(e => e.scrollIntoView({ block: 'center' })); } catch (_) {}
          try { await el.click(); return true; }
          catch (_) {
            // Overlapped by another layer (or detached mid-click) — fall back
            // to a DOM-level click, which most banner buttons accept.
            try { await el.evaluate(e => e.click()); return true; } catch (_2) {}
          }
        } catch (_) {}
      }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

/**
 * Run page.evaluate(fn, el) with XPath-aware element resolution.
 * graceMs (default 0) gives the element a brief window to appear before we
 * give up — used by extraction steps so a value that renders a beat after
 * load is still captured, while a genuinely-present element is read with no
 * delay. Still throws when nothing turns up (extraction callers wrap this in
 * \`.catch(() => null)\` so an absent element becomes an empty value).
 */
async function evalOnElement(page, selectors, fn, graceMs = 0) {
  const el = await resolveElementSoft(page, selectors, graceMs);
  if (!el) throw new Error('evalOnElement: element not found for selectors: ' + JSON.stringify(selectors));
  return page.evaluate(fn, el);
}

/**
 * Run page.evaluate(fn, el) on ALL elements matched by the first working
 * selector. graceMs waits (without scrolling) for the first match to appear.
 */
async function evalOnElements(page, selectors, fn, graceMs = 0) {
  const els = await resolveElementsSoft(page, selectors, graceMs);
  if (!els.length) return [];
  return Promise.all(els.map(el => page.evaluate(fn, el)));
}
${fieldRuntimeSrc}${enrichRuntimeSrc}${harvestRuntimeSrc}${instrumentationSrc}${consentHelperSrc}${resourceBlockSrc}${httpExtractSrc}${poolHelperSrc}${captchaHelperSrc}
async function run() {
  const __results__ = {};
${rootResultsDecl}${currentStepDecl}${variablesCode}${capturedAliasesCode}
  const browser = await puppeteer.launch({
    // Honour CHROME_PATH when set (Linux servers / CI / containers); fall back
    // to the local Chrome install used during development.
    executablePath: process.env.CHROME_PATH || 'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
    headless: 'new',
    defaultViewport: null,
    args: ${launchArgsCode},
    ignoreDefaultArgs: ['--enable-automation', '--hide-scrollbars'],
  });

  let page = await __openPage(browser);
  await page.setViewport({ width: ${vpW}, height: ${vpH}, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // NOTE: The workflow's first step is the explicit NAVIGATE that pins
  // the start URL — we don't inject an extra page.goto here so the run
  // doesn't double-navigate when the user already has that step in the
  // workflow tree.

  try {
${stepCode}
  } catch (err) {
${catchBody}
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  // Output collected extraction results
  if (Object.keys(__results__).length > 0) {
    console.log('');
    for (const [key, value] of Object.entries(__results__)) {
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
        // Tabular data from ForEach loop — print as table
        console.log('\\n── ' + key + ' ──');
        const cols = Object.keys(value[0]);
        const widths = cols.map(c => Math.max(c.length, ...value.map(r => String(r[c] ?? '').length)));
        const hr = widths.map(w => '─'.repeat(w + 2)).join('┼');
        const header = cols.map((c, i) => ' ' + c.padEnd(widths[i]) + ' ').join('│');
        console.log(header);
        console.log(hr);
        value.forEach(row => {
          const line = cols.map((c, i) => ' ' + String(row[c] ?? '').padEnd(widths[i]) + ' ').join('│');
          console.log(line);
        });
      } else {
        console.log('\\n── ' + key + ' ──');
        console.log(JSON.stringify(value, null, 2));
      }
    }
${workflowResultsMarker}  }
${saversSnippet}}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
`;
}

/* ── Render user-defined workflow variables ─────────────────────────────── */
// Each variable from workflow.meta.variables becomes a `let` declaration
// at the top of run() so subsequent steps can reference it directly in
// generated code. Names are forced to valid JS identifiers; values are
// converted based on the declared type (string / number / boolean / json).
// Anything malformed becomes `undefined` with a comment so the user can
// fix it in the Variables panel.
function renderVariableDeclarations(variables) {
  if (!Array.isArray(variables) || variables.length === 0) return '';
  const seen = new Set();
  const lines = ['', '  // ─── Workflow Variables ──────────────────────────────────────────'];
  for (const v of variables) {
    if (!v || typeof v !== 'object') continue;
    const ident = toJsIdent(v.name);
    if (!ident || seen.has(ident)) continue;
    seen.add(ident);
    const literal = renderVariableLiteral(v);
    const comment = v.description ? `  // ${String(v.description).replace(/\r?\n/g, ' ').slice(0, 200)}` : '';
    lines.push(`  let ${ident} = ${literal};${comment ? ` ${comment.trim()}` : ''}`);
  }
  lines.push('  // ─────────────────────────────────────────────────────────────────');
  return lines.join('\n');
}

function toJsIdent(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().replace(/[^a-zA-Z0-9_$]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) return '';
  if (/^[0-9]/.test(s)) s = '_' + s;
  // Avoid reserved words / common built-ins by prefixing if needed.
  if (/^(let|const|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|this|super|null|undefined|true|false|page|browser)$/.test(s)) {
    s = s + '_';
  }
  return s.slice(0, 60);
}

function renderVariableLiteral(v) {
  const raw = v.value == null ? '' : String(v.value);
  const type = (v.type || 'string').toLowerCase();
  switch (type) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? String(n) : '0';
    }
    case 'boolean': {
      return /^(true|1|yes|on)$/i.test(raw.trim()) ? 'true' : 'false';
    }
    case 'json': {
      try { JSON.parse(raw); return raw; } catch (_) { return 'undefined /* invalid JSON */'; }
    }
    case 'string':
    default:
      return JSON.stringify(raw);
  }
}

/* =========================================================================
   README GENERATOR
   Produces a Markdown README tailored to a workflow's generated script —
   how to install + run it, and exactly where to make common edits. Shipped
   alongside the downloaded workflow.js.
   ========================================================================= */

// Walk the step tree once to pull the facts the README references: the start
// URL, declared variables, the named outputs the script collects, and which
// optional features are in play (pagination, field cleaning, subflows).
function collectReadmeInfo(workflow) {
  const steps = workflow.steps || [];
  const variables = Array.isArray(workflow.meta?.variables) ? workflow.meta.variables : [];
  const outputs = [];
  let startUrl = workflow.meta?.startUrl || null;
  let hasPagination = false, hasTransforms = false, hasSubflow = false, hasPageLoop = false;

  function walk(arr) {
    for (const s of arr || []) {
      if (!s || typeof s !== 'object') continue;
      if (s.kind === 'action') {
        if (s.type === 'NAVIGATE' && !startUrl && s.params?.url) startUrl = s.params.url;
        if (EXTRACTION_TYPES.has(s.type) && s.label && s.label.trim()) outputs.push(s.label.trim());
        if (s.type === 'RUN_SUBFLOW') {
          hasSubflow = true;
          const k = (s.params?.outputVar && String(s.params.outputVar).trim()) || (s.label && s.label.trim());
          if (k) outputs.push(k);
        }
        if (s.type === 'EXTRACT_LIST') {
          const f = s.params?.fields || {};
          for (const spec of Object.values(f)) if (__ftHasPipeline(spec)) hasTransforms = true;
        }
      } else if (s.kind === 'control') {
        if (s.meta?.kind === 'pagination') hasPagination = true;
        if (s.type === 'REPEAT' || s.meta?.strategy === 'url_param') hasPageLoop = true;
      }
      for (const key of ['body', 'then', 'else', 'try', 'catch']) {
        if (Array.isArray(s[key])) walk(s[key]);
      }
    }
  }
  walk(steps);

  return {
    name: (workflow.meta?.name && String(workflow.meta.name).trim()) || '',
    startUrl,
    variables,
    outputs: [...new Set(outputs)],
    hasPagination, hasTransforms, hasSubflow, hasPageLoop,
  };
}

function generateReadme(workflow) {
  const info = collectReadmeInfo(workflow);
  const BT = String.fromCharCode(96);          // backtick
  const FENCE = BT + BT + BT;
  const code = (s) => BT + String(s) + BT;
  const title = info.name ? `${info.name} — Web Scraper` : 'Web Scraper — Generated Script';

  const L = [];
  L.push(`# ${title}`);
  L.push('');
  L.push('This folder contains a standalone web-scraping script generated by **WebScraper**.');
  L.push('It drives a real Chrome browser with [Puppeteer](https://pptr.dev/) and prints the data it collects.');
  L.push('');

  L.push('## Requirements');
  L.push('');
  L.push('- **Node.js 18+** — check with ' + code('node -v'));
  L.push('- **Google Chrome** (or let the install step below download a bundled Chromium)');
  L.push('');

  L.push('## 1. Install dependencies');
  L.push('');
  L.push('From this folder, run:');
  L.push('');
  L.push(FENCE + 'bash');
  L.push('npm init -y');
  L.push('npm install puppeteer-extra puppeteer-extra-plugin-stealth puppeteer');
  L.push(FENCE);
  L.push('');
  L.push('> ' + code('puppeteer') + ' downloads its own Chromium. To use a Chrome you already have, skip it and set ' + code('CHROME_PATH') + ' (see below).');
  L.push('');

  L.push('## 2. Run it');
  L.push('');
  L.push(FENCE + 'bash');
  L.push('node workflow.js');
  L.push(FENCE);
  L.push('');
  if (info.startUrl) {
    L.push('The script starts at ' + code(info.startUrl) + ', runs each step, then prints the results.');
  } else {
    L.push('The script opens the browser, runs each step, then prints the results.');
  }
  L.push('');

  L.push('## Output');
  L.push('');
  if (info.outputs.length) {
    L.push('Collected data is printed to the terminal, grouped under: ' + info.outputs.map(code).join(', ') + '.');
  } else {
    L.push('Collected data is printed to the terminal when the run finishes.');
  }
  L.push('');
  L.push('To save it to a file, either redirect the console output:');
  L.push('');
  L.push(FENCE + 'bash');
  L.push('node workflow.js > results.txt');
  L.push(FENCE);
  L.push('');
  L.push('…or write JSON directly — see *Save results to a file* below.');
  L.push('');

  L.push('## Where to make changes');
  L.push('');
  L.push('All edits are in ' + code('workflow.js') + ':');
  L.push('');
  L.push('- **Start URL / target page** — the first ' + code('await page.goto("…")') + ' inside ' + code('run()') + '.');
  L.push('- **What gets extracted (CSS selectors)** — look for ' + code('{ value: "<selector>", type: "css" }') + ' in the extraction steps and edit the selector strings.');
  if (info.variables.length) {
    L.push('- **Workflow variables** — the ' + code('// Workflow Variables') + ' block at the top of ' + code('run()') + '. This script declares:');
    for (const v of info.variables) {
      const id = toJsIdent(v && v.name);
      if (!id) continue;
      const desc = v.description ? ` — ${String(v.description).replace(/\s+/g, ' ').trim()}` : '';
      L.push('  - ' + code(id) + ` (${(v.type || 'string')})` + desc);
    }
  } else {
    L.push('- **Workflow variables** — if you add any, they appear as ' + code('let') + ' declarations at the top of ' + code('run()') + '.');
  }
  if (info.hasPageLoop || info.hasPagination) {
    L.push('- **How many pages to scrape** — look for the ' + code('// Pagination') + ' block(s); each loop stops on its own (no more content / button gone), but you can tighten the ' + code('Max pages') + ' safety cap or the page-number math.');
  }
  if (info.hasTransforms) {
    L.push('- **Field cleaning / splitting** — fields are post-processed in the ' + code('__ftMaterializeRow(...)') + ' call; tweak the ' + code('transforms') + ' / ' + code('split') + ' specs there.');
  }
  L.push('- **Show the browser window** — set ' + code("headless: 'new'") + ' to ' + code('false') + ' in ' + code('puppeteer.launch({ … })') + '.');
  L.push('- **Use your own Chrome** — set the ' + code('CHROME_PATH') + ' env var, or edit ' + code('executablePath') + ' in ' + code('puppeteer.launch') + '.');
  L.push('- **Window size** — ' + code('page.setViewport({ width, height })') + '.');
  L.push('- **Timeouts** — the ' + code('timeout:') + ' values on navigation / waits (milliseconds).');
  L.push('- **Save results to a file** — ' + code('workflow.js') + ' already includes a commented-out *"Save results to a file"* block at the end of ' + code('run()') + '. Uncomment the JSON and/or CSV part (copied below).');
  L.push('');

  L.push('### Save results as JSON or CSV');
  L.push('');
  L.push('Open ' + code('workflow.js') + ', find the ' + code('// ─── Save results to a file') + ' block near the end of ' + code('run()') + ', and uncomment what you want:');
  L.push('');
  L.push(FENCE + 'js');
  L.push(`const fs = require('fs');`);
  L.push('');
  L.push('// → JSON: write everything to one file');
  L.push(`fs.writeFileSync('results.json', JSON.stringify(__results__, null, 2));`);
  L.push('');
  L.push('// → CSV: one .csv per result set that is a list of rows');
  L.push(`for (const [name, rows] of Object.entries(__results__)) {`);
  L.push(`  if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== 'object') continue;`);
  L.push(`  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];`);
  L.push(`  const esc = (v) => {`);
  L.push(`    const s = v === null || v === undefined ? '' : String(v);`);
  L.push(`    return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;`);
  L.push(`  };`);
  L.push(`  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\\n');`);
  L.push(`  fs.writeFileSync(name + '.csv', csv);`);
  L.push(`}`);
  L.push(FENCE);
  L.push('');

  L.push('### Use your own Chrome (optional)');
  L.push('');
  L.push(FENCE + 'bash');
  L.push('# macOS');
  L.push(`CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node workflow.js`);
  L.push('# Linux');
  L.push('CHROME_PATH="/usr/bin/google-chrome" node workflow.js');
  L.push(FENCE);
  L.push('');

  if (info.hasSubflow) {
    L.push('> **Note:** this workflow calls one or more sub-workflows; their steps are inlined into ' + code('workflow.js') + '.');
    L.push('');
  }

  L.push('## Troubleshooting');
  L.push('');
  L.push('- **"Could not find Chrome" / launch fails** — install Chrome and set ' + code('CHROME_PATH') + ', or run ' + code('npx puppeteer browsers install chrome') + '.');
  L.push('- **Empty results** — the site\'s markup probably changed; update the CSS selectors.');
  L.push('- **Timeouts / slow pages** — increase the ' + code('timeout:') + ' values, or add a ' + code('Wait') + ' after navigation.');
  L.push('- **Blocked / bot detection** — try running non-headless, slow the script down, and respect the site\'s ' + code('robots.txt') + ' and terms of service.');
  L.push('- **CAPTCHA / anti-bot challenge** — the script detects reCAPTCHA, hCaptcha, Cloudflare Turnstile and "Just a moment" pages. Cloudflare interstitials are waited out automatically. To auto-solve the rest, set ' + code('CAPTCHA_PROVIDER') + ' (' + code('capsolver') + ' or ' + code('twocaptcha') + ') and ' + code('CAPTCHA_API_KEY') + ' — both are cheap, pay-per-solve (~$0.30–3 / 1000).');
  L.push('');
  L.push('---');
  L.push('_Generated by WebScraper. Scrape responsibly and only data you\'re allowed to access._');
  L.push('');

  return L.join('\n');
}

module.exports = {
  generateCode, generateReadme,
  // Shared with executionPipeline so the run and the generated script
  // agree on one interpretation of meta.execution.
  resolveExecution, EXECUTION_DEFAULTS,
  // Exported so test/scroll-harvest.test.js can eval the runtime and drive it
  // against real fixture pages — the engine is where the accuracy lives.
  HARVEST_RUNTIME_SRC,
  // Exported so test/resume-e2e.test.js drives the REAL emitted resume filter
  // rather than a lookalike — the whole point of that test is that a resumed
  // run reproduces an uninterrupted one, which only means something if the
  // code under test is the code that actually ships.
  resumeSkipCode,
  resolvePerf,
};
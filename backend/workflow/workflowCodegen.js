'use strict';

const { RUNTIME_SRC: FIELD_TRANSFORM_RUNTIME, __ftHasPipeline } = require('./fieldTransforms');

// ─── Extraction action types (steps that produce named data) ──────────────
const EXTRACTION_TYPES = new Set([
  'EXTRACT_TEXT', 'EXTRACT_ATTRIBUTE', 'EXTRACT_HTML',
  'EXTRACT_TABLE', 'EXTRACT_LIST', 'EXTRACT_JSON',
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
// Anything that doesn't match (e.g. "{{not a var}}") stays as literal
// text so users aren't accidentally interpolating arbitrary braces.
//
// Both helpers escape backticks / existing ${...} sequences so the
// generated code stays well-formed even when the user types tricky text.
const VAR_RX = /\{\{\s*([a-zA-Z_$][\w$]*)(\[\*\])?((?:\.[a-zA-Z_$][\w$]*)*)\s*\}\}/g;

function refToJs(root, star, rest) {
  if (star) {
    return rest
      ? `(${root} || []).map(_x => _x${rest})`
      : `(${root} || [])`;
  }
  return root + (rest || '');
}

function qStr(s /* declaredVars kept for back-compat — no longer used */) {
  if (typeof s !== 'string') return JSON.stringify(s == null ? '' : String(s));
  if (!s.includes('{{')) return JSON.stringify(s);

  VAR_RX.lastIndex = 0;
  if (!VAR_RX.test(s)) return JSON.stringify(s);

  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
  const interpolated = escaped.replace(VAR_RX, (_full, root, star, rest) =>
    '${' + refToJs(root, star, rest) + '}'
  );
  return '`' + interpolated + '`';
}

// Extract a JS EXPRESSION out of a string that's "essentially a template
// reference" — i.e. exactly `{{var[*].something}}` (with optional
// whitespace). Used for fields that should evaluate to an array / object
// at runtime, not a string. Returns null if `s` isn't a pure template
// reference — callers can fall back to literal-array parsing or default
// to `[]`.
function qExpr(s) {
  if (typeof s !== 'string') return null;
  const m = /^\s*\{\{\s*([a-zA-Z_$][\w$]*)(\[\*\])?((?:\.[a-zA-Z_$][\w$]*)*)\s*\}\}\s*$/.exec(s);
  if (!m) return null;
  return refToJs(m[1], m[2], m[3]);
}

// Convert a user-typed "JS expression" field (FOR_EACH source, IF
// expression, WHILE expression, REPEAT count, …) into a safe inlined
// expression. Behaviour:
//   - empty                       → fallback
//   - "{{var}} < 5"               → "var < 5"           (textual subst)
//   - "{{products[*].link}}"      → "(products || []).map(_x => _x.link)"
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
  VAR_RX.lastIndex = 0;
  return t.replace(VAR_RX, (_full, root, star, rest) => refToJs(root, star, rest));
}

const q = (s) => JSON.stringify(s || '');
const num = (n, fallback = 0) => (typeof n === 'number' ? n : fallback);

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

  // ── ForEach element context ─────────────────────────────────────────────
  // When inside a FOR_EACH_ELEMENTS loop that has extractions, generate
  // element-relative code using `el.$eval(selector)` instead of page-level
  // helpers, and populate the row object instead of __results__.
  const feCtx = ctx.forEachEl; // { elVar, rowVar, hasExtractions } | undefined
  if (feCtx && feCtx.hasExtractions && isExtraction) {
    const fieldKey = (label && label.trim()) ? label : type.toLowerCase().replace('extract_', '');
    const sel = params.selector || '';
    const isSelf = sel === ':scope' || sel === '';

    switch (type) {
      case 'EXTRACT_TEXT': {
        const expr = isSelf
          ? `await ${feCtx.elVar}.evaluate(e => (e.textContent || '').trim()).catch(() => '')`
          : `await ${feCtx.elVar}.$eval(${q(sel)}, e => (e.textContent || '').trim()).catch(() => '')`;
        return `${feCtx.rowVar}[${JSON.stringify(fieldKey)}] = ${expr};\n`;
      }
      case 'EXTRACT_ATTRIBUTE': {
        const attr = params.attribute || '';
        const expr = isSelf
          ? `await ${feCtx.elVar}.evaluate((e, a) => e.getAttribute(a) || '', ${q(attr)}).catch(() => '')`
          : `await ${feCtx.elVar}.$eval(${q(sel)}, (e, a) => e.getAttribute(a) || '', ${q(attr)}).catch(() => '')`;
        return `${feCtx.rowVar}[${JSON.stringify(fieldKey)}] = ${expr};\n`;
      }
      case 'EXTRACT_HTML': {
        const prop = params.mode === 'outer' ? 'outerHTML' : 'innerHTML';
        const expr = isSelf
          ? `await ${feCtx.elVar}.evaluate(e => e.${prop}).catch(() => '')`
          : `await ${feCtx.elVar}.$eval(${q(sel)}, e => e.${prop}).catch(() => '')`;
        return `${feCtx.rowVar}[${JSON.stringify(fieldKey)}] = ${expr};\n`;
      }
      default:
        // Other extraction types (TABLE, LIST, JSON) fall through to page-level
        break;
    }
  }

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
    if (includeInOutput) {
      const key = (label && label.trim()) ? label : `extracted_${varName}`;
      if (ctx.inLoop) {
        // Inside WHILE/REPEAT: accumulate into array instead of overwriting
        store = `  if (!__results__[${JSON.stringify(key)}]) __results__[${JSON.stringify(key)}] = [];\n`
              + `  if (Array.isArray(${varName})) __results__[${JSON.stringify(key)}].push(...${varName});\n`
              + `  else if (${varName} !== null && ${varName} !== undefined) __results__[${JSON.stringify(key)}].push(${varName});\n`;
      } else {
        store = `  __results__[${JSON.stringify(key)}] = ${varName};\n`;
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
        store += `  ${alias} = ${varName};\n`;
      }
    }

    // Emit record-count / field-fill stats so the execution pipeline can
    // detect a step that "succeeded" but captured nothing and trigger
    // self-healing. Only for selector-repairable extraction types.
    if (HEALABLE_EXTRACTION_TYPES.has(type) && step.id) {
      const statsKey = (label && label.trim()) ? label : `extracted_${varName}`;
      store += `  await __emitStepStats(page, { stepId: ${JSON.stringify(step.id)}, type: ${JSON.stringify(type)}, label: ${JSON.stringify(label || '')}, key: ${JSON.stringify(statsKey)}, multiple: ${!!params.multiple} }, ${varName});\n`;
    }
  }

  switch (type) {

    // ── Navigation ───────────────────────────────────────────────────────
    case 'NAVIGATE': return `
// Navigate
await page.goto(${q(params.url)}, {
  waitUntil: ${q(advanced.waitUntil || 'load')},
  timeout: ${num(advanced.timeout, 30000)},
});
`.trim() + '\n';

    case 'GO_BACK': return `await page.goBack({ waitUntil: ${q(advanced.waitUntil || 'load')} });\n`;

    case 'RELOAD_PAGE': return `await page.reload({ waitUntil: ${q(advanced.waitUntil || 'load')} });\n`;

    case 'OPEN_NEW_TAB': return `
{
  const _newPage = await browser.newPage();
  await applyStealthToPage(_newPage);
  await _newPage.goto(${q(params.url)}, { waitUntil: 'load' });
  page = _newPage;
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
await waitForAny(page, ${selList(params)}, ${num(advanced.timeout, 30000)});
`.trim() + '\n';

    case 'WAIT_FOR_NAVIGATION': return `
await page.waitForNavigation({ waitUntil: ${q(advanced.waitUntil || 'load')}, timeout: ${num(advanced.timeout, 30000)} });
`.trim() + '\n';

    case 'BREAK_LOOP': return `break;\n`;

    // ── Extraction ───────────────────────────────────────────────────────
    case 'EXTRACT_TEXT': {
      const sels = selList(params);
      const code = params.multiple
        ? `const ${varName} = await evalOnElements(page, ${sels}, el => el.textContent.trim());\n`
        : `const ${varName} = await evalOnElement(page, ${sels}, el => el.textContent.trim()).catch(() => null);\n`;
      return code + store;
    }

    case 'EXTRACT_ATTRIBUTE': {
      const sels = selList(params);
      const attr = q(params.attribute);
      const code = params.multiple
        ? `const ${varName} = await evalOnElements(page, ${sels}, (el, a) => el.getAttribute(a), ${attr});\n`
        : `const ${varName} = await evalOnElement(page, ${sels}, (el, a) => el.getAttribute(a), ${attr}).catch(() => null);\n`;
      // Note: page.evaluate only passes one extra arg; use closure instead
      const codeFinal = params.multiple
        ? `const ${varName} = await (async () => { const _els = await resolveElements(page, ${sels}); return Promise.all(_els.map(el => page.evaluate((e, a) => e.getAttribute(a), el, ${attr}))); })();\n`
        : `const ${varName} = await (async () => { const _el = await resolveElement(page, ${sels}); return _el ? page.evaluate((e, a) => e.getAttribute(a), _el, ${attr}) : null; })();\n`;
      return codeFinal + store;
    }

    case 'EXTRACT_HTML': {
      const prop = params.mode === 'outer' ? 'outerHTML' : 'innerHTML';
      return `
const ${varName} = await evalOnElement(page, ${selList(params)}, el => el.${prop}).catch(() => null);
${store}`.trim() + '\n';
    }

    case 'EXTRACT_TABLE': return `
const ${varName} = await (async () => {
  const _tbl = await resolveElement(page, ${selList({ selector: params.selector || 'table', selectorType: params.selectorType || 'css', fallbackSelectors: params.fallbackSelectors || [] })});
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
  const _containers = await resolveElements(page, ${sels});
  return Promise.all(_containers.map(container =>
    page.evaluate((el, fields) => {
      const item = {};
      for (const [name, spec] of Object.entries(fields)) {
        const sel = spec.selector || '';
        // Empty selector means "use the container itself" (useful for
        // attribute extraction off the row element).
        const child = sel ? el.querySelector(sel) : el;
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
      if (params.format === 'csv') {
        return `
{
  const _rows = Array.isArray(${params.source}) ? ${params.source} : [${params.source}];
  const _headers = Object.keys(_rows[0] || {});
  const _csv = [_headers.join(','), ..._rows.map(r => _headers.map(h => JSON.stringify(r[h] ?? '')).join(','))].join('\\n');
  require('fs').writeFileSync(${q(params.destination)}, _csv, 'utf8');
}
`.trim() + '\n';
      }
      return `require('fs').writeFileSync(${q(params.destination)}, JSON.stringify(${params.source || 'null'}, null, 2), 'utf8');\n`;
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
      };
      subCtx.visitedSubflows.add(String(subflowId));
      // When inlining a subflow, its FIRST step is almost always a pinned
      // NAVIGATE to the URL it was authored on. The parent step already
      // opens _subPage at the URL the user wants (single mode) or the
      // current iteration's URL (iterate mode), so re-navigating to the
      // authored URL would just throw the work away. Strip a leading
      // NAVIGATE so the subflow's remaining steps run on _subPage where
      // the parent put it.
      const rawSubSteps = sub.steps || [];
      const subSteps = (
        rawSubSteps.length > 0
        && rawSubSteps[0]
        && rawSubSteps[0].kind === 'action'
        && rawSubSteps[0].type === 'NAVIGATE'
      ) ? rawSubSteps.slice(1) : rawSubSteps;
      const subCode  = genStepList(subSteps, subCtx, params.mode === 'iterate' ? 5 : 4);
      const subAliasDecls = subCtx.capturedAliases.size === 0 ? '' :
        Array.from(subCtx.capturedAliases).map(a =>
          (params.mode === 'iterate' ? '        ' : '      ') + `let ${a};`
        ).join('\n');

      const safeSubName = (sub.name || 'unnamed').replace(/\*\//g, '*\\/');
      const timeoutMs   = num(advanced.timeout, 30000);

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
          `  const _urlList = Array.isArray(_urls) ? _urls : [];`,
          `  if (!__results__[${JSON.stringify(outKey)}]) __results__[${JSON.stringify(outKey)}] = [];`,
          `  console.log('ITER_START:' + JSON.stringify({stepId: ${subIdJson}, total: _urlList.length}));`,
          `  for (let _i = 0; _i < _urlList.length; _i++) {`,
          `    console.log('ITER_TICK:' + JSON.stringify({stepId: ${subIdJson}, index: _i}));`,
          `    const ${itemVar} = _urlList[_i];`,
          `    if (${itemVar} == null || ${itemVar} === '') continue;`,
          `    const _subPage = await browser.newPage();`,
          `    try {`,
          `      await applyStealthToPage(_subPage);`,
          `      await _subPage.goto(String(${itemVar}), { waitUntil: 'load', timeout: ${timeoutMs} });`,
          `      const _subResults = await (async (page) => {`,
          `        const __results__ = {};`,
          `        let __currentStep__ = null;`,
          subAliasDecls,
          `        try {`,
          subCode,
          `        } catch (err) {`,
          `          console.error(${JSON.stringify(`Subflow ${outKey} iteration error:`)}, err && err.message);`,
          `        }`,
          `        return __results__;`,
          `      })(_subPage);`,
          `      _subResults._sourceUrl = String(${itemVar});`,
          `      __results__[${JSON.stringify(outKey)}].push(_subResults);`,
          `    } catch (err) {`,
          `      console.error(${JSON.stringify(`Subflow ${outKey} failed on URL`)}, ${itemVar}, '—', err && err.message);`,
          `    } finally {`,
          `      try { await _subPage.close(); } catch (_) {}`,
          `    }`,
          `  }`,
          `  console.log('ITER_END:' + JSON.stringify({stepId: ${subIdJson}}));`,
          `}`,
          ``,
        ].join('\n');
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
        `  const _subPage = await browser.newPage();`,
        `  try {`,
        `    await applyStealthToPage(_subPage);`,
        `    await _subPage.goto(_subUrl, { waitUntil: 'load', timeout: ${timeoutMs} });`,
        `    const _subResults = await (async (page) => {`,
        `      const __results__ = {};`,
        `      let __currentStep__ = null;`,
        subAliasDecls,
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
      return `{\n  const _src = ${src};\n  const _arr = Array.isArray(_src) ? _src : (_src || []);\n  console.log('ITER_START:' + JSON.stringify({stepId: ${stepIdJson}, total: _arr.length}));\n  for (let ${idx} = 0; ${idx} < _arr.length; ${idx}++) {\n    console.log('ITER_TICK:' + JSON.stringify({stepId: ${stepIdJson}, index: ${idx}}));\n    const ${item} = _arr[${idx}];\n${body}  }\n  console.log('ITER_END:' + JSON.stringify({stepId: ${stepIdJson}}));\n}\n`;
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

      // Mirror the rows into a JS-visible alias so downstream steps can
      // reference it as `<label>` (e.g. a FOR_EACH source field). Same
      // trick we use for standalone extraction steps.
      const aliasName = step.label && step.label.trim() ? toJsIdent(step.label.trim()) : '';
      const aliasLine = (aliasName && !ctx.declaredVars?.has(aliasName))
        ? (ctx.capturedAliases && ctx.capturedAliases.add(aliasName), `${aliasName} = ${resultsVar};`)
        : '';

      // Same "Include in final output" semantics as standalone
      // extractions — the JS alias is still emitted so the rows are
      // usable downstream even if the user opts out of putting the
      // table in the results JSON.
      const includeInOutput = (step.advanced && step.advanced.includeInOutput) !== false;
      const writebackLine = includeInOutput
        ? `__results__[${JSON.stringify(resultsKey)}] = ${resultsVar};`
        : `// (${resultsKey}: kept as JS variable only — excluded from results JSON)`;

      // Iteration markers (see FOR_EACH for the rationale).
      const feIdJson = JSON.stringify(step.id || '');
      if (hasExtractions) {
        return [
          `const ${resultsVar} = [];`,
          `{`,
          `  const ${elsVar} = await page.$$(${sel});`,
          `  console.log('ITER_START:' + JSON.stringify({stepId: ${feIdJson}, total: ${elsVar}.length}));`,
          `  for (let ${idxVar} = 0; ${idxVar} < ${elsVar}.length; ${idxVar}++) {`,
          `    console.log('ITER_TICK:' + JSON.stringify({stepId: ${feIdJson}, index: ${idxVar}}));`,
          `    const ${elVar} = ${elsVar}[${idxVar}];`,
          `    const ${rowVar} = { _index: ${idxVar} + 1 };`,
          body.trimEnd(),
          `    ${resultsVar}.push(${rowVar});`,
          `  }`,
          `  console.log('ITER_END:' + JSON.stringify({stepId: ${feIdJson}}));`,
          `}`,
          writebackLine,
          aliasLine,
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
        `  console.log('ITER_START:' + JSON.stringify({stepId: ${feIdJson}, total: ${elsVar}.length}));`,
        `  for (let ${idxVar} = 0; ${idxVar} < ${elsVar}.length; ${idxVar}++) {`,
        `    console.log('ITER_TICK:' + JSON.stringify({stepId: ${feIdJson}, index: ${idxVar}}));`,
        `    const ${elVar} = ${elsVar}[${idxVar}];`,
        body.trimEnd(),
        `  }`,
        `  console.log('ITER_END:' + JSON.stringify({stepId: ${feIdJson}}));`,
        `}`,
        ``,
      ].join('\n');
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
  console.log('ITER_START:' + JSON.stringify({stepId: ${stepIdJson}, total: 0}));
  while ((${expr}) && _whileGuard < ${max}) {
    console.log('ITER_TICK:' + JSON.stringify({stepId: ${stepIdJson}, index: _whileGuard}));
    _whileGuard++;
${body}  }
  console.log('ITER_END:' + JSON.stringify({stepId: ${stepIdJson}}));
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
      return `for (let ${idx} = 0; ${idx} < ${count}; ${idx}++) {\n${body}}\n`;
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
  const json = JSON.stringify(info);
  // Embed the json as a JS string literal — JSON is valid JS for objects
  // but we use JSON.stringify of the literal to be safe against odd chars.
  return `__currentStep__ = ${JSON.stringify(info)};\nconsole.log('STEP_BEGIN:' + ${JSON.stringify(json)});\n`;
}

function genStepList(steps, ctx, depth = 0) {
  const pad = '  '.repeat(depth);
  return steps.map(step => {
    const marker = stepMarker(step);
    const raw = step.kind === 'control'
      ? genControl(step, ctx, depth)
      : genAction(step, ctx);
    const combined = marker + raw;
    return combined.split('\n').map(l => (l.trim() ? pad + l : l)).join('\n');
  }).join('');
}

/* =========================================================================
   MAIN EXPORT: generateCode(workflow) → string
   workflow = { steps: [...], meta: { startUrl, viewport } }
   ========================================================================= */
function generateCode(workflow) {
  const steps    = workflow.steps   || [];
  const startUrl = workflow.meta?.startUrl || null;
  const vpW      = workflow.meta?.viewportWidth  || 1280;
  const vpH      = workflow.meta?.viewportHeight || 720;
  const variables = Array.isArray(workflow.meta?.variables) ? workflow.meta.variables : [];

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
  };

  const stepCode = genStepList(steps, ctx, 2);

  // Now that step codegen is done, ctx.capturedAliases holds every alias
  // we need to declare. Render them as `let <name>;` lines at the top of
  // run() so assignments inside try / loop / catch blocks land on
  // function-scoped slots that subsequent steps can read.
  const capturedAliasesCode = ctx.capturedAliases.size === 0 ? '' :
    '\n  // ─── Captured outputs (from named extraction steps) ──────────\n' +
    Array.from(ctx.capturedAliases).map(a => `  let ${a};`).join('\n') +
    '\n  // ─────────────────────────────────────────────────────────────';

  return `#!/usr/bin/env node
'use strict';

/**
 * Generated by WebScraper — ${new Date().toISOString()}
 * Run:  node workflow.js
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const STEALTH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function applyStealthToPage(page) {
  try {
    const client = await page.target().createCDPSession();
    await client.send('Emulation.setUserAgentOverride', {
      userAgent: STEALTH_UA,
      platform: 'Win32',
    });
    await client.send('Emulation.setLocaleOverride', { locale: 'en-US' }).catch(() => {});
    await client.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' }).catch(() => {});
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    });
  } catch (_) {}
}

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
 * Wait until any selector in the list appears within timeout ms.
 * Returns the ElementHandle of the first match found.
 * Throws if nothing resolves in time.
 */
async function waitForAny(page, selectors, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    for (const { value, type } of selectors) {
      try {
        const el = type === 'xpath'
          ? (await page.$x(value))[0]
          : await page.$(value);
        if (el) return el;
      } catch (e) { lastErr = e; }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  const tried = selectors.map(s => \`[\${s.type}] \${s.value}\`).join(', ');
  throw new Error(\`waitForAny: none matched within \${timeout}ms. Tried: \${tried}\`);
}

/**
 * Run page.evaluate(fn, el) with XPath-aware element resolution.
 */
async function evalOnElement(page, selectors, fn) {
  const el = await resolveElement(page, selectors);
  if (!el) throw new Error('evalOnElement: element not found for selectors: ' + JSON.stringify(selectors));
  return page.evaluate(fn, el);
}

/**
 * Run page.evaluate(fn, el) on ALL elements matched by the first working selector.
 */
async function evalOnElements(page, selectors, fn) {
  const els = await resolveElements(page, selectors);
  if (!els.length) return [];
  return Promise.all(els.map(el => page.evaluate(fn, el)));
}

/**
 * Snapshot a cleaned version of the page's HTML, useful as context to an
 * LLM-based workflow repair step. We strip head, scripts and styles to
 * keep the snippet focused on visible structure (which is what selectors
 * usually target). Truncated to keep the payload small for the LLM.
 */
async function __snapshotPageHtml(page) {
  if (!page) return null;
  try {
    return await page.evaluate(() => {
      try {
        const root = document.documentElement.cloneNode(true);
        root.querySelectorAll('head, script, style, noscript, link, meta, template, svg').forEach(n => n.remove());
        // Drop inline event handlers + base64 data: srcs which aren't useful here
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

/**
 * Compute record-count + per-field fill statistics for an extraction result.
 * A list/multiple result is an array (count = length; fields tallied from the
 * row objects). A scalar is 0 (nothing) or 1. This is what lets the platform
 * notice a step that "succeeded" but captured nothing — the silent failure a
 * broken selector produces.
 */
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

// A result worth snapshotting for possible self-healing. For a COLLECTION
// (list/loop) that means ≤1 record or a field empty in every record; for a
// SCALAR single value it means nothing came back (count 1 is the healthy
// state for a single extraction, so it must NOT trigger a snapshot).
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

// ─── Field transform runtime (clean / split per-field pipelines) ──────────
// Inlined verbatim from backend/workflow/fieldTransforms.js so the generated
// script can post-process EXTRACT_LIST rows without external deps.
${FIELD_TRANSFORM_RUNTIME}

function __safeUrl(page) { try { return page.url(); } catch (_) { return null; } }

// Emit a STEP_RESULT marker (record counts / field fill) for an extraction,
// plus a STEP_SNAPSHOT of the page when the result looks broken — the runner
// forwards both to the execution pipeline, which decides whether to self-heal.
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

async function run() {
  const __results__ = {};
  let __currentStep__ = null;
${variablesCode}${capturedAliasesCode}
  const browser = await puppeteer.launch({
    // Honour CHROME_PATH when set (Linux servers / CI / containers); fall back
    // to the local Chrome install used during development.
    executablePath: process.env.CHROME_PATH || 'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=${vpW},${vpH}',
    ],
  });

  let page = await browser.newPage();
  await applyStealthToPage(page);
  await page.setViewport({ width: ${vpW}, height: ${vpH}, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // NOTE: The workflow's first step is the explicit NAVIGATE that pins
  // the start URL — we don't inject an extra page.goto here so the run
  // doesn't double-navigate when the user already has that step in the
  // workflow tree.

  try {
${stepCode}
  } catch (err) {
    console.error('❌ Workflow error:', err.message);
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
    process.exitCode = 1;
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
    console.log('\\nWORKFLOW_RESULTS:' + JSON.stringify(__results__));
  }
}

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

module.exports = { generateCode };
'use strict';

// ─── Extraction action types (steps that produce named data) ──────────────
const EXTRACTION_TYPES = new Set([
  'EXTRACT_TEXT', 'EXTRACT_ATTRIBUTE', 'EXTRACT_HTML',
  'EXTRACT_TABLE', 'EXTRACT_LIST', 'EXTRACT_JSON',
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
// string-or-falsy). qStr handles workflow-variable interpolation: if `s`
// contains `{{name}}` references to a DECLARED variable, the output is a
// template literal so the actual JS variable is read at runtime. Refs to
// undeclared names are left as literal text — that way users can write
// "{{not a var}}" and have it appear verbatim.
//
// Both helpers escape backticks / existing ${...} sequences so the
// generated code stays well-formed even when the user types tricky text.
const VAR_RX = /\{\{\s*([a-zA-Z_$][\w$]*)\s*\}\}/g;

function qStr(s, declaredVars) {
  if (typeof s !== 'string') return JSON.stringify(s == null ? '' : String(s));
  // No variables declared on this workflow → cheap path.
  if (!declaredVars || declaredVars.size === 0) return JSON.stringify(s);
  // Quickly bail if there's no interpolation marker at all.
  if (!s.includes('{{')) return JSON.stringify(s);

  // Scan for at least ONE reference to a declared variable. Otherwise
  // we don't need a template literal.
  let hasInterp = false;
  let m; VAR_RX.lastIndex = 0;
  while ((m = VAR_RX.exec(s)) !== null) {
    if (declaredVars.has(m[1])) { hasInterp = true; break; }
  }
  if (!hasInterp) return JSON.stringify(s);

  // Escape characters that would otherwise change the meaning of the
  // template literal.
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
  // Now substitute declared {{var}} → ${var}; leave others untouched.
  const interpolated = escaped.replace(VAR_RX, (full, name) =>
    declaredVars.has(name) ? '${' + name + '}' : full
  );
  return '`' + interpolated + '`';
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
      const normalised = {};
      for (const [name, v] of Object.entries(rawFields)) {
        if (v == null) continue;
        if (typeof v === 'string') {
          normalised[name] = { selector: v, kind: 'text', attribute: null };
        } else if (typeof v === 'object') {
          const kind = v.kind === 'attr' || v.kind === 'attribute' ? 'attr'
                     : v.kind === 'html' ? 'html'
                     : 'text';
          normalised[name] = {
            selector: typeof v.selector === 'string' ? v.selector : '',
            kind,
            attribute: kind === 'attr' && typeof v.attribute === 'string' ? v.attribute : null,
          };
        }
      }
      const fieldsJson = JSON.stringify(normalised);
      const sels = selList({
        selector: params.containerSelector,
        selectorType: params.selectorType || 'css',
        fallbackSelectors: params.fallbackSelectors || [],
      });
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
  ));
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
      const expr = params.expression || 'false';
      const thenCode = genStepList(step.then || [], ctx, depth + 1);
      const elseCode = genStepList(step.else || [], ctx, depth + 1);
      return `if (${expr}) {\n${thenCode}} else {\n${elseCode}}\n`;
    }

    case 'FOR_EACH': {
      const src    = params.source   || '[]';
      const item   = params.itemVar  || 'item';
      const idx    = params.indexVar || 'index';
      const body   = genStepList(step.body || [], ctx, depth + 1);
      return `for (let ${idx} = 0; ${idx} < (${src} || []).length; ${idx}++) {\n  const ${item} = ${src}[${idx}];\n${body}}\n`;
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
      const body = genStepList(bodySteps, ctx, depth + 1);
      ctx.forEachEl = prevCtx;

      if (hasExtractions) {
        return [
          `const ${resultsVar} = [];`,
          `{`,
          `  const ${elsVar} = await page.$$(${sel});`,
          `  for (let ${idxVar} = 0; ${idxVar} < ${elsVar}.length; ${idxVar}++) {`,
          `    const ${elVar} = ${elsVar}[${idxVar}];`,
          `    const ${rowVar} = { _index: ${idxVar} + 1 };`,
          body.trimEnd(),
          `    ${resultsVar}.push(${rowVar});`,
          `  }`,
          `}`,
          `__results__[${JSON.stringify(resultsKey)}] = ${resultsVar};`,
          ``,
        ].join('\n');
      }

      return [
        `{`,
        `  const ${elsVar} = await page.$$(${sel});`,
        `  for (let ${idxVar} = 0; ${idxVar} < ${elsVar}.length; ${idxVar}++) {`,
        `    const ${elVar} = ${elsVar}[${idxVar}];`,
        body.trimEnd(),
        `  }`,
        `}`,
        ``,
      ].join('\n');
    }


    case 'WHILE': {
      const expr = params.expression || 'false';
      const max  = num(params.maxIterations, 1000);
      const body = genStepList(step.body || [], { ...ctx, inLoop: true }, depth + 1);
      return `{
  let _whileGuard = 0;
  while ((${expr}) && _whileGuard < ${max}) {
    _whileGuard++;
${body}  }
}
`.trim() + '\n';
    }

    case 'REPEAT': {
      const count = num(params.count, 10);
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
  };

  const stepCode = genStepList(steps, ctx, 2);

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

async function run() {
  const __results__ = {};
  let __currentStep__ = null;
${variablesCode}
  const browser = await puppeteer.launch({
    // to delete:
    executablePath: 'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
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
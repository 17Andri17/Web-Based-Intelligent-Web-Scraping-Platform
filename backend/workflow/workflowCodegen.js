'use strict';

// ─── Extraction action types (steps that produce named data) ──────────────
const EXTRACTION_TYPES = new Set([
  'EXTRACT_TEXT', 'EXTRACT_ATTRIBUTE', 'EXTRACT_HTML',
  'EXTRACT_TABLE', 'EXTRACT_LIST', 'EXTRACT_JSON',
]);

// ─── Indent helper ────────────────────────────────────────────────────────
const indent = (code, levels = 1) =>
  code.split('\n').map(line => '  '.repeat(levels) + line).join('\n');

// ─── Selector quoting helper ──────────────────────────────────────────────
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
  let store = '';
  if (isExtraction) {
    const key = (label && label.trim()) ? label : `extracted_${varName}`;
    store = `  __results__[${JSON.stringify(key)}] = ${varName};\n`;
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
      const navWait = advanced.waitForNavigation
        ? `await page.waitForNavigation({ timeout: ${num(advanced.timeout, 10000)} });`
        : '';
      return `
// Click: ${params.selector}
await page.waitForSelector(${q(params.selector)}, { timeout: ${num(advanced.timeout, 10000)} });
${navWait ? `await Promise.all([\n  page.waitForNavigation({ timeout: ${num(advanced.timeout, 10000)} }),\n  page.click(${q(params.selector)}),\n]);` : `await page.click(${q(params.selector)});`}
`.trim() + '\n';
    }

    case 'HOVER_ELEMENT': return `
await page.waitForSelector(${q(params.selector)}, { timeout: ${num(advanced.timeout, 10000)} });
await page.hover(${q(params.selector)});
`.trim() + '\n';

    case 'TYPE_TEXT': return `
await page.waitForSelector(${q(params.selector)}, { timeout: 10000 });
${params.clearFirst !== false ? `await page.evaluate(sel => { document.querySelector(sel).value = ''; }, ${q(params.selector)});` : ''}
await page.type(${q(params.selector)}, ${q(params.text)}, { delay: ${num(advanced.delay, 0)} });
${params.pressEnter ? `await page.keyboard.press('Enter');` : ''}
`.trim() + '\n';

    case 'CLEAR_INPUT': return `
await page.evaluate(sel => { const el = document.querySelector(sel); if (el) el.value = ''; }, ${q(params.selector)});
`.trim() + '\n';

    case 'PRESS_KEY': {
      const count = num(advanced.count, 1);
      if (params.selector) {
        return `for (let _i = 0; _i < ${count}; _i++) await page.press(${q(params.selector)}, ${q(params.key)});\n`;
      }
      return `for (let _i = 0; _i < ${count}; _i++) await page.keyboard.press(${q(params.key)});\n`;
    }

    case 'SCROLL_TO_ELEMENT': return `
await page.waitForSelector(${q(params.selector)}, { timeout: 10000 });
await page.$eval(${q(params.selector)}, el => el.scrollIntoView({ behavior: ${q(advanced.behavior || 'auto')}, block: 'center' }));
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
  const _fileInput = await page.$(${q(params.selector)});
  if (_fileInput) await _fileInput.uploadFile(${q(params.filePath)});
}
`.trim() + '\n';

    // ── Flow control (leaf variants used inside generated code) ──────────
    case 'WAIT': return `await new Promise(r => setTimeout(r, ${num(params.duration, 1000)}));\n`;

    case 'WAIT_FOR_SELECTOR': return `
await page.waitForSelector(${q(params.selector)}, {
  visible: ${params.state === 'visible' || !params.state},
  hidden: ${params.state === 'hidden'},
  timeout: ${num(advanced.timeout, 30000)},
});
`.trim() + '\n';

    case 'WAIT_FOR_NAVIGATION': return `
await page.waitForNavigation({ waitUntil: ${q(advanced.waitUntil || 'load')}, timeout: ${num(advanced.timeout, 30000)} });
`.trim() + '\n';

    case 'BREAK_LOOP': return `break;\n`;

    // ── Extraction ───────────────────────────────────────────────────────
    case 'EXTRACT_TEXT': {
      const code = params.multiple
        ? `const ${varName} = await page.$$eval(${q(params.selector)}, els => els.map(e => e.textContent.trim()));\n`
        : `const ${varName} = await page.$eval(${q(params.selector)}, el => el.textContent.trim()).catch(() => null);\n`;
      return code + store;
    }

    case 'EXTRACT_ATTRIBUTE': {
      const attr = q(params.attribute);
      const code = params.multiple
        ? `const ${varName} = await page.$$eval(${q(params.selector)}, (els, a) => els.map(e => e.getAttribute(a)), ${attr});\n`
        : `const ${varName} = await page.$eval(${q(params.selector)}, (el, a) => el.getAttribute(a), ${attr}).catch(() => null);\n`;
      return code + store;
    }

    case 'EXTRACT_HTML': {
      const prop = params.mode === 'outer' ? 'outerHTML' : 'innerHTML';
      return `
const ${varName} = await page.$eval(${q(params.selector)}, el => el.${prop}).catch(() => null);
${store}`.trim() + '\n';
    }

    case 'EXTRACT_TABLE': return `
const ${varName} = await page.$eval(${q(params.selector || 'table')}, (table, hasHeader) => {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (hasHeader && rows.length > 0) {
    const headers = Array.from(rows[0].querySelectorAll('th,td')).map(c => c.textContent.trim());
    return rows.slice(1).map(row => {
      const cells = Array.from(row.querySelectorAll('td,th')).map(c => c.textContent.trim());
      return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? null]));
    });
  }
  return rows.map(r => Array.from(r.querySelectorAll('td,th')).map(c => c.textContent.trim()));
}, ${params.hasHeader !== false}).catch(() => null);
${store}`.trim() + '\n';

    case 'EXTRACT_LIST': {
      const fields = JSON.stringify(params.fields || {});
      return `
const ${varName} = await page.$$eval(
  ${q(params.containerSelector)},
  (containers, fields) => containers.map(container => {
    const item = {};
    for (const [name, sel] of Object.entries(fields)) {
      const el = container.querySelector(sel);
      item[name] = el ? el.textContent.trim() : null;
    }
    return item;
  }),
  ${fields}
).catch(() => []);
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

    case 'WHILE': {
      const expr = params.expression || 'false';
      const max  = num(params.maxIterations, 1000);
      const body = genStepList(step.body || [], ctx, depth + 1);
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
      const body  = genStepList(step.body || [], ctx, depth + 1);
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
   ========================================================================= */
function genStepList(steps, ctx, depth = 0) {
  const pad = '  '.repeat(depth);
  return steps.map(step => {
    const raw = step.kind === 'control'
      ? genControl(step, ctx, depth)
      : genAction(step, ctx);
    // Indent each line by current depth
    return raw.split('\n').map(l => (l.trim() ? pad + l : l)).join('\n');
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

  // ID counter for unique variable names when outputVar is missing
  let idCounter = 0;
  const ctx = { nextId: () => (idCounter++).toString(36) };

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

async function run() {
  const __results__ = {};

  const browser = await puppeteer.launch({
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

  ${startUrl ? `// Starting URL from recording session\n  await page.goto(${q(startUrl)}, { waitUntil: 'networkidle2' });` : ''}

  try {
${stepCode}
  } catch (err) {
    console.error('❌ Workflow error:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }

  // Output collected extraction results
  if (Object.keys(__results__).length > 0) {
    console.log('');
    console.log('WORKFLOW_RESULTS:' + JSON.stringify(__results__));
  }
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
`;
}

module.exports = { generateCode };
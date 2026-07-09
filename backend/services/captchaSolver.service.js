'use strict';

/* ===========================================================================
   CAPTCHA solver — pluggable provider abstraction
   ---------------------------------------------------------------------------
   ONE place that knows how to turn a detected challenge
   ({ type, sitekey, url, action }) into a solution TOKEN by talking to a
   third-party solving service. Everything above it (the live editor's
   "auto-solve" button, the generated scrape script's SOLVE_CAPTCHA / auto
   handling) is provider-agnostic — it just asks for a token.

   ── Cost / free-tier design ────────────────────────────────────────────────
   The default provider is `none`: no key, no network calls, no cost. In that
   mode the platform DETECTS captchas (always free) and either lets the user
   solve them by hand in the live editor (the CDP stream forwards real
   mouse/keyboard, so a human can just click it) or flags a headless run as
   `needs_review`. You only start paying when you opt in by setting:

       CAPTCHA_PROVIDER = capsolver | twocaptcha
       CAPTCHA_API_KEY  = <your key>

   Rough pricing when you're ready for production (per 1000 solves):
       capsolver   ~ $0.30–0.80   (AI-based, cheapest for tokens)
       twocaptcha  ~ $1–3         (human+AI, widest coverage, very reliable)
   You pay per solve, so a workflow that trips a captcha once per run and runs
   a few thousand times a month costs single-digit dollars.

   ── Why the client lives here as a SOURCE STRING ──────────────────────────
   Generated scrape scripts run as standalone child processes that can only
   `require('puppeteer')` (+ NODE_PATH to backend/node_modules) — they can't
   pull in this service. So the actual HTTP polling logic is authored ONCE as
   `PROVIDER_CLIENT_SRC` (plain, dependency-free, uses global fetch) and:
     - inlined verbatim into generated scripts by workflowCodegen.js, and
     - evaluated here so the backend live-editor path runs the exact same code.
   Same pattern consent.js uses with CONSENT_CASCADE_SRC — one implementation,
   two consumers, no drift.
   ========================================================================= */

// The captcha "types" our detector emits and this solver understands. Kept in
// sync with backend/browser/captcha.js.
const SUPPORTED_TYPES = new Set([
  'recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'turnstile',
]);

/* ---------------------------------------------------------------------------
   PROVIDER_CLIENT_SRC — dependency-free, self-contained.
   Defines an async function:

     __captchaSolveToken(cfg, task) -> Promise<{ ok, token?, error?, code? }>

   cfg  = { provider, apiKey, timeoutMs, pollMs }
   task = { type, sitekey, url, action?, proxy? }

   Never throws — always resolves to a result object so callers can decide how
   to degrade (wait / flag / fail) without try/catch noise. Uses global fetch
   (Node 18+, already a hard requirement — see services/llm.service.js).
   --------------------------------------------------------------------------- */
const PROVIDER_CLIENT_SRC = `
async function __captchaSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function __captchaHttpJson(url, opts, timeoutMs) {
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, timeoutMs || 20000);
  try {
    var res = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
    var text = await res.text();
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    return { ok: res.ok, status: res.status, json: json, text: text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: '', error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ── CapSolver (https://api.capsolver.com) ──────────────────────────────────
// createTask → poll getTaskResult. AI-based, cheapest per-token provider.
async function __captchaSolveCapsolver(cfg, task) {
  var base = 'https://api.capsolver.com';
  var taskType;
  if (task.type === 'recaptcha_v2')      taskType = 'ReCaptchaV2TaskProxyLess';
  else if (task.type === 'recaptcha_v3') taskType = 'ReCaptchaV3TaskProxyLess';
  else if (task.type === 'hcaptcha')     taskType = 'HCaptchaTaskProxyLess';
  else if (task.type === 'turnstile')    taskType = 'AntiTurnstileTaskProxyLess';
  else return { ok: false, error: 'unsupported captcha type for capsolver: ' + task.type, code: 'UNSUPPORTED' };

  var taskPayload = { type: taskType, websiteURL: task.url, websiteKey: task.sitekey };
  if (task.type === 'recaptcha_v3') { taskPayload.pageAction = task.action || 'verify'; taskPayload.minScore = 0.7; }

  var created = await __captchaHttpJson(base + '/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: cfg.apiKey, task: taskPayload }),
  }, cfg.timeoutMs);
  if (!created.json) return { ok: false, error: 'capsolver createTask: no response' + (created.error ? ' (' + created.error + ')' : ''), code: 'NET' };
  if (created.json.errorId) return { ok: false, error: 'capsolver: ' + (created.json.errorDescription || created.json.errorCode || 'createTask failed'), code: created.json.errorCode || 'CREATE_FAILED' };
  var taskId = created.json.taskId;
  if (!taskId) return { ok: false, error: 'capsolver: missing taskId', code: 'CREATE_FAILED' };

  var deadline = Date.now() + (cfg.overallTimeoutMs || 180000);
  while (Date.now() < deadline) {
    await __captchaSleep(cfg.pollMs || 3000);
    var got = await __captchaHttpJson(base + '/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: cfg.apiKey, taskId: taskId }),
    }, cfg.timeoutMs);
    if (!got.json) continue;
    if (got.json.errorId) return { ok: false, error: 'capsolver: ' + (got.json.errorDescription || 'getTaskResult failed'), code: got.json.errorCode || 'SOLVE_FAILED' };
    if (got.json.status === 'ready') {
      var sol = got.json.solution || {};
      var token = sol.gRecaptchaResponse || sol.token || sol.captchaToken || null;
      if (token) return { ok: true, token: token };
      return { ok: false, error: 'capsolver: ready but no token in solution', code: 'NO_TOKEN' };
    }
    // status === 'processing' → keep polling
  }
  return { ok: false, error: 'capsolver: timed out waiting for solution', code: 'TIMEOUT' };
}

// ── 2Captcha (https://2captcha.com) ────────────────────────────────────────
// in.php (submit) → res.php (poll). Human+AI, widest coverage.
async function __captchaSolve2captcha(cfg, task) {
  var base = 'https://2captcha.com';
  var params = new URLSearchParams();
  params.set('key', cfg.apiKey);
  params.set('json', '1');
  params.set('pageurl', task.url);
  if (task.type === 'recaptcha_v2') { params.set('method', 'userrecaptcha'); params.set('googlekey', task.sitekey); }
  else if (task.type === 'recaptcha_v3') { params.set('method', 'userrecaptcha'); params.set('version', 'v3'); params.set('googlekey', task.sitekey); params.set('action', task.action || 'verify'); params.set('min_score', '0.7'); }
  else if (task.type === 'hcaptcha') { params.set('method', 'hcaptcha'); params.set('sitekey', task.sitekey); }
  else if (task.type === 'turnstile') { params.set('method', 'turnstile'); params.set('sitekey', task.sitekey); }
  else return { ok: false, error: 'unsupported captcha type for 2captcha: ' + task.type, code: 'UNSUPPORTED' };

  var submit = await __captchaHttpJson(base + '/in.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  }, cfg.timeoutMs);
  if (!submit.json) return { ok: false, error: '2captcha in.php: no response' + (submit.error ? ' (' + submit.error + ')' : ''), code: 'NET' };
  if (submit.json.status !== 1) return { ok: false, error: '2captcha: ' + (submit.json.request || 'submit failed'), code: submit.json.request || 'CREATE_FAILED' };
  var id = submit.json.request;

  var deadline = Date.now() + (cfg.overallTimeoutMs || 180000);
  // First result is rarely ready before ~15s; poll politely thereafter.
  await __captchaSleep(Math.max(cfg.pollMs || 5000, 5000));
  while (Date.now() < deadline) {
    var got = await __captchaHttpJson(base + '/res.php?key=' + encodeURIComponent(cfg.apiKey) + '&action=get&json=1&id=' + encodeURIComponent(id), {}, cfg.timeoutMs);
    if (got.json) {
      if (got.json.status === 1) return { ok: true, token: got.json.request };
      if (got.json.request && got.json.request !== 'CAPCHA_NOT_READY') return { ok: false, error: '2captcha: ' + got.json.request, code: got.json.request };
    }
    await __captchaSleep(cfg.pollMs || 5000);
  }
  return { ok: false, error: '2captcha: timed out waiting for solution', code: 'TIMEOUT' };
}

async function __captchaSolveToken(cfg, task) {
  if (!cfg || !cfg.provider || cfg.provider === 'none') return { ok: false, error: 'no captcha provider configured', code: 'NO_PROVIDER' };
  if (!cfg.apiKey) return { ok: false, error: 'captcha provider has no API key (set CAPTCHA_API_KEY)', code: 'NO_API_KEY' };
  if (!task || !task.sitekey || !task.url) return { ok: false, error: 'captcha task missing sitekey/url', code: 'BAD_TASK' };
  try {
    if (cfg.provider === 'capsolver')  return await __captchaSolveCapsolver(cfg, task);
    if (cfg.provider === 'twocaptcha') return await __captchaSolve2captcha(cfg, task);
    return { ok: false, error: 'unknown captcha provider: ' + cfg.provider, code: 'UNKNOWN_PROVIDER' };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e), code: 'EXCEPTION' };
  }
}
`;

// Build a live callable from the same source the generated scripts inline, so
// the backend live-editor path can't drift from the scrape-run path.
// eslint-disable-next-line no-new-func
const __captchaSolveToken = new Function(
  PROVIDER_CLIENT_SRC + '\nreturn __captchaSolveToken;'
)();

// Normalise a provider name from env. Accepts a few common aliases so users
// aren't tripped up by "2captcha" vs "twocaptcha".
function normalizeProvider(raw) {
  const p = String(raw || 'none').trim().toLowerCase();
  if (p === '2captcha' || p === 'two-captcha' || p === 'twocaptcha') return 'twocaptcha';
  if (p === 'capsolver' || p === 'cap-solver') return 'capsolver';
  if (!p || p === 'none' || p === 'off' || p === 'manual') return 'none';
  return p; // unknown → surfaced as an error at solve time
}

function getConfig() {
  return {
    provider: normalizeProvider(process.env.CAPTCHA_PROVIDER),
    apiKey: process.env.CAPTCHA_API_KEY || '',
    timeoutMs: Number(process.env.CAPTCHA_HTTP_TIMEOUT_MS) || 20000,
    pollMs: Number(process.env.CAPTCHA_POLL_MS) || (normalizeProvider(process.env.CAPTCHA_PROVIDER) === 'twocaptcha' ? 5000 : 3000),
    overallTimeoutMs: Number(process.env.CAPTCHA_SOLVE_TIMEOUT_MS) || 180000,
  };
}

// True when a real solving provider + key are set. `none` (default) is free
// and always returns false here — callers then fall back to manual / flagging.
function isConfigured() {
  const cfg = getConfig();
  return cfg.provider !== 'none' && !!cfg.apiKey;
}

function getProviderName() {
  return getConfig().provider;
}

function isSupportedType(type) {
  return SUPPORTED_TYPES.has(type);
}

// Solve a detected challenge into a token. Never throws.
//   task = { type, sitekey, url, action? }
async function solveToken(task) {
  const cfg = getConfig();
  return __captchaSolveToken(cfg, task || {});
}

module.exports = {
  PROVIDER_CLIENT_SRC,
  SUPPORTED_TYPES,
  isConfigured,
  isSupportedType,
  getProviderName,
  getConfig,
  solveToken,
};

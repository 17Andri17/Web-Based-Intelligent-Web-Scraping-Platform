'use strict';

/* ===========================================================================
   apiReplay
   ---------------------------------------------------------------------------
   Verifies a discovered API source (from apiDiscovery.service.js) by actually
   replaying its request and checking the response still contains the data the
   page showed. This is what turns a heuristic guess into a proven fact — and
   it empirically settles the authorization question the discovery heuristics
   can only guess at:

     • Replay with NO credentials (cookies + auth headers stripped). If it
       still returns the data, the endpoint is genuinely OPEN — regardless of
       what auth headers the browser happened to attach. → "open-verified".
     • If that fails, replay WITH the browser's session cookies + captured
       auth headers. If THAT returns the data, the endpoint works but needs
       the logged-in session we already have. → "verified".
     • If both fail, it's guarded (WAF / anti-bot / signed) → "blocked".

   Safety: replay runs server-side, so a malicious page could try to get us to
   fetch an internal address (SSRF). We only replay public http(s) hosts and
   block loopback / private / link-local / cloud-metadata targets.

   Public:
     verify(source, opts)      → { ...result }         (single source)
     verifyMany(sources, opts) → sources with `.verification` attached
   ========================================================================= */

const { scoreValueMatch, findPrimaryCollection } = require('./apiDiscovery.service');

const fetchFn = (typeof global.fetch === 'function') ? global.fetch : require('node-fetch');

const REPLAY_TIMEOUT_MS   = 7000;
const MAX_REPLAY_BODY      = 1.5 * 1024 * 1024;
const DEFAULT_CONCURRENCY  = 3;
const DEFAULT_MAX_VERIFY   = 5;

// Header/query patterns that carry credentials — stripped for the "is it open?"
// probe. (Kept in sync with apiDiscovery's classifier intent.)
const CRED_HEADER_RE = /^(authorization|cookie|x-api-key|api-key|apikey|x-app-key|x-appkey|x-auth-token|x-access-token|x-rapidapi-key|x-token|x-csrf-token|x-xsrf-token)$/i;
const AUTH_QUERY_RE  = /^(api[_-]?key|apikey|key|access[_-]?token|auth[_-]?token|token|auth|signature|sign|hmac|sig)$/i;

function safeUrl(u) { try { return new URL(u); } catch { return null; } }

// Block SSRF targets: only public http(s) hosts are replayable server-side.
function isReplayableUrl(u) {
  const url = safeUrl(u);
  if (!url) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false;
  // IPv6 loopback / unspecified.
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false;
  // IPv4 literal in loopback / private / link-local / metadata ranges.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 0 || a === 10) return false;
    if (a === 169 && b === 254) return false;               // link-local + cloud metadata
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a >= 224) return false;                             // multicast / reserved
  }
  return true;
}

// Build a Cookie header from puppeteer-style cookies that apply to this URL.
function cookieHeaderFor(url, cookies) {
  const u = safeUrl(url);
  if (!u || !Array.isArray(cookies) || !cookies.length) return '';
  const host = u.hostname;
  const applicable = cookies.filter((c) => {
    if (!c || !c.name) return false;
    const domain = String(c.domain || '').replace(/^\./, '');
    if (!domain) return true;
    return host === domain || host.endsWith('.' + domain);
  });
  return applicable.map((c) => `${c.name}=${c.value}`).join('; ');
}

// A response "matches" if it still carries the scraped values (when we have
// them) or, in structure-only mode, is valid JSON with a real collection.
function responseMatches(text, sampleValues) {
  const samples = (sampleValues || []).filter((s) => String(s).trim().length >= 2);
  let json;
  try { json = JSON.parse(String(text).replace(/^\)\]\}',?\s*/, '')); } catch { json = undefined; }
  if (samples.length) {
    const { matched, total } = scoreValueMatch(text, samples);
    return { ok: matched > 0 && matched >= Math.min(2, total), matched, total };
  }
  if (json !== undefined) {
    const coll = findPrimaryCollection(json);
    return { ok: !!(coll || (json && typeof json === 'object')), matched: 0, total: 0 };
  }
  return { ok: false, matched: 0, total: 0 };
}

async function doFetch(url, { method, headers, body }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REPLAY_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method, headers, body: body || undefined, redirect: 'follow', signal: ctl.signal });
    // Read at most MAX_REPLAY_BODY so a huge/streamed response can't hang us.
    const raw = await res.text();
    const text = raw.length > MAX_REPLAY_BODY ? raw.slice(0, MAX_REPLAY_BODY) : raw;
    return { status: res.status, ok: res.ok, text };
  } finally {
    clearTimeout(timer);
  }
}

// Strip credentials (headers + auth query params) for the "is it open?" probe.
function strippedRequest(source) {
  const headers = {};
  for (const [k, v] of Object.entries(source.requestHeaders || {})) {
    if (!CRED_HEADER_RE.test(k)) headers[k] = v;
  }
  const u = safeUrl(source.url);
  let hadAuthQuery = false;
  if (u) {
    for (const k of Array.from(u.searchParams.keys())) {
      if (AUTH_QUERY_RE.test(k)) { u.searchParams.delete(k); hadAuthQuery = true; }
    }
  }
  return { url: u ? u.href : source.url, headers, hadAuthQuery };
}

async function verify(source, opts = {}) {
  const { sampleValues = [], cookies = [] } = opts;
  const method = (source.method || 'GET').toUpperCase();
  const body = (method === 'GET' || method === 'HEAD') ? null : (source.requestBody || null);

  if (!isReplayableUrl(source.url)) {
    return { verification: 'unverified', note: 'Target is a private/local address — not replayed.', replayStatus: null };
  }
  // Signed requests regenerate their signature in-browser; replaying the
  // captured one will 401/403. Don't waste a request — report honestly.
  if (source.authTier === 'signed') {
    return { verification: 'blocked', note: 'Request is signed in-browser (HMAC); the captured signature can\'t be replayed.', replayStatus: null };
  }

  // ── Probe A: no credentials → is it actually open? ───────────────────────
  const stripped = strippedRequest(source);
  if (!stripped.hadAuthQuery) {
    try {
      const a = await doFetch(stripped.url, { method, headers: stripped.headers, body });
      if (a.ok) {
        const m = responseMatches(a.text, sampleValues);
        if (m.ok) {
          return { verification: 'open-verified', note: 'Returns the same data with no authentication.', replayStatus: a.status, matched: m.matched, total: m.total };
        }
      }
    } catch (_) { /* fall through to credentialed probe */ }
  }

  // ── Probe B: with the browser's session (cookies + captured auth) ────────
  const headersB = { ...(source.requestHeaders || {}) };
  const cookieHeader = cookieHeaderFor(source.url, cookies);
  if (cookieHeader) headersB['Cookie'] = cookieHeader;
  const haveCreds = cookieHeader || Object.keys(headersB).some((k) => CRED_HEADER_RE.test(k)) || stripped.hadAuthQuery;

  if (haveCreds) {
    try {
      const b = await doFetch(source.url, { method, headers: headersB, body });
      if (b.ok) {
        const m = responseMatches(b.text, sampleValues);
        if (m.ok) {
          const note = cookieHeader
            ? 'Works with your logged-in session cookies (replayed from this browser).'
            : 'Works with the captured credentials/token (may expire).';
          return { verification: 'verified', authUsed: cookieHeader ? 'session' : 'credential', note, replayStatus: b.status, matched: m.matched, total: m.total };
        }
      }
      return { verification: 'blocked', note: `Replay returned HTTP ${b.status} or unrecognized data — likely anti-bot/WAF protected.`, replayStatus: b.status };
    } catch (err) {
      return { verification: 'unverified', note: `Replay failed: ${err.message}`, replayStatus: null };
    }
  }

  return { verification: 'blocked', note: 'Could not confirm — no usable credentials and the open probe failed.', replayStatus: null };
}

// Verify the top sources with bounded concurrency; mutates each source's
// `.verification` in place and returns the same array.
async function verifyMany(sources, opts = {}) {
  const { maxVerify = DEFAULT_MAX_VERIFY, concurrency = DEFAULT_CONCURRENCY } = opts;
  const targets = (sources || []).slice(0, maxVerify);
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const idx = i++;
      const src = targets[idx];
      try { src.verification = await verify(src, opts); }
      catch (err) { src.verification = { verification: 'unverified', note: err.message, replayStatus: null }; }
      // A confirmed-open endpoint is worth more than the heuristic guessed.
      if (src.verification.verification === 'open-verified') {
        src.authTier = 'open';
        src.confidence = Math.min(0.99, (src.confidence || 0) + 0.15);
      } else if (src.verification.verification === 'verified') {
        src.confidence = Math.min(0.99, (src.confidence || 0) + 0.1);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  (sources || []).sort((a, b) => b.confidence - a.confidence);
  return sources;
}

module.exports = { verify, verifyMany, isReplayableUrl };

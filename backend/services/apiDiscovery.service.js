'use strict';

/* ===========================================================================
   apiDiscovery
   ---------------------------------------------------------------------------
   Turns the raw XHR/fetch records captured by browser/networkCapture.js into a
   ranked list of "API sources" — the endpoints the page's own frontend calls
   to get its data — so the platform can propose using them directly instead of
   scraping the rendered DOM.

   This is deterministic and heuristic by design. Nothing here calls an LLM;
   AI (services/apiDiscoveryAI.service.js, later) is only ever enrichment on
   top of these results — never the thing that decides which endpoint is the
   data source.

   The scoring blends three signals:
     1. VALUE MATCH   — when the user has already selected/extracted data, we
                        search each response body for those sample values. A
                        response that contains what they're scraping *is* the
                        source. Strongest signal.
     2. DATA RICHNESS — arrays of objects with repeated key shapes, item counts,
                        field diversity. Used on its own when nothing's been
                        selected yet (structure-only mode).
     3. AUTH TIER     — open endpoints are the most useful to propose; signed
                        (HMAC) ones the least. Nudges the ranking.

   Public:
     analyze(records, opts) → { sources, capturedCount, consideredCount }
   ========================================================================= */

// Hosts/paths that are analytics, ads, tag managers, error/telemetry beacons —
// never a data API worth proposing. Matched as substrings against the host.
const TRACKER_HOST_PATTERNS = [
  'google-analytics.', 'googletagmanager.', 'analytics.google.', 'doubleclick.',
  'googlesyndication.', 'googleadservices.', 'g.doubleclick', 'stats.g.',
  'facebook.com/tr', 'connect.facebook.', 'segment.io', 'segment.com',
  'sentry.io', 'ingest.sentry', 'bugsnag.', 'mixpanel.', 'amplitude.',
  'hotjar.', 'fullstory.', 'optimizely.', 'newrelic.', 'nr-data.net',
  'cloudflareinsights.', 'clarity.ms', 'branch.io', 'appsflyer.',
  'criteo.', 'taboola.', 'outbrain.', 'quantserve.', 'scorecardresearch.',
  'adservice.', 'adsystem.', 'moatads.', 'demdex.', 'omtrdc.net',
  'tiktok.com/i18n', 'analytics.tiktok', 'bat.bing.', 'snap.licdn.',
];

// Paths that scream "beacon", not "data".
const TRACKER_PATH_RE = /\/(collect|beacon|pixel|track(ing)?|telemetry|metrics|gtm|gtag|analytics|log(s|ging)?|event(s)?\/(batch|track))\b/i;

// Query/param names that identify pagination controls — the params we'd
// increment to walk the API page-by-page.
const PAGINATION_PARAM_RE = /^(page|paged|pg|pagenum|pageno|pagenr|pageindex|offset|start|skip|from|cursor|after|before|limit|size|count|per[_-]?page|page[_-]?size|rows|top)$/i;

// Query/param names that carry the search/filter intent.
const QUERY_PARAM_RE = /^(q|query|search|term|keyword|keywords|text|filter|category|cat|sort|order|lang|locale|type|slug|id|ids)$/i;

// Header names that indicate a signed/HMAC request — these are regenerated in
// the browser per-request and generally CAN'T be replayed standalone.
const SIGNATURE_HEADER_RE = /(^|[-_])(signature|sign|hmac|x-amz-signature|x-goog-signature|x-hmac|x-signature)([-_]|$)/i;

// Header names that carry a bearer-style credential.
const APIKEY_HEADER_RE = /^(authorization|x-api-key|api-key|apikey|x-app-key|x-appkey|x-auth-token|x-access-token|x-rapidapi-key|x-token|token|x-csrf-token|x-xsrf-token)$/i;

// Query params that carry a credential.
const AUTH_QUERY_RE = /^(api[_-]?key|apikey|key|access[_-]?token|auth[_-]?token|token|auth|signature|sign|hmac|sig)$/i;

// Request headers worth keeping for display / replay. We drop client-hint and
// transport noise (sec-*, user-agent, accept-encoding, connection, …) but keep
// anything auth-ish or that a picky backend commonly checks.
const KEEP_HEADER_RE = /^(authorization|cookie|content-type|accept|accept-language|x-requested-with|referer|origin|x-api-key|api-key|apikey|x-app-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|x-token|x-rapidapi-key|graphql|x-graphql)/i;
function isKeptHeader(name) {
  const n = String(name || '').toLowerCase();
  if (KEEP_HEADER_RE.test(n)) return true;
  // Keep bespoke x-* app headers (often required), but not client hints.
  if (n.startsWith('x-') && !n.startsWith('x-client-') && !/sec-|-ua$/.test(n)) return true;
  return false;
}

function lc(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) out[k.toLowerCase()] = headers[k];
  return out;
}

function safeUrl(u) {
  try { return new URL(u); } catch { return null; }
}

function isTracker(url) {
  const u = safeUrl(url);
  if (!u) return true;
  const host = u.hostname.toLowerCase();
  if (TRACKER_HOST_PATTERNS.some((p) => (host + u.pathname).includes(p))) return true;
  if (TRACKER_PATH_RE.test(u.pathname)) return true;
  return false;
}

function tryParseJson(text) {
  if (typeof text !== 'string') return undefined;
  const t = text.trim();
  if (!t) return undefined;
  // Some frameworks prefix JSON with an anti-hijacking guard, e.g. )]}' or
  // while(1); — strip a leading guard line before parsing.
  const cleaned = t.replace(/^\)\]\}',?\s*/, '').replace(/^while\(1\);?/, '').replace(/^for\(;;\);?/, '');
  try { return JSON.parse(cleaned); } catch { return undefined; }
}

// Walk a parsed JSON value (bounded) to find the most "collection-like" node:
// the largest array whose elements are objects. That's almost always the list
// the user wants. Returns { array, path, fields } or null.
function findPrimaryCollection(json) {
  let best = null;
  const visit = (node, path, depth) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length >= 1) {
        const score = objs.length;
        if (!best || score > best.score) {
          const fields = new Set();
          for (const o of objs.slice(0, 5)) Object.keys(o).forEach((k) => fields.add(k));
          best = { score, array: node, path, fields: Array.from(fields).slice(0, 24), itemCount: node.length };
        }
      }
      // Still descend into array elements (nested lists happen).
      node.slice(0, 20).forEach((x, i) => visit(x, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) visit(node[k], path ? `${path}.${k}` : k, depth + 1);
    }
  };
  visit(json, '', 0);
  return best;
}

// Normalize a string for loose containment tests.
function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}
// Digits-only projection, for matching a scraped "$1,299.00" against a JSON
// numeric field like 1299 or "1299.00".
function digits(s) {
  return String(s == null ? '' : s).replace(/[^\d]/g, '');
}

// How many of the sample values appear in this response body? Tries a raw
// normalized substring match and a digits-only match (prices/counts). Returns
// { matched, total } — total 0 means "no samples to match against".
function scoreValueMatch(bodyText, sampleValues) {
  const samples = (sampleValues || []).map((s) => norm(s)).filter((s) => s.length >= 2);
  if (!samples.length) return { matched: 0, total: 0 };
  const hayRaw = norm(bodyText).slice(0, 2 * 1024 * 1024);
  const hayDigits = digits(bodyText);
  let matched = 0;
  const seen = new Set();
  for (const s of samples) {
    if (seen.has(s)) continue;
    seen.add(s);
    if (s.length <= 40 && hayRaw.includes(s)) { matched++; continue; }
    const d = digits(s);
    if (d.length >= 3 && hayDigits.includes(d)) { matched++; continue; }
  }
  return { matched, total: seen.size };
}

// Classify how the request was authorized, from its (merged) headers + URL.
function classifyAuth(requestHeaders, url) {
  const h = lc(requestHeaders);
  const u = safeUrl(url);
  const signals = [];
  let signed = false, bearer = false, cookie = false, apikeyQuery = false;

  for (const name of Object.keys(h)) {
    if (SIGNATURE_HEADER_RE.test(name)) { signed = true; signals.push(`signed request header "${name}"`); }
    else if (APIKEY_HEADER_RE.test(name)) {
      const val = String(h[name] || '');
      if (name === 'cookie') continue; // handled below
      if (name === 'authorization') {
        const scheme = val.split(/\s+/)[0] || 'token';
        bearer = true; signals.push(`Authorization: ${scheme}`);
      } else { bearer = true; signals.push(`credential header "${name}"`); }
    }
  }
  if (h['cookie']) { cookie = true; signals.push('session cookies'); }

  if (u) {
    for (const [k] of u.searchParams.entries()) {
      if (AUTH_QUERY_RE.test(k)) {
        if (/sign|hmac|sig/i.test(k)) { signed = true; signals.push(`signature query "${k}"`); }
        else { apikeyQuery = true; signals.push(`credential query "${k}"`); }
      }
    }
  }

  // Precedence: signed (least usable) → bearer/api-key → session → open.
  let tier;
  if (signed) tier = 'signed';
  else if (bearer || apikeyQuery) tier = 'bearer';
  else if (cookie) tier = 'session';
  else tier = 'open';

  return { tier, signals };
}

// Split a URL into origin/path plus a classified param list.
function describeParams(url) {
  const u = safeUrl(url);
  if (!u) return { origin: '', path: '', params: [] };
  const params = [];
  for (const [name, value] of u.searchParams.entries()) {
    let role = 'other';
    if (PAGINATION_PARAM_RE.test(name)) role = 'pagination';
    else if (QUERY_PARAM_RE.test(name)) role = 'query';
    params.push({ name, value: String(value).slice(0, 80), role });
  }
  return { origin: u.origin, path: u.pathname, params };
}

// Curate request headers down to the relevant subset for display/replay.
function curateHeaders(requestHeaders) {
  const out = {};
  for (const k of Object.keys(requestHeaders || {})) {
    if (isKeptHeader(k)) out[k] = requestHeaders[k];
  }
  return out;
}

function buildCurl(method, url, headers, body) {
  const parts = [`curl -X ${method} ${JSON.stringify(url)}`];
  for (const [k, v] of Object.entries(headers || {})) {
    parts.push(`-H ${JSON.stringify(`${k}: ${v}`)}`);
  }
  if (body) parts.push(`--data ${JSON.stringify(body)}`);
  return parts.join(' \\\n  ');
}

function buildFetchSnippet(method, url, headers, body) {
  const opts = { method, headers: headers || {} };
  if (body) opts.body = body;
  return `await fetch(${JSON.stringify(url)}, ${JSON.stringify(opts, null, 2)});`;
}

// Group records that hit the same logical endpoint (method + origin + path,
// ignoring query VALUES) so pagination calls collapse into one candidate.
function groupKey(rec) {
  const { origin, path } = describeParams(rec.url);
  return `${rec.method} ${origin}${path}`;
}

function analyze(records, opts = {}) {
  const { sampleValues = [], maxSources = 8 } = opts;
  const capturedCount = Array.isArray(records) ? records.length : 0;

  // 1) Filter to plausible data responses.
  const candidates = (records || []).filter((r) => {
    if (!r || !r.url) return false;
    if (r.status && (r.status < 200 || r.status >= 400)) return false;
    if (isTracker(r.url)) return false;
    if (!r.responseBody) return false;
    return true;
  });

  // 2) Group by logical endpoint; keep the "best" representative per group.
  const groups = new Map();
  for (const rec of candidates) {
    const json = tryParseJson(rec.responseBody);
    if (json === undefined) continue;                 // not JSON → not a data API
    const key = groupKey(rec);
    const match = scoreValueMatch(rec.responseBody, sampleValues);
    const coll = findPrimaryCollection(json);
    const g = groups.get(key);
    // Prefer the representative with the most value matches, then the richest.
    const better = !g ||
      match.matched > g.match.matched ||
      (match.matched === g.match.matched && (coll?.itemCount || 0) > (g.coll?.itemCount || 0));
    if (better) groups.set(key, { rec, json, coll, match, occurrences: (g?.occurrences || 0) + 1 });
    else g.occurrences += 1;
  }

  const consideredCount = groups.size;
  const sources = [];

  for (const { rec, json, coll, match, occurrences } of groups.values()) {
    const { origin, path, params } = describeParams(rec.url);
    const auth = classifyAuth(rec.requestHeaders, rec.url);

    // ── Richness 0..1 ────────────────────────────────────────────────────
    let richness = 0;
    if (coll) {
      richness += 0.5;
      if (coll.itemCount >= 3) richness += 0.2;
      if (coll.itemCount >= 10) richness += 0.1;
      if ((coll.fields?.length || 0) >= 3) richness += 0.2;
    } else if (json && typeof json === 'object') {
      richness += 0.25; // a single object can still be a useful detail endpoint
    }
    richness = Math.min(1, richness);

    // ── Confidence ───────────────────────────────────────────────────────
    let confidence;
    if (match.total > 0) {
      const frac = match.matched / match.total;
      if (match.matched === 0) {
        // Samples exist but none are in this body → almost certainly not the
        // source. Keep it, but low.
        confidence = 0.12 + 0.13 * richness;
      } else {
        confidence = 0.4 + 0.45 * frac + 0.15 * richness;
      }
    } else {
      // Structure-only mode — never as certain as a value match.
      confidence = 0.22 + 0.55 * richness;
    }
    // Auth nudges: open is most useful to propose; signed the least.
    confidence += ({ open: 0.05, session: 0.0, bearer: -0.04, signed: -0.16 })[auth.tier] || 0;
    if (occurrences > 1) confidence += 0.03; // repeated calls = a real, reused endpoint
    confidence = Math.max(0.05, Math.min(0.98, confidence));

    // ── Human-readable summary ───────────────────────────────────────────
    const shape = coll
      ? `JSON array of ${coll.itemCount} object${coll.itemCount === 1 ? '' : 's'}` +
        (coll.fields.length ? ` (${coll.fields.slice(0, 6).join(', ')}${coll.fields.length > 6 ? ', …' : ''})` : '')
      : (json && Array.isArray(json)) ? `JSON array of ${json.length} items`
      : 'JSON object';
    const pageParam = params.find((p) => p.role === 'pagination');
    const pagingNote = pageParam ? ` Paginated via "${pageParam.name}".` : '';
    const summary = `${rec.method} ${path} — ${shape}.${pagingNote}`;

    const headers = curateHeaders(rec.requestHeaders);

    sources.push({
      id: Buffer.from(groupKey(rec)).toString('base64').replace(/=+$/, ''),
      method: rec.method,
      url: rec.url,
      origin,
      path,
      status: rec.status || null,
      contentType: rec.responseMimeType || '',
      queryParams: params,
      authTier: auth.tier,
      authSignals: auth.signals,
      matchedValues: match.matched,
      totalSampleValues: match.total,
      recordShape: coll
        ? { kind: 'array', itemCount: coll.itemCount, fields: coll.fields, path: coll.path }
        : (Array.isArray(json) ? { kind: 'array', itemCount: json.length, fields: [], path: '' }
          : { kind: 'object', itemCount: 1, fields: json && typeof json === 'object' ? Object.keys(json).slice(0, 24) : [] }),
      occurrences,
      confidence: Number(confidence.toFixed(3)),
      summary,
      requestHeaders: headers,
      requestBody: rec.requestBody || null,
      curl: buildCurl(rec.method, rec.url, headers, rec.requestBody),
      fetchSnippet: buildFetchSnippet(rec.method, rec.url, headers, rec.requestBody),
      // Filled in by apiReplay.service.js (verify pass): 'verified' | 'unverified'
      // | 'blocked' | 'open-verified' | null.
      verification: null,
    });
  }

  sources.sort((a, b) => b.confidence - a.confidence);
  return { sources: sources.slice(0, maxSources), capturedCount, consideredCount };
}

module.exports = { analyze, classifyAuth, findPrimaryCollection, isTracker, scoreValueMatch };

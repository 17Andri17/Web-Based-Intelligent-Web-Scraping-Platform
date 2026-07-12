'use strict';

const llm = require('./llm.service');
const llmJson = require('./llmJson');

/* ===========================================================================
   apiDiscoveryAI.service
   ---------------------------------------------------------------------------
   OPTIONAL enrichment for a discovered API source (services/apiDiscovery). The
   deterministic heuristics already decide WHICH endpoint is the data source and
   whether it works — this only makes a chosen one friendlier to read:

     • title       – a short human name for the dataset
     • summary     – one plain-English sentence about what it returns
     • fieldLabels – friendly snake_case names for opaque/abbreviated JSON keys
                     (e.g. "pdct_nm" → "product_name")

   AI is never in the correctness path: if the LLM is unconfigured, times out,
   or returns garbage, discovery still works — the panel just shows the raw
   heuristic result. Mirrors extractListAI's conventions and reuses the shared
   defensive JSON parser (services/llmJson).

   Public:
     isAvailable()          → boolean
     enrich(source, opts)   → { ok, ai } | { ok:false, code, error }
   ========================================================================= */

const SYSTEM_PROMPT = [
  'You label a web API endpoint that a website calls to load its own data. You are given the HTTP method, path, the JSON field names it returns, and a rough machine summary.',
  '',
  'YOUR ENTIRE REPLY MUST BE A SINGLE JSON OBJECT.',
  '- Start with "{" and end with "}". Nothing before or after.',
  '- Do NOT think out loud, explain, or use markdown fences.',
  '',
  'Shape:',
  '{"title":"<2-4 word Title Case name for the dataset>","summary":"<one short sentence: what the endpoint returns and how it paginates>","fields":[{"raw":"<exact field name from the list>","label":"<clearer snake_case name>"}]}',
  '',
  'Rules:',
  '- "title": what the ROWS are (e.g. "Product Listings", "Job Postings", "Search Results"). Never generic like "Data" or "Items".',
  '- "fields": ONLY rename fields whose name is abbreviated, cryptic, or unclear. Use the EXACT raw name from the provided list. Skip fields that are already clear. Omit the array entirely if nothing needs renaming.',
  '- "label": snake_case, descriptive of the value. Never invent fields that are not in the list.',
].join('\n');

function buildUserPrompt(source) {
  const fields = (source.recordShape && Array.isArray(source.recordShape.fields)) ? source.recordShape.fields : [];
  const lines = [];
  lines.push(`Method: ${source.method || 'GET'}`);
  lines.push(`Path: ${source.path || source.url || ''}`);
  if (source.recordShape && source.recordShape.kind === 'array') {
    lines.push(`Returns: an array of ${source.recordShape.itemCount ?? '?'} objects`);
  }
  if (fields.length) lines.push(`Field names: ${fields.slice(0, 40).join(', ')}`);
  if (source.summary) lines.push(`Machine summary: ${source.summary}`);
  const pag = (source.queryParams || []).filter((p) => p.role === 'pagination').map((p) => p.name);
  if (pag.length) lines.push(`Pagination params: ${pag.join(', ')}`);
  lines.push('');
  lines.push('Output the JSON object now:');
  return lines.join('\n');
}

function isAvailable() {
  return llm.isConfigured();
}

// snake_case identifier, mirroring extractListAI's field-name rules.
const LABEL_RX = /^[a-z][a-z0-9_]{0,40}$/;
function toSnake(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return LABEL_RX.test(cleaned) ? cleaned : '';
}

function titleCase(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(/[^A-Za-z0-9\s_-]/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const words = s.split(/[_\s-]+/).filter(Boolean).slice(0, 5);
  if (!words.length) return '';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ').slice(0, 48);
}

function sanitize(parsed, source) {
  const known = new Set((source.recordShape && source.recordShape.fields) || []);
  const ai = {};
  ai.title = titleCase(parsed.title);
  ai.summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 240) : '';
  ai.fieldLabels = [];
  if (Array.isArray(parsed.fields)) {
    const seen = new Set();
    for (const f of parsed.fields) {
      if (!f || typeof f !== 'object') continue;
      const raw = typeof f.raw === 'string' ? f.raw.trim() : '';
      // Only accept renames for fields we actually saw, and skip no-op labels.
      if (!raw || (known.size && !known.has(raw)) || seen.has(raw)) continue;
      const label = toSnake(f.label);
      if (!label || label === toSnake(raw)) continue;
      ai.fieldLabels.push({ raw, label });
      seen.add(raw);
      if (ai.fieldLabels.length >= 12) break;
    }
  }
  return ai;
}

async function enrich(source, { requestId = '?' } = {}) {
  const tag = `[apiDiscoveryAI ${requestId}]`;
  if (!source || typeof source !== 'object') return { ok: false, code: 'NO_SOURCE', error: 'source required' };
  if (!llm.isConfigured()) return { ok: false, code: 'NO_API_KEY', error: 'LLM not configured' };

  const user = buildUserPrompt(source);
  const t0 = Date.now();
  const res = await llm.safeChat({ system: SYSTEM_PROMPT, user, temperature: 0.2, maxTokens: 500, timeoutMs: 20000 });
  const elapsed = Date.now() - t0;
  if (!res.ok) {
    console.warn(`${tag} LLM failed in ${elapsed}ms: ${res.code} — ${res.error}`);
    return { ok: false, code: res.code || 'LLM_FAIL', error: res.error || 'LLM call failed' };
  }

  const parsed = llmJson.parse(res.text, { preferKeys: ['summary', 'title', 'fields'] });
  if (!parsed) {
    console.warn(`${tag} unparseable LLM output`);
    return { ok: false, code: 'BAD_JSON', error: 'LLM output was not valid JSON' };
  }
  const ai = sanitize(parsed, source);
  if (!ai.title && !ai.summary && !ai.fieldLabels.length) {
    return { ok: false, code: 'EMPTY', error: 'nothing usable in AI output' };
  }
  console.log(`${tag} enriched in ${elapsed}ms: title="${ai.title}", ${ai.fieldLabels.length} field label(s)`);
  return { ok: true, ai };
}

module.exports = { enrich, isAvailable };

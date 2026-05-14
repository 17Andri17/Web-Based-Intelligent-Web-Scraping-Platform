'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const llm = require('../services/llm.service');

const router = express.Router();
router.use(requireAuth);

/* ===========================================================================
   POST /api/ai/suggest-step-name
   ---------------------------------------------------------------------------
   Body:
     {
       stepType:    'EXTRACT_TEXT' | 'EXTRACT_ATTRIBUTE' | ...
                    | 'FOR_EACH_ELEMENTS',
       selector?:   string,
       tag?:        string,        // 'a', 'div', 'span', 'table', ...
       classes?:    string,
       attribute?:  string,        // for EXTRACT_ATTRIBUTE
       text?:       string,        // visible text of the selected element
       html?:       string,        // small outerHTML snippet
       sample?:     string|array|object,  // any preview/sample value
       matchCount?: number         // for loops/multi-selection
     }

   Response: { name: string }   ('' on any failure — never throws to client)
   =========================================================================== */

const MAX_FIELD_LEN = 600;          // per text field of context
const MAX_NAME_LEN  = 32;
const MIN_NAME_LEN  = 2;

const REFUSAL_RX = /\b(?:i (?:can(?:'|no)?t|cannot|won'?t|am sorry|'?m sorry)|as an? (?:ai|language model)|i (?:do(?:n'|n no)?t|cannot determine)|unknown|n\/a|none|null|undefined|step name|field name)\b/i;

function clip(s, n = MAX_FIELD_LEN) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function describeSample(v) {
  if (v == null) return '';
  if (typeof v === 'string') return clip(v, 200);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const head = v.slice(0, 3).map(x => typeof x === 'string' ? clip(x, 80) : JSON.stringify(x).slice(0, 80));
    return `(array of ${v.length}) ${head.join(' | ')}`;
  }
  try { return clip(JSON.stringify(v), 300); } catch { return ''; }
}

function buildPrompt(payload) {
  const lines = [];
  const isLoop = payload.stepType === 'FOR_EACH_ELEMENTS';
  lines.push(`Action: ${payload.stepType || 'unknown'}`);
  if (payload.tag)       lines.push(`Element tag: <${payload.tag}>`);
  if (payload.classes)   lines.push(`Element classes: ${clip(payload.classes, 200)}`);
  if (payload.attribute) lines.push(`Extracting attribute: ${clip(payload.attribute, 60)}`);
  if (payload.selector)  lines.push(`Selector: ${clip(payload.selector, 200)}`);
  if (payload.text)      lines.push(`Visible text: "${clip(payload.text, 200)}"`);
  if (payload.html)      lines.push(`HTML snippet: ${clip(payload.html, 400)}`);
  const sample = describeSample(payload.sample);
  if (sample)            lines.push(`Sample value: ${sample}`);
  if (typeof payload.matchCount === 'number') lines.push(`Number of matches: ${payload.matchCount}`);
  lines.push('');
  lines.push(isLoop
    ? 'Suggest a plural snake_case field name for the COLLECTION of items this loop iterates over.'
    : 'Suggest a singular snake_case field name describing the value being extracted.');
  return lines.join('\n');
}

const SYSTEM_PROMPT = [
  'You name data fields extracted by a web-scraping workflow.',
  'Output ONLY the field name itself — no quotes, no punctuation, no explanation.',
  'Rules:',
  '- snake_case, lowercase ASCII letters / digits / underscores only',
  `- ${MIN_NAME_LEN}–${MAX_NAME_LEN} characters`,
  '- must start with a letter',
  '- be specific to the value (e.g. product_price, article_title, review_count, search_results)',
  '- singular for single values, plural for lists / loops over multiple items',
  '- if you cannot determine a meaningful name, output exactly: unknown',
].join('\n');

function sanitiseName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();

  // Take only the first non-empty line — the model sometimes adds prose.
  s = s.split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';

  // Strip surrounding quotes / backticks / markdown.
  s = s.replace(/^["'`*]+|["'`*]+$/g, '').trim();

  // Reject obvious refusals or generic placeholders.
  if (REFUSAL_RX.test(s)) return '';

  // Snake-case it.
  s = s.toLowerCase()
       .replace(/[^a-z0-9_\s-]/g, '')   // drop punctuation
       .trim()
       .replace(/[\s-]+/g, '_')         // collapse separators
       .replace(/_+/g, '_')
       .replace(/^_+|_+$/g, '');

  if (s.length < MIN_NAME_LEN || s.length > MAX_NAME_LEN) return '';
  if (!/^[a-z][a-z0-9_]*$/.test(s)) return '';
  return s;
}

router.post('/suggest-step-name', async (req, res) => {
  // Always answer with { name: '' } on any problem — auto-naming is best-effort
  // and the user can always type a name manually.
  if (!llm.isConfigured()) return res.json({ name: '' });

  const payload = req.body || {};
  if (typeof payload.stepType !== 'string') return res.json({ name: '' });

  const prompt = buildPrompt(payload);

  const result = await llm.safeChat({
    system: SYSTEM_PROMPT,
    user:   prompt,
    temperature: 0.2,
    maxTokens: 16,
  });

  if (!result.ok) {
    if (result.code !== 'NO_API_KEY') {
      console.warn('[ai] suggest-step-name failed:', result.code, result.error);
    }
    return res.json({ name: '' });
  }

  res.json({ name: sanitiseName(result.text) });
});

module.exports = router;

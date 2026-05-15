'use strict';

const llm = require('./llm.service');

/* ===========================================================================
   extractListAI.service
   ---------------------------------------------------------------------------
   Given the cleaned outerHTML of a single sample list item ("container"),
   ask the LLM to propose a set of extraction fields. Each field is a
   { name, selector, kind, attribute? } record. Selectors must be relative
   to the supplied container so they apply uniformly to every sibling row.

   The caller is responsible for verifying the proposed selectors against
   the live DOM — that's the only reliable check that a CSS selector
   actually targets the intended element. This module only does syntactic
   validation.

   Public API:
     proposeFields({ sampleHtml, userHint, existingFields, maxFields })
       → { ok: true, fields: [...], explanation }
       → { ok: false, error, code }
   ========================================================================= */

const SYSTEM_PROMPT = [
  'You analyse a sample list-item HTML element from a website and propose a structured set of extraction fields.',
  'The HTML you receive is a SINGLE item from a repeating list (a product card, a search result row, an article preview, etc.). Your proposed selectors will be applied to every sibling item, so they MUST be relative to this container.',
  '',
  'OUTPUT FORMAT (strict):',
  '- A single JSON object. No prose. No markdown fences. No commentary.',
  '- Shape:',
  '  {',
  '    "fields": [',
  '      { "name": "title",     "selector": "h2.product-title", "kind": "text" },',
  '      { "name": "price",     "selector": ".price",           "kind": "text" },',
  '      { "name": "image_url", "selector": "img",              "kind": "attr", "attribute": "src"  },',
  '      { "name": "url",       "selector": "a.product-link",   "kind": "attr", "attribute": "href" }',
  '    ],',
  '    "explanation": "1-2 short sentences"',
  '  }',
  '',
  'RULES:',
  '- "name" is a short snake_case identifier — singular, descriptive of the value, never reflecting style ("counter_number") or layout ("col_2").',
  '- "selector" is a valid CSS selector. It MUST be relative to the container. NEVER start with html / body / a leading combinator. NEVER include the container element itself as the root — assume the container is the implicit parent.',
  '- Prefer stable anchors: tags + data-* attributes + aria-label + role + semantic classes ("price", "title"). Avoid hashed classes like "css-1a2b3c".',
  '- "kind":',
  '    "text" — visible text (default)',
  '    "attr" — read an attribute; you MUST also set "attribute" to the attribute name (e.g. "href", "src", "data-id"). For images use "src". For links use "href".',
  '    "html" — innerHTML (use sparingly — only when text isn\'t structured enough)',
  '- For images, link URLs, IDs, prices stored in data attributes: ALWAYS use kind "attr".',
  '- Output 3-12 fields. Skip noise (decorative spans, icons, action buttons, "Add to cart" labels) unless they carry data.',
  '- If the user supplies a HINT, treat it as the source of truth — include exactly the fields they asked for, and skip anything else they say to ignore.',
  '- If you genuinely cannot identify ANY extractable field, return {"fields": [], "explanation": "..."}.',
].join('\n');

function buildUserPrompt({ sampleHtml, userHint, existingFields }) {
  const lines = [];
  lines.push('Sample list-item HTML (already cleaned — head, scripts, styles removed):');
  lines.push('```html');
  lines.push(truncate(sampleHtml || '[no html captured]', 18000));
  lines.push('```');

  if (userHint && typeof userHint === 'string' && userHint.trim()) {
    lines.push('');
    lines.push('User hint (TREAT AS AUTHORITATIVE — match these field requests exactly):');
    lines.push(userHint.trim().slice(0, 2000));
  }

  if (existingFields && typeof existingFields === 'object') {
    const known = Object.entries(existingFields).filter(([, v]) => v).map(([k]) => k);
    if (known.length) {
      lines.push('');
      lines.push(`The user has already defined these fields — DO NOT propose duplicates and try to fit alongside them: ${known.join(', ')}`);
    }
  }

  lines.push('');
  lines.push('Return the JSON object only.');
  return lines.join('\n');
}

async function proposeFields({ sampleHtml, userHint, existingFields, maxFields = 12 }) {
  if (!sampleHtml || typeof sampleHtml !== 'string') {
    return { ok: false, error: 'sampleHtml is required', code: 'NO_HTML' };
  }
  if (!llm.isConfigured()) {
    return { ok: false, error: 'LLM not configured', code: 'NO_API_KEY' };
  }

  const result = await llm.safeChat({
    system: SYSTEM_PROMPT,
    user:   buildUserPrompt({ sampleHtml, userHint, existingFields }),
    temperature: 0.15,
    maxTokens: 1200,
    timeoutMs: 30000,
  });

  if (!result.ok) {
    return { ok: false, error: result.error || 'LLM call failed', code: result.code || 'LLM_FAIL' };
  }

  const parsed = parseLlmJson(result.text);
  if (!parsed) {
    return { ok: false, error: 'LLM output was not valid JSON', code: 'BAD_JSON', raw: truncate(result.text, 400) };
  }

  const validated = validateFields(parsed, maxFields);
  if (!validated.ok) {
    return { ok: false, error: validated.error, code: 'BAD_FIELDS', raw: truncate(result.text, 400) };
  }

  return { ok: true, fields: validated.fields, explanation: validated.explanation };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function parseLlmJson(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/```(?:json)?/gi, '').trim();
  const first = s.indexOf('{');
  const last  = s.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try { return JSON.parse(s.slice(first, last + 1)); } catch (_) { return null; }
}

const NAME_RX = /^[a-z][a-z0-9_]{0,40}$/;

function sanitiseName(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.trim().toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return NAME_RX.test(cleaned) ? cleaned : '';
}

function validateFields(obj, maxFields) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'output is not an object' };
  const raw = Array.isArray(obj.fields) ? obj.fields : null;
  if (!raw) return { ok: false, error: 'fields array missing' };

  const fields = [];
  const seenNames = new Set();
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const name = sanitiseName(f.name);
    if (!name || seenNames.has(name)) continue;
    if (typeof f.selector !== 'string' || !f.selector.trim()) continue;
    const selector = f.selector.trim();
    if (selector.length > 1000) continue;
    // Reject obviously page-rooted selectors — the AI sometimes ignores
    // the "relative to container" rule on a first attempt.
    if (/^(?:html|body)\b/i.test(selector)) continue;
    const kind = f.kind === 'attr' || f.kind === 'attribute' ? 'attr'
              : f.kind === 'html' ? 'html' : 'text';
    let attribute = null;
    if (kind === 'attr') {
      if (typeof f.attribute !== 'string' || !f.attribute.trim()) continue;
      attribute = f.attribute.trim();
      if (attribute.length > 100) continue;
    }
    fields.push({ name, selector, kind, attribute });
    seenNames.add(name);
    if (fields.length >= maxFields) break;
  }

  if (fields.length === 0) {
    return { ok: false, error: 'no usable fields after validation' };
  }

  const explanation = typeof obj.explanation === 'string' ? obj.explanation.slice(0, 600) : '';
  return { ok: true, fields, explanation };
}

function truncate(s, n) {
  if (s == null) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n) + '...[truncated]' : s;
}

module.exports = { proposeFields };

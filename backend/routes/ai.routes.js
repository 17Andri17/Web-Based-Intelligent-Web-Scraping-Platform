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

// Phrases that indicate the model refused or returned a placeholder rather
// than an actual name. "step name" / "field name" were tempting to include
// but reasoning models routinely echo them back when explaining their answer
// ("The field name is: product_price"), so we keep the refusal list tight.
const REFUSAL_RX = /\b(?:i (?:can(?:'|no)?t|cannot|won'?t|am sorry|'?m sorry)|as an? (?:ai|language model)|i (?:do(?:n'|n no)?t|cannot determine)|unknown|n\/a|none|null|undefined)\b/i;

// Format-instruction artifacts the model parrots back from the prompt instead
// of producing a real name. These are valid-looking snake_case tokens, so the
// candidate extraction below would otherwise pick them up — most commonly the
// literal "snake_case", which then becomes the step's name.
const STOPWORDS = new Set([
  'snake_case', 'snakecase', 'camel_case', 'camelcase', 'pascal_case',
  'pascalcase', 'kebab_case', 'kebabcase', 'lower_case', 'lowercase',
  'upper_case', 'uppercase', 'field_name', 'fieldname', 'step_name',
  'stepname', 'field', 'name', 'value',
]);

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

// Steps that produce a TABLE / collection of repeating rows. These get a
// human-friendly Title Case name (e.g. "Product Listings"); single-value
// extractions keep a snake_case identifier.
const TABLE_STEP_TYPES = new Set(['FOR_EACH_ELEMENTS', 'EXTRACT_LIST', 'EXTRACT_TABLE']);

// "product_listings" → "Product Listings". The model is still asked for a
// reliable snake_case token (which sanitiseName extracts robustly); we only
// present it as a title.
function snakeToTitle(s) {
  if (typeof s !== 'string') return '';
  return s
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function buildPrompt(payload) {
  const lines = [];
  const isLoop = TABLE_STEP_TYPES.has(payload.stepType);
  lines.push(`Action: ${payload.stepType || 'unknown'}`);
  if (payload.tag)       lines.push(`Element tag: <${payload.tag}>`);
  if (payload.classes)   lines.push(`Element classes: ${clip(payload.classes, 200)}`);
  if (payload.attribute) lines.push(`Extracting attribute: ${clip(payload.attribute, 60)}`);
  if (payload.selector)  lines.push(`Selector: ${clip(payload.selector, 200)}`);
  // Ancestors give structural context: a <span> inside <div.product-card>
  // is probably a price/title, not a nav label.
  if (Array.isArray(payload.ancestors) && payload.ancestors.length) {
    const chain = payload.ancestors
      .map(a => typeof a === 'string' ? clip(a, 60) : '')
      .filter(Boolean)
      .join(' > ');
    if (chain) lines.push(`Ancestor chain: ${chain}`);
  }
  if (payload.text)       lines.push(`Visible text: "${clip(payload.text, 200)}"`);
  if (payload.href)       lines.push(`Link href: ${clip(payload.href, 200)}`);
  if (payload.src)        lines.push(`Image/media src: ${clip(payload.src, 200)}`);
  if (payload.html)       lines.push(`HTML snippet: ${clip(payload.html, 400)}`);
  // Parent context: the parent's combined text and HTML often contain a
  // nearby label that describes the value (e.g. "180" + "Cert Providers").
  // This is usually the single strongest signal for naming.
  if (payload.parentTag)  lines.push(`Parent tag: <${payload.parentTag}>`);
  if (payload.parentText) lines.push(`Parent text (target + siblings): "${clip(payload.parentText, 400)}"`);
  if (payload.parentHtml) lines.push(`Parent HTML: ${clip(payload.parentHtml, 600)}`);
  const sample = describeSample(payload.sample);
  if (sample)             lines.push(`Sample value: ${sample}`);
  if (typeof payload.matchCount === 'number') lines.push(`Number of matches: ${payload.matchCount}`);
  lines.push('');

  // Naming guidance — keep it short and concrete. The biggest issue we hit
  // was the model padding names with redundant modifiers ("popular_link" when
  // "link" would do), and copying example words verbatim — so we keep the
  // examples generic and tell the model never to reuse them.
  lines.push('Naming rules:');
  lines.push('- Base the name ONLY on the element, text, and context above. NEVER copy a word from the examples in these rules unless it genuinely matches the data.');
  lines.push('- Prefer SHORT, simple names that describe the VALUE: price, title, image_url, link, rating.');
  lines.push('- Drop generic / promotional modifiers (popular, featured, latest, top, best, new, hot, trending) unless they are the entire point of the value.');
  lines.push('- If the PARENT TEXT contains a clear label next to the value (e.g. a number shown beside the word "Reviews"), name the field after the LABEL (→ reviews), not the visible numeric value.');
  lines.push('- Ignore styling-only class names (counter-number, plus, btn, item-1) — they describe how the element looks, not what it means.');
  lines.push('');
  lines.push(isLoop
    ? 'This step extracts a TABLE / collection of repeating items (one row per item). Suggest a PLURAL snake_case name for the WHOLE collection that describes what the items ARE on this page (e.g. products, articles, job_postings, search_results, cert_providers). Make it specific and meaningful — never a generic "items"/"rows"/"list".'
    : 'Suggest a singular snake_case name describing the value being extracted.');
  return lines.join('\n');
}

const SYSTEM_PROMPT = [
  'You name a single step (a field or a table) in a web-scraping workflow.',
  'The name must describe the ACTUAL data on the page you are given — the page could be about anything (laptops, recipes, jobs, flights, …).',
  'Output ONLY the name itself — no quotes, no punctuation, no explanation.',
  'Hard rules:',
  '- lowercase ASCII words joined by underscores (e.g. product_title), letters / digits / underscores only',
  `- ${MIN_NAME_LEN}–${MAX_NAME_LEN} characters`,
  '- must start with a letter',
  '- singular for single values, plural for tables / loops over multiple items',
  '- if you cannot determine a meaningful name, output exactly: unknown',
  '',
  'Style rules:',
  '- NEVER copy a word from these examples — they only show formatting and length. Derive every name from the data the user gives you.',
  '- Prefer the SHORTEST clear name. A bare noun (link) beats a padded one (popular_link).',
  '- Drop adjectives that describe how something is presented on the page — popular, featured, latest, top, best, new, hot, trending, recommended — unless that adjective IS the data.',
  '- Drop visual / layout class names — counter-number, plus, btn, item-1, card-body. They describe how the element LOOKS, not what it MEANS.',
  '- If a label sits next to the value (sibling text in the parent), name the field after the LABEL: a value shown beside the word "Weight" → weight.',
  '- 1–3 words is the sweet spot. Avoid stacking more than 3 unless every word adds meaning.',
].join('\n');

function isValidName(s) {
  return typeof s === 'string'
      && s.length >= MIN_NAME_LEN
      && s.length <= MAX_NAME_LEN
      && /^[a-z][a-z0-9_]*$/.test(s);
}

function sanitiseName(raw) {
  if (typeof raw !== 'string') return '';

  // Take only the last non-empty line — when a reasoning model is forced to
  // think out loud in `content`, the actual answer lives on the final line.
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  let s = lines[lines.length - 1].replace(/^["'`*\s]+|["'`*\s.]+$/g, '').trim();

  // Reject the few unambiguous refusal phrases.
  if (REFUSAL_RX.test(s)) return '';

  // 1) Look for snake_case-like identifiers in the FULL response.
  //    Models often answer "The name is: product_price" — we extract
  //    the underscored token regardless of surrounding prose. When several
  //    underscored candidates appear we use the LAST one, because that's
  //    typically where the model places its final answer.
  const candidates = (raw.match(/[a-zA-Z][a-zA-Z0-9_]*/g) || [])
    .map(t => t.toLowerCase())
    .filter(isValidName)
    .filter(t => !STOPWORDS.has(t));

  const withUnderscore = candidates.filter(t => t.includes('_'));
  if (withUnderscore.length) return withUnderscore[withUnderscore.length - 1];

  // 2) No snake_case token. If the last line is itself a short multi-word
  //    name (e.g. "Product Price"), normalise it.
  const direct = s.toLowerCase()
       .replace(/[^a-z0-9_\s-]/g, '')
       .trim()
       .replace(/[\s-]+/g, '_')
       .replace(/_+/g, '_')
       .replace(/^_+|_+$/g, '');
  if (isValidName(direct) && direct.length <= 20 && !STOPWORDS.has(direct)) return direct;

  // 3) Last resort — pick the final simple token in the response (the
  //    model often ends a chain-of-thought with the answer word).
  if (candidates.length) return candidates[candidates.length - 1];
  return '';
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
    // Reasoning models (openai/gpt-oss-*, DeepSeek-R1, …) burn most of
    // their budget on chain-of-thought before emitting the final answer.
    // 256 is well over the ~5–15 tokens a snake_case name needs but
    // gives reasoning models room to finish thinking. Cheap either way.
    maxTokens: 256,
  });

  if (!result.ok) {
    if (result.code !== 'NO_API_KEY') {
      console.warn('[ai] suggest-step-name failed:', result.code, result.error);
    }
    return res.json({ name: '' });
  }

  // The model returns a reliable snake_case token; for tables/collections we
  // present it as a human-friendly Title Case name ("Product Listings").
  const snake = sanitiseName(result.text);
  const name = (snake && TABLE_STEP_TYPES.has(payload.stepType)) ? snakeToTitle(snake) : snake;
  res.json({ name });
});

module.exports = router;

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

   Logging:
     The socket handler runs with an opaque requestId. We log every
     significant step prefixed with `[extractListAI <id>]` so a developer
     watching the server console can trace prompt → raw response → parsed
     JSON → validation outcome end-to-end.

   Public API:
     proposeFields({ sampleHtml, userHint, existingFields, maxFields, requestId })
       → { ok: true, fields: [...], explanation, raw }
       → { ok: false, error, code, raw? }
   ========================================================================= */

// Kept short so smaller / faster models (Groq's llama-3.1-8b-instant) don't
// burn budget rehearsing rules before they answer. The detailed reasoning
// from the long-form version is moved into the user prompt so each request
// surfaces exactly the constraints the model needs for THIS sample.
const SYSTEM_PROMPT = [
  'You are a web-scraping helper. Given a sample HTML snippet of ONE item from a repeating list, you propose extraction fields for every sibling item.',
  '',
  'YOUR ENTIRE REPLY MUST BE A SINGLE JSON OBJECT.',
  '- Start your reply with the character "{".',
  '- End your reply with the character "}".',
  '- Do NOT think out loud. Do NOT explain. Do NOT use markdown code fences.',
  '- The text BEFORE { and AFTER } must be empty.',
  '',
  'Shape:',
  '{"name":"<Title Case name for the whole list>","fields":[{"name":"<snake_case>","selector":"<CSS relative to container>","kind":"text"|"attr"|"html","attribute":"<only when kind=attr>"}],"explanation":"<one short sentence>"}',
].join('\n');

function buildUserPrompt({ sampleHtml, userHint, existingFields }) {
  const lines = [];
  lines.push('Sample HTML of ONE list item (the rest of the items have the same structure):');
  lines.push('```html');
  lines.push(truncate(sampleHtml || '[no html captured]', 18000));
  lines.push('```');
  lines.push('');
  lines.push('Rules:');
  lines.push('- "selector" is CSS, relative to the container above. Never start with html / body.');
  lines.push('- If the value lives ON THE CONTAINER ITSELF (e.g. the container is an <a> and you want its href, or it carries data-* attributes), set "selector" to "" (empty string) and read from the container directly.');
  lines.push('- Otherwise the selector targets a DESCENDANT of the container.');
  lines.push('- Use stable anchors when possible: data-* attributes, aria-label, role, semantic tags.');
  lines.push('- NEVER use CSS-module / build-time hashed class names as selectors. These are short, random-looking class names like ._8Lp2Q, ._3xK9m, .sc-7bLkzJ, or any class that mixes uppercase letters, lowercase letters, and digits in a short string (3-10 chars) — they regenerate on every build and will immediately break the scraper. Instead use tag names, nth-child(), data-* attributes, aria-label/role, or other stable structural selectors.');
  lines.push('- "kind":"text" → extract textContent (default for visible text).');
  lines.push('- "kind":"attr" → extract an attribute, and you MUST include "attribute" (e.g. "href" for links, "src" for images).');
  lines.push('- "kind":"html" → innerHTML (rarely needed).');
  lines.push('- Field "name"s: snake_case, short, descriptive of the VALUE (price, title, image_url, product_link). No layout / style names.');
  lines.push('- Top-level "name": a short, human-friendly TITLE CASE title for the WHOLE list/table, describing what the rows ARE (e.g. "Product Listings", "Job Postings", "Search Results", "Cert Providers"). 1-4 words, each capitalised, spaces between words — NOT snake_case. Make it specific; never a generic "Items" / "Rows" / "List".');
  lines.push('- Aim for 3-10 fields. Always include a "link" / "url" field with kind=attr+attribute=href if the item has an anchor tag.');
  lines.push('- Always include an "image" / "image_url" field with kind=attr+attribute=src if the item has an <img>.');
  lines.push('- Skip obvious noise: decorative spans, icons, action buttons like "Add to cart".');

  if (userHint && typeof userHint === 'string' && userHint.trim()) {
    lines.push('');
    lines.push('USER REQUEST (treat as authoritative — match these field requests exactly):');
    lines.push(userHint.trim().slice(0, 2000));
  }

  if (existingFields && typeof existingFields === 'object') {
    const known = Object.entries(existingFields).filter(([, v]) => v).map(([k]) => k);
    if (known.length) {
      lines.push('');
      lines.push(`Already defined — do NOT propose duplicates: ${known.join(', ')}`);
    }
  }

  lines.push('');
  lines.push('Remember: your reply starts with { and ends with }. Nothing before, nothing after.');
  lines.push('Output the JSON object now:');
  return lines.join('\n');
}

async function proposeFields({ sampleHtml, userHint, existingFields, maxFields = 12, requestId = '?' }) {
  const tag = `[extractListAI ${requestId}]`;

  if (!sampleHtml || typeof sampleHtml !== 'string') {
    console.warn(`${tag} no sampleHtml supplied`);
    return { ok: false, error: 'sampleHtml is required', code: 'NO_HTML' };
  }
  if (!llm.isConfigured()) {
    console.warn(`${tag} LLM is not configured — set LLM_API_KEY or GROQ_API_KEY`);
    return { ok: false, error: 'LLM not configured', code: 'NO_API_KEY' };
  }

  const userPrompt = buildUserPrompt({ sampleHtml, userHint, existingFields });
  console.log(`${tag} prompting LLM — sampleHtml=${sampleHtml.length}b, hint=${(userHint || '').length}b, existing=${Object.keys(existingFields || {}).length}`);
  // Truncated visible prompts so the dev can see what we sent without
  // flooding the terminal on big pages. Full prompt is reconstructible from
  // the sample HTML + hint anyway.
  console.log(`${tag} user prompt (first 600 chars):\n${userPrompt.slice(0, 600)}${userPrompt.length > 600 ? '…' : ''}`);

  const t0 = Date.now();
  const result = await llm.safeChat({
    system: SYSTEM_PROMPT,
    user:   userPrompt,
    temperature: 0.15,
    maxTokens: 1200,
    timeoutMs: 30000,
  });
  const elapsed = Date.now() - t0;

  if (!result.ok) {
    console.warn(`${tag} LLM call failed in ${elapsed}ms: ${result.code} — ${result.error}`);
    return { ok: false, error: result.error || 'LLM call failed', code: result.code || 'LLM_FAIL' };
  }
  console.log(`${tag} LLM responded in ${elapsed}ms (${result.text.length}b). First 600 chars:\n${result.text.slice(0, 600)}${result.text.length > 600 ? '…' : ''}`);

  const parsed = parseLlmJson(result.text);
  if (!parsed) {
    console.warn(`${tag} LLM output didn't parse as JSON`);
    return { ok: false, error: 'LLM output was not valid JSON', code: 'BAD_JSON', raw: truncate(result.text, 600) };
  }
  console.log(`${tag} parsed JSON. fields=${Array.isArray(parsed.fields) ? parsed.fields.length : 'n/a'}`);

  const validated = validateFields(parsed, maxFields, tag);
  if (!validated.ok) {
    console.warn(`${tag} validation failed: ${validated.error}`);
    return { ok: false, error: validated.error, code: 'BAD_FIELDS', raw: truncate(result.text, 600) };
  }
  console.log(`${tag} validation kept ${validated.fields.length} field(s): ${validated.fields.map(f => f.name).join(', ')}`);

  return { ok: true, fields: validated.fields, explanation: validated.explanation, name: validated.name, raw: truncate(result.text, 600) };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

// Robust JSON extractor for "chatty" LLM responses. Some smaller models
// (notably Groq's llama-3.1-8b-instant) reason out loud BEFORE emitting
// their JSON, so the response often looks like:
//
//   "We need to output JSON with fields title and link. The container is
//    an <a> tag... Each field has {name, selector, ...}. Final answer:
//    {"fields": [...]}"
//
// Naive {first ... last} extraction picks up "{name, selector, ...}" from
// the prose and fails to parse. Instead we walk the string, find every
// brace-balanced `{...}` substring (respecting JSON strings + escapes),
// try parsing each one, and prefer the LATEST candidate that actually
// contains a `fields` array.
function parseLlmJson(raw) {
  if (typeof raw !== 'string') return null;

  // Strip <think> blocks and ```json fences first — easy wins.
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

  // Walk character-by-character finding all balanced top-level {...} spans.
  const candidates = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (escape) { escape = false; continue; }
      if (inStr) {
        if (ch === '\\') escape = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(s.slice(i, j + 1));
          // Skip ahead past the close — we don't need to start a new
          // candidate inside the one we just collected.
          i = j;
          break;
        }
      }
    }
  }

  const tryParse = (txt) => {
    try { return JSON.parse(txt); } catch (_) {}
    // Repair common LLM-ism: trailing commas.
    const repaired = txt.replace(/,(\s*[}\]])/g, '$1');
    try { return JSON.parse(repaired); } catch (_) { return null; }
  };

  // Iterate latest → earliest, preferring objects with a fields array.
  let firstParsable = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const obj = tryParse(candidates[i]);
    if (!obj || typeof obj !== 'object') continue;
    if (Array.isArray(obj.fields)) return obj;
    if (!firstParsable) firstParsable = obj;
  }
  return firstParsable;
}

const NAME_RX = /^[a-z][a-z0-9_]{0,40}$/;

function sanitiseName(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.trim().toLowerCase()
    // camelCase → snake_case before we strip non-alnum
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return NAME_RX.test(cleaned) ? cleaned : '';
}

// Strip common ways an LLM leaks the container into a selector. The selector
// MUST end up relative to the container, so a leading "> ", a leading
// container-matching prefix, or a leading "&" combinator should all be
// trimmed off rather than getting the proposal rejected outright.
function cleanSelector(raw, containerHint) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';
  // Drop leading combinators
  s = s.replace(/^[>+~]\s*/, '');
  // Drop a leading "& " (some models try SCSS-style nesting)
  s = s.replace(/^&\s*/, '');
  // Drop a leading "html " / "body " — selectors should be relative.
  s = s.replace(/^(?:html|body)\s+/i, '');
  // Drop a leading reference to the container selector if the model echoed it.
  if (containerHint && typeof containerHint === 'string') {
    const escaped = containerHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp('^' + escaped + '\\s+'), '');
    s = s.replace(new RegExp('^' + escaped + '\\s*>\\s*'), '');
  }
  return s.trim();
}

function validateFields(obj, maxFields, tag = '') {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'output is not an object' };
  const raw = Array.isArray(obj.fields) ? obj.fields : null;
  if (!raw) return { ok: false, error: 'fields array missing' };

  const fields = [];
  const seenNames = new Set();
  let dropped = 0;
  const dropReasons = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') { dropped++; dropReasons.push('not an object'); continue; }

    const origName = f.name;
    const name = sanitiseName(origName);
    if (!name) { dropped++; dropReasons.push(`bad name "${origName}"`); continue; }
    if (seenNames.has(name)) { dropped++; dropReasons.push(`duplicate name "${name}"`); continue; }

    // Empty selector is valid — it means "use the container element itself"
    // (the LLM uses this for cases where the value lives on the container,
    // typically an attribute like the href of an <a> container).
    if (typeof f.selector !== 'string') {
      dropped++; dropReasons.push(`selector not a string for "${name}"`); continue;
    }
    let selector = cleanSelector(f.selector);
    if (selector.length > 1000) { dropped++; dropReasons.push(`selector too long for "${name}"`); continue; }
    // We still require attribute-kind fields with an empty selector to
    // have an attribute name (otherwise there's nothing to extract).

    const rawKind = String(f.kind || '').toLowerCase();
    const kind = rawKind === 'attr' || rawKind === 'attribute' ? 'attr'
              : rawKind === 'html' ? 'html' : 'text';
    let attribute = null;
    if (kind === 'attr') {
      if (typeof f.attribute !== 'string' || !f.attribute.trim()) {
        // The model said "extract an attribute" but forgot to name which —
        // see if the field NAME or selector hints at the answer.
        const guessed = guessAttributeFromContext(name, selector);
        if (guessed) {
          attribute = guessed;
        } else {
          dropped++; dropReasons.push(`no attribute name for kind=attr "${name}"`); continue;
        }
      } else {
        attribute = f.attribute.trim();
        if (attribute.length > 100) { dropped++; dropReasons.push(`attribute too long for "${name}"`); continue; }
      }
    }
    fields.push({ name, selector, kind, attribute });
    seenNames.add(name);
    if (fields.length >= maxFields) break;
  }

  if (tag && dropped) {
    console.warn(`${tag} dropped ${dropped} field(s) during validation: ${dropReasons.slice(0, 5).join('; ')}${dropReasons.length > 5 ? '; …' : ''}`);
  }

  if (fields.length === 0) {
    return { ok: false, error: dropReasons[0] ? `no usable fields (${dropReasons[0]})` : 'no usable fields in LLM output' };
  }

  const explanation = typeof obj.explanation === 'string' ? obj.explanation.slice(0, 600) : '';
  return { ok: true, fields, explanation, name: normaliseListName(obj.name) };
}

// Normalise the LLM's proposed table title to "Aaaa Bbbb Cccc" Title Case,
// tolerating snake_case / camelCase / quoted input. Returns '' if unusable so
// the caller can fall back to its own naming.
function normaliseListName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2');   // camelCase → spaced
  s = s.replace(/[^A-Za-z0-9\s_-]/g, ' ');               // drop quotes/punct
  const words = s.split(/[_\s-]+/).filter(Boolean);
  if (!words.length) return '';
  const titled = words
    .slice(0, 4)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  return titled.length >= 2 ? titled.slice(0, 48) : '';
}

// When kind=attr but the model forgot to name the attribute, try to infer
// from the field name and the selector. "link"/"url" → href; "image" → src.
function guessAttributeFromContext(name, selector) {
  const n = name.toLowerCase();
  const s = (selector || '').toLowerCase();
  if (/href/.test(s)) return 'href';
  if (/src/.test(s))  return 'src';
  if (/(?:^|_)(url|link|href)\b|_link$|_url$|_href$/.test(n)) return 'href';
  if (/^(image|img|photo|picture|thumb|thumbnail)/.test(n) || /_image$|_img$|_photo$|_thumb$/.test(n)) return 'src';
  return null;
}

function truncate(s, n) {
  if (s == null) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n) + '...[truncated]' : s;
}

module.exports = { proposeFields };


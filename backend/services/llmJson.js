'use strict';

/* ===========================================================================
   llmJson
   ---------------------------------------------------------------------------
   Shared, defensive extractor for the single JSON object a constrained LLM
   prompt is supposed to return. Small models routinely reason out loud before
   (or wrap their answer around) the JSON, so naive {first…last} slicing fails.
   We strip <think>/code-fences, walk the string collecting every balanced
   {…} span (respecting strings + escapes), repair trailing commas, and return
   the best parse — preferring the LAST object that carries a recognised key.

   This is the same approach proven in extractListAI; centralised so every
   AI feature (naming, field discovery, self-healing) parses identically.
   ========================================================================= */

function parse(raw, { preferKeys = [] } = {}) {
  if (typeof raw !== 'string') return null;

  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

  const spans = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, escape = false;
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
        if (depth === 0) { spans.push(s.slice(i, j + 1)); i = j; break; }
      }
    }
  }

  const tryParse = (txt) => {
    try { return JSON.parse(txt); } catch (_) {}
    const repaired = txt.replace(/,(\s*[}\]])/g, '$1');
    try { return JSON.parse(repaired); } catch (_) { return null; }
  };

  let firstParsable = null;
  for (let i = spans.length - 1; i >= 0; i--) {
    const obj = tryParse(spans[i]);
    if (!obj || typeof obj !== 'object') continue;
    if (preferKeys.length && preferKeys.some(k => Object.prototype.hasOwnProperty.call(obj, k))) return obj;
    if (!firstParsable) firstParsable = obj;
  }
  return firstParsable;
}

module.exports = { parse };

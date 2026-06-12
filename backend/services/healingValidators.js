'use strict';

/* ===========================================================================
   healingValidators
   ---------------------------------------------------------------------------
   Deterministic, AI-free checks that a proposed selector is actually
   capturing *sensible* data — not just "something". This is the guard the
   user asked for: it is far better to escalate to a human than to silently
   adopt a selector that grabs the wrong element (e.g. a nav label instead of
   a price) or grabs nothing useful.

   These operate on already-extracted sample VALUES (strings), so they are
   pure and unit-testable. The DOM-side matching/counting lives in
   healingVerify (which needs a browser); this module judges the values that
   matching produced.
   ========================================================================= */

// Characters-only / punctuation-only strings carry no real data.
const PUNCT_ONLY_RX = /^[\s\p{P}\p{S}]*$/u;

function isBlank(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

function looksLikeUrl(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  if (/^javascript:/i.test(s)) return false;          // void links aren't data
  if (/^#/.test(s)) return false;                      // pure in-page anchor
  return /^(https?:)?\/\//i.test(s)                    // absolute / protocol-relative
      || /^\//.test(s)                                 // root-relative
      || /^data:/i.test(s)                             // data URI (images)
      || /^[\w./-]+\.[a-z]{2,}(\/|$)/i.test(s);        // bare host/path
}

function hasDigit(v) {
  return typeof v === 'string' && /\d/.test(v);
}

/**
 * Judge a single extracted value against the field's contract.
 *
 * @param {Object} field  { name, kind:'text'|'attr'|'html', attribute? }
 * @param {*} value       the extracted value (string|null)
 * @returns {{ ok:boolean, reason:string|null }}
 */
function validateValue(field, value) {
  const name = String((field && field.name) || '').toLowerCase();
  const kind = (field && field.kind) || 'text';
  const attr = (field && field.attribute) || '';

  if (isBlank(value)) return { ok: false, reason: 'empty' };
  const s = String(value).trim();

  if (kind === 'attr') {
    const a = String(attr).toLowerCase();
    if (a === 'href') {
      return looksLikeUrl(s) ? { ok: true, reason: null } : { ok: false, reason: 'href is not a link' };
    }
    if (a === 'src' || a === 'data-src' || a === 'srcset') {
      return looksLikeUrl(s) ? { ok: true, reason: null } : { ok: false, reason: 'src is not a URL' };
    }
    // Other attributes: just require non-blank, non-punctuation.
    return PUNCT_ONLY_RX.test(s) ? { ok: false, reason: 'attribute is punctuation only' } : { ok: true, reason: null };
  }

  // text / html
  if (PUNCT_ONLY_RX.test(s)) return { ok: false, reason: 'value is punctuation/whitespace only' };

  // Light, name-driven sanity: price/amount/cost fields should contain a digit.
  if (/(price|amount|cost|total|salary|fee|qty|quantity|count|number|year|rating|score|views?)/.test(name)
      && !hasDigit(s)) {
    return { ok: false, reason: `"${name}" has no digit — likely the wrong element` };
  }

  return { ok: true, reason: null };
}

/**
 * Aggregate verdict for a field across MULTIPLE sample values (one per
 * surveyed container).
 *
 * We separate two questions that a flat "valid rate" conflates:
 *   - presence  : in how many rows did the selector MATCH at all? (a field
 *                 that is legitimately optional — e.g. a sale discount — is
 *                 simply absent in some rows; that must NOT count against it)
 *   - quality   : OF the rows where it matched, how many returned a sensible
 *                 value? (this is what catches a selector pointing at the
 *                 wrong element — e.g. brand text where a price was expected)
 *
 * A field is accepted only when the values it DID produce are sensible
 * (quality ≥ minValidRate) AND it matched enough rows to trust it (≥2, or at
 * least half) — a single lucky hit on a long list is rejected.
 *
 * @param {Object} field
 * @param {Array} samples   extracted values across containers (null = no match)
 * @param {Object} [opts]   { minValidRate=0.8 }
 * @returns {{ ok:boolean, quality:number, presence:number, validRate:number,
 *             matched:number, valid:number, total:number, reasons:string[] }}
 */
function assessFieldSamples(field, samples, opts = {}) {
  const minValidRate = typeof opts.minValidRate === 'number' ? opts.minValidRate : 0.8;
  const list = Array.isArray(samples) ? samples : [];
  const total = list.length;
  if (total === 0) {
    return { ok: false, quality: 0, presence: 0, validRate: 0, matched: 0, valid: 0, total: 0, reasons: ['no samples'] };
  }
  let matched = 0, valid = 0;
  const reasons = new Set();
  for (const v of list) {
    if (isBlank(v)) continue;                 // field simply absent in this row
    matched++;
    const r = validateValue(field, v);
    if (r.ok) valid++;
    else if (r.reason) reasons.add(r.reason);
  }
  const quality  = matched ? valid / matched : 0;
  const presence = matched / total;
  const validRate = valid / total;
  const enoughRows = matched >= 2 || presence >= 0.5;
  return {
    ok: matched >= 1 && quality >= minValidRate && enoughRows,
    quality, presence, validRate, matched, valid, total,
    reasons: Array.from(reasons),
  };
}

module.exports = {
  isBlank,
  looksLikeUrl,
  validateValue,
  assessFieldSamples,
};

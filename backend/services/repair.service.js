'use strict';

const llm = require('./llm.service');

/* ===========================================================================
   repair.service
   ---------------------------------------------------------------------------
   When a workflow step fails because the page's HTML structure changed, ask
   the LLM to propose a patch to the step's parameters (typically a new
   selector). We deliberately do NOT ask the LLM to rewrite the underlying
   Puppeteer code: the workflow JSON is the user's source of truth, and a
   selector swap is far easier to validate than arbitrary code.

   Public surface:
     proposePatch({ step, errorMessage, pageHtml })
       → { ok: true, patch, explanation, confidence }
       → { ok: false, error, code }              ← LLM unreachable / bad output

   The caller (executionPipeline) is responsible for applying the patch to
   a deep copy of the workflow, re-running, and recording the repair attempt.
   ========================================================================= */

const SYSTEM_PROMPT = [
  'You are a web scraping workflow repair assistant.',
  'A single step in an automated scraping workflow has just failed. The workflow targets a real website whose HTML may have changed since the workflow was authored.',
  '',
  'Your task: propose a minimal change to that step\'s parameters that will make it work on the supplied current HTML.',
  '',
  'STRICT OUTPUT FORMAT:',
  '- Respond with EXACTLY one JSON object. No prose. No code fences. No leading "Here is" / trailing explanations.',
  '- Shape: {"newParams": { ... }, "explanation": "...", "confidence": "high"|"medium"|"low"}.',
  '- "newParams" contains ONLY the param fields you wish to change. Typical fields: "selector" (string), "selectorType" ("css" or "xpath"), "fallbackSelectors" (array of {"value": string, "type": "css"|"xpath"}), "attribute" (only for EXTRACT_ATTRIBUTE).',
  '- DO NOT include other params (url, text, etc.) unless they are clearly the cause of the failure.',
  '- DO NOT change the action type.',
  '',
  'SELECTOR RULES:',
  '- Selectors must be valid CSS (default) or XPath (when selectorType = "xpath"). They must select the element described by the step\'s label / original selector.',
  '- Prefer STABLE anchors in the HTML: id="...", data-* attributes, aria-label, role, semantic tags. Avoid randomly-hashed class names like "css-1a2b3c" or "_ngContent-abc".',
  '- For lists / iteration (FOR_EACH_ELEMENTS), the selector must match MULTIPLE sibling items, not a single specific one.',
  '- Add 1-2 fallbackSelectors when there is more than one reasonable candidate.',
  '',
  'CONFIDENCE:',
  '- "high"    — the new selector clearly maps to the element described by the step.',
  '- "medium"  — there is a likely match but ambiguity exists.',
  '- "low"     — page may be showing an error / login / captcha; or no clearly matching element is present. Still propose your best guess.',
  '',
  'If the HTML is too short or unrelated to make any guess, return: {"newParams": {}, "explanation": "Page content does not contain a recognisable target", "confidence": "low"}.',
].join('\n');

function buildUserPrompt({ step, errorMessage, pageHtml, pageUrl }) {
  const lines = [];
  lines.push('Failing step:');
  lines.push(`  Type:  ${step.type || 'unknown'}`);
  if (step.label) lines.push(`  Label: ${step.label}`);
  lines.push(`  Current params: ${truncate(JSON.stringify(step.params || {}), 1200)}`);
  lines.push('');
  lines.push('Error from runtime:');
  lines.push(`  ${truncate(errorMessage, 600)}`);
  if (pageUrl) {
    lines.push('');
    lines.push(`Current page URL: ${pageUrl}`);
  }
  lines.push('');
  lines.push('Cleaned HTML at the time of failure (head, scripts, styles already removed):');
  lines.push('```html');
  lines.push(truncate(pageHtml || '[no html captured]', 45000));
  lines.push('```');
  lines.push('');
  lines.push('Respond with the JSON patch only.');
  return lines.join('\n');
}

async function proposePatch({ step, errorMessage, pageHtml, pageUrl }) {
  if (!step) {
    return { ok: false, error: 'no step', code: 'NO_STEP' };
  }
  if (!llm.isConfigured()) {
    return { ok: false, error: 'LLM not configured', code: 'NO_API_KEY' };
  }

  const user = buildUserPrompt({ step, errorMessage, pageHtml, pageUrl });

  // Generous maxTokens because reasoning-style models burn budget on thought
  // before emitting the JSON. We're not paying per token in dev (free Groq)
  // and we want a complete answer.
  const result = await llm.safeChat({
    system: SYSTEM_PROMPT,
    user,
    temperature: 0.1,
    maxTokens: 800,
    timeoutMs: 30000,
  });

  if (!result.ok) {
    return { ok: false, error: result.error || 'LLM call failed', code: result.code || 'LLM_FAIL' };
  }

  const parsed = parseLlmJson(result.text);
  if (!parsed) {
    return { ok: false, error: 'LLM output was not valid JSON', code: 'BAD_JSON', raw: truncate(result.text, 400) };
  }

  const validated = validatePatch(parsed, step);
  if (!validated.ok) {
    return { ok: false, error: validated.error, code: 'BAD_PATCH', raw: truncate(result.text, 400) };
  }

  return {
    ok: true,
    patch:       validated.newParams,
    explanation: validated.explanation,
    confidence:  validated.confidence,
  };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function parseLlmJson(raw) {
  if (typeof raw !== 'string') return null;
  // Strip ```json fences and <think> blocks defensively.
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/```(?:json)?/gi, '').trim();
  // Find the outermost JSON object — some models add a sentence before it.
  const first = s.indexOf('{');
  const last  = s.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  const candidate = s.slice(first, last + 1);
  try { return JSON.parse(candidate); } catch (_) { return null; }
}

function validatePatch(obj, step) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'patch is not an object' };
  const np = obj.newParams;
  if (!np || typeof np !== 'object') return { ok: false, error: 'newParams missing' };

  const out = {};

  if (np.selector !== undefined) {
    if (typeof np.selector !== 'string' || !np.selector.trim()) {
      return { ok: false, error: 'selector must be a non-empty string' };
    }
    if (np.selector.length > 2000) {
      return { ok: false, error: 'selector unreasonably long' };
    }
    out.selector = np.selector.trim();
  }
  if (np.selectorType !== undefined) {
    const t = String(np.selectorType).toLowerCase();
    if (t !== 'css' && t !== 'xpath') {
      return { ok: false, error: 'selectorType must be css or xpath' };
    }
    out.selectorType = t;
  }
  if (np.fallbackSelectors !== undefined) {
    if (!Array.isArray(np.fallbackSelectors)) {
      return { ok: false, error: 'fallbackSelectors must be an array' };
    }
    const fb = [];
    for (const f of np.fallbackSelectors.slice(0, 5)) {
      if (typeof f === 'string') { fb.push({ value: f, type: 'css' }); continue; }
      if (f && typeof f === 'object' && typeof f.value === 'string' && f.value.trim()) {
        const t = (f.type === 'xpath') ? 'xpath' : 'css';
        fb.push({ value: f.value.trim(), type: t });
      }
    }
    out.fallbackSelectors = fb;
  }
  // EXTRACT_ATTRIBUTE-specific
  if (step.type === 'EXTRACT_ATTRIBUTE' && typeof np.attribute === 'string' && np.attribute.trim()) {
    out.attribute = np.attribute.trim();
  }

  // Reject patches that don't change anything actionable.
  const hasChange = out.selector || out.selectorType || out.fallbackSelectors || out.attribute;
  if (!hasChange) {
    return { ok: false, error: 'patch contains no actionable fields' };
  }

  const confidence = ['high', 'medium', 'low'].includes(obj.confidence) ? obj.confidence : 'medium';
  const explanation = typeof obj.explanation === 'string' ? obj.explanation.slice(0, 1000) : '';

  return { ok: true, newParams: out, explanation, confidence };
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '...[truncated]' : s;
}

module.exports = { proposePatch };

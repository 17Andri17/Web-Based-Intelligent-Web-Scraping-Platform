'use strict';

/* ===========================================================================
   Reusable LLM client (defaults to Groq's OpenAI-compatible endpoint).
   ---------------------------------------------------------------------------
   Environment:
     LLM_API_KEY    – the API key (falls back to GROQ_API_KEY for back-compat)
     LLM_BASE_URL   – OpenAI-compatible base URL (default Groq's)
     LLM_MODELS     – comma-separated model ids, best first. The client tries
                      them in order and falls back to the next one when a model
                      hits its rate limit (HTTP 429) or is otherwise unavailable
                      (HTTP 5xx). Defaults to a free Groq chain (best → worst).
     LLM_MODEL      – single model id; used as the primary when LLM_MODELS is
                      unset (kept for back-compat).
     LLM_TIMEOUT_MS – per-request timeout (default 15000)

   Public API:
     isConfigured()                → boolean
     chat({ system, user, ... })   → returns content string (throws on error)
     safeChat({ ... })             → returns { ok, text, error } (never throws)

   Callers should treat this module as opaque: pass a system + user prompt
   in, get a text completion out. Validation / parsing of the response is
   the caller's responsibility (LLM output is untrusted).
   =========================================================================== */

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
// Plain chat model — fast, free, and unlike `openai/gpt-oss-*` it doesn't
// route its output through a separate reasoning channel that leaves
// message.content empty.
const DEFAULT_MODEL    = 'llama-3.1-8b-instant';
// Ordered fallback chain (best → worst), all free on Groq's tier. The smarter
// 70b model is tried first; when it hits its rate limit we drop to the small,
// high-throughput model that almost always has quota left.
const DEFAULT_MODELS = [
  'qwen/qwen3-32b',
  'deepseek-r1-distill-llama-70b',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant'
];
const DEFAULT_TIMEOUT  = 15000;

// HTTP_429 = rate limit reached; HTTP_5xx = provider unavailable. Both mean
// "this model can't answer right now" → try the next one in the chain.
function isFallbackCode(code) {
  return code === 'HTTP_429' || /^HTTP_5\d\d$/.test(String(code || ''));
}

// Resolve the ordered model chain. LLM_MODELS (comma-separated, best first)
// wins; otherwise fall back to the single LLM_MODEL, otherwise the built-in
// free chain.
function getModels() {
  const fromList = (process.env.LLM_MODELS || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  if (fromList.length) return fromList;
  if (process.env.LLM_MODEL) return [process.env.LLM_MODEL.trim()];
  return [...DEFAULT_MODELS];
}

function getConfig() {
  return {
    apiKey:  process.env.LLM_API_KEY || process.env.GROQ_API_KEY || '',
    baseUrl: (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model:   process.env.LLM_MODEL || DEFAULT_MODEL,
    models:  getModels(),
    timeout: Number(process.env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT,
  };
}

function isConfigured() {
  return Boolean(getConfig().apiKey);
}

// Single request against one specific model. Throws on any failure with an
// `err.code` set (HTTP_<status>, EMPTY_RESPONSE, etc.).
async function chatOnce(cfg, modelId, { messages, temperature, maxTokens, timeoutMs }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs ?? cfg.timeout);

  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`LLM HTTP ${res.status} (${modelId}): ${body.slice(0, 200)}`);
    err.code = `HTTP_${res.status}`;
    throw err;
  }

  const data = await res.json();
  const msg = data?.choices?.[0]?.message;

  // Reasoning-style models (Groq's `openai/gpt-oss-*`, DeepSeek-R1 derivatives,
  // etc.) sometimes emit their final answer through a separate `reasoning`
  // field and leave `content` as an empty string. Other implementations wrap
  // the chain-of-thought in `<think>…</think>` blocks inside `content` and
  // put the answer after. Try to pull the actual answer out of either shape.
  let text = typeof msg?.content === 'string' ? msg.content : '';
  if (!text.trim() && typeof msg?.reasoning === 'string') {
    text = msg.reasoning;
  }
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  if (!text) {
    const err = new Error('LLM response missing content (try a non-reasoning model like llama-3.1-8b-instant)');
    err.code = 'EMPTY_RESPONSE';
    throw err;
  }
  return text;
}

async function chat({ system, user, model, temperature = 0.2, maxTokens = 60, timeoutMs }) {
  const cfg = getConfig();
  if (!cfg.apiKey) {
    const err = new Error('LLM not configured (set LLM_API_KEY or GROQ_API_KEY in environment)');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: String(system) });
  messages.push({ role: 'user', content: String(user || '') });

  // An explicit per-call model opts out of the fallback chain; otherwise walk
  // the configured chain (best → worst) and step down on rate-limit / outage.
  const chain = model ? [model] : cfg.models;
  const opts = { messages, temperature, maxTokens, timeoutMs };

  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    try {
      return await chatOnce(cfg, chain[i], opts);
    } catch (err) {
      lastErr = err;
      const hasNext = i < chain.length - 1;
      if (hasNext && isFallbackCode(err.code)) continue;
      throw err;
    }
  }
  throw lastErr;
}

async function safeChat(opts) {
  try {
    const text = await chat(opts);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code || 'UNKNOWN' };
  }
}

module.exports = { isConfigured, chat, safeChat };

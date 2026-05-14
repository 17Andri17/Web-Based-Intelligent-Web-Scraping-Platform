'use strict';

/* ===========================================================================
   Reusable LLM client (defaults to Groq's OpenAI-compatible endpoint).
   ---------------------------------------------------------------------------
   Environment:
     LLM_API_KEY    – the API key (falls back to GROQ_API_KEY for back-compat)
     LLM_BASE_URL   – OpenAI-compatible base URL (default Groq's)
     LLM_MODEL      – model id (default openai/gpt-oss-20b on Groq's free tier)
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
const DEFAULT_MODEL    = 'openai/gpt-oss-20b';
const DEFAULT_TIMEOUT  = 15000;

function getConfig() {
  return {
    apiKey:  process.env.LLM_API_KEY || process.env.GROQ_API_KEY || '',
    baseUrl: (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model:   process.env.LLM_MODEL || DEFAULT_MODEL,
    timeout: Number(process.env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT,
  };
}

function isConfigured() {
  return Boolean(getConfig().apiKey);
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
        model: model || cfg.model,
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
    const err = new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.code = `HTTP_${res.status}`;
    throw err;
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    const err = new Error('LLM response missing content');
    err.code = 'BAD_RESPONSE';
    throw err;
  }
  return text;
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

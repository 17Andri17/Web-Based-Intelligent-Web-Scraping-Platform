'use strict';

// Quick health check for the LLM connection.
// Usage:  cd backend && node scripts/test-llm.js
//
// Reads backend/.env automatically. Prints what's configured, hits the
// model with a tiny ping, and tells you exactly what failed if it did.

require('dotenv').config();
const llm = require('../services/llm.service');

(async () => {
  console.log('── LLM connection check ───────────────────────────');
  console.log('Configured: ', llm.isConfigured());
  console.log('Model:      ', process.env.LLM_MODEL    || '(default) llama-3.1-8b-instant');
  console.log('Base URL:   ', process.env.LLM_BASE_URL || '(default) https://api.groq.com/openai/v1');
  console.log('Timeout:    ', (process.env.LLM_TIMEOUT_MS || 15000) + ' ms');
  const key = process.env.LLM_API_KEY || process.env.GROQ_API_KEY || '';
  console.log('API key:    ', key ? `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)` : '(none)');
  console.log('───────────────────────────────────────────────────\n');

  if (!llm.isConfigured()) {
    console.log('❌ No API key set. Add GROQ_API_KEY=... to backend/.env');
    process.exit(1);
  }

  // 1) Ping the model.
  const ping = await llm.safeChat({
    system: 'Reply with exactly one short word.',
    user:   'Say pong.',
    maxTokens: 8,
  });
  if (!ping.ok) {
    console.log('❌ Ping failed');
    console.log('   code: ', ping.code);
    console.log('   error:', ping.error);
    process.exit(1);
  }
  const pingText = ping.text.trim();
  if (!pingText) {
    console.log('❌ Ping returned 200 but empty text.');
    console.log('   The model likely uses a reasoning channel that leaves');
    console.log('   message.content empty. Switch LLM_MODEL in backend/.env');
    console.log('   to e.g. llama-3.1-8b-instant and rerun.');
    process.exit(1);
  }
  console.log('✅ Ping reply:', JSON.stringify(pingText));

  // 2) Try a real name-suggestion to verify the prompt path.
  const name = await llm.safeChat({
    system: 'You name data fields. Output ONLY a snake_case name, lowercase letters/digits/underscores, 2-30 chars. Nothing else.',
    user:   'Action: EXTRACT_TEXT\nHTML: <span class="price">$24.99</span>\nSample value: $24.99',
    maxTokens: 16,
  });
  if (!name.ok) {
    console.log('⚠ Suggestion call failed:', name.code, name.error);
  } else {
    const sug = name.text.trim();
    if (sug) console.log('✅ Suggestion reply:', JSON.stringify(sug));
    else      console.log('⚠ Suggestion returned empty text (see ping diagnostic above)');
  }

  console.log('\nDone. If both lines are ✅, your endpoint is good to go.');
})();

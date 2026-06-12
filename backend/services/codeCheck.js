'use strict';

const vm = require('vm');

/* ===========================================================================
   codeCheck
   ---------------------------------------------------------------------------
   A no-AI guard that a patched workflow still compiles. After the healing
   pipeline rewrites a selector (or drops a field) we regenerate the whole
   Puppeteer script and parse it here BEFORE attempting an end-to-end re-run.
   `new vm.Script(code)` parses without executing — requires never fire, the
   browser never launches — so this is a cheap, safe syntax gate that catches
   a malformed selector that produced invalid generated code.
   ========================================================================= */

/**
 * @param {string} code  generated Node.js source
 * @returns {{ ok: boolean, error: string|null }}
 */
function checkCompiles(code) {
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, error: 'no code to check' };
  }
  try {
    // eslint-disable-next-line no-new
    new vm.Script(code, { filename: 'healed-workflow.js' });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err && err.message ? String(err.message) : String(err) };
  }
}

module.exports = { checkCompiles };

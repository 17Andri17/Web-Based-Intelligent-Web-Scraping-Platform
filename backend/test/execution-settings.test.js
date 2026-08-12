'use strict';

/* Per-workflow reliability settings must actually reach the run.

   The failure mode here is silent: a user raises the timeout to 90s because a
   site is slow, the setting is stored, the UI shows it — and the generated
   script still says 30000. Nothing errors; the run just keeps failing for the
   original reason. Same for turning self-healing off and having a selector
   quietly rewritten anyway.

   So these assert the settings survive the whole way into the emitted code,
   and that the defaults are unchanged for a workflow that never opted in.

   Run:  node test/execution-settings.test.js  */

const {
  generateCode, resolveExecution, EXECUTION_DEFAULTS,
} = require('../workflow/workflowCodegen');
const { buildCodegenStealthHelper, DEVICE_PROFILES } = require('../browser/stealthCore');

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      ${detail ?? ''}`}`);
};

const navStep = (advanced = {}) => ([{
  id: 'n1', kind: 'action', type: 'NAVIGATE', label: 'Go', pinned: true,
  params: { url: 'https://example.test' }, advanced, outputVar: 'pageurl',
}]);
const src = (out) => (typeof out === 'string' ? out : out.code);
const gen = (meta, steps = navStep()) => src(generateCode({ steps, meta }));

/* ── resolver ─────────────────────────────────────────────────────────── */
console.log('resolveExecution');

t('a workflow with no execution block gets the defaults',
  JSON.stringify(resolveExecution({})) === JSON.stringify(EXECUTION_DEFAULTS),
  JSON.stringify(resolveExecution({})));

t('a workflow with no meta at all is survivable',
  JSON.stringify(resolveExecution(undefined)) === JSON.stringify(EXECUTION_DEFAULTS));

{
  const r = resolveExecution({ execution: { navTimeoutMs: 90000, connectionRetries: 5, healing: false, deviceProfile: 'mac-m2' } });
  t('explicit values are kept', r.navTimeoutMs === 90000 && r.connectionRetries === 5
    && r.healing === false && r.deviceProfile === 'mac-m2', JSON.stringify(r));
}

{
  const r = resolveExecution({ execution: { navTimeoutMs: 1, connectionRetries: 999 } });
  t('absurd values are clamped, not obeyed', r.navTimeoutMs === 1000 && r.connectionRetries === 10,
    JSON.stringify(r));
}

// Healing is the one setting where the wrong default is dangerous: an older
// workflow saved before this existed must keep healing.
t('healing stays on unless explicitly false',
  resolveExecution({ execution: {} }).healing === true &&
  resolveExecution({ execution: { healing: undefined } }).healing === true &&
  resolveExecution({ execution: { healing: false } }).healing === false);

t('a garbage value falls back rather than reaching codegen',
  resolveExecution({ execution: { navTimeoutMs: 'soon' } }).navTimeoutMs === EXECUTION_DEFAULTS.navTimeoutMs);

/* ── the settings reach the emitted script ────────────────────────────── */
console.log('generated script');

t('the default navigation timeout is 30s', /timeout: 30000/.test(gen({})));

t('a raised timeout reaches the script',
  /timeout: 90000/.test(gen({ execution: { navTimeoutMs: 90000 } })));

// The whole point of a per-step timeout is that it's more specific.
t('a step with its own timeout still wins',
  /timeout: 5000/.test(gen({ execution: { navTimeoutMs: 90000 } }, navStep({ timeout: 5000 }))));

t('the script still parses with custom settings', (() => {
  const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-set-'));
  try {
    const file = path.join(dir, 'w.js');
    fs.writeFileSync(file, gen({ execution: { navTimeoutMs: 90000, deviceProfile: 'mac-m2' } }));
    return cp.spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status === 0;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})());

/* ── device profile pinning ───────────────────────────────────────────── */
console.log('device profile');

t('pinning is stable across builds', (() => {
  const ids = new Set(Array.from({ length: 8 }, () => buildCodegenStealthHelper('mac-m2').profile.id));
  return ids.size === 1 && ids.has('mac-m2');
})());

t('auto still rotates', (() => {
  // With 4 profiles, 40 draws landing on one id would be ~1 in 10^23.
  const ids = new Set(Array.from({ length: 40 }, () => buildCodegenStealthHelper('auto').profile.id));
  return ids.size > 1;
})());

t('an unknown profile id falls back to rotation rather than breaking',
  !!buildCodegenStealthHelper('does-not-exist').profile.id);

t('every id offered in the UI exists in DEVICE_PROFILES', (() => {
  const offered = ['win-nvidia', 'win-intel', 'win-amd', 'mac-m2'];
  const known = new Set(DEVICE_PROFILES.map(p => p.id));
  return offered.every(id => known.has(id));
})(), `known: ${DEVICE_PROFILES.map(p => p.id).join(', ')}`);

// A pinned profile has to stay internally consistent — that's the reason the
// control is a profile and not a free-text user-agent string.
t('a pinned profile keeps UA and platform in agreement', (() => {
  const { profile } = buildCodegenStealthHelper('mac-m2');
  return /Macintosh/.test(profile.userAgent) && profile.platform === 'MacIntel';
})());

console.log(`\n${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);

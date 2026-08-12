/* Every dialog in the app must be operable from a keyboard.

   This is a STATIC test: it checks the wiring, not the runtime behaviour —
   the app has no DOM test harness, and the dialogs all sit behind sign-in so
   they can't be driven in a browser unattended. What it does catch is the way
   this actually regresses: someone adds dialog #25 by copy-pasting an older
   one, and it silently arrives with no focus trap, no Escape, and no way out
   for a keyboard user.

   The behaviour itself lives in components/useDialog.js (Modal.jsx consumes
   the same hook), so "is it wired up?" is a good proxy for "does it work?".

   Run (from frontend/):  npm test  */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      ${detail ?? ''}`}`);
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full, out); continue; }
    if (entry.endsWith('.jsx')) out.push(full);
  }
  return out;
}

const files = walk(srcRoot).map(f => ({ path: relative(srcRoot, f), src: readFileSync(f, 'utf8') }));

/* ── every overlay gets the behaviour ─────────────────────────────────── */
console.log('dialog coverage');

const OVERLAY = /className="[a-z-]*overlay/;
const withOverlay = files.filter(f => OVERLAY.test(f.src));

t('the app still has dialogs to check', withOverlay.length > 0, String(withOverlay.length));

const unwired = withOverlay.filter(f => !/useDialog|<Modal/.test(f.src));
t('every file with an overlay uses useDialog (or Modal)', unwired.length === 0,
  `no dialog behaviour in: ${unwired.map(f => f.path).join(', ')}`);

/* A dialog that closes on ANY click that failed to stopPropagation — including
   the mouseup of a text selection that drifted onto the backdrop. The hook's
   overlayProps replace this; re-introducing it is the regression. */
const adHocBackdrop = files.filter(f =>
  /className="[a-z-]*overlay"\s+onClick=\{on(Close|Cancel)\}/.test(f.src));
t('no overlay closes on a bare onClick={onClose}', adHocBackdrop.length === 0,
  adHocBackdrop.map(f => f.path).join(', '));

/* ── native dialogs stay gone ─────────────────────────────────────────── */
console.log('native dialogs');

const nativeCall = /(^|[^.\w])(confirm|alert|prompt)\s*\(/;
const offenders = files.filter(f => {
  // Strip comments and the ConfirmDialog module itself (which legitimately
  // names the API it replaces).
  if (f.path.replace(/\\/g, '/').endsWith('components/ConfirmDialog.jsx')) return false;
  const code = f.src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/await\s+confirm\s*\(/g, 'AWAITED(')      // ours
    .replace(/const confirm = useConfirm\(\);/g, '');
  return nativeCall.test(code);
});
t('no window.confirm / alert / prompt anywhere', offenders.length === 0,
  offenders.map(f => f.path).join(', '));

/* ── the primitive keeps its guarantees ───────────────────────────────── */
console.log('useDialog contract');
const hook = readFileSync(join(here, 'useDialog.js'), 'utf8');

for (const [label, re] of [
  ['traps Tab inside the dialog',        /e\.key !== "Tab"[\s\S]*preventDefault/],
  ['closes on Escape',                   /e\.key === "Escape"/],
  ['only the topmost dialog responds',   /stack\[stack\.length - 1\] !== tokenRef\.current/],
  ['restores focus on close',            /restoreFocusRef[\s\S]*\.focus\(/],
  ['locks background scroll',            /document\.body\.style\.overflow = "hidden"/],
  ['marks the element as a dialog',      /role: "dialog"/],
  ['sets aria-modal',                    /"aria-modal": "true"/],
  ['requires the gesture to start on the backdrop', /pressOnBackdropRef/],
]) {
  t(`useDialog ${label}`, re.test(hook));
}

// The scroll lock is reference-counted: a nested dialog closing must not
// unlock the page while its parent is still open.
t('useDialog reference-counts the scroll lock',
  /if \(stack\.length !== 1\) return;/.test(hook) && /if \(stack\.length !== 0\) return;/.test(hook));

// position:fixed makes offsetParent null for the entire dialog subtree, so a
// visibility check based on it would find zero focusable elements.
t('useDialog does not use offsetParent for visibility',
  !/offsetParent/.test(hook) || /offsetParent` is null/.test(hook));

console.log(`\n${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);

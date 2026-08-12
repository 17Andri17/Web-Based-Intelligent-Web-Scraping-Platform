/* Both themes must stay readable, and stay in sync.

   A light theme rots in two quiet ways: a token gets added to one theme and
   not the other (so it silently keeps its dark value on a white page), or a
   colour is nudged for looks until text stops being legible. Neither shows up
   in a build or a lint — only in someone's eyes, months later.

   These parse the real token blocks out of app.css and check both.

   Run (from frontend/):  npm test  */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'app.css'), 'utf8');

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      ${detail ?? ''}`}`);
};

/* ── contrast ─────────────────────────────────────────────────────────── */
const toRgb = (h) => {
  h = h.trim().replace('#', '');
  if (h.length === 3) h = [...h].map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
};
const luminance = (rgb) => {
  const [r, g, b] = rgb.map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(toRgb(a)), luminance(toRgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/* ── token extraction ─────────────────────────────────────────────────── */
// Grab a `--name: value;` from a specific block of the file.
function blockAfter(marker) {
  const at = css.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const open = css.indexOf('{', at);
  // Walk braces so a nested media-query block is captured whole.
  let depth = 0, i = open;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) break; }
  }
  return css.slice(open, i);
}
const tokensIn = (block) => {
  const out = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
};

const dark  = tokensIn(blockAfter('\n:root {'));
const light = tokensIn(blockAfter(':root[data-theme="light"] {'));
const lightAuto = tokensIn(blockAfter('@media (prefers-color-scheme: light)'));

console.log('defaults');
// Dark is the product's default and a light OS must not silently override it.
// The guarantee is structural: the follow-the-OS rule is keyed to an explicit
// data-theme="system", so a bare <html> can only ever resolve to the dark
// block. If someone re-points that media query at :root or :not([data-theme]),
// the default flips for every user on a light machine — hence this test.
t('the OS media query only applies to an explicit "system" choice',
  /@media \(prefers-color-scheme: light\)\s*\{\s*:root\[data-theme="system"\]/.test(css),
  'the prefers-color-scheme block must be scoped to :root[data-theme="system"]');
t('no rule lets a light OS style a bare :root',
  !/@media \(prefers-color-scheme: light\)\s*\{\s*:root(\s*\{|:not)/.test(css));

console.log('theme parity');
t('the dark block defines tokens', Object.keys(dark).length > 20, Object.keys(dark).length);
t('the light block defines tokens', Object.keys(light).length > 20, Object.keys(light).length);
// The light theme should read as a designed surface, not an unstyled page:
// panels sit ABOVE a tinted canvas rather than being cut out of white.
const lighter = (a, b) => luminance(toRgb(a)) > luminance(toRgb(b));
t('light: panels lift off the canvas rather than sinking into it',
  lighter(light['--bg-secondary'], light['--bg-primary']),
  `--bg-secondary ${light['--bg-secondary']} should be lighter than --bg-primary ${light['--bg-primary']}`);
t('light: the canvas is tinted, not pure white',
  light['--bg-primary'].toLowerCase() !== '#ffffff' && light['--bg-primary'].toLowerCase() !== '#fff',
  light['--bg-primary']);
// Dark keeps the opposite ramp — surfaces get lighter as they come forward.
t('dark: panels still lift off the canvas',
  lighter(dark['--bg-secondary'], dark['--bg-primary']));

// Colour tokens only: radii/transitions are theme-independent by design.
const isColour = (k, v) => /^(--bg|--text|--accent|--border|--tint|--syntax|--shadow)/.test(k)
  && !/^--(radius|transition)/.test(k);
const darkColours = Object.keys(dark).filter(k => isColour(k, dark[k]));
const missing = darkColours.filter(k => !(k in light));
t('every dark colour token has a light counterpart', missing.length === 0,
  `missing from the light theme: ${missing.join(', ')}`);

// The prefers-color-scheme block and the explicit [data-theme="light"] block
// must agree, or the app looks different before and after you touch the
// toggle — the most confusing possible bug.
const drift = Object.keys(light)
  .filter(k => isColour(k, light[k]))
  .filter(k => lightAuto[k] !== undefined && lightAuto[k] !== light[k]);
t('auto-light and explicit-light agree on every token', drift.length === 0,
  drift.map(k => `${k}: auto=${lightAuto[k]} vs explicit=${light[k]}`).join('; '));

console.log('contrast (WCAG AA, 4.5:1 for normal text)');
const surfaces = ['--bg-primary', '--bg-secondary', '--bg-tertiary'];
const bodyText = ['--text-primary', '--text-secondary', '--text-muted'];

for (const [name, tok] of [['dark', dark], ['light', light]]) {
  for (const fg of bodyText) {
    const worst = Math.min(...surfaces.map(bg => contrast(tok[fg], tok[bg])));
    t(`${name}: ${fg} is readable on the page background`,
      contrast(tok[fg], tok['--bg-primary']) >= 4.5,
      `${tok[fg]} on ${tok['--bg-primary']} = ${contrast(tok[fg], tok['--bg-primary']).toFixed(2)}:1`);
    // Chips and badges sit on --bg-tertiary and are small/bold, so the large-text
    // threshold (3:1) is the honest bar for the worst surface.
    t(`${name}: ${fg} clears 3:1 on every surface`, worst >= 3,
      `worst = ${worst.toFixed(2)}:1`);
  }
  // Accents are used as text (links, status labels), not just as fills.
  for (const fg of ['--accent-primary', '--accent-success', '--accent-danger', '--accent-warning']) {
    const r = contrast(tok[fg], tok['--bg-primary']);
    t(`${name}: ${fg} clears 3:1 as text on the page background`, r >= 3,
      `${tok[fg]} on ${tok['--bg-primary']} = ${r.toFixed(2)}:1`);
  }
  // Filled buttons. The accents themselves are too bright in dark mode to
  // carry white text (white on #58a6ff is 2.5:1), which is exactly why the
  // -fill tokens exist — so this checks the fills, not the accents.
  for (const fg of ['--accent-primary-fill', '--accent-success-fill',
                    '--accent-danger-fill', '--accent-purple-fill']) {
    const r = contrast(tok['--text-on-accent'], tok[fg]);
    t(`${name}: button text on ${fg} clears 4:1`, r >= 4,
      `${tok['--text-on-accent']} on ${tok[fg]} = ${r.toFixed(2)}:1`);
  }
}

console.log('no stray literals');
// The point of the token layer: a bare hex outside the token blocks is a colour
// that can only be right in one theme. Scan from the end of the alias block —
// everything above it IS the token definitions — and strip comments, which
// legitimately quote hex values when explaining a choice.
const tokenBlocksEnd = css.indexOf('/* ==================== RESET');
const afterTokens = css.slice(tokenBlocksEnd > 0 ? tokenBlocksEnd : 0)
  .replace(/\/\*[\s\S]*?\*\//g, '')                       // comments
  .replace(/var\(--[a-z0-9-]+,\s*#[0-9a-fA-F]{3,8}\)/g, ''); // legacy fallbacks
const bare = [...afterTokens.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
t('app.css has no bare hex colours after the token blocks', bare.length === 0,
  `found: ${[...new Set(bare)].join(', ')}`);

console.log(`\n${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);

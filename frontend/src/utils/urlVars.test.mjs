/* Workflow variables must survive URL capture.
   A workflow parameterised on {{targetUrl}} has to store the VARIABLE in its
   navigation and pagination steps — not the one sample value the preview
   happened to load — or running it with a different input scrapes the wrong
   site. These cover the substitution both ways, plus picking the workflow step
   that actually navigated to the current page.

   Run (from frontend/):  npm test  */

import { unresolveVars, rawUrlForCurrentPage } from './urlVars.js';
const VAR_RX = /\{\{\s*([^.[\]{}]+(?:\.[^.[\]{}]+)*)\s*\}\}/g;
const resolve = (s, vars) => typeof s === 'string' && s.includes('{{')
  ? s.replace(VAR_RX, (f, p) => { const v = (vars||[]).find(x => x.name === p.trim()); return v ? String(v.value) : f; })
  : s;
const vars = [{ name: 'targetUrl', value: 'https://lock.me/pl/.../reviews' }, { name: 'lang', value: 'pl' }];
let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${got}\n      want ${want}`}`);
};
t('captured url is re-parameterised',
  unresolveVars('https://lock.me/pl/.../reviews?page=2', vars), '{{targetUrl}}?page=2');
t('already-parameterised url is left alone',
  unresolveVars('{{targetUrl}}?page=2', vars), '{{targetUrl}}?page=2');
t('unrelated url untouched',
  unresolveVars('https://other.com/x', vars), 'https://other.com/x');
t('longest value wins over a prefix',
  unresolveVars('https://lock.me/pl/.../reviews', [{name:'host',value:'https://lock.me'},{name:'targetUrl',value:'https://lock.me/pl/.../reviews'}]),
  '{{targetUrl}}');
t('short values ignored (would corrupt urls)',
  unresolveVars('https://a.com/pl/x', [{ name: 'l', value: 'pl' }]), 'https://a.com/pl/x');
// Base url resolution: prefers the workflow step that navigated here.
const steps = [
  { type: 'NAVIGATE', params: { url: '{{targetUrl}}' } },
  { type: 'CLICK', params: {} },
  { type: 'NAVIGATE', params: { url: 'https://lock.me/pl/.../reviews' } },
];
t('uses the workflow step that navigated to this page',
  rawUrlForCurrentPage(steps.slice(0,1), 'https://lock.me/pl/.../reviews', vars, resolve), '{{targetUrl}}');
t('trailing slash / hash differences still match',
  rawUrlForCurrentPage(steps.slice(0,1), 'https://lock.me/pl/.../reviews/#comments', vars, resolve), '{{targetUrl}}');
t('a later navigation wins over the start url',
  rawUrlForCurrentPage(
    [{ type:'NAVIGATE', params:{url:'{{targetUrl}}'} }, { type:'NAVIGATE', params:{url:'https://lock.me/other'} }],
    'https://lock.me/other', vars, resolve), 'https://lock.me/other');
t('nested NAVIGATE inside a loop body is found',
  rawUrlForCurrentPage([{ type:'FOR_EACH', body:[{ type:'NAVIGATE', params:{url:'{{targetUrl}}'} }] }],
    'https://lock.me/pl/.../reviews', vars, resolve), '{{targetUrl}}');
t('no matching step → falls back to re-parameterising',
  rawUrlForCurrentPage([], 'https://lock.me/pl/.../reviews?page=5', vars, resolve), '{{targetUrl}}?page=5');
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

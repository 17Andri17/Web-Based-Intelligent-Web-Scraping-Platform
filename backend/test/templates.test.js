'use strict';

/* Every shipped template must be a workflow the platform can actually run.

   A template is the first thing a new user touches, so a broken one is worse
   than no gallery at all. These assert the three ways one could rot:
     • the envelope stops matching the import format,
     • a step loses the id/kind/type shape the editor and codegen expect,
     • the code generator can no longer turn it into a runnable script.

   Run:  node test/templates.test.js  */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const templates = require('../services/templates.service');
const portable = require('../utils/workflowPortable');
const { generateCode } = require('../workflow/workflowCodegen');

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      ${detail || ''}`}`);
};

const BRANCHES = ['body', 'then', 'else', 'try', 'catch'];

function badSteps(steps, trail = '') {
  const problems = [];
  (steps || []).forEach((s, i) => {
    const at = `${trail}[${i}]`;
    if (!s || typeof s !== 'object') { problems.push(`${at} is not an object`); return; }
    if (!s.id) problems.push(`${at} has no id`);
    if (s.kind !== 'action' && s.kind !== 'control') problems.push(`${at} has kind "${s.kind}"`);
    if (!s.type) problems.push(`${at} has no type`);
    if (s.kind === 'control' && !BRANCHES.some(b => Array.isArray(s[b]))) {
      problems.push(`${at} is a control with no branch array`);
    }
    for (const b of BRANCHES) {
      if (Array.isArray(s[b])) problems.push(...badSteps(s[b], `${at}.${b}`));
    }
  });
  return problems;
}

const list = templates.list();

console.log('catalogue');
t('ships at least one template', list.length > 0);
t('every entry has the fields the gallery renders',
  list.every(x => x.id && x.name && x.category && x.icon && x.summary && Array.isArray(x.setup)),
  JSON.stringify(list.find(x => !(x.id && x.name && x.category && x.icon && x.summary && Array.isArray(x.setup)))));
t('ids are unique', new Set(list.map(x => x.id)).size === list.length);
t('every template tells the user what to fill in', list.every(x => x.setup.length > 0));
t('list() carries no step payloads', list.every(x => x.steps === undefined));

console.log('envelopes');
for (const meta of list) {
  const env = templates.buildEnvelope(meta.id);
  const v = portable.validateEnvelope(env);
  t(`${meta.id}: imports as a valid envelope`, v.ok, v.error);
  const problems = badSteps(env.steps);
  t(`${meta.id}: every step is well-formed`, problems.length === 0, problems.join('; '));
  t(`${meta.id}: stepCount matches the built steps`,
    meta.stepCount === templates.countSteps(env.steps));
  t(`${meta.id}: starts on a pinned NAVIGATE`,
    env.steps[0] && env.steps[0].type === 'NAVIGATE' && env.steps[0].pinned === true);
}

console.log('freshness');
{
  const a = templates.buildEnvelope(list[0].id);
  const b = templates.buildEnvelope(list[0].id);
  // Two workflows made from one template must not share step ids, or editing
  // one would follow the other around the editor.
  t('each use gets its own step ids', a.steps[0].id !== b.steps[0].id);
}
t('an unknown id returns null, not a throw', templates.buildEnvelope('nope-not-real') === null);

console.log('code generation');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-test-'));
  try {
    for (const meta of list) {
      const env = templates.buildEnvelope(meta.id);
      let src = null, err = null;
      try {
        const out = generateCode(env.steps, { variables: env.meta.variables || [] });
        src = typeof out === 'string' ? out : out && out.code;
      } catch (e) { err = e.message; }
      if (!src) { t(`${meta.id}: generates a script`, false, err); continue; }
      // The script opens with a shebang, so syntax-check it as a real file
      // rather than through new Function().
      const file = path.join(dir, `${meta.id}.js`);
      fs.writeFileSync(file, src);
      const r = cp.spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      t(`${meta.id}: generates syntactically valid Node`, r.status === 0,
        (r.stderr || '').split('\n').slice(0, 3).join(' | '));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);

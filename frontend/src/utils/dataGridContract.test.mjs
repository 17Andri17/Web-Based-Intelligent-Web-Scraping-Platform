/* The client half of the shared grid contract.

   The grid filters and sorts in the browser under ~2,000 rows and on the
   server above it, and a scrape must not change its story when it crosses
   that line. shared/datagrid-vectors.json is the agreement; this asserts the
   client still honours it, and backend/test/dataset-view.test.js asserts the
   server does.

   A deliberate behaviour change means regenerating the fixture and updating
   BOTH suites — which is the point. Failing here is the signal that the
   server needs the same edit.

   Run (from frontend/):  npm test  */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildColumns, buildView } from './dataGrid.js';
import { profileColumns, findIssues } from './columnProfile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vec = JSON.parse(
  fs.readFileSync(path.join(here, '..', '..', '..', 'shared', 'datagrid-vectors.json'), 'utf8')
);

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

const rows = vec.rows;
const titles = (list) => list.map(x => String(x.title).trim());

t('columns match the contract', buildColumns(rows), vec.columns);

const profiles = profileColumns(rows, vec.columns);
for (const id of vec.columns) {
  t(`profile matches — ${id}`, profiles[id], vec.profiles[id]);
}

t('issue roll-up matches the contract', findIssues(rows, vec.columns, profiles), vec.issues);

for (const c of vec.filterCases) {
  t(`filter — ${c.name}`,
    titles(buildView(rows, { filters: c.filters, query: c.query || '', types: vec.types })),
    c.expect);
}

for (const c of vec.sortCases) {
  t(`sort — ${c.name}`,
    titles(buildView(rows, { sorts: c.sorts, types: vec.types })),
    c.expect);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

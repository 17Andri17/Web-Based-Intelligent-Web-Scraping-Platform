/* Saved table layouts: what survives, what deliberately doesn't, and what
   happens when the stored blob is rubbish.

   The sanitising matters more than it looks. localStorage is user-writable
   and may hold something an older version of this file wrote, so a bad
   value has to degrade to the default rather than to a broken table.

   Run (from frontend/):  npm test  */

// gridPrefs talks to localStorage; give it one before importing.
class MemoryStorage {
  constructor() { this.map = new Map(); this.failNextWrite = false; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error('QuotaExceededError'); }
    this.map.set(k, String(v));
  }
  removeItem(k) { this.map.delete(k); }
  keys() { return [...this.map.keys()]; }
}
const store = new MemoryStorage();
globalThis.localStorage = store;

const { loadGridView, saveGridView, clearGridView } = await import('./gridPrefs.js');

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

const VIEW = {
  order: ['price', 'title', 'sku'],
  hidden: { notes: true },
  density: 'roomy',
  pageSize: 250,
  sorts: [{ id: 'price', dir: 'desc' }],
};

// ── round trip ──────────────────────────────────────────────────────────────
saveGridView('wf:1:products', VIEW);
t('a layout survives a round trip', loadGridView('wf:1:products'), VIEW);
t('an unknown key has no layout', loadGridView('wf:9:nothing'), null);
t('layouts are scoped by key', loadGridView('wf:2:products'), null);

clearGridView('wf:1:products');
t('cleared means gone', loadGridView('wf:1:products'), null);
t('a missing key is a no-op, not a throw', (() => { clearGridView(null); return true; })(), true);
t('no key means no read', loadGridView(''), null);

// ── what is NOT saved ───────────────────────────────────────────────────────
/* Filters, the search box and the issue chips must never come back on their
   own: they change which rows EXIST, and a table that silently opens showing
   nine of four thousand rows is a support ticket. */
saveGridView('wf:3:p', { ...VIEW, filters: { price: '>100' }, query: 'desk', focusIssue: 'incomplete' });
const restored = loadGridView('wf:3:p');
t('filters are not persisted',   restored.filters, undefined);
t('the search box is not persisted', restored.query, undefined);
t('an issue chip is not persisted',  restored.focusIssue, undefined);
t('but the arrangement is',      restored.order, VIEW.order);

// ── sanitising a hostile or stale blob ──────────────────────────────────────
const write = (key, obj) => store.setItem(`ws:grid:1:${key}`, JSON.stringify(obj));

write('bad1', { density: 'enormous', pageSize: -5, order: 'not-an-array' });
t('an unknown density is dropped', loadGridView('bad1'), null);

write('bad2', { order: ['ok', 42, null, 'fine'] });
t('non-string column names are dropped', loadGridView('bad2'), { order: ['ok', 'fine'] });

write('bad3', { hidden: { a: true, b: false, c: 1 } });
t('only truthy hides are kept', loadGridView('bad3'), { hidden: { a: true, c: true } });

write('bad4', { sorts: [{ id: 'a', dir: 'sideways' }, { id: 5 }, { dir: 'asc' }] });
t('a bad sort direction falls back to ascending, junk entries go',
  loadGridView('bad4'), { sorts: [{ id: 'a', dir: 'asc' }] });

write('bad5', { pageSize: 999999 });
t('an absurd page size is dropped', loadGridView('bad5'), null);

write('bad6', { pageSize: 100.7 });
t('a fractional page size is floored', loadGridView('bad6'), { pageSize: 100 });

store.setItem('ws:grid:1:bad7', 'not json at all');
t('unparseable storage reads as no layout', loadGridView('bad7'), null);

write('bad8', [1, 2, 3]);
t('an array where an object belongs reads as no layout', loadGridView('bad8'), null);

// ── failures must stay silent ───────────────────────────────────────────────
store.failNextWrite = true;
t('a quota failure does not throw', (() => { saveGridView('wf:4:p', VIEW); return true; })(), true);
t('and simply leaves no layout', loadGridView('wf:4:p'), null);

saveGridView('wf:5:p', { garbage: true });
t('saving nothing recognisable stores nothing', loadGridView('wf:5:p'), null);

const huge = { order: Array.from({ length: 400 }, (_, i) => 'c'.repeat(400) + i) };
saveGridView('wf:6:p', huge);
t('an oversized layout is skipped rather than blowing the quota', loadGridView('wf:6:p'), null);

// ── namespacing ─────────────────────────────────────────────────────────────
saveGridView('wf:7:p', VIEW);
t('keys are namespaced and versioned',
  store.keys().some(k => k === 'ws:grid:1:wf:7:p'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

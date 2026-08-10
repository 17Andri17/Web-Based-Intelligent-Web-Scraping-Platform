/* Unsaved work must survive a refresh — and the guided tour must never leave
   a scraper behind in the user's drafts.

   These cover the three storage slots, the per-user scoping (a shared browser
   must not hand one account's in-progress scraper to the next person), the
   staleness/size guards, and the "tour writes to its own slot" separation
   that keeps the DemoMart practice workflow out of the draft.

   Run (from frontend/):  npm test  */

// draftStore talks to localStorage; give it one before importing.
class MemoryStorage {
  constructor() { this.map = new Map(); this.failNextWrite = false; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    if (this.failNextWrite) { this.failNextWrite = false; const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
    this.map.set(k, String(v));
  }
  removeItem(k) { this.map.delete(k); }
  get size() { return this.map.size; }
  keys() { return [...this.map.keys()]; }
}
const store = new MemoryStorage();
globalThis.localStorage = store;
// draftStore warns on quota/oversize; keep the test output readable.
const realWarn = console.warn;
console.warn = () => {};

const {
  saveDraft, loadDraft, clearDraft,
  saveTourProgress, loadTourProgress, clearTourProgress,
  loadTourPrefs, saveTourPrefs,
} = await import('./draftStore.js');

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

const steps = [{ id: 'a', type: 'NAVIGATE', pinned: true, params: { url: 'https://x.test' } }];
const draft = {
  steps,
  variables: [{ name: 'url', value: 'https://x.test' }],
  meta: { startUrl: 'https://x.test' },
  workflowId: null,
  workflowName: 'Untitled draft',
  perfSettings: {},
  proxy: null,
  url: 'https://x.test',
  savedSignature: null,
};

console.log('draft round-trip');
saveDraft('ada', draft);
t('restores the step tree', loadDraft('ada').steps, steps);
t('restores the variables', loadDraft('ada').variables, draft.variables);
t('restores the save baseline', loadDraft('ada').savedSignature, null);
t('stamps a timestamp', typeof loadDraft('ada').updatedAt, 'number');

console.log('per-user scoping');
t('another user sees no draft', loadDraft('grace'), null);
saveDraft('grace', { ...draft, workflowName: 'Grace only' });
t("ada's draft is untouched", loadDraft('ada').workflowName, 'Untitled draft');
t("grace's draft is her own", loadDraft('grace').workflowName, 'Grace only');
t('usernames with odd characters are still isolated', loadDraft('ada@x.io/../grace'), null);

console.log('emptying the editor empties the draft');
saveDraft('ada', { ...draft, steps: [] });
t('no steps → nothing stored', loadDraft('ada'), null);

console.log('transient preview data is not persisted');
const bulky = [{
  id: 'l', type: 'EXTRACT_LIST', params: {},
  previewElements: new Array(500).fill({ html: 'x'.repeat(200) }),
  body: [{ id: 'n', type: 'EXTRACT_TEXT', previewElements: [1, 2, 3] }],
}];
saveDraft('ada', { ...draft, steps: bulky });
const restored = loadDraft('ada');
t('stripped at the top level', 'previewElements' in restored.steps[0], false);
t('stripped inside branches', 'previewElements' in restored.steps[0].body[0], false);
t('the rest of the step survives', restored.steps[0].type, 'EXTRACT_LIST');

console.log('robustness');
clearDraft('ada');
t('cleared', loadDraft('ada'), null);
store.map.set('ws.ada.draft.v1', '{not json');
t('corrupt entry reads as no draft', loadDraft('ada'), null);
t('…and is dropped, not left to fail again', store.getItem('ws.ada.draft.v1'), null);
store.failNextWrite = true;
t('a quota failure is survivable', saveDraft('ada', draft), false);
const huge = [{ id: 'h', type: 'X', params: { blob: 'y'.repeat(3 * 1024 * 1024) } }];
t('an oversized draft is refused, not thrown', saveDraft('ada', { ...draft, steps: huge }), false);
clearDraft('ada');
const stale = { ...draft, updatedAt: Date.now() - 15 * 24 * 60 * 60 * 1000 };
store.map.set('ws.ada.draft.v1', JSON.stringify(stale));
t('a draft older than the window is ignored', loadDraft('ada'), null);

console.log('the tour keeps to its own slot');
clearDraft('ada'); clearTourProgress('ada');
saveTourProgress('ada', { idx: 7, maxIdx: 9, total: 24, steps, variables: [] });
t('progress round-trips', loadTourProgress('ada').idx, 7);
t('frontier round-trips', loadTourProgress('ada').maxIdx, 9);
t('the demo workflow rides along', loadTourProgress('ada').steps, steps);
t('and NONE of it shows up as a draft', loadDraft('ada'), null);
saveDraft('ada', draft);
t('a real draft and tour progress coexist', [loadDraft('ada').workflowName, loadTourProgress('ada').idx], ['Untitled draft', 7]);
clearTourProgress('ada');
t('finishing the tour clears its progress', loadTourProgress('ada'), null);
t('…and leaves the draft alone', loadDraft('ada').workflowName, 'Untitled draft');

console.log('tour preferences');
t('unset prefs are all false', loadTourPrefs('zed'), { completed: false, promptDismissed: false });
saveTourPrefs('zed', { promptDismissed: true });
t('dismissal sticks', loadTourPrefs('zed'), { completed: false, promptDismissed: true });
saveTourPrefs('zed', { completed: true });
t('completion merges rather than replaces', loadTourPrefs('zed'), { completed: true, promptDismissed: true });
t('prefs are per user too', loadTourPrefs('ada'), { completed: false, promptDismissed: false });

console.warn = realWarn;
console.log(`\n${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);

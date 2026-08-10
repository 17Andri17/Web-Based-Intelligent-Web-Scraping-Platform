'use strict';

/* ===========================================================================
   Sharding
   ---------------------------------------------------------------------------
   Splitting a list across independent runs is only useful if the union of the
   shards is exactly the original list: every item scraped, none scraped twice.
   Since shards run in separate processes with no coordination, that property
   has to come from the assignment function alone — which is what these tests
   pin down.

   Assignment hashes the item's URL rather than using its position, so it is
   also stable when the list shifts: an item added upstream must not push
   everything after it into a different shard (which on a resumed shard would
   mean re-scraping work that was already done).
   ========================================================================= */

const assert = require('assert');
const vm = require('vm');
const { buildCodegenPoolHelper } = require('../browser/pagePool');

const fs = require('fs');
const os = require('os');
const path = require('path');

// Drives the REAL initialisation path: the platform writes a sidecar, the
// generated script reads WS_RESUME_FILE and builds __SHARD from it. Stubbing
// __inShard directly would test a function no run actually calls.
let boxSeq = 0;
const tempFiles = [];
function shardBox(shard) {
  let file = null;
  if (shard) {
    file = path.join(os.tmpdir(), `ws_shard_test_${process.pid}_${boxSeq++}.json`);
    fs.writeFileSync(file, JSON.stringify({ steps: {}, shard }), 'utf8');
    tempFiles.push(file);
  }
  const box = {
    require, JSON, Object, Array, Promise, Set, Math, String, Number, Date, setTimeout, clearTimeout,
    AbortController, fetch: undefined,
    process: { env: file ? { WS_RESUME_FILE: file } : {} },
    console: { log: () => {}, error: () => {} },
    applyStealthToPage: async () => {}, applyResourceBlocking: async () => {},
    __checkpoint: () => {},
  };
  vm.createContext(box);
  vm.runInContext(buildCodegenPoolHelper({ instrument: true }), box);
  return box;
}

const URLS = Array.from({ length: 500 }, (_, i) => `https://shop.example/p/${i}`);

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

console.log('shard assignment');

test('the shards partition the list exactly — every item once, none twice', () => {
  for (const count of [2, 3, 4, 8]) {
    const seen = [];
    for (let index = 0; index < count; index++) {
      const box = shardBox({ index, count });
      seen.push(...URLS.filter(u => box.__inShard(u)));
    }
    assert.strictEqual(seen.length, URLS.length, `${count} shards: total item count must match`);
    assert.strictEqual(new Set(seen).size, URLS.length, `${count} shards: no item may appear twice`);
    assert.deepStrictEqual(seen.slice().sort(), URLS.slice().sort());
  }
});

test('shards are reasonably balanced', () => {
  const count = 4;
  const sizes = [];
  for (let index = 0; index < count; index++) {
    const box = shardBox({ index, count });
    sizes.push(URLS.filter(u => box.__inShard(u)).length);
  }
  const ideal = URLS.length / count;
  for (const s of sizes) {
    assert.ok(s > ideal * 0.6 && s < ideal * 1.4,
      `shard sizes ${JSON.stringify(sizes)} are too skewed for ${count} shards`);
  }
});

test('assignment is stable when the list changes (hash, not position)', () => {
  const box = shardBox({ index: 1, count: 3 });
  const before = URLS.filter(u => box.__inShard(u));
  // A new item appears at the FRONT — with index-based splitting this would
  // shift every subsequent item into a different shard.
  const grown = ['https://shop.example/p/new', ...URLS];
  const after = grown.filter(u => box.__inShard(u));
  for (const u of before) {
    assert.ok(after.includes(u), `${u} must stay in the same shard after the list grows`);
  }
});

test('assignment is deterministic across processes', () => {
  const a = shardBox({ index: 2, count: 5 });
  const b = shardBox({ index: 2, count: 5 });
  for (const u of URLS.slice(0, 50)) {
    assert.strictEqual(a.__inShard(u), b.__inShard(u), `${u} must hash identically everywhere`);
  }
});

test('no shard configured ⇒ the run takes every item', () => {
  const box = shardBox(null);
  assert.strictEqual(URLS.every(u => box.__inShard(u)), true);
});

test('downloaded scripts always take every item (sharding is platform-only)', () => {
  const src = buildCodegenPoolHelper({ instrument: false });
  assert.match(src, /function __inShard\(_url\) \{ return true; \}/);
});

test('a shard count of 1 disables sharding rather than splitting', () => {
  const box = shardBox({ index: 0, count: 1 });
  assert.strictEqual(URLS.every(u => box.__inShard(u)), true);
});

for (const f of tempFiles) { try { fs.unlinkSync(f); } catch (_) {} }

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall shard tests passed');

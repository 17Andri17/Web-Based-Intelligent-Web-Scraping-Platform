'use strict';

/* Unit tests for the pure parts of googleSheets.service: spreadsheet-id
   parsing and row shaping (header union + alignment to an existing sheet).
   The network calls (token exchange, append) are not exercised here.
   Run: node test/google-sheets.test.js  (from backend/) */

const assert = require('assert');
const gs = require('../services/googleSheets.service');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('parseSpreadsheetId');
test('extracts id from a full edit URL', () => {
  assert.equal(gs.parseSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC-dEf_123/edit#gid=0'), '1AbC-dEf_123');
});
test('extracts id from a URL without a fragment', () => {
  assert.equal(gs.parseSpreadsheetId('https://docs.google.com/spreadsheets/d/ABC123'), 'ABC123');
});
test('accepts a bare id', () => {
  assert.equal(gs.parseSpreadsheetId('1AbC-dEf_123'), '1AbC-dEf_123');
});
test('rejects junk / a random URL', () => {
  assert.equal(gs.parseSpreadsheetId('https://example.com/foo'), null);
  assert.equal(gs.parseSpreadsheetId('not an id/slash'), null);
  assert.equal(gs.parseSpreadsheetId(''), null);
  assert.equal(gs.parseSpreadsheetId(null), null);
});

console.log('buildRows — empty sheet (write headers)');
test('derives union headers and writes them when the sheet is empty', () => {
  const results = { products: [
    { name: 'A', price: '1' },
    { name: 'B', price: '2', stock: '5' },   // 'stock' absent from row 0
  ]};
  const { headers, writeHeaders, dataRows } = gs.buildRows(results, { output: 'products' }, []);
  assert.deepEqual(headers, ['name', 'price', 'stock']);   // union, not row-0
  assert.equal(writeHeaders, true);
  assert.deepEqual(dataRows[0], ['A', '1', '']);           // missing stock → blank
  assert.deepEqual(dataRows[1], ['B', '2', '5']);
});
test('object/array cells become JSON; nulls become blank', () => {
  const results = { r: [{ name: 'A', tags: ['x', 'y'], meta: { k: 1 }, note: null }] };
  const { dataRows } = gs.buildRows(results, { output: 'r' }, []);
  assert.deepEqual(dataRows[0], ['A', '["x","y"]', '{"k":1}', '']);
});
test('scalar list → single value column', () => {
  const { headers, writeHeaders, dataRows } = gs.buildRows({ r: ['a', 'b'] }, { output: 'r' }, []);
  assert.deepEqual(headers, ['value']);
  assert.equal(writeHeaders, true);
  assert.deepEqual(dataRows, [['a'], ['b']]);
});

console.log('buildRows — existing sheet (align, no header)');
test('aligns rows to the sheet\'s existing header order and never re-writes headers', () => {
  const results = { products: [{ price: '9', name: 'Z', extra: 'ignored' }] };
  const existing = ['name', 'price', 'stock'];
  const { headers, writeHeaders, dataRows } = gs.buildRows(results, { output: 'products' }, existing);
  assert.deepEqual(headers, existing);
  assert.equal(writeHeaders, false);
  // aligned to existing order; unknown 'extra' dropped; missing 'stock' blank
  assert.deepEqual(dataRows[0], ['Z', '9', '']);
});

console.log('buildRows — edges');
test('missing output → no rows', () => {
  const { dataRows, writeHeaders } = gs.buildRows({}, { output: 'nope' }, []);
  assert.deepEqual(dataRows, []);
  assert.equal(writeHeaders, false);
});
test('empty list on an empty sheet → no header written', () => {
  const { writeHeaders, dataRows } = gs.buildRows({ r: [] }, { output: 'r' }, []);
  assert.equal(writeHeaders, false);
  assert.deepEqual(dataRows, []);
});

console.log('service account (env-driven)');
test('not configured when env unset', () => {
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  gs._resetCache();
  assert.equal(gs.isConfigured(), false);
  assert.equal(gs.getServiceAccountEmail(), null);
});
test('reads inline JSON and exposes the client e-mail', () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'svc@p.iam.gserviceaccount.com', private_key: 'x' });
  gs._resetCache();
  assert.equal(gs.isConfigured(), true);
  assert.equal(gs.getServiceAccountEmail(), 'svc@p.iam.gserviceaccount.com');
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  gs._resetCache();
});

console.log(`\n${passed} assertions passed`);

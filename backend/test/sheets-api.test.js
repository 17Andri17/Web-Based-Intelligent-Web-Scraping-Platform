'use strict';

/* /api/workflows/:id/sheet (Google Sheets delivery config) route tests —
   boots the real app against a throwaway SQLite DB. Exercises config CRUD,
   URL/ID parsing, the service-account status field, and ownership scoping.
   The actual Google append is not called (no run is executed here).
   Run: node test/sheets-api.test.js  (from backend/) */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sheets-api-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT;
// A service account so the status field reports "configured".
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'svc@proj.iam.gserviceaccount.com', private_key: 'x' });

const http = require('http');
const db = require('../db/client');
const app = require('../app');
const workflowsRepo = require('../db/repositories/workflows.repo');
const runStore = require('../services/runStore.service');
const { signToken } = require('../middleware/auth');

let BASE;
let passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); process.exitCode = 1; throw new Error(`FAILED: ${name}`); }
}

async function req(method, pathname, { token, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json };
}

async function main() {
  await db.init();
  await require('../db/migrate').run(db);
  const user  = await db.get(`INSERT INTO users (username, password_hash) VALUES ('sh', 'x') RETURNING id`);
  const other = await db.get(`INSERT INTO users (username, password_hash) VALUES ('shother', 'x') RETURNING id`);
  const token = signToken({ sub: user.id, username: 'sh' });
  const otherToken = signToken({ sub: other.id, username: 'shother' });
  const wf = await workflowsRepo.create({ userId: user.id, name: 'Prices', stepsJson: '[]', metaJson: null });

  console.log('status + empty');
  {
    const r = await req('GET', `/api/workflows/${wf.id}/sheet`, { token });
    ok('no config yet → null', r.status === 200 && r.json.sheet === null);
    ok('reports service account configured + email', r.json.serviceAccount.configured === true
      && r.json.serviceAccount.email === 'svc@proj.iam.gserviceaccount.com');
  }

  console.log('validation');
  {
    const bad = await req('PUT', `/api/workflows/${wf.id}/sheet`, { token, body: { spreadsheet: 'https://example.com/nope' } });
    ok('invalid sheet link → 400', bad.status === 400);
    const foreign = await req('PUT', `/api/workflows/${wf.id}/sheet`, { token: otherToken, body: { spreadsheet: 'ABC123' } });
    ok('another user cannot configure it → 404', foreign.status === 404);
  }

  console.log('create + parse + read back');
  {
    const put = await req('PUT', `/api/workflows/${wf.id}/sheet`, { token, body: {
      spreadsheet: 'https://docs.google.com/spreadsheets/d/SHEET_ID_123/edit#gid=0',
      sheetName: 'Runs', outputKey: 'products', isActive: true,
    }});
    ok('PUT → 200 with parsed id', put.status === 200 && put.json.sheet.spreadsheetId === 'SHEET_ID_123');
    ok('tab + output stored', put.json.sheet.sheetName === 'Runs' && put.json.sheet.outputKey === 'products');
    ok('active', put.json.sheet.isActive === true);

    const get = await req('GET', `/api/workflows/${wf.id}/sheet`, { token });
    ok('config reads back', get.json.sheet.spreadsheetId === 'SHEET_ID_123');

    // bare id also accepted; tab defaults to Sheet1 when omitted
    const put2 = await req('PUT', `/api/workflows/${wf.id}/sheet`, { token, body: { spreadsheet: 'BARE_ID_456' } });
    ok('bare id accepted, tab defaults to Sheet1', put2.json.sheet.spreadsheetId === 'BARE_ID_456' && put2.json.sheet.sheetName === 'Sheet1');
  }

  console.log('pipeline lookup (getSheetByWorkflow)');
  {
    const row = await runStore.getSheetByWorkflow(wf.id);
    ok('config found by workflow id for the pipeline', row && row.spreadsheet_id === 'BARE_ID_456' && row.is_active === 1);
  }

  console.log('disable + delete + scoping');
  {
    const off = await req('PUT', `/api/workflows/${wf.id}/sheet`, { token, body: { spreadsheet: 'BARE_ID_456', isActive: false } });
    ok('can disable', off.json.sheet.isActive === false);

    const foreignDel = await req('DELETE', `/api/workflows/${wf.id}/sheet`, { token: otherToken });
    ok('another user cannot delete → 404', foreignDel.status === 404);

    const del = await req('DELETE', `/api/workflows/${wf.id}/sheet`, { token });
    ok('owner deletes → ok', del.status === 200 && del.json.ok === true);
    const gone = await req('DELETE', `/api/workflows/${wf.id}/sheet`, { token });
    ok('delete again → 404', gone.status === 404);
  }

  console.log(`\n${passed} checks passed ✅`);
}

const server = http.createServer(app);
server.listen(0, '127.0.0.1', async () => {
  BASE = `http://127.0.0.1:${server.address().port}`;
  try { await main(); }
  catch (e) { console.error(e); process.exitCode = 1; }
  finally { server.close(); try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} }
});

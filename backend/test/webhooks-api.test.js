'use strict';

/* Internal /api/webhooks (dashboard, JWT) route tests — boots the real app
   against a throwaway SQLite DB.
   Run: node test/webhooks-api.test.js  (from backend/) */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'webhooks-api-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT;

const http = require('http');
const db = require('../db/client');
const app = require('../app');
const { signToken } = require('../middleware/auth');
const { WEBHOOK_EVENTS } = require('../services/webhookEvents');

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
  const user  = await db.get(`INSERT INTO users (username, password_hash) VALUES ('wh', 'x') RETURNING id`);
  const other = await db.get(`INSERT INTO users (username, password_hash) VALUES ('whother', 'x') RETURNING id`);
  const token = signToken({ sub: user.id, username: 'wh' });
  const otherToken = signToken({ sub: other.id, username: 'whother' });

  console.log('event catalogue');
  {
    const r = await req('GET', '/api/webhooks/events', { token });
    ok('lists all events incl run.changed', r.status === 200
      && r.json.events.map(e => e.event).join(',') === WEBHOOK_EVENTS.join(','));
    ok('events carry descriptions', r.json.events.every(e => typeof e.label === 'string' && e.label));
  }

  console.log('validation');
  {
    const noAuth = await req('POST', '/api/webhooks', { body: { url: 'https://x.com' } });
    ok('requires auth → 401', noAuth.status === 401);
    let r = await req('POST', '/api/webhooks', { token, body: { url: 'not a url' } });
    ok('invalid url → 400', r.status === 400);
    r = await req('POST', '/api/webhooks', { token, body: { url: 'ftp://x.com' } });
    ok('non-http scheme → 400', r.status === 400);
    r = await req('POST', '/api/webhooks', { token, body: { url: 'https://x.com/hook', events: ['run.exploded'] } });
    ok('unknown event → 400', r.status === 400);
    r = await req('POST', '/api/webhooks', { token, body: { url: 'https://x.com/hook', events: [] } });
    ok('empty events → 400', r.status === 400);
  }

  let createdId;
  console.log('create + list');
  {
    const r = await req('POST', '/api/webhooks', { token, body: { url: 'https://example.com/hook', events: ['run.changed'] } });
    ok('create → 201 + secret shown once', r.status === 201 && r.json.webhook.secret.startsWith('whsec_'));
    ok('subscribed to the chosen event', r.json.webhook.events.join(',') === 'run.changed');
    createdId = r.json.webhook.id;

    const list = await req('GET', '/api/webhooks', { token });
    ok('list returns the endpoint', list.status === 200 && list.json.webhooks.length === 1);
    ok('list hides the secret', !('secret' in list.json.webhooks[0]));

    // defaults to all events when omitted
    const r2 = await req('POST', '/api/webhooks', { token, body: { url: 'https://example.com/all' } });
    ok('omitted events → all events', r2.json.webhook.events.join(',') === WEBHOOK_EVENTS.join(','));
  }

  console.log('scoping + delete');
  {
    const foreignList = await req('GET', '/api/webhooks', { token: otherToken });
    ok('another user sees none of them', foreignList.json.webhooks.length === 0);
    const foreignDel = await req('DELETE', `/api/webhooks/${createdId}`, { token: otherToken });
    ok('another user cannot delete → 404', foreignDel.status === 404);

    const del = await req('DELETE', `/api/webhooks/${createdId}`, { token });
    ok('owner deletes → ok', del.status === 200 && del.json.ok === true);
    const gone = await req('DELETE', `/api/webhooks/${createdId}`, { token });
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

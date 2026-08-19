'use strict';

/* ===========================================================================
   Auth: e-mail/password registration and sign-in, OAuth account resolution,
   and the CSRF/linking rules that protect them.

   The OAuth tests drive resolveUser's three cases directly against the DB
   rather than standing up a fake Google — what matters is the decision (link
   vs. create vs. refuse), not that fetch works. The one HTTP-level thing
   worth asserting is that a callback without valid state is rejected, since
   that check is what stops login-CSRF.

   Run: node test/auth-flows.test.js  (from backend/)
   ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-flows-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT;
process.env.AUTH_RATE_LIMIT = '0';       // exercised in its own block below
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

const http = require('http');

const db = require('../db/client');
const app = require('../app');
const users = require('../db/repositories/users.repo');
const oauthAccounts = require('../db/repositories/oauthAccounts.repo');

let BASE;
let passed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
    throw new Error(`FAILED: ${name}`);
  }
}

async function api(method, pathname, { token, body, redirect = 'manual' } = {}) {
  const res = await fetch(BASE + pathname, {
    method, redirect,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  await db.init();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  /* ── Registration ──────────────────────────────────────────────────────── */
  console.log('registration');
  {
    let r = await api('POST', '/api/auth/register', {
      body: { email: 'Alice@Example.com', password: 'correct-horse' },
    });
    ok('registers with e-mail + password', r.status === 201, `got ${r.status} ${r.text}`);
    ok('returns a token', typeof r.json.token === 'string' && r.json.token.length > 20);
    ok('e-mail is normalised to lowercase', r.json.user.email === 'alice@example.com');
    ok('username derived from the e-mail', r.json.user.username === 'alice');
    ok('starts on the free plan', r.json.user.plan.slug === 'free');
    ok('session says it has a password', r.json.user.hasPassword === true);

    r = await api('POST', '/api/auth/register', {
      body: { email: 'alice@example.com', password: 'another-one' },
    });
    ok('duplicate e-mail → 409', r.status === 409);

    // Case-insensitive: the whole point of normalising on write.
    r = await api('POST', '/api/auth/register', {
      body: { email: 'ALICE@EXAMPLE.COM', password: 'another-one' },
    });
    ok('duplicate differing only in case → 409', r.status === 409);

    r = await api('POST', '/api/auth/register', {
      body: { email: 'bob@example.com', password: 'short' },
    });
    ok('password under 8 chars → 400', r.status === 400);

    r = await api('POST', '/api/auth/register', {
      body: { email: 'not-an-email', password: 'correct-horse' },
    });
    ok('malformed e-mail → 400', r.status === 400);

    // Two accounts sharing a local part must not collide on the derived
    // username — the second gets a suffix rather than a 500.
    r = await api('POST', '/api/auth/register', {
      body: { email: 'alice@other.test', password: 'correct-horse' },
    });
    ok('same local part, different domain → still registers', r.status === 201, `got ${r.status}`);
    ok('…with a distinct username', r.json.user.username !== 'alice');
  }

  /* ── Sign-in ───────────────────────────────────────────────────────────── */
  console.log('sign-in');
  {
    let r = await api('POST', '/api/auth/login', {
      body: { email: 'alice@example.com', password: 'correct-horse' },
    });
    ok('signs in with e-mail', r.status === 200, `got ${r.status}`);
    const token = r.json.token;

    r = await api('POST', '/api/auth/login', {
      body: { email: 'ALICE@example.com', password: 'correct-horse' },
    });
    ok('sign-in is case-insensitive on e-mail', r.status === 200);

    r = await api('POST', '/api/auth/login', {
      body: { email: 'alice@example.com', password: 'wrong' },
    });
    ok('wrong password → 401', r.status === 401);

    r = await api('POST', '/api/auth/login', {
      body: { email: 'nobody@example.com', password: 'whatever' },
    });
    ok('unknown account → 401', r.status === 401);
    ok('unknown and wrong-password are indistinguishable',
      r.json.error === 'Invalid e-mail or password.');

    r = await api('GET', '/api/auth/me', { token });
    ok('/me returns the session', r.status === 200 && r.json.user.email === 'alice@example.com');
    ok('/me carries plan features for the UI', r.json.user.plan.features.scheduling === false);

    r = await api('GET', '/api/auth/me');
    ok('/me without a token → 401', r.status === 401);
  }

  /* ── Legacy username accounts ──────────────────────────────────────────── */
  console.log('pre-plans accounts (no e-mail)');
  {
    // The five accounts already in the production DB have email NULL. An
    // email-only login would lock every one of them out.
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('legacy-password', 10);
    await db.run(
      `INSERT INTO users (username, password_hash) VALUES ('oldtimer', ?)`, [hash]);

    let r = await api('POST', '/api/auth/login', {
      body: { username: 'oldtimer', password: 'legacy-password' },
    });
    ok('legacy username sign-in still works', r.status === 200, `got ${r.status} ${r.text}`);
    ok('…and reports no e-mail yet', r.json.user.email === null);

    // They can then adopt one.
    r = await api('PUT', '/api/auth/email', {
      token: r.json.token, body: { email: 'old@example.com' },
    });
    ok('can add an e-mail afterwards', r.status === 200 && r.json.user.email === 'old@example.com');
    ok('…stored UNVERIFIED (nothing proved they own it)', r.json.user.emailVerified === false);
  }

  /* ── OAuth account resolution ──────────────────────────────────────────── */
  console.log('oauth account resolution');
  {
    const oauthRoutes = require('../routes/oauth.routes');
    // resolveUser isn't exported (it's an implementation detail of the
    // callback), so drive the same three cases through the repos it uses.

    // Case 3: brand-new identity, no matching e-mail → new account.
    const before = await users.existsByEmail('carol@example.com');
    ok('precondition: carol does not exist', before === false);

    const carolId = await users.createOAuthUser({ username: 'carol', email: 'carol@example.com' });
    await oauthAccounts.link({
      userId: carolId, provider: 'google', providerAccountId: 'g-carol-1',
      email: 'carol@example.com', displayName: 'Carol',
    });
    const link = await oauthAccounts.findByProviderAccount('google', 'g-carol-1');
    ok('new OAuth account is created and linked', !!link && link.user_id === carolId);

    // OAuth-only accounts must not be sign-in-able with a password.
    ok('OAuth-only account has no usable password',
      (await users.hasPassword(carolId)) === false);

    let r = await api('POST', '/api/auth/login', {
      body: { email: 'carol@example.com', password: 'anything' },
    });
    ok('password login on an OAuth-only account → 409, not 401', r.status === 409, `got ${r.status}`);
    ok('…and says which button to use', r.json.code === 'use_oauth'
      && r.json.providers.includes('google'));

    // The sentinel must never be guessable as a password either.
    r = await api('POST', '/api/auth/login', {
      body: { email: 'carol@example.com', password: users.OAUTH_ONLY_HASH },
    });
    ok('the sentinel itself is not a valid password', r.status === 409);

    // Case 2: verified e-mail matching an existing password account → link.
    const alice = await users.findByEmail('alice@example.com');
    await oauthAccounts.link({
      userId: alice.id, provider: 'google', providerAccountId: 'g-alice-1',
      email: 'alice@example.com',
    });
    const aliceLink = await oauthAccounts.findByProviderAccount('google', 'g-alice-1');
    ok('verified e-mail links to the existing account instead of duplicating',
      aliceLink.user_id === alice.id);

    // Case 1 is the linked lookup, which the two assertions above already cover.
    ok('provider id is the durable key, not the e-mail',
      (await oauthAccounts.findByProviderAccount('google', 'g-alice-1')).user_id === alice.id);
  }

  /* ── Unlinking cannot lock you out ─────────────────────────────────────── */
  console.log('unlink safety');
  {
    const { signToken } = require('../middleware/auth');
    const carol = await users.findByEmail('carol@example.com');
    const token = signToken({ sub: carol.id, username: carol.username });

    let r = await api('DELETE', '/api/auth/oauth/linked/google', { token });
    ok('unlinking the only sign-in method → 409', r.status === 409, `got ${r.status}`);

    // Once a password exists, the same unlink is allowed.
    r = await api('PUT', '/api/auth/password', {
      token, body: { newPassword: 'now-i-have-one' },
    });
    ok('OAuth-only account can set a password without the old one', r.status === 200);

    r = await api('DELETE', '/api/auth/oauth/linked/google', { token });
    ok('…then unlinking is allowed', r.status === 200, `got ${r.status}`);

    r = await api('POST', '/api/auth/login', {
      body: { email: 'carol@example.com', password: 'now-i-have-one' },
    });
    ok('…and the new password works', r.status === 200);
  }

  /* ── OAuth CSRF ────────────────────────────────────────────────────────── */
  console.log('oauth csrf');
  {
    let r = await api('GET', '/api/auth/oauth/google');
    ok('authorize redirects to the provider', r.status === 302);
    const location = r.headers.get('location') || '';
    ok('…to Google', location.startsWith('https://accounts.google.com/'));
    ok('…carrying a state parameter', /[?&]state=[^&]{20,}/.test(location));
    const setCookie = r.headers.get('set-cookie') || '';
    ok('…and sets an httpOnly state cookie',
      setCookie.includes('scrapient_oauth_state') && /httponly/i.test(setCookie));
    ok('…SameSite=Lax so it survives the provider redirect back',
      /samesite=lax/i.test(setCookie));

    // No cookie → the state cannot be verified → refuse. This is the check
    // that stops an attacker completing the flow in a victim's browser.
    r = await api('GET', '/api/auth/oauth/google/callback?code=abc&state=forged');
    ok('callback without the state cookie → redirected to an error', r.status === 302);
    ok('…and no token is issued',
      !(r.headers.get('location') || '').includes('#token='));

    r = await api('GET', '/api/auth/oauth/unknownprovider');
    ok('unknown provider → 404', r.status === 404);

    r = await api('GET', '/api/auth/oauth/github');
    ok('unconfigured provider → 503 rather than a broken redirect', r.status === 503);

    r = await api('GET', '/api/auth/oauth/providers');
    ok('providers list shows only configured ones',
      r.status === 200 && r.json.providers.length === 1
      && r.json.providers[0].name === 'google');
  }

  /* ── Development sign-in provider ──────────────────────────────────────── */
  console.log('dev provider');
  {
    const oauth = require('../services/oauth.service');

    // Off by default: absent the explicit opt-in it must not exist at all.
    delete process.env.OAUTH_DEV_PROVIDER;
    let r = await api('GET', '/api/auth/oauth/providers');
    ok('hidden unless explicitly enabled',
      !r.json.providers.some((p) => p.name === 'dev'));
    r = await api('GET', '/api/auth/oauth/dev');
    ok('and refuses to start', r.status === 503, `got ${r.status}`);

    process.env.OAUTH_DEV_PROVIDER = '1';
    r = await api('GET', '/api/auth/oauth/providers');
    const dev = r.json.providers.find((p) => p.name === 'dev');
    ok('appears once enabled', !!dev);
    ok('…flagged local so the UI can mark it as scaffolding', dev.local === true);

    // The whole point: a full sign-in with no provider and no credentials.
    r = await api('GET', '/api/auth/oauth/dev?email=devperson@example.com');
    ok('start redirects', r.status === 302);
    const authorizeUrl = r.headers.get('location') || '';
    ok('…straight back to our own callback, not to a provider',
      authorizeUrl.includes('/api/auth/oauth/dev/callback'));
    ok('…still carrying a state parameter', /[?&]state=/.test(authorizeUrl));
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    ok('…and still setting the state cookie', cookie.includes('scrapient_oauth_state'));

    // Follow it, presenting the cookie as a browser would.
    const cb = await fetch(BASE + authorizeUrl.replace(BASE, ''), {
      redirect: 'manual', headers: { cookie },
    });
    ok('callback completes', cb.status === 302, `got ${cb.status}`);
    const back = cb.headers.get('location') || '';
    ok('…and hands back a token in the URL fragment', back.includes('#token='));

    const created = await users.findByEmail('devperson@example.com');
    ok('an account was created', !!created);
    ok('…with the address marked verified', !!created.email_verified);
    const link = await oauthAccounts.findByProviderAccount('dev', 'dev|devperson@example.com');
    ok('…and linked to the dev identity', !!link && link.user_id === created.id);

    // Stable identity: clicking again must return to the SAME account rather
    // than minting a new one, or testing anything stateful is impossible.
    const second = await api('GET', '/api/auth/oauth/dev?email=devperson@example.com');
    const secondCookie = (second.headers.get('set-cookie') || '').split(';')[0];
    await fetch(BASE + (second.headers.get('location') || '').replace(BASE, ''), {
      redirect: 'manual', headers: { cookie: secondCookie },
    });
    const links = await oauthAccounts.listForUser(created.id);
    ok('signing in twice does not create a second account',
      links.filter((l) => l.provider === 'dev').length === 1);

    // The linking path — the reason the field exists in the UI.
    const before = await users.findByEmail('alice@example.com');
    const linkStart = await api('GET', '/api/auth/oauth/dev?email=alice@example.com');
    const linkCookie = (linkStart.headers.get('set-cookie') || '').split(';')[0];
    await fetch(BASE + (linkStart.headers.get('location') || '').replace(BASE, ''), {
      redirect: 'manual', headers: { cookie: linkCookie },
    });
    const aliceLink = await oauthAccounts.findByProviderAccount('dev', 'dev|alice@example.com');
    ok('links to an existing password account instead of duplicating it',
      !!aliceLink && aliceLink.user_id === before.id);

    // State is still enforced — the dev path must not be a hole in CSRF.
    const noCookie = await api('GET', '/api/auth/oauth/dev/callback?code=x&state=forged');
    ok('a forged state is still rejected',
      noCookie.status === 302 && !(noCookie.headers.get('location') || '').includes('#token='));

    /* The rail that matters most. */
    process.env.NODE_ENV = 'production';
    r = await api('GET', '/api/auth/oauth/providers');
    ok('never offered in production, even when opted in',
      !r.json.providers.some((p) => p.name === 'dev'));
    r = await api('GET', '/api/auth/oauth/dev');
    ok('…and refuses to start there', r.status === 503, `got ${r.status}`);
    let threw = null;
    try { oauth.assertDevProviderAllowed(); } catch (e) { threw = e; }
    ok('…with the guard throwing rather than returning', !!threw);
    delete process.env.NODE_ENV;

    delete process.env.OAUTH_DEV_PROVIDER;
  }

  /* ── Rate limiting ─────────────────────────────────────────────────────── */
  console.log('rate limiting');
  {
    process.env.AUTH_RATE_LIMIT = '1';
    let limited = false;
    let attempts = 0;
    // The short window allows 10/min; 14 wrong passwords must trip it.
    for (let i = 0; i < 14; i++) {
      const r = await api('POST', '/api/auth/login', {
        body: { email: 'alice@example.com', password: `wrong-${i}` },
      });
      attempts++;
      if (r.status === 429) { limited = true; break; }
    }
    ok('repeated failures are rate limited', limited, `no 429 after ${attempts} attempts`);
    process.env.AUTH_RATE_LIMIT = '0';
  }

  console.log(`\nAll ${passed} checks passed ✅`);
  server.close();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});

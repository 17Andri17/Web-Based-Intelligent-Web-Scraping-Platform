'use strict';

const express = require('express');
const oauth = require('../services/oauth.service');
const users = require('../db/repositories/users.repo');
const oauthAccounts = require('../db/repositories/oauthAccounts.repo');
const { signToken, requireAuth } = require('../middleware/auth');

/* ===========================================================================
   /api/auth/oauth — sign in with Google or GitHub.

       GET  /api/auth/oauth/providers          which providers this deploy offers
       GET  /api/auth/oauth/:provider          → 302 to the provider
       GET  /api/auth/oauth/:provider/callback → 302 back to the app with a token
       GET  /api/auth/oauth/linked             providers linked to my account
       DELETE /api/auth/oauth/linked/:provider unlink one

   The token comes back in the URL **fragment** (#token=…), not the query
   string. A fragment is never sent to a server, so the token stays out of
   access logs, out of Referer headers, and out of any proxy in between. The
   frontend reads it on load and immediately strips it from the address bar.
   ========================================================================= */

const router = express.Router();

// Where the browser lands after the flow — the APP's origin, which in
// development is the Vite server rather than this one. Always a fixed,
// configuration-derived host: an open redirect here would let an attacker
// bounce a freshly-minted token to a host they control, handing them the
// account, so nothing from the request or the provider may influence it.
function appReturnUrl(req, { token, error }) {
  const base = oauth.appBaseUrl(req);
  if (error) return `${base}/auth/callback#error=${encodeURIComponent(error)}`;
  return `${base}/auth/callback#token=${encodeURIComponent(token)}`;
}

router.get('/providers', (req, res) => {
  res.json({ providers: oauth.configuredProviders() });
});

/* ── Step 1: send the user to the provider ──────────────────────────────── */
router.get('/:provider', (req, res) => {
  const name = String(req.params.provider || '').toLowerCase();
  if (!oauth.getProvider(name)) {
    return res.status(404).json({ error: 'Unknown sign-in provider.' });
  }
  if (!oauth.isConfigured(name)) {
    return res.status(503).json({
      error: `${oauth.getProvider(name).label} sign-in is not configured on this server.`,
    });
  }
  const state = oauth.newState();
  oauth.setStateCookie(res, state, req);
  res.redirect(oauth.buildAuthorizeUrl(req, name, state));
});

/* ── Step 2: the provider sends them back ───────────────────────────────── */
router.get('/:provider/callback', async (req, res) => {
  const name = String(req.params.provider || '').toLowerCase();
  const provider = oauth.getProvider(name);

  // Errors redirect to the app rather than rendering JSON: the user is in a
  // browser mid-sign-in, and a raw JSON body is a dead end for them.
  const fail = (message) => {
    oauth.clearStateCookie(res);
    return res.redirect(appReturnUrl(req, { error: message }));
  };

  if (!provider || !oauth.isConfigured(name)) return fail('Unknown or unconfigured provider.');

  // The user pressed "Cancel" on the provider's consent screen.
  if (req.query.error) {
    return fail(req.query.error === 'access_denied'
      ? 'Sign-in was cancelled.'
      : String(req.query.error_description || req.query.error));
  }

  if (!oauth.verifyState(req, req.query.state)) {
    return fail('Sign-in session expired or was tampered with. Please try again.');
  }
  oauth.clearStateCookie(res);

  const code = req.query.code;
  if (!code || typeof code !== 'string') return fail('No authorization code returned.');

  let profile;
  try {
    const accessToken = await oauth.exchangeCode(req, name, code);
    profile = await oauth.fetchProfile(name, accessToken);
  } catch (err) {
    // The provider's message can contain the client_secret in some failure
    // modes, so log server-side and hand the user something generic.
    console.error(`[oauth] ${name} failed:`, err.message);
    return fail(`Could not complete ${provider.label} sign-in. Please try again.`);
  }

  if (!profile || !profile.id) return fail(`${provider.label} returned no account id.`);

  try {
    const user = await resolveUser(name, profile);
    if (user.blocked) return fail(user.blocked);

    await users.touchLastLogin(user.id);
    const token = signToken({ sub: user.id, username: user.username });
    return res.redirect(appReturnUrl(req, { token }));
  } catch (err) {
    console.error('[oauth] account resolution failed:', err);
    return fail('Could not sign you in. Please try again.');
  }
});

/* ── Account resolution ─────────────────────────────────────────────────────
   Three cases, in strict order:

     1. This provider identity is already linked  → sign in as that user.
     2. The provider gave a VERIFIED email that matches an existing account
        → link the identity to it and sign in. This is what makes "I signed up
        with a password, now I click Sign in with Google" work instead of
        silently creating a duplicate account.
     3. Otherwise → create a new account.

   Case 2 is the security-critical one. `profile.email` is null unless the
   provider verified it (see oauth.service.js), so an unverified address falls
   through to case 3 and gets its own account rather than someone else's.
   ------------------------------------------------------------------------ */
async function resolveUser(provider, profile) {
  const existingLink = await oauthAccounts.findByProviderAccount(provider, profile.id);
  if (existingLink) {
    const user = await users.findById(existingLink.user_id);
    if (!user) throw new Error('Linked account no longer exists');
    if (user.status === 'suspended') {
      return { blocked: 'This account is suspended. Contact support@scrapient.app.' };
    }
    return user;
  }

  if (profile.email) {
    const byEmail = await users.findByEmail(profile.email);
    if (byEmail) {
      if (byEmail.status === 'suspended') {
        return { blocked: 'This account is suspended. Contact support@scrapient.app.' };
      }
      await oauthAccounts.link({
        userId: byEmail.id, provider, providerAccountId: profile.id,
        email: profile.email, displayName: profile.name, avatarUrl: profile.avatar,
      });
      // The provider has verified this address, so an account that signed up
      // with an unverified one is now confirmed.
      if (!byEmail.email_verified) await users.setEmail(byEmail.id, profile.email, true);
      return byEmail;
    }
  }

  const username = await deriveUsername(profile, provider);
  const userId = await users.createOAuthUser({
    username,
    // Null when unverified — the account simply has no email until the user
    // supplies one, rather than carrying an address nobody has proven.
    email: profile.email,
  });
  await oauthAccounts.link({
    userId, provider, providerAccountId: profile.id,
    email: profile.email, displayName: profile.name, avatarUrl: profile.avatar,
  });
  return { id: userId, username, status: 'active' };
}

/* Usernames stay a required, unique display handle even for OAuth accounts,
   so one is derived from whatever the provider gave us and made to satisfy
   the same rules as a typed one (3-32 chars of [A-Za-z0-9_.-]). */
async function deriveUsername(profile, provider) {
  const seed = (profile.email ? profile.email.split('@')[0] : '')
            || (profile.name || '')
            || provider;

  let base = String(seed).toLowerCase().replace(/[^a-z0-9_.-]/g, '').replace(/^[._-]+/, '');
  if (base.length < 3) base = `${provider}user`;
  base = base.slice(0, 24);

  if (!(await users.existsByUsername(base))) return base;
  // Random rather than sequential: probing for `alice2`, `alice3`… would let
  // anyone enumerate which usernames are taken.
  for (let i = 0; i < 20; i++) {
    const candidate = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    if (!(await users.existsByUsername(candidate))) return candidate;
  }
  return `${base}${Date.now().toString(36)}`.slice(0, 32);
}

/* ── Managing links from the account screen ─────────────────────────────── */

router.get('/linked/list', requireAuth, async (req, res) => {
  const rows = await oauthAccounts.listForUser(req.user.id);
  res.json({
    linked: rows.map((r) => ({
      provider: r.provider,
      label: (oauth.getProvider(r.provider) || {}).label || r.provider,
      email: r.email,
      displayName: r.display_name,
      linkedAt: r.created_at,
    })),
  });
});

router.delete('/linked/:provider', requireAuth, async (req, res) => {
  const name = String(req.params.provider || '').toLowerCase();

  // Refuse to remove the last way in. An OAuth-only account that unlinks its
  // only provider has no password to fall back on and is locked out
  // permanently — the delete would succeed and the user would never get back.
  const linkedCount = await oauthAccounts.countForUser(req.user.id);
  const hasPassword = await users.hasPassword(req.user.id);
  if (linkedCount <= 1 && !hasPassword) {
    return res.status(409).json({
      error: 'This is your only way to sign in. Set a password first, then unlink.',
    });
  }

  const changes = await oauthAccounts.unlink(req.user.id, name);
  if (changes === 0) return res.status(404).json({ error: 'That provider is not linked.' });
  res.json({ ok: true });
});

module.exports = router;

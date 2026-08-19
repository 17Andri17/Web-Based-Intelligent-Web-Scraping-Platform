'use strict';

const crypto = require('crypto');

/* ===========================================================================
   oauth.service
   ---------------------------------------------------------------------------
   Server-side OAuth 2.0 authorization-code flow for Google and GitHub.

   Deliberately dependency-free: Node 22 has global fetch, Express 5 has
   res.cookie, and the flow itself is three HTTP calls. Passport and its
   strategy packages would add a middleware framework and a dozen transitive
   dependencies to avoid writing the sixty lines below.

   ── The one rule that matters ─────────────────────────────────────────────
   An account is only ever linked by a VERIFIED email. If a provider hands
   back an address it has not verified, that address is treated as absent:
   the user gets a new account, never someone else's.

   The attack this prevents: an attacker registers alice@corp.com at a
   provider that doesn't verify addresses, signs in here, and — if we linked
   on the unverified address — is handed Alice's existing Scrapient account
   with all her workflows and data. Google always returns email_verified;
   GitHub requires reading /user/emails and checking the `verified` flag,
   which is why that provider needs a second API call.
   ========================================================================= */

const PROVIDERS = {
  google: {
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    // Google returns everything needed from one userinfo call.
    async profile(accessToken) {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Google userinfo failed (${res.status})`);
      const u = await res.json();
      return {
        id: String(u.sub),
        // email_verified can arrive as the boolean true or the string "true"
        // depending on the endpoint; anything else counts as unverified.
        email: (u.email_verified === true || u.email_verified === 'true') ? u.email : null,
        name: u.name || null,
        avatar: u.picture || null,
      };
    },
  },

  github: {
    label: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    clientIdEnv: 'GITHUB_CLIENT_ID',
    clientSecretEnv: 'GITHUB_CLIENT_SECRET',
    async profile(accessToken) {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        // GitHub rejects API requests without a User-Agent.
        'User-Agent': 'Scrapient',
      };
      const res = await fetch('https://api.github.com/user', { headers });
      if (!res.ok) throw new Error(`GitHub user failed (${res.status})`);
      const u = await res.json();

      // u.email is the PUBLIC profile email — often null, and never a
      // verification signal. The authoritative list is /user/emails, where we
      // want the address that is both primary and verified.
      let email = null;
      try {
        const er = await fetch('https://api.github.com/user/emails', { headers });
        if (er.ok) {
          const list = await er.json();
          const primary = Array.isArray(list)
            ? list.find((e) => e && e.primary && e.verified)
            : null;
          if (primary) email = primary.email;
        }
      } catch (_) { /* no verified email → treated as absent, see header */ }

      return {
        id: String(u.id),
        email,
        name: u.name || u.login || null,
        avatar: u.avatar_url || null,
      };
    },
  },
};

/* ── The development provider ───────────────────────────────────────────────
   A fake provider that signs you in as whoever you say you are, with no
   network call and no Google credentials.

   It exists because everything interesting about OAuth here is on OUR side —
   the state check, account resolution (link an existing account by verified
   e-mail vs. create a new one), username derivation, session issue — and none
   of that should require a trip to Google Cloud Console before it can be
   exercised or debugged. This runs that entire path; only the two HTTP calls
   to the real provider are replaced.

   ── The safety rail ───────────────────────────────────────────────────────
   A button that signs you in as an arbitrary e-mail is a total authentication
   bypass. It therefore needs BOTH an explicit opt-in and a non-production
   environment, and the check runs at call time rather than at boot so it
   cannot be left enabled by a stale module-load. Same shape as the billing
   stub's guard, for the same reason.
   ------------------------------------------------------------------------ */
const DEV_PROVIDER = 'dev';

function devProviderEnabled() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') return false;
  return String(process.env.OAUTH_DEV_PROVIDER || '') === '1';
}

/**
 * Thrown rather than returned so that a bug which routes here in production
 * fails loudly instead of quietly signing someone in.
 */
function assertDevProviderAllowed() {
  if (devProviderEnabled()) return;
  const err = new Error('The development sign-in provider is not enabled.');
  err.status = 403;
  throw err;
}

// The chosen identity travels through the flow where a real provider's
// authorization code would. base64url so it survives a URL round-trip.
function encodeDevIdentity(identity) {
  return Buffer.from(JSON.stringify(identity), 'utf8').toString('base64url');
}

function decodeDevIdentity(blob) {
  try {
    const parsed = JSON.parse(Buffer.from(String(blob), 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

PROVIDERS[DEV_PROVIDER] = {
  label: 'Dev Login',
  // Marks it for the UI, which styles it as obviously-not-a-real-provider.
  local: true,

  /* Instead of sending the browser to a provider, send it straight back to
     our own callback. The state cookie is still set and still verified on the
     way back, so the CSRF path is exercised rather than bypassed. */
  buildAuthorize(req, state) {
    assertDevProviderAllowed();
    const email = String((req.query && req.query.email) || 'dev@localhost').trim().toLowerCase();
    const name = String((req.query && req.query.name) || '').trim() || null;
    const code = encodeDevIdentity({
      // Stable per e-mail, so clicking twice returns to the SAME account
      // rather than minting a new one each time — which is what makes
      // testing the "already linked" path possible.
      id: `dev|${email}`,
      email,
      name,
    });
    const params = new URLSearchParams({ state, code });
    return `${apiBaseUrl(req)}/api/auth/oauth/${DEV_PROVIDER}/callback?${params.toString()}`;
  },

  // No token endpoint to call: the "code" already carries the identity.
  async exchange(req, code) {
    assertDevProviderAllowed();
    return code;
  },

  async profile(blob) {
    assertDevProviderAllowed();
    const identity = decodeDevIdentity(blob);
    if (!identity || !identity.email) throw new Error('Malformed dev identity');
    return {
      id: identity.id || `dev|${identity.email}`,
      // Treated as VERIFIED, which is the point: it exercises the
      // link-to-existing-account branch that an unverified address skips.
      email: identity.email,
      name: identity.name,
      avatar: null,
    };
  },
};

function getProvider(name) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, name) ? PROVIDERS[name] : null;
}

// A provider is only offered once its credentials are actually present, so a
// deploy that hasn't configured GitHub doesn't render a button that dead-ends
// on a provider error page.
function isConfigured(name) {
  const p = getProvider(name);
  if (!p) return false;
  if (name === DEV_PROVIDER) return devProviderEnabled();
  return !!(process.env[p.clientIdEnv] && process.env[p.clientSecretEnv]);
}

function configuredProviders() {
  return Object.keys(PROVIDERS)
    .filter(isConfigured)
    .map((name) => ({
      name,
      label: PROVIDERS[name].label,
      local: !!PROVIDERS[name].local,
    }));
}

/* ── Base URL resolution ────────────────────────────────────────────────────
   TWO origins, not one, because they are not always the same host:

     apiBaseUrl — where this Express app lives. The provider's redirect_uri
                  must point here, because /api/auth/oauth/:provider/callback
                  is served here.
     appBaseUrl — where the user's browser should end up. That's the frontend.

   In production the built UI is served from this same process, so one
   PUBLIC_APP_URL covers both. In development they differ: Vite serves the UI
   on :5173 while the API runs on :3001. Deriving the final redirect from the
   API origin (as this did originally) sent the user to :3001/auth/callback
   after signing in, which serves the last production build — or nothing —
   instead of the app they were using.

   Both prefer explicit configuration over the request's own headers, which
   behind a reverse proxy are attacker-influenceable. The request-derived
   fallback exists so a local run needs no configuration at all.
   ------------------------------------------------------------------------ */
function envUrl(name) {
  return (process.env[name] || '').trim().replace(/\/+$/, '');
}

function apiBaseUrl(req) {
  // PUBLIC_API_URL only needs setting when the API is on a different origin
  // from the app; otherwise PUBLIC_APP_URL covers it.
  return envUrl('PUBLIC_API_URL') || envUrl('PUBLIC_APP_URL')
      || `${req.protocol || 'http'}://${req.get('host')}`;
}

function appBaseUrl(req) {
  return envUrl('PUBLIC_APP_URL') || apiBaseUrl(req);
}

function redirectUri(req, provider) {
  return `${apiBaseUrl(req)}/api/auth/oauth/${provider}/callback`;
}

/* ── CSRF state ─────────────────────────────────────────────────────────────
   The `state` round-trips through the provider and is compared against a
   short-lived httpOnly cookie. Without this, an attacker can complete a flow
   with their OWN authorization code in a victim's browser ("login CSRF"),
   silently signing the victim into the attacker's account — after which
   anything the victim creates lands in an account the attacker controls.

   Compared with timingSafeEqual because a plain === leaks position
   information through timing, and the comparison is cheap either way.
   ------------------------------------------------------------------------ */
const STATE_COOKIE = 'scrapient_oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000;

function newState() {
  return crypto.randomBytes(32).toString('base64url');
}

function setStateCookie(res, state, req) {
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',           // must not be 'strict': this cookie has to
                               // survive the provider's cross-site redirect back
    // Keyed off the API origin, since that is the host this cookie is set on
    // and sent back to. Marking it secure on a plain-http dev server would
    // make the browser drop it, breaking the state check entirely.
    secure: apiBaseUrl(req).startsWith('https://'),
    maxAge: STATE_TTL_MS,
    path: '/api/auth/oauth',
  });
}

function clearStateCookie(res) {
  res.clearCookie(STATE_COOKIE, { path: '/api/auth/oauth' });
}

// Read one cookie without pulling in cookie-parser, which would be a whole
// dependency for the single cookie this application sets.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch (_) { return null; }
    }
  }
  return null;
}

function verifyState(req, received) {
  const expected = readCookie(req, STATE_COOKIE);
  if (!expected || !received) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(received));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ── Flow ───────────────────────────────────────────────────────────────── */

/* A provider may override either step of the flow. Only the dev provider
   does — it has no authorization server to visit and no token endpoint to
   call, so it supplies its own authorize URL (pointing back at us) and
   returns the identity straight from `exchange`. Everything downstream —
   state verification, profile shape, account resolution — is identical. */
function buildAuthorizeUrl(req, providerName, state) {
  const p = getProvider(providerName);
  if (typeof p.buildAuthorize === 'function') return p.buildAuthorize(req, state);

  const params = new URLSearchParams({
    client_id: process.env[p.clientIdEnv],
    redirect_uri: redirectUri(req, providerName),
    response_type: 'code',
    scope: p.scope,
    state,
  });
  // Google needs an explicit prompt to re-show the account chooser; without
  // it a user with several Google accounts is silently signed in as whichever
  // one the browser last used, with no way to pick.
  if (providerName === 'google') params.set('prompt', 'select_account');
  return `${p.authUrl}?${params.toString()}`;
}

async function exchangeCode(req, providerName, code) {
  const p = getProvider(providerName);
  if (typeof p.exchange === 'function') return p.exchange(req, code);

  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',   // GitHub returns form-encoded without this
    },
    body: new URLSearchParams({
      client_id: process.env[p.clientIdEnv],
      client_secret: process.env[p.clientSecretEnv],
      code,
      redirect_uri: redirectUri(req, providerName),
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!res.ok) throw new Error(`${p.label} token exchange failed (${res.status})`);
  const body = await res.json();
  // GitHub answers 200 with {error, error_description} on a bad code, so a
  // non-ok status is not sufficient to detect failure.
  if (body.error) throw new Error(`${p.label}: ${body.error_description || body.error}`);
  if (!body.access_token) throw new Error(`${p.label} returned no access token`);
  return body.access_token;
}

async function fetchProfile(providerName, accessToken) {
  return getProvider(providerName).profile(accessToken);
}

module.exports = {
  PROVIDERS,
  DEV_PROVIDER,
  devProviderEnabled,
  assertDevProviderAllowed,
  getProvider,
  isConfigured,
  configuredProviders,
  apiBaseUrl,
  appBaseUrl,
  redirectUri,
  newState,
  setStateCookie,
  clearStateCookie,
  readCookie,
  verifyState,
  buildAuthorizeUrl,
  exchangeCode,
  fetchProfile,
};

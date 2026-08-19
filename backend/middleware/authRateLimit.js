'use strict';

/* ===========================================================================
   Brute-force protection for the credential endpoints.

   Distinct from middleware/apiRateLimit.js, which keys buckets by API-key id
   and so cannot protect the very endpoints that exist to hand out
   credentials: an attacker guessing passwords has no API key to be limited
   by. This keys on client IP instead.

   Two windows on purpose:
     • a short one that stops a burst,
     • a long one that stops a slow drip under the short limit — 5/minute for
       an hour is 300 attempts, which is a real dictionary attack.

   In-memory, therefore per-process. That matches the current single-process
   deployment; behind several instances this becomes per-instance and the
   store should move to Redis. It is a meaningful speed bump either way, and
   the alternative (nothing) is what a public signup form must never ship
   with.
   ========================================================================= */

const WINDOWS = [
  { ms: 60 * 1000, max: 10, label: 'minute' },
  { ms: 60 * 60 * 1000, max: 60, label: 'hour' },
];

const buckets = new Map(); // key -> [{ count, resetAt }, …] parallel to WINDOWS

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, list] of buckets) {
    if (list.every((b) => now >= b.resetAt)) buckets.delete(key);
  }
}, 10 * 60 * 1000);
if (sweeper.unref) sweeper.unref();

function clientKey(req) {
  // req.ip honours trust proxy when the app sets it; the socket address is
  // the fallback for a direct connection.
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function enabled() {
  // AUTH_RATE_LIMIT=0 disables entirely — used by the test suite, which makes
  // hundreds of auth calls in seconds and would otherwise limit itself.
  return String(process.env.AUTH_RATE_LIMIT ?? '1') !== '0';
}

function authRateLimit(req, res, next) {
  if (!enabled()) return next();

  const key = clientKey(req);
  const now = Date.now();
  let list = buckets.get(key);
  if (!list) {
    list = WINDOWS.map((w) => ({ count: 0, resetAt: now + w.ms }));
    buckets.set(key, list);
  }

  for (let i = 0; i < WINDOWS.length; i++) {
    const w = WINDOWS[i];
    const b = list[i];
    if (now >= b.resetAt) { b.count = 0; b.resetAt = now + w.ms; }
    b.count++;
    if (b.count > w.max) {
      const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: `Too many attempts. Try again in ${retryAfter > 90 ? `${Math.ceil(retryAfter / 60)} minutes` : `${retryAfter} seconds`}.`,
        code: 'rate_limited',
      });
    }
  }
  next();
}

/**
 * Roll back the counters for a request that turned out to be legitimate.
 * Called after a SUCCESSFUL sign-in so that someone logging in from a shared
 * office IP — or simply working across several tabs — isn't locked out by
 * their own successful activity. Only failures should accumulate.
 */
function creditSuccess(req) {
  if (!enabled()) return;
  const list = buckets.get(clientKey(req));
  if (!list) return;
  for (const b of list) b.count = Math.max(0, b.count - 1);
}

module.exports = { authRateLimit, creditSuccess };

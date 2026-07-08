'use strict';

const { sendApiError } = require('./apiKeyAuth');

/* ===========================================================================
   Per-API-key rate limiter for /v1 (fixed 60-second window).

   In-memory and therefore per-process: good enough for the current
   single-process deployment, and the headers/semantics (X-RateLimit-*,
   429 + Retry-After) are what third-party developers integrate against —
   swapping the counter store for Redis later changes nothing visible.
   Must run AFTER requireApiKey (buckets are keyed by api_key id).
   ========================================================================= */

const WINDOW_MS = 60 * 1000;
const buckets = new Map(); // apiKeyId -> { count, resetAt }

// Periodic sweep so revoked/idle keys don't accumulate buckets forever.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, b] of buckets) { if (now >= b.resetAt) buckets.delete(id); }
}, 10 * WINDOW_MS);
if (sweeper.unref) sweeper.unref();

function limitPerMinute() {
  const n = Number(process.env.API_RATE_LIMIT_PER_MIN);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

function apiRateLimit(req, res, next) {
  const limit = limitPerMinute();
  if (limit === 0) return next(); // 0 disables limiting entirely

  const now = Date.now();
  let bucket = buckets.get(req.apiKey.id);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(req.apiKey.id, bucket);
  }
  bucket.count++;

  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return sendApiError(res, 429, 'rate_limited',
      `Rate limit of ${limit} requests/minute exceeded for this API key. Retry after ${retryAfter}s.`,
      { 'Retry-After': String(retryAfter) });
  }
  next();
}

module.exports = { apiRateLimit };

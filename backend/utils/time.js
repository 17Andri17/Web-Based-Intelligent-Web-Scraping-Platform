'use strict';

/* ===========================================================================
   utils/time
   ---------------------------------------------------------------------------
   Reading timestamps back out of the database.

   This schema writes most timestamps with CURRENT_TIMESTAMP, which on SQLite
   yields "YYYY-MM-DD HH:MM:SS" — a UTC instant with no marker saying so.
   Date.parse() reads that shape as LOCAL time, so on any server not on UTC the
   value comes back skewed by the offset, and the skew is one-directional:
   east of UTC a row looks OLDER than it is, so every "has enough time passed?"
   check passes when it shouldn't. That silently defeated the verification
   resend cooldown once already.

   Columns this project writes itself as ISO-8601 with a 'Z' (auth_tokens,
   notification_throttle) are already unambiguous. parseUtc handles both, so
   callers don't have to know which kind they're holding.
   ========================================================================= */

/**
 * Parse a stored timestamp as the UTC instant it actually represents.
 * @returns {number} epoch ms, or NaN if unparseable.
 */
function parseUtc(value) {
  if (value == null) return NaN;
  const s = String(value).trim();
  // Bare "YYYY-MM-DD HH:MM:SS[.sss]" with no zone — the CURRENT_TIMESTAMP shape.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
    return Date.parse(`${s.replace(' ', 'T')}Z`);
  }
  return Date.parse(s);
}

module.exports = { parseUtc };

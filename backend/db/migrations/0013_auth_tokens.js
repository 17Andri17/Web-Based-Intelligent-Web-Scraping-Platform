'use strict';

/* ===========================================================================
   0013_auth_tokens
   ---------------------------------------------------------------------------
   Single-use, expiring tokens for the two flows that prove control of an
   e-mail address: resetting a forgotten password, and verifying an address at
   signup.

   ── One table, not two ────────────────────────────────────────────────────
   Both flows need exactly the same machinery — issue a secret, mail it,
   accept it once, expire it — and differ only in what accepting it does. A
   `kind` column keeps that shared logic in one place (services/authToken)
   rather than duplicating the hashing, expiry and single-use rules twice and
   letting them drift.

   ── Why token_hash and not token ──────────────────────────────────────────
   The plaintext token exists only in the e-mail. What is stored is its
   SHA-256. A database leak therefore does not hand the attacker the ability
   to reset every account on the platform — which is exactly what storing
   plaintext reset tokens would do. SHA-256 without a salt is correct here
   (unlike for passwords): the token is 32 bytes of CSPRNG output, so there is
   no dictionary to attack and no need for a slow KDF.

   ── Why `email` is on the token ───────────────────────────────────────────
   A verification token proves control of ONE address. Without pinning the
   address here, a user could request verification for a@x.com, change their
   account to b@y.com, then click the old link and have b@y.com marked
   verified — proving nothing. The consume step compares this column against
   the account's current address and refuses a mismatch.
   ========================================================================= */

const { pk, fk } = require('../schema');

module.exports = {
  id: '0013_auth_tokens',
  up(dialect) {
    const ID = pk(dialect);
    const FK = fk(dialect);

    return [
      `CREATE TABLE IF NOT EXISTS auth_tokens (
         id         ${ID},
         user_id    ${FK} NOT NULL,
         kind       TEXT NOT NULL,
         token_hash TEXT NOT NULL,
         email      TEXT,
         expires_at TEXT NOT NULL,
         used_at    TEXT,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       )`,
      // Lookup is BY HASH — the flow never knows which user a token belongs
      // to until it has resolved it. Unique so a hash collision (or a repeat
      // insert) can't produce two rows that both validate.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_tokens_hash
         ON auth_tokens(token_hash)`,
      // Supports "invalidate this user's other tokens of this kind", which
      // runs on every issue and every successful consume.
      `CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_kind
         ON auth_tokens(user_id, kind)`,
      // Supports the retention sweep that deletes expired rows.
      `CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires
         ON auth_tokens(expires_at)`,
    ];
  },
};

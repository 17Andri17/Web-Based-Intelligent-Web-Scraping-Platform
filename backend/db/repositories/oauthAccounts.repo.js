'use strict';

const db = require('../client');

/* ===========================================================================
   oauthAccounts.repo
   ---------------------------------------------------------------------------
   Links between a Scrapient account and an external identity provider. One
   row per (provider, provider_account_id); a user may link several providers
   to the same account.

   The provider's account id — not its email — is the durable key. Emails get
   changed at the provider, and keying on them would silently orphan an
   account the moment a user updated their Google address.
   ========================================================================= */

async function findByProviderAccount(provider, providerAccountId) {
  return db.get(
    `SELECT * FROM oauth_accounts WHERE provider = ? AND provider_account_id = ?`,
    [provider, String(providerAccountId)]
  );
}

async function listForUser(userId) {
  return db.all(
    `SELECT id, provider, provider_account_id, email, display_name, avatar_url, created_at
       FROM oauth_accounts WHERE user_id = ? ORDER BY created_at`,
    [userId]
  );
}

async function link({ userId, provider, providerAccountId, email, displayName, avatarUrl }) {
  const row = await db.get(
    `INSERT INTO oauth_accounts
       (user_id, provider, provider_account_id, email, display_name, avatar_url)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    [userId, provider, String(providerAccountId), email || null, displayName || null, avatarUrl || null]
  );
  return row.id;
}

async function unlink(userId, provider) {
  const info = await db.run(
    `DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?`,
    [userId, provider]
  );
  return info.changes;
}

async function countForUser(userId) {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM oauth_accounts WHERE user_id = ?', [userId]);
  return row ? Number(row.n) : 0;
}

module.exports = {
  findByProviderAccount, listForUser, link, unlink, countForUser,
};

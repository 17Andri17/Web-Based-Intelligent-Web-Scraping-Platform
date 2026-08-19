'use strict';

const db = require('../client');

/* ===========================================================================
   adminAudit.repo
   ---------------------------------------------------------------------------
   Every administrative action that changes another account, recorded.

   Plan changes, comps and suspensions are exactly the actions a customer
   later disputes ("I never cancelled", "why was I downgraded"), and the only
   useful answer is a timestamped record of who did what. The table has no
   foreign key to the target user on purpose: a 'user.delete' entry has to
   outlive the row it describes, and ON DELETE CASCADE would erase precisely
   the records the log exists to keep.
   ========================================================================= */

async function record({ adminUserId, action, targetUserId = null, details = null }) {
  await db.run(
    `INSERT INTO admin_audit (admin_user_id, action, target_user_id, details_json)
     VALUES (?, ?, ?, ?)`,
    [adminUserId, action, targetUserId, details ? JSON.stringify(details) : null]
  );
}

async function list({ limit = 100, offset = 0, targetUserId = null } = {}) {
  const where = targetUserId ? 'WHERE a.target_user_id = ?' : '';
  const params = targetUserId ? [targetUserId] : [];
  return db.all(
    `SELECT a.id, a.action, a.target_user_id, a.details_json, a.created_at,
            admin.username AS admin_username,
            target.username AS target_username
       FROM admin_audit a
       LEFT JOIN users admin  ON admin.id  = a.admin_user_id
       LEFT JOIN users target ON target.id = a.target_user_id
       ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
}

module.exports = { record, list };

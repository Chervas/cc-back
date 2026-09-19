'use strict';
module.exports = {
  async up(qi, S = require('sequelize')) {
    const P = await qi.describeTable('GoogleAdsActionPlans');
    for (const [name, type] of Object.entries({ scope_key: S.STRING(64), scope_digest: S.CHAR(64),
      session_expires_at: S.DATE(3), closed_at: S.DATE(3), closed_by_session_ref: S.CHAR(36) })) {
      if (!P[name]) await qi.addColumn('GoogleAdsActionPlans', name, { type, allowNull: true });
    }
    const Q = await qi.describeTable('GoogleAdsActionCommands');
    for (const [name, type] of Object.entries({ actor_user_id: S.INTEGER, session_ref: S.CHAR(36) })) {
      if (!Q[name]) await qi.addColumn('GoogleAdsActionCommands', name, { type, allowNull: true });
    }
    await qi.sequelize.query("ALTER TABLE GoogleAdsActionCommands MODIFY family ENUM('prepare','validate','apply','status','cancel') NOT NULL");
    // Existing identities are deliberately not guessed/backfilled from current
    // grants. A missing original scope digest requires explicit reconciliation.
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM GoogleAdsActionPlans');
    if (Number(rows[0].n)) throw Error('Preserve recovery ownership and closed plans; older code cannot enforce cancellation');
    await qi.sequelize.query("ALTER TABLE GoogleAdsActionCommands MODIFY family ENUM('prepare','validate','apply','status') NOT NULL");
    for (const field of ['actor_user_id', 'session_ref']) await qi.removeColumn('GoogleAdsActionCommands', field);
    for (const field of ['scope_key', 'scope_digest', 'session_expires_at', 'closed_at', 'closed_by_session_ref']) await qi.removeColumn('GoogleAdsActionPlans', field);
  },
};

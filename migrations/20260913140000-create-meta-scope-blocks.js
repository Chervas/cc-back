'use strict';
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE MetaScopeBlocks (
      scope_key VARCHAR(64) NOT NULL PRIMARY KEY,
      reason ENUM('scope_disconnected','legacy_disconnected') NOT NULL,
      connection_id INT NULL, actor_user_id INT NULL,
      created_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
    // Preserve the blocks already recorded before deploying this independent
    // registry. There is intentionally no FK/cascade and no reactivation API.
    await qi.sequelize.query(`INSERT INTO MetaScopeBlocks (scope_key,reason,connection_id,actor_user_id,created_at)
      SELECT scopeKey,'legacy_disconnected',metaConnectionId,authorizedByUserId,UTC_TIMESTAMP(3)
      FROM MetaConnectionAssignments WHERE status IN ('disconnected','revoked')`);
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM MetaScopeBlocks');
    if (Number(rows[0].n)) throw Error('Preserve Meta scope blocks; rollback requires an approved cut');
    await qi.dropTable('MetaScopeBlocks');
  },
};

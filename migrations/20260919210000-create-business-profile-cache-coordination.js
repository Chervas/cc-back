'use strict';
module.exports = {
  async up(qi) {
    // Publish only with writers drained. Existing uncertain mutations cannot
    // safely acquire a zero pending count during an upgrade.
    const [rows] = await qi.sequelize.query("SELECT COUNT(*) AS n FROM BusinessProfileMutations WHERE state='attempted'");
    if (Number(rows[0].n)) throw Error('Reconcile pending Business Profile mutations before cache coordination migration');
    await qi.sequelize.query(`CREATE TABLE IF NOT EXISTS BusinessProfileCacheStates (
      resource_key CHAR(64) NOT NULL PRIMARY KEY,
      epoch CHAR(36) NOT NULL, observation_ref CHAR(36) NULL,
      pending_count INT NOT NULL DEFAULT 0,
      CONSTRAINT cc_gbp_cache_pending CHECK (pending_count >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM BusinessProfileCacheStates');
    if (Number(rows[0].n)) throw Error('Preserve Business Profile cache coordination history');
    await qi.dropTable('BusinessProfileCacheStates');
  },
};

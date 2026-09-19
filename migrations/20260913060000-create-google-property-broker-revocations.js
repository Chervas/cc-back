'use strict';
// Durable access boundary and delivery queue. No FK/cascade or credential data.
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE GooglePropertyBrokerRevocations (
      tuple_hash CHAR(64) NOT NULL PRIMARY KEY,
      kind ENUM('search_console','analytics') NOT NULL,
      resource VARCHAR(512) NOT NULL, connection_ref VARCHAR(128) NOT NULL, asset_ref VARCHAR(128) NOT NULL,
      clinica_id INT NOT NULL, google_connection_id INT NOT NULL, google_user_id VARCHAR(128) NOT NULL,
      request_id CHAR(36) NOT NULL UNIQUE, actor_user_id INT NOT NULL,
      requested_at DATETIME(3) NOT NULL, confirmed_at DATETIME(3) NULL,
      state ENUM('pending','confirmed') NOT NULL DEFAULT 'pending',
      attempts INT UNSIGNED NOT NULL DEFAULT 0, next_attempt_at DATETIME(3) NOT NULL,
      lease_token CHAR(36) NULL, lease_until DATETIME(3) NULL, last_error VARCHAR(48) NULL,
      INDEX cc_property_revoke_delivery (state,next_attempt_at,lease_until),
      INDEX cc_property_revoke_scope (google_connection_id,clinica_id),
      INDEX cc_property_revoke_subject (google_user_id),
      INDEX cc_property_revoke_asset (kind,asset_ref)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM GooglePropertyBrokerRevocations');
    if (Number(rows[0].n)) throw Error('Preserve Google property revocation boundaries; rollback requires an approved cut');
    await qi.dropTable('GooglePropertyBrokerRevocations');
  },
};

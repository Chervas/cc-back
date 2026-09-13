'use strict';
// Independent access boundary and control outbox; no credentials or cascading FK.
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE GoogleAdsBrokerRevocations (
      tuple_hash CHAR(64) NOT NULL PRIMARY KEY,
      customer_id CHAR(10) NOT NULL, connection_ref VARCHAR(128) NOT NULL, asset_ref VARCHAR(128) NOT NULL,
      tenant_clinic_id INT NOT NULL, google_connection_id INT NOT NULL, google_user_id VARCHAR(128) NOT NULL,
      login_customer_id CHAR(10) NULL, scope_key VARCHAR(64) NOT NULL,
      clinic_ids TEXT NOT NULL, mapping_ids TEXT NOT NULL,
      request_id CHAR(36) NOT NULL UNIQUE, actor_user_id INT NOT NULL,
      requested_at DATETIME(3) NOT NULL, confirmed_at DATETIME(3) NULL,
      state ENUM('pending','confirmed') NOT NULL DEFAULT 'pending',
      attempts INT UNSIGNED NOT NULL DEFAULT 0, next_attempt_at DATETIME(3) NOT NULL,
      lease_token CHAR(36) NULL, lease_until DATETIME(3) NULL, last_error VARCHAR(48) NULL,
      INDEX cc_ads_revoke_delivery (state,next_attempt_at,lease_until),
      INDEX cc_ads_revoke_connection (google_connection_id),
      INDEX cc_ads_revoke_subject (google_user_id), INDEX cc_ads_revoke_customer (customer_id),
      INDEX cc_ads_revoke_tenant (tenant_clinic_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM GoogleAdsBrokerRevocations');
    if (Number(rows[0].n)) throw Error('Preserve durable Ads revocations; rollback requires an approved cut');
    await qi.dropTable('GoogleAdsBrokerRevocations');
  },
};

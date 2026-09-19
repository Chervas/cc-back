'use strict';
// Independent scope and intent records. Never cascade away the access boundary.
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE GoogleAdsEnrollmentScopes (
      scope_key VARCHAR(64) NOT NULL PRIMARY KEY,
      google_connection_id INT NOT NULL, google_user_id VARCHAR(128) NOT NULL,
      connection_ref VARCHAR(128) NOT NULL, asset_ref VARCHAR(128) NOT NULL,
      tenant_clinic_id INT NOT NULL, root_customer_id CHAR(10) NOT NULL, login_customer_id CHAR(10) NULL,
      state ENUM('blocked','active') NOT NULL DEFAULT 'blocked',
      INDEX cc_ads_enrollment_scope_connection (google_connection_id),
      INDEX cc_ads_enrollment_scope_subject (google_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
    await qi.sequelize.query(`CREATE TABLE GoogleAdsEnrollmentRequests (
      enrollment_id CHAR(36) NOT NULL PRIMARY KEY,
      scope_key VARCHAR(64) NOT NULL, google_connection_id INT NOT NULL, google_user_id VARCHAR(128) NOT NULL,
      connection_ref VARCHAR(128) NOT NULL, scope_ref VARCHAR(128) NOT NULL, tenant_clinic_id INT NOT NULL,
      customer_id CHAR(10) NOT NULL UNIQUE, login_customer_id CHAR(10) NULL,
      clinic_ids TEXT NOT NULL, clinic_count INT UNSIGNED NOT NULL, clinic_digest CHAR(64) NOT NULL,
      scope_digest CHAR(64) NOT NULL, mapping_id INT NULL UNIQUE,
      actor_user_id INT NOT NULL, session_ref CHAR(36) NOT NULL, session_expires_at DATETIME(3) NOT NULL,
      prepare_request_id CHAR(36) NOT NULL UNIQUE, activate_request_id CHAR(36) NOT NULL UNIQUE,
      revoke_request_id CHAR(36) NOT NULL UNIQUE,
      state ENUM('prepare_pending','prepared','activate_pending','activation_confirmed','active','revoke_pending','revoked') NOT NULL DEFAULT 'prepare_pending',
      requested_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 0, next_attempt_at DATETIME(3) NOT NULL,
      lease_token CHAR(36) NULL, lease_until DATETIME(3) NULL, last_error VARCHAR(64) NULL,
      INDEX cc_ads_enrollment_delivery (state,next_attempt_at,lease_until),
      INDEX cc_ads_enrollment_request_connection (google_connection_id),
      INDEX cc_ads_enrollment_request_subject (google_user_id),
      INDEX cc_ads_enrollment_request_scope (scope_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
  },
  async down(qi) {
    for (const table of ['GoogleAdsEnrollmentScopes', 'GoogleAdsEnrollmentRequests']) {
      const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM ${table}`);
      if (Number(rows[0].n)) throw Error('Preserve enrollment scope and intent history; rollback requires an approved cut');
    }
    await qi.dropTable('GoogleAdsEnrollmentRequests');
    await qi.dropTable('GoogleAdsEnrollmentScopes');
  },
};

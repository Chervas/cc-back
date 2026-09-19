'use strict';
// Security ownership must survive deletion of business mappings: no cascading FK.
module.exports={
  async up(qi){
    await qi.sequelize.query(`CREATE TABLE MetaMarketingEnrollmentRequests (
      enrollment_id CHAR(36) NOT NULL PRIMARY KEY, flow_id CHAR(36) NOT NULL UNIQUE,
      scope_key VARCHAR(64) NOT NULL, clinic_ids TEXT NOT NULL,
      connection_ref VARCHAR(128) NOT NULL, scope_digest CHAR(64) NOT NULL,
      flow_digest CHAR(64) NOT NULL, candidate_digest CHAR(64) NOT NULL,
      meta_user_id VARCHAR(30) NOT NULL, app_id VARCHAR(30) NOT NULL,
      meta_connection_id INT NOT NULL, assignment_digest CHAR(64) NOT NULL,
      assets TEXT NOT NULL, mapping_ids TEXT NOT NULL,
      actor_user_id INT NOT NULL, session_ref CHAR(36) NOT NULL, session_expires_at DATETIME(3) NOT NULL,
      prepare_request_id CHAR(36) NOT NULL UNIQUE, activate_request_id CHAR(36) NOT NULL UNIQUE,
      revoke_request_id CHAR(36) NOT NULL UNIQUE, selection_digest CHAR(64) NULL,
      state ENUM('prepare_pending','prepared','activate_pending','active','revoke_pending','revoked') NOT NULL,
      requested_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      prepared_at DATETIME(3) NULL, activated_at DATETIME(3) NULL, revoked_at DATETIME(3) NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 0, next_attempt_at DATETIME(3) NOT NULL,
      lease_token CHAR(36) NULL, lease_until DATETIME(3) NULL, last_error VARCHAR(64) NULL,
      INDEX cc_meta_enroll_delivery (state,next_attempt_at,lease_until),
      INDEX cc_meta_enroll_scope (scope_key,state), INDEX cc_meta_enroll_subject (meta_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
    await qi.sequelize.query(`CREATE TABLE MetaMarketingEnrollmentClaims (
      asset_ref VARCHAR(128) NOT NULL PRIMARY KEY, enrollment_id CHAR(36) NOT NULL,
      created_at DATETIME(3) NOT NULL, INDEX cc_meta_enroll_claim_owner (enrollment_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
    await qi.sequelize.query(`CREATE TABLE MetaMarketingEnrollmentIdentities (
      meta_user_id VARCHAR(30) NOT NULL PRIMARY KEY, app_id VARCHAR(30) NOT NULL,
      meta_connection_id INT NOT NULL UNIQUE, created_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
  },
  async down(qi){
    for(const table of ['MetaMarketingEnrollmentRequests','MetaMarketingEnrollmentClaims','MetaMarketingEnrollmentIdentities']){
      const [rows]=await qi.sequelize.query('SELECT COUNT(*) AS n FROM '+table);
      if(Number(rows[0].n))throw Error('Preserve Meta enrollment ownership; populated journal cannot be rolled back');
    }
    for(const table of ['MetaMarketingEnrollmentClaims','MetaMarketingEnrollmentIdentities','MetaMarketingEnrollmentRequests'])await qi.dropTable(table);
  },
};

'use strict';

// Additive, independently selected DDL. No population, credentials, FK cascade or existing authority changes.
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE GoogleOAuthAdmissionAttempts (
      attempt_id CHAR(36) NOT NULL PRIMARY KEY,
      actor_user_id INT NOT NULL, session_ref_hash CHAR(64) NOT NULL, session_expires_at DATETIME(3) NOT NULL,
      scope_key VARCHAR(64) NOT NULL, clinic_ids TEXT NOT NULL, clinic_count INT UNSIGNED NOT NULL,
      clinic_digest CHAR(64) NOT NULL,
      service ENUM('business_profile','search_console','analytics','ads') NOT NULL,
      binding_digest CHAR(64) NOT NULL,
      state ENUM('prepared','cancelled','expired') NOT NULL DEFAULT 'prepared',
      revision INT UNSIGNED NOT NULL DEFAULT 0,
      requested_at DATETIME(3) NOT NULL, expires_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL, completed_at DATETIME(3) NULL,
      INDEX cc_google_admission_scope_service (scope_key,service,requested_at),
      INDEX cc_google_admission_expiry (state,expires_at),
      CONSTRAINT cc_google_admission_actor CHECK (actor_user_id BETWEEN 1 AND 2147483647),
      CONSTRAINT cc_google_admission_clinics CHECK (clinic_count BETWEEN 1 AND 1000 AND JSON_VALID(clinic_ids)
        AND JSON_TYPE(clinic_ids)='ARRAY' AND JSON_LENGTH(clinic_ids)=clinic_count),
      CONSTRAINT cc_google_admission_ttl CHECK (expires_at > requested_at AND expires_at <= session_expires_at
        AND expires_at <= TIMESTAMPADD(MICROSECOND,600000000,requested_at)),
      CONSTRAINT cc_google_admission_terminal CHECK (
        (state='prepared' AND revision=0 AND completed_at IS NULL AND updated_at=requested_at)
        OR (state='cancelled' AND revision=1 AND completed_at IS NOT NULL AND completed_at=updated_at AND completed_at>=requested_at AND completed_at<expires_at)
        OR (state='expired' AND revision=1 AND completed_at IS NOT NULL AND completed_at=updated_at AND completed_at>=expires_at))
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM GoogleOAuthAdmissionAttempts');
    if (rows.length !== 1 || String(rows[0].n) !== '0') throw Error('google_oauth_admission_preserve_attempt_history');
    await qi.dropTable('GoogleOAuthAdmissionAttempts');
  },
};

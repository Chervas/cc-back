'use strict';
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE GoogleOAuthAdmissionReturns (
      state_hash CHAR(64) NOT NULL PRIMARY KEY, attempt_id CHAR(36) NOT NULL,
      binding_digest CHAR(64) NOT NULL, session_ref_hash CHAR(64) NOT NULL, actor_user_id INT NOT NULL,
      scope_key VARCHAR(64) NOT NULL, service ENUM('business_profile','search_console','analytics','ads') NOT NULL,
      clinic_digest CHAR(64) NOT NULL, return_path VARCHAR(64) NOT NULL,
      session_expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL, expires_at DATETIME(3) NOT NULL,
      UNIQUE KEY cc_google_admission_return_attempt (attempt_id),
      CONSTRAINT cc_google_admission_return_actor CHECK (actor_user_id BETWEEN 1 AND 2147483647),
      CONSTRAINT cc_google_admission_return_path CHECK (return_path='/pages/settings'),
      CONSTRAINT cc_google_admission_return_ttl CHECK (expires_at>created_at AND expires_at<=session_expires_at
        AND expires_at<=TIMESTAMPADD(MICROSECOND,600000000,created_at))
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM GoogleOAuthAdmissionReturns');
    if (rows.length !== 1 || String(rows[0].n) !== '0') throw Error('google_oauth_admission_preserve_return_history');
    await qi.dropTable('GoogleOAuthAdmissionReturns');
  },
};

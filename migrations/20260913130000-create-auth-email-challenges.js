'use strict';
// Retain challenge/verification history; no cascading deletion of an auth proof.
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE AuthEmailChallenges (
      challenge_id CHAR(36) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL,
      challenge_hash CHAR(64) NOT NULL UNIQUE,
      code_hash CHAR(64) NOT NULL,
      credential_binding CHAR(64) NOT NULL,
      email_hash CHAR(64) NOT NULL,
      state ENUM('pending','verified','used','revoked','locked','expired') NOT NULL DEFAULT 'pending',
      created_at DATETIME(3) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      absolute_expires_at DATETIME(3) NOT NULL,
      last_sent_at DATETIME(3) NOT NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      sends INT UNSIGNED NOT NULL DEFAULT 1,
      verified_at DATETIME(3) NULL,
      consumed_session_id CHAR(36) NULL UNIQUE,
      email_message_id INT NULL,
      INDEX idx_auth_email_user (user_id,created_at),
      INDEX idx_auth_email_state (state,expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
    await qi.sequelize.query(`ALTER TABLE AuthSessions
      ADD COLUMN authentication_method ENUM('password','password_email') NOT NULL DEFAULT 'password',
      ADD COLUMN email_verified_at DATETIME(3) NULL,
      ADD COLUMN email_challenge_id CHAR(36) NULL UNIQUE`);
  },
  async down(qi) {
    const [challenges] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM AuthEmailChallenges');
    const [sessions] = await qi.sequelize.query("SELECT COUNT(*) AS n FROM AuthSessions WHERE authentication_method='password_email' OR email_challenge_id IS NOT NULL");
    if (Number(challenges[0].n) || Number(sessions[0].n)) throw Error('Preserve email verification history; rollback requires an approved cut');
    await qi.sequelize.query('ALTER TABLE AuthSessions DROP COLUMN email_challenge_id, DROP COLUMN email_verified_at, DROP COLUMN authentication_method');
    await qi.dropTable('AuthEmailChallenges');
  },
};

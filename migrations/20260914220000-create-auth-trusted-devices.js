'use strict';
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE AuthTrustedDevices (
      device_id CHAR(36) NOT NULL PRIMARY KEY, user_id INT NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE, key_binding CHAR(64) NOT NULL,
      credential_binding CHAR(64) NOT NULL, creation_session_id CHAR(36) NOT NULL UNIQUE,
      email_verified_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL,
      expires_at DATETIME(3) NOT NULL, revoked_at DATETIME(3) NULL, last_used_at DATETIME(3) NULL,
      INDEX idx_auth_trusted_device_user (user_id,revoked_at,expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
    await qi.sequelize.query(`ALTER TABLE AuthSessions
      MODIFY COLUMN authentication_method ENUM('password','password_email','password_trusted_device') NOT NULL DEFAULT 'password',
      ADD COLUMN trusted_device_id CHAR(36) NULL`);
  },
  async down() { throw Error('Preserve trusted device revocations; roll back application code with MFA enforced'); },
};

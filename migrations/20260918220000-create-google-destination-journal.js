'use strict';
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE IF NOT EXISTS GoogleDestinationAuthorizations (
      authorization_id CHAR(36) NOT NULL PRIMARY KEY, plan_id CHAR(36) NOT NULL UNIQUE,
      owner_digest CHAR(64) NOT NULL, actor_user_id INT NOT NULL, session_ref CHAR(36) NOT NULL,
      session_expires_at DATETIME(3) NOT NULL, scope_key VARCHAR(64) NOT NULL, scope_digest CHAR(64) NOT NULL,
      mapping_id INT NOT NULL, customer_id CHAR(10) NOT NULL, input JSON NOT NULL, receipt JSON NULL,
      revoke_command_id CHAR(36) NULL UNIQUE, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      INDEX cc_google_destination_owner (actor_user_id,session_ref,created_at),
      CONSTRAINT cc_google_destination_parent FOREIGN KEY (plan_id) REFERENCES GoogleAdsActionPlans(plan_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
    await qi.sequelize.query(`CREATE TABLE IF NOT EXISTS GoogleDestinationCommands (
      command_id CHAR(36) NOT NULL PRIMARY KEY, authorization_id CHAR(36) NOT NULL,
      family ENUM('authorize','status','revoke') NOT NULL, actor_user_id INT NOT NULL, session_ref CHAR(36) NOT NULL,
      state ENUM('attempted','completed') NOT NULL, attempted_at DATETIME(3) NOT NULL,
      completed_at DATETIME(3) NULL, last_error VARCHAR(64) NULL,
      INDEX cc_google_destination_commands (authorization_id,attempted_at),
      INDEX cc_google_destination_pending (authorization_id,state,family,command_id),
      CONSTRAINT cc_google_destination_command_owner FOREIGN KEY (authorization_id) REFERENCES GoogleDestinationAuthorizations(authorization_id),
      CONSTRAINT cc_google_destination_completion CHECK (
        (state = 'attempted' AND completed_at IS NULL) OR (state = 'completed' AND completed_at IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM GoogleDestinationAuthorizations');
    if (Number(rows[0].n)) throw Error('Preserve destination decisions, revocations and unknown outcomes');
    await qi.dropTable('GoogleDestinationCommands'); await qi.dropTable('GoogleDestinationAuthorizations');
  },
};

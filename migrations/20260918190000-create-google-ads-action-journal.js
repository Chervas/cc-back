'use strict';
// Append-only command identities. In particular, never drop an unknown outcome.
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE IF NOT EXISTS GoogleAdsActionPlans (
      plan_id CHAR(36) NOT NULL PRIMARY KEY, owner_digest CHAR(64) NOT NULL,
      actor_user_id INT NOT NULL, session_ref CHAR(36) NOT NULL,
      mapping_id INT NOT NULL, customer_id CHAR(10) NOT NULL,
      input JSON NOT NULL, receipt JSON NULL, apply_command_id CHAR(36) NULL UNIQUE,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      INDEX cc_google_action_owner (actor_user_id,session_ref,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
    await qi.sequelize.query(`CREATE TABLE IF NOT EXISTS GoogleAdsActionCommands (
      command_id CHAR(36) NOT NULL PRIMARY KEY, plan_id CHAR(36) NOT NULL,
      family ENUM('prepare','validate','apply','status') NOT NULL,
      state ENUM('attempted','completed') NOT NULL,
      attempted_at DATETIME(3) NOT NULL, completed_at DATETIME(3) NULL, last_error VARCHAR(64) NULL,
      INDEX cc_google_action_command_plan (plan_id,attempted_at),
      CONSTRAINT cc_google_action_command_owner FOREIGN KEY (plan_id) REFERENCES GoogleAdsActionPlans(plan_id),
      CONSTRAINT cc_google_action_command_completion CHECK (
        (state = 'attempted' AND completed_at IS NULL) OR (state = 'completed' AND completed_at IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM GoogleAdsActionPlans');
    if (Number(rows[0].n)) throw Error('Preserve Google action plans, command identities and unknown outcomes');
    await qi.dropTable('GoogleAdsActionCommands'); await qi.dropTable('GoogleAdsActionPlans');
  },
};

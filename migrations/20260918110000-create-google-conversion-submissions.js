'use strict';
// A separate append-only identity boundary; never cascade away delivery history.
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`CREATE TABLE GoogleConversionSubmissions (
      submission_id CHAR(36) NOT NULL PRIMARY KEY,
      attempt_id BIGINT UNSIGNED NOT NULL UNIQUE, dedupe_key CHAR(64) NOT NULL UNIQUE,
      mapping_id INT NOT NULL, google_connection_id INT NOT NULL,
      connection_ref VARCHAR(128) NOT NULL, asset_ref VARCHAR(128) NOT NULL, tenant_ref VARCHAR(128) NOT NULL,
      customer_id CHAR(10) NOT NULL, login_customer_id CHAR(10) NULL,
      conversion_action_id VARCHAR(20) NOT NULL, event_name VARCHAR(32) NOT NULL,
      scope_digest CHAR(64) NOT NULL, delivery_digest CHAR(64) NOT NULL,
      audit_digest CHAR(64) NOT NULL, payload_digest CHAR(64) NOT NULL,
      state ENUM('prepared','attempted','unknown','accepted','succeeded','partial_success','failed') NOT NULL DEFAULT 'prepared',
      provider_request_id VARCHAR(191) NULL UNIQUE,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, attempted_at DATETIME(3) NULL,
      acknowledged_at DATETIME(3) NULL, completed_at DATETIME(3) NULL, last_error VARCHAR(64) NULL,
      INDEX cc_google_conversion_pending (state,updated_at),
      INDEX cc_google_conversion_scope (mapping_id,google_connection_id),
      CONSTRAINT cc_google_conversion_attempt CHECK (
        (state = 'prepared' AND attempted_at IS NULL) OR (state <> 'prepared' AND attempted_at IS NOT NULL)),
      CONSTRAINT cc_google_conversion_ack CHECK (
        (state IN ('prepared','attempted','unknown') AND acknowledged_at IS NULL AND provider_request_id IS NULL)
        OR (state IN ('accepted','succeeded','partial_success','failed') AND acknowledged_at IS NOT NULL)),
      CONSTRAINT cc_google_conversion_terminal CHECK (
        (state IN ('succeeded','partial_success','failed') AND completed_at IS NOT NULL)
        OR (state NOT IN ('succeeded','partial_success','failed') AND completed_at IS NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM GoogleConversionSubmissions');
    if (Number(rows[0].n)) throw Error('Preserve conversion identities and receipts; rollback must not erase delivery history');
    await qi.dropTable('GoogleConversionSubmissions');
  },
};

'use strict';
module.exports = {
  async up(qi) {
    // Independent history: no FK to mutable mappings, sessions or flow rows.
    await qi.sequelize.query(`CREATE TABLE IF NOT EXISTS BusinessProfileMutations (
      operation_id CHAR(36) NOT NULL PRIMARY KEY,
      actor_type ENUM('user','automation') NOT NULL, actor_user_id INT NOT NULL, actor_key CHAR(64) NOT NULL,
      session_ref CHAR(36) NULL, session_expires_at DATETIME(3) NULL,
      execution_id INT NULL, node_id VARCHAR(32) NULL, runtime_namespace VARCHAR(32) NOT NULL,
      requested_clinic_id INT NOT NULL, mapping_id INT NOT NULL, google_connection_id INT NOT NULL,
      connection_ref VARCHAR(128) NOT NULL, asset_ref VARCHAR(128) NOT NULL,
      scope_digest CHAR(64) NOT NULL, input_digest CHAR(64) NOT NULL,
      kind ENUM('replyUpdate','replyDelete','photo','hours') NOT NULL,
      input JSON NOT NULL, local_input JSON NOT NULL,
      state ENUM('attempted','applied') NOT NULL, broker_receipt JSON NULL, last_error VARCHAR(64) NULL,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, applied_at DATETIME(3) NULL,
      INDEX cc_gbp_mutation_actor (actor_user_id,requested_clinic_id,state,created_at,operation_id),
      CONSTRAINT cc_gbp_mutation_actor_shape CHECK (
        (actor_type='user' AND session_ref IS NOT NULL AND session_expires_at IS NOT NULL AND execution_id IS NULL AND node_id IS NULL)
        OR (actor_type='automation' AND session_ref IS NULL AND session_expires_at IS NULL AND execution_id IS NOT NULL AND node_id IS NOT NULL)),
      CONSTRAINT cc_gbp_mutation_completion CHECK (
        (state='attempted' AND applied_at IS NULL AND broker_receipt IS NULL)
        OR (state='applied' AND applied_at IS NOT NULL AND broker_receipt IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
    await qi.sequelize.query(`CREATE TABLE IF NOT EXISTS BusinessProfileMutationLocks (
      resource_key CHAR(64) NOT NULL PRIMARY KEY, operation_id CHAR(36) NOT NULL,
      INDEX cc_gbp_mutation_lock_owner (operation_id),
      CONSTRAINT cc_gbp_mutation_lock_operation FOREIGN KEY (operation_id) REFERENCES BusinessProfileMutations(operation_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin`);
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM BusinessProfileMutations');
    if (Number(rows[0].n)) throw Error('Preserve Business Profile attempts, receipts and resource locks');
    await qi.dropTable('BusinessProfileMutationLocks'); await qi.dropTable('BusinessProfileMutations');
  },
};

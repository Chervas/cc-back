'use strict';
// Append-only recovery generations. Historical blocks and mappings are retained.
module.exports = {
  async up(queryInterface, D) {
    await queryInterface.createTable('MetaMarketingRecoveries', {
      recovery_id: { type: D.CHAR(36), allowNull: false, primaryKey: true },
      scope_key: { type: D.STRING(64), allowNull: false },
      clinic_ids: { type: D.TEXT, allowNull: false },
      app_id: { type: D.STRING(30), allowNull: false },
      meta_user_id: { type: D.STRING(30), allowNull: false },
      source_connection_id: { type: D.INTEGER, allowNull: false },
      canonical_connection_id: { type: D.INTEGER, allowNull: true },
      mapping_ids: { type: D.TEXT, allowNull: false },
      snapshot: { type: D.TEXT('long'), allowNull: false },
      snapshot_digest: { type: D.CHAR(64), allowNull: false },
      prepared_by_user_id: { type: D.INTEGER, allowNull: false },
      prepared_at: { type: D.DATE(3), allowNull: false },
      expires_at: { type: D.DATE(3), allowNull: false },
      state: { type: D.ENUM('prepared', 'flow_bound', 'active', 'retired'), allowNull: false },
      flow_id: { type: D.CHAR(36), allowNull: true },
      candidate_digest: { type: D.CHAR(64), allowNull: true },
      enrollment_id: { type: D.CHAR(36), allowNull: true },
      bound_at: { type: D.DATE(3), allowNull: true },
      activated_at: { type: D.DATE(3), allowNull: true },
      retired_at: { type: D.DATE(3), allowNull: true },
    }, { charset: 'utf8mb4', collate: 'utf8mb4_bin' });
    await queryInterface.addIndex('MetaMarketingRecoveries', ['canonical_connection_id'], { unique: true, name: 'cc_meta_recovery_canonical' });
    await queryInterface.addIndex('MetaMarketingRecoveries', ['flow_id'], { unique: true, name: 'cc_meta_recovery_flow' });
    await queryInterface.addIndex('MetaMarketingRecoveries', ['enrollment_id'], { unique: true, name: 'cc_meta_recovery_enrollment' });
    await queryInterface.addIndex('MetaMarketingRecoveries', ['scope_key', 'state'], { name: 'cc_meta_recovery_scope_state' });
  },
  async down() { throw Error('meta_recovery_history_must_be_preserved'); },
};

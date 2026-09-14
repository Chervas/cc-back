'use strict';
const table = 'PlatformAuditEvents';
module.exports = {
  async up(qi, S) {
    // Separate opt-in migration. Never run against a shared database without the approved cut.
    await qi.createTable(table, {
      event_id: { type: S.UUID, primaryKey: true, allowNull: false },
      correlation_id: { type: S.UUID, allowNull: false }, stage: { type: S.STRING(16), allowNull: false },
      occurred_at: { type: S.DATE(3), allowNull: false }, body: { type: S.TEXT, allowNull: false },
      digest: { type: S.STRING(64), allowNull: false }, state: { type: S.STRING(16), allowNull: false, defaultValue: 'pending' },
      attempts: { type: S.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      next_attempt_at: { type: S.DATE(3), allowNull: false }, lease_token: { type: S.UUID, allowNull: true },
      lease_until: { type: S.DATE(3), allowNull: true }, last_error: { type: S.STRING(48), allowNull: true },
      receipt: { type: S.JSON, allowNull: true }, delivered_at: { type: S.DATE(3), allowNull: true },
    });
    await qi.addIndex(table, ['correlation_id', 'stage'], { unique: true, name: 'uq_platform_audit_stage' });
    await qi.addIndex(table, ['state', 'next_attempt_at', 'lease_until'], { name: 'idx_platform_audit_delivery' });
  },
  async down() { throw Error('platform_audit_preserve_evidence_manual_retention_approval_required'); },
};

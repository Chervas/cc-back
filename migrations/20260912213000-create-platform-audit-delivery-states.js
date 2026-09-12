'use strict';
module.exports = {
  async up(qi, S) {
    await qi.createTable('PlatformAuditDeliveryStates', {
      state_key: { type: S.STRING(48), primaryKey: true, allowNull: false },
      lease_token: { type: S.UUID, allowNull: true }, lease_until: { type: S.DATE(3), allowNull: true },
      last_started_at: { type: S.DATE(3), allowNull: true }, last_completed_at: { type: S.DATE(3), allowNull: true },
      last_confirmed_at: { type: S.DATE(3), allowNull: true },
      last_error: { type: S.STRING(48), allowNull: true }, summary: { type: S.JSON, allowNull: true },
      monitor_checked_at: { type: S.DATE(3), allowNull: true }, alarm_episode: { type: S.UUID, allowNull: true },
      alarm_level: { type: S.STRING(16), allowNull: false, defaultValue: 'healthy' }, alarm_code: { type: S.STRING(48), allowNull: true },
    });
  },
  async down() { throw Error('platform_audit_preserve_delivery_state_and_alert_evidence'); },
};

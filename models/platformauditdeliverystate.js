'use strict';
module.exports = (sequelize, D) => sequelize.define('PlatformAuditDeliveryState', {
  state_key: { type: D.STRING(48), primaryKey: true }, lease_token: { type: D.UUID, allowNull: true },
  lease_until: { type: D.DATE(3), allowNull: true }, last_started_at: { type: D.DATE(3), allowNull: true },
  last_completed_at: { type: D.DATE(3), allowNull: true }, last_error: { type: D.STRING(48), allowNull: true },
  last_confirmed_at: { type: D.DATE(3), allowNull: true },
  summary: { type: D.JSON, allowNull: true }, monitor_checked_at: { type: D.DATE(3), allowNull: true },
  alarm_episode: { type: D.UUID, allowNull: true }, alarm_level: { type: D.STRING(16), allowNull: false, defaultValue: 'healthy' },
  alarm_code: { type: D.STRING(48), allowNull: true },
}, { tableName: 'PlatformAuditDeliveryStates', timestamps: false });

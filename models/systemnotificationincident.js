'use strict';

module.exports = (sequelize, D) => sequelize.define('SystemNotificationIncident', {
  incident_key: { type: D.CHAR(64), primaryKey: true },
  namespace: { type: D.STRING(32), allowNull: false },
  event_key: { type: D.STRING(120), allowNull: false },
  scope_key: { type: D.STRING(128), allowNull: false },
  state: { type: D.STRING(16), allowNull: false },
  severity: { type: D.STRING(24), allowNull: false },
  opened_at: { type: D.DATE(3), allowNull: false },
  observed_at: { type: D.DATE(3), allowNull: false },
  closed_at: D.DATE(3),
  snapshot: { type: D.JSON, allowNull: false },
  channel_state: { type: D.JSON, allowNull: false },
}, { tableName: 'SystemNotificationIncidents', timestamps: false });

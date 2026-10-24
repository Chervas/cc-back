'use strict';
module.exports = (sequelize, D) => sequelize.define('InfrastructureNotificationState', {
 alarm_key: { type: D.CHAR(64), primaryKey: true }, alarm_arn: { type: D.STRING(512), allowNull: false },
 state: { type: D.STRING(24), allowNull: false }, state_changed_at: D.DATE(3), last_receipt_key: D.CHAR(64),
 updated_at: { type: D.DATE(3), allowNull: false },
}, { tableName: 'InfrastructureNotificationStates', timestamps: false });

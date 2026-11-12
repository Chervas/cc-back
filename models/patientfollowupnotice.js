'use strict';
module.exports = (sequelize, D) => sequelize.define('PatientFollowUpNotice', {
  id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  follow_up_id: { type: D.BIGINT.UNSIGNED, allowNull: false },
  user_id: { type: D.INTEGER, allowNull: false },
  enabled: { type: D.BOOLEAN, allowNull: false, defaultValue: true },
  snoozed_until: D.DATE,
  next_notice_at: D.DATE,
  notification_id: D.INTEGER,
  cycle: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
  last_issued_at: D.DATE,
}, { tableName: 'PatientFollowUpNotices', underscored: true,
  indexes: [{ unique: true, fields: ['follow_up_id', 'user_id'], name: 'pfun_recipient_unique' }] });

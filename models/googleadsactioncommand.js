'use strict';
module.exports = (sequelize, D) => sequelize.define('GoogleAdsActionCommand', {
  command_id: { type: D.UUID, primaryKey: true, allowNull: false },
  plan_id: { type: D.UUID, allowNull: false },
  family: { type: D.ENUM('prepare', 'validate', 'apply', 'status', 'cancel'), allowNull: false },
  actor_user_id: { type: D.INTEGER, allowNull: true },
  session_ref: { type: D.CHAR(36), allowNull: true },
  state: { type: D.ENUM('attempted', 'completed'), allowNull: false },
  attempted_at: { type: D.DATE(3), allowNull: false },
  completed_at: { type: D.DATE(3), allowNull: true },
  last_error: { type: D.STRING(64), allowNull: true },
}, { tableName: 'GoogleAdsActionCommands', timestamps: false });

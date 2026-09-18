'use strict';
module.exports = (sequelize, D) => sequelize.define('GoogleDestinationCommand', {
  command_id: { type: D.UUID, primaryKey: true, allowNull: false },
  authorization_id: { type: D.UUID, allowNull: false },
  family: { type: D.ENUM('authorize', 'status', 'revoke'), allowNull: false },
  actor_user_id: { type: D.INTEGER, allowNull: false },
  session_ref: { type: D.UUID, allowNull: false },
  state: { type: D.ENUM('attempted', 'completed'), allowNull: false },
  attempted_at: { type: D.DATE(3), allowNull: false },
  completed_at: { type: D.DATE(3), allowNull: true },
  last_error: { type: D.STRING(64), allowNull: true },
}, { tableName: 'GoogleDestinationCommands', timestamps: false });

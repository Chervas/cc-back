'use strict';
module.exports = (sequelize, D) => sequelize.define('GoogleDestinationAuthorization', {
  authorization_id: { type: D.UUID, primaryKey: true, allowNull: false },
  plan_id: { type: D.UUID, allowNull: false, unique: true },
  owner_digest: { type: D.CHAR(64), allowNull: false },
  actor_user_id: { type: D.INTEGER, allowNull: false },
  session_ref: { type: D.UUID, allowNull: false },
  session_expires_at: { type: D.DATE(3), allowNull: false },
  scope_key: { type: D.STRING(64), allowNull: false },
  scope_digest: { type: D.CHAR(64), allowNull: false },
  mapping_id: { type: D.INTEGER, allowNull: false },
  customer_id: { type: D.CHAR(10), allowNull: false },
  input: { type: D.JSON, allowNull: false },
  receipt: { type: D.JSON, allowNull: true },
  revoke_command_id: { type: D.UUID, allowNull: true, unique: true },
  created_at: { type: D.DATE(3), allowNull: false },
  updated_at: { type: D.DATE(3), allowNull: false },
}, { tableName: 'GoogleDestinationAuthorizations', timestamps: false });

'use strict';
module.exports = (sequelize, D) => sequelize.define('MetaScopeBlock', {
  scope_key: { type: D.STRING(64), primaryKey: true, allowNull: false },
  reason: { type: D.ENUM('scope_disconnected', 'legacy_disconnected'), allowNull: false },
  connection_id: { type: D.INTEGER, allowNull: true }, actor_user_id: { type: D.INTEGER, allowNull: true },
  created_at: { type: D.DATE(3), allowNull: false },
}, { tableName: 'MetaScopeBlocks', timestamps: false });

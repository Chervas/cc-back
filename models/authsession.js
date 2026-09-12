'use strict';
module.exports = (sequelize, D) => sequelize.define('AuthSession', {
  session_id: { type: D.UUID, primaryKey: true },
  user_id: { type: D.INTEGER, allowNull: false },
  issued_at: { type: D.DATE(3), allowNull: false },
  expires_at: { type: D.DATE(3), allowNull: false },
  absolute_expires_at: { type: D.DATE(3), allowNull: false },
  credential_binding: { type: D.STRING(64), allowNull: false },
  state: { type: D.STRING(16), allowNull: false },
  ended_at: { type: D.DATE(3), allowNull: true },
}, { tableName: 'AuthSessions', timestamps: false,
  indexes: [{ name: 'idx_auth_session_user', fields: ['user_id', 'state'] },
    { name: 'idx_auth_session_expiry', fields: ['state', 'expires_at'] }] });

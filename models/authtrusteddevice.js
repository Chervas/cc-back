'use strict';
module.exports = (sequelize, D) => sequelize.define('AuthTrustedDevice', {
  device_id: { type: D.UUID, primaryKey: true }, user_id: { type: D.INTEGER, allowNull: false },
  token_hash: { type: D.STRING(64), allowNull: false, unique: true }, key_binding: { type: D.STRING(64), allowNull: false },
  credential_binding: { type: D.STRING(64), allowNull: false }, creation_session_id: { type: D.UUID, allowNull: false, unique: true },
  email_verified_at: { type: D.DATE(3), allowNull: false }, created_at: { type: D.DATE(3), allowNull: false },
  expires_at: { type: D.DATE(3), allowNull: false }, revoked_at: { type: D.DATE(3), allowNull: true },
  last_used_at: { type: D.DATE(3), allowNull: true },
}, { tableName: 'AuthTrustedDevices', timestamps: false,
  indexes: [{ name: 'idx_auth_trusted_device_user', fields: ['user_id', 'revoked_at', 'expires_at'] }] });

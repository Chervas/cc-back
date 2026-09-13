'use strict';
module.exports = (sequelize, D) => sequelize.define('GoogleOAuthBrokerBinding', {
  google_user_id: { type: D.STRING(128), primaryKey: true, allowNull: false },
  google_connection_id: { type: D.INTEGER, unique: true, allowNull: false },
  connection_ref: { type: D.STRING(128), unique: true, allowNull: false },
  asset_ref: { type: D.STRING(128), allowNull: false },
  clinica_id: { type: D.INTEGER, allowNull: false },
  scope_key: { type: D.STRING(64), allowNull: false },
  policy_version: { type: D.STRING(64), allowNull: false },
  secret_version: { type: D.STRING(64), allowNull: true },
  confirmed_at: { type: D.DATE(3), allowNull: true },
}, { tableName: 'GoogleOAuthBrokerBindings', timestamps: false });

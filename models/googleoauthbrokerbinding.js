'use strict';
module.exports = (sequelize, D) => sequelize.define('GoogleOAuthBrokerBinding', {
  google_user_id: { type: D.STRING(128), primaryKey: true, allowNull: false },
  cohort: { type: D.ENUM('business_profile', 'search_console', 'analytics'), primaryKey: true, allowNull: false, defaultValue: 'business_profile' },
  google_connection_id: { type: D.INTEGER, allowNull: false },
  connection_ref: { type: D.STRING(128), allowNull: false },
  asset_ref: { type: D.STRING(128), allowNull: false },
  clinica_id: { type: D.INTEGER, allowNull: false },
  scope_key: { type: D.STRING(64), allowNull: false },
  policy_version: { type: D.STRING(64), allowNull: false },
  secret_version: { type: D.STRING(64), allowNull: true },
  confirmed_at: { type: D.DATE(3), allowNull: true },
}, { tableName: 'GoogleOAuthBrokerBindings', timestamps: false, indexes: [
  { name: 'cc_oauth_google_connection_id_cohort', fields: ['google_connection_id', 'cohort'], unique: true },
  { name: 'cc_oauth_connection_ref_cohort', fields: ['connection_ref', 'cohort'], unique: true },
] });

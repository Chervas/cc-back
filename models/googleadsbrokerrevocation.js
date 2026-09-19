'use strict';
module.exports = (sequelize, D) => sequelize.define('GoogleAdsBrokerRevocation', {
  tuple_hash: { type: D.CHAR(64), primaryKey: true, allowNull: false },
  customer_id: { type: D.CHAR(10), allowNull: false },
  connection_ref: { type: D.STRING(128), allowNull: false }, asset_ref: { type: D.STRING(128), allowNull: false },
  tenant_clinic_id: { type: D.INTEGER, allowNull: false }, google_connection_id: { type: D.INTEGER, allowNull: false },
  google_user_id: { type: D.STRING(128), allowNull: false }, login_customer_id: { type: D.CHAR(10), allowNull: true },
  scope_key: { type: D.STRING(64), allowNull: false }, clinic_ids: { type: D.TEXT, allowNull: false }, mapping_ids: { type: D.TEXT, allowNull: false },
  request_id: { type: D.UUID, allowNull: false, unique: true }, actor_user_id: { type: D.INTEGER, allowNull: false },
  requested_at: { type: D.DATE(3), allowNull: false }, confirmed_at: { type: D.DATE(3), allowNull: true },
  state: { type: D.ENUM('pending', 'confirmed'), allowNull: false, defaultValue: 'pending' },
  attempts: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, next_attempt_at: { type: D.DATE(3), allowNull: false },
  lease_token: { type: D.UUID, allowNull: true }, lease_until: { type: D.DATE(3), allowNull: true }, last_error: { type: D.STRING(48), allowNull: true },
}, { tableName: 'GoogleAdsBrokerRevocations', timestamps: false, charset: 'ascii', collate: 'ascii_bin', indexes: [
  { name: 'cc_ads_revoke_delivery', fields: ['state', 'next_attempt_at', 'lease_until'] },
  { name: 'cc_ads_revoke_connection', fields: ['google_connection_id'] }, { name: 'cc_ads_revoke_subject', fields: ['google_user_id'] },
  { name: 'cc_ads_revoke_customer', fields: ['customer_id'] }, { name: 'cc_ads_revoke_tenant', fields: ['tenant_clinic_id'] },
] });

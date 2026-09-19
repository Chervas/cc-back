'use strict';
module.exports = (sequelize, D) => sequelize.define('MetaMarketingBrokerRevocation', {
  tuple_hash: { type: D.CHAR(64), primaryKey: true, allowNull: false },
  connection_ref: { type: D.STRING(128), allowNull: false }, asset_ref: { type: D.STRING(128), allowNull: false },
  tenant_clinic_id: { type: D.INTEGER, allowNull: false }, meta_connection_id: { type: D.INTEGER, allowNull: false },
  meta_user_id: { type: D.STRING(30), allowNull: false }, app_id: { type: D.STRING(30), allowNull: false }, parent_page_id: { type: D.STRING(30), allowNull: true },
  scope_key: { type: D.STRING(64), allowNull: false }, clinic_ids: { type: D.TEXT, allowNull: false }, mapping_ids: { type: D.TEXT, allowNull: false },
  request_id: { type: D.UUID, allowNull: false, unique: true }, actor_user_id: { type: D.INTEGER, allowNull: false },
  requested_at: { type: D.DATE(3), allowNull: false }, confirmed_at: { type: D.DATE(3), allowNull: true },
  state: { type: D.ENUM('pending', 'confirmed'), allowNull: false, defaultValue: 'pending' },
  attempts: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, next_attempt_at: { type: D.DATE(3), allowNull: false },
  lease_token: { type: D.UUID, allowNull: true }, lease_until: { type: D.DATE(3), allowNull: true }, last_error: { type: D.STRING(48), allowNull: true },
}, { tableName: 'MetaMarketingBrokerRevocations', timestamps: false, charset: 'ascii', collate: 'ascii_bin', indexes: [
  { name: 'cc_meta_revoke_delivery', fields: ['state', 'next_attempt_at', 'lease_until'] },
  { name: 'cc_meta_revoke_connection', fields: ['meta_connection_id'] }, { name: 'cc_meta_revoke_scope', fields: ['scope_key'] },
  { name: 'cc_meta_revoke_asset', fields: ['asset_ref'] }, { name: 'cc_meta_revoke_tenant', fields: ['tenant_clinic_id'] },
  { name: 'cc_meta_revoke_parent', fields: ['parent_page_id'] },
] });

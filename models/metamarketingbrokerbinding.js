'use strict';
// No FKs: this security registry must survive deletion of application mappings.
module.exports = (sequelize, D) => sequelize.define('MetaMarketingBrokerBinding', {
  mapping_id: { type: D.INTEGER, primaryKey: true, allowNull: false },
  asset_ref: { type: D.STRING(128), allowNull: false },
  meta_connection_id: { type: D.INTEGER, allowNull: false },
  meta_user_id: { type: D.STRING(30), allowNull: false },
  app_id: { type: D.STRING(30), allowNull: false },
  connection_ref: { type: D.STRING(128), allowNull: false },
  scope_key: { type: D.STRING(64), allowNull: false },
  tenant_clinic_id: { type: D.INTEGER, allowNull: false },
  parent_page_id: { type: D.STRING(30), allowNull: true },
  state: { type: D.ENUM('staged', 'active', 'blocked'), allowNull: false, defaultValue: 'staged' },
}, { tableName: 'MetaMarketingBrokerBindings', timestamps: false, charset: 'ascii', collate: 'ascii_bin', indexes: [
  { name: 'cc_meta_marketing_asset', fields: ['asset_ref'] },
  { name: 'cc_meta_marketing_scope', fields: ['scope_key','state'] },
  { name: 'cc_meta_marketing_connection', fields: ['meta_connection_id'] },
  { name: 'cc_meta_marketing_subject', fields: ['meta_user_id', 'app_id'] },
] });

'use strict';
module.exports = (sequelize, D) => sequelize.define('GooglePropertyBrokerRevocation', {
  tuple_hash: { type: D.CHAR(64), primaryKey: true, allowNull: false },
  kind: { type: D.ENUM('search_console', 'analytics'), allowNull: false },
  resource: { type: D.STRING(512), allowNull: false },
  connection_ref: { type: D.STRING(128), allowNull: false }, asset_ref: { type: D.STRING(128), allowNull: false },
  clinica_id: { type: D.INTEGER, allowNull: false }, google_connection_id: { type: D.INTEGER, allowNull: false },
  google_user_id: { type: D.STRING(128), allowNull: false },
  request_id: { type: D.UUID, allowNull: false, unique: true }, actor_user_id: { type: D.INTEGER, allowNull: false },
  requested_at: { type: D.DATE(3), allowNull: false }, confirmed_at: { type: D.DATE(3), allowNull: true },
  state: { type: D.ENUM('pending', 'confirmed'), allowNull: false, defaultValue: 'pending' },
  attempts: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, next_attempt_at: { type: D.DATE(3), allowNull: false },
  lease_token: { type: D.UUID, allowNull: true }, lease_until: { type: D.DATE(3), allowNull: true }, last_error: { type: D.STRING(48), allowNull: true },
}, { tableName: 'GooglePropertyBrokerRevocations', timestamps: false, charset: 'ascii', collate: 'ascii_bin',
  indexes: [{ name: 'cc_property_revoke_delivery', fields: ['state', 'next_attempt_at', 'lease_until'] },
    { name: 'cc_property_revoke_scope', fields: ['google_connection_id', 'clinica_id'] },
    { name: 'cc_property_revoke_subject', fields: ['google_user_id'] }, { name: 'cc_property_revoke_asset', fields: ['kind', 'asset_ref'] }] });

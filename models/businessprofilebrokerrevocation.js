'use strict';
// No FK cascade or automatic cleanup: deleting mappings must not restore access.
module.exports = (sequelize, D) => sequelize.define('BusinessProfileBrokerRevocation', {
  external_location_id: { type: D.STRING(30), primaryKey: true, allowNull: false },
  connection_ref: { type: D.STRING(128), allowNull: false }, asset_ref: { type: D.STRING(128), allowNull: false },
  clinica_id: { type: D.INTEGER, allowNull: false }, google_connection_id: { type: D.INTEGER, allowNull: false },
  request_id: { type: D.UUID, allowNull: false, unique: true }, actor_user_id: { type: D.INTEGER, allowNull: false },
  requested_at: { type: D.DATE(3), allowNull: false }, confirmed_at: { type: D.DATE(3), allowNull: true },
  state: { type: D.STRING(16), allowNull: false, defaultValue: 'pending' },
  attempts: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, next_attempt_at: { type: D.DATE(3), allowNull: false },
  lease_token: { type: D.UUID, allowNull: true }, lease_until: { type: D.DATE(3), allowNull: true },
  last_error: { type: D.STRING(48), allowNull: true },
}, { tableName: 'BusinessProfileBrokerRevocations', timestamps: false,
  indexes: [{ name: 'idx_gbp_revocation_delivery', fields: ['state', 'next_attempt_at', 'lease_until'] },
    { name: 'idx_gbp_revocation_scope', fields: ['clinica_id', 'google_connection_id', 'external_location_id'] }] });

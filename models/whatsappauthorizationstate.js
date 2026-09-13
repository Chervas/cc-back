'use strict';
module.exports = (sequelize, D) => sequelize.define('WhatsappAuthorizationState', {
  request_id: { type: D.UUID, primaryKey: true },
  user_id: { type: D.INTEGER, allowNull: false }, session_ref: { type: D.UUID, allowNull: false },
  session_expires_at: { type: D.DATE(3), allowNull: false },
  scope_type: { type: D.ENUM('clinic', 'group'), allowNull: false }, scope_id: { type: D.INTEGER, allowNull: false },
  original_clinic_ids: { type: D.JSON, allowNull: false }, scope_digest: { type: D.STRING(64), allowNull: false },
  state_hash: { type: D.STRING(64), allowNull: false }, context_digest: { type: D.STRING(64), allowNull: false },
  state: { type: D.ENUM('awaiting', 'claimed', 'cancelled'), allowNull: false }, code_hash: D.STRING(64),
  created_at: { type: D.DATE(3), allowNull: false }, expires_at: { type: D.DATE(3), allowNull: false },
  claimed_at: D.DATE(3), cancelled_at: D.DATE(3),
}, { tableName: 'WhatsappAuthorizationStates', timestamps: false,
  indexes: [{ unique: true, name: 'uq_whatsapp_authorization_state_hash', fields: ['state_hash'] },
    { unique: true, name: 'uq_whatsapp_authorization_code_hash', fields: ['code_hash'] },
    { name: 'idx_whatsapp_authorization_user_time', fields: ['user_id', 'created_at'] },
    { name: 'idx_whatsapp_authorization_user_active', fields: ['user_id', 'state', 'expires_at'] }] });

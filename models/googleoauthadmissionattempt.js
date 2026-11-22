'use strict';

// Intention history only. No connection, subject, authorization, secret or resource grant is created here.
module.exports = (sequelize, D) => sequelize.define('GoogleOAuthAdmissionAttempt', {
  attempt_id: { type: D.UUID, primaryKey: true, allowNull: false },
  actor_user_id: { type: D.INTEGER, allowNull: false },
  session_ref_hash: { type: D.CHAR(64), allowNull: false },
  session_expires_at: { type: D.DATE(3), allowNull: false },
  scope_key: { type: D.STRING(64), allowNull: false },
  clinic_ids: { type: D.TEXT, allowNull: false },
  clinic_count: { type: D.INTEGER.UNSIGNED, allowNull: false },
  clinic_digest: { type: D.CHAR(64), allowNull: false },
  service: { type: D.ENUM('business_profile', 'search_console', 'analytics', 'ads'), allowNull: false },
  binding_digest: { type: D.CHAR(64), allowNull: false },
  state: { type: D.ENUM('prepared', 'cancelled', 'expired'), allowNull: false, defaultValue: 'prepared' },
  revision: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  requested_at: { type: D.DATE(3), allowNull: false },
  expires_at: { type: D.DATE(3), allowNull: false },
  updated_at: { type: D.DATE(3), allowNull: false },
  completed_at: { type: D.DATE(3), allowNull: true },
}, { tableName: 'GoogleOAuthAdmissionAttempts', timestamps: false, indexes: [
  { name: 'cc_google_admission_scope_service', fields: ['scope_key', 'service', 'requested_at'] },
  { name: 'cc_google_admission_expiry', fields: ['state', 'expires_at'] },
] });

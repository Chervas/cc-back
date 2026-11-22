'use strict';
// Hash-only callback locator/tombstone. No OAuth code, raw state, raw JTI or credential.
module.exports = (sequelize, D) => sequelize.define('GoogleOAuthAdmissionReturn', {
  state_hash: { type: D.CHAR(64), primaryKey: true, allowNull: false },
  attempt_id: { type: D.UUID, unique: true, allowNull: false },
  binding_digest: { type: D.CHAR(64), allowNull: false },
  session_ref_hash: { type: D.CHAR(64), allowNull: false },
  actor_user_id: { type: D.INTEGER, allowNull: false },
  scope_key: { type: D.STRING(64), allowNull: false },
  service: { type: D.ENUM('business_profile', 'search_console', 'analytics', 'ads'), allowNull: false },
  clinic_digest: { type: D.CHAR(64), allowNull: false },
  return_path: { type: D.STRING(64), allowNull: false },
  session_expires_at: { type: D.DATE(3), allowNull: false },
  created_at: { type: D.DATE(3), allowNull: false },
  expires_at: { type: D.DATE(3), allowNull: false },
}, { tableName: 'GoogleOAuthAdmissionReturns', timestamps: false });

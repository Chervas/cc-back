'use strict';
module.exports = (sequelize, D) => sequelize.define('BusinessProfileAssociationRequest', {
  attempt_id: { type: D.UUID, primaryKey: true, allowNull: false }, scope_key: { type: D.STRING(64), allowNull: false },
  clinica_id: { type: D.INTEGER, allowNull: false }, google_connection_id: { type: D.INTEGER, allowNull: false },
  google_user_id: { type: D.STRING(128), allowNull: false }, connection_ref: { type: D.STRING(128), allowNull: false }, scope_ref: { type: D.STRING(128), allowNull: false },
  account_id: { type: D.STRING(30), allowNull: false }, location_id: { type: D.STRING(30), allowNull: false },
  previous_asset_ref: { type: D.STRING(128), allowNull: true }, source_mapping_id: { type: D.INTEGER, allowNull: true }, target_mapping_id: { type: D.INTEGER, allowNull: true },
  source_fingerprint: { type: D.CHAR(64), allowNull: false }, authority_digest: { type: D.CHAR(64), allowNull: false }, oauth_binding_digest: { type: D.CHAR(64), allowNull: false },
  current_snapshot: { type: D.JSON, allowNull: true }, target_snapshot: { type: D.JSON, allowNull: false },
  actor_user_id: { type: D.INTEGER, allowNull: false }, session_ref: { type: D.UUID, allowNull: false }, session_expires_at: { type: D.DATE(3), allowNull: false },
  prepare_request_id: { type: D.UUID, unique: true, allowNull: false }, activate_request_id: { type: D.UUID, unique: true, allowNull: false }, retire_request_id: { type: D.UUID, unique: true, allowNull: false }, abort_request_id: { type: D.UUID, unique: true, allowNull: false },
  command_history: { type: D.JSON, allowNull: false },
  state: { type: D.ENUM('prepare_pending','prepared','activate_pending','broker_active','retire_pending','active','cancel_pending','cancelled'), allowNull: false },
  requested_at: { type: D.DATE(3), allowNull: false }, updated_at: { type: D.DATE(3), allowNull: false }, next_attempt_at: { type: D.DATE(3), allowNull: false },
  attempts: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 }, lease_token: { type: D.UUID, allowNull: true }, lease_until: { type: D.DATE(3), allowNull: true }, last_error: { type: D.STRING(64), allowNull: true },
}, { tableName: 'BusinessProfileAssociationRequests', timestamps: false, indexes: [{ name: 'cc_gbp_association_scope', fields: ['scope_key','requested_at','attempt_id'] }, { name: 'cc_gbp_association_location', fields: ['location_id','state'] }] });

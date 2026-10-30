'use strict';
module.exports = (sequelize, D) => sequelize.define('GoogleConversionSubmission', {
  submission_id: { type: D.UUID, primaryKey: true, allowNull: false },
  attempt_id: { type: D.BIGINT.UNSIGNED, unique: true, allowNull: false },
  dedupe_key: { type: D.CHAR(64), unique: true, allowNull: false },
  mapping_id: { type: D.INTEGER, allowNull: false }, google_connection_id: { type: D.INTEGER, allowNull: false },
  connection_ref: { type: D.STRING(128), allowNull: false }, asset_ref: { type: D.STRING(128), allowNull: false },
  tenant_ref: { type: D.STRING(128), allowNull: false }, customer_id: { type: D.CHAR(10), allowNull: false },
  login_customer_id: { type: D.CHAR(10), allowNull: true }, conversion_action_id: { type: D.STRING(20), allowNull: false },
  event_name: { type: D.STRING(32), allowNull: false }, scope_digest: { type: D.CHAR(64), allowNull: false },
  delivery_digest: { type: D.CHAR(64), allowNull: false }, audit_digest: { type: D.CHAR(64), allowNull: false },
  payload_digest: { type: D.CHAR(64), allowNull: false },
  state: { type: D.ENUM('prepared', 'attempted', 'unknown', 'accepted', 'succeeded', 'partial_success', 'failed'), allowNull: false },
  provider_request_id: { type: D.STRING(191), unique: true, allowNull: true },
  created_at: { type: D.DATE(3), allowNull: false }, updated_at: { type: D.DATE(3), allowNull: false },
  attempted_at: { type: D.DATE(3), allowNull: true }, acknowledged_at: { type: D.DATE(3), allowNull: true },
  completed_at: { type: D.DATE(3), allowNull: true }, last_error: { type: D.STRING(64), allowNull: true },
}, { tableName: 'GoogleConversionSubmissions', timestamps: false });

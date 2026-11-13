'use strict';
// Independent ownership history. Never cascade this journal with a mapping.
module.exports = (sequelize, D) => sequelize.define('BusinessProfileBrokerBindingGeneration', {
  generation_id: { type: D.UUID, primaryKey: true, allowNull: false },
  mapping_id: { type: D.INTEGER, allowNull: false, unique: true },
  external_location_id: { type: D.STRING(30), allowNull: false },
  clinica_id: { type: D.INTEGER, allowNull: false },
  google_connection_id: { type: D.INTEGER, allowNull: false },
  connection_ref: { type: D.STRING(128), allowNull: false },
  asset_ref: { type: D.STRING(128), allowNull: false },
  scope_ref: { type: D.STRING(128), allowNull: false },
  previous_asset_ref: { type: D.STRING(128), allowNull: true },
  state: { type: D.ENUM('staged', 'active', 'retired'), allowNull: false, defaultValue: 'staged' },
  association_attempt_id: { type: D.UUID, allowNull: false, unique: true },
  source_fingerprint: { type: D.CHAR(64), allowNull: false },
  predecessor: { type: D.JSON, allowNull: false },
  reassociation: { type: D.JSON, allowNull: true },
  proof_digest: { type: D.CHAR(64), allowNull: true },
  created_at: { type: D.DATE(3), allowNull: false },
  updated_at: { type: D.DATE(3), allowNull: false },
}, { tableName: 'BusinessProfileBrokerBindingGenerations', timestamps: false });

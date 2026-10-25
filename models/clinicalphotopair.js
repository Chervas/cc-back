'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicalPhotoPair', {
  id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, public_id: { type: D.STRING(36), unique: true, allowNull: false },
  clinic_id: { type: D.INTEGER, allowNull: false }, patient_id: { type: D.INTEGER, allowNull: false },
  title: { type: D.STRING(180), allowNull: false }, service_ref: D.JSON, treatment_id: D.INTEGER,
  scope_key: { type: D.STRING(64), allowNull: false }, before_photo: { type: D.JSON, allowNull: false }, after_photo: { type: D.JSON, allowNull: false },
  before_asset_id: { type: D.INTEGER, allowNull: false }, after_asset_id: { type: D.INTEGER, allowNull: false },
  status: { type: D.STRING(16), allowNull: false, defaultValue: 'active' }, version_number: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
  idempotency_key: { type: D.STRING(120), allowNull: false }, creation_hash: { type: D.STRING(64), allowNull: false },
  created_by: { type: D.INTEGER, allowNull: false }, updated_by: { type: D.INTEGER, allowNull: false },
}, { tableName: 'ClinicalPhotoPairs', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

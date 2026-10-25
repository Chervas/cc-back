'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicalTreatmentTemplateDefault', {
  id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, public_id: { type: D.STRING(36), allowNull: false, unique: true },
  clinic_id: { type: D.INTEGER, allowNull: false }, treatment_id: { type: D.INTEGER, allowNull: false },
  version_number: { type: D.INTEGER.UNSIGNED, allowNull: false }, enabled: { type: D.BOOLEAN, allowNull: false }, template_ref: D.JSON,
  treatment_title: { type: D.STRING(255), allowNull: false }, template_title: D.STRING(160),
  created_by: { type: D.INTEGER, allowNull: false }, updated_by: { type: D.INTEGER, allowNull: false },
}, { tableName: 'ClinicalTreatmentTemplateDefaults', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicalAttachmentLibraryState', {
  asset_id: { type: D.INTEGER, primaryKey: true }, clinic_id: { type: D.INTEGER, allowNull: false }, patient_id: { type: D.INTEGER, allowNull: false },
  classification: { type: D.STRING(16), allowNull: false }, status: { type: D.STRING(16), allowNull: false, defaultValue: 'active' },
  version_number: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 }, updated_by: { type: D.INTEGER, allowNull: false },
}, { tableName: 'ClinicalAttachmentLibraryStates', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

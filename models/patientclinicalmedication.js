'use strict';
module.exports = (sequelize, D) => sequelize.define('PatientClinicalMedication', {
  id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, patient_id: { type: D.INTEGER, allowNull: false, unique: true },
  public_id: { type: D.STRING(36), allowNull: false, unique: true },
  version_number: D.INTEGER.UNSIGNED, items: D.JSON, created_by: D.INTEGER, updated_by: D.INTEGER,
}, { tableName: 'PatientClinicalMedications', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

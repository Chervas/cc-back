'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientFollowUp extends Model {}
  PatientFollowUp.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    patient_id: { type: DataTypes.INTEGER, allowNull: false },
    treatment_id: DataTypes.INTEGER,
    operational_reason: { type: DataTypes.STRING(500), allowNull: false },
    clinical_notes: DataTypes.TEXT,
    clinical_target_date: DataTypes.DATEONLY,
    contact_due_date: DataTypes.DATEONLY,
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    linked_appointment_id: DataTypes.INTEGER,
    source_appointment_id: DataTypes.INTEGER,
    source_report_id: DataTypes.BIGINT.UNSIGNED,
    source_kind: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'manual' },
    source_namespace: DataTypes.STRING(120),
    source_reference: DataTypes.STRING(200),
    source_key: { type: DataTypes.STRING(64), unique: true },
    source_date: DataTypes.DATEONLY,
    source_date_semantics: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'unknown' },
    version_number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    created_by: DataTypes.INTEGER,
    updated_by: DataTypes.INTEGER,
  }, {
    sequelize, modelName: 'PatientFollowUp', tableName: 'PatientFollowUps',
    underscored: true, createdAt: 'created_at', updatedAt: 'updated_at',
  });
  return PatientFollowUp;
};

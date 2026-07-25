'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AppointmentClinicalReport extends Model {}
  AppointmentClinicalReport.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    patient_id: { type: DataTypes.INTEGER, allowNull: false },
    appointment_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    treatment_id: DataTypes.INTEGER,
    professional_id: DataTypes.INTEGER,
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    version_number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    reason: DataTypes.STRING(500),
    summary: DataTypes.TEXT,
    findings: DataTypes.TEXT,
    interventions: DataTypes.TEXT,
    outcome: DataTypes.TEXT,
    plan: DataTypes.TEXT,
    next_steps: DataTypes.TEXT,
    private_notes: DataTypes.TEXT,
    finalized_at: DataTypes.DATE,
    finalized_by: DataTypes.INTEGER,
    created_by: DataTypes.INTEGER,
    updated_by: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'AppointmentClinicalReport',
    tableName: 'AppointmentClinicalReports',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return AppointmentClinicalReport;
};

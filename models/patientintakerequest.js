'use strict';
module.exports = (sequelize, D) => sequelize.define('PatientIntakeRequest', {
  id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
  package_id: { type: D.INTEGER, allowNull: false, unique: true },
  patient_id: { type: D.INTEGER, allowNull: false },
  clinic_id: { type: D.INTEGER, allowNull: false },
  schema_version: { type: D.STRING(60), allowNull: false },
  status: { type: D.STRING(30), allowNull: false, defaultValue: 'pending' },
  version: { type: D.INTEGER, allowNull: false, defaultValue: 1 },
  personal_snapshot: { type: D.JSON, allowNull: false },
  answers: D.JSON,
  submitted_personal: D.JSON,
  submitted_at: D.DATE,
  reviewed_at: D.DATE,
  reviewed_by: D.INTEGER,
  confirmed_summary: D.JSON,
  created_by: { type: D.INTEGER, allowNull: false },
}, { tableName: 'PatientIntakeRequests', createdAt: 'created_at', updatedAt: 'updated_at' });

'use strict';

module.exports = (sequelize, D) => sequelize.define('ClinicalEpisodeAppointment', {
  appointment_id: { type: D.INTEGER, primaryKey: true, allowNull: false },
  report_id: { type: D.BIGINT.UNSIGNED, allowNull: false },
  clinic_id: { type: D.INTEGER, allowNull: false },
  patient_id: { type: D.INTEGER, allowNull: false },
  created_by: D.INTEGER,
}, { tableName: 'ClinicalEpisodeAppointments', underscored: true,
  createdAt: 'created_at', updatedAt: false,
  indexes: [{ name: 'clinical_episode_appointments_report_idx', fields: ['report_id', 'appointment_id'] }] });

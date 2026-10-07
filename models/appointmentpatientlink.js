'use strict';
module.exports = (sequelize, D) => sequelize.define('AppointmentPatientLink', {
  id: { type: D.STRING(36), primaryKey: true, allowNull: false },
  clinic_id: { type: D.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' } },
  patient_id: { type: D.INTEGER, allowNull: false, references: { model: 'Pacientes', key: 'id_paciente' } },
  owner_appointment_id: { type: D.INTEGER, allowNull: false, references: { model: 'CitasPacientes', key: 'id_cita' } },
  revision: { type: D.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
  created_by: { type: D.INTEGER, allowNull: false },
}, { tableName: 'AppointmentPatientLinks', underscored: true });

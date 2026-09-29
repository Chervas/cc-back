'use strict';
const { DataTypes: D } = require('sequelize');
module.exports = {
  async up(qi) {
    const columns = await qi.describeTable('CitasPacientes');
    for (const key of ['arrived_at', 'care_started_at', 'care_schedule_start']) {
      if (!columns[key]) await qi.addColumn('CitasPacientes', key, { type: D.DATE, allowNull: true });
    }
    for (const key of ['arrived_by', 'care_started_by']) {
      if (!columns[key]) await qi.addColumn('CitasPacientes', key, { type: D.INTEGER, allowNull: true });
    }
    const tables = await qi.showAllTables();
    if (!tables.includes('AppointmentCareEvents')) await qi.createTable('AppointmentCareEvents', {
      id: { type: D.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      appointment_id: { type: D.INTEGER, allowNull: false, references: { model: 'CitasPacientes', key: 'id_cita' }, onDelete: 'RESTRICT' },
      clinic_id: { type: D.INTEGER, allowNull: false },
      actor_id: { type: D.INTEGER, allowNull: false },
      action: { type: D.STRING(20), allowNull: false },
      schedule_start: { type: D.DATE, allowNull: false },
      created_at: { type: D.DATE, allowNull: false },
    });
    if (!tables.includes('PatientIntakeRequests')) await qi.createTable('PatientIntakeRequests', {
      id: { type: D.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      package_id: { type: D.INTEGER, allowNull: false, unique: true, references: { model: 'ConsentSignaturePackages', key: 'id' }, onDelete: 'RESTRICT' },
      patient_id: { type: D.INTEGER, allowNull: false, references: { model: 'Pacientes', key: 'id_paciente' }, onDelete: 'RESTRICT' },
      clinic_id: { type: D.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' },
      schema_version: { type: D.STRING(60), allowNull: false },
      status: { type: D.STRING(30), allowNull: false, defaultValue: 'pending' },
      version: { type: D.INTEGER, allowNull: false, defaultValue: 1 },
      personal_snapshot: { type: D.JSON, allowNull: false },
      answers: { type: D.JSON, allowNull: true },
      submitted_personal: { type: D.JSON, allowNull: true },
      submitted_at: { type: D.DATE, allowNull: true },
      reviewed_at: { type: D.DATE, allowNull: true },
      reviewed_by: { type: D.INTEGER, allowNull: true },
      confirmed_summary: { type: D.JSON, allowNull: true },
      created_by: { type: D.INTEGER, allowNull: false },
      created_at: { type: D.DATE, allowNull: false },
      updated_at: { type: D.DATE, allowNull: false },
    });
    if (!(await qi.showIndex('PatientIntakeRequests')).some(i => i.name === 'intake_patient_clinic')) {
      await qi.addIndex('PatientIntakeRequests', ['patient_id', 'clinic_id', 'id'], { name: 'intake_patient_clinic' });
    }
  },
  async down() { throw Error('Preserve clinical intake and arrival evidence; roll back code, not clinical data.'); },
};

'use strict';

module.exports = (sequelize, D) => {
  const fk = (model, key) => ({ type: D.INTEGER, allowNull: false,
    references: { model, key }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' });
  return sequelize.define('AppointmentReminderSequence', {
    id: { type: D.STRING(36), primaryKey: true, allowNull: false },
    clinic_id: fk('Clinicas', 'id_clinica'), patient_id: fk('Pacientes', 'id_paciente'),
    local_date: { type: D.DATEONLY, allowNull: false },
    time_zone: { type: D.STRING(64), allowNull: false },
    anchor_appointment_id: fk('CitasPacientes', 'id_cita'),
    arrival_at: { type: D.DATE(3), allowNull: false },
    claims: { type: D.JSON, allowNull: false },
    response_message_id: { type: D.INTEGER, allowNull: true, references: { model: 'Messages', key: 'id' },
      onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
    response_received_at: { type: D.DATE(3), allowNull: true },
    attendance_confirmed_at: { type: D.DATE(3), allowNull: true },
    created_at: { type: D.DATE(3), allowNull: false }, updated_at: { type: D.DATE(3), allowNull: false },
  }, { tableName: 'AppointmentReminderSequences', underscored: true,
    createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ name: 'ars_patient_clinic_day', unique: true, fields: ['patient_id', 'clinic_id', 'local_date'] }] });
};

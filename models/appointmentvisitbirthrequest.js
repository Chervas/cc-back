'use strict';
module.exports = (sequelize, D) => {
  const fk = (model, key, type = D.INTEGER) => ({ type, allowNull: false,
    references: { model, key }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' });
  return sequelize.define('AppointmentVisitBirthRequest', {
    id: { type: D.STRING(36), primaryKey: true, allowNull: false },
    clinic_id: fk('Clinicas', 'id_clinica'), patient_id: fk('Pacientes', 'id_paciente'),
    request_key: { type: D.STRING(36), allowNull: false }, request_sha256: { type: D.STRING(64), allowNull: false },
    appointment_id: { ...fk('CitasPacientes', 'id_cita'), allowNull: true },
    visit_id: { ...fk('AppointmentVisits', 'id', D.STRING(36)), allowNull: true },
    actor_id: { type: D.INTEGER, allowNull: false }, recorded_at: { type: D.DATE(3), allowNull: false },
    created_at: { type: D.DATE(3), allowNull: false }, updated_at: { type: D.DATE(3), allowNull: false },
  }, { tableName: 'AppointmentVisitBirthRequests', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ name: 'avbr_clinic_request', unique: true, fields: ['clinic_id', 'request_key'] },
      { name: 'avbr_appointment', unique: true, fields: ['appointment_id'] }, { name: 'avbr_visit', unique: true, fields: ['visit_id'] }] });
};

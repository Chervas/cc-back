'use strict';

// Additive communication ledger only: no patient HOLD release, historical
// adoption, appointment merging, message generation or scheduler execution.
module.exports = {
  async up(qi, S) {
    const fk = (model, key) => ({ type: S.INTEGER, allowNull: false,
      references: { model, key }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' });
    await qi.createTable('AppointmentReminderSequences', {
      id: { type: S.STRING(36), primaryKey: true, allowNull: false },
      clinic_id: fk('Clinicas', 'id_clinica'), patient_id: fk('Pacientes', 'id_paciente'),
      local_date: { type: S.DATEONLY, allowNull: false }, time_zone: { type: S.STRING(64), allowNull: false },
      anchor_appointment_id: fk('CitasPacientes', 'id_cita'), arrival_at: { type: S.DATE(3), allowNull: false },
      claims: { type: S.JSON, allowNull: false },
      response_message_id: { type: S.INTEGER, allowNull: true, references: { model: 'Messages', key: 'id' },
        onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
      response_received_at: { type: S.DATE(3), allowNull: true },
      attendance_confirmed_at: { type: S.DATE(3), allowNull: true },
      created_at: { type: S.DATE(3), allowNull: false }, updated_at: { type: S.DATE(3), allowNull: false },
    });
    await qi.addIndex('AppointmentReminderSequences', ['patient_id', 'clinic_id', 'local_date'],
      { name: 'ars_patient_clinic_day', unique: true });
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS count FROM `AppointmentReminderSequences`');
    if (Number(rows[0].count) !== 0) throw Error('AppointmentReminderSequences contains durable delivery rights; ordinary rollback is refused.');
    await qi.dropTable('AppointmentReminderSequences');
  },
};

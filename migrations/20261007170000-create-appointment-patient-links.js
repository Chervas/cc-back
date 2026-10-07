'use strict';
// Structure only. No historical grouping, rescheduling, jobs or messages.
module.exports = {
  async up(q, S) {
    const fk = (model, key, type = S.INTEGER) => ({ type, allowNull: false,
      references: { model, key }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' });
    const times = { created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false } };
    await q.createTable('AppointmentPatientLinks', {
      id: { type: S.STRING(36), primaryKey: true, allowNull: false },
      clinic_id: fk('Clinicas', 'id_clinica'), patient_id: fk('Pacientes', 'id_paciente'),
      owner_appointment_id: fk('CitasPacientes', 'id_cita'),
      revision: { type: S.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      created_by: { type: S.INTEGER, allowNull: false }, ...times,
    });
    await q.createTable('AppointmentPatientLinkMembers', {
      appointment_id: { ...fk('CitasPacientes', 'id_cita'), primaryKey: true },
      link_id: fk('AppointmentPatientLinks', 'id', S.STRING(36)), ...times,
    });
    await q.addIndex('AppointmentPatientLinkMembers', ['link_id', 'appointment_id'], { name: 'aplm_link_appointment' });
  },
  async down(q) {
    for (const table of ['AppointmentPatientLinkMembers', 'AppointmentPatientLinks']) {
      const [rows] = await q.sequelize.query(`SELECT COUNT(*) AS n FROM ${table}`);
      if (Number(rows[0].n)) throw new Error('Refusing to remove patient links with existing data');
    }
    await q.dropTable('AppointmentPatientLinkMembers'); await q.dropTable('AppointmentPatientLinks');
  },
};

'use strict';

// Structure only. No backfill, appointments, events, executions, jobs or sends.
module.exports = {
  async up(queryInterface, S) {
    const fk = (model, key, type = S.INTEGER) => ({ type, allowNull: false,
      references: { model, key }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' });
    const times = () => ({ created_at: { type: S.DATE(3), allowNull: false }, updated_at: { type: S.DATE(3), allowNull: false } });
    await queryInterface.createTable('AppointmentVisits', {
      id: { type: S.STRING(36), primaryKey: true, allowNull: false },
      clinic_id: fk('Clinicas', 'id_clinica'), patient_id: fk('Pacientes', 'id_paciente'),
      owner_appointment_id: fk('CitasPacientes', 'id_cita'),
      grouping_kind: { type: S.STRING(24), allowNull: false },
      status: { type: S.STRING(24), allowNull: false, defaultValue: 'active' },
      communication_revision: { type: S.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      membership_sha256: { type: S.STRING(64), allowNull: false },
      snapshot_sha256: { type: S.STRING(64), allowNull: false },
      snapshot: { type: S.JSON, allowNull: false },
      grouping_evidence: { type: S.JSON, allowNull: false },
      merged_into_visit_id: { ...fk('AppointmentVisits', 'id', S.STRING(36)), allowNull: true },
      created_by: { type: S.INTEGER, allowNull: true }, updated_by: { type: S.INTEGER, allowNull: true }, ...times(),
    });
    await queryInterface.addIndex('AppointmentVisits', ['clinic_id', 'patient_id', 'id'], { name: 'av_clinic_patient' });
    await queryInterface.createTable('AppointmentVisitMembers', {
      // One existing reservation has exactly one current durable visit identity.
      appointment_id: { ...fk('CitasPacientes', 'id_cita'), primaryKey: true },
      visit_id: fk('AppointmentVisits', 'id', S.STRING(36)),
      clinic_id: fk('Clinicas', 'id_clinica'), patient_id: fk('Pacientes', 'id_paciente'),
      role: { type: S.STRING(24), allowNull: false },
      evidence: { type: S.JSON, allowNull: false }, ...times(),
    });
    await queryInterface.addIndex('AppointmentVisitMembers', ['visit_id', 'appointment_id'], { name: 'avm_visit_member' });
    await queryInterface.createTable('AppointmentVisitCommunications', {
      id: { type: S.STRING(36), primaryKey: true, allowNull: false },
      visit_id: fk('AppointmentVisits', 'id', S.STRING(36)),
      clinic_id: fk('Clinicas', 'id_clinica'), patient_id: fk('Pacientes', 'id_paciente'),
      owner_appointment_id: fk('CitasPacientes', 'id_cita'),
      purpose: { type: S.STRING(64), allowNull: false },
      communication_revision: { type: S.INTEGER.UNSIGNED, allowNull: false },
      window_key: { type: S.STRING(120), allowNull: false }, window_sha256: { type: S.STRING(64), allowNull: false },
      window_starts_at: { type: S.DATE(3), allowNull: false }, window_ends_at: { type: S.DATE(3), allowNull: false },
      membership_sha256: { type: S.STRING(64), allowNull: false }, snapshot_sha256: { type: S.STRING(64), allowNull: false },
      snapshot: { type: S.JSON, allowNull: false },
      status: { type: S.STRING(24), allowNull: false, defaultValue: 'pending' },
      // Audit/binding only, never part of the uniqueness identity.
      template_version_id: { type: S.INTEGER, allowNull: true },
      execution_id: { ...fk('FlowExecutionsV2', 'id'), allowNull: true },
      message_id: { ...fk('Messages', 'id'), allowNull: true },
      accepted_at: { type: S.DATE(3), allowNull: true }, unknown_at: { type: S.DATE(3), allowNull: true },
      cancelled_at: { type: S.DATE(3), allowNull: true }, cancellation_reason: { type: S.STRING(120), allowNull: true },
      created_by: { type: S.INTEGER, allowNull: true }, ...times(),
    });
    await queryInterface.addIndex('AppointmentVisitCommunications', ['visit_id', 'purpose', 'communication_revision', 'window_sha256'],
      { name: 'avc_visit_purpose_revision_window', unique: true });
    await queryInterface.addIndex('AppointmentVisitCommunications', ['message_id'], { name: 'avc_message_unique', unique: true });
    await queryInterface.addIndex('AppointmentVisitCommunications', ['execution_id'], { name: 'avc_execution' });
    await queryInterface.addIndex('AppointmentVisitCommunications', ['clinic_id', 'visit_id', 'status'], { name: 'avc_clinic_visit_status' });
  },

  async down(queryInterface) {
    // Never erase delivery rights, uncertain delivery or clinical grouping history.
    for (const table of ['AppointmentVisitCommunications', 'AppointmentVisitMembers', 'AppointmentVisits']) {
      const [rows] = await queryInterface.sequelize.query('SELECT COUNT(*) AS count FROM `' + table + '`');
      if (Number(rows[0].count) !== 0) throw new Error(table + ' contains durable history; ordinary rollback is refused.');
    }
    await queryInterface.dropTable('AppointmentVisitCommunications');
    await queryInterface.dropTable('AppointmentVisitMembers');
    await queryInterface.dropTable('AppointmentVisits');
  },
};

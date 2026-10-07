'use strict';

// Empty additive contracts only. Never enrolls, releases, enqueues or sends.
module.exports = {
  async up(q, S) {
    const fk = (model, key, type = S.INTEGER) => ({ type, allowNull: false,
      references: { model, key }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' });
    const times = { created_at: { type: S.DATE(3), allowNull: false }, updated_at: { type: S.DATE(3), allowNull: false } };
    for (const [table, fields] of [['AppointmentVisits', ['runtime_enrollment', 'runtime_enrollment_sha256']],
      ['AppointmentVisitCommunications', ['runtime_stage', 'runtime_stage_sha256', 'runtime_wait', 'runtime_wait_sha256']]]) {
      for (const field of fields) await q.addColumn(table, field, { type: field.endsWith('_sha256') ? S.STRING(64) : S.JSON, allowNull: true });
    }
    await q.createTable('AppointmentVisitBirthRequests', {
      id: { type: S.STRING(36), allowNull: false, primaryKey: true },
      clinic_id: fk('Clinicas', 'id_clinica'), patient_id: fk('Pacientes', 'id_paciente'),
      request_key: { type: S.STRING(36), allowNull: false }, request_sha256: { type: S.STRING(64), allowNull: false },
      appointment_id: { ...fk('CitasPacientes', 'id_cita'), allowNull: true },
      visit_id: { ...fk('AppointmentVisits', 'id', S.STRING(36)), allowNull: true },
      actor_id: { type: S.INTEGER, allowNull: false }, recorded_at: { type: S.DATE(3), allowNull: false }, ...times,
    });
    await q.addIndex('AppointmentVisitBirthRequests', ['clinic_id', 'request_key'], { name: 'avbr_clinic_request', unique: true });
    await q.addIndex('AppointmentVisitBirthRequests', ['appointment_id'], { name: 'avbr_appointment', unique: true });
    await q.addIndex('AppointmentVisitBirthRequests', ['visit_id'], { name: 'avbr_visit', unique: true });
    await q.createTable('AppointmentVisitDispatches', {
      id: { type: S.STRING(36), allowNull: false, primaryKey: true },
      communication_id: fk('AppointmentVisitCommunications', 'id', S.STRING(36)),
      message_id: fk('Messages', 'id'), execution_id: fk('FlowExecutionsV2', 'id'),
      job_request_id: fk('JobRequests', 'id', S.INTEGER.UNSIGNED),
      job_attempt: { type: S.INTEGER.UNSIGNED, allowNull: false }, job_claimed_at: { type: S.DATE(3), allowNull: false },
      runtime_namespace: { type: S.STRING(32), allowNull: false },
      attempt_number: { type: S.INTEGER.UNSIGNED, allowNull: false },
      attempt_token: { type: S.STRING(36), allowNull: false },
      status: { type: S.STRING(32), allowNull: false, defaultValue: 'leased' },
      started_at: { type: S.DATE(3), allowNull: false }, lease_expires_at: { type: S.DATE(3), allowNull: false },
      network_started_at: { type: S.DATE(3), allowNull: true }, settled_at: { type: S.DATE(3), allowNull: true },
      failure_reason: { type: S.STRING(120), allowNull: true }, ...times,
    });
    await q.addIndex('AppointmentVisitDispatches', ['communication_id', 'attempt_number'], { name: 'avd_intent_attempt', unique: true });
    await q.addIndex('AppointmentVisitDispatches', ['attempt_token'], { name: 'avd_token', unique: true });
    await q.addIndex('AppointmentVisitDispatches', ['communication_id', 'status'], { name: 'avd_intent_status' });
  },
  async down(q) {
    for (const table of ['AppointmentVisitDispatches', 'AppointmentVisitBirthRequests']) {
      const [rows] = await q.sequelize.query('SELECT COUNT(*) AS count FROM `' + table + '`');
      if (Number(rows[0].count)) throw Error('appointment visit runtime contains durable history; rollback refused');
    }
    for (const [table, field] of [['AppointmentVisits', 'runtime_enrollment'], ['AppointmentVisitCommunications', 'runtime_stage'],
      ['AppointmentVisitCommunications', 'runtime_wait']]) {
      const [rows] = await q.sequelize.query('SELECT COUNT(*) AS count FROM `' + table + '` WHERE `' + field
        + '` IS NOT NULL OR `' + field + '_sha256` IS NOT NULL');
      if (Number(rows[0].count)) throw Error('appointment visit runtime contains durable history; rollback refused');
    }
    await q.dropTable('AppointmentVisitDispatches'); await q.dropTable('AppointmentVisitBirthRequests');
    for (const [table, fields] of [['AppointmentVisitCommunications', ['runtime_wait_sha256', 'runtime_wait', 'runtime_stage_sha256', 'runtime_stage']],
      ['AppointmentVisits', ['runtime_enrollment_sha256', 'runtime_enrollment']]]) for (const field of fields) await q.removeColumn(table, field);
  },
};

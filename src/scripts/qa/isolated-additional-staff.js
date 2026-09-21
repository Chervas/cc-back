#!/usr/bin/env node
'use strict';
// Real SQL, synthetic DEV only, rolled back including append-only events.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MARKER, PATIENT_ID } = require('./prepare-isolated-clinical-fixture');
async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  require('dotenv').config({ quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  const db = require('../../../models');
  const { mutateAppointmentBooking } = require('../../services/appointmentBookingCommand.service');
  const { changeAppointmentSupport } = require('../../services/appointmentSupport.service');
  const { resourceAppointments } = require('../../services/appointmentResourceCalendar.service');
  const capabilities = { simple: true, multi: true }, marker = `qa-support-${randomUUID()}`;
  const rollback = Error('QA_SUPPORT_ROLLBACK'), ids = [];
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    assert.equal((await db.Clinica.findByPk(1)).nombre_clinica, 'Clinica ficticia DEV');
    const patient = await db.Paciente.findOne({ where: { public_id: PATIENT_ID, clinica_id: 1 } });
    const staff = await db.Usuario.findAll({ where: { notas_usuario: MARKER }, order: [['id_usuario', 'ASC']] });
    const rooms = await db.Instalacion.findAll({ where: { clinica_id: 1, descripcion: MARKER }, order: [['id', 'ASC']] });
    assert(patient && staff.length >= 2 && rooms.length >= 2);
    await assert.rejects(db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const start = '2026-11-16T10:00:00.000Z', end = '2026-11-16T10:30:00.000Z';
      const values = { clinica_id: 1, paciente_id: patient.id_paciente, doctor_id: staff[0].id_usuario,
        instalacion_id: rooms[0].id, inicio: start, fin: end, estado: 'recordatorio_confirmado',
        source_system: 'qa_support', source_reference: marker,
        import_metadata: { notification_suppression: { appointment_details: true, day_before: true, same_day: true } } };
      const persist = async ({ values: resolved, existing, transaction: tx }) => existing
        ? existing.update(resolved, { transaction: tx }) : db.CitaPaciente.create(resolved, { transaction: tx });
      const appointment = await mutateAppointmentBooking({ db, appointmentValues: values, persist, transaction, capabilities });
      ids.push(appointment.id_cita);
      const changed = await changeAppointmentSupport({ db, appointmentId: appointment.id_cita, actorId: 1,
        ids: [staff[1].id_usuario], expectedRange: { start, end }, capabilities, transaction });
      assert.equal(changed.estado, 'recordatorio_confirmado');
      assert.equal(new Date(changed.inicio).toISOString(), start);
      assert.deepEqual(changed.import_metadata.notification_suppression, values.import_metadata.notification_suppression);
      const event = await db.PatientOperationalEvent.findOne({ where: { patient_id: patient.id_paciente,
        event_type: 'appointment.staff_changed' }, order: [['id', 'DESC']], transaction });
      assert.equal(event.metadata.appointment_id, appointment.id_cita);
      assert.equal(event.metadata.additional_staff[0].id, staff[1].id_usuario);
      const busy = await resourceAppointments({ db, doctorId: staff[1].id_usuario, start, end, transaction, enabled: true });
      assert(busy.some(row => row.id_cita === appointment.id_cita && row.can_force_legacy === false));
      const other = await db.Paciente.create({ public_id: `pac_qa_${randomUUID()}`, nombre: 'QA apoyo', apellidos: 'Solo rollback', clinica_id: 1 }, { transaction });
      await assert.rejects(mutateAppointmentBooking({ db, transaction, capabilities, persist, force: true,
        appointmentValues: { ...values, paciente_id: other.id_paciente, doctor_id: staff[1].id_usuario,
          instalacion_id: rooms[1].id, source_reference: `${marker}-conflict` } }), { code: 'booking_unavailable' });
      const later = { start: '2026-11-16T11:00:00.000Z', end: '2026-11-16T11:30:00.000Z' };
      const moved = await mutateAppointmentBooking({ db, transaction, capabilities, persist,
        existingAppointmentId: appointment.id_cita, appointmentValues: { inicio: later.start, fin: later.end } });
      assert.deepEqual(moved.import_metadata.additional_staff.ids, [staff[1].id_usuario]);
      await assert.rejects(changeAppointmentSupport({ db, appointmentId: appointment.id_cita, actorId: 1, ids: [],
        expectedRange: { start, end }, capabilities, transaction }), { code: 'booking_appointment_changed' });
      await changeAppointmentSupport({ db, appointmentId: appointment.id_cita, actorId: 1, ids: [],
        expectedRange: later, capabilities, transaction });
      assert.equal(await db.AppointmentBookingOccupancy.count({ where: { appointment_id: appointment.id_cita,
        doctor_id: staff[1].id_usuario }, transaction }), 0);
      assert.equal(await db.CitaPaciente.count({ where: { source_reference: marker }, transaction }), 1);
      throw rollback;
    }), error => error === rollback);
    assert.equal(await db.CitaPaciente.count({ where: { source_reference: marker } }), 0);
    assert.equal(await db.AppointmentBookingOccupancy.count({ where: { appointment_id: ids } }), 0);
    const events = await db.PatientOperationalEvent.findAll({ where: { patient_id: patient.id_paciente,
      event_type: 'appointment.staff_changed' }, attributes: ['metadata'], raw: true });
    assert(!events.some(event => ids.includes(event.metadata?.appointment_id)));
    console.log(JSON.stringify({ status: 'passed', database: 'isolated_dev', real_sql: true,
      one_appointment_two_people: true, same_status_and_hold: true, support_busy_for_others: true,
      support_survives_move: true, stale_edit_rejected: true, removal_releases_capacity: true,
      event_transactional: true, rolled_back: true, public_database_touched: false }));
  } finally { await db.sequelize.close(); }
}
main().catch(error => { console.error('ISOLATED_SUPPORT_QA_FAILED', error.code || error.message); process.exitCode = 1; });

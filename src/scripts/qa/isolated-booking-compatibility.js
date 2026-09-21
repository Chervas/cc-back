#!/usr/bin/env node
'use strict';
// Synthetic SQL acceptance, always rolled back. Never boots HTTP/providers.
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MARKER, PATIENT_ID } = require('./prepare-isolated-clinical-fixture');

async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  const source = path.resolve(process.argv[2] || path.resolve(__dirname, '../../..'));
  assert(source.startsWith('/home/ubuntu/wt/back-'));
  for (const key of ['BOOKING_PROFILES_ENABLED', 'BOOKING_MULTI_RESOURCE_ENABLED', 'TREATMENT_PROGRAM_BOOKING_ENABLED', 'TREATMENT_PROGRAM_ECONOMICS_ENABLED']) process.env[key] = 'true';
  const log = console.log;
  let db;
  try { console.log = () => {}; db = require('../../../models'); } finally { console.log = log; }
  const { mutateAppointmentBooking } = require(path.join(source, 'src/services/appointmentBookingCommand.service'));
  const { withCalendarMutation } = require(path.join(source, 'src/services/appointmentCalendarMutation.service'));
  const { resourceAppointments } = require(path.join(source, 'src/services/appointmentResourceCalendar.service'));
  const rollback = new Error('QA_ALWAYS_ROLL_BACK');
  const marker = `qa-booking-rollback-${randomUUID()}`;
  const createdIds = [];
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    const clinic = await db.Clinica.findByPk(1);
    assert.equal(clinic?.nombre_clinica, 'Clinica ficticia DEV');
    const patient = await db.Paciente.findOne({ where: { public_id: PATIENT_ID, clinica_id: 1 } });
    assert(patient);
    const doctor = await db.Usuario.findOne({ where: { email_usuario: 'qa.bs.prioritario.20260920@example.invalid', notas_usuario: MARKER } });
    const room = await db.Instalacion.findOne({ where: { clinica_id: 1, nombre: 'Cabina ficticia 1 · QA BS', descripcion: MARKER } });
    assert(doctor && room);
    // Non-null JSON must be covered too: a null legacy row short-circuits MySQL
    // JSON evaluation and cannot catch malformed path generation by the ORM.
    const program = await db.CitaPaciente.findOne({ where: { paciente_id: patient.id_paciente, clinica_id: 1,
      source_system: 'treatment_program', estado: { [db.Sequelize.Op.ne]: 'cancelada' } }, order: [['id_cita', 'DESC']] });
    assert(program);
    const protectedRows = await resourceAppointments({ db, clinic, doctorId: program.doctor_id, installationId: program.instalacion_id,
      start: program.inicio, end: program.fin });
    assert(protectedRows.some(row => row.id_cita === program.id_cita && row.can_force_legacy === false));
    const before = await db.CitaPaciente.count({ where: { clinica_id: 1 } });
    await assert.rejects(db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const other = await db.Paciente.create({ public_id: `pac_qa_${randomUUID()}`, nombre: 'QA temporal', apellidos: 'Solo rollback', clinica_id: 1 }, { transaction });
      const values = { clinica_id: 1, paciente_id: patient.id_paciente, doctor_id: doctor.id_usuario, instalacion_id: room.id,
        inicio: '2026-10-26T10:00:00Z', fin: '2026-10-26T10:30:00Z', estado: 'pendiente', source_system: 'qa_rollback', source_reference: marker };
      const persist = async ({ values: resolved, transaction: tx }) => {
        const row = await db.CitaPaciente.create({ ...resolved, source_reference: `${marker}-${createdIds.length}` }, { transaction: tx }); createdIds.push(row.id_cita); return row;
      };
      const reserve = (overrides = {}) => mutateAppointmentBooking({ db, appointmentValues: values, persist, transaction, ...overrides });
      await reserve();
      await assert.rejects(reserve({ appointmentValues: { ...values, paciente_id: other.id_paciente } }), error => error.code === 'booking_unavailable' && error.details.can_force === true);
      await reserve({ appointmentValues: { ...values, paciente_id: other.id_paciente }, force: true });
      await assert.rejects(reserve({ force: true }), error => error.code === 'booking_unavailable' && error.details.can_force === false);
      const occupied = await resourceAppointments({ db, clinic, doctorId: doctor.id_usuario, installationId: room.id,
        start: values.inicio, end: values.fin, transaction });
      assert.equal(new Set(occupied.map(row => row.id_cita)).size, 2);
      await assert.rejects(withCalendarMutation({ db, clinic, installationId: room.id, transaction,
        mutate: tx => db.InstalacionBloqueo.create({ instalacion_id: room.id, fecha_inicio: values.inicio, fecha_fin: values.fin, motivo: marker }, { transaction: tx }) }),
      error => error.code === 'booking_calendar_conflict');
      throw rollback;
    }), error => error === rollback);
    assert.equal(await db.CitaPaciente.count({ where: { clinica_id: 1 } }), before);
    assert.equal(await db.CitaPaciente.count({ where: { source_reference: marker } }), 0);
    assert.equal(await db.AppointmentBookingOccupancy.count({ where: { appointment_id: createdIds } }), 0);
    assert.equal(await db.InstalacionBloqueo.count({ where: { motivo: marker } }), 0);
    log(JSON.stringify({ status: 'passed', database: 'isolated-dev-only', source, checks: ['protected-non-null-json-profile', 'ordinary-overlap-confirmation', 'occupancy-force', 'patient-conflict', 'segmented-calendar-read', 'calendar-mutation-protection', 'full-rollback'], persistedAppointments: 0 }));
  } finally { await db.sequelize.close(); }
}
main().catch(error => { console.error('ISOLATED_BOOKING_COMPATIBILITY_FAILED', error.code || error.name,
  error.name === 'AssertionError' ? error.message : 'Verificar configuración y contrato SQL de la fixture aislada.'); process.exitCode = 1; });

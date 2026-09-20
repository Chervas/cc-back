#!/usr/bin/env node
'use strict';
// Real SQL integration against an existing synthetic fixture. Every mutation
// below rolls back. No API/auth bypass, delivery or change to runtime gates.
const assert = require('node:assert/strict');
const { MARKER, PATIENT_ID } = require('./prepare-isolated-clinical-fixture');
async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  const db = require('../../../models');
  const { withCalendarMutation, assertDoctorIdentityMutable } = require('../../services/appointmentCalendarMutation.service');
  const { lockBookingResources } = require('../../services/appointmentBookingCommand.service');
  const checks = [];
  const rollbackSentinel = Error('QA_EXPECTED_ROLLBACK');
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    const clinic = await db.Clinica.findByPk(1);
    assert.equal(clinic.nombre_clinica, 'Clinica ficticia DEV');
    const patient = await db.Paciente.findOne({ where: { public_id: PATIENT_ID } });
    assert(patient && patient.clinica_id === 1);
    const appointment = await db.CitaPaciente.findOne({ where: { paciente_id: patient.id_paciente, clinica_id: 1, estado: 'pendiente' }, order: [['inicio', 'ASC']] });
    assert(appointment && appointment.voucher_id);
    const rows = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: appointment.id_cita } });
    const doctor = rows.find(r => r.doctor_id);
    const rooms = rows.filter(r => r.installation_id).sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
    assert(doctor && rooms.length >= 2);
    const before = await db.DoctorBloqueo.count({ where: { doctor_id: doctor.doctor_id } });
    await assert.rejects(withCalendarMutation({ db, doctorId: doctor.doctor_id, enabled: true,
      mutate: transaction => db.DoctorBloqueo.create({ doctor_id: doctor.doctor_id, clinica_id: 1,
        fecha_inicio: doctor.start_at, fecha_fin: doctor.end_at, recurrente: 'none', tipo: 'otro', motivo: MARKER }, { transaction }) }), { code: 'booking_calendar_conflict' });
    assert.equal(await db.DoctorBloqueo.count({ where: { doctor_id: doctor.doctor_id } }), before);
    checks.push('A conflicting doctor block rolls back without hiding the program appointment');
    const second = rooms[1];
    await assert.rejects(withCalendarMutation({ db, installationId: second.installation_id, enabled: true,
      mutate: transaction => db.InstalacionBloqueo.create({ instalacion_id: second.installation_id,
        fecha_inicio: second.start_at, fecha_fin: second.end_at, recurrente: 'none', motivo: MARKER }, { transaction }) }), { code: 'booking_calendar_conflict' });
    checks.push('A block in the second cabin also protects its phase');
    const clinicBefore = (await db.ClinicaHorario.findAll({ where: { clinica_id: 1 }, order: [['id', 'ASC']], raw: true }));
    await assert.rejects(withCalendarMutation({ db, clinicId: 1, enabled: true, mutate: async transaction => {
      await db.ClinicaHorario.destroy({ where: { clinica_id: 1 }, transaction });
      await db.ClinicaHorario.create({ clinica_id: 1, dia_semana: 1, activo: true, hora_inicio: '18:00', hora_fin: '19:00' }, { transaction });
    } }), { code: 'booking_calendar_conflict' });
    assert.deepEqual(await db.ClinicaHorario.findAll({ where: { clinica_id: 1 }, order: [['id', 'ASC']], raw: true }), clinicBefore);
    checks.push('Changing clinic opening hours cannot invalidate already booked visits');
    await assert.rejects(db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      await assertDoctorIdentityMutable({ db, doctorIds: [doctor.doctor_id], transaction, enabled: true });
    }), { code: 'booking_calendar_identity_review_required' });
    checks.push('Account merging refuses to rewrite protected treatment/booking identities');
    // Exercise actual InnoDB contention, not a mocked mutex. All attempts are
    // rolled back and a bound protects the operator from an indefinite wait.
    const held = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
    let contender;
    try {
      await lockBookingResources({ db, resourceKeys: [`doctor:${doctor.doctor_id}`], transaction: held });
      let entered = false;
      contender = withCalendarMutation({ db, doctorId: doctor.doctor_id, enabled: true,
        mutate: async () => { entered = true; throw rollbackSentinel; } }).then(() => { throw Error('MUTATION_MUST_ROLL_BACK'); }, error => error);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(entered, false);
      await held.rollback();
      assert.equal(await contender, rollbackSentinel);
      assert.equal(entered, true);
    } finally { if (!held.finished) await held.rollback(); if (contender) await contender; }
    checks.push('Calendar editing waits on the same InnoDB resource lock as booking');
    console.log(JSON.stringify({ marker: MARKER, ok: true, checks, committed_calendar_mutations: 0 }));
  } finally { await db.sequelize.close(); }
}
main().catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || error.name, message: error.message })); process.exitCode = 1; });

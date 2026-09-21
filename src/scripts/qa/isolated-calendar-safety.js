#!/usr/bin/env node
'use strict';
// Real SQL integration against an existing synthetic fixture. Every mutation
// below rolls back. No API/auth bypass, delivery or change to runtime gates.
const assert = require('node:assert/strict');
const path = require('node:path');
const { MARKER, PATIENT_ID } = require('./prepare-isolated-clinical-fixture');
async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  const source = path.resolve(process.argv[2] || path.resolve(__dirname, '../../..'));
  assert(['/home/ubuntu/wt/back-dev', '/home/ubuntu/wt/back-staging', '/home/ubuntu/wt/gateway'].includes(source));
  const log = console.log;
  let db;
  try { console.log = () => {}; db = require('../../../models'); } finally { console.log = log; }
  const { withCalendarMutation, assertDoctorIdentityMutable } = require(path.join(source, 'src/services/appointmentCalendarMutation.service'));
  const { lockBookingResources } = require(path.join(source, 'src/services/appointmentBookingCommand.service'));
  const checks = [];
  const rollbackSentinel = Error('QA_EXPECTED_ROLLBACK');
  // Even a regression that incorrectly allows a conflicting change must never
  // commit it. Give every case an owned transaction, rolled back in finally.
  const rollbackOnly = async run => {
    const transaction = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
    try { return await run(transaction); } finally { if (!transaction.finished) await transaction.rollback(); }
  };
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    assert.equal(db.sequelize.config.username, 'cc_dev_api');
    const clinic = await db.Clinica.findByPk(1);
    assert.equal(clinic.nombre_clinica, 'Clinica ficticia DEV');
    const patient = await db.Paciente.findOne({ where: { public_id: PATIENT_ID } });
    assert(patient && patient.clinica_id === 1);
    const budget = await db.EconomicBudget.findOne({ where: { clinic_id: 1,
      source_reference: `${MARKER}-multicabina`, source_system: 'clinicaclick_demo' } });
    assert(budget, 'Prepare the isolated multicabin fixture before running this acceptance');
    const voucher = await db.PatientVoucher.findOne({ where: { clinic_id: 1, patient_id: patient.id_paciente,
      budget_id: budget.id, source_system: 'treatment_program' } });
    assert(voucher);
    const appointment = await db.CitaPaciente.findOne({ where: { paciente_id: patient.id_paciente, clinica_id: 1,
      voucher_id: voucher.id, source_system: 'treatment_program', estado: 'pendiente' }, order: [['inicio', 'ASC']] });
    assert(appointment && appointment.voucher_id);
    const rows = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: appointment.id_cita } });
    const doctor = rows.find(r => r.doctor_id);
    const rooms = rows.filter(r => r.installation_id).sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
    assert(doctor && new Set(rooms.map(row => row.installation_id)).size >= 2);
    const before = await db.DoctorBloqueo.count({ where: { doctor_id: doctor.doctor_id } });
    await rollbackOnly(transaction => assert.rejects(withCalendarMutation({ db, doctorId: doctor.doctor_id, enabled: true, transaction,
      mutate: transaction => db.DoctorBloqueo.create({ doctor_id: doctor.doctor_id, clinica_id: 1,
        fecha_inicio: doctor.start_at, fecha_fin: doctor.end_at, recurrente: 'none', tipo: 'otro', motivo: MARKER }, { transaction }) }), { code: 'booking_calendar_conflict' }));
    assert.equal(await db.DoctorBloqueo.count({ where: { doctor_id: doctor.doctor_id } }), before);
    checks.push('A conflicting doctor block rolls back without hiding the program appointment');
    const second = rooms[1];
    const roomBefore = await db.InstalacionBloqueo.count({ where: { instalacion_id: second.installation_id } });
    await rollbackOnly(transaction => assert.rejects(withCalendarMutation({ db, installationId: second.installation_id, enabled: true, transaction,
      mutate: transaction => db.InstalacionBloqueo.create({ instalacion_id: second.installation_id,
        fecha_inicio: second.start_at, fecha_fin: second.end_at, recurrente: 'none', motivo: MARKER }, { transaction }) }), { code: 'booking_calendar_conflict' }));
    assert.equal(await db.InstalacionBloqueo.count({ where: { instalacion_id: second.installation_id } }), roomBefore);
    checks.push('A block in the second cabin also protects its phase');
    const clinicBefore = (await db.ClinicaHorario.findAll({ where: { clinica_id: 1 }, order: [['id', 'ASC']], raw: true }));
    await rollbackOnly(transaction => assert.rejects(withCalendarMutation({ db, clinicId: 1, enabled: true, transaction, mutate: async transaction => {
      await db.ClinicaHorario.destroy({ where: { clinica_id: 1 }, transaction });
      await db.ClinicaHorario.create({ clinica_id: 1, dia_semana: 1, activo: true, hora_inicio: '18:00', hora_fin: '19:00' }, { transaction });
    } }), { code: 'booking_calendar_conflict' }));
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
    console.log(JSON.stringify({ marker: MARKER, source, ok: true, checks, committed_calendar_mutations: 0 }));
  } finally { await db.sequelize.close(); }
}
main().catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || error.name, message: error.message })); process.exitCode = 1; });

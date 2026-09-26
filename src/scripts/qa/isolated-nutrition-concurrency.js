#!/usr/bin/env node
'use strict';

// Real service and independent MySQL transactions, using an existing synthetic
// appointment. No fixtures are created, business writes allowed or CRM loaded.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { MARKER, PATIENT_ID } = require('./prepare-isolated-clinical-fixture');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  let db;
  const log = console.log;
  try { console.log = () => {}; db = require('../../../models'); } finally { console.log = log; }
  const checks = [], blockedWrites = [];
  let held, writer, queryTimer;
  const hook = 'isolated-nutrition-concurrency-readonly';
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    assert.equal(db.sequelize.config.username, 'cc_dev_api');
    assert.equal((await db.Clinica.findByPk(1)).nombre_clinica, 'Clinica ficticia DEV');
    const patient = await db.Paciente.findOne({ where: { public_id: PATIENT_ID, clinica_id: 1 } });
    assert(patient, 'Existing isolated synthetic patient is required');
    const appointment = await db.CitaPaciente.findOne({ where: {
      paciente_id: patient.id_paciente, clinica_id: 1,
      source_reference: 'qa-week-calendar-unassigned-20260920',
    } });
    assert(appointment, 'Existing isolated synthetic calendar appointment is required');
    const snapshot = async () => ({
      patient: (await patient.reload()).toJSON(),
      appointment: (await appointment.reload()).toJSON(),
      measurements: await db.PatientNutritionMeasurement.findAll({ where: { patient_id: patient.id_paciente }, order: [['id', 'ASC']], raw: true }),
      reports: await db.PatientNutritionReport.findAll({ where: { patient_id: patient.id_paciente }, order: [['id', 'ASC']], raw: true }),
      occupancy: await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: appointment.id_cita }, order: [['id', 'ASC']], raw: true }),
      events: await db.PatientOperationalEvent.findAll({ where: { patient_id: patient.id_paciente }, order: [['id', 'ASC']], raw: true }),
    });
    const before = await snapshot();
    held = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
    await db.CitaPaciente.findByPk(appointment.id_cita, { transaction: held, lock: held.LOCK.UPDATE });
    let signalQuery, queryFinished = false, settled = false;
    const queryStarted = new Promise(resolve => { signalQuery = resolve; });
    const isWriterAppointmentQuery = options => options.model === db.CitaPaciente
      && options.type === 'SELECT' && options.transaction && options.transaction !== held;
    db.sequelize.addHook('beforeQuery', hook, options => {
      // Fail closed if validation regresses. This guard never provides a fake
      // response or replaces the actual SELECT/locking behavior under test.
      if (['INSERT', 'UPDATE', 'BULKUPDATE', 'DELETE', 'BULKDELETE', 'UPSERT'].includes(options.type)) {
        blockedWrites.push(options.type);
        throw new Error('Unexpected business write in read-only concurrency QA');
      }
      if (isWriterAppointmentQuery(options)) {
        assert.equal(options.lock, 'UPDATE', 'Nutrition must lock the appointment before deriving context');
        signalQuery();
      }
    });
    db.sequelize.addHook('afterQuery', hook, options => {
      if (isWriterAppointmentQuery(options)) queryFinished = true;
    });
    writer = require('../../services/nutritionWorkspace.service').createNutritionMeasurement(PATIENT_ID, {
      profile_code: 'quick', raw_values: { weight_kg: 70, stature_cm: 170, waist_cm: 80, hip_cm: 90 },
      appointment_id: appointment.id_cita,
      // This deliberately mismatches the existing fixture clinic. Once the
      // lock is released, real validation must reject without creating data.
      clinic_id: 2147483647, notes: 'Isolated read-only concurrency QA',
    }, 1).then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
    const first = await Promise.race([
      queryStarted.then(() => 'appointment_query'), writer.then(() => 'settled_early'),
      new Promise(resolve => { queryTimer = setTimeout(() => resolve('query_timeout'), 10000); }),
    ]);
    clearTimeout(queryTimer);
    assert.equal(first, 'appointment_query');
    await delay(250);
    assert.equal(queryFinished, false, 'The real appointment SELECT completed while another transaction owned its lock');
    assert.equal(settled, false, 'The real nutrition writer must wait');
    checks.push('Nutrition reaches its own SELECT FOR UPDATE and waits for the appointment lock');
    await held.rollback();
    const outcome = await writer;
    assert.equal(queryFinished, true);
    assert.equal(outcome.error?.code, 'nutrition_appointment_clinic_mismatch');
    checks.push('After release, authoritative appointment/clinic validation rejects the inconsistent request');
    const after = await snapshot();
    assert.deepEqual(after, before);
    assert.deepEqual(blockedWrites, []);
    checks.push('Patient, appointment, HOLD, canonical occupancy, events, measurements and report snapshots are unchanged');
    console.log(JSON.stringify({ ok: true, database: 'isolated_dev', real_sql: true, checks,
      before_sha256: hash(before), after_sha256: hash(after),
      measurements_preserved: before.measurements.length, reports_preserved: before.reports.length,
      committed_mutations: 0, public_database_touched: false }));
  } finally {
    clearTimeout(queryTimer);
    if (held && !held.finished) await held.rollback();
    if (writer) await writer;
    db.sequelize.removeHook('beforeQuery', hook);
    db.sequelize.removeHook('afterQuery', hook);
    await db.sequelize.close();
  }
}
main().catch(error => { console.error('ISOLATED_NUTRITION_CONCURRENCY_FAILED', error.code, error.message); process.exitCode = 1; });

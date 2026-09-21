'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const review = require('../../lib/appointment-import-review');
const { normalizeResolution } = require('../../services/appointmentImportResolution.service');
const { assessAppointmentClinicalConsent } = require('../../services/appointmentConsentEligibility.service');

function appointment() {
  return { id_cita: 51, paciente_id: 8, clinica_id: 72, inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T10:30:00Z',
    updated_at: '2026-09-21T14:00:00Z', doctor_id: 5, instalacion_id: 9, tratamiento_id: null,
    tipo_cita: 'continuacion', estado: 'pendiente', source_system: 'cliniccloud', source_reference: 'fixture',
    titulo: 'ORIGINAL SOURCE', nota: 'ORIGINAL NOTE', import_metadata: {
      notification_suppression: { appointment_details: true, day_before: true, same_day: true },
      cliniccloud_delta: { pending_assignment: ['doctor_id', 'installation_id', 'treatment_id'], source: { service_key: 'SOURCE' } },
      cliniccloud_reconciliation: { automation_policy: 'hold' } } };
}
function fixture({ failEvent = false, dependency = null, bookingError = null } = {}) {
  let state = appointment();
  const events = [], bookings = [];
  const db = { CitaPaciente: { findByPk: async (id, { transaction, lock }) => {
    assert.equal(id, 51); assert.equal(lock, 'UPDATE');
    const row = { ...structuredClone(transaction.row), toJSON: () => structuredClone(transaction.row),
      update: async (values, options) => { assert.equal(options.transaction, transaction);
        transaction.row = { ...transaction.row, ...structuredClone(values) }; return { ...transaction.row }; } };
    return row;
  } }, PatientOperationalEvent: { create: async (event, { transaction }) => {
    if (failEvent) throw Error('event_failed'); transaction.events.push(event);
  } }, sequelize: { transaction: async (options, callback) => {
    const tx = { options, LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' }, row: structuredClone(state), events: [] };
    const result = await callback(tx); state = tx.row; events.push(...tx.events); return result;
  } } };
  for (const model of ['AppointmentClinicalReport', 'PatientNutritionMeasurement', 'PatientNutritionReport',
    'PatientConsentDocument', 'PatientVoucherMovement', 'PatientProgramSession']) {
    db[model] = { findOne: async ({ transaction, lock }) => { assert(transaction); assert.equal(lock, 'SHARE'); return model === dependency ? { id: 1 } : null; } };
  }
  const exports = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../services/appointmentImportResolution.service'), 'utf8'), {
    module: exports, Date, Number, JSON,
    require: name => name === './appointmentBookingCommand.service' ? { mutateAppointmentBooking: async args => {
      bookings.push(args); if (bookingError) throw Object.assign(Error(bookingError), { code: bookingError });
      const existing = await db.CitaPaciente.findByPk(51, { transaction: args.transaction, lock: 'UPDATE' });
      return args.persist({ values: { ...existing.toJSON(), ...args.appointmentValues }, existing, transaction: args.transaction });
    } } : name === 'node:crypto' ? require(name)
      : name === '../lib/appointment-import-review' ? review : require('../../services/treatmentBookingProfile.service'),
  });
  const request = () => ({ mode: 'treatment', treatment_id: 3, reason: 'Revisado con clínica', expected_version: review.importReviewVersion(state) });
  return { db, events, bookings, get row() { return state; }, set row(v) { state = v; }, request,
    run: (input = request(), overrides = {}) => exports.exports.resolveImportedTreatment({ db, appointmentId: 51,
      clinicId: 72, actorId: 7, input, capabilities: { simple: true, multi: true }, ...overrides }) };
}

test('resolution validates explicit clinical choice, reason and stale-read precondition', () => {
  const version = 'a'.repeat(64);
  for (const input of [null, {}, { mode: 'other', expected_version: version, reason: 'Valid' },
    { mode: 'no_treatment', expected_version: version, reason: 'Valid', visit_type: 'urgencia' },
    { mode: 'treatment', expected_version: version, reason: 'Valid', treatment_id: '5' },
    { mode: 'treatment', expected_version: version, reason: ' ', treatment_id: 5 },
    { mode: 'no_treatment', expected_version: version, reason: 'Valid', treatment_id: 5, visit_type: 'revision' }]) {
    assert.throws(() => normalizeResolution(input), { code: 'booking_import_invalid' });
  }
});
test('version detects identity, notes, interval and HOLD changes, ignoring joined decoration', () => {
  const row = appointment(), version = review.importReviewVersion(row);
  assert.match(version, /^[a-f0-9]{64}$/);
  assert.equal(review.importReviewVersion({ ...row, paciente: { nombre: 'Ficticio' } }), version);
  assert.equal(review.importReviewVersion({ ...row, inicio: new Date(row.inicio) }), version);
  assert.equal(review.importReviewVersion({ ...row, updated_at: undefined }), null);
  for (const field of ['paciente_id', 'clinica_id', 'nota', 'estado', 'import_metadata']) {
    assert.notEqual(review.importReviewVersion({ ...row, [field]: field === 'import_metadata' ? {} : 'changed' }), version);
  }
});
test('treatment resolution preserves identity, source, HOLD, notes and interval with one canonical event', async () => {
  const f = fixture(), before = structuredClone(f.row), input = f.request();
  const result = await f.run({ ...input, inicio: '2099-01-01', clinica_id: 99, estado: 'completada', force: true });
  assert.equal(result.replayed, false); assert.equal(f.row.tratamiento_id, 3);
  for (const field of ['id_cita', 'paciente_id', 'clinica_id', 'inicio', 'fin', 'estado', 'nota', 'titulo', 'source_system', 'source_reference']) assert.deepEqual(f.row[field], before[field]);
  assert.deepEqual(f.row.import_metadata.notification_suppression, before.import_metadata.notification_suppression);
  assert.deepEqual(f.row.import_metadata.cliniccloud_delta, before.import_metadata.cliniccloud_delta);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].event_type, 'appointment.import_resolved');
  assert.equal(f.bookings[0].force, undefined); assert.equal(f.bookings[0].allowObsolete, undefined);
  assert.equal(f.bookings[0].transaction.options.isolationLevel, 'READ COMMITTED');
  assert.deepEqual(review.appointmentImportReview(f.row).pending_assignment, []);
  f.row = { ...f.row, nota: 'A later clinical note', updated_at: '2026-09-22T00:00Z' };
  assert.equal((await f.run(input)).replayed, true);
  assert.equal(f.row.nota, 'A later clinical note'); assert.equal(f.events.length, 1); assert.equal(f.bookings.length, 1);
});
test('an explicit review without treatment is recorded and no longer mistaken for unresolved care', async () => {
  const f = fixture();
  await f.run({ mode: 'no_treatment', visit_type: 'revision', expected_version: f.request().expected_version, reason: 'Solo revisión' });
  assert.equal(f.row.tratamiento_id, null); assert.equal(f.row.tipo_cita, 'revision');
  assert.equal(review.hasReviewedNoTreatment(f.row), true);
  assert.equal(review.appointmentImportReview(f.row).treatment_resolution, 'no_treatment');
  assert.deepEqual(review.appointmentImportReview(f.row).pending_assignment, []);
  assert.equal((await assessAppointmentClinicalConsent({ db: {}, appointment: f.row, transaction: {} })).allowed, true);
  assert.equal(review.hasReviewedNoTreatment({ ...f.row, paciente_id: 1234 }), false);
  assert.equal(review.hasReviewedNoTreatment({ ...f.row, tipo_cita: 'continuacion' }), false);
});
test('unresolved imported treatment blocks clinical completion, including a raw revision label', async () => {
  for (const tipo_cita of ['continuacion', 'revision']) {
    await assert.rejects(assessAppointmentClinicalConsent({ db: {}, appointment: { ...appointment(), tipo_cita }, transaction: {} }),
      { code: 'appointment_consent_import_review_required' });
  }
});
test('stale edits, reassignment of clinic and gates fail before booking', async () => {
  const f = fixture(), input = f.request(); f.row = { ...f.row, nota: 'Changed' };
  await assert.rejects(f.run(input), { code: 'booking_import_changed' });
  await assert.rejects(f.run(f.request(), { clinicId: 99 }), { code: 'booking_import_not_found' });
  await assert.rejects(f.run(f.request(), { capabilities: { simple: false } }), { code: 'booking_profile_runtime_unavailable' });
  assert.equal(f.bookings.length, 0); assert.equal(f.events.length, 0);
});
test('closed, purchased, native and already classified appointments cannot use import completion', async () => {
  for (const patch of [{ estado: 'completada' }, { estado: 'cancelada' }, { estado: 'no_asistio' },
    { voucher_id: 1 }, { tratamiento_id: 3 }, { source_system: null }, { es_provisional: true }, { hold_expires_at: '2030-01-07' }]) {
    const f = fixture(); f.row = { ...f.row, ...patch };
    await assert.rejects(f.run(), { code: 'booking_import_not_resolvable' }); assert.equal(f.bookings.length, 0);
  }
});
test('existing clinical, consent, nutrition or economic history blocks reinterpretation', async () => {
  for (const dependency of ['AppointmentClinicalReport', 'PatientNutritionMeasurement', 'PatientNutritionReport',
    'PatientConsentDocument', 'PatientVoucherMovement', 'PatientProgramSession']) {
    const f = fixture({ dependency });
    await assert.rejects(f.run(), { code: 'booking_import_history_exists' }); assert.equal(f.bookings.length, 0);
  }
});
test('event failure and canonical resource/priority conflicts leave the appointment unchanged', async () => {
  for (const options of [{ failEvent: true }, { bookingError: 'booking_unavailable' }, { bookingError: 'booking_priority_confirmation_required' }]) {
    const f = fixture(options), before = structuredClone(f.row);
    await assert.rejects(f.run()); assert.deepEqual(f.row, before); assert.equal(f.events.length, 0);
  }
});
test('ordinary HTTP and booking paths cannot forge a no-treatment review marker', () => {
  const controller = fs.readFileSync(require.resolve('../../controllers/citas.controller'), 'utf8');
  const command = fs.readFileSync(require.resolve('../../services/appointmentBookingCommand.service'), 'utf8');
  assert.match(controller, /delete baseImportMetadata\.import_treatment_resolution/);
  assert.match(command, /delete importMetadata\.import_treatment_resolution/);
});

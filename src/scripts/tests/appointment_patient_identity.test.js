'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeAppointmentClinicId, prospectiveAppointmentPatientIdentity, withAppointmentPatientIdentity } = require('../../lib/appointment-patient-identity');
const { assessment } = require('../../lib/booking-restriction-confirmation');

test('appointment clinic identity accepts integer/string equivalence without coercing other JSON types', () => {
  for (const value of [35, '35', ' 35 ', '035']) assert.equal(normalizeAppointmentClinicId(value), 35);
  for (const value of [null, undefined, true, false, [], {}, '', 'bad', '35x', '35.0', 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeAppointmentClinicId(value), { code: 'booking_patient_identity_invalid', statusCode: 400 });
  }
});
const draft = () => ({ clinicId: 35, leadId: 701,
  patient: { nombre: 'Paciente Ficticio', apellidos: 'Prueba', telefono: '+34 600 000 001', email: ' qa@example.invalid ', idioma_preferido: 'es' } });
test('prospective patient receipt is stable across clinic representations and normalized contact formatting', () => {
  const f = draft(), original = prospectiveAppointmentPatientIdentity(f);
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(prospectiveAppointmentPatientIdentity({ ...f, clinicId: '35', patient: { ...f.patient,
    telefono: '34600000001', email: 'QA@EXAMPLE.INVALID' } }), original);
  assert.equal(prospectiveAppointmentPatientIdentity({ ...f, patient: { ...f.patient, prospectivePatientIdentity: 'spoofed',
    id_paciente_creado: 999, created: false } }), original, 'Unrecognized client fields never supply the receipt identity');
});
test('changed lead, clinic, patient contact, name or language cannot reuse another prospective receipt', () => {
  const f = draft(), original = prospectiveAppointmentPatientIdentity(f);
  for (const patch of [{ clinicId: 36 }, { leadId: 702 }, ...Object.entries({ nombre: 'Otra persona', apellidos: 'Otra',
    telefono: '34600000002', email: 'other@example.invalid', idioma_preferido: 'ca', titulo: 'Otro título' })
    .map(([key, value]) => ({ patient: { ...f.patient, [key]: value } }))]) {
    assert.notEqual(prospectiveAppointmentPatientIdentity({ ...f, ...patch }), original);
  }
});

function transactionFixture() {
  const calls = [], transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const db = { sequelize: { transaction: async (options, work) => {
    calls.push(['begin', options]); try { const result = await work(transaction); calls.push(['commit']); return result; }
    catch (error) { calls.push(['rollback']); throw error; }
  }, query: async (sql, options) => {
    calls.push(['query', sql, options]);
    if (sql.startsWith('SELECT id_clinica')) return [[{ id_clinica: 35, grupoClinicaId: 50 }]];
    if (sql.startsWith('SELECT next_number')) return [[{ next_number: '7' }]];
    return [[], {}];
  } }, Clinica: { findByPk: async () => { throw Error('CLINIC_EXCLUSIVE_LOCK_BEFORE_NHC_IS_FORBIDDEN'); } } };
  return { db, transaction, calls };
}
test('contact resolution and booking work lock the native NHC scope first without consuming a number or locking the clinic exclusively', async () => {
  const f = transactionFixture(), input = draft();
  const output = await withAppointmentPatientIdentity({ db: f.db, clinic: { id_clinica: '35' }, patient: input.patient, leadId: input.leadId,
    resolve: async transaction => { assert.equal(transaction, f.transaction); f.calls.push(['resolve']); return { patient: { id_paciente: 10 }, created: true }; },
    work: async value => { assert.equal(value.transaction, f.transaction); assert.equal(value.created, true);
      assert.equal(value.prospectivePatientIdentity, prospectiveAppointmentPatientIdentity(input)); f.calls.push(['work']); return 'saved'; } });
  assert.equal(output, 'saved'); assert.deepEqual(f.calls.map(x => x[0]), ['begin', 'query', 'query', 'query', 'resolve', 'work', 'commit']);
  assert.equal(f.calls[0][1].isolationLevel, 'READ COMMITTED');
  const queries = f.calls.filter(x => x[0] === 'query');
  assert(queries.every(x => x[2].transaction === f.transaction));
  assert.equal(queries[0][2].replacements.clinicId, 35);
  assert.match(queries[1][1], /^INSERT INTO PatientHistoryCounters/);
  assert.match(queries[2][1], /^SELECT next_number.*FOR UPDATE$/);
  assert.equal(queries[2][2].replacements.scope, 'group:50');
  assert(!queries.some(x => /next_number\s*=\s*next_number\s*\+/.test(x[1])), 'Identity serialization never consumes an NHC');
  assert(!queries.some(x => /Clinicas.*FOR UPDATE/.test(x[1])), 'The counter-to-clinic-FK order must not be inverted');
});
test('existing explicit patient retains its durable ID and does not receive a prospective identity', async () => {
  const f = transactionFixture(); let observed;
  await withAppointmentPatientIdentity({ db: f.db, clinic: { id_clinica: 35 }, patient: { id_paciente: 20 },
    resolve: async () => ({ patient: { id_paciente: 20 }, created: false }), work: async input => { observed = input; } });
  assert.equal(observed.prospectivePatientIdentity, null); assert.equal(observed.patient.id_paciente, 20);
  assert(!f.calls.some(x => x[0] === 'query'), 'An explicit durable patient needs no creation counter lock');
});
test('a rejected booking rejects the enclosing transaction instead of committing a new patient alone', async () => {
  const f = transactionFixture();
  await assert.rejects(withAppointmentPatientIdentity({ db: f.db, clinic: { id_clinica: 35 }, patient: draft().patient,
    resolve: async () => ({ patient: { id_paciente: 22 }, created: true }), work: async () => {
      throw Object.assign(Error('Confirmar ocupación'), { code: 'booking_restriction_confirmation_required' });
    } }), { code: 'booking_restriction_confirmation_required' });
  assert.equal(f.calls.at(-1)[0], 'rollback'); assert(!f.calls.some(x => x[0] === 'commit'));
});
test('malformed resolution is rejected before invoking the reservation writer', async () => {
  for (const resolved of [null, { patient: { id_paciente: 0 }, created: true }, { patient: { id_paciente: 22 }, created: 'true' }]) {
    const f = transactionFixture(); let worked = false;
    await assert.rejects(withAppointmentPatientIdentity({ db: f.db, clinic: { id_clinica: 35 }, patient: draft().patient,
      resolve: async () => resolved, work: async () => { worked = true; } }), /appointment_patient_resolution_invalid/);
    assert.equal(worked, false); assert.equal(f.calls.at(-1)[0], 'rollback');
  }
});

function busyFixture() {
  const windows = [{ start: '2030-01-11T08:00:00.000Z', end: '2030-01-11T19:00:00.000Z' }];
  const busy = [{ start: '2030-01-11T10:00:00.000Z', end: '2030-01-11T10:05:00.000Z', appointment_id: 501 }];
  return { profile: { version: 1, phases: [{ key: 'manual', label: 'Primera sin tratamiento', duration_minutes: 16,
    installation_ids: [101], professionals: { mode: 'any', ids: [1], preferred_id: 1 } }] },
    start: '2030-01-11T09:55:00.000Z', selections: { manual: { doctor_id: 1, installation_id: 101 } },
    clinicId: 35, patientId: 10, actorId: 1, context: { timeZone: 'Europe/Madrid', clinicWindows: windows, patientBusy: [],
      doctors: new Map([[1, { name: 'Profesional ficticio', windows, busy }]]),
      installations: new Map([[101, { name: 'Box ficticio', windows, busy }]]) } };
}
test('new patient warning stays valid after rollback consumes another AUTO_INCREMENT ID', () => {
  const f = busyFixture(), identity = prospectiveAppointmentPatientIdentity(draft());
  const first = assessment({ ...f, prospectivePatientIdentity: identity });
  assert.equal(first.canConfirm, true); assert.equal(first.confirmed, false);
  assert.deepEqual(first.restrictions.map(x => x.code).sort(), ['INSTALLATION_OVERLAP', 'STAFF_OVERLAP']);
  const confirmed = assessment({ ...f, patientId: 999, prospectivePatientIdentity: identity, acknowledgement: first.acknowledgement });
  assert.equal(confirmed.confirmed, true); assert.equal(confirmed.acknowledgement, first.acknowledgement);
  assert.equal(assessment({ ...f, patientId: 999, prospectivePatientIdentity: prospectiveAppointmentPatientIdentity({ ...draft(), leadId: 702 }),
    acknowledgement: first.acknowledgement }).confirmed, false);
});
test('existing patient receipts still require their actual patient identity', () => {
  const f = busyFixture(), first = assessment(f);
  assert.equal(assessment({ ...f, acknowledgement: first.acknowledgement }).confirmed, true);
  assert.equal(assessment({ ...f, patientId: 11, acknowledgement: first.acknowledgement }).confirmed, false);
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { attach } = require('../../services/personalScheduleProgramRead.service');
const publicId = 'e8567ea0-0ae4-4daa-af49-16990051035d';
const profile = { version: 1, phases: [{ key: 'one', duration_minutes: 30,
  installation_ids: [9], professionals: { mode: 'any', ids: [5], preferred_id: 5 } }] };
function appointment() { return { id_cita: 10, clinica_id: 1, paciente_id: 11, voucher_id: 12,
  source_system: 'treatment_program', inicio: '2030-01-07T09:00:00Z', fin: '2030-01-07T09:30:00Z',
  import_metadata: { program_session: { session_id: 13, key: 's1' }, booking: { version: 1, profile,
    phases: [{ key: 'one', label: 'Clinical private label', start_at: '2030-01-07T09:00:00Z', end_at: '2030-01-07T09:30:00Z',
      installation_id: 9, doctor_ids: [5], staff_time_scope: 'phase' }] } } }; }
function database({ patientId = 11, clinicId = 1 } = {}) {
  const calls = [];
  return { calls,
    PatientProgramSession: { findAll: async q => { calls.push(q); assert.deepEqual(q.where.appointment_id[Op.in], [10]);
      return [{ id: 13, appointment_id: 10, voucher_id: 12, session_key: 's1', position: 0 }]; } },
    PatientVoucher: { findAll: async q => { calls.push(q); return [{ id: 12, public_id: publicId, clinic_id: clinicId,
      patient_id: patientId, name: 'Programa ficticio', total_units: 3, source_system: 'treatment_program' }]; } } };
}
test('Personal impact reads canonical public program identity and actual phase resources only with clinical scope', async () => {
  const row = appointment(), db = database(), acl = [];
  await attach({ db, appointments: [row], actorId: 7, accessibleClinics: async input => { acl.push(input); return [1]; } });
  assert.deepEqual(acl, [{ actorId: 7, featureKey: 'patients.sensitive.view', clinicIds: [1] }]);
  assert.equal(row.program_context.voucher_id, publicId); assert.equal(row.program_context.session_key, 's1');
  assert.equal(row.program_context.session_number, 1); assert.equal(row.program_context.session_count, 3);
  assert.equal(row.booking_segments.length, 1); assert.equal(row.booking_segments[0].phase_key, 'one');
  assert.equal(row.booking_segments[0].installation_id, 9); assert.deepEqual(row.booking_segments[0].doctor_ids, [5]);
  assert.equal(row.booking_segments[0].label, ''); assert.equal(db.calls.length, 2);
});
test('schedule management alone never exposes public purchase identity or resource snapshot', async () => {
  for (const actorId of [7, null]) {
    const row = appointment(), db = database(); row.program_context = { voucher_id: 'stale' }; row.booking_segments = [{ doctor_ids: [999] }];
    await attach({ db, appointments: [row], actorId, accessibleClinics: async () => [] });
    assert.deepEqual(row.program_context, { kind: 'program', status: 'unavailable' });
    assert.deepEqual(row.booking_segments, []); assert.equal(db.calls.length, 0);
  }
});
test('forged/cross-patient/cross-clinic program metadata cannot supply a planner identity', async () => {
  for (const change of [{ patientId: 999 }, { clinicId: 999 }]) {
    const row = appointment(); await attach({ db: database(change), appointments: [row], actorId: 7, accessibleClinics: async () => [1] });
    assert.deepEqual(row.program_context, { kind: 'program', status: 'unavailable' });
  }
  const row = appointment(); row.import_metadata.program_session.key = 'forged';
  await attach({ db: database(), appointments: [row], actorId: 7, accessibleClinics: async () => [1] });
  assert.deepEqual(row.program_context, { kind: 'program', status: 'unavailable' });
});
test('legacy ordinary rows add no queries or ACL work and stale projections are cleared', async () => {
  const row = { id_cita: 10, clinica_id: 1, program_context: { voucher_id: 'stale' }, booking_segments: [{}] }, db = database();
  await attach({ db, appointments: [row], actorId: 7, accessibleClinics: async () => { assert.fail('No ACL needed'); } });
  assert.equal(row.program_context, null); assert.deepEqual(row.booking_segments, []); assert.equal(db.calls.length, 0);
});
test('JSON and Sequelize rows retain metadata and invalid phase snapshot is not copied into the preview', async () => {
  const row = appointment(); row.import_metadata = JSON.stringify(row.import_metadata);
  const wrapped = { toJSON: () => row, setDataValue: (k,v) => { row[k] = v; } };
  await attach({ db: database(), appointments: [wrapped], actorId: 7, accessibleClinics: async () => [1] });
  assert.equal(typeof row.import_metadata, 'string'); assert.equal(row.booking_segments.length, 1);
  const invalid = appointment(); invalid.import_metadata.booking.phases[0].doctor_ids = [999];
  await attach({ db: database(), appointments: [invalid], actorId: 7, accessibleClinics: async () => [1] });
  assert.deepEqual(invalid.booking_segments, []);
});

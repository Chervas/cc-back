'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { prepareWeekAppointments, executeWeekAppointments, sourceReference } = require('../../lib/cliniccloud-import/week-appointments');
function fixture() {
  const snapshot = { database_target: 'crm', database_group_id: 29, source_account: 'cliniccloud-5880',
    complete_for: { clinic_ids: [66, 72] }, patients: [{ id: 7, source_contact_ids: ['90001'] }], appointments: [] };
  const source = { source_contact_id: '90001', start_local: '2026-09-21T10:00:00', end_local: '2026-09-21T10:30:00',
    start_utc: '2026-09-21T08:00:00.000Z', end_utc: '2026-09-21T08:30:00.000Z', agenda_key: 'CELIA', service_key: 'VALORACION',
    status: 'pendiente', details: 'Synthetic fixture only', validation_errors: [] };
  const action = { action_key: 'a', entity: 'appointment', action: 'create_appointment_candidate', source,
    patient_id: 7, reasons: ['RESOURCE_AND_SERVICE_MAP_REQUIRED'], candidate_local_ids: [], provenance: { file_sha256: 'a'.repeat(64), source_row: 5 } };
  const plan = { manifest: { source_system: 'cliniccloud', source_account: snapshot.source_account, snapshot_sha256: hash(snapshot),
    timezone: 'Europe/Madrid', automation_policy: 'hold', coverage: { start: '2026-09-01', end: '2026-12-31', authority: 'source_snapshot_plus_protected_native' } }, actions: [action] };
  plan.plan_sha256 = hash(plan);
  const decision = { action_key: 'a', disposition: 'create', reason: 'Exact external patient identity and reviewed calendar',
    assignment: { clinic_id: 72, doctor_id: 5, installation_id: null, treatment_id: 9, appointment_type: 'primera_con_trat' },
    pending_assignment: ['installation_id'], evidence: ['Source CELIA and confirmed Carlos mapping to Dra. Camacho'] };
  const review = { plan_sha256: plan.plan_sha256, reviewed_by: 'Automated operator under owner authorization', reviewed_at: '2026-09-20T20:00:00Z',
    week: { start: '2026-09-21', end: '2026-09-27' }, decisions: [decision] };
  return { snapshot, plan, review, target: 'crm', action, decision };
}
function memoryStore() {
  let rows = [], reasons = [], failRead = false;
  const store = {
    transaction: async callback => { const before = structuredClone(rows); try { return await callback(store); } catch (e) { rows = before; throw e; } },
    findSource: async reference => rows.find(r => r.source_reference === reference),
    validate: async () => ({ reasons }),
    insert: async payload => { const row = { ...structuredClone(payload), id_cita: rows.length + 1 }; rows.push(row); return row.id_cita; },
    read: async id => failRead ? null : rows.find(r => r.id_cita === id),
  };
  return { store, rows: () => rows, defer: v => { reasons = v; }, failRead: () => { failRead = true; } };
}
function execution(pkg, store) {
  const entries = [];
  return { pkg, store, journal: { append: async row => entries.push(structuredClone(row)) }, entries,
    now: () => Date.parse('2026-09-20T21:00:00Z'), approval: { package_sha256: pkg.package_sha256, automation_policy: 'hold', confirm_create_only: true,
      reviewed_by: 'QA operator', backup_manifest_sha256: 'a'.repeat(64), expires_at: '2026-09-21T00:00:00Z' } };
}
test('review preserves source times and explicitly records an unknown cabin instead of inventing one', () => {
  const pkg = prepareWeekAppointments(fixture());
  assert.equal(pkg.operations[0].assignment.installation_id, null);
  assert.deepEqual(pkg.operations[0].pending_assignment, ['installation_id']);
  assert.equal(pkg.operations[0].start_utc, '2026-09-21T08:00:00.000Z');
  assert.equal(pkg.changes_existing_appointments, false);
});
test('missing assignments must be explicit and a source ambiguity cannot be waved through', () => {
  const f = fixture(); f.decision.pending_assignment = [];
  assert.throws(() => prepareWeekAppointments(f), /WEEK_MISSING_ASSIGNMENT_MUST_BE_EXPLICIT/);
  f.decision.pending_assignment = ['installation_id']; f.action.reasons.push('POSSIBLE_RESCHEDULE_OR_NATIVE_DUPLICATE');
  f.plan.plan_sha256 = hash({ manifest: f.plan.manifest, actions: f.plan.actions }); f.review.plan_sha256 = f.plan.plan_sha256;
  assert.throws(() => prepareWeekAppointments(f), /WEEK_CREATION_NOT_UNAMBIGUOUS/);
});
test('mismatched target, patient link and dates fail before SQL', () => {
  const f = fixture(); f.target = 'dev'; assert.throws(() => prepareWeekAppointments(f), /TARGET_OR_SCOPE/);
  f.target = 'crm'; f.action.patient_id = 8;
  f.plan.plan_sha256 = hash({ manifest: f.plan.manifest, actions: f.plan.actions }); f.review.plan_sha256 = f.plan.plan_sha256;
  assert.throws(() => prepareWeekAppointments(f), /WEEK_PATIENT_LINK_AMBIGUOUS/);
  f.action.patient_id = 7; f.action.source.start_utc = '2026-09-21T10:00:00.000Z';
  f.plan.plan_sha256 = hash({ manifest: f.plan.manifest, actions: f.plan.actions }); f.review.plan_sha256 = f.plan.plan_sha256;
  assert.throws(() => prepareWeekAppointments(f), /WEEK_SOURCE_INTERVAL_INVALID/);
});
test('fingerprint is independent of source row/export ordering, notes and state but not the visit slot', () => {
  const source = fixture().action.source;
  assert.equal(sourceReference(source), sourceReference({ ...source, details: 'edited', status: 'cancelada' }));
  assert.notEqual(sourceReference(source), sourceReference({ ...source, start_local: '2026-09-22T10:00:00' }));
});
test('HOLD creation is journaled and replay preserves later user edits', async () => {
  const pkg = prepareWeekAppointments(fixture()), f = memoryStore(), options = execution(pkg, f.store);
  const first = await executeWeekAppointments(options);
  assert.equal(first.created, 1); assert.equal(first.messages_sent, 0);
  assert.deepEqual(f.rows()[0].import_metadata.notification_suppression, { appointment_details: true, day_before: true, same_day: true });
  f.rows()[0].nota = 'Later staff note';
  assert.equal((await executeWeekAppointments(options)).replayed, 1); assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].nota, 'Later staff note');
  assert.deepEqual(options.entries.map(e => e.phase), ['week_prepared', 'week_committed', 'week_already_applied']);
});
test('a live patient conflict defers the source row without changing the native appointment', async () => {
  const pkg = prepareWeekAppointments(fixture()), f = memoryStore(); f.defer(['CURRENT_PATIENT_SLOT_REQUIRES_RECONCILIATION']);
  const result = await executeWeekAppointments(execution(pkg, f.store)); assert.equal(result.deferred, 1); assert.equal(f.rows().length, 0);
});
test('failed persistence or failed durable intent rolls back the entire row', async () => {
  const pkg = prepareWeekAppointments(fixture()), f = memoryStore(); f.failRead();
  await assert.rejects(executeWeekAppointments(execution(pkg, f.store)), /WEEK_INSERT_VERIFICATION_FAILED/); assert.equal(f.rows().length, 0);
  const next = memoryStore(), options = execution(pkg, next.store); options.journal.append = async () => { throw Error('DISK_FULL'); };
  await assert.rejects(executeWeekAppointments(options), /DISK_FULL/); assert.equal(next.rows().length, 0);
});
test('a lost journal acknowledgement after commit can be replayed without another creation', async () => {
  const pkg = prepareWeekAppointments(fixture()), f = memoryStore(), options = execution(pkg, f.store);
  options.journal.append = async row => { if (row.phase === 'week_committed') throw Error('LOST_ACK'); };
  await assert.rejects(executeWeekAppointments(options), /LOST_ACK/); assert.equal(f.rows().length, 1);
  const replay = await executeWeekAppointments(execution(pkg, f.store)); assert.equal(replay.replayed, 1);
});
test('expired approval or tampered package never writes', async () => {
  const pkg = prepareWeekAppointments(fixture()), f = memoryStore(), options = execution(pkg, f.store);
  options.approval.expires_at = '2026-09-20T20:59:59Z';
  await assert.rejects(executeWeekAppointments(options), /WEEK_APPROVAL_REQUIRED/);
  pkg.operations[0].patient_id = 99;
  await assert.rejects(executeWeekAppointments(options), /WEEK_PACKAGE_INVALID/); assert.equal(f.rows().length, 0);
});

'use strict';
// Offline domain executor + real follow-up service using in-memory transactional
// model doubles. Never opens a DB connection or sends a notification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Op } = require('sequelize');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const primary = require('../../lib/cliniccloud-import/primary-clinics');
const apply = require('../../lib/cliniccloud-import/primary-followups-apply');
const clone = value => JSON.parse(JSON.stringify(value));
const BEFORE = '2026-09-07T01:00:00.000Z', AFTER = '2026-09-07T05:00:00.000Z';
function fixture() {
  const sourcePatient = { id: 8, clinic_id: 72, source_contact_ids: ['100'], source_history_numbers: ['300'] };
  const snapshot = { source_account: apply.ACCOUNT, database_group_id: 9, patients: [sourcePatient] };
  const live = { captured_at: AFTER, clinics: [{ id_clinica: 66, grupoClinicaId: 9 }, { id_clinica: 72, grupoClinicaId: 9 }],
    patients: [{ id_paciente: 8, clinica_id: 72, updatedAt: BEFORE }], memberships: [{ id: 1, paciente_id: 8, clinica_id: 72, es_principal: true, updatedAt: BEFORE }],
    identities: [{ id: 1, paciente_id: 8, clinica_id: 72, source: 'cliniccloud', source_column: 'contacto_1.csv', field_key: 'raw_contact', value: JSON.stringify({ contact: { idContacto: '100', num: '300' } }) }], followups: [] };
  const evidence = [{ clinic_id: 66, treatment_date: '2020-01-01', source_contact_id: '100', treatment_id: 't1', paid_evidence: false }];
  const assignments = primary.assignmentPlan({ evidence, patients: snapshot.patients, memberships: live.memberships }).assignments;
  const alert = { source_external_id: '900', source_contact_id: '100', history_number: '300', kind: 'followup', body: 'Revisión capilar de prueba', contact_due_at: '2026-09-08T09:30:00', status: 'pending', validation_errors: [], provenance: { file_sha256: 'a'.repeat(64), row_sha256: 'b'.repeat(64), source_row: 2 } };
  const followups = primary.alertPlan({ alerts: [alert], patients: snapshot.patients, assignments, memberships: live.memberships }).rows;
  const plan = { manifest: { source_account: apply.ACCOUNT, snapshot_sha256: hash(snapshot), automation_policy: 'hold', files: [] }, assignments, followups };
  plan.plan_sha256 = hash(plan);
  return { snapshot, plan, live };
}
function prepare(f = fixture()) { return apply.prepare({ ...f, now: AFTER }); }
function database(live) {
  let state = { patients: clone(live.patients), memberships: clone(live.memberships), identities: clone(live.identities), followups: clone(live.followups), revisions: [], clinics: clone(live.clinics), users: [{ id_usuario: 7, estado_cuenta: 'activo' }] };
  const calls = [];
  function matches(row, where) { return Object.entries(where || {}).every(([key, value]) => value && typeof value === 'object' && value[Op.in] ? value[Op.in].includes(row[key]) : row[key] === value); }
  function wrap(row, table) { return Object.assign({}, row, { toJSON: () => clone(row), update: async values => { calls.push({ type: 'update', table, values: clone(values) }); Object.assign(row, values, { updatedAt: AFTER }); return wrap(row, table); } }); }
  function model(table, key = 'id') { return {
    findOne: async query => { const row = state[table].find(row => matches(row, query.where)); return row ? wrap(row, table) : null; },
    findAll: async query => state[table].filter(row => matches(row, query.where)).map(row => wrap(row, table)),
    create: async values => { calls.push({ type: 'create', table, values: clone(values) }); const row = { [key]: Math.max(0, ...state[table].map(row => row[key] || 0)) + 1, ...clone(values), updatedAt: AFTER }; state[table].push(row); return wrap(row, table); },
  }; }
  return { state: () => state, calls,
    db: { Sequelize: { Op }, Paciente: model('patients', 'id_paciente'), PacienteClinica: model('memberships'), PatientCustomField: model('identities'), PatientFollowUp: model('followups'), PatientFollowUpRevision: model('revisions'), Clinica: model('clinics', 'id_clinica'), Usuario: model('users', 'id_usuario'), Tratamiento: { findAll: async () => [] }, CitaPaciente: { findAll: async () => [] },
      sequelize: { transaction: async callback => { const before = clone(state); try { return await callback({ LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } }); } catch (error) { state = before; throw error; } } } },
  };
}
function journal() { const rows = []; return { rows, latestPatient: (id, digest) => [...rows].reverse().find(row => row.patient_id === id && row.prepared_sha256 === digest), append: async row => { rows.push(clone(row)); } }; }
function executor(f = fixture()) { const prepared = prepare(f), store = database(f.live), log = journal(); return { prepared, store, log, service: apply.createExecutor({ db: store.db, journal: log, now: () => new Date(AFTER) }), args: { prepared, approvedHash: prepared.prepared_sha256, actorId: 7 } }; }

test('prepare recomputes a safe subset without mutations and keeps original alert date/NUM', () => {
  const f = fixture(), before = hash(f), result = prepare(f);
  assert.equal(hash(f), before);
  assert.equal(result.summary.primary_moves, 1); assert.equal(result.summary.memberships_add, 1); assert.equal(result.summary.followups_create, 1);
  const row = result.operations.find(row => row.entity === 'followup');
  assert.equal(row.payload.contact_due_date, '2026-09-08'); assert.equal(row.payload.clinical_target_date, null);
  assert.equal(row.history_number, '300'); assert.equal(row.source_contact_id, '100'); assert.equal(row.importedSource.reference, 'alert:900');
  assert.equal(row.importedSource.kind, 'cliniccloud_alert'); assert.equal(result.messages_enabled, false);
});
test('NUM/source identity drift and a globally duplicated exact source ID quarantine decisions', () => {
  const f = fixture(); f.live.identities[0].value = JSON.stringify({ contact: { idContacto: '100', num: '100' } });
  assert.equal(prepare(f).operations.length, 0);
  const second = fixture(); second.live.identities.push({ ...second.live.identities[0], id: 2, paciente_id: 9 });
  assert.equal(prepare(second).operations.length, 0);
});
test('new contact snapshot resolves NUM independently and deduplicates the scalar legacy ID marker', () => {
  const f = fixture();
  f.live.identities = [
    { id: 1, paciente_id: 8, clinica_id: 72, source: 'cliniccloud', source_column: 'cliniccloud_contact_snapshot', field_key: 'cliniccloud_contact_snapshot', value: JSON.stringify({ version: 'cliniccloud_contact_snapshot/1', source_account: apply.ACCOUNT, contact: { idContacto: '100', num: '300', alta: '01/01/2026' }, fields: { phone: 'fixture only' }, provenance: { file_sha256: 'a'.repeat(64) } }) },
    { id: 2, paciente_id: 8, clinica_id: 72, source: 'cliniccloud', source_column: 'idContacto', field_key: 'cliniccloud_source_contact_id', value: '100' },
  ];
  assert.deepEqual(apply.identityOf(f.live.patients[0], f.live.identities), { source_contact_ids: ['100'], source_history_numbers: ['300'] });
  assert.equal(prepare(f).summary.followups_create, 1);
  f.live.identities.push({ ...f.live.identities[0], id: 3, paciente_id: 9 });
  assert.equal(prepare(f).operations.length, 0, 'New markers participate in the global exact-identity collision index');
});
test('new identity marker rejects another source account/version and ignores other patients/sources', () => {
  const marker = { paciente_id: 8, source: 'cliniccloud', source_column: 'cliniccloud_contact_snapshot', value: { version: 'cliniccloud_contact_snapshot/1', source_account: apply.ACCOUNT, contact: { idContacto: 100, num: 300 } } };
  assert.deepEqual(apply.identityOf({ id_paciente: 8 }, [marker]), { source_contact_ids: ['100'], source_history_numbers: ['300'] });
  assert.deepEqual(apply.identityOf({ id_paciente: 9 }, [marker]), { source_contact_ids: [], source_history_numbers: [] });
  assert.deepEqual(apply.identityOf({ id_paciente: 8 }, [{ ...marker, source: 'another_source' }]), { source_contact_ids: [], source_history_numbers: [] });
  assert.throws(() => apply.identityOf({ id_paciente: 8 }, [{ ...marker, value: { ...marker.value, source_account: 'other-account' } }]), /UNSUPPORTED_LOCAL_IDENTITY_SNAPSHOT/);
  assert.throws(() => apply.identityOf({ id_paciente: 8 }, [{ ...marker, value: { ...marker.value, version: 'future-version' } }]), /UNSUPPORTED_LOCAL_IDENTITY_SNAPSHOT/);
});
test('tampered plan, contact date and expanded membership cannot be applied', () => {
  const f = fixture(); f.plan.assignments[0].proposed_clinic_id = 1;
  assert.throws(() => prepare(f), /PLAN_HASH_MISMATCH/);
  const g = fixture(); g.plan.followups[0].payload.contact_due_date = '2026-08-08'; delete g.plan.plan_sha256; g.plan.plan_sha256 = hash(g.plan);
  assert.throws(() => prepare(g), /IMPORTED_ALERT_DATE_SEMANTICS_CHANGED/);
  const h = fixture(); h.plan.assignments[0].memberships.ensure.push(999); delete h.plan.plan_sha256; h.plan.plan_sha256 = hash(h.plan);
  assert.throws(() => prepare(h), /UNSAFE_MEMBERSHIP_EXPANSION/);
});
test('a file locator never masquerades as an external ClinicCloud ID', () => {
  const f = fixture(); f.plan.followups[0].source_external_id = null; delete f.plan.plan_sha256; f.plan.plan_sha256 = hash(f.plan);
  const row = prepare(f).operations.find(row => row.entity === 'followup');
  assert.match(row.importedSource.reference, /^row:/); assert.equal(row.row_identity_requires_reconciliation_on_new_export, true);
});
test('possible repeat of a row-only identity from another export requires reconciliation', () => {
  const f = fixture();
  f.live.followups.push({ id: 50, public_id: 'previous-export', patient_id: 8, clinic_id: 66, source_namespace: apply.ACCOUNT, source_reference: 'row:older-file:2:older-row', source_key: 'e'.repeat(64), clinical_notes: f.plan.followups[0].payload.clinical_notes });
  const p = prepare(f);
  assert.equal(p.summary.followups_create, 0);
  assert(p.conflicts.some(row => row.code === 'POSSIBLE_EXISTING_ROW_IDENTITY_REPEAT'));
});
test('apply atomically changes primary/membership and creates canonical followup/revision only', async () => {
  const x = executor(); await x.service.apply(x.args);
  assert.equal(x.store.state().patients[0].clinica_id, 66);
  assert.equal(x.store.state().memberships.find(row => row.clinica_id === 72).es_principal, false);
  assert.equal(x.store.state().memberships.find(row => row.clinica_id === 66).es_principal, true);
  assert.equal(x.store.state().followups.length, 1); assert.equal(x.store.state().revisions.length, 1);
  assert.equal(x.store.state().revisions[0].change_type, 'imported');
  assert.equal(x.store.state().identities.length, 1, 'No audit clutter written to patient custom fields');
  assert(x.store.calls.every(call => ['patients', 'memberships', 'followups', 'revisions'].includes(call.table)));
  assert.equal(x.log.rows[0].event, 'prepared_patient'); assert.equal(x.log.rows[1].event, 'committed_patient');
});
test('repeat uses journal/source identity without duplicate memberships/revisions or reopening local work', async () => {
  const x = executor(); await x.service.apply(x.args);
  x.store.state().followups[0].status = 'closed'; x.store.state().followups[0].version_number = 2;
  const again = await x.service.apply(x.args);
  assert.equal(again.resumed, 1); assert.equal(again.preserved_followups, 1);
  assert.equal(x.store.state().followups.length, 1); assert.equal(x.store.state().followups[0].status, 'closed');
  assert.equal(x.store.state().revisions.length, 1); assert.equal(x.store.state().memberships.length, 2);
});
test('closed and cancelled source alerts are imported as history without reopening', async () => {
  for (const status of ['closed', 'cancelled']) {
    const f = fixture(); f.plan.followups[0].payload.status = status; delete f.plan.plan_sha256; f.plan.plan_sha256 = hash(f.plan);
    const x = executor(f); await x.service.apply(x.args); assert.equal(x.store.state().followups[0].status, status);
  }
});
test('technical system import records nullable actor without impersonating user zero', async () => {
  const x = executor(); await x.service.apply({ ...x.args, actorId: null });
  assert.equal(x.store.state().followups[0].created_by, null);
  assert.equal(x.store.state().followups[0].updated_by, null);
  assert.equal(x.store.state().revisions[0].actor_id, null);
  assert.equal(x.store.state().revisions[0].change_type, 'imported');
  assert.equal(x.log.rows[0].actor_kind, 'system_import');
  const y = executor(); await assert.rejects(y.service.apply({ ...y.args, actorId: undefined }), /EXPLICIT_IMPORT_ACTOR_REQUIRED/);
});
test('patient edits, group changes and inactive actor fail before mutation', async () => {
  for (const mutation of [x => { x.store.state().patients[0].updatedAt = AFTER; }, x => { x.store.state().clinics[0].grupoClinicaId = 10; }, x => { x.store.state().users[0].estado_cuenta = 'disabled'; }]) {
    const x = executor(); mutation(x); await assert.rejects(x.service.apply(x.args)); assert.equal(x.store.calls.length, 0);
  }
});
test('a followup collision rolls primary and memberships back in the same patient transaction', async () => {
  const x = executor(); const row = x.prepared.operations.find(row => row.entity === 'followup');
  x.store.state().followups.push({ id: 44, public_id: 'other', patient_id: 9, clinic_id: 66, source_key: row.source_key });
  await assert.rejects(x.service.apply(x.args), /FOLLOWUP_SOURCE_CONTEXT_CHANGED/);
  assert.equal(x.store.state().patients[0].clinica_id, 72); assert.equal(x.store.state().memberships.length, 1); assert.equal(x.store.state().revisions.length, 0);
});
test('crash between commit and journal stops at ambiguity instead of guessing ownership', async () => {
  const x = executor(); x.log.append = async row => { if (row.event === 'committed_patient') throw new Error('DISK_UNAVAILABLE'); x.log.rows.push(clone(row)); };
  await assert.rejects(x.service.apply(x.args), /DISK_UNAVAILABLE/);
  assert.equal(x.store.state().patients[0].clinica_id, 66);
  await assert.rejects(x.service.apply(x.args), /AMBIGUOUS_PREVIOUS_PATIENT_TRANSACTION/);
  assert.equal(x.store.state().followups.length, 1);
});
test('unapproved prepared hash is rejected before any transaction', async () => {
  const x = executor(); await assert.rejects(x.service.apply({ ...x.args, approvedHash: '0'.repeat(64) }), /PREPARED_APPROVAL_HASH_MISMATCH/); assert.equal(x.store.calls.length, 0);
});
test('after-write verification rejects lost membership or silent primary update failure', async () => {
  const x = executor(); x.store.db.PacienteClinica.create = async () => ({});
  await assert.rejects(x.service.apply(x.args), /PRIMARY_AFTER_WRITE_VERIFICATION_FAILED/);
  assert.equal(x.store.state().patients[0].clinica_id, 72);
  assert.equal(x.store.state().followups.length, 0);
});
test('live SQL captures private alert text required for re-export conflict detection', () => {
  const runtime = fs.readFileSync(path.resolve(__dirname, '../../lib/cliniccloud-import/primary-followups-runtime.js'), 'utf8');
  assert.match(runtime, /SELECT id, public_id,[^\n]*clinical_notes[^\n]*FROM PatientFollowUps/);
  assert.match(runtime, /source_column IN \('idContacto','contacto_1\.csv','cliniccloud_contact_snapshot'\)/);
  assert.match(runtime, /START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY/);
  assert.doesNotMatch(runtime, /console\.(?:log|error)/);
});

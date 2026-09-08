'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { instant, normalizedRow, prepareAppointments, applyAppointments, verifyPackage } = require('../../lib/cliniccloud-import/appointments-apply');
const clone = value => JSON.parse(JSON.stringify(value));
const clock = () => Date.parse('2026-09-07T12:00:00Z');

function fixture() {
  const row = { id_cita: 1, paciente_id: 20, clinica_id: 72, doctor_id: 30, instalacion_id: 40, tratamiento_id: 50,
    source_system: 'cliniccloud', source_reference: 'appointment:123', estado: 'pendiente', inicio: '2026-09-08 07:00:00', fin: '2026-09-08 07:30:00',
    created_at: '2026-07-26 10:00:00', updated_at: '2026-07-26 10:00:00', voucher_id: null, lead_intake_id: null, es_provisional: 0, hold_expires_at: null,
    nota: 'Nota sintética que debe conservarse.', import_metadata: { source_appointment_id: '123', source_contact_id: '456', raw: { historic: 'synthetic' }, notification_suppression: { other: true } } };
  const local = { id: 1, patient_id: 20, clinic_id: 72, doctor_id: 30, installation_id: 40, treatment_id: 50, source_system: 'cliniccloud',
    source_reference: 'appointment:123', source_external_id: '123', source_contact_id: '456', status: 'pendiente', start_local: '2026-09-08T09:00:00', end_local: '2026-09-08T09:30:00', updated_at: row.updated_at };
  const snapshot = { source_account: 'cliniccloud-test', complete_for: { clinic_ids: [72, 66] }, appointments: [local], patients: [] };
  const action = { action_key: 'action-1', entity: 'appointment', action: 'update_imported_candidate', local_id: 1, expected_local_hash: hash(local), patient_id: 20,
    source_external_id: '123', reasons: [], provenance: { row_key: 'synthetic-row', row_sha256: 'synthetic' },
    source: { source_contact_id: '456', validation_errors: [], start_local: local.start_local, end_local: local.end_local, start_utc: '2026-09-08T07:00:00.000Z', end_utc: '2026-09-08T07:30:00.000Z', status: 'pendiente' } };
  const plan = { manifest: { source_system: 'cliniccloud', source_account: 'cliniccloud-test', automation_policy: 'hold', timezone: 'Europe/Madrid', snapshot_sha256: hash(snapshot), coverage: { start: '2026-08-01', end: '2026-12-31', authority: 'source_snapshot_plus_protected_native' } }, actions: [action] };
  const rehash = () => { plan.manifest.snapshot_sha256 = hash(snapshot); action.expected_local_hash = hash(local); plan.plan_sha256 = hash({ manifest: plan.manifest, actions: plan.actions }); };
  rehash();
  const context = { schema_sha256: 'synthetic', identity_unique: true, patient_scope: true, clinic_scope: true, doctor_scope: true, installation_scope: true, treatment_scope: true,
    overlap_count: 0, active_job_count: 0, automation_count: 0, references: { 'AppointmentClinicalReports.appointment_id': 0 } };
  const state = { row, context, writes: 0, transactions: 0, inspections: 0, commitFailure: false };
  const store = {
    inspect: async () => { state.inspections++; return { row: clone(state.row), context: clone(state.context) }; },
    transaction: async callback => {
      state.transactions++;
      let working = clone(state.row);
      await callback({ inspect: async () => ({ row: clone(working), context: clone(state.context) }), read: async () => clone(working),
        update: async (id, patch) => { state.writes++; working = { ...working, ...clone(patch) }; } });
      if (state.commitFailure) throw new Error('SIMULATED_COMMIT_FAILURE');
      state.row = working;
    },
  };
  const events = [], journal = { append: async event => { events.push(clone(event)); } };
  const prepare = () => prepareAppointments({ plan, snapshot, store, capturedAt: new Date(clock()).toISOString() });
  const approve = pkg => ({ package_sha256: pkg.package_sha256, reviewed_by: 'test-operator', reviewed_at: '2026-09-07T11:00:00Z', expires_at: '2026-09-07T13:00:00Z',
    backup_manifest_sha256: 'b'.repeat(64), automation_policy: 'hold', confirm_in_place_only: true, action_keys: pkg.operations.map(row => row.action_key) });
  const apply = (pkg, overrides = {}) => applyAppointments({ pkg, approval: approve(pkg), store, journal, now: clock, ...overrides });
  return { state, local, action, plan, snapshot, context, store, journal, events, rehash, prepare, approve, apply };
}

test('UTC is explicit regardless of machine timezone; row JSON key order has stable hash', () => {
  assert.equal(instant('2026-10-25 01:30:00'), '2026-10-25T01:30:00.000Z');
  assert.equal(instant('2026-07-01T12:00:00.123Z'), '2026-07-01T12:00:00.123Z');
  assert.throws(() => instant('07/09/2026 09:00'), { message: 'INVALID_UTC_DATABASE_TIMESTAMP' });
  const { state } = fixture(), other = clone(state.row);
  other.import_metadata = JSON.stringify(other.import_metadata);
  assert.equal(hash(normalizedRow(state.row)), hash(normalizedRow(other)));
});

test('preparation is read-only, binds complete before/context hashes and preserves existing identity/assignment', async () => {
  const f = fixture(), pkg = await f.prepare();
  assert.equal(pkg.operations.length, 1); assert.equal(pkg.summary.hold_only, 1); assert.equal(pkg.summary.state_changes_enabled, false);
  assert.equal(pkg.operations[0].expected_row_sha256, hash(normalizedRow(f.state.row)));
  assert.equal(f.state.writes, 0); assert.equal(f.state.transactions, 0);
  assert.equal(verifyPackage(pkg), undefined);
  const tampered = clone(pkg); tampered.operations[0].desired_status = 'cancelada';
  assert.throws(() => verifyPackage(tampered), { message: 'PACKAGE_INTEGRITY_MISMATCH' });
});

test('changed source states cannot be enabled by an operator declaration', async () => {
  const f = fixture(); f.action.source.status = 'completada'; f.rehash();
  const pkg = await f.prepare();
  assert.equal(pkg.operations.length, 0); assert(pkg.excluded[0].reasons.includes('STATE_CHANGE_EXECUTOR_DISABLED'));
  assert.equal(f.state.inspections, 0, 'unsupported state changes must not run detail SQL');
});

test('native/Graci, moved schedule, jobs, ambiguous identity, scope and dependent appointments are excluded', async () => {
  const cases = [
    [f => { f.state.row.source_system = null; }, 'NATIVE_APPOINTMENT_PROTECTED'],
    [f => { f.state.row.inicio = '2026-09-08 08:00:00'; }, 'SCHEDULE_CHANGE_NOT_SUPPORTED'],
    [f => { f.state.context.active_job_count = 1; }, 'AUTOMATION_ALREADY_PRESENT_REQUIRES_REVIEW'],
    [f => { f.state.context.identity_unique = false; }, 'CURRENT_FOREIGN_KEY_OR_SCOPE_CONFLICT'],
    [f => { f.state.context.installation_scope = false; }, 'CURRENT_FOREIGN_KEY_OR_SCOPE_CONFLICT'],
    [f => { f.state.context.overlap_count = 1; }, 'CURRENT_PATIENT_OVERLAP_REQUIRES_REVIEW'],
    [f => { f.state.row.voucher_id = 99; }, 'LINKED_OR_ADVANCED_APPOINTMENT_REQUIRES_REVIEW'],
  ];
  for (const [mutate, reason] of cases) { const f = fixture(); mutate(f); const pkg = await f.prepare(); assert.equal(pkg.operations.length, 0); assert(pkg.excluded[0].reasons.includes(reason), reason); }
});

test('only metadata/timestamp change, historical raw and unrelated suppression fields remain intact', async () => {
  const f = fixture(), before = clone(f.state.row), pkg = await f.prepare();
  const result = await f.apply(pkg);
  assert.equal(result.committed, 1); assert.equal(f.state.writes, 1);
  for (const key of Object.keys(before).filter(key => !['import_metadata', 'updated_at'].includes(key))) assert.deepEqual(f.state.row[key], before[key], key);
  const metadata = f.state.row.import_metadata;
  assert.deepEqual(metadata.raw, before.import_metadata.raw);
  assert.deepEqual(metadata.notification_suppression, { other: true, appointment_details: true, day_before: true, same_day: true });
  assert.equal(metadata.cliniccloud_reconciliation.applied['action-1'].events_dispatched, false);
  assert.equal(metadata.cliniccloud_reconciliation.automation_policy, 'hold');
  assert.deepEqual(f.events.map(event => event.phase), ['prepared', 'committed']);
});

test('replay and a later user change never overwrite state or create another mutation', async () => {
  const f = fixture(), pkg = await f.prepare(); await f.apply(pkg);
  f.state.row.nota = 'Edición local posterior';
  f.state.row.estado = 'info_confirmada';
  const result = await f.apply(pkg);
  assert.equal(result.already_applied, 1); assert.equal(f.state.writes, 1);
  assert.equal(f.state.row.nota, 'Edición local posterior'); assert.equal(f.state.row.estado, 'info_confirmada');
});

test('full current row hash and live identity/context are checked inside the transaction', async () => {
  for (const contextChange of [false, true]) {
    const f = fixture(), pkg = await f.prepare();
    if (contextChange) f.state.context.patient_primary_clinic_id = 66; else f.state.row.nota = 'Concurrent change';
    await assert.rejects(f.apply(pkg), { message: contextChange ? 'CURRENT_CONTEXT_HASH_CONFLICT' : 'CURRENT_ROW_HASH_CONFLICT' });
    assert.equal(f.state.writes, 0); assert.equal(f.events.length, 0);
  }
});

test('durable prepare failure prevents SQL and a DB rollback leaves no applied marker', async () => {
  const f = fixture(), pkg = await f.prepare();
  await assert.rejects(f.apply(pkg, { journal: { append: async () => { throw new Error('DISK_FULL'); } } }), { message: 'DISK_FULL' });
  assert.equal(f.state.writes, 0);
  f.state.commitFailure = true;
  await assert.rejects(f.apply(pkg), { message: 'SIMULATED_COMMIT_FAILURE' });
  assert.equal(f.state.row.import_metadata.cliniccloud_reconciliation, undefined);
  assert.deepEqual(f.events.map(event => event.phase), ['prepared']);
});

test('commit-to-journal crash resumes from DB marker without writing twice', async () => {
  const f = fixture(), pkg = await f.prepare();
  await assert.rejects(f.apply(pkg, { journal: { append: async event => { if (event.phase === 'committed') throw new Error('AFTER_COMMIT_DISK_FULL'); } } }), { message: 'AFTER_COMMIT_DISK_FULL' });
  assert.equal(f.state.writes, 1); assert(f.state.row.import_metadata.cliniccloud_reconciliation);
  const result = await f.apply(pkg); assert.equal(result.already_applied, 1); assert.equal(f.state.writes, 1);
});

test('approval expiry, wrong SHA, missing backup, unlisted actions and invalid batch limits reject writes', async () => {
  const f = fixture(), pkg = await f.prepare();
  for (const change of [{ expires_at: '2026-09-07T10:00:00Z' }, { package_sha256: 'wrong' }, { backup_manifest_sha256: '' }, { confirm_in_place_only: false }, { action_keys: ['unknown'] }]) await assert.rejects(f.apply(pkg, { approval: { ...f.approve(pkg), ...change } }));
  await assert.rejects(f.apply(pkg, { maxOperations: 101 }), { message: 'INVALID_BATCH_LIMIT' });
  assert.equal(f.state.writes, 0);
});

test('SQL adapter and CLI do not import runtime hooks and can only update metadata in-place', () => {
  const fs = require('node:fs'), path = require('node:path');
  const store = fs.readFileSync(path.join(__dirname, '../../lib/cliniccloud-import/appointments-store.js'), 'utf8');
  assert.doesNotMatch(store, /require\([^\n]*(?:models|appointmentAutomation|jobRequests)/);
  assert.match(store, /UPDATE CitasPacientes SET import_metadata = \?, updated_at = \? WHERE id_cita/);
  assert.doesNotMatch(store, /INSERT INTO|DELETE FROM|UPDATE (?:Pacientes|Patient|Job|Appointment)/);
  assert.match(store, /FOR UPDATE/);
  assert.match(store, /WRITE_COLUMNS_NOT_ALLOWED/);
  assert.match(store, /APPOINTMENT_SQL_TRIGGERS_REQUIRE_REVIEW/);
  assert.doesNotMatch(store, /COUNT\(\*\)|for \(const relation of/);
  assert.match(store, /ConversationAutomationStates WHERE clinic_id = \? AND appointment_id = \? LIMIT 1/);
  const cli = fs.readFileSync(path.join(__dirname, '../cliniccloud-import-appointments-apply.js'), 'utf8');
  assert.match(cli, /fs\.fsyncSync\(directoryDescriptor\)/);
});

test('different packages sharing one canonical journal contend on the same second lock', async () => {
  const { acquireExecutorLocks } = require('../cliniccloud-import-appointments-apply');
  const keys = [], connection = { query: async (sql, values) => { keys.push(values[0]); return [[{ acquired: 1 }]]; } };
  await acquireExecutorLocks(connection, 'a'.repeat(64), '/private/synthetic/journal.jsonl');
  await acquireExecutorLocks(connection, 'b'.repeat(64), '/private/synthetic/journal.jsonl');
  assert.notEqual(keys[0], keys[2]); assert.equal(keys[1], keys[3]);
  await assert.rejects(acquireExecutorLocks({ query: async () => [[{ acquired: 0 }]] }, 'c'.repeat(64), '/private/synthetic/journal.jsonl'), { message: 'PACKAGE_OR_JOURNAL_ALREADY_RUNNING' });
});

test('the SQL store requires its transaction and rejects writes outside the metadata allowlist', async () => {
  const { createAppointmentStore } = require('../../lib/cliniccloud-import/appointments-store');
  const calls = [];
  const connection = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT id_clinica')) return [[{ id_clinica: 72, grupoClinicaId: 8 }, { id_clinica: 66, grupoClinicaId: 8 }]];
      if (sql.startsWith('UPDATE')) return [{ affectedRows: 1 }];
      return [[]];
    },
    beginTransaction: async () => calls.push({ sql: 'BEGIN' }),
    commit: async () => calls.push({ sql: 'COMMIT' }),
    rollback: async () => calls.push({ sql: 'ROLLBACK' }),
  };
  const store = await createAppointmentStore(connection, [72, 66], { readOnly: false });
  await assert.rejects(store.prepareIdentities(['456']), { message: 'IDENTITY_CACHE_READ_ONLY_PREPARATION_REQUIRED' });
  await assert.rejects(store.update(1, {}, {}), { message: 'WRITE_TRANSACTION_NOT_ENABLED' });
  await assert.rejects(store.transaction(tx => tx.update(1, { estado: 'cancelada' }, {})), { message: 'WRITE_COLUMNS_NOT_ALLOWED' });
  assert(calls.some(call => call.sql === 'ROLLBACK')); assert(!calls.some(call => call.sql.startsWith('UPDATE')));
  const before = normalizedRow(fixture().state.row);
  await store.transaction(tx => tx.update(1, { import_metadata: {}, updated_at: '2026-09-07T12:00:00.000Z' }, before));
  const update = calls.find(call => call.sql.startsWith('UPDATE'));
  assert.match(update.sql, /AND source_system = \? AND source_reference = \? AND estado = \? AND inicio = \? AND fin = \? AND updated_at = \?/);
  assert.equal(update.values[1], '2026-09-07 12:00:00.000');
  assert.equal(calls.at(-1).sql, 'COMMIT');
  const readonly = await createAppointmentStore(connection, [72, 66]);
  await assert.rejects(readonly.transaction(() => {}), { message: 'WRITE_TRANSACTION_NOT_ENABLED' });
});

test('private append journal fsyncs a verifiable chain and rejects truncation or tampering', async () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-appointments-journal-test-'));
  const filename = path.join(directory, 'journal.jsonl');
  const script = path.resolve(__dirname, '../cliniccloud-import-appointments-apply.js');
  const actualRequire = require('node:module').createRequire(script), module = { exports: {} };
  const testRequire = name => name.endsWith('/cliniccloud-import/io') ? { ...actualRequire(name), PRIVATE_ROOT: directory } : actualRequire(name);
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), { module, exports: module.exports, require: testRequire, __dirname: path.dirname(script), process });
  const { openJournal } = module.exports;
  try {
    let journal = openJournal(filename, 'package-test');
    await journal.append({ phase: 'prepared', action_key: 'synthetic' }); journal.close();
    journal = openJournal(filename, 'package-test');
    await journal.append({ phase: 'committed', action_key: 'synthetic' }); journal.close();
    const text = fs.readFileSync(filename, 'utf8'), entries = text.trim().split('\n').map(JSON.parse);
    assert.equal(entries[1].sequence, 2); assert.equal(entries[1].previous_entry_sha256, entries[0].entry_sha256);
    assert.equal(fs.statSync(filename).mode & 0o077, 0);
    fs.writeFileSync(filename, text.replace('committed', 'tampered'));
    assert.throws(() => openJournal(filename, 'package-test'), /JOURNAL_INTEGRITY_MISMATCH/);
    fs.writeFileSync(filename, text.slice(0, -2));
    assert.throws(() => openJournal(filename, 'package-test'), /JOURNAL_TRUNCATED_REQUIRES_REVIEW/);
    fs.writeFileSync(filename, text);
    fs.chmodSync(filename, 0o644);
    assert.throws(() => openJournal(filename, 'package-test'), /PRIVATE_JOURNAL_PERMISSIONS_INVALID/);
  } finally { fs.unlinkSync(filename); fs.rmdirSync(directory); }
});

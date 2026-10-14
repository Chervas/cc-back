'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('sequelize');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const operations = require('../../lib/whatsappImportedAppointmentOperations');
const cut = require('../appointment-reminder-sequence-release');
const configuration = { database: 'owned_fixture_only', user: 'fixture', password: 'never_emitted' };
const info = { commit: 'a'.repeat(40), pins: { ['migrations/' + cut.NAME]: cut.MIGRATION_SHA256 } };
const NOW = Date.now();
function state() {
  const tables = [...Object.keys(cut.PARENTS), 'SequelizeMeta'].sort().map(TABLE_NAME => ({ TABLE_NAME, ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_bin' }));
  return { database_name: configuration.database, database_collation: 'utf8mb4_bin', identity_sha256: 'fixture_identity',
    tables, columns: Object.entries(cut.PARENTS).map(([TABLE_NAME, COLUMN_NAME]) => ({ TABLE_NAME, COLUMN_NAME,
      COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: 'auto_increment', COLLATION_NAME: null,
      GENERATION_EXPRESSION: '', ORDINAL_POSITION: 1 })).sort((a, b) => a.TABLE_NAME.localeCompare(b.TABLE_NAME)),
    indexes: [], foreignKeys: [], triggers: [], metadata_names: ['old-owned-fixture.js'] };
}
function applied(before, registered = true) {
  const result = structuredClone(before);
  result.tables.push({ TABLE_NAME: cut.TABLE, ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_bin' }); result.tables.sort((a, b) => a.TABLE_NAME.localeCompare(b.TABLE_NAME));
  result.columns.push(...Object.entries(cut.FIELDS).map(([COLUMN_NAME, [type, nullable]], i) => ({ TABLE_NAME: cut.TABLE,
    COLUMN_NAME, COLUMN_TYPE: type, IS_NULLABLE: nullable ? 'YES' : 'NO', COLUMN_DEFAULT: null, EXTRA: '',
    COLLATION_NAME: type.startsWith('varchar') ? 'utf8mb4_bin' : null, GENERATION_EXPRESSION: '', ORDINAL_POSITION: i + 1 })));
  result.columns.sort((a, b) => a.TABLE_NAME.localeCompare(b.TABLE_NAME) || a.ORDINAL_POSITION - b.ORDINAL_POSITION);
  for (const [INDEX_NAME, fields, NON_UNIQUE] of [['PRIMARY', ['id'], 0],
    ['ars_patient_clinic_day', ['patient_id', 'clinic_id', 'local_date'], 0], ['clinic_id', ['clinic_id'], 1],
    ['anchor_appointment_id', ['anchor_appointment_id'], 1], ['response_message_id', ['response_message_id'], 1]]) {
    result.indexes.push(...fields.map((COLUMN_NAME, i) => ({ TABLE_NAME: cut.TABLE, INDEX_NAME, NON_UNIQUE,
      COLUMN_NAME, SEQ_IN_INDEX: i + 1, SUB_PART: null, INDEX_TYPE: 'BTREE' })));
  }
  result.foreignKeys.push(...Object.entries(cut.FOREIGN).map(([COLUMN_NAME, [REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME]], i) => ({
    TABLE_NAME: cut.TABLE, COLUMN_NAME, CONSTRAINT_NAME: 'fixture_ibfk_' + i, REFERENCED_TABLE_NAME,
    REFERENCED_COLUMN_NAME, UPDATE_RULE: 'RESTRICT', DELETE_RULE: 'RESTRICT' })));
  if (registered) result.metadata_names.push(cut.NAME); result.metadata_names.sort();
  return result;
}
function policy() {
  const policy = { version: 1, purpose: 'appointment_operations', approvedBy: 7, approvalRef: 'fixture-only',
    approvedAt: '2026-10-06T11:00:00.000Z', clinicIds: [66, 72], automaticBacklogReplay: false,
    sameDayAllowed: false, preserved_future_extension: { untouched: true } };
  const bytes = Buffer.from(JSON.stringify(policy) + '\n');
  return { file: operations.FILE, bytes_base64: bytes.toString('base64'), file_sha256: hash(bytes), policy,
    uid: process.getuid(), gid: process.getgid(), mode: 0o600, inode: 99 };
}
function plan(action = 'schema') {
  return { version: cut.VERSION, target: 'crm', action, migration: cut.NAME, source: info,
    configuration_sha256: hash(configuration), generated_at: new Date(NOW).toISOString(),
    before: action === 'schema' ? state() : applied(state()), policy_before: action === 'schema' ? null : policy() };
}
function ready() {
  return { version: 'appointment-reminder-runtime-ready/1', target: 'crm', source_commit: info.commit,
    verified_at: new Date(NOW).toISOString(), checks: { schema_compatible: true, runtime_restarted: true,
      protected_gates_verified: true, no_manual_replay: true } };
}
function executor({ action = 'schema', busy = false, drift = false, ddlFailure = false, metadataFailure = false,
  policyDrift = false, policyMutation = false } = {}) {
  const prepared = plan(action), calls = [], journal = [], backups = [];
  let current = structuredClone(prepared.before), transaction = false, metadataBefore;
  let currentPolicy = policy();
  const connection = {
    query: async (sql, args) => {
      calls.push({ sql, args });
      if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: busy ? 0 : 1 }]];
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.startsWith('INSERT INTO SequelizeMeta')) {
        assert(transaction); assert.deepEqual(args, [cut.NAME]);
        if (metadataFailure) throw Error('owned_metadata_failure');
        current.metadata_names.push(cut.NAME); current.metadata_names.sort(); return [{ affectedRows: 1 }];
      }
      assert.fail('Unexpected operator SQL ' + sql);
    },
    beginTransaction: async () => { calls.push({ sql: 'BEGIN' }); transaction = true; metadataBefore = [...current.metadata_names]; },
    commit: async () => { calls.push({ sql: 'COMMIT' }); transaction = false; },
    rollback: async () => { calls.push({ sql: 'ROLLBACK' }); current.metadata_names = metadataBefore; transaction = false; },
  };
  const run = (extra = {}) => cut.applyPlan({ connection, plan: prepared, info, target: 'crm', configuration,
    backupPath: '/home/ubuntu/secure-imports/fictitious-unused-backup.json', runtimeProof: ready(),
    journal: { append: async event => journal.push(event) }, saveBackup: (_filename, backup) => backups.push(backup),
    captureState: async () => { const result = structuredClone(current); if (drift) result.identity_sha256 = 'drift'; return result; },
    loadPolicy: () => policyDrift ? { ...currentPolicy, file_sha256: 'drift' } : structuredClone(currentPolicy),
    writePolicy: before => {
      calls.push({ sql: 'ATOMIC_POLICY_FLAG_WRITE' });
      currentPolicy = { ...before, policy: { ...before.policy, sameDayAllowed: true, ...(policyMutation ? { approvedAt: '2026-10-14T11:00:00.000Z' } : {}) } };
      return currentPolicy;
    },
    migrationInterfaceFactory: () => ({}), loadMigration: () => ({ up: async () => {
      calls.push({ sql: 'EXACT_REVIEWED_UP' }); current = applied(current, false);
      if (ddlFailure) throw Error('owned_ddl_failure');
    } }), ...extra });
  return { run, calls, journal, backups, current: () => current, currentPolicy: () => currentPolicy };
}

test('only exact reviewed migration bytes are pinned, and operator module imports no application model', () => {
  const root = path.resolve(__dirname, '../../..');
  assert.equal(hash(fs.readFileSync(path.join(root, 'migrations', cut.NAME))), cut.MIGRATION_SHA256);
  const source = fs.readFileSync(require.resolve('../appointment-reminder-sequence-release'), 'utf8');
  assert(!/require\(['"]\.\.\/\.\.\/models/.test(source));
  assert(!/\.down\(|dropTable\(|\bDROP TABLE\b|\bDELETE FROM\b|sequelize-cli/.test(source));
});
test('schema plan validates strict source/configuration/target/freshness and refuses partial/existing ledger adoption', () => {
  const p = plan(); assert.doesNotThrow(() => cut.validatePlan(p, info, 'crm', configuration, { now: NOW }));
  for (const patch of [{ target: 'dev' }, { source: { ...info, commit: 'b'.repeat(40) } }, { migration: 'another.js' },
    { configuration_sha256: 'wrong' }, { action: 'unknown' }, { generated_at: new Date(NOW - 7200001).toISOString() },
    { generated_at: new Date(NOW + 1).toISOString() }]) assert.throws(() => cut.validatePlan({ ...p, ...patch }, info, 'crm', configuration, { now: NOW }));
  for (const broken of [applied(state()), { ...state(), metadata_names: [cut.NAME] },
    { ...state(), tables: [...state().tables, { TABLE_NAME: cut.TABLE, ENGINE: 'InnoDB' }] }]) {
    assert.throws(() => cut.assertUnapplied(broken), /EXISTING_OR_PARTIAL/);
  }
});
test('compatible ledger requires all exact columns, unique identity, integer parent FKs and no ledger/meta triggers', () => {
  const valid = applied(state()); assert.doesNotThrow(() => cut.verifySchema(valid));
  for (const mutate of [s => s.columns.find(r => r.TABLE_NAME === cut.TABLE && r.COLUMN_NAME === 'claims').IS_NULLABLE = 'YES',
    s => s.columns.find(r => r.TABLE_NAME === cut.TABLE && r.COLUMN_NAME === 'arrival_at').COLUMN_TYPE = 'datetime',
    s => s.indexes.find(r => r.INDEX_NAME === 'ars_patient_clinic_day').NON_UNIQUE = 1,
    s => s.foreignKeys[0].DELETE_RULE = 'CASCADE', s => s.tables.find(r => r.TABLE_NAME === cut.TABLE).ENGINE = 'MyISAM',
    s => s.columns.find(r => r.TABLE_NAME === 'Messages').COLUMN_TYPE = 'int unsigned',
    s => s.triggers.push({ EVENT_OBJECT_TABLE: cut.TABLE }), s => s.metadata_names = []]) {
    const broken = structuredClone(valid); mutate(broken); assert.throws(() => cut.verifySchema(broken));
  }
});
test('real reviewed migration runs only bounded atomic create including unique FK restrictions and no down', async () => {
  const calls = [], qi = cut.boundedQueryInterface({ query: async sql => calls.push(sql) }, S, 'utf8mb4_bin');
  await require('../../../migrations/' + cut.NAME).up(qi, S);
  assert.equal(calls.length, 1); assert.match(calls[0], /^CREATE TABLE `AppointmentReminderSequences`/);
  assert.match(calls[0], /UNIQUE KEY `ars_patient_clinic_day` \(`patient_id`,`clinic_id`,`local_date`\)/);
  assert.equal((calls[0].match(/ON DELETE RESTRICT ON UPDATE RESTRICT/g) || []).length, 4);
  assert.match(calls[0], /`arrival_at` DATETIME\(3\) NOT NULL/); assert.match(calls[0], /`claims` JSON NOT NULL/);
  await assert.rejects(qi.addIndex(cut.TABLE, ['patient_id'], { name: 'other', unique: false }), /UNEXPECTED_DDL/);
  await assert.rejects(qi.createTable('Pacientes', {}), /UNEXPECTED_DDL/);
});
test('apply backs up and journals before additive DDL, registers only this migration and never writes business data', async () => {
  const f = executor(), result = await f.run(); assert.equal(result.status, 'applied_verified');
  assert.equal(f.backups.length, 1); assert.deepEqual(f.backups[0].before, state());
  assert.equal(f.journal[0].phase, 'backup_durable_before_mutation');
  assert.equal(f.journal.at(-1).phase, 'verified');
  assert(f.calls.some(call => call.sql === 'COMMIT'));
  assert.equal(f.calls.filter(call => call.sql.startsWith('INSERT INTO')).length, 1);
  assert(!f.calls.some(call => /UPDATE|DELETE|DROP|Pacientes.*SET|Messages.*SET/.test(call.sql)));
  assert.deepEqual(cut.protectedState(f.current()), cut.protectedState(state()));
});
test('busy operator or drift aborts before mutation; failed DDL/metadata preserves ledger and refuses silent recovery', async () => {
  for (const setting of [{ busy: true }, { drift: true }]) {
    const f = executor(setting); await assert.rejects(f.run()); assert.equal(f.backups.length, 0);
    assert(!f.calls.some(call => call.sql === 'EXACT_REVIEWED_UP'));
  }
  for (const setting of [{ ddlFailure: true }, { metadataFailure: true }]) {
    const f = executor(setting); await assert.rejects(f.run());
    assert(f.current().tables.some(row => row.TABLE_NAME === cut.TABLE));
    assert(!f.current().metadata_names.includes(cut.NAME));
    assert(!f.calls.some(call => /DROP|DELETE/.test(call.sql)));
    assert.equal(f.journal.at(-1).phase, 'failed_preserve_additive_schema_and_backups');
  }
});
test('same-day action is CRM-only and demands verified current runtime rather than source deployment assumption', () => {
  const p = plan('same-day'); assert.doesNotThrow(() => cut.validatePlan(p, info, 'crm', configuration, { now: NOW }));
  assert.throws(() => cut.validatePlan({ ...p, target: 'dev' }, info, 'dev', configuration, { now: NOW }));
  assert.doesNotThrow(() => cut.validateRuntimeReady(ready(), info, { now: NOW }));
  for (const patch of [{ target: 'dev' }, { source_commit: 'b'.repeat(40) }, { checks: { schema_compatible: true } },
    { verified_at: new Date(NOW - 7200001).toISOString() }, { verified_at: new Date(NOW + 1).toISOString() }]) {
    assert.throws(() => cut.validateRuntimeReady({ ...ready(), ...patch }, info, { now: NOW }));
  }
});
test('flag activation preserves approvedAt, metadata/receipts/extensions and false backlog with backup before atomic write', async () => {
  const f = executor({ action: 'same-day' }); await f.run();
  assert.equal(f.backups[0].policy_before.bytes_base64, policy().bytes_base64);
  assert.deepEqual(f.currentPolicy().policy, { ...policy().policy, sameDayAllowed: true });
  assert.equal(f.currentPolicy().policy.approvedAt, policy().policy.approvedAt);
  assert.equal(f.currentPolicy().policy.automaticBacklogReplay, false);
  assert(!f.calls.some(call => call.sql === 'EXACT_REVIEWED_UP' || call.sql.startsWith('INSERT')));
  assert.equal(f.journal.at(-1).protected_approved_at_unchanged, true);
});
test('flag drift, missing runtime proof, or any unintended policy field change is rejected and evidence retained', async () => {
  const drift = executor({ action: 'same-day', policyDrift: true }); await assert.rejects(drift.run(), /POLICY_PLAN_DRIFT/);
  assert(!drift.calls.some(call => call.sql === 'ATOMIC_POLICY_FLAG_WRITE'));
  const noProof = executor({ action: 'same-day' }); await assert.rejects(noProof.run({ runtimeProof: null }), /VERIFIED_DEPLOYED_RUNTIME_PROOF/);
  assert.equal(noProof.backups.length, 0);
  const mutation = executor({ action: 'same-day', policyMutation: true }); await assert.rejects(mutation.run(), /POLICY_VERIFICATION_FAILED/);
  assert.equal(mutation.backups.length, 1); assert.equal(mutation.journal.at(-1).phase, 'failed_preserve_additive_schema_and_backups');
});

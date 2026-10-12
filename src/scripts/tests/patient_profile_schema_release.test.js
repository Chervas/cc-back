'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Sequelize = require('sequelize');
const cut = require('../patient-profile-schema-release');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { PATIENT_PROFILE_FIELD_NAMES: names, PATIENT_PROFILE_FIELD_SPECS: specs, patientProfileAttributes } = require('../../lib/patient-profile-fields');
const ROOT = path.resolve(__dirname, '../../..');
const configuration = { database: 'fictitious_crm', user: 'fictitious', password: 'NOT_EMITTED' };
const info = { commit: 'a'.repeat(40), migration_sha256: cut.MIGRATION_SHA256, fields_sha256: cut.FIELDS_SHA256 };
const now = Date.now();
function state() {
  return { database_name: configuration.database, identity_sha256: 'identity', server_sha256: hash('fixture-server'),
    tables: ['Pacientes', 'SequelizeMeta'].map(TABLE_NAME => ({ TABLE_NAME, ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_bin' })),
    columns: ['Pacientes', 'SequelizeMeta'].map(TABLE_NAME => ({ TABLE_NAME, COLUMN_NAME: TABLE_NAME === 'Pacientes' ? 'id_paciente' : 'name',
      COLUMN_TYPE: TABLE_NAME === 'Pacientes' ? 'int' : 'varchar(255)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: '',
      CHARACTER_SET_NAME: TABLE_NAME === 'Pacientes' ? null : 'utf8mb4', COLLATION_NAME: TABLE_NAME === 'Pacientes' ? null : 'utf8mb4_bin',
      GENERATION_EXPRESSION: '', ORDINAL_POSITION: 1 })), indexes: [], foreignKeys: [], triggers: [], metadata_names: ['prior.js'] };
}
function column(name, position) {
  const spec = specs[name];
  return { TABLE_NAME: 'Pacientes', COLUMN_NAME: name, COLUMN_TYPE: spec.kind === 'boolean' ? 'tinyint(1)' : spec.kind === 'text' ? 'text' : `varchar(${spec.maxLength})`,
    IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, EXTRA: '', CHARACTER_SET_NAME: spec.kind === 'boolean' ? null : 'utf8mb4',
    COLLATION_NAME: spec.kind === 'boolean' ? null : 'utf8mb4_bin', GENERATION_EXPRESSION: '', ORDINAL_POSITION: position };
}
function applied(before, registered = false) {
  const after = structuredClone(before);
  after.columns = [after.columns[0], ...names.map((name, i) => column(name, i + 2)), after.columns[1]];
  if (registered) after.metadata_names.push(cut.NAME);
  after.metadata_names.sort();
  return after;
}
function plan(before = state()) {
  return { version: cut.VERSION, target: 'crm', source_commit: info.commit, migration: cut.NAME, migration_sha256: cut.MIGRATION_SHA256,
    fields_sha256: cut.FIELDS_SHA256, configuration_sha256: hash(configuration), generated_at: new Date(now).toISOString(), before };
}
function executor({ drift = false, badAfter = false, failure = null, busy = false, metadataFailure = false } = {}) {
  const before = state(); const prepared = plan(before);
  let current = structuredClone(before); let metadataBefore;
  const calls = []; const journal = [];
  const connection = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: busy ? 0 : 1 }]];
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.startsWith('INSERT INTO SequelizeMeta')) {
        assert.ok(metadataBefore, 'metadata transaction required');
        if (metadataFailure) throw Error('FICTITIOUS_METADATA_FAILURE');
        assert.deepEqual(values, [cut.NAME]); current.metadata_names.push(cut.NAME); current.metadata_names.sort();
        return [{ affectedRows: 1 }];
      }
      assert.fail(`Unexpected mock SQL: ${sql}`);
    },
    async beginTransaction() { calls.push({ sql: 'BEGIN' }); metadataBefore = [...current.metadata_names]; },
    async commit() { calls.push({ sql: 'COMMIT' }); metadataBefore = null; },
    async rollback() { calls.push({ sql: 'ROLLBACK' }); current.metadata_names = metadataBefore; metadataBefore = null; },
  };
  const loadMigration = () => ({ async up() {
    calls.push({ sql: 'REVIEWED_MIGRATION_UP' });
    if (failure) { current.columns.push(column(names[0], 2)); throw failure; }
    current = applied(current);
    if (badAfter) current.columns[0].COLUMN_TYPE = 'bigint';
  } });
  const captureState = async () => {
    const snapshot = structuredClone(current);
    if (drift && !calls.some(call => call.sql === 'REVIEWED_MIGRATION_UP')) snapshot.indexes.push({ drift: true });
    return snapshot;
  };
  const run = () => cut.applyPlan({ connection, plan: prepared, info, target: 'crm', configuration,
    journal: { append: async event => journal.push(event) }, captureState, migrationInterfaceFactory: () => ({}), loadMigration });
  return { run, calls, journal, current: () => current };
}

test('reviewed migration and pure field spec hashes are pinned exactly', () => {
  assert.equal(hash(fs.readFileSync(path.join(ROOT, 'migrations', cut.NAME))), cut.MIGRATION_SHA256);
  assert.equal(hash(fs.readFileSync(path.join(ROOT, 'src/lib/patient-profile-fields.js'))), cut.FIELDS_SHA256);
});
test('valid metadata-only plan is bound to target, source, migration, fields and exact configuration', () => {
  const p = plan();
  assert.doesNotThrow(() => cut.validatePlan(p, info, 'crm', configuration, { now }));
  for (const patch of [{ target: 'dev' }, { source_commit: 'b'.repeat(40) }, { migration: 'other.js' },
    { migration_sha256: 'b'.repeat(64) }, { fields_sha256: 'b'.repeat(64) }, { configuration_sha256: 'bad' },
    { generated_at: new Date(now - 7200001).toISOString() }, { generated_at: new Date(now + 1).toISOString() }]) {
    assert.throws(() => cut.validatePlan({ ...p, ...patch }, info, 'crm', configuration, { now }), /PLAN_INVALID_OR_EXPIRED/);
  }
  assert.throws(() => cut.validatePlan(p, info, 'crm', { ...configuration, database: 'other_database' }, { now }), /PLAN_INVALID_OR_EXPIRED/);
  assert.doesNotThrow(() => cut.validatePlan({ ...p, generated_at: new Date(now - 7200001).toISOString() }, info, 'crm', configuration, { now, fresh: false }));
});
test('existing, partial, unsafe parent or metadata trigger state requires review', () => {
  for (const change of [s => s.columns.push(column(names[0], 2)), s => s.metadata_names.push(cut.NAME),
    s => s.tables[0].ENGINE = 'MyISAM', s => s.tables.pop(), s => s.triggers.push({ EVENT_OBJECT_TABLE: 'SequelizeMeta' })]) {
    const s = state(); change(s); assert.throws(() => cut.assertUnapplied(s), /PATIENT_SCHEMA_/);
  }
});
test('backup must match exact target/server/database, full integrity and fresh completion flags', () => {
  const backup = { version: 'cliniccloud-operator-backup/1', database_target: 'crm', database_name: configuration.database,
    server_name: 'fixture-server', full_gzip_verified: true, dump_completion_verified: true, tables: ['Pacientes', 'SequelizeMeta'], generated_at: new Date(now).toISOString() };
  assert.doesNotThrow(() => cut.validateBackupManifest(backup, plan(), configuration, 'crm', now));
  for (const patch of [{ database_target: 'dev' }, { database_name: 'other' }, { server_name: 'other' },
    { full_gzip_verified: false }, { dump_completion_verified: false }, { tables: ['Pacientes'] },
    { generated_at: new Date(now - 7200001).toISOString() }, { generated_at: new Date(now + 1).toISOString() }]) {
    assert.throws(() => cut.validateBackupManifest({ ...backup, ...patch }, plan(), configuration, 'crm', now), /FRESH_TARGET_BACKUP/);
  }
});
test('exact nine nullable column types and metadata registration are mandatory', () => {
  const s = applied(state(), true); assert.doesNotThrow(() => cut.verifySchema(s));
  for (const change of [s => s.columns[1].IS_NULLABLE = 'NO', s => s.columns[1].COLUMN_DEFAULT = 'copied-note',
    s => s.columns[1].COLUMN_TYPE = 'varchar(255)', s => s.columns[1].GENERATION_EXPRESSION = 'expression',
    s => s.columns[1].CHARACTER_SET_NAME = 'latin1', s => s.columns[1].COLLATION_NAME = 'utf8mb4_general_ci',
    s => s.columns.splice(1, 1), s => s.metadata_names = []]) {
    const broken = structuredClone(s); change(broken);
    assert.throws(() => cut.verifySchema(broken), /PATIENT_SCHEMA_/);
  }
});
test('all old metadata and identity remain exact; only the reviewed registration may appear', () => {
  const before = state(); assert.doesNotThrow(() => cut.verifyAfter(before, applied(before)));
  assert.doesNotThrow(() => cut.verifyAfter(before, applied(before, true), { registered: true }));
  for (const change of [s => s.columns[0].COLUMN_TYPE = 'bigint', s => s.identity_sha256 = 'changed',
    s => s.indexes.push({ name: 'changed' }), s => s.foreignKeys.push({ name: 'changed' }),
    s => s.triggers.push({ EVENT_OBJECT_TABLE: 'Pacientes' }), s => s.tables[0].TABLE_COLLATION = 'other',
    s => s.metadata_names.push('unrelated.js')]) {
    const after = applied(before); change(after); assert.throws(() => cut.verifyAfter(before, after), /PATIENT_SCHEMA_/);
  }
});
test('bounded interface accepts exactly nine nullable INSTANT ADDs and metadata-only descriptions', async () => {
  const calls = []; const connection = { query: async (sql, values) => { calls.push({ sql, values }); return [[]]; } };
  const qi = cut.boundedQueryInterface(connection, Sequelize);
  await qi.describeTable('Pacientes');
  const attrs = patientProfileAttributes(Sequelize);
  for (const name of names) await qi.addColumn('Pacientes', name, attrs[name]);
  assert.equal(calls.length, 10);
  assert.ok(calls.slice(1).every(call => /^ALTER TABLE `Pacientes` ADD COLUMN `[a-z_]+` (?:TEXT|VARCHAR\(\d+\)|TINYINT\(1\)) NULL DEFAULT NULL, ALGORITHM=INSTANT$/.test(call.sql)));
  assert.ok(calls.every(call => !/UPDATE |SELECT \*|DELETE |DROP |PatientCustomFields/.test(call.sql)));
  await assert.rejects(qi.describeTable('Other'), /UNEXPECTED_TABLE/);
  for (const args of [['Other', names[0], attrs[names[0]]], ['Pacientes', 'unreviewed', attrs[names[0]]],
    ['Pacientes', names[0], { ...attrs[names[0]], defaultValue: 'copied' }],
    ['Pacientes', names[0], { ...attrs[names[0]], allowNull: false }],
    ['Pacientes', names[0], { type: Sequelize.STRING(1), allowNull: true }]]) {
    await assert.rejects(qi.addColumn(...args), /UNEXPECTED_DDL/);
  }
  assert.equal(calls.length, 10);
});
test('unsupported INSTANT never falls back to table rebuild or copy', async () => {
  let calls = 0;
  const qi = cut.boundedQueryInterface({ query: async () => { calls++; throw Error('INSTANT_UNSUPPORTED'); } }, Sequelize);
  await assert.rejects(qi.addColumn('Pacientes', names[0], patientProfileAttributes(Sequelize)[names[0]]), /INSTANT_UNSUPPORTED/);
  assert.equal(calls, 1);
});
test('DEV writer guard reads only states and never changes services or runtime flags', () => {
  const seen = [];
  cut.assertDevStopped((program, args) => { seen.push({ program, args }); return 'inactive\n'; });
  assert.equal(seen.length, 2); assert.ok(seen.every(call => call.program === 'systemctl' && call.args[0] === 'show'));
  assert.throws(() => cut.assertDevStopped(() => 'active\n'), /STOP_DEV_WRITERS_FIRST/);
});
test('apply journals intent before DDL, verifies before registration and commits metadata only', async () => {
  const f = executor(); const result = await f.run();
  assert.equal(result.status, 'applied_verified'); assert.equal(result.business_data_written, false);
  assert.deepEqual(f.journal.map(event => event.phase), ['before_ddl', 'ddl_completed_requires_verification', 'ddl_verified_before_metadata', 'metadata_verified_before_commit', 'verified']);
  assert.ok(f.calls.findIndex(call => call.sql === 'REVIEWED_MIGRATION_UP') < f.calls.findIndex(call => call.sql === 'BEGIN'));
  assert.equal(f.calls.filter(call => call.sql.startsWith('INSERT INTO SequelizeMeta')).length, 1);
  assert.equal(f.calls.at(-1).sql, 'SELECT RELEASE_LOCK(?)');
});
test('busy/drift plans never reach DDL; post-DDL mismatch never registers a migration', async () => {
  for (const options of [{ busy: true }, { drift: true }]) {
    const f = executor(options); await assert.rejects(f.run(), /PATIENT_SCHEMA_/);
    assert.equal(f.calls.some(call => call.sql === 'REVIEWED_MIGRATION_UP'), false);
  }
  const f = executor({ badAfter: true }); await assert.rejects(f.run(), /EXISTING_METADATA_CHANGED/);
  assert.equal(f.calls.some(call => call.sql.startsWith('INSERT')), false);
  assert.equal(f.journal.at(-1).phase, 'failed_preserve_additive_schema');
});
test('partial DDL is preserved; metadata failure rolls back registration without pretending DDL rollback', async () => {
  const f = executor({ failure: Error('FICTITIOUS_DDL_FAILURE') });
  await assert.rejects(f.run(), /FICTITIOUS_DDL_FAILURE/);
  assert.equal(f.current().columns.some(row => row.COLUMN_NAME === names[0]), true);
  assert.equal(f.current().metadata_names.includes(cut.NAME), false);
  const metadata = executor({ metadataFailure: true });
  await assert.rejects(metadata.run(), /FICTITIOUS_METADATA_FAILURE/);
  assert.equal(metadata.current().columns.filter(row => names.includes(row.COLUMN_NAME)).length, 9);
  assert.equal(metadata.current().metadata_names.includes(cut.NAME), false);
  assert.equal(metadata.calls.some(call => call.sql === 'ROLLBACK'), true);
});
test('capture rejects wrong database and never selects patient/business rows or credentials', async () => {
  const before = state(); const calls = [];
  const query = async sql => {
    calls.push(sql);
    if (sql.startsWith('SELECT DATABASE')) return [[{ database_name: configuration.database, database_user: 'fixture-user', server_name: 'fixture-server' }]];
    for (const [part, table] of [['tables', 'TABLES'], ['columns', 'COLUMNS'], ['indexes', 'STATISTICS'], ['foreignKeys', 'KEY_COLUMN_USAGE'], ['triggers', 'TRIGGERS']]) {
      if (sql.includes(`information_schema.${table} `)) return [before[part]];
    }
    if (sql === 'SELECT name FROM SequelizeMeta ORDER BY name') return [[{ name: 'prior.js' }]];
    assert.fail('Unexpected metadata query');
  };
  const result = await cut.capture({ query }, configuration);
  assert.equal(result.database_name, configuration.database); assert.equal(JSON.stringify(result).includes(configuration.password), false);
  assert.ok(calls.every(sql => !/SELECT \*|FROM Pacientes\b|UPDATE |DELETE |DROP /.test(sql)));
  await assert.rejects(cut.capture({ query }, { ...configuration, database: 'wrong' }), /DATABASE_IDENTITY_MISMATCH/);
});

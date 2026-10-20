'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const operator = require('../program-enrollment-schema-release');
const before = { identity_sha256: 'identity', columns: [{ COLUMN_NAME: 'id', COLUMN_TYPE: 'bigint', ORDINAL_POSITION: 1 }],
  indexes: [{ INDEX_NAME: 'PRIMARY', COLUMN_NAME: 'id' }], foreign_keys: [], metadata_names: ['prior.js'], registered: false,
  row_count: 1, prior_rows_sha256: 'prior-rows', nonnull_snapshots: 0 };
const column = { COLUMN_NAME: 'program_snapshot', COLUMN_TYPE: 'json', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null,
  EXTRA: '', GENERATION_EXPRESSION: '', ORDINAL_POSITION: 2 };
test('enrollment schema adds only nullable JSON and preserves all prior fields, rows, indexes and references', () => {
  assert(operator.verifyColumn([column]));
  assert.deepEqual(operator.withoutSnapshot({ id: 1, sold_amount: '120.00', program_snapshot: null }), { id: 1, sold_amount: '120.00' });
  const after = { ...before, columns: [...before.columns, column] };
  assert.doesNotThrow(() => operator.verifyAfter(before, after));
  for (const patch of [{ row_count: 2 }, { prior_rows_sha256: 'other' }, { indexes: [] }, { foreign_keys: [{ other: true }] },
    { identity_sha256: 'wrong-target' }, { nonnull_snapshots: 1 }, { metadata_names: [] }]) {
    assert.throws(() => operator.verifyAfter(before, { ...after, ...patch }), /ENROLLMENT_SCHEMA_/);
  }
  for (const patch of [{ COLUMN_TYPE: 'text' }, { IS_NULLABLE: 'NO' }, { COLUMN_DEFAULT: '{}' }, { EXTRA: 'generated' }]) {
    assert.equal(operator.verifyColumn([{ ...column, ...patch }]), false);
  }
  const registered = { ...after, registered: true, metadata_names: [...before.metadata_names, operator.NAME].sort() };
  assert.doesNotThrow(() => operator.verifyAfter(before, registered, true));
});
test('enrollment schema requires an exact current plan, target, committed migration and short freshness', () => {
  const info = { commit: 'a'.repeat(40), migration_sha256: 'b'.repeat(64) }, now = Date.now();
  const plan = { version: 1, target: 'crm', source_commit: info.commit, migration: operator.NAME,
    migration_sha256: info.migration_sha256, generated_at: new Date(now).toISOString(), before };
  assert.doesNotThrow(() => operator.validateBefore(plan, before, info, 'crm', now));
  for (const patch of [{ target: 'dev' }, { source_commit: 'wrong' }, { migration_sha256: 'wrong' },
    { generated_at: new Date(now + 1).toISOString() }, { generated_at: new Date(now - operator.MAX_AGE - 1).toISOString() }]) {
    assert.throws(() => operator.validateBefore({ ...plan, ...patch }, before, info, 'crm', now), /PLAN_INVALID/);
  }
  assert.throws(() => operator.validateBefore(plan, { ...before, prior_rows_sha256: 'changed' }, info, 'crm', now), /CONCURRENT_CHANGE/);
  const partial = { ...before, columns: [...before.columns, column] };
  assert.throws(() => operator.validateBefore({ ...plan, before: partial }, partial, info, 'crm', now), /EXISTING_OR_PARTIAL/);
});
test('bounded migration adapter cannot update values, backfill, copy a table or alter another column', async () => {
  const queries = [], connection = { query: async sql => { queries.push(sql); return [[{ COLUMN_NAME: 'id', COLUMN_TYPE: 'bigint', IS_NULLABLE: 'NO' }]]; } };
  const Sequelize = { JSON: {} }, q = operator.boundedInterface(connection, Sequelize);
  assert.deepEqual(await q.describeTable('PatientVouchers'), { id: { type: 'BIGINT', allowNull: false } });
  await q.addColumn('PatientVouchers', 'program_snapshot', { type: Sequelize.JSON, allowNull: true });
  assert.equal(queries[1], 'ALTER TABLE `PatientVouchers` ADD COLUMN `program_snapshot` JSON NULL, ALGORITHM=INSTANT');
  for (const [table, name, spec] of [
    ['Pacientes', 'program_snapshot', { type: Sequelize.JSON, allowNull: true }],
    ['PatientVouchers', 'budget_id', { type: Sequelize.JSON, allowNull: true }],
    ['PatientVouchers', 'program_snapshot', { type: Sequelize.JSON, allowNull: true, defaultValue: {} }],
    ['PatientVouchers', 'program_snapshot', { type: Sequelize.JSON, allowNull: false }],
  ]) await assert.rejects(q.addColumn(table, name, spec), /UNEXPECTED_DDL/);
  await assert.rejects(q.describeTable('EconomicBudgets'), /UNEXPECTED_TABLE/);
  assert.equal(queries.length, 2);
});
test('backup must decompress completely and contain the exact target schema and all original voucher fields', () => {
  const directory = fs.mkdtempSync('/home/ubuntu/secure-imports/program-enrollment-schema-test-'); fs.chmodSync(directory, 0o700);
  const rows = [{ id: 1, clinic_id: 72, available_units: '3.00', sold_amount: '250.00', budget_id: 2 }];
  const captured = { ...before, prior_rows_sha256: hash(rows), rows, create_table: 'CREATE TABLE PatientVouchers (...)' };
  const backup = { version: 1, target: 'crm', migration: operator.NAME, captured };
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(backup))), filename = path.join(directory, 'backup.json.gz');
  fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
  const plan = { target: 'crm', migration: operator.NAME, before: operator.state(captured), backup_path: filename, backup_sha256: hash(bytes) };
  assert.equal(operator.verifyBackup(plan), true);
  assert.throws(() => operator.verifyBackup({ ...plan, target: 'dev' }), /BACKUP_INCOMPLETE/);
  assert.throws(() => operator.verifyBackup({ ...plan, backup_sha256: 'wrong' }), /BACKUP_CHANGED/);
  assert.throws(() => operator.verifyBackup({ ...plan, before: { ...plan.before, row_count: 2 } }), /BACKUP_INCOMPLETE/);
  fs.chmodSync(filename, 0o644);
  assert.throws(() => operator.verifyBackup(plan), /BACKUP_INVALID/);
  fs.chmodSync(filename, 0o600);
});

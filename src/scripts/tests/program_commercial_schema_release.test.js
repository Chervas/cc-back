'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { NAME, verifyColumn, withoutNewColumn, validateBefore, verifyAfter, newJournal, boundedQueryInterface } = require('../program-commercial-schema-release');
const before = { identity_sha256: 'identity', registered: false, metadata_names: ['previous.js'], columns: [{ COLUMN_NAME: 'id', COLUMN_TYPE: 'int', ORDINAL_POSITION: 1 }], program_count: 2, programs_sha256: 'programs', revisions_count: 3, revisions_sha256: 'revisions', nonnull_profiles: 0 };
const column = { COLUMN_NAME: 'price_profile', COLUMN_TYPE: 'json', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, EXTRA: '', GENERATION_EXPRESSION: '', ORDINAL_POSITION: 2 };
const copy = x => JSON.parse(JSON.stringify(x));
test('schema cut verifies exact nullable JSON and preserves all preexisting business fields', () => {
  assert(verifyColumn([column]));
  for (const patch of [{ COLUMN_TYPE: 'text' }, { IS_NULLABLE: 'NO' }, { COLUMN_DEFAULT: '{}' }, { EXTRA: 'STORED GENERATED' }]) assert.equal(verifyColumn([{ ...column, ...patch }]), false);
  assert.deepEqual(withoutNewColumn({ id: 1, notes: 'previous', price_profile: null }), { id: 1, notes: 'previous' });
  assert.doesNotThrow(() => verifyAfter(before, { ...before, columns: [...before.columns, column] }));
  for (const patch of [{ programs_sha256: 'changed' }, { revisions_sha256: 'changed' }, { identity_sha256: 'other-db' }, { nonnull_profiles: 1 }]) assert.throws(() => verifyAfter(before, { ...before, columns: [...before.columns, column], ...patch }));
  const after = { ...before, registered: true, metadata_names: [...before.metadata_names, NAME].sort(), columns: [...before.columns, column] };
  assert.doesNotThrow(() => verifyAfter(before, after, { registered: true }));
  for (const metadata_names of [[NAME], [...after.metadata_names, 'unexpected.js'], before.metadata_names]) assert.throws(() => verifyAfter(before, { ...after, metadata_names }, { registered: true }), /METADATA_CHANGED/);
});
test('schema plan is pinned to exact source, migration, target, freshness and prior metadata/data', () => {
  const info = { commit: 'a'.repeat(40), migration_sha256: 'b'.repeat(64) }, now = Date.now();
  const plan = { version: 1, target: 'crm', source_commit: info.commit, migration: NAME, migration_sha256: info.migration_sha256, generated_at: new Date(now).toISOString(), before };
  assert.doesNotThrow(() => validateBefore(plan, before, info, 'crm', now));
  for (const patch of [{ target: 'dev' }, { source_commit: 'wrong' }, { migration: 'other' }, { migration_sha256: 'wrong' }, { generated_at: new Date(now + 1).toISOString() }, { generated_at: new Date(now - 7200001).toISOString() }]) assert.throws(() => validateBefore({ ...plan, ...patch }, before, info, 'crm', now));
  assert.throws(() => validateBefore(plan, { ...before, programs_sha256: 'changed' }, info, 'crm', now));
  const partial = { ...before, columns: [...before.columns, column] };
  assert.throws(() => validateBefore({ ...plan, before: partial }, partial, info, 'crm', now), /PARTIAL/);
  const registered = { ...before, registered: true };
  assert.throws(() => validateBefore({ ...plan, before: registered }, registered, info, 'crm', now), /PARTIAL/);
});
test('bounded DDL adapter permits one online ADD only, never defaults, arbitrary tables or implicit copy fallback', async () => {
  const calls = [], connection = { query: async (...args) => { calls.push(args); return [[{ COLUMN_NAME: 'id', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO' }]]; } };
  const Sequelize = { JSON: {} }, qi = boundedQueryInterface(connection, Sequelize);
  assert.deepEqual(await qi.describeTable('TreatmentPrograms'), { id: { type: 'INT', allowNull: false } });
  await qi.addColumn('TreatmentPrograms', 'price_profile', { type: Sequelize.JSON, allowNull: true });
  assert.equal(calls[1][0], 'ALTER TABLE `TreatmentPrograms` ADD COLUMN `price_profile` JSON NULL, ALGORITHM=INSTANT');
  for (const [table, field, spec] of [['Pacientes', 'price_profile', { type: Sequelize.JSON, allowNull: true }], ['TreatmentPrograms', 'tax', { type: Sequelize.JSON, allowNull: true }], ['TreatmentPrograms', 'price_profile', { type: Sequelize.JSON, allowNull: true, defaultValue: {} }], ['TreatmentPrograms', 'price_profile', { type: Sequelize.JSON, allowNull: false }]]) await assert.rejects(qi.addColumn(table, field, spec), /UNEXPECTED_DDL/);
  await assert.rejects(qi.describeTable('Pacientes'), /UNEXPECTED_TABLE/);
  assert.equal(calls.length, 2);
});
test('schema journal is exclusively created, private and hash chained; another target cannot reuse its path', async () => {
  const dir = fs.mkdtempSync('/home/ubuntu/secure-imports/program-schema-journal-test-'); fs.chmodSync(dir, 0o700);
  const filename = path.join(dir, 'journal.jsonl'), journal = newJournal(filename, 'a'.repeat(64));
  try {
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.throws(() => newJournal(filename, 'b'.repeat(64)), /EEXIST/);
    await journal.append({ phase: 'before_ddl' }); await journal.append({ phase: 'verified' });
    const entries = fs.readFileSync(filename, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries[0].sequence, 1); assert.equal(entries[1].sequence, 2);
    assert.equal(entries[1].previous_entry_sha256, entries[0].entry_sha256);
    assert.equal(entries[1].package_sha256, 'a'.repeat(64));
  } finally { journal.close(); }
});

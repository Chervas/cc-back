'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const cut = require('../clinical-workspace-schema-release'), { hash } = require('../../lib/cliniccloud-import/adapter');
test('schema operator refuses non-DEV identities and is bound to both reviewed migration names', async () => {
  assert.deepEqual(cut.MIGRATIONS, ['20261020193000-clinical-episodes-foundation.js', '20261020200000-clinical-drawings.js']);
  const valid = { database_name: 'clinicaclick_dev_isolated', database_user: 'cc_dev_api@localhost', fictional_anchor: 1 };
  assert.doesNotThrow(() => cut.assertIdentity(valid));
  for (const patch of [{ database_name: 'clinicaclick' }, { database_user: 'root@localhost' }, { fictional_anchor: 0 }]) {
    assert.throws(() => cut.assertIdentity({ ...valid, ...patch }), /ISOLATED_FICTIONAL_DATABASE_REQUIRED/);
  }
  await assert.rejects(cut.run(['--mode', 'inspect', '--target', 'crm']), /EXPLICIT_DEV_MODE_REQUIRED/);
});
test('write phase requires stopped API and worker, while preserving unknown/active states', () => {
  assert.doesNotThrow(() => cut.assertStopped(() => 'inactive\n'));
  for (const status of ['active', 'activating', 'deactivating', 'unknown', '']) assert.throws(() => cut.assertStopped(() => status), /STOP_DEV_WRITERS_FIRST/);
});
test('plan rejects drift, partial schema, changed source, expired approvals and unrelated migration bytes', () => {
  const before = { columns: [], tables: [], metadata_names: ['prior.js'] }, info = { commit: 'a'.repeat(40), migrations: cut.MIGRATIONS.map(name => ({ name, sha256: 'b'.repeat(64) })) };
  const plan = { version: cut.VERSION, target: 'dev', source_commit: info.commit, migrations: info.migrations, generated_at: new Date().toISOString(), before };
  assert.doesNotThrow(() => cut.validatePlan(plan, info, before));
  for (const patch of [{ target: 'crm' }, { source_commit: 'x' }, { generated_at: '2020-01-01T00:00:00Z' }, { migrations: [{ name: 'unrelated.js', sha256: 'x' }] }]) {
    assert.throws(() => cut.validatePlan({ ...plan, ...patch }, info, before), /PLAN_INVALID_OR_EXPIRED/);
  }
  assert.throws(() => cut.validatePlan(plan, info, { ...before, metadata_names: ['other.js'] }), /PLAN_DRIFT/);
  assert.throws(() => cut.assertUnapplied({ ...before, metadata_names: [cut.MIGRATIONS[0]] }), /PARTIAL_OR_EXISTING/);
  assert.throws(() => cut.assertUnapplied({ ...before, tables: [{ TABLE_NAME: 'ClinicalDrawings' }] }), /PARTIAL_OR_EXISTING/);
});
test('backup manifest requires exact isolated target, host, complete private dump and all prerequisite tables', () => {
  const plan = { before: { server_sha256: hash('owned-server') } }, backup = { version: 'cliniccloud-operator-backup/1', database_target: 'dev',
    database_name: 'clinicaclick_dev_isolated', server_name: 'owned-server', full_gzip_verified: true, dump_completion_verified: true,
    tables: [...cut.PARENTS], generated_at: new Date().toISOString() };
  assert.doesNotThrow(() => cut.validateBackupManifest(backup, plan));
  for (const patch of [{ database_target: 'crm' }, { server_name: 'other-server' }, { full_gzip_verified: false }, { tables: ['SequelizeMeta'] }, { generated_at: '2020-01-01T00:00:00Z' }]) {
    assert.throws(() => cut.validateBackupManifest({ ...backup, ...patch }, plan), /FRESH_BACKUP_REQUIRED/);
  }
});

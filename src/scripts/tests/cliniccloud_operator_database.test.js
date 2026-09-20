'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { databaseOptions } = require('../../lib/cliniccloud-import/operator-database');
function inputs(database = 'clinicaclick_dev_isolated', user = 'cc_dev_api') {
  return { stat: () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o100600 }),
    readFile: () => Buffer.from(`DB_HOST=localhost\nDB_USERNAME=${user}\nDB_NAME=${database}\nDB_PASSWORD=synthetic-test-password\n`) };
}
test('operator target must be explicit and cannot read arbitrary credential paths', () => {
  for (const target of [undefined, '', '../crm', '__proto__', 'staging']) assert.throws(() => databaseOptions(target, inputs()), /EXPLICIT_DATABASE_TARGET_REQUIRED/);
});
test('isolated DEV is pinned and CRM cannot alias the isolated database', () => {
  assert.equal(databaseOptions('dev', inputs()).database, 'clinicaclick_dev_isolated');
  assert.throws(() => databaseOptions('dev', inputs('clinical', 'clinical_operator')), /TARGET_MISMATCH/);
  assert.throws(() => databaseOptions('crm', inputs()), /TARGET_MISMATCH/);
  assert.equal(databaseOptions('crm', inputs('clinical', 'clinical_operator')).multipleStatements, false);
});
test('rejects symlinks, permissive files and incomplete config', () => {
  const context = inputs();
  assert.throws(() => databaseOptions('crm', { ...context, stat: () => ({ isFile: () => true, isSymbolicLink: () => true }) }), /PERMISSIONS/);
  assert.throws(() => databaseOptions('crm', { ...context, stat: () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o100644 }) }), /PERMISSIONS/);
  assert.throws(() => databaseOptions('crm', { ...context, readFile: () => '' }), /CONFIG_INCOMPLETE/);
});
test('does not change process credentials or use existing process.env overrides', () => {
  const before = { ...process.env };
  databaseOptions('dev', inputs());
  assert.deepEqual({ ...process.env }, before);
});

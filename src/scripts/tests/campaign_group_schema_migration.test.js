'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260928180000-repair-google-ads-group-account-nullability');

test('repair changes only mandatory signed-int clinic nullability without dropping FKs or indexes', async () => {
  for (const type of ['int', 'int(11)']) {
    const calls = [];
    await migration.up({ sequelize: { query: async sql => {
      calls.push(sql); return [[{ COLUMN_TYPE: type, IS_NULLABLE: 'NO' }]];
    } } });
    assert.equal(calls.length, 2);
    assert.equal(calls[1], 'ALTER TABLE `ClinicGoogleAdsAccounts` MODIFY COLUMN `clinicaId` INT NULL DEFAULT NULL');
  }
});
test('existing group-compatible databases are unchanged on repeated migration', async () => {
  let calls = 0;
  await migration.up({ sequelize: { query: async () => { calls++; return [[{ COLUMN_TYPE: 'int', IS_NULLABLE: 'YES' }]]; } } });
  assert.equal(calls, 1);
});
test('unexpected schema and destructive rollback fail closed', async () => {
  for (const columns of [[], [{ COLUMN_TYPE: 'bigint', IS_NULLABLE: 'NO' }], [{ COLUMN_TYPE: 'int unsigned', IS_NULLABLE: 'NO' }],
    [{ COLUMN_TYPE: 'int', IS_NULLABLE: 'unknown' }]]) {
    let calls = 0;
    await assert.rejects(migration.up({ sequelize: { query: async () => { calls++; return [columns]; } } }), /UNEXPECTED_GOOGLE_ADS/);
    assert.equal(calls, 1);
  }
  await assert.rejects(migration.down(), /DO_NOT_REVERT/);
});

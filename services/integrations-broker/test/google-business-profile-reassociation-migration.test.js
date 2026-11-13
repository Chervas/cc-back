'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');
const M = require('../src/google-business-profile-reassociation-migration');
const { TABLES, createBusinessProfileReassociation } = require('../src/google-business-profile-reassociation');

test('explicit additive ledger migration preserves existing authority and supports read-only reconciliation', t => {
  const f = fixture(t);
  f.store.db.prepare('INSERT INTO google_business_profile_retirements VALUES (?,?,?,?,?,?)')
    .run('clinic:123', 'connection:test', 'gbp:123:456', '456', '10000000-0000-4000-8000-000000000001', 1700000000123);
  const before = M.snapshot(f.store.db), plan = M.planSchema(f.store.db);
  assert.deepEqual(M.snapshot(f.store.db), before, 'planning is read only');
  const result = M.applySchema(f.store.db, plan);
  assert.deepEqual(result.protectedRows, before.protectedRows);
  assert.deepEqual(Object.values(result.newTableCounts), [0, 0, 0]);
  assert.deepEqual(M.verifySchema(f.store.db, plan), result);
  const after = M.snapshot(f.store.db);
  assert.throws(() => M.applySchema(f.store.db, plan), /plan_stale/);
  assert.deepEqual(M.snapshot(f.store.db), after, 'a lost answer never authorizes replay');
});

test('a stale authority snapshot prevents every schema statement', t => {
  const f = fixture(t), plan = M.planSchema(f.store.db);
  f.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)')
    .run('clinic:123', 'connection:test', 'gbp:123:456', '10000000-0000-4000-8000-000000000001', 1700000000123);
  assert.throws(() => M.applySchema(f.store.db, plan), /plan_stale/);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'google_business_profile_reassoc%'").get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM asset_revocations').get().n, 1);
});

test('failure after the first additive DDL rolls back all new objects without changing old rows', t => {
  const f = fixture(t), before = M.snapshot(f.store.db), plan = M.planSchema(f.store.db);
  let calls = 0;
  const db = { prepare: f.store.db.prepare.bind(f.store.db), exec(sql) {
    if (sql.startsWith('CREATE ') && ++calls === 2) throw Error('FICTITIOUS_DDL_FAILURE');
    return f.store.db.exec(sql);
  } };
  assert.throws(() => M.applySchema(db, plan), /FICTITIOUS_DDL_FAILURE/);
  assert.deepEqual(M.snapshot(f.store.db), before);
});

test('normal Owner construction never installs the reassociation ledger', t => {
  const f = fixture(t), before = M.snapshot(f.store.db);
  createBusinessProfileReassociation({ store: f.store });
  assert.deepEqual(M.snapshot(f.store.db), before);
  for (const table of TABLES) assert.equal(f.store.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table), undefined);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const release = require('../../lib/googleBusinessProfileWritesSchemaRelease');
const { digest } = require('../../lib/securitySchemaContract');
const operator = require('../google-business-profile-writes-schema-release');

const sha = value => createHash('sha256').update(value).digest('hex');

function fixture() {
  const baseTable = {
    TABLE_NAME: 'SequelizeMeta',
    ENGINE: 'InnoDB',
    TABLE_COLLATION: 'utf8mb4_unicode_ci',
  };
  const before = {
    defaults: { DEFAULT_CHARACTER_SET_NAME: 'utf8mb4', DEFAULT_COLLATION_NAME: 'utf8mb4_unicode_ci' },
    tables: [baseTable],
    columns: [],
    indexes: [],
    checks: [],
    foreignKeys: [],
    migrations: ['historical.js'],
  };
  const writeTables = Object.fromEntries(release.TABLES.map(name => [name, {
    ENGINE: 'InnoDB',
    TABLE_COLLATION: 'ascii_bin',
    columns: [],
    indexes: [],
    checks: [],
    foreignKeys: [],
  }]));
  const hashes = Object.fromEntries(release.MIGRATIONS.map(name => [name, sha(name)]));
  const baseContract = {
    defaults: before.defaults,
    tables: { SequelizeMeta: { ...baseTable, columns: [], indexes: [] } },
    migrations: [{ name: 'historical.js', sha256: sha('historical') }],
  };
  const targetContract = {
    defaults: before.defaults,
    tables: { ...baseContract.tables, ...writeTables },
    migrations: [...baseContract.migrations, ...release.MIGRATIONS.map(name => ({ name, sha256: hashes[name] }))],
  };
  const info = { revision: 'a'.repeat(40), contractDigest: sha('contract'), migrations: hashes, baseContract, targetContract };
  const plan = {
    version: 1,
    kind: 'google_business_profile_writes_schema_v1',
    runtime: 'staging',
    database: 'clinicaclick',
    revision: info.revision,
    contractDigest: info.contractDigest,
    beforeDigest: digest(before),
    before,
    migrations: release.MIGRATIONS.map(name => ({ name, sha256: hashes[name] })),
  };
  return { before, info, plan };
}

test('the public GBP write plan accepts exactly the two missing migrations and three tables', () => {
  const { before, info, plan } = fixture();
  assert.doesNotThrow(() => release.validate(plan, before, info, 'clinicaclick'));
});

test('the public GBP write plan rejects a partial table or unrelated schema drift', () => {
  const { before, info, plan } = fixture();
  const partial = structuredClone(before);
  partial.tables.push({ TABLE_NAME: release.TABLES[0], ENGINE: 'InnoDB', TABLE_COLLATION: 'ascii_bin' });
  partial.migrations.push(release.MIGRATIONS[0]);
  const partialPlan = { ...plan, before: partial, beforeDigest: digest(partial) };
  assert.throws(() => release.validate(partialPlan, partial, info, 'clinicaclick'));

  const drift = structuredClone(before);
  drift.tables[0].ENGINE = 'MyISAM';
  const driftPlan = { ...plan, before: drift, beforeDigest: digest(drift) };
  assert.throws(() => release.validate(driftPlan, drift, info, 'clinicaclick'));
});

test('the public GBP write plan is pinned to staging, database, commit and migration hashes', () => {
  const { before, info, plan } = fixture();
  for (const candidate of [
    { ...plan, runtime: 'dev' },
    { ...plan, database: 'clinicaclick_dev_isolated' },
    { ...plan, revision: 'b'.repeat(40) },
    { ...plan, migrations: plan.migrations.slice(0, 1) },
    { ...plan, migrations: plan.migrations.map((row, index) => index ? row : { ...row, sha256: '0'.repeat(64) }) },
  ]) assert.throws(() => release.validate(candidate, before, info, candidate.database));
});

test('metadata comparison can prove that existing schema remains byte-for-byte unchanged', () => {
  const { before } = fixture();
  const after = structuredClone(before);
  for (const name of release.TABLES) after.tables.push({ TABLE_NAME: name, ENGINE: 'InnoDB', TABLE_COLLATION: 'ascii_bin' });
  after.migrations.push(...release.MIGRATIONS);
  assert.equal(digest(release.withoutWriteSchema(after)), digest(release.withoutWriteSchema(before)));
  after.tables[0].ENGINE = 'MyISAM';
  assert.notEqual(digest(release.withoutWriteSchema(after)), digest(release.withoutWriteSchema(before)));
});

test('the operator accepts only an absolute source and a private recovery directory', () => {
  assert.deepEqual(operator.parse([
    'plan', '--source', '/home/ubuntu/wt/back-dev', '--dir',
    '/var/lib/clinicaclick-schema-recovery/google-gbp-writes-20260925',
  ]), {
    action: 'plan',
    source: '/home/ubuntu/wt/back-dev',
    directory: '/var/lib/clinicaclick-schema-recovery/google-gbp-writes-20260925',
  });
  for (const argv of [
    ['apply', '--source', '.', '--dir', '/var/lib/clinicaclick-schema-recovery/google-gbp-writes-20260925'],
    ['plan', '--source', '/home/ubuntu/wt/back-dev', '--dir', '/tmp/google-gbp-writes-20260925'],
    ['all', '--source', '/home/ubuntu/wt/back-dev', '--dir', '/var/lib/clinicaclick-schema-recovery/google-gbp-writes-20260925'],
  ]) assert.throws(() => operator.parse(argv), /google_business_profile_writes_arguments_invalid/);
});

test('writer detection excludes only the schema operator itself', () => {
  assert.equal(operator.isPublicWriter('123', '/home/ubuntu/wt/back-staging', ['node', 'src/scripts/google-business-profile-writes-schema-release.js'], 123), false);
  assert.equal(operator.isPublicWriter('124', '/home/ubuntu/wt/back-staging', ['node', 'src/app.js'], 123), true);
  assert.equal(operator.isPublicWriter('124', '/home/ubuntu/wt/front-staging', ['node', 'src/app.js'], 123), false);
});

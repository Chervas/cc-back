'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { EventEmitter } = require('node:events');
const P = require('../../lib/rdsSchemaMigrationPolicy'), R = require('../../lib/rdsSchemaFirstCreateReconciliation');
const C = require('../../lib/rdsSchemaMigration'), { digest } = require('../../lib/securitySchemaContract');
const SOURCE = path.resolve(__dirname, '../../..'), names = R.BS_ACKED.selected.map(row => row.name);
const clone = structuredClone;
require('node:net').Socket.prototype.connect = () => { throw Error('TEST_ONLY_network_forbidden'); };
require('node:tls').connect = () => { throw Error('TEST_ONLY_network_forbidden'); };

async function fixture() {
  const createdAt = Date.parse('2026-11-18T08:28:00Z');
  const before = { defaults: { DEFAULT_CHARACTER_SET_NAME: 'utf8mb4', DEFAULT_COLLATION_NAME: 'utf8mb4_0900_ai_ci' },
    tables: ['PatientFollowUps', 'SequelizeMeta', 'SocialAdsEntities', 'SocialPosts'].map(TABLE_NAME => ({ TABLE_NAME, ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_0900_ai_ci' })),
    columns: ['PatientFollowUps', 'SocialAdsEntities', 'SocialPosts'].map(TABLE_NAME => ({ TABLE_NAME, COLUMN_NAME: 'id', COLUMN_TYPE: 'int',
      IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: '', CHARACTER_SET_NAME: null, COLLATION_NAME: null, GENERATION_EXPRESSION: '' })),
    indexes: [], foreignKeys: [], checks: [], triggers: [], migrations: ['20200101000000-synthetic.js'] };
  const identity = { physicalDbId: 'TEST_ONLY_OWNED', engineVersion: '8.4.11', database: 'TEST_ONLY' };
  const plan = { schema: P.PLAN_SCHEMA, sourceRevision: R.BS_ACKED.sourceRevision, contractDigest: R.BS_ACKED.contractDigest,
    effectiveContractDigest: R.BS_ACKED.effectiveContractDigest, before, beforeDigest: digest(before), identity,
    selected: R.BS_ACKED.selected.map(row => ({ ...row, alreadyApplied: false })), toApply: names,
    moduleFiles: P.migrationFiles(SOURCE, names), createdAtEpochMs: createdAt };
  const backup = { snapshotId: R.BS_ACKED.snapshotId, status: 'available', physicalDbId: identity.physicalDbId, createdAt: '2026-11-18T08:30:00Z' };
  const result = { status: 'rds_schema_failed_preserve_partial', reason: 'rds_schema_sql_scope', operationNonce: R.BS_ACKED.originalOperationNonce,
    planRef: { sha256: R.BS_ACKED.originalPlanSha256 }, writesDispatched: 2, transportOpened: true, automaticReplayAllowed: false,
    closure: { physicalCloseObserved: true, physicalStreamDestroyed: true }, backup };
  const journal = [{ event: 'backup_request', snapshotId: backup.snapshotId }, { event: 'backup_create_ack', snapshotId: backup.snapshotId },
    { event: 'backup_available', ...backup },
    { event: 'statement_request', migration: names[0], kind: 'ddl', sqlSha256: R.BS_ACKED.sqlSha256 },
    { event: 'statement_ack', migration: names[0], kind: 'ddl', sqlSha256: R.BS_ACKED.sqlSha256, warnings: 0 },
    { event: 'statement_request', migration: names[0], kind: 'sequelize_meta', sqlSha256: R.BS_ACKED.metaSqlSha256 },
    { event: 'statement_ack', migration: names[0], kind: 'sequelize_meta', sqlSha256: R.BS_ACKED.metaSqlSha256, warnings: 0, affectedRows: 1 },
    { event: 'terminal', status: result.status, accepted: false, writesDispatched: 2 }].map((row, i) => ({ atEpochMs: createdAt + 360000 + i, ...row }));
  const observed = clone(before); observed.columns.splice(1, 0, await R.acknowledgedMonthDefinition(SOURCE, plan));
  observed.migrations.push(names[0]); observed.migrations.sort();
  return { source: SOURCE, originalPlan: plan, observed, identity, result, journal };
}

test('only the exact fully ACKed month migration is reconciled; metadata includes its sole column and SequelizeMeta row', async () => {
  const f = await fixture(), proof = await R.validate(f);
  assert.equal(proof.kind, R.BS_ACKED.kind); assert.deepEqual(proof.completedMigrations, [names[0]]);
  assert.equal(proof.replayedStatements, 0); assert.equal(proof.statements, undefined);
  assert.deepEqual(proof.originalAcknowledgements.map(row => row.journalIndex), [4, 6]);
  assert.deepEqual(proof.originalDiagnostics, { count: 0, retainedAcknowledgements: true });
});

test('known prefix rejects nonce/plan/source/hash, metadata drift, missing ACK, warning, later request and unknown closure', async () => {
  const base = await fixture();
  const changes = [
    f => { f.result.operationNonce = 'foreign'; }, f => { f.result.planRef.sha256 = '0'.repeat(64); },
    f => { f.originalPlan.sourceRevision = '0'.repeat(40); }, f => { f.originalPlan.contractDigest = '0'.repeat(64); },
    f => { f.originalPlan.effectiveContractDigest = '0'.repeat(64); }, f => { f.originalPlan.continuation = {}; },
    f => { f.originalPlan.selected[0].sha256 = '0'.repeat(64); },
    f => { f.originalPlan.selected[1].sha256 = '0'.repeat(64); }, f => { f.originalPlan.moduleFiles[0].sha256 = '0'.repeat(64); },
    f => { f.result.reason = 'rds_schema_statement_outcome_requires_reconciliation'; }, f => { f.result.writesDispatched = 3; },
    f => { f.result.automaticReplayAllowed = true; }, f => { f.result.transportOpened = false; },
    f => { f.result.closure.physicalCloseObserved = false; }, f => { f.result.closure.physicalStreamDestroyed = false; },
    f => { f.journal[3].sqlSha256 = '0'.repeat(64); }, f => { f.journal[5].sqlSha256 = '0'.repeat(64); },
    f => { f.journal[4].warnings = 1; }, f => { f.journal[6].warnings = 1; }, f => { f.journal[6].affectedRows = 0; },
    f => { f.journal.splice(4, 1); }, f => { f.journal.splice(7, 0, { event: 'statement_request', migration: names[1] }); },
    f => { f.journal.splice(7, 0, { event: 'statement_diagnostics', warningReadFailed: false, warningStatus: 0, diagnostics: [] }); },
    f => { f.journal[7].accepted = true; }, f => { f.journal[3].atEpochMs = Date.parse('2025-11-18T08:30:00Z'); },
    f => { f.result.backup.status = 'pending'; }, f => { f.result.backup.createdAt = '2025-11-18T08:30:00Z'; },
    f => { f.identity.engineVersion = '8.4.12'; }, f => { f.identity.physicalDbId = 'foreign'; },
    f => { f.observed.columns[1].COLUMN_TYPE = 'varchar(8)'; }, f => { f.observed.columns[1].IS_NULLABLE = 'NO'; },
    f => { f.observed.columns[1].COLUMN_DEFAULT = '2027-01'; }, f => { f.observed.columns[1].COLLATION_NAME = 'utf8mb4_bin'; },
    f => { f.observed.columns[0].EXTRA = 'auto_increment'; }, f => { f.observed.columns.reverse(); },
    f => { f.observed.indexes.push({ INDEX_NAME: 'foreign' }); }, f => { f.observed.triggers.push({ TRIGGER_NAME: 'foreign' }); },
    f => { f.observed.migrations.push(names[1]); }, f => { f.observed.migrations = []; }, f => { f.observed.tables.pop(); },
  ];
  for (const change of changes) { const f = clone(base); change(f); await assert.rejects(R.validate(f), /rds_schema_reconciliation_/); }
});

test('new plan retains all three selected hashes and omits only the completed migration without a SQL-prefix skip', async () => {
  const f = await fixture();
  const plan = P.buildPlan({ info: { revision: 'b'.repeat(40), contractDigest: f.originalPlan.contractDigest,
    contract: { tables: {}, migrations: [] }, migrations: Object.fromEntries(R.BS_ACKED.selected.map(row => [row.name, row.sha256])) },
    before: f.observed, identity: f.identity, selected: names, moduleFiles: f.originalPlan.moduleFiles, profile: 'TEST_ONLY', at: Date.now(),
    continuation: { proof: await R.validate(f) } });
  assert.equal(plan.selected.length, 3); assert.equal(plan.selected[0].alreadyApplied, true);
  assert.deepEqual(plan.toApply, names.slice(1));
  const sql = [], events = [], raw = { query(options, values, callback) {
    if (typeof values === 'function') callback = values;
    const statement = typeof options === 'string' ? options : options.sql; sql.push(statement);
    const result = statement === 'SHOW WARNINGS' ? [] : /^SHOW FULL COLUMNS/.test(statement)
      ? [{ Field: 'id', Type: 'int', Null: 'NO', Key: 'PRI', Default: null, Extra: '', Comment: '' }]
      : { affectedRows: 0, warningStatus: 0 };
    queueMicrotask(() => callback(null, result)); return new EventEmitter();
  } }; raw.execute = raw.query;
  for (const name of plan.toApply) {
    const bridge = C.migrationInterface({ admin: { raw, identity: { database: 'clinicaclick', engineVersion: '8.4.11' } },
      aws: { assertFresh() {} }, journal: event => events.push(event), migrationName: name, continuation: null });
    const loaded = P.loadMigration(SOURCE, name, plan.moduleFiles, require('sequelize'));
    try { await loaded.migration.up(bridge.queryInterface, loaded.facade); } finally { await bridge.restore(); }
  }
  assert.equal(sql.filter(value => /^ALTER TABLE/.test(value)).length, 2);
  assert(!sql.some(value => P.sha(value) === R.BS_ACKED.sqlSha256));
  assert.equal(events.filter(event => event.event === 'statement_ack').length, 2);
  assert(!events.some(event => event.event === 'statement_reconciled'));
});

test('the exact old operator-pin allowlist never relaxes unrelated source or the ordinary requirements verifier', async () => {
  const f = await fixture(), original = P.assertRequirements;
  const old = [...Object.entries(R.BS_ACKED_OPERATOR_UPGRADE).map(([path, sha256]) => ({ path, sha256 })),
    { path: 'src/lib/rdsSchemaMigrationTransport.js', sha256: 'a'.repeat(64) }].sort((a, b) => a.path.localeCompare(b.path));
  f.originalPlan.operatorFiles = old;
  const info = { operatorFiles: old.map(row => ({ ...row, sha256: Object.hasOwn(R.BS_ACKED_OPERATOR_UPGRADE, row.path) ? 'b'.repeat(64) : row.sha256 })) };
  let called = 0;
  P.assertRequirements = (plan, current, selected) => { called++; assert.equal(plan.effectiveContractDigest, R.BS_ACKED.effectiveContractDigest);
    assert.equal(current, info); assert.deepEqual(plan.operatorFiles, info.operatorFiles); assert.deepEqual(selected, names); return 'verified'; };
  try {
    assert.equal(R.assertOriginalRequirements(f.originalPlan, info, names, R.BS_ACKED.originalPlanSha256), 'verified');
    assert.equal(called, 1);
    for (const mutate of [x => { x.operatorFiles.at(-1).sha256 = 'c'.repeat(64); },
      x => { x.operatorFiles.push({ path: 'extra.js', sha256: 'b'.repeat(64) }); }]) {
      const changed = clone(info); mutate(changed);
      assert.throws(() => R.assertOriginalRequirements(f.originalPlan, changed, names, R.BS_ACKED.originalPlanSha256), /operator_source_changed/);
    }
    assert.throws(() => R.assertOriginalRequirements(f.originalPlan, info, names, '0'.repeat(64)), /original_run_changed/);
    f.originalPlan.operatorFiles[0].sha256 = '0'.repeat(64);
    assert.throws(() => R.assertOriginalRequirements(f.originalPlan, info, names, R.BS_ACKED.originalPlanSha256), /operator_source_changed/);
    assert.equal(called, 1);
  } finally { P.assertRequirements = original; }
});

test('SQL string semicolons and escaped quotes remain data; separators, outside comments and unterminated literals fail closed', () => {
  for (const comment of ["'normal synchronization; never a thumbnail'", "'it''s a semicolon; string'", "'it\\'s still; data'", "'/* # -- ; DROP TABLE quoted text */'"])
    assert.equal(P.statementKind('ALTER TABLE `SocialPosts` ADD `original_media_url` TEXT COMMENT ' + comment + ';'), 'ddl');
  for (const sql of ['ALTER TABLE x ADD y TEXT; SELECT 1', "ALTER TABLE x ADD y TEXT COMMENT 'value'; DROP TABLE x;",
    "ALTER TABLE x ADD y TEXT COMMENT 'unterminated;", "ALTER TABLE x ADD y TEXT COMMENT 'ending\\'",
    'ALTER TABLE x ADD y TEXT /* outer */', 'ALTER TABLE x ADD y TEXT -- outer', 'ALTER TABLE x ADD y TEXT # outer',
    "ALTER TABLE `x';SELECT` ADD y TEXT", 'ALTER TABLE `unterminated ADD y TEXT', 'ALTER TABLE x ADD y TEXT;;'])
    assert.throws(() => P.statementKind(sql), /rds_schema_/);
});

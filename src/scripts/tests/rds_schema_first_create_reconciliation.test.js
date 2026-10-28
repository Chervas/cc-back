'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
require('node:net').Socket.prototype.connect = () => { throw Error('TEST_ONLY_network_forbidden'); };
require('node:tls').connect = () => { throw Error('TEST_ONLY_network_forbidden'); };
const P = require('../../lib/rdsSchemaMigrationPolicy'), C = require('../../lib/rdsSchemaMigration'), R = require('../../lib/rdsSchemaFirstCreateReconciliation');
const W = require('../../lib/rdsSchemaWarningPolicy'), { digest } = require('../../lib/securitySchemaContract');
const SOURCE = path.resolve(__dirname, '../../..'), clone = value => structuredClone(value);
async function fixture(t, selected = R.SUPPORTED) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rds-create-reconcile-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = root + '/source'; fs.mkdirSync(source); fs.mkdirSync(source + '/migrations');
  fs.copyFileSync(SOURCE + '/migrations/' + selected.migration, source + '/migrations/' + selected.migration);
  const before = { defaults: { DEFAULT_CHARACTER_SET_NAME: 'utf8mb4', DEFAULT_COLLATION_NAME: 'utf8mb4_0900_ai_ci' },
    tables: [{ TABLE_NAME: 'Clinicas', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_0900_ai_ci' }],
    columns: ['id_clinica','label'].map(name => ({ TABLE_NAME: 'Clinicas', COLUMN_NAME: name, COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null,
      EXTRA: '', CHARACTER_SET_NAME: null, COLLATION_NAME: null, GENERATION_EXPRESSION: '' })), indexes: [], checks: [], foreignKeys: [], migrations: [], triggers: [] };
  const identity = { physicalDbId: 'db-TEST_ONLY', engineVersion: '8.4.11', serverUuid: 'TEST_ONLY_UUID' };
  const info = { revision: selected.sourceRevision || 'a'.repeat(40), contractDigest: 'b'.repeat(64), contract: { tables: {}, migrations: [] }, migrations: { [selected.migration]: selected.migrationSha256 } };
  const plan = P.buildPlan({ info, before, identity, selected: [selected.migration], moduleFiles: P.migrationFiles(source, [selected.migration]), profile: 'TEST_ONLY', at: Date.now() });
  const shape = await R.definition(source, plan), observed = clone(before);
  observed.tables.push(shape.table); observed.columns.push(...shape.columns); observed.indexes.push(...shape.indexes); observed.foreignKeys.push(...shape.foreignKeys);
  const result = { status: 'rds_schema_failed_preserve_partial', reason: 'rds_schema_statement_warnings_require_reconciliation', writesDispatched: 1,
    automaticReplayAllowed: false, transportOpened: true, backup: { status: 'available', physicalDbId: identity.physicalDbId, createdAt: new Date(plan.createdAtEpochMs).toISOString() },
    closure: { physicalCloseObserved: true, physicalStreamDestroyed: true } };
  const journal = [{ event: 'statement_request', migration: selected.migration, kind: 'ddl', sqlSha256: selected.sqlSha256 },
    { event: 'terminal', accepted: false }];
  if (selected === R.DELEGATED) {
    result.operationNonce = selected.originalOperationNonce; result.planRef = { sha256: selected.originalPlanSha256 };
    journal.splice(1, 0, { event: 'statement_diagnostics', migration: selected.migration, kind: 'ddl', sqlSha256: selected.sqlSha256,
      warningReadFailed: false, warningStatus: 2, policy: W.NAME,
      diagnostics: Array.from({ length: 2 }, () => ({ level: 'Warning', code: 1287, messageSha256: selected.diagnosticMessageSha256 })) });
  }
  return { root, source, before, identity, info, plan, shape, observed, result, journal };
}
const validate = f => R.validate({ source: f.source, originalPlan: f.plan, observed: f.observed, identity: f.identity, result: f.result, journal: f.journal });
test('only the known first CREATE is reconciled from its exact pinned metadata; original warning remains unknown', async t => {
  const f = await fixture(t), proof = await validate(f);
  assert.equal(proof.sqlSha256, R.SUPPORTED.sqlSha256); assert.equal(proof.observedDigest, digest(f.observed));
  assert.equal(proof.originalWarning, 'not_retained_by_original_operator_unknown');
  assert.equal(proof.originalBeforeDigest, f.plan.beforeDigest);
});
test('compatible but different table/index/FK/column/default/order or unrelated metadata is refused', async t => {
  const f = await fixture(t);
  const mutations = [
    x => x.observed.indexes.push({ TABLE_NAME: 'ClinicSuppliers', INDEX_NAME: 'clinic_suppliers_scope' }),
    x => { x.observed.foreignKeys.at(-1).DELETE_RULE = 'CASCADE'; },
    x => { x.observed.columns.at(-1).IS_NULLABLE = 'YES'; },
    x => { x.observed.columns.at(-1).COLUMN_DEFAULT = 'unexpected'; },
    x => { const a = x.observed.columns.length - 1, b = a - 1; [x.observed.columns[a], x.observed.columns[b]] = [x.observed.columns[b], x.observed.columns[a]]; },
    x => { [x.observed.columns[0], x.observed.columns[1]] = [x.observed.columns[1], x.observed.columns[0]]; },
    x => { x.observed.tables[0].ENGINE = 'MyISAM'; },
    x => { x.observed.foreignKeys.pop(); },
    x => { x.observed.triggers.push({ TRIGGER_NAME: 'unexpected' }); },
    x => { x.observed.migrations.push(R.SUPPORTED.migration); },
    x => { x.observed.defaults.DEFAULT_COLLATION_NAME = 'latin1_swedish_ci'; },
  ];
  for (const mutate of mutations) { const x = { ...f, observed: clone(f.observed) }; mutate(x); await assert.rejects(validate(x), /metadata_drift/); }
});
test('different source/SQL/identity, extra dispatched statement, ACK, or uncertain result cannot authorize a skip', async t => {
  const f = await fixture(t);
  for (const mutate of [x => { x.identity.physicalDbId = 'foreign'; }, x => { x.journal[0].sqlSha256 = '0'.repeat(64); },
    x => { x.journal.unshift(clone(x.journal[0])); }, x => { x.journal.unshift({ event: 'statement_ack' }); },
    x => { x.result.writesDispatched = 2; }, x => { x.result.reason = 'rds_schema_statement_outcome_requires_reconciliation'; },
    x => { x.result.backup.status = 'pending'; }, x => { x.result.backup.physicalDbId = 'foreign'; },
    x => { x.result.closure.physicalCloseObserved = false; }]) {
    const x = { ...f, identity: clone(f.identity), result: clone(f.result), journal: clone(f.journal) }; mutate(x);
    await assert.rejects(validate(x), /rds_schema_reconciliation_/);
  }
  fs.appendFileSync(f.source + '/migrations/' + R.SUPPORTED.migration, '\n// changed reviewed source\n');
  await assert.rejects(validate(f), /source_changed/);
});
test('continuation ledger keeps old artifacts, claims one successor atomically and remains fenced after a pre-DDL failure', async t => {
  const f = await fixture(t), owner = process.getuid(), store = C.createStore(f.root + '/ledger', owner);
  C.privateDirectory(f.root + '/plan', owner); const planRef = C.writePrivate(f.root + '/plan/original.json', f.plan);
  const old = store.start(planRef); old.journal(f.journal[0]);
  old.finish({ ...f.result, planRef, transportOpened: true }, false);
  const pending = store.pending(old.directory), originalBytes = fs.readFileSync(old.directory + '/journal.jsonl');
  const nextRef = C.writePrivate(f.root + '/plan/next.json', { TEST_ONLY: true });
  const successor = store.start(nextRef, pending);
  assert.equal(fs.readFileSync(old.directory + '/journal.jsonl').equals(originalBytes), true);
  assert.equal(fs.existsSync(f.root + '/ledger/claims/' + planRef.sha256 + '.json'), true);
  assert.equal(JSON.parse(fs.readFileSync(old.directory + '/continuation-claim.json')).operationNonce, successor.operationNonce);
  assert.throws(() => store.start(nextRef, pending), /active_mismatch|EEXIST/);
  successor.finish({ status: 'rds_schema_failed_preserve_partial', closure: { physicalCloseObserved: true }, transportOpened: true }, false);
  assert.equal(fs.existsSync(f.root + '/ledger/active.json'), true);
  assert.throws(() => store.start(nextRef), /previous_attempt_requires_reconciliation/);
});
test('one matching prefix is omitted, explicitly reconciled rather than ACKed, and a mismatch poisons the bridge', async t => {
  const f = await fixture(t), S = require('sequelize'), generator = new S({ dialect: 'mysql', logging: false }); let sql;
  const stop = Error('TEST_ONLY_CAPTURE'); generator.query = async value => { sql = value; throw stop; };
  try { await require(f.source + '/migrations/' + R.SUPPORTED.migration).up(generator.getQueryInterface(), S); } catch (error) { assert.equal(error, stop); }
  const sent = [], events = [], raw = { query(options, values, cb) { if (typeof values === 'function') cb = values; const value = typeof options === 'string' ? options : options.sql;
    sent.push(value); queueMicrotask(() => cb(null, value === 'SHOW WARNINGS' ? [] : { affectedRows: 0, warningStatus: 0 })); return new EventEmitter(); } }; raw.execute = raw.query;
  const continuation = { pending: true, proof: await validate(f), resultRef: { path: '/TEST_ONLY/result.json', sha256: 'a'.repeat(64) } };
  const bridge = C.migrationInterface({ admin: { raw, identity: { engineVersion: '8.4.11' } }, aws: { assertFresh() {} }, journal: e => events.push(e), migrationName: R.SUPPORTED.migration, continuation });
  try { await bridge.queryInterface.sequelize.query(sql); assert.equal(continuation.pending, false); assert.deepEqual(sent, []);
    await bridge.queryInterface.addIndex('ClinicSuppliers', ['clinic_id','active','name'], { name: 'clinic_suppliers_scope' });
  } finally { await bridge.restore(); }
  assert.deepEqual(events.map(x => x.event), ['statement_reconciled','statement_request','statement_ack']);
  assert.equal(sent.filter(x => x === sql).length, 0);
  const other = C.migrationInterface({ admin: { raw }, aws: { assertFresh() {} }, journal() {}, migrationName: R.SUPPORTED.migration,
    continuation: { pending: true, proof: await validate(f) } });
  try { await assert.rejects(other.queryInterface.sequelize.query('SHOW TABLES'), /prefix_changed/);
    await assert.rejects(other.queryInterface.sequelize.query(sql), /prior_statement_failed/); }
  finally { await other.restore(); }
});
test('native proven warning policy is exact by message, count, SQL class, literal type and engine; other diagnostics stay private', () => {
  const row = { Level: 'Warning', Code: 1681, Message: W.MESSAGE }, good = { sql: 'CREATE TABLE `x` (`a` TINYINT(1)) ENGINE=InnoDB', kind: 'ddl', engineVersion: '8.4.11', rows: [row], warningStatus: 1 };
  assert.equal(W.accepted(good), true);
  for (const change of [{ engineVersion: '8.4.10' }, { kind: 'metadata' }, { warningStatus: 0 }, { rows: [{ ...row, Message: 'Other deprecation' }] },
    { rows: [{ ...row, Code: 3860 }] }, { rows: [{ ...row, Level: 'Note' }] }, { sql: 'CREATE TABLE `x` (`a` INT(1))' },
    { sql: "CREATE TABLE `x` (`a` VARCHAR(40) DEFAULT 'TINYINT(1)')" }, { sql: 'ALTER TABLE `x` CHANGE `a` `a` TINYINT(1)' },
    { sql: 'CREATE TABLE `x` (`a` TINYINT(1),`b` TINYINT(1))' }]) assert.equal(W.accepted({ ...good, ...change }), false, JSON.stringify(change));
  const diagnostics = W.diagnostics([{ Level: 'Warning', Code: 1265, Message: 'TEST_ONLY_SECRET_VALUE' }]);
  assert.equal(JSON.stringify(diagnostics).includes('TEST_ONLY_SECRET'), false); assert.equal(diagnostics[0].code, 1265); assert.match(diagnostics[0].messageSha256, /^[a-f0-9]{64}$/);
});
test('CLI exposes reconciliation as a read-only plan step and only publishes a strictly scoped result reference', () => {
  const CLI = require('../security-rds-schema-migrate');
  const options = CLI.parse(['reconcile-rds','--source',SOURCE,'--run','/TEST_ONLY/run','--out','/TEST_ONLY/plan.json']);
  assert.equal(options.action, 'reconcile'); assert.deepEqual(options.selected, []);
  assert.throws(() => CLI.parse(['reconcile-rds','--source',SOURCE,'--run','/TEST_ONLY/run','--migration',R.SUPPORTED.migration]), /arguments_invalid/);
  assert.throws(() => CLI.parse(['reconcile-rds','--source',SOURCE,'--run','/TEST_ONLY/run','--approve-plan','a'.repeat(64)]), /arguments_invalid/);
  const value = { path: '/var/lib/clinicaclick-rds-schema-release/runs/7924eeda-3342-42cc-9a7c-c2f5f69675d4/result.json', sha256: 'a'.repeat(64) };
  assert.deepEqual(C.safeResultRef({ ...value, password: 'TEST_ONLY_DO_NOT_INCLUDE' }), value);
  for (const change of [{ path: '/etc/secret' }, { path: value.path + '?secret=x' }, { sha256: 'invalid' }, { path: value.path.replace('/runs/', '/runs/../') }]) {
    assert.equal(C.safeResultRef({ ...value, ...change }), null);
  }
});

test('the exact DelegatedSessions CREATE preserves hashed diagnostics and proves UUID binary, date precision, unique handoff and all restrictive FKs', async t => {
  const f = await fixture(t, R.DELEGATED), proof = await validate(f);
  assert.equal(proof.migration, R.DELEGATED.migration); assert.equal(proof.originalWarning, 'retained_by_original_operator_hashed_diagnostics');
  assert.equal(proof.originalDiagnostics.warningStatus, 2); assert.deepEqual(proof.originalDiagnostics.diagnostics, f.journal[1].diagnostics);
  assert.equal(proof.originalDiagnostics.journalRowDigest, digest(f.journal[1])); assert.equal(proof.originalDiagnostics.journalIndex, 1);
  assert.equal(f.shape.columns.length, 20); assert.equal(f.shape.indexes.length, 5); assert.equal(f.shape.foreignKeys.length, 3);
  assert.deepEqual(f.shape.columns.filter(r => r.COLUMN_TYPE === 'char(36)').map(r => [r.COLUMN_NAME, r.COLLATION_NAME]), [['delegation_id','utf8mb4_bin'],['parent_session_id','utf8mb4_bin']]);
  assert.equal(f.shape.columns.find(r => r.COLUMN_NAME === 'expires_at').COLUMN_TYPE, 'datetime(3)');
  assert.equal(f.shape.indexes.find(r => r.INDEX_NAME === 'handoff_digest').NON_UNIQUE, 0);
  assert(f.shape.foreignKeys.every(r => r.UPDATE_RULE === 'RESTRICT' && r.DELETE_RULE === 'RESTRICT'));
});
test('DelegatedSessions requires the original run, source, SQL, identity and exactly retained two diagnostics; it never accepts warning classes generally', async t => {
  const f = await fixture(t, R.DELEGATED);
  const mutations = [x => { x.result.operationNonce = 'other'; }, x => { x.result.planRef.sha256 = '0'.repeat(64); },
    x => { x.plan.sourceRevision = '0'.repeat(40); }, x => { x.identity.engineVersion = '8.4.12'; },
    x => { x.journal[0].sqlSha256 = '0'.repeat(64); }, x => { x.journal[1].sqlSha256 = '0'.repeat(64); },
    x => { x.journal.splice(1,1); }, x => { x.journal.splice(1,0,clone(x.journal[1])); },
    x => { x.journal[1].warningReadFailed = true; }, x => { x.journal[1].warningStatus = 1; },
    x => { x.journal[1].diagnostics.pop(); }, x => { x.journal[1].diagnostics[0].level = 'Note'; },
    x => { x.journal[1].diagnostics[0].code = 1681; }, x => { x.journal[1].diagnostics[0].messageSha256 = '0'.repeat(64); },
    x => { x.journal[1].policy = 'any-warning'; }, x => { x.journal.unshift({ event: 'statement_ack' }); },
    x => { x.result.writesDispatched = 2; }, x => { x.result.closure.physicalStreamDestroyed = false; }];
  for (const change of mutations) { const x = { ...f, result: clone(f.result), identity: clone(f.identity), plan: clone(f.plan), journal: clone(f.journal) }; change(x); await assert.rejects(validate(x), /rds_schema_reconciliation_/); }
  fs.appendFileSync(f.source + '/migrations/' + R.DELEGATED.migration, '\n// TEST_ONLY changed source\n');
  await assert.rejects(validate(f), /source_changed/);
});
test('DelegatedSessions refuses missing/extra indexes, weakened UUID/date/unique/FK metadata, and any unrelated drift', async t => {
  const f = await fixture(t, R.DELEGATED);
  for (const change of [x => { x.observed.indexes.push({ ...x.shape.indexes[0], INDEX_NAME: 'idx_delegated_parent_state' }); },
    x => { x.observed.indexes.pop(); }, x => { x.observed.indexes.find(r => r.INDEX_NAME === 'handoff_digest').NON_UNIQUE = 1; },
    x => { x.observed.columns.find(r => r.COLUMN_NAME === 'delegation_id').COLLATION_NAME = 'utf8mb4_0900_ai_ci'; },
    x => { x.observed.columns.find(r => r.COLUMN_NAME === 'expires_at').COLUMN_TYPE = 'datetime'; },
    x => { x.observed.foreignKeys.at(-1).UPDATE_RULE = 'NO ACTION'; }, x => { x.observed.foreignKeys.at(-1).DELETE_RULE = 'CASCADE'; },
    x => { x.observed.foreignKeys.pop(); }, x => { x.observed.columns[0].COLUMN_DEFAULT = 'unexpected'; },
    x => { x.observed.triggers.push({ TABLE_NAME: 'DelegatedSessions', TRIGGER_NAME: 'unexpected' }); },
    x => { x.observed.migrations.push(R.DELEGATED.migration); }]) {
    const x = { ...f, observed: clone(f.observed) }; change(x); await assert.rejects(validate(x), /metadata_drift/);
  }
});
test('DelegatedSessions continuation dispatches only three zero-warning indexes and never replays or invents ACK for CREATE', async t => {
  const f = await fixture(t, R.DELEGATED), sent = [], events = [];
  const raw = { query(options, values, cb) { if (typeof values === 'function') cb = values; const sql = typeof options === 'string' ? options : options.sql;
    sent.push(sql); queueMicrotask(() => cb(null, sql === 'SHOW WARNINGS' ? [] : { affectedRows: 0, warningStatus: 0 })); return new EventEmitter(); } }; raw.execute = raw.query;
  const continuation = { pending: true, proof: await validate(f), resultRef: { path: '/TEST_ONLY/original-result.json', sha256: 'a'.repeat(64) } };
  const bridge = C.migrationInterface({ admin: { raw, identity: { engineVersion: '8.4.11' } }, aws: { assertFresh() {} }, journal: e => events.push(e), migrationName: R.DELEGATED.migration, continuation });
  try { await require(f.source + '/migrations/' + R.DELEGATED.migration).up(bridge.queryInterface, require('sequelize')); }
  finally { await bridge.restore(); }
  assert.equal(continuation.pending, false); assert(!sent.some(sql => /^CREATE TABLE/i.test(sql)));
  assert.equal(sent.filter(sql => sql !== 'SHOW WARNINGS').length, 3); assert(sent.filter(sql => sql !== 'SHOW WARNINGS').every(sql => /^ALTER TABLE `DelegatedSessions` ADD INDEX /i.test(sql)));
  assert.equal(events.filter(e => e.event === 'statement_reconciled').length, 1); assert.equal(events.filter(e => e.event === 'statement_ack').length, 3);
  assert(!events.some(e => e.event === 'statement_ack' && e.sqlSha256 === R.DELEGATED.sqlSha256));
  assert(events.filter(e => e.event === 'statement_ack').every(e => e.warnings === 0));
});

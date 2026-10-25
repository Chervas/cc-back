'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
// This process cannot open a real child, socket, provider or shared database.
const child = require('node:child_process');
for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
  child[name] = () => { throw Error('TEST_ONLY_real_children_forbidden'); };
}
require('node:net').Socket.prototype.connect = () => { throw Error('TEST_ONLY_real_sockets_forbidden'); };
require('node:tls').connect = () => { throw Error('TEST_ONLY_real_tls_forbidden'); };
const readFile = fs.readFileSync;
fs.readFileSync = function deniedSecretReads(file, ...args) {
  if (typeof file === 'string' && (/\/\.env(?:\.|$)/.test(file) || /\/proc\/.*\/environ$|\/\.aws\/|\/Goal\b/.test(file))) throw Error('TEST_ONLY_secret_reads_forbidden');
  return readFile.call(fs, file, ...args);
};
const { digest } = require('../../lib/securitySchemaContract');
const P = require('../../lib/rdsSchemaMigrationPolicy');
const E = require('../../lib/mysqlEnumExtension');
const C = require('../../lib/rdsSchemaMigration');
const T = require('../../lib/rdsSchemaMigrationTransport');
const CLI = require('../security-rds-schema-migrate');
const legacy = require('../security-schema-release');

const NAME = '20261024120000-create-schema-release-fixture.js';
const OLD = '20200101000000-unselected-historical-fixture.js';
test('actual legacy CLI publishes exports before the circular RDS delegation; old ordering reproduces refusal', async () => {
  const vm = require('node:vm'); const { createRequire } = require('node:module');
  const entry = path.resolve(__dirname, '../security-schema-release.js');
  const delegate = path.resolve(__dirname, '../security-rds-schema-migrate.js');
  const source = fs.readFileSync(entry, 'utf8'); const exportLine = 'module.exports = { run, parse, sourceInfo, applyPlan };\n';
  assert.equal(source.split(exportLine).length, 2);
  async function executeMain(entrySource) {
    const cache = new Map(); const out = [], err = []; let received, plans = 0;
    const main = { exports: {} }; cache.set(entry, main);
    const fakeProcess = { argv: ['TEST_ONLY_node', entry, 'plan-rds', '--source', path.resolve(__dirname, '../../..'), '--migration', NAME],
      stdout: { write: x => out.push(x) }, stderr: { write: x => err.push(x) }, exitCode: 0 };
    function evaluate(filename, text, module) {
      const local = id => {
        if (filename === delegate && id === '../lib/rdsSchemaMigration') return {
          safeCode: C.safeCode, createRunner({ sourceInfo }) {
            received = sourceInfo; assert.equal(typeof sourceInfo, 'function');
            return { plan: async () => { plans++; return { status: 'TEST_ONLY_PLAN', compatible: true }; } };
          } };
        const resolved = createRequire(filename).resolve(id);
        if (cache.has(resolved)) return cache.get(resolved).exports;
        if (resolved === delegate) {
          const next = { exports: {} }; cache.set(resolved, next);
          evaluate(resolved, fs.readFileSync(resolved, 'utf8'), next); return next.exports;
        }
        return createRequire(filename)(id);
      };
      local.main = main;
      vm.runInThisContext('(function(require,module,exports,__filename,__dirname,process){\n'
        + text.replace(/^#![^\n]*\n/, '') + '\n})', { filename })(local, module, module.exports, filename, path.dirname(filename), fakeProcess);
    }
    evaluate(entry, entrySource, main);
    await new Promise(resolve => setImmediate(resolve));
    return { code: fakeProcess.exitCode, out: out.join(''), err: err.join(''), received, plans, exports: main.exports };
  }
  const previous = await executeMain(source.replace(exportLine, '') + exportLine);
  assert.equal(previous.code, 1); assert.equal(previous.plans, 0); assert.equal(previous.received, undefined);
  const current = await executeMain(source);
  assert.equal(current.code, 0); assert.equal(current.err, ''); assert.equal(current.plans, 1);
  assert.equal(current.received, current.exports.sourceInfo); assert.equal(JSON.parse(current.out).status, 'TEST_ONLY_PLAN');
  for (const name of ['run', 'parse', 'sourceInfo', 'applyPlan']) assert.equal(typeof current.exports[name], 'function');
});
function fixture(t, up = "await q.createTable('SchemaReleaseFixture', { id: { type: S.INTEGER, primaryKey: true }, label: S.STRING(40) });") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rds-schema-pure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = root + '/source'; fs.mkdirSync(source); fs.mkdirSync(source + '/migrations'); fs.mkdirSync(source + '/src'); fs.mkdirSync(source + '/src/lib');
  fs.writeFileSync(source + '/migrations/' + NAME, "module.exports={async up(q,S){" + up + "},async down(){throw Error('not used')}};\n");
  fs.writeFileSync(source + '/migrations/' + OLD, "module.exports={async up(){throw Error('HISTORICAL_MUST_NOT_RUN')}};\n");
  const state = { tables: [{ TABLE_NAME: 'SequelizeMeta', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_unicode_ci' }],
    migrations: [], dispatch: [], events: [], closed: 0, ddlFailure: false, warnings: [] };
  const identity = { host: T.HOST, database: 'clinicaclick', port: 3306, serverUuid: '00000000-0000-4000-8000-000000000001',
    engineVersion: '8.4.11', physicalDbId: 'db-TEST_ONLY', secretVersionId: 'TEST_ONLY_VERSION', caSha256: T.CA_SHA, strictTls: true, hostnameVerified: true };
  const contract = { version: 1, tables: { SchemaReleaseFixture: { columns: [], indexes: [] } }, migrations: [] };
  const info = () => ({ revision: 'a'.repeat(40), contractDigest: digest(contract), contract,
    migrations: Object.fromEntries([NAME, OLD].map(name => [name, P.sha(fs.readFileSync(source + '/migrations/' + name))])) });
  function respond(sql, values = []) {
    state.dispatch.push(sql);
    if (sql === 'SHOW WARNINGS') return structuredClone(state.warnings);
    if (sql === E.metadataSql) return state.enumRow ? [structuredClone(state.enumRow)] : [];
    if (/FROM information_schema.SCHEMATA/.test(sql)) return [{ DEFAULT_CHARACTER_SET_NAME: 'utf8mb4', DEFAULT_COLLATION_NAME: 'utf8mb4_unicode_ci' }];
    if (/FROM information_schema.TABLES/.test(sql)) return structuredClone(state.tables).sort((a, b) => a.TABLE_NAME.localeCompare(b.TABLE_NAME));
    if (/information_schema\./.test(sql)) return [];
    if (/SELECT name FROM SequelizeMeta/.test(sql)) return state.migrations.slice().sort().map(name => ({ name }));
    if (/GET_LOCK/.test(sql)) return [{ acquired: 1 }];
    if (/^SET SESSION/.test(sql)) return { affectedRows: 0, warningStatus: 0 };
    if (/^INSERT INTO SequelizeMeta/.test(sql)) { state.migrations.push(values[0]); return { affectedRows: 1, warningStatus: 0 }; }
    if (/^CREATE TABLE SequelizeMeta/.test(sql)) { state.tables.push({ TABLE_NAME: 'SequelizeMeta', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_unicode_ci' }); return { affectedRows: 0, warningStatus: 0 }; }
    if (/^CREATE TABLE/.test(sql)) {
      if (state.ddlFailure) throw Error('DO_NOT_PERSIST_PASSWORD_OR_RAW_SQL');
      assert.match(sql, /`SchemaReleaseFixture`/); assert.match(sql, /`label` VARCHAR\(40\)/);
      state.tables.push({ TABLE_NAME: 'SchemaReleaseFixture', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_unicode_ci' });
      return { affectedRows: 0, warningStatus: 0 };
    }
    if (/^ALTER TABLE/.test(sql) && state.enumRow) {
      const parsed = E.statement(sql);
      state.enumRow.COLUMN_TYPE = 'enum(' + parsed.values.map(value => "'" + value.replace(/'/g, "''") + "'").join(',') + ')';
      if (state.enumPostTamper) state.enumRow.COLUMN_COMMENT = 'Unexpected metadata drift';
      return { affectedRows: 0, warningStatus: 0 };
    }
    throw Error('UNEXPECTED_FAKE_SQL:' + sql);
  }
  const raw = { config: {}, query(options, values, callback) {
    if (typeof values === 'function') { callback = values; values = []; }
    const sql = typeof options === 'string' ? options : options.sql;
    queueMicrotask(() => { try { callback(null, respond(sql, values)); } catch (error) { callback(error); } });
    return new EventEmitter();
  } };
  raw.execute = raw.query;
  const aws = { profile: 'TEST_ONLY', assertFresh() {}, inspect: async () => { state.events.push('aws_inspect'); return {}; },
    secret: async () => ({ password: 'TEST_ONLY_NOT_A_REAL_CREDENTIAL' }),
    backup: async ({ journal }) => {
      state.events.push('backup'); journal({ event: 'backup_request', snapshotId: 'TEST_ONLY' }); journal({ event: 'backup_create_ack', snapshotId: 'TEST_ONLY' });
      return { snapshotId: 'TEST_ONLY', physicalDbId: identity.physicalDbId, createdAt: new Date().toISOString(), status: 'available' };
    } };
  const connect = async () => {
    state.events.push('connect');
    return { raw, identity: structuredClone(identity), query: async (sql, values) => respond(sql, values),
      close: async () => { state.closed++; if (state.closeFailure) throw Error('rds_schema_physical_close_unproven'); return { physicalCloseObserved: true, physicalStreamDestroyed: true }; } };
  };
  const runner = C.createRunner({ sourceInfo: info, awsFactory: () => aws, connect,
    storeFactory: () => C.createStore(root + '/ledger', process.getuid()), operatorUid: () => 0, fileOwner: process.getuid() });
  return { root, source, state, identity, info, aws, raw, runner };
}

test('genuine CLI plan → approved apply → verify uses real Sequelize SQL and never unselected history', async t => {
  const f = fixture(t);
  const plan = await CLI.run(['plan', '--source', f.source, '--migration', NAME, '--out', f.root + '/plan/plan.json'], { runner: f.runner });
  assert.deepEqual(plan.toApply, [NAME]); assert.equal(plan.unselectedPendingCount, 1);
  assert.equal(f.state.dispatch.some(sql => /^CREATE|^INSERT/.test(sql)), false);
  const applied = await CLI.run(['apply', '--source', f.source, '--plan', plan.planRef.path, '--approve-plan', plan.planRef.sha256], { runner: f.runner });
  assert.equal(applied.compatible, true); assert.deepEqual(applied.completed, [NAME]);
  assert.deepEqual(applied.releaseGate.preflightArgs, ['--require-migration', NAME]);
  assert.deepEqual(f.state.migrations, [NAME]);
  assert.equal(f.state.events.indexOf('backup') < f.state.events.lastIndexOf('connect'), true);
  const verified = await CLI.run(['verify', '--source', f.source, '--run', path.dirname(applied.resultRef.path)], { runner: f.runner });
  assert.equal(verified.status, 'rds_schema_verified'); assert.equal(f.state.closed, 3);
  const journal = fs.readFileSync(path.dirname(applied.resultRef.path) + '/journal.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(journal.filter(row => row.event === 'statement_request').map(row => row.kind), ['ddl', 'sequelize_meta']);
  assert.deepEqual(journal.filter(row => row.event === 'statement_ack').map(row => row.kind), ['ddl', 'sequelize_meta']);
  assert.equal(journal.some(row => Object.hasOwn(row, 'sql') || Object.hasOwn(row, 'password')), false);
  await assert.rejects(f.runner.apply({ source: f.source, planFile: plan.planRef.path, approvePlan: plan.planRef.sha256 }), /plan_already_consumed/);
});

test('approval refusal, altered selected module, and stale schema never dispatch DDL', async t => {
  const f = fixture(t); const plan = await f.runner.plan({ source: f.source, selected: [NAME], out: f.root + '/plan/plan.json' });
  await assert.rejects(f.runner.apply({ source: f.source, planFile: plan.planRef.path, approvePlan: '0'.repeat(64) }), /explicit_plan_approval/);
  fs.appendFileSync(f.source + '/migrations/' + NAME, '\n// changed after review');
  await assert.rejects(f.runner.apply({ source: f.source, planFile: plan.planRef.path, approvePlan: plan.planRef.sha256 }), /plan_stale/);
  assert.equal(f.state.events.includes('backup'), false);
});

test('schema CAS is repeated after backup and refuses changed target before DDL', async t => {
  const f = fixture(t); const plan = await f.runner.plan({ source: f.source, selected: [NAME], out: f.root + '/plan/plan.json' });
  f.state.tables.push({ TABLE_NAME: 'UnexpectedConcurrentDdl' });
  await assert.rejects(f.runner.apply({ source: f.source, planFile: plan.planRef.path, approvePlan: plan.planRef.sha256 }), /plan_stale/);
  assert.equal(f.state.dispatch.some(sql => /^CREATE|^INSERT/.test(sql)), false);
});

test('unknown real driver outcome leaves durable blocking ledger and omits SequelizeMeta', async t => {
  const f = fixture(t); const plan = await f.runner.plan({ source: f.source, selected: [NAME], out: f.root + '/plan/plan.json' });
  f.state.ddlFailure = true;
  await assert.rejects(f.runner.apply({ source: f.source, planFile: plan.planRef.path, approvePlan: plan.planRef.sha256 }), /requires_reconciliation/);
  assert.deepEqual(f.state.migrations, []);
  assert.equal(fs.existsSync(f.root + '/ledger/active.json'), true);
  const active = JSON.parse(fs.readFileSync(f.root + '/ledger/active.json'));
  const body = fs.readFileSync(active.directory + '/result.json', 'utf8');
  assert.equal(body.includes('DO_NOT_PERSIST_PASSWORD'), false);
  assert.equal(body.includes('CREATE TABLE'), false);
  await assert.rejects(f.runner.apply({ source: f.source, planFile: plan.planRef.path, approvePlan: plan.planRef.sha256 }), /previous_attempt_requires_reconciliation/);
});

test('empty owned fixture bootstraps only SequelizeMeta after backup with its own request and ACK', async t => {
  const f = fixture(t); f.state.tables = [];
  const plan = await f.runner.plan({ source: f.source, selected: [NAME], out: f.root + '/plan/plan.json' });
  const applied = await f.runner.apply({ source: f.source, planFile: plan.planRef.path, approvePlan: plan.planRef.sha256 });
  const events = fs.readFileSync(path.dirname(applied.resultRef.path) + '/journal.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter(e => e.event === 'statement_request').map(e => e.kind), ['sequelize_meta_bootstrap', 'ddl', 'sequelize_meta']);
  assert.deepEqual(f.state.migrations, [NAME]);
});

test('DDL warning refuses ACK and migration recording; a prewrite close failure also blocks later applies', async t => {
  const f = fixture(t); const plan = await f.runner.plan({ source: f.source, selected: [NAME], out: f.root + '/plan/plan.json' });
  f.state.warnings = [{ Level: 'Warning', Code: 1, Message: 'TEST_ONLY_DO_NOT_PERSIST' }];
  await assert.rejects(f.runner.apply({ source: f.source, planFile: plan.planRef.path, approvePlan: plan.planRef.sha256 }), /warnings_require_reconciliation/);
  assert.deepEqual(f.state.migrations, []); assert.equal(fs.existsSync(f.root + '/ledger/active.json'), true);
  const other = fixture(t); const otherPlan = await other.runner.plan({ source: other.source, selected: [NAME], out: other.root + '/plan/plan.json' });
  other.state.tables.push({ TABLE_NAME: 'ConcurrentShape' }); other.state.closeFailure = true;
  await assert.rejects(other.runner.apply({ source: other.source, planFile: otherPlan.planRef.path, approvePlan: otherPlan.planRef.sha256 }), /plan_stale/);
  assert.equal(fs.existsSync(other.root + '/ledger/active.json'), true);
});

test('DML/DCL/cross-database/destructive SQL and nonmetadata SELECT are refused', () => {
  for (const sql of ['UPDATE Patients SET name=\'x\'', 'DELETE FROM Patients', 'DROP TABLE Patients', 'CREATE USER x',
    'ALTER TABLE Patients DROP COLUMN id', 'ALTER TABLE Patients MODIFY id BIGINT',
    'CREATE TABLE mysql.x (id INT)', 'SELECT * FROM Patients', 'SELECT * FROM information_schema.TABLES INTO OUTFILE \'x\'',
    'CREATE TABLE x (id INT); DROP DATABASE clinicaclick', 'SET FOREIGN_KEY_CHECKS=0']) assert.throws(() => P.statementKind(sql), /rds_schema_/);
  assert.equal(P.statementKind('ALTER TABLE `Patients` ADD CONSTRAINT `fk` FOREIGN KEY (`a`) REFERENCES `Parents` (`id`) ON DELETE CASCADE ON UPDATE CASCADE'), 'ddl');
});

test('driver execute bind path has the same scope guard and cannot bypass via prepared DML', async t => {
  const f = fixture(t); const admin = { raw: f.raw }; const events = [];
  const bridge = C.migrationInterface({ admin, aws: f.aws, journal: event => events.push(event), migrationName: NAME });
  await assert.rejects(bridge.queryInterface.sequelize.query('UPDATE Patients SET name=$name', { bind: { name: 'TEST_ONLY' } }), /rds_schema_sql_scope/);
  await bridge.restore(); assert.equal(f.state.dispatch.length, 0); assert.equal(events.length, 0);
});

test('ENUM bridge allows only append with identical properties, validates live metadata before dispatch and verifies after', async t => {
  const f = fixture(t), events = [];
  f.state.enumRow = { COLUMN_TYPE: "enum('old','legacy-2')", IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'old',
    COLUMN_COMMENT: 'Audit history', EXTRA: '', GENERATION_EXPRESSION: '', CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_bin' };
  const before = E.column(f.state.enumRow), target = { ...before, values: [...before.values, 'new'] };
  const bridge = C.migrationInterface({ admin: { raw: f.raw }, aws: f.aws, journal: event => events.push(event), migrationName: NAME });
  try { await bridge.queryInterface.sequelize.query(E.sql('SchemaReleaseFixture', 'event_type', target)); }
  finally { await bridge.restore(); }
  assert.deepEqual(E.column(f.state.enumRow).values, ['old', 'legacy-2', 'new']);
  assert.equal(f.state.dispatch.filter(sql => sql === E.metadataSql).length, 2);
  assert.deepEqual(events.map(event => event.event), ['statement_request', 'statement_ack']);
});

test('ENUM bridge refuses removed/reordered members, other types and changed default/nullability/comment/charset/collation before DDL', async t => {
  const row = { COLUMN_TYPE: "enum('old','legacy-2')", IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'old',
    COLUMN_COMMENT: 'Audit', EXTRA: '', GENERATION_EXPRESSION: '', CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_bin' };
  const base = E.column(row);
  for (const change of [{ values: ['old'] }, { values: ['legacy-2','old','new'] }, { values: ['old','legacy-2'] },
    { defaultValue: null }, { allowNull: true }, { comment: '' }, { charset: 'latin1' }, { collation: 'utf8mb4_unicode_ci' }]) {
    const f = fixture(t), events = []; f.state.enumRow = structuredClone(row);
    const bridge = C.migrationInterface({ admin: { raw: f.raw }, aws: f.aws, journal: event => events.push(event), migrationName: NAME });
    try { await assert.rejects(bridge.queryInterface.sequelize.query(E.sql('SchemaReleaseFixture', 'event_type', { ...base, values: [...base.values,'new'], ...change })), /enum_extension_invalid/); }
    finally { await bridge.restore(); }
    assert.equal(f.state.dispatch.some(sql => /^ALTER/.test(sql)), false); assert.equal(events.length, 0);
  }
  const f = fixture(t); f.state.enumRow = { ...row, COLUMN_TYPE: 'varchar(100)' };
  const bridge = C.migrationInterface({ admin: { raw: f.raw }, aws: f.aws, journal() {}, migrationName: NAME });
  try { await assert.rejects(bridge.queryInterface.sequelize.query(E.sql('SchemaReleaseFixture','event_type',{ ...base, values: [...base.values,'new'] })), /enum_extension_invalid/); }
  finally { await bridge.restore(); }
  assert.equal(f.state.dispatch.some(sql => /^ALTER/.test(sql)), false);
  for (const sql of ['ALTER TABLE `x` CHANGE `a` `b` ENUM(\'old\',\'new\') CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL',
    'ALTER TABLE `x` CHANGE `a` `a` VARCHAR(100) NOT NULL', 'ALTER TABLE `foreign`.`x` CHANGE `a` `a` ENUM(\'old\',\'new\') NOT NULL',
    E.sql('SequelizeMeta', 'name', { ...base, values: [...base.values,'new'] }),
    'ALTER TABLE `x` CHANGE `a` `a` ENUM(\'old\',\'new\') CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, ADD `other` INT']) {
    assert.throws(() => P.statementKind(sql), /rds_schema_/);
  }
});

test('ENUM postverification failure omits ACK and poisons subsequent statements after the dispatched DDL', async t => {
  const f = fixture(t), events = [];
  f.state.enumRow = { COLUMN_TYPE: "enum('old')", IS_NULLABLE: 'YES', COLUMN_DEFAULT: null,
    COLUMN_COMMENT: '', EXTRA: '', GENERATION_EXPRESSION: '', CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_bin' };
  f.state.enumPostTamper = true;
  const target = { ...E.column(f.state.enumRow), values: ['old','new'] };
  const bridge = C.migrationInterface({ admin: { raw: f.raw }, aws: f.aws, journal: event => events.push(event), migrationName: NAME });
  try {
    await assert.rejects(bridge.queryInterface.sequelize.query(E.sql('SchemaReleaseFixture','event_type',target)), /enum_extension_invalid/);
    await assert.rejects(bridge.queryInterface.sequelize.query('SHOW TABLES'), /prior_statement_failed/);
  } finally { await bridge.restore(); }
  assert.equal(f.state.dispatch.filter(sql => /^ALTER/.test(sql)).length, 1);
  assert.deepEqual(events.map(event => event.event), ['statement_request']);
});

test('restricted module loading refuses models/process imports and detects transitive drift', t => {
  const f = fixture(t); fs.writeFileSync(f.source + '/migrations/' + NAME, "require('../models');module.exports={up(){}};");
  assert.throws(() => P.migrationFiles(f.source, [NAME]), /module_scope/);
  fs.writeFileSync(f.source + '/migrations/' + NAME, "require('node:child_process');module.exports={up(){}};");
  assert.throws(() => P.migrationFiles(f.source, [NAME]), /import_forbidden/);
});

test('temporary AWS bootstrap refuses static credentials and never places secrets in argv/env', async () => {
  const calls = [];
  const aws = T.createAws({ execute: async (binary, args, options) => {
    calls.push({ binary, args, env: options.env });
    return { stdout: JSON.stringify({ Version: 1, AccessKeyId: 'TEST_ONLY', SecretAccessKey: 'DO_NOT_LOG', SessionToken: '', Expiration: new Date(Date.now() + 3600000).toISOString() }), stderr: '' };
  } });
  await assert.rejects(aws.inspect(), /temporary_aws_session_required/);
  assert.equal(JSON.stringify(calls).includes('DO_NOT_LOG'), false);
  assert.equal(Object.hasOwn(calls[0].env, 'AWS_SECRET_ACCESS_KEY'), false);
  assert.equal(Object.hasOwn(calls[0].env, 'DB_PASSWORD'), false);
});

test('QA transport cannot name primary DBI/schema and is not exposed as an arbitrary CLI target', () => {
  const qa = { mode: 'ISOLATED_EMPTY_QA', dbId: 'cc-schema-qa-20261024-1040',
    host: 'cc-schema-qa-20261024-1040.clkgw6ogy2cb.eu-west-3.rds.amazonaws.com', database: 'schema_release_fixture',
    physicalDbId: 'db-NLFVFQ4H2R7NYCW7HYYD3JQ3JY', engineVersion: '8.4.11' };
  assert.equal(T.scopeFor(qa).database, 'schema_release_fixture');
  assert.throws(() => T.scopeFor({ ...qa, physicalDbId: 'db-2YF2E5HFTNWAHYB45MS4QW7VUA' }), /qa_scope_invalid/);
  assert.throws(() => T.scopeFor({ ...qa, database: 'clinicaclick' }), /qa_scope_invalid/);
  assert.throws(() => CLI.parse(['plan', '--host', qa.host]), /arguments_invalid/);
});

test('closure requires actual close EVENT; destroy flag alone is insufficient', async () => {
  const stream = new EventEmitter(); stream.destroyed = false;
  const raw = { stream, config: { password: 'TEST_ONLY' }, destroy() { stream.destroyed = true; }, };
  stream.destroy = () => { stream.destroyed = true; queueMicrotask(() => stream.emit('close')); };
  assert.deepEqual(await T.closePhysical(raw), { physicalCloseObserved: true, physicalStreamDestroyed: true });
  assert.equal(raw.config.password, '');
});

test('failed handshake retains its owned raw socket and proves close before returning failure', async () => {
  const stream = new EventEmitter(); stream.destroyed = false;
  const failure = Error('TEST_ONLY_handshake_failed');
  const raw = { stream, config: {}, destroy() { stream.destroyed = true; } };
  stream.destroy = () => { stream.destroyed = true; queueMicrotask(() => stream.emit('close')); };
  raw.promise = () => ({ connection: raw, connect: async () => { throw failure; } });
  const secret = { username: 'TEST_ONLY', password: 'TEST_ONLY' };
  await assert.rejects(T.connectAdmin({ aws: { assertFresh() {} }, db: {}, secret,
    makeConnection: config => { raw.config = config; return raw; } }), error => {
    assert.equal(error, failure); assert.equal(error.transportOpened, true);
    assert.deepEqual(error.closure, { physicalCloseObserved: true, physicalStreamDestroyed: true }); return true;
  });
  assert.equal(raw.config.password, ''); assert.equal(secret.password, '');
});

test('native temporary session can refresh only under the same AWS account and role', async () => {
  let generation = 1; let changedRole = false;
  const aws = T.createAws({ execute: async (_binary, args) => {
    if (args.includes('export-credentials')) return { stdout: JSON.stringify({ AccessKeyId: 'TEST_ONLY_' + generation,
      SecretAccessKey: 'TEST_ONLY', SessionToken: 'TEST_ONLY_' + generation, Expiration: new Date(Date.now() + 3600000).toISOString() }) };
    if (args.includes('get-caller-identity')) return { stdout: JSON.stringify({ Account: '137819318729',
      Arn: 'arn:aws:sts::137819318729:assumed-role/' + (changedRole ? 'OTHER' : 'TEST_ONLY') + '/session-' + generation }) };
    throw Error('TEST_ONLY_unexpected_aws');
  } });
  await aws.ensureFresh(900000); generation++;
  await aws.ensureFresh(900000); generation++; changedRole = true;
  await assert.rejects(aws.ensureFresh(900000), /aws_session_changed/);
});

test('production AWS binding admits only the existing physical DBI even at the same endpoint', async () => {
  const db = { DBInstanceIdentifier: T.DB_ID, DBInstanceStatus: 'available', Engine: 'mysql', EngineVersion: '8.4.11',
    Endpoint: { Address: T.HOST, Port: 3306 }, DbiResourceId: T.PRIMARY_DBI, MultiAZ: true, BackupRetentionPeriod: 15,
    StorageEncrypted: true, PendingModifiedValues: {}, DBParameterGroups: [{ ParameterApplyStatus: 'in-sync' }],
    MasterUserSecret: { SecretStatus: 'active', SecretArn: 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:TEST_ONLY' } };
  const aws = T.createAws({ execute: async (_binary, args) => {
    if (args.includes('export-credentials')) return { stdout: JSON.stringify({ AccessKeyId: 'TEST_ONLY', SecretAccessKey: 'TEST_ONLY',
      SessionToken: 'TEST_ONLY', Expiration: new Date(Date.now() + 3600000).toISOString() }) };
    if (args.includes('get-caller-identity')) return { stdout: JSON.stringify({ Account: '137819318729', Arn: 'arn:aws:sts::137819318729:assumed-role/TEST_ONLY/session' }) };
    if (args.includes('describe-db-instances')) return { stdout: JSON.stringify({ DBInstances: [db] }) };
    throw Error('TEST_ONLY_unexpected_aws');
  } });
  assert.equal((await aws.inspect()).DbiResourceId, T.PRIMARY_DBI);
  db.DbiResourceId = 'db-TESTONLYREPLACEMENT';
  await assert.rejects(aws.inspect(), /rds_not_ready/);
});

test('snapshot wait accepts a 46-minute backup once and remains bounded at 90 minutes', async () => {
  for (const availableAfterMs of [46 * 60000, Infinity]) {
    let clock = Date.parse('2026-10-24T14:00:00Z');
    const started = clock; const requests = []; const journal = [];
    const db = { DBInstanceIdentifier: T.DB_ID, DBInstanceStatus: 'available', Engine: 'mysql', EngineVersion: '8.4.11',
      Endpoint: { Address: T.HOST, Port: 3306 }, DbiResourceId: T.PRIMARY_DBI, MultiAZ: true, BackupRetentionPeriod: 15,
      StorageEncrypted: true, PendingModifiedValues: {}, DBParameterGroups: [{ ParameterApplyStatus: 'in-sync' }],
      MasterUserSecret: { SecretStatus: 'active', SecretArn: 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:TEST_ONLY' } };
    const snapshotId = 'cc-schema-' + 'a'.repeat(32);
    const aws = T.createAws({ now: () => clock, pause: async ms => { clock += ms; }, execute: async (_binary, args) => {
      requests.push(args);
      if (args.includes('export-credentials')) return { stdout: JSON.stringify({ AccessKeyId: 'TEST_ONLY', SecretAccessKey: 'TEST_ONLY',
        SessionToken: 'TEST_ONLY', Expiration: new Date(clock + 3600000).toISOString() }) };
      if (args.includes('get-caller-identity')) return { stdout: JSON.stringify({ Account: '137819318729', Arn: 'arn:aws:sts::137819318729:assumed-role/TEST_ONLY/session' }) };
      if (args.includes('create-db-snapshot')) return { stdout: JSON.stringify({ DBSnapshot: { DBSnapshotIdentifier: snapshotId, DBInstanceIdentifier: T.DB_ID } }) };
      if (args.includes('describe-db-snapshots')) return { stdout: JSON.stringify({ DBSnapshots: [{ DBSnapshotIdentifier: snapshotId,
        DBInstanceIdentifier: T.DB_ID, DbiResourceId: T.PRIMARY_DBI, Encrypted: true, Engine: 'mysql', EngineVersion: '8.4.11',
        SnapshotCreateTime: new Date(started).toISOString(), Status: clock - started >= availableAfterMs ? 'available' : 'creating' }] }) };
      if (args.includes('describe-db-instances')) return { stdout: JSON.stringify({ DBInstances: [db] }) };
      throw Error('TEST_ONLY_unexpected_aws');
    } });
    const result = aws.backup({ operationNonce: 'a'.repeat(32), journal: event => journal.push(event) });
    if (Number.isFinite(availableAfterMs)) {
      assert.equal((await result).status, 'available');
      assert.equal(clock - started, availableAfterMs);
      assert.equal(journal.filter(x => x.event === 'backup_available').length, 1);
    } else {
      await assert.rejects(result, /backup_timeout/);
      assert.equal(clock - started, 90 * 60000);
      assert.equal(journal.some(x => x.event === 'backup_available'), false);
    }
    assert.equal(requests.filter(args => args.includes('create-db-snapshot')).length, 1);
    assert.equal(requests.some(args => args.includes('get-secret-value')), false);
  }
});

test('owned session prepares exact strict modes from weak QA defaults; wrong readback or warnings refuse', async () => {
  for (const outcome of ['accepted', 'wrong_readback', 'mode_warning']) {
    const calls = []; let modes = 'IGNORE_SPACE,NO_ENGINE_SUBSTITUTION'; let last;
    const stream = new EventEmitter(); stream.destroyed = false;
    const raw = { stream, threadId: 46, destroy() { stream.destroyed = true; } };
    stream.destroy = () => { stream.destroyed = true; queueMicrotask(() => stream.emit('close')); };
    raw.promise = () => ({ connection: raw, connect: async () => {}, query: async options => {
      calls.push(options.sql);
      if (options.sql === 'SHOW WARNINGS') return [outcome === 'mode_warning' && last === 'SET SESSION sql_mode=?' ? [{ Code: 1 }] : []];
      last = options.sql;
      if (options.sql === 'SET SESSION sql_mode=?') {
        assert.deepEqual(options.values, [T.SQL_MODES.join(',')]);
        if (outcome !== 'wrong_readback') modes = options.values[0];
        return [{ affectedRows: 0 }];
      }
      if (options.sql === T.IDENTITY_SQL) return [[{ uuid: '8f74b18c-cf99-11f1-bd78-0afff7054403', version: '8.4.11',
        port: 3306, db: 'clinicaclick', account: 'cc_qa_admin@%', sid: 46, fk: 1, autocommit: 1, modes, charset: 'utf8mb4' }]];
      if (options.sql === T.TLS_SQL) return [[{ Variable_name: 'Ssl_version', Value: 'TLSv1.3' }, { Variable_name: 'Ssl_cipher', Value: 'TEST_ONLY' }]];
      throw Error('TEST_ONLY_unexpected_query');
    } });
    const open = T.connectAdmin({ aws: { assertFresh() {} }, db: { EngineVersion: '8.4.11', DbiResourceId: T.PRIMARY_DBI },
      secret: { username: 'cc_qa_admin', password: 'TEST_ONLY', versionId: 'TEST_ONLY' },
      makeConnection: config => { raw.config = config; return raw; } });
    if (outcome === 'accepted') { const admin = await open; assert.equal(admin.identity.serverUuid, '8f74b18c-cf99-11f1-bd78-0afff7054403'); await admin.close(); }
    else await assert.rejects(open, outcome === 'wrong_readback' ? /sql_identity/ : /warnings/);
    assert.equal(calls.some(sql => /GLOBAL/i.test(sql)), false); assert.equal(stream.destroyed, true);
  }
});

test('interactive release requires exact generated plan approval; legacy DEV/RDS guards remain', async t => {
  const f = fixture(t); const args = ['release-rds', '--source', f.source, '--migration', NAME, '--out', f.root + '/plan/plan.json'];
  await assert.rejects(CLI.run(args, { runner: f.runner, confirm: async () => 'no' }), /explicit_plan_approval/);
  assert.equal(f.state.events.includes('backup'), false);
  assert.throws(() => legacy.parse(['apply-dev', '--runtime', 'staging', '--plan', '/tmp/p', '--out', '/tmp/o']));
  assert.throws(() => legacy.parse(['check', '--runtime', 'dev', '--binding', '/tmp/b', '--binding-sha', 'a'.repeat(64), '--out', '/tmp/o']));
  assert.deepEqual(legacy.parse(['check', '--out', '/tmp/o', '--require-migration', NAME]).requiredMigrations, [NAME]);
});

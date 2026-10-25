'use strict';
// Explicit integration entrypoint. Only an owned /tmp Unix socket is accepted;
// no environment, runtime credentials, TCP, AWS or application models are read.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const mysql = require('mysql2'), S = require('sequelize');
const C = require('../../lib/rdsSchemaMigration'), P = require('../../lib/rdsSchemaMigrationPolicy'), R = require('../../lib/rdsSchemaFirstCreateReconciliation');
const W = require('../../lib/rdsSchemaWarningPolicy'), T = require('../../lib/rdsSchemaMigrationTransport'), CLI = require('../security-rds-schema-migrate');
const { digest } = require('../../lib/securitySchemaContract');
const SOURCE = path.resolve(__dirname, '../../..'), BASE = require('./fixtures/rds_release_20261025_metadata.json');
const NAMES = ['20261024190000-create-clinic-supplies.js','20261024230000-clinical-workspace-structured-data.js',
  '20261025090000-clinical-episode-stock-consumptions.js','20261025090500-clinical-episode-service-context.js',
  '20261025100000-clinical-gallery-pairs-classification.js','20261025110000-economic-concept-adjustments-fiscal-coverage.js',
  '20261025160000-economic-runtime-enum-values.js','20261025170000-clinical-treatment-template-defaults.js'];
const quote = value => '`' + value.replace(/`/g, '``') + '`';
async function run(socketPath) {
  assert.match(socketPath || '', /^\/tmp\/cc-rds-recovery-mysql[^/]*\/mysql\.sock$/);
  assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rds-native-reconciliation-')), owner = process.getuid();
  const database = 'cc_owned_release_' + crypto.randomBytes(6).toString('hex');
  const setup = await mysql.createConnection({ socketPath, user: 'root', multipleStatements: false }).promise();
  const dispatched = [], opened = []; let phase = 'original', firstNative, output, backupCount = 0;
  try {
    const [[version]] = await setup.query('SELECT VERSION() version'); assert.equal(version.version, '8.4.11');
    await setup.query('CREATE DATABASE ' + quote(database) + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    await setup.query('USE ' + quote(database));
    for (const table of BASE.tables) {
      const columns = BASE.columns.filter(row => row.TABLE_NAME === table.TABLE_NAME).map(row => {
        const textual = row.CHARACTER_SET_NAME ? ' CHARACTER SET ' + row.CHARACTER_SET_NAME + ' COLLATE ' + row.COLLATION_NAME : '';
        return quote(row.COLUMN_NAME) + ' ' + row.COLUMN_TYPE + textual + (row.IS_NULLABLE === 'NO' ? ' NOT NULL' : ' NULL')
          + (row.COLUMN_DEFAULT === null ? row.IS_NULLABLE === 'YES' ? ' DEFAULT NULL' : '' : ' DEFAULT ' + setup.escape(row.COLUMN_DEFAULT))
          + (row.EXTRA === 'auto_increment' ? ' AUTO_INCREMENT' : '');
      });
      const pk = BASE.indexes.filter(row => row.TABLE_NAME === table.TABLE_NAME && row.INDEX_NAME === 'PRIMARY').sort((a,b) => a.SEQ_IN_INDEX-b.SEQ_IN_INDEX);
      if (pk.length) columns.push('PRIMARY KEY (' + pk.map(row => quote(row.COLUMN_NAME)).join(',') + ')');
      await setup.query('CREATE TABLE ' + quote(table.TABLE_NAME) + ' (' + columns.join(',') + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=' + table.TABLE_COLLATION);
    }
    await setup.query('CREATE TABLE SequelizeMeta (name VARCHAR(255) NOT NULL PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
    const identity = { host: 'TEST_ONLY_SOCKET', database, physicalDbId: 'db-TEST_ONLY_OWNED', engineVersion: version.version,
      serverUuid: 'TEST_ONLY_OWNED_UUID', strictTls: false, hostnameVerified: false };
    const contract = { version: 1, tables: {}, migrations: [] }, info = () => ({ revision: (phase === 'original' ? 'a' : 'b').repeat(40), contract,
      contractDigest: digest(contract), migrations: Object.fromEntries(fs.readdirSync(SOURCE + '/migrations').filter(name => P.NAME.test(name)).map(name => [name, P.sha(fs.readFileSync(SOURCE + '/migrations/' + name))])) });
    const aws = { inspect: async () => ({}), secret: async () => ({ password: 'TEST_ONLY_UNUSED' }), assertFresh() {},
      backup: async ({ journal }) => { backupCount++; journal({ event: 'backup_request', snapshotId: 'TEST_ONLY_OWNED' }); journal({ event: 'backup_create_ack', snapshotId: 'TEST_ONLY_OWNED' });
        return { status: 'available', physicalDbId: identity.physicalDbId, createdAt: new Date().toISOString(), snapshotId: 'TEST_ONLY_OWNED' }; } };
    const connect = async () => {
      const raw = mysql.createConnection({ socketPath, user: 'root', database, multipleStatements: false });
      const native = raw.query; raw.query = function (...args) { const value = typeof args[0] === 'string' ? args[0] : args[0].sql;
        if (/^(?:CREATE|ALTER|INSERT INTO SequelizeMeta)/i.test(value)) dispatched.push(value); return native.apply(raw, args); };
      const connection = raw.promise(); await connection.connect(); await connection.query('SET SESSION sql_mode=?', [T.SQL_MODES.join(',')]);
      const admin = { raw, connection, identity: { ...identity }, query: async (sql, values = []) => {
        const [rows] = await connection.query(sql, values), [warnings] = await connection.query('SHOW WARNINGS');
        assert.deepEqual(warnings, [], 'metadata query must be warning free'); return rows;
      }, close: () => T.closePhysical(connection) }; opened.push(admin); return admin;
    };
    const store = C.createStore(root + '/ledger', owner), runner = C.createRunner({ sourceInfo: info, awsFactory: () => aws, connect,
      storeFactory: () => store, operatorUid: () => 0, fileOwner: owner });
    const original = await runner.plan({ source: SOURCE, selected: NAMES, profile: 'TEST_ONLY', out: root + '/plan/original.json' });
    const originalBody = C.readPrivate(original.planRef.path, owner).value;
    // Reproduce the legacy bridge's exact first dispatch and its lost warning;
    // the new code must not invent an ACK for this historical attempt.
    const old = store.start(original.planRef), admin = await connect(), seq = new S({ dialect: 'mysql', logging: false }), stop = Error('TEST_ONLY_FIRST_CREATE');
    const originalBackup = await aws.backup({ journal: old.journal });
    seq.query = async sql => {
      assert.equal(P.sha(sql), R.SUPPORTED.sqlSha256); old.journal({ event: 'statement_request', migration: NAMES[0], kind: 'ddl', sqlSha256: P.sha(sql) });
      const [result] = await admin.connection.query(sql), [warnings] = await admin.connection.query('SHOW WARNINGS');
      firstNative = { result, warnings }; assert.equal(result.warningStatus, 1); assert.deepEqual(warnings, [{ Level: 'Warning', Code: 1681, Message: W.MESSAGE }]); throw stop;
    };
    try { await require(SOURCE + '/migrations/' + NAMES[0]).up(seq.getQueryInterface(), S); } catch (error) { assert.equal(error, stop); }
    const closure = await admin.close();
    old.finish({ status: 'rds_schema_failed_preserve_partial', reason: 'rds_schema_statement_warnings_require_reconciliation', planRef: original.planRef,
      automaticReplayAllowed: false, transportOpened: true, backup: originalBackup, closure }, false);
    const preserved = Object.fromEntries(['journal.jsonl','result.json'].map(name => [name, fs.readFileSync(old.directory + '/' + name)]));
    phase = 'continuation'; const beforeReadOnly = dispatched.length;
    const continued = await CLI.run(['reconcile-rds','--source',SOURCE,'--run',old.directory,'--out',root + '/plan/continuation.json'], { runner });
    assert.equal(dispatched.length, beforeReadOnly, 'reconcile must not dispatch DDL');
    assert.equal(continued.originalSourceRevision, 'a'.repeat(40)); assert.equal(continued.sourceRevision, 'b'.repeat(40));
    assert.equal(continued.continuation.proof.originalWarning, 'not_retained_by_original_operator_unknown');
    const tampered = C.readPrivate(continued.planRef.path, owner).value; tampered.continuation.proof.sqlSha256 = '0'.repeat(64);
    const badRef = C.writePrivate(root + '/plan/tampered.json', tampered), beforeRefusal = dispatched.length;
    await assert.rejects(runner.apply({ source: SOURCE, planFile: badRef.path, approvePlan: badRef.sha256 }), /reconciliation_plan_binding/);
    assert.equal(dispatched.length, beforeRefusal); assert.equal(backupCount, 1);
    // Compatibility alone is insufficient: even the intended next index is
    // outside the known prefix and must block a new reconciliation plan.
    await setup.query('CREATE INDEX clinic_suppliers_scope ON ClinicSuppliers(clinic_id,active,name)');
    await assert.rejects(runner.reconcile({ source: SOURCE, runDirectory: old.directory, out: root + '/plan/drift.json' }), /metadata_drift/);
    // Adding the covering index may replace its implicit FK index in MySQL.
    const [implicit] = await setup.query("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ClinicSuppliers' AND INDEX_NAME='clinic_id'");
    if (!implicit.length) await setup.query('CREATE INDEX clinic_id ON ClinicSuppliers(clinic_id)');
    await setup.query('DROP INDEX clinic_suppliers_scope ON ClinicSuppliers');
    const settled = await Promise.allSettled([1,2].map(() => CLI.run(['apply-rds','--source',SOURCE,'--plan',continued.planRef.path,'--approve-plan',continued.planRef.sha256], { runner })));
    assert.equal(settled.filter(row => row.status === 'fulfilled').length, 1); assert.equal(settled.filter(row => row.status === 'rejected').length, 1);
    const applied = settled.find(row => row.status === 'fulfilled').value, result = C.readPrivate(applied.resultRef.path, owner).value;
    assert.deepEqual(result.completed, NAMES); assert.equal(result.reconciledStatements, 1);
    assert.equal(backupCount, 2, 'continuation must request its own fresh backup');
    assert.equal(result.after.tables.length - originalBody.before.tables.length, 21);
    assert.equal(result.after.columns.length - originalBody.before.columns.length, 258);
    assert.equal(result.after.foreignKeys.length - originalBody.before.foreignKeys.length, 55);
    assert(result.after.foreignKeys.every(row => row.DELETE_RULE === 'RESTRICT'));
    assert.deepEqual(result.after.migrations, NAMES.slice().sort());
    const journal = fs.readFileSync(path.dirname(applied.resultRef.path) + '/journal.jsonl','utf8').trim().split('\n').map(JSON.parse);
    assert.equal(journal.filter(row => row.event === 'statement_request').length, 67);
    assert.equal(journal.filter(row => row.event === 'statement_ack').length, 67);
    assert.equal(journal.filter(row => row.event === 'statement_reconciled').length, 1);
    assert.equal(dispatched.filter(sql => P.sha(sql) === R.SUPPORTED.sqlSha256).length, 1, 'the first CREATE must never be sent twice');
    const typedWarnings = journal.filter(row => row.event === 'statement_diagnostics'); assert(typedWarnings.length > 0);
    assert(typedWarnings.every(row => row.diagnostics.every(d => d.code === 1681 && d.message === W.MESSAGE)));
    for (const [name, bytes] of Object.entries(preserved)) assert.equal(fs.readFileSync(old.directory + '/' + name).equals(bytes), true);
    assert.equal(fs.existsSync(root + '/ledger/claims/' + original.planRef.sha256 + '.json'), true);
    assert.equal(fs.existsSync(old.directory + '/continuation-claim.json'), true);
    assert.equal(fs.existsSync(root + '/ledger/active.json'), false);
    const verified = await CLI.run(['verify-rds','--source',SOURCE,'--run',path.dirname(applied.resultRef.path)], { runner }); assert.equal(verified.compatible, true);
    await assert.rejects(runner.apply({ source: SOURCE, planFile: continued.planRef.path, approvePlan: continued.planRef.sha256 }));
    output = { success: true, engineVersion: version.version, originalFirstWarning: firstNative, selectedMigrations: NAMES,
      counts: { newTables: 21, addedColumns: 258, existingAddedColumns: 5, enumExtensions: 4, foreignKeys: 55, requests: 67, acks: 67, reconciled: 1, acknowledgedDeprecationStatements: typedWarnings.length },
      checks: ['exact-native-warning','read-only-reconcile','full-metadata-drift-refused','original-source-pins-preserved','concurrent-apply-one-winner','one-create-only',
        'all-eight-native-migrations','independent-enum-extensions','immutable-old-journal-result-claim','migration-meta-only-after-completion','verify-and-no-repeat'],
      rows: 'No business rows inserted or selected; metadata and owned SequelizeMeta only', artifacts: root };
    fs.writeFileSync(root + '/integration-result.json', JSON.stringify(output,null,2)+'\n', { mode: 0o600, flag: 'wx' });
  } finally {
    for (const admin of opened) { if (!admin.raw.stream?.destroyed) try { await admin.close(); } catch {} }
    try { await setup.query('DROP DATABASE ' + quote(database)); } finally { await setup.end(); }
  }
  return output;
}
module.exports = { run };
if (require.main === module) run(process.argv[2]).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.stack); process.exitCode = 1; });

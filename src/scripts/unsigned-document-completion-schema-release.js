#!/usr/bin/env node
'use strict';

// Two additive enum values only; never bootstrap app/models/jobs/providers.
// DDL commits implicitly. Durable backup precedes DDL; a partial expansion is
// safe to keep and re-plan, never automatically roll back reception receipts.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { databaseOptions, connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { parseArgs, readBytes, writePrivateJson, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const { newJournal } = require('./program-commercial-schema-release');
const NAME = '20261017180000-add-unsigned-document-completion.js';
const VERSION = 'unsigned-document-completion-schema-release/v1';
const TYPES = Object.freeze({
  PatientConsentDocuments: "enum('pending','sent','viewed','signed','rejected','revoked','expired','cancelled','superseded','voided')",
  ConsentSignaturePackages: "enum('draft','pending','sent','viewed','signed','expired','cancelled')",
});
const afterType = type => type.slice(0, -1) + ",'completed')";
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = code => { throw Error('UNSIGNED_DOCUMENT_SCHEMA_' + code); };
function source() {
  const root = path.resolve(__dirname, '../..'), git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (!['/home/ubuntu/wt/back-dev', '/home/ubuntu/wt/back-staging'].includes(root)
    || !['dev', 'staging'].includes(git(['branch', '--show-current'])) || git(['status', '--porcelain'])) fail('CLEAN_COMMITTED_SOURCE_REQUIRED');
  const commit = git(['rev-parse', 'HEAD']);
  const pins = {};
  for (const file of ['migrations/' + NAME, 'src/scripts/unsigned-document-completion-schema-release.js']) {
    const local = readBytes(path.join(root, file)), committed = execFileSync('git', ['show', `${commit}:${file}`], { cwd: root });
    if (!local.equals(committed)) fail('COMMITTED_SOURCE_REQUIRED');
    pins[file] = crypto.createHash('sha256').update(local).digest('hex');
  }
  return { commit, pins };
}
function privateInput(filename) {
  const root = fs.realpathSync(PRIVATE_ROOT), actual = fs.realpathSync(filename || '');
  const stat = fs.lstatSync(filename);
  if (actual !== filename || !actual.startsWith(root + path.sep) || !stat.isFile() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.mode & 0o077) fail('PRIVATE_PLAN_REQUIRED');
  return JSON.parse(readBytes(filename));
}
async function capture(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() AS database_name,CURRENT_USER() AS database_user,@@hostname AS server_name');
  const [columns] = await connection.query("SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,ORDINAL_POSITION,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('PatientConsentDocuments','ConsentSignaturePackages') ORDER BY TABLE_NAME,ORDINAL_POSITION");
  const ddl = {}, status_counts = {};
  for (const table of Object.keys(TYPES)) {
    const column = columns.find(row => row.TABLE_NAME === table && row.COLUMN_NAME === 'status');
    if (!column || ![TYPES[table], afterType(TYPES[table])].includes(column.COLUMN_TYPE)
      || column.IS_NULLABLE !== 'NO' || column.COLUMN_DEFAULT !== 'pending' || column.EXTRA !== '' || column.GENERATION_EXPRESSION
      || !/^[a-zA-Z0-9_]+$/.test(column.CHARACTER_SET_NAME || '') || !/^[a-zA-Z0-9_]+$/.test(column.COLLATION_NAME || '')) fail('REVIEWED_ENUM_SCHEMA_REQUIRED');
    const [create] = await connection.query('SHOW CREATE TABLE `' + table + '`'); ddl[table] = create[0]['Create Table'];
    const [counts] = await connection.query('SELECT status,COUNT(*) AS count FROM `' + table + '` GROUP BY status ORDER BY status');
    status_counts[table] = counts.map(row => ({ status: row.status, count: Number(row.count) }));
  }
  const [metadata] = await connection.query('SELECT name FROM SequelizeMeta WHERE name=?', [NAME]);
  return { identity_sha256: hash(identity), database_name: identity.database_name, columns, ddl, status_counts,
    registered: metadata.length === 1 };
}
function schemaFingerprint(snapshot) { return hash({ identity_sha256: snapshot.identity_sha256, columns: snapshot.columns, registered: snapshot.registered }); }
function verifyExpansion(before, after) {
  if (before.identity_sha256 !== after.identity_sha256) fail('DATABASE_IDENTITY_CHANGED');
  const expected = before.columns.map(column => column.COLUMN_NAME === 'status'
    ? { ...column, COLUMN_TYPE: afterType(TYPES[column.TABLE_NAME]) } : column);
  if (hash(expected) !== hash(after.columns)) fail('OTHER_COLUMNS_CHANGED_OR_EXPANSION_MISSING');
}
async function execute({ connection, target, plan, approvedHash, backupPath, journal, saveBackup = writePrivateJson, info, now = Date.now() }) {
  if (plan?.schema_version !== VERSION || plan.target !== target || plan.migration !== NAME || hash(plan) !== approvedHash
    || hash(plan.source) !== hash(info) || !Number.isFinite(Date.parse(plan.generated_at))
    || Date.parse(plan.generated_at) > now || now - Date.parse(plan.generated_at) > 7200000) fail('EXACT_FRESH_PLAN_REQUIRED');
  const [[lock]] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [VERSION]);
  if (Number(lock.acquired) !== 1) fail('OPERATOR_BUSY');
  try {
    const before = await capture(connection);
    if (schemaFingerprint(before) !== schemaFingerprint(plan.before)) fail('SCHEMA_DRIFT_REPLAN_REQUIRED');
    saveBackup(backupPath, { schema_version: VERSION + ':backup', migration: NAME, plan_sha256: hash(plan), source: info, before,
      restoration: 'No automatic rollback. Preserve appended enum and all real completed receipts; manual review only.' });
    await journal.append({ phase: 'before_ddl', before_sha256: hash(before), business_dml: false });
    for (const table of Object.keys(TYPES)) {
      const column = before.columns.find(row => row.TABLE_NAME === table && row.COLUMN_NAME === 'status');
      if (column.COLUMN_TYPE === afterType(TYPES[table])) continue;
      const ddl = 'ALTER TABLE `' + table + '` MODIFY COLUMN `status` ' + afterType(TYPES[table])
        + ' CHARACTER SET `' + column.CHARACTER_SET_NAME + '` COLLATE `' + column.COLLATION_NAME
        + "` NOT NULL DEFAULT 'pending', ALGORITHM=INPLACE, LOCK=NONE";
      await journal.append({ phase: 'ddl_intent', table, ddl });
      await connection.query(ddl);
      await journal.append({ phase: 'ddl_complete', table });
    }
    const expanded = await capture(connection); verifyExpansion(before, expanded);
    if (!expanded.registered) await connection.query('INSERT INTO SequelizeMeta (name) VALUES (?)', [NAME]);
    const after = await capture(connection); verifyExpansion(before, after);
    if (!after.registered) fail('MIGRATION_RECEIPT_MISSING');
    const receipt = { schema_version: VERSION + ':receipt', target, migration: NAME, source: info, plan_sha256: hash(plan),
      status: 'applied_verified', before, after, business_dml: false, clinic_configuration_changed: false,
      historical_status_labels_preserved: true, templates_changed: false, providers_called: false,
      concurrent_status_changes: hash(before.status_counts) !== hash(after.status_counts) };
    await journal.append({ phase: 'verified', receipt_sha256: hash(receipt), registered: true });
    return receipt;
  } finally { await connection.query('SELECT RELEASE_LOCK(?)', [VERSION]); }
}
async function main(args) {
  const options = parseArgs(args, ['--mode', '--target', '--output', '--plan', '--approved-plan-sha256', '--backup', '--journal']);
  const target = options['--target'], mode = options['--mode'];
  if (!['plan', 'apply', 'verify'].includes(mode) || !['dev', 'crm'].includes(target)) fail('EXPLICIT_MODE_TARGET_REQUIRED');
  const info = source(), configuration = databaseOptions(target), connection = await connectOperatorDatabase(target);
  let journal;
  try {
    await connection.query('SET SESSION lock_wait_timeout=10');
    if (mode === 'plan') {
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      let before; try { before = await capture(connection); } finally { await connection.rollback(); }
      if (before.database_name !== configuration.database) fail('TARGET_DATABASE_CHANGED');
      const plan = { schema_version: VERSION, target, migration: NAME, source: info, generated_at: new Date().toISOString(), before };
      writePrivateJson(options['--output'], plan);
      return { status: 'planned', target, plan_sha256: hash(plan), business_dml: false };
    }
    const plan = privateInput(options['--plan']);
    if (plan.target !== target || plan.before.database_name !== configuration.database) fail('TARGET_DATABASE_CHANGED');
    if (plan.schema_version !== VERSION || plan.migration !== NAME || hash(plan.source) !== hash(info)) fail('EXACT_SOURCE_PLAN_REQUIRED');
    if (mode === 'verify') {
      const after = await capture(connection); verifyExpansion(plan.before, after);
      if (!after.registered) fail('MIGRATION_RECEIPT_MISSING');
      writePrivateJson(options['--output'], { schema_version: VERSION + ':verification', source: info, target, migration: NAME, after, business_dml: false });
      return { status: 'verified', target, business_dml: false };
    }
    journal = newJournal(options['--journal'], options['--approved-plan-sha256']);
    const receipt = await execute({ connection, target, plan, approvedHash: options['--approved-plan-sha256'],
      backupPath: options['--backup'], journal, info });
    writePrivateJson(options['--output'], receipt);
    return { status: receipt.status, target, migration: NAME, business_dml: false };
  } finally { journal?.close(); await connection.end(); }
}
if (require.main === module) main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch(error => { process.stderr.write(String(error.code || error.message) + '\n'); process.exitCode = 1; });
module.exports = { NAME, VERSION, TYPES, afterType, hash, capture, schemaFingerprint, verifyExpansion, execute };

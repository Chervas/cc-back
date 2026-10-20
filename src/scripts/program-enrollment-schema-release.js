#!/usr/bin/env node
'use strict';

// Explicit, bounded schema operation. No application, models, environment copy,
// backfill or communications. MySQL DDL is not transactionally rollbackable.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, writePrivateJson, syncDirectory } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { privateJson } = require('./cliniccloud-import-appointments-apply');
const { newJournal } = require('./program-commercial-schema-release');
const NAME = '20261020170000-add-patient-program-enrollment-snapshot.js';
const TABLE = 'PatientVouchers', COLUMN = 'program_snapshot', ROOT = '/home/ubuntu/wt/back-dev';
const MAX_AGE = 30 * 60 * 1000;
const fail = code => { throw Error(code); };
const withoutSnapshot = value => { const { program_snapshot, ...prior } = value; return prior; };

function source() {
  if (process.cwd() !== ROOT || path.resolve(__dirname, '../..') !== ROOT
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev'
    || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) fail('ENROLLMENT_SCHEMA_COMMITTED_DEV_REQUIRED');
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    migration_sha256: hash(fs.readFileSync(path.join(ROOT, 'migrations', NAME))) };
}
function privateDirectory(filename) {
  if (!path.isAbsolute(filename || '')) fail('ENROLLMENT_SCHEMA_PRIVATE_PATH_REQUIRED');
  const root = fs.realpathSync('/home/ubuntu/secure-imports'), parent = fs.realpathSync(path.dirname(filename));
  if (parent !== root && !parent.startsWith(root + path.sep)) fail('ENROLLMENT_SCHEMA_PRIVATE_PATH_REQUIRED');
  for (const directory of [root, parent]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail('ENROLLMENT_SCHEMA_PRIVATE_PATH_REQUIRED');
  }
  return parent;
}
async function capture(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() database_name, CURRENT_USER() database_user, @@hostname server_name');
  const [columns] = await connection.query(`SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION,ORDINAL_POSITION
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='PatientVouchers' ORDER BY ORDINAL_POSITION`);
  if (!columns.length) fail('ENROLLMENT_SCHEMA_PARENT_REQUIRED');
  const [indexes] = await connection.query(`SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='PatientVouchers' ORDER BY INDEX_NAME,SEQ_IN_INDEX`);
  const [foreignKeys] = await connection.query(`SELECT CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME,ORDINAL_POSITION
    FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='PatientVouchers'
    AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME,ORDINAL_POSITION`);
  const [rows] = await connection.query('SELECT * FROM PatientVouchers ORDER BY id');
  const [metadata] = await connection.query('SELECT name FROM SequelizeMeta ORDER BY name');
  const [ddl] = await connection.query('SHOW CREATE TABLE PatientVouchers');
  return { identity_sha256: hash(identity), columns, indexes, foreign_keys: foreignKeys,
    metadata_names: metadata.map(row => row.name), registered: metadata.some(row => row.name === NAME),
    row_count: rows.length, prior_rows_sha256: hash(rows.map(withoutSnapshot)),
    nonnull_snapshots: rows.filter(row => row.program_snapshot != null).length,
    rows, create_table: ddl[0]?.['Create Table'] };
}
function state(captured) { const { rows, create_table, ...result } = captured; return result; }
function verifyColumn(columns) {
  const column = columns.find(value => value.COLUMN_NAME === COLUMN);
  return !!column && column.COLUMN_TYPE.toLowerCase() === 'json' && column.IS_NULLABLE === 'YES'
    && column.COLUMN_DEFAULT === null && column.EXTRA === '' && !column.GENERATION_EXPRESSION;
}
function validateBefore(plan, current, info, target, now = Date.now()) {
  if (plan?.version !== 1 || plan.target !== target || plan.migration !== NAME || plan.source_commit !== info.commit
    || plan.migration_sha256 !== info.migration_sha256 || !Number.isFinite(Date.parse(plan.generated_at))
    || Date.parse(plan.generated_at) > now || now - Date.parse(plan.generated_at) > MAX_AGE) fail('ENROLLMENT_SCHEMA_PLAN_INVALID');
  if (hash(plan.before) !== hash(state(current))) fail('ENROLLMENT_SCHEMA_CONCURRENT_CHANGE');
  if (current.registered || current.columns.some(column => column.COLUMN_NAME === COLUMN)) fail('ENROLLMENT_SCHEMA_EXISTING_OR_PARTIAL');
}
function verifyAfter(before, after, registered = false) {
  if (!verifyColumn(after.columns) || after.nonnull_snapshots !== 0) fail('ENROLLMENT_SCHEMA_COLUMN_INVALID');
  for (const field of ['identity_sha256', 'indexes', 'foreign_keys', 'row_count', 'prior_rows_sha256']) {
    if (hash(before[field]) !== hash(after[field])) fail('ENROLLMENT_SCHEMA_EXISTING_DATA_OR_STRUCTURE_CHANGED');
  }
  if (hash(after.columns.filter(column => column.COLUMN_NAME !== COLUMN)) !== hash(before.columns)) fail('ENROLLMENT_SCHEMA_OLD_COLUMNS_CHANGED');
  const expected = registered ? [...before.metadata_names, NAME].sort() : before.metadata_names;
  if (after.registered !== registered || hash(after.metadata_names) !== hash(expected)) fail('ENROLLMENT_SCHEMA_REGISTRY_CHANGED');
}
function boundedInterface(connection, Sequelize) {
  return {
    describeTable: async table => {
      if (table !== TABLE) fail('ENROLLMENT_SCHEMA_UNEXPECTED_TABLE');
      const [columns] = await connection.query(`SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='PatientVouchers'`);
      return Object.fromEntries(columns.map(column => [column.COLUMN_NAME, { type: column.COLUMN_TYPE.toUpperCase(), allowNull: column.IS_NULLABLE === 'YES' }]));
    },
    addColumn: async (table, column, specification) => {
      if (table !== TABLE || column !== COLUMN || specification?.type !== Sequelize.JSON || specification.allowNull !== true
        || Object.keys(specification).sort().join(',') !== 'allowNull,type') fail('ENROLLMENT_SCHEMA_UNEXPECTED_DDL');
      await connection.query('ALTER TABLE `PatientVouchers` ADD COLUMN `program_snapshot` JSON NULL, ALGORITHM=INSTANT');
    },
  };
}
function verifyBackup(plan) {
  privateDirectory(plan.backup_path);
  const stat = fs.lstatSync(plan.backup_path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.nlink !== 1) fail('ENROLLMENT_SCHEMA_BACKUP_INVALID');
  const bytes = fs.readFileSync(plan.backup_path);
  if (hash(bytes) !== plan.backup_sha256) fail('ENROLLMENT_SCHEMA_BACKUP_CHANGED');
  const backup = JSON.parse(zlib.gunzipSync(bytes));
  if (backup.target !== plan.target || backup.migration !== NAME || hash(state(backup.captured)) !== hash(plan.before)
    || !backup.captured.create_table || hash(backup.captured.rows.map(withoutSnapshot)) !== plan.before.prior_rows_sha256
    || backup.captured.rows.length !== plan.before.row_count) fail('ENROLLMENT_SCHEMA_BACKUP_INCOMPLETE');
  return true;
}
function assertDevStopped() {
  for (const name of ['clinicaclick-back-dev.service', 'clinicaclick-dev-security.service']) {
    const status = execFileSync('systemctl', ['show', name, '--property=ActiveState', '--value'], { encoding: 'utf8' }).trim();
    if (!['inactive', 'failed'].includes(status)) fail('ENROLLMENT_SCHEMA_STOP_DEV_WRITERS_FIRST');
  }
}
async function run(argv) {
  const args = parseArgs(argv, ['--mode', '--target', '--plan', '--approved-sha256', '--private-output', '--private-journal']);
  const mode = args['--mode'], target = args['--target'];
  if (!['prepare', 'apply', 'verify'].includes(mode) || !['dev', 'crm'].includes(target)) fail('ENROLLMENT_SCHEMA_EXPLICIT_TARGET_MODE_REQUIRED');
  const info = source(), connection = await connectOperatorDatabase(target);
  let log, locked = false;
  try {
    await connection.query('SET SESSION lock_wait_timeout=10');
    await connection.query('SET SESSION innodb_lock_wait_timeout=10');
    if (mode === 'prepare') {
      const directory = privateDirectory(args['--private-output']);
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      let captured; try { captured = await capture(connection); } finally { await connection.rollback(); }
      if (captured.registered || captured.columns.some(column => column.COLUMN_NAME === COLUMN)) fail('ENROLLMENT_SCHEMA_EXISTING_OR_PARTIAL');
      const backup = { version: 1, target, migration: NAME, captured }, bytes = zlib.gzipSync(Buffer.from(JSON.stringify(backup)));
      const backupPath = path.join(directory, `patient-vouchers-${target}-${Date.now()}.json.gz`);
      const backupFd = fs.openSync(backupPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(backupFd, bytes); fs.fsyncSync(backupFd); } finally { fs.closeSync(backupFd); }
      syncDirectory(directory);
      const plan = { version: 1, target, source_commit: info.commit, migration: NAME, migration_sha256: info.migration_sha256,
        generated_at: new Date().toISOString(), before: state(captured), backup_path: backupPath, backup_sha256: hash(bytes) };
      verifyBackup(plan); writePrivateJson(args['--private-output'], plan);
      return { status: 'prepared_read_only_with_scoped_backup', target, rows: captured.row_count,
        migration_sha256: info.migration_sha256, plan_sha256: hash(plan), business_writes: 0 };
    }
    const plan = privateJson(args['--plan']); verifyBackup(plan);
    if (mode === 'verify') {
      const after = await capture(connection);
      if (plan.target !== target || plan.migration !== NAME || plan.migration_sha256 !== info.migration_sha256) fail('ENROLLMENT_SCHEMA_VERIFICATION_PLAN_INVALID');
      verifyAfter(plan.before, after, true);
      const report = { status: 'verified', target, rows: after.row_count, migration: NAME, column: COLUMN, business_writes: 0 };
      writePrivateJson(args['--private-output'], report); return report;
    }
    if (args['--approved-sha256'] !== hash(plan)) fail('ENROLLMENT_SCHEMA_EXPLICIT_PLAN_APPROVAL_REQUIRED');
    if (target === 'dev') assertDevStopped();
    const [[lock]] = await connection.query('SELECT GET_LOCK(?,0) acquired', [`cc-program-enrollment-schema:${target}`]);
    if (Number(lock.acquired) !== 1) fail('ENROLLMENT_SCHEMA_ANOTHER_OPERATOR_ACTIVE');
    locked = true;
    const current = await capture(connection); validateBefore(plan, current, info, target);
    log = newJournal(args['--private-journal'], hash(plan));
    await log.append({ phase: 'before_ddl', target, migration: NAME, migration_sha256: info.migration_sha256, backup_sha256: plan.backup_sha256 });
    const Sequelize = require('sequelize');
    await require(path.join(ROOT, 'migrations', NAME)).up(boundedInterface(connection, Sequelize), Sequelize);
    await log.append({ phase: 'ddl_completed_requires_verification', target, migration: NAME });
    verifyAfter(current, await capture(connection));
    await connection.query('INSERT INTO SequelizeMeta(name) VALUES (?)', [NAME]);
    const after = await capture(connection); verifyAfter(current, after, true);
    await log.append({ phase: 'verified', target, migration: NAME, rows: after.row_count, prior_rows_sha256: after.prior_rows_sha256, business_writes: 0 });
    return { status: 'applied_verified', target, migration: NAME, rows: after.row_count, business_writes: 0 };
  } finally {
    log?.close();
    try { if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [`cc-program-enrollment-schema:${target}`]); }
    finally { await connection.end(); }
  }
}
if (require.main === module) run(process.argv.slice(2)).then(report => console.log(JSON.stringify(report))).catch(error => {
  console.error(/^ENROLLMENT_SCHEMA_/.test(error.message) ? error.message : 'ENROLLMENT_SCHEMA_FAILED_INSPECT_PRIVATE_JOURNAL'); process.exitCode = 1;
});
module.exports = { NAME, TABLE, COLUMN, MAX_AGE, withoutSnapshot, state, capture, verifyColumn, validateBefore, verifyAfter, boundedInterface, verifyBackup, run };

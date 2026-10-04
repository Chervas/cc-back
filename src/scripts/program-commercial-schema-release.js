#!/usr/bin/env node
'use strict';

// One additive nullable field, no application bootstrap or business backfill.
// DDL commits implicitly: keep the journal and additive schema on any failure.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase, databaseOptions } = require('../lib/cliniccloud-import/operator-database');
const { privateJson } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
const NAME = '20261004180000-program-commercial-price-profile.js';
const ROOT = '/home/ubuntu/wt/back-dev';
const COLUMN = 'price_profile';
const fail = code => { throw Error(code); };

function source() {
  if (process.cwd() !== ROOT || path.resolve(__dirname, '../..') !== ROOT
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev'
    || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) fail('PROGRAM_SCHEMA_COMMITTED_DEV_REQUIRED');
  const file = path.join(ROOT, 'migrations', NAME);
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), file, migration_sha256: hash(readBytes(file)) };
}
function verifyColumn(columns) {
  const column = columns.find(row => row.COLUMN_NAME === COLUMN);
  return Boolean(column && column.COLUMN_TYPE.toLowerCase() === 'json' && column.IS_NULLABLE === 'YES'
    && column.COLUMN_DEFAULT === null && column.EXTRA === '' && !column.GENERATION_EXPRESSION);
}
function withoutNewColumn(row) { const { price_profile, ...prior } = row; return prior; }
async function capture(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() AS database_name, CURRENT_USER() AS database_user, @@hostname AS server_name');
  const [columns] = await connection.query(`SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION,ORDINAL_POSITION
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='TreatmentPrograms' ORDER BY ORDINAL_POSITION`);
  if (!columns.length) fail('PROGRAM_SCHEMA_PARENT_TABLE_REQUIRED');
  const [metadata] = await connection.query('SELECT name FROM SequelizeMeta ORDER BY name');
  const [programs] = await connection.query('SELECT * FROM TreatmentPrograms ORDER BY id');
  const [revisions] = await connection.query('SELECT * FROM TreatmentProgramRevisions ORDER BY id');
  return { identity_sha256: hash(identity), columns, registered: metadata.some(row => row.name === NAME),
    metadata_names: metadata.map(row => row.name).sort(),
    program_count: programs.length, programs_sha256: hash(programs.map(withoutNewColumn)),
    revisions_count: revisions.length, revisions_sha256: hash(revisions),
    nonnull_profiles: programs.filter(row => row.price_profile != null).length };
}
function validateBefore(plan, current, info, target, now = Date.now()) {
  if (plan?.version !== 1 || plan.target !== target || plan.migration !== NAME || plan.source_commit !== info.commit
    || plan.migration_sha256 !== info.migration_sha256 || !Number.isFinite(Date.parse(plan.generated_at))
    || Date.parse(plan.generated_at) > now || now - Date.parse(plan.generated_at) > 7200000) fail('PROGRAM_SCHEMA_PLAN_INVALID_OR_EXPIRED');
  if (hash(plan.before) !== hash(current)) fail('PROGRAM_SCHEMA_PLAN_DRIFT');
  if (current.registered || current.columns.some(row => row.COLUMN_NAME === COLUMN)) fail('PROGRAM_SCHEMA_EXISTING_OR_PARTIAL_REQUIRES_REVIEW');
}
function verifyAfter(before, after, { registered = false } = {}) {
  if (!verifyColumn(after.columns) || after.nonnull_profiles !== 0) fail('PROGRAM_SCHEMA_COLUMN_VERIFICATION_FAILED');
  if (hash(after.columns.filter(row => row.COLUMN_NAME !== COLUMN)) !== hash(before.columns)
    || after.identity_sha256 !== before.identity_sha256 || after.programs_sha256 !== before.programs_sha256
    || after.revisions_sha256 !== before.revisions_sha256
    || after.program_count !== before.program_count || after.revisions_count !== before.revisions_count) fail('PROGRAM_SCHEMA_EXISTING_DATA_OR_COLUMNS_CHANGED');
  const expected = registered ? [...before.metadata_names, NAME].sort() : before.metadata_names;
  if (after.registered !== registered || hash(after.metadata_names) !== hash(expected)) fail('PROGRAM_SCHEMA_MIGRATION_METADATA_CHANGED');
}
function newJournal(filename, planHash) {
  if (!path.isAbsolute(filename || '')) fail('PROGRAM_SCHEMA_PRIVATE_JOURNAL_REQUIRED');
  const root = fs.realpathSync('/home/ubuntu/secure-imports'), parent = fs.realpathSync(path.dirname(filename));
  if (parent !== root && !parent.startsWith(root + path.sep)) fail('PROGRAM_SCHEMA_PRIVATE_JOURNAL_REQUIRED');
  for (const dir of [root, parent]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('PROGRAM_SCHEMA_PRIVATE_JOURNAL_REQUIRED');
  }
  const resolved = path.join(parent, path.basename(filename));
  const descriptor = fs.openSync(resolved, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1) fail('PROGRAM_SCHEMA_PRIVATE_JOURNAL_REQUIRED');
    fs.fsyncSync(descriptor);
    const directory = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch (error) { fs.closeSync(descriptor); throw error; }
  let sequence = 0, previous = null;
  return { append: async event => {
    const entry = { ...event, package_sha256: planHash, journal_at: new Date().toISOString(), sequence: ++sequence, previous_entry_sha256: previous };
    previous = hash(entry);
    fs.writeSync(descriptor, JSON.stringify({ ...entry, entry_sha256: previous }) + '\n');
    fs.fsyncSync(descriptor);
  }, close: () => fs.closeSync(descriptor) };
}
function boundedQueryInterface(connection, Sequelize) {
  return {
    describeTable: async table => {
      if (table !== 'TreatmentPrograms') fail('PROGRAM_SCHEMA_UNEXPECTED_TABLE');
      const [rows] = await connection.query("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='TreatmentPrograms'");
      return Object.fromEntries(rows.map(row => [row.COLUMN_NAME, { type: row.COLUMN_TYPE.toUpperCase(), allowNull: row.IS_NULLABLE === 'YES' }]));
    },
    addColumn: async (table, column, specification) => {
      if (table !== 'TreatmentPrograms' || column !== COLUMN || specification?.type !== Sequelize.JSON
        || specification.allowNull !== true || Object.keys(specification).sort().join(',') !== 'allowNull,type') fail('PROGRAM_SCHEMA_UNEXPECTED_DDL');
      // Require the online additive operation; never rebuild/copy the table as
      // an implicit fallback or modify any existing value/default/index.
      await connection.query('ALTER TABLE `TreatmentPrograms` ADD COLUMN `price_profile` JSON NULL, ALGORITHM=INSTANT');
    },
  };
}
function assertDevStopped() {
  for (const service of ['clinicaclick-back-dev.service', 'clinicaclick-dev-security.service']) {
    const state = execFileSync('systemctl', ['show', '--property=ActiveState', '--value', service], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!['inactive', 'failed'].includes(state)) fail('PROGRAM_SCHEMA_STOP_DEV_WRITERS_FIRST');
  }
}
async function run(args) {
  const options = parseArgs(args, ['--mode', '--target', '--private-output', '--plan', '--approved-migration-sha256', '--backup-manifest', '--private-journal']);
  const mode = options['--mode'], target = options['--target'];
  if (!['prepare', 'apply', 'verify'].includes(mode) || !['dev', 'crm'].includes(target)) fail('PROGRAM_SCHEMA_EXPLICIT_MODE_TARGET_REQUIRED');
  const info = source();
  const configuration = databaseOptions(target);
  const connection = await connectOperatorDatabase(target);
  let journal;
  try {
    await connection.query('SET SESSION lock_wait_timeout=10');
    if (mode !== 'apply') {
      if (!options['--private-output']) fail('PROGRAM_SCHEMA_PRIVATE_OUTPUT_REQUIRED');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      let before;
      try { before = await capture(connection); } finally { await connection.rollback(); }
      if (mode === 'verify') {
        if (!before.registered || !verifyColumn(before.columns)) fail('PROGRAM_SCHEMA_NOT_APPLIED_VERIFIED');
        if (!options['--plan']) fail('PROGRAM_SCHEMA_VERIFICATION_PLAN_REQUIRED');
        const prior = privateJson(options['--plan']);
        if (prior.version !== 1 || prior.target !== target || prior.migration !== NAME
          || prior.source_commit !== info.commit || prior.migration_sha256 !== info.migration_sha256) fail('PROGRAM_SCHEMA_VERIFICATION_PLAN_INVALID');
        verifyAfter(prior.before, before, { registered: true });
        const result = { status: 'verified', target, source_commit: info.commit, migration: NAME, migration_sha256: info.migration_sha256, state: before, business_data_written: false };
        writePrivateJson(options['--private-output'], result);
        return { status: 'verified', target, programs: before.program_count, source_commit: info.commit };
      }
      if (before.registered || before.columns.some(row => row.COLUMN_NAME === COLUMN)) fail('PROGRAM_SCHEMA_EXISTING_OR_PARTIAL_REQUIRES_REVIEW');
      const plan = { version: 1, target, source_commit: info.commit, migration: NAME, migration_sha256: info.migration_sha256, generated_at: new Date().toISOString(), before };
      writePrivateJson(options['--private-output'], plan);
      return { status: 'prepared', target, migration: NAME, migration_sha256: info.migration_sha256, programs: before.program_count, business_data_written: false };
    }
    if (!options['--plan'] || !options['--backup-manifest'] || !options['--private-journal']
      || options['--approved-migration-sha256'] !== info.migration_sha256) fail('PROGRAM_SCHEMA_APPROVED_PLAN_BACKUP_JOURNAL_REQUIRED');
    const plan = privateJson(options['--plan']);
    const backup = privateJson(options['--backup-manifest']);
    if (backup.database_target !== target || backup.database_name !== configuration.database
      || backup.full_gzip_verified !== true || backup.dump_completion_verified !== true
      || !Number.isFinite(Date.parse(backup.generated_at)) || Date.parse(backup.generated_at) > Date.now()
      || Date.now() - Date.parse(backup.generated_at) > 7200000) fail('PROGRAM_SCHEMA_FRESH_TARGET_BACKUP_REQUIRED');
    await validateBackup(options['--backup-manifest']);
    if (target === 'dev') assertDevStopped();
    if (fs.existsSync(options['--private-journal'])) fail('PROGRAM_SCHEMA_NEW_JOURNAL_REQUIRED');
    const [[lock]] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [`cc-program-price-schema:${target}`]);
    if (Number(lock.acquired) !== 1) fail('PROGRAM_SCHEMA_ANOTHER_OPERATOR_ACTIVE');
    const current = await capture(connection);
    validateBefore(plan, current, info, target);
    journal = newJournal(options['--private-journal'], hash(plan));
    await journal.append({ phase: 'before_ddl', target, source_commit: info.commit, migration: NAME, migration_sha256: info.migration_sha256, before_sha256: hash(current), backup_manifest_sha256: hash(backup) });
    const Sequelize = require('sequelize');
    await require(info.file).up(boundedQueryInterface(connection, Sequelize), Sequelize);
    await journal.append({ phase: 'ddl_completed_requires_verification', target, migration: NAME });
    const after = await capture(connection);
    verifyAfter(current, after);
    await connection.query('INSERT INTO SequelizeMeta(name) VALUES (?)', [NAME]);
    const registered = await capture(connection);
    verifyAfter(current, registered, { registered: true });
    await journal.append({ phase: 'verified', target, migration: NAME, programs_sha256: after.programs_sha256, revisions_sha256: after.revisions_sha256, metadata_names_sha256: hash(registered.metadata_names), programs: after.program_count, revisions: after.revisions_count, business_data_written: false });
    return { status: 'applied_verified', target, migration: NAME, programs: after.program_count, revisions: after.revisions_count, business_data_written: false };
  } finally { journal?.close(); await connection.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'PROGRAM_SCHEMA_FAILED_INSPECT_PRIVATE_JOURNAL');
  process.exitCode = 1;
});
module.exports = { NAME, capture, verifyColumn, withoutNewColumn, validateBefore, verifyAfter, newJournal, boundedQueryInterface, run };

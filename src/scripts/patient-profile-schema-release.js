#!/usr/bin/env node
'use strict';

// Operator-only, metadata-only release of nine nullable patient columns.
// No model bootstrap, patient rows, backfill, runtime settings or restarts.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase, databaseOptions } = require('../lib/cliniccloud-import/operator-database');
const { privateJson } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
const { newJournal } = require('./program-commercial-schema-release');
const { PATIENT_PROFILE_FIELD_NAMES, PATIENT_PROFILE_FIELD_SPECS, patientProfileAttributes } = require('../lib/patient-profile-fields');
const ROOT = '/home/ubuntu/wt/back-dev';
const VERSION = 'patient-profile-schema/1';
const NAME = '20261012100000-add-patient-profile-and-medical-notes.js';
const MIGRATION_SHA256 = 'b642794506d9cbcb11d8ca5b22817bfe3a8f4e7f581fa42d9fb1c7ab6f64870b';
const FIELDS_SHA256 = '6872ca9f3d416fecbf6ac47cbe62206df94401d901653aec8194be4eedbc6ef9';
const TABLES = ['Pacientes', 'SequelizeMeta'];
const fail = code => { throw Error(code); };
const isNewColumn = row => row.TABLE_NAME === 'Pacientes' && PATIENT_PROFILE_FIELD_NAMES.includes(row.COLUMN_NAME);

function reviewedBytes() {
  if (hash(readBytes(path.join(ROOT, 'migrations', NAME))) !== MIGRATION_SHA256
    || hash(readBytes(path.join(ROOT, 'src/lib/patient-profile-fields.js'))) !== FIELDS_SHA256) fail('PATIENT_SCHEMA_REVIEWED_SOURCE_CHANGED');
}
function source() {
  if (process.cwd() !== ROOT || path.resolve(__dirname, '../..') !== ROOT
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev'
    || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) fail('PATIENT_SCHEMA_COMMITTED_CANONICAL_DEV_REQUIRED');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('PATIENT_SCHEMA_SOURCE_INVALID');
  reviewedBytes();
  return { commit, migration_sha256: MIGRATION_SHA256, fields_sha256: FIELDS_SHA256 };
}

async function capture(connection, configuration) {
  const query = async (sql, values = []) => (await connection.query(sql, values))[0];
  const [identity] = await query('SELECT DATABASE() AS database_name, CURRENT_USER() AS database_user, @@hostname AS server_name');
  if (identity?.database_name !== configuration.database) fail('PATIENT_SCHEMA_DATABASE_IDENTITY_MISMATCH');
  const tables = await query('SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME', [TABLES]);
  if (TABLES.some(name => !tables.some(row => row.TABLE_NAME === name && row.ENGINE === 'InnoDB'))) fail('PATIENT_SCHEMA_PARENT_AND_METADATA_INNODB_REQUIRED');
  const columns = await query('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION,ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,ORDINAL_POSITION', [TABLES]);
  const indexes = await query('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX', [TABLES]);
  const foreignKeys = await query('SELECT TABLE_NAME,COLUMN_NAME,CONSTRAINT_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION', [TABLES]);
  const triggers = await query('SELECT EVENT_OBJECT_TABLE,TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (?) ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME', [TABLES]);
  if (triggers.some(row => row.EVENT_OBJECT_TABLE === 'SequelizeMeta')) fail('PATIENT_SCHEMA_METADATA_TRIGGERS_UNEXPECTED');
  const metadata = await query('SELECT name FROM SequelizeMeta ORDER BY name');
  return { database_name: identity.database_name, identity_sha256: hash(identity), server_sha256: hash(identity.server_name),
    tables, columns, indexes, foreignKeys, triggers, metadata_names: metadata.map(row => row.name).sort() };
}
function assertUnapplied(state) {
  if (TABLES.some(name => !state.tables.some(row => row.TABLE_NAME === name && row.ENGINE === 'InnoDB'))) fail('PATIENT_SCHEMA_PARENT_AND_METADATA_INNODB_REQUIRED');
  if (state.triggers.some(row => row.EVENT_OBJECT_TABLE === 'SequelizeMeta')) fail('PATIENT_SCHEMA_METADATA_TRIGGERS_UNEXPECTED');
  if (state.metadata_names.includes(NAME) || state.columns.some(isNewColumn)) fail('PATIENT_SCHEMA_EXISTING_OR_PARTIAL_REQUIRES_REVIEW');
}
function validColumn(column) {
  const spec = PATIENT_PROFILE_FIELD_SPECS[column?.COLUMN_NAME];
  if (!spec) return false;
  const wanted = spec.kind === 'boolean' ? 'tinyint(1)' : spec.kind === 'text' ? 'text' : `varchar(${spec.maxLength})`;
  return column.TABLE_NAME === 'Pacientes' && column.COLUMN_TYPE.toLowerCase() === wanted && column.IS_NULLABLE === 'YES'
    && column.COLUMN_DEFAULT === null && !column.EXTRA && !column.GENERATION_EXPRESSION;
}
function verifySchema(state, { registered = true } = {}) {
  if (TABLES.some(name => !state.tables.some(row => row.TABLE_NAME === name && row.ENGINE === 'InnoDB'))) fail('PATIENT_SCHEMA_PARENT_AND_METADATA_INNODB_REQUIRED');
  const collation = state.tables.find(row => row.TABLE_NAME === 'Pacientes').TABLE_COLLATION;
  if (PATIENT_PROFILE_FIELD_NAMES.some(name => {
    const column = state.columns.find(row => row.TABLE_NAME === 'Pacientes' && row.COLUMN_NAME === name);
    if (!validColumn(column)) return true;
    return PATIENT_PROFILE_FIELD_SPECS[name].kind === 'boolean'
      ? column.CHARACTER_SET_NAME !== null || column.COLLATION_NAME !== null
      : column.COLLATION_NAME !== collation || column.CHARACTER_SET_NAME !== String(collation).split('_')[0];
  })) fail('PATIENT_SCHEMA_ADDED_COLUMNS_INVALID');
  if (state.triggers.some(row => row.EVENT_OBJECT_TABLE === 'SequelizeMeta')) fail('PATIENT_SCHEMA_METADATA_TRIGGERS_UNEXPECTED');
  if (state.metadata_names.includes(NAME) !== registered) fail('PATIENT_SCHEMA_MIGRATION_METADATA_CHANGED');
}
function validatePlan(plan, info, target, configuration, { now = Date.now(), fresh = true } = {}) {
  if (plan?.version !== VERSION || plan.target !== target || plan.source_commit !== info.commit || plan.migration !== NAME
    || plan.migration_sha256 !== MIGRATION_SHA256 || info.migration_sha256 !== MIGRATION_SHA256
    || plan.fields_sha256 !== FIELDS_SHA256 || info.fields_sha256 !== FIELDS_SHA256
    || plan.configuration_sha256 !== hash(configuration) || plan.before?.database_name !== configuration.database
    || !Number.isFinite(Date.parse(plan.generated_at)) || Date.parse(plan.generated_at) > now
    || fresh && now - Date.parse(plan.generated_at) > 7200000) fail('PATIENT_SCHEMA_PLAN_INVALID_OR_EXPIRED');
  assertUnapplied(plan.before);
}
function validateBackupManifest(backup, plan, configuration, target, now = Date.now()) {
  if (backup.version !== 'cliniccloud-operator-backup/1' || backup.database_target !== target || backup.database_name !== configuration.database
    || hash(backup.server_name) !== plan.before.server_sha256 || backup.full_gzip_verified !== true || backup.dump_completion_verified !== true
    || !TABLES.every(name => backup.tables?.includes(name)) || !Number.isFinite(Date.parse(backup.generated_at))
    || Date.parse(backup.generated_at) > now || now - Date.parse(backup.generated_at) > 7200000) fail('PATIENT_SCHEMA_FRESH_TARGET_BACKUP_REQUIRED');
}
function verifyAfter(before, after, { registered = false } = {}) {
  verifySchema(after, { registered });
  for (const part of ['tables', 'indexes', 'foreignKeys', 'triggers']) {
    if (hash(before[part]) !== hash(after[part])) fail('PATIENT_SCHEMA_EXISTING_METADATA_CHANGED');
  }
  if (hash(before.columns) !== hash(after.columns.filter(row => !isNewColumn(row)))
    || before.identity_sha256 !== after.identity_sha256 || before.database_name !== after.database_name) fail('PATIENT_SCHEMA_EXISTING_METADATA_CHANGED');
  const expected = registered ? [...before.metadata_names, NAME].sort() : before.metadata_names;
  if (hash(after.metadata_names) !== hash(expected)) fail('PATIENT_SCHEMA_MIGRATION_METADATA_CHANGED');
}

function boundedQueryInterface(connection, Sequelize) {
  const wanted = patientProfileAttributes(Sequelize);
  return {
    describeTable: async table => {
      if (table !== 'Pacientes') fail('PATIENT_SCHEMA_UNEXPECTED_TABLE');
      const [rows] = await connection.query("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='Pacientes'");
      return Object.fromEntries(rows.map(row => [row.COLUMN_NAME, { type: row.COLUMN_TYPE.toUpperCase(), allowNull: row.IS_NULLABLE === 'YES', defaultValue: row.COLUMN_DEFAULT }]));
    },
    addColumn: async (table, field, specification) => {
      if (table !== 'Pacientes' || !Object.hasOwn(wanted, field) || specification?.allowNull !== true
        || Object.keys(specification).sort().join(',') !== 'allowNull,type'
        || specification.type.toString() !== wanted[field].type.toString()) fail('PATIENT_SCHEMA_UNEXPECTED_DDL');
      const spec = PATIENT_PROFILE_FIELD_SPECS[field];
      const type = spec.kind === 'boolean' ? 'TINYINT(1)' : spec.kind === 'text' ? 'TEXT' : `VARCHAR(${spec.maxLength})`;
      // Exact reviewed identifiers/types only. No implicit table copy fallback.
      await connection.query(`ALTER TABLE \`Pacientes\` ADD COLUMN \`${field}\` ${type} NULL DEFAULT NULL, ALGORITHM=INSTANT`);
    },
  };
}
function assertDevStopped(command = execFileSync) {
  for (const service of ['clinicaclick-back-dev.service', 'clinicaclick-dev-security.service']) {
    const state = command('systemctl', ['show', '--property=ActiveState', '--value', service], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!['inactive', 'failed'].includes(state)) fail('PATIENT_SCHEMA_STOP_DEV_WRITERS_FIRST');
  }
}
async function applyPlan({ connection, plan, info, target, configuration, journal, captureState = capture,
  migrationInterfaceFactory = boundedQueryInterface, loadMigration = () => require(path.join(ROOT, 'migrations', NAME)) }) {
  const [[lock]] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [`cc-patient-profile-schema:${target}`]);
  if (Number(lock.acquired) !== 1) fail('PATIENT_SCHEMA_ANOTHER_OPERATOR_ACTIVE');
  let transaction = false;
  try {
    const current = await captureState(connection, configuration);
    validatePlan(plan, info, target, configuration);
    assertUnapplied(current);
    if (hash(current) !== hash(plan.before)) fail('PATIENT_SCHEMA_PLAN_DRIFT');
    reviewedBytes();
    await journal.append({ phase: 'before_ddl', target, source_commit: info.commit, migration: NAME, migration_sha256: MIGRATION_SHA256, before_sha256: hash(current) });
    const Sequelize = require('sequelize');
    await loadMigration().up(migrationInterfaceFactory(connection, Sequelize), Sequelize);
    await journal.append({ phase: 'ddl_completed_requires_verification' });
    verifyAfter(current, await captureState(connection, configuration));
    await journal.append({ phase: 'ddl_verified_before_metadata' });
    await connection.beginTransaction(); transaction = true;
    await connection.query('INSERT INTO SequelizeMeta(name) VALUES (?)', [NAME]);
    verifyAfter(current, await captureState(connection, configuration), { registered: true });
    await journal.append({ phase: 'metadata_verified_before_commit' });
    await connection.commit(); transaction = false;
    verifyAfter(current, await captureState(connection, configuration), { registered: true });
    await journal.append({ phase: 'verified', target, metadata_only_verification: true, patient_rows_read: false,
      business_dml_executed: false, configuration_changed: false, process_restarted: false });
    return { status: 'applied_verified', target, source_commit: info.commit, migration: NAME, business_data_written: false, metadata_only_verification: true };
  } catch (error) {
    if (transaction) await connection.rollback();
    await journal.append({ phase: 'failed_preserve_additive_schema', instruction: 'Inspect journal/schema; no blind retry, down or global restore over later writes.' });
    throw error;
  } finally { await connection.query('SELECT RELEASE_LOCK(?)', [`cc-patient-profile-schema:${target}`]); }
}
async function run(args) {
  const options = parseArgs(args, ['--mode', '--target', '--private-output', '--plan', '--approved-plan-sha256', '--backup-manifest', '--private-journal']);
  const mode = options['--mode'], target = options['--target'];
  if (!['prepare', 'check', 'apply', 'verify'].includes(mode) || !['dev', 'crm'].includes(target)) fail('PATIENT_SCHEMA_EXPLICIT_MODE_TARGET_REQUIRED');
  const info = source(), configuration = databaseOptions(target);
  const connection = await connectOperatorDatabase(target);
  let journal;
  try {
    await connection.query('SET SESSION lock_wait_timeout=10');
    if (mode !== 'apply') {
      if (!options['--private-output']) fail('PATIENT_SCHEMA_PRIVATE_OUTPUT_REQUIRED');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      let state;
      try { state = await capture(connection, configuration); } finally { await connection.rollback(); }
      if (mode === 'prepare') {
        assertUnapplied(state);
        const plan = { version: VERSION, target, source_commit: info.commit, migration: NAME, migration_sha256: MIGRATION_SHA256,
          fields_sha256: FIELDS_SHA256, generated_at: new Date().toISOString(), configuration_sha256: hash(configuration), before: state };
        writePrivateJson(options['--private-output'], plan);
        return { status: 'prepared', target, migration: NAME, plan_sha256: hash(plan), metadata_only: true };
      }
      verifySchema(state);
      if (mode === 'verify') {
        if (!options['--plan']) fail('PATIENT_SCHEMA_VERIFICATION_PLAN_REQUIRED');
        const plan = privateJson(options['--plan']);
        validatePlan(plan, info, target, configuration, { fresh: false });
        verifyAfter(plan.before, state, { registered: true });
      }
      writePrivateJson(options['--private-output'], { status: mode === 'check' ? 'compatible' : 'verified', target, source_commit: info.commit,
        migration: NAME, state, metadata_only: true, patient_rows_read: false });
      return { status: mode === 'check' ? 'compatible' : 'verified', target, source_commit: info.commit, metadata_only: true };
    }
    if (!options['--plan'] || !options['--backup-manifest'] || !options['--private-journal']) fail('PATIENT_SCHEMA_APPROVED_PLAN_BACKUP_JOURNAL_REQUIRED');
    const plan = privateJson(options['--plan']), backup = privateJson(options['--backup-manifest']);
    validatePlan(plan, info, target, configuration);
    if (options['--approved-plan-sha256'] !== hash(plan)) fail('PATIENT_SCHEMA_APPROVED_PLAN_HASH_REQUIRED');
    validateBackupManifest(backup, plan, configuration, target);
    await validateBackup(options['--backup-manifest']);
    if (target === 'dev') assertDevStopped();
    if (fs.existsSync(options['--private-journal'])) fail('PATIENT_SCHEMA_NEW_JOURNAL_REQUIRED');
    journal = newJournal(options['--private-journal'], hash(plan));
    await journal.append({ phase: 'backup_integrity_verified', backup_manifest_sha256: hash(backup), backup_sha256: backup.backup.sha256,
      restore_rehearsal_performed: false });
    return await applyPlan({ connection, plan, info, target, configuration, journal });
  } finally { try { journal?.close(); } finally { await connection.end(); } }
}
if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(/^PATIENT_SCHEMA_[A-Z_]+$/.test(error.message) ? error.message : 'PATIENT_SCHEMA_FAILED_INSPECT_PRIVATE_JOURNAL');
  process.exitCode = 1;
});
module.exports = { VERSION, NAME, MIGRATION_SHA256, FIELDS_SHA256, source, capture, assertUnapplied, validColumn, verifySchema,
  validatePlan, validateBackupManifest, verifyAfter, boundedQueryInterface, assertDevStopped, applyPlan, run };

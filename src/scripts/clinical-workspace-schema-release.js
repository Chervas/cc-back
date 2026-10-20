#!/usr/bin/env node
'use strict';

// Operator-only, explicitly isolated DEV and two reviewed additive migrations.
// No application models, patient narrative reads, fixture creation or restarts.
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const { Sequelize } = require('sequelize');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { databaseOptions } = require('../lib/cliniccloud-import/operator-database');
const { privateJson } = require('./cliniccloud-import-appointments-apply');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
const { newJournal } = require('./program-commercial-schema-release');
const ROOT = '/home/ubuntu/wt/back-dev', VERSION = 'clinical-workspace-schema/1';
const MIGRATIONS = Object.freeze(['20261020193000-clinical-episodes-foundation.js', '20261020200000-clinical-drawings.js']);
const PARENTS = Object.freeze(['Clinicas', 'Pacientes', 'CitasPacientes', 'ClinicalPrivateAssets', 'AppointmentClinicalReports', 'AppointmentClinicalReportRevisions', 'SequelizeMeta']);
const NEW_TABLES = Object.freeze(['ClinicalEpisodeAppointments', 'ClinicalDrawings', 'ClinicalDrawingRevisions']);
const TABLES = [...PARENTS, ...NEW_TABLES];
const NEW_COLUMNS = Object.freeze({ AppointmentClinicalReports: { title: 'varchar(255)', occurred_at: 'datetime', template_key: 'varchar(40)',
  rich_document: 'json', material_refs: 'json', creation_key: 'varchar(64)', creation_payload_hash: 'varchar(64)' },
AppointmentClinicalReportRevisions: { mutation_key: 'varchar(64)', request_hash: 'varchar(64)' } });
const NEW_INDEXES = Object.freeze(['clinical_episodes_creation_uq', 'clinical_episodes_patient_date_idx', 'clinical_episode_revision_mutation_uq']);
const fail = code => { throw Error(code); };
function source({ clean = false } = {}) {
  if (process.cwd() !== ROOT || path.resolve(__dirname, '../..') !== ROOT
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev') fail('CLINICAL_SCHEMA_DEV_SOURCE_REQUIRED');
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim());
  if (clean && dirty) fail('CLINICAL_SCHEMA_COMMITTED_DEV_REQUIRED');
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty,
    migrations: MIGRATIONS.map(name => ({ name, sha256: hash(fs.readFileSync(path.join(ROOT, 'migrations', name))) })) };
}
function assertIdentity(identity) {
  if (identity.database_name !== 'clinicaclick_dev_isolated' || !/^cc_dev_api@/.test(identity.database_user)
    || Number(identity.fictional_anchor) !== 1) fail('CLINICAL_SCHEMA_ISOLATED_FICTIONAL_DATABASE_REQUIRED');
}
async function capture(sql) {
  const query = async (text, replacements) => (await sql.query(text, { replacements }))[0];
  const [identity] = await query("SELECT DATABASE() AS database_name,CURRENT_USER() AS database_user,@@hostname AS server_name,EXISTS(SELECT 1 FROM Clinicas WHERE id_clinica=1 AND nombre_clinica='Clinica ficticia DEV') AS fictional_anchor");
  assertIdentity(identity);
  const tables = await query('SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (:tables) ORDER BY TABLE_NAME', { tables: TABLES });
  if (PARENTS.some(name => !tables.some(row => row.TABLE_NAME === name && row.ENGINE === 'InnoDB'))) fail('CLINICAL_SCHEMA_PREREQUISITE_MISSING');
  const columns = await query('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION,ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (:tables) ORDER BY TABLE_NAME,ORDINAL_POSITION', { tables: TABLES });
  const indexes = await query('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (:tables) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX', { tables: TABLES });
  const foreignKeys = await query('SELECT K.TABLE_NAME,K.COLUMN_NAME,K.CONSTRAINT_NAME,K.REFERENCED_TABLE_NAME,K.REFERENCED_COLUMN_NAME,R.UPDATE_RULE,R.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE K JOIN information_schema.REFERENTIAL_CONSTRAINTS R ON R.CONSTRAINT_SCHEMA=K.CONSTRAINT_SCHEMA AND R.CONSTRAINT_NAME=K.CONSTRAINT_NAME AND R.TABLE_NAME=K.TABLE_NAME WHERE K.TABLE_SCHEMA=DATABASE() AND K.TABLE_NAME IN (:tables) AND K.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY K.TABLE_NAME,K.CONSTRAINT_NAME,K.ORDINAL_POSITION', { tables: TABLES });
  const triggers = await query('SELECT EVENT_OBJECT_TABLE,TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (:tables) ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME', { tables: TABLES });
  if (triggers.some(row => row.EVENT_OBJECT_TABLE === 'SequelizeMeta' || NEW_TABLES.includes(row.EVENT_OBJECT_TABLE))) fail('CLINICAL_SCHEMA_UNEXPECTED_METADATA_TRIGGER');
  const metadata = await query('SELECT name FROM SequelizeMeta ORDER BY name');
  return { database_name: identity.database_name, identity_sha256: hash(identity), server_sha256: hash(identity.server_name),
    fictional_anchor_verified: true, tables, columns, indexes, foreignKeys, triggers, metadata_names: metadata.map(row => row.name) };
}
function newColumn(row) { return Object.hasOwn(NEW_COLUMNS[row.TABLE_NAME] || {}, row.COLUMN_NAME); }
function assertUnapplied(state) {
  if (MIGRATIONS.some(name => state.metadata_names.includes(name)) || state.columns.some(newColumn)
    || state.tables.some(row => NEW_TABLES.includes(row.TABLE_NAME))) fail('CLINICAL_SCHEMA_PARTIAL_OR_EXISTING_REQUIRES_REVIEW');
}
function verifySchema(state, registered = true) {
  for (const [table, fields] of Object.entries(NEW_COLUMNS)) for (const [name, type] of Object.entries(fields)) {
    const column = state.columns.find(row => row.TABLE_NAME === table && row.COLUMN_NAME === name);
    if (!column || column.COLUMN_TYPE.toLowerCase() !== type || column.IS_NULLABLE !== 'YES' || column.COLUMN_DEFAULT !== null
      || column.EXTRA || column.GENERATION_EXPRESSION) fail('CLINICAL_SCHEMA_NEW_COLUMN_INVALID');
  }
  const owner = state.columns.find(row => row.TABLE_NAME === 'AppointmentClinicalReports' && row.COLUMN_NAME === 'appointment_id');
  const drawingTemplateVersion = state.columns.find(row => row.TABLE_NAME === 'ClinicalDrawings' && row.COLUMN_NAME === 'template_version');
  if (!drawingTemplateVersion || drawingTemplateVersion.COLUMN_TYPE.toLowerCase() !== 'int unsigned'
    || drawingTemplateVersion.IS_NULLABLE !== 'NO' || String(drawingTemplateVersion.COLUMN_DEFAULT) !== '1'
    || drawingTemplateVersion.EXTRA || drawingTemplateVersion.GENERATION_EXPRESSION) fail('CLINICAL_SCHEMA_DRAWING_TEMPLATE_VERSION_INVALID');
  if (owner?.IS_NULLABLE !== 'YES' || NEW_TABLES.some(name => !state.tables.some(row => row.TABLE_NAME === name && row.ENGINE === 'InnoDB'))
    || NEW_INDEXES.some(name => !state.indexes.some(row => row.INDEX_NAME === name))) fail('CLINICAL_SCHEMA_NEW_CONTRACT_INVALID');
  for (const name of MIGRATIONS) if (state.metadata_names.includes(name) !== registered) fail('CLINICAL_SCHEMA_METADATA_INVALID');
}
function verifyAfter(before, after, registered = true) {
  verifySchema(after, registered);
  if (before.identity_sha256 !== after.identity_sha256) fail('CLINICAL_SCHEMA_DATABASE_IDENTITY_CHANGED');
  const oldTables = after.tables.filter(row => !NEW_TABLES.includes(row.TABLE_NAME));
  const oldColumns = after.columns.filter(row => !NEW_TABLES.includes(row.TABLE_NAME) && !newColumn(row)).map(row => row.TABLE_NAME === 'AppointmentClinicalReports' && row.COLUMN_NAME === 'appointment_id'
    ? { ...row, IS_NULLABLE: before.columns.find(old => old.TABLE_NAME === row.TABLE_NAME && old.COLUMN_NAME === row.COLUMN_NAME).IS_NULLABLE } : row);
  const oldIndexes = after.indexes.filter(row => !NEW_TABLES.includes(row.TABLE_NAME) && !NEW_INDEXES.includes(row.INDEX_NAME));
  if (hash(oldTables) !== hash(before.tables) || hash(oldColumns) !== hash(before.columns) || hash(oldIndexes) !== hash(before.indexes)
    || hash(after.foreignKeys.filter(row => !NEW_TABLES.includes(row.TABLE_NAME))) !== hash(before.foreignKeys)
    || hash(after.triggers) !== hash(before.triggers)) fail('CLINICAL_SCHEMA_EXISTING_METADATA_CHANGED');
  const expected = registered ? [...before.metadata_names, ...MIGRATIONS].sort() : before.metadata_names;
  if (hash([...after.metadata_names].sort()) !== hash([...expected].sort())) fail('CLINICAL_SCHEMA_UNRELATED_MIGRATION_CHANGED');
}
function assertStopped(command = execFileSync) {
  for (const unit of ['clinicaclick-back-dev.service', 'clinicaclick-dev-security.service']) {
    const state = command('systemctl', ['show', '--property=ActiveState', '--value', unit], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!['inactive', 'failed'].includes(state)) fail('CLINICAL_SCHEMA_STOP_DEV_WRITERS_FIRST');
  }
}
function validatePlan(plan, info, current, { fresh = true } = {}) {
  if (plan?.version !== VERSION || plan.target !== 'dev' || plan.source_commit !== info.commit
    || hash(plan.migrations) !== hash(info.migrations) || !Number.isFinite(Date.parse(plan.generated_at))
    || Date.parse(plan.generated_at) > Date.now() || fresh && Date.now() - Date.parse(plan.generated_at) > 7200000) fail('CLINICAL_SCHEMA_PLAN_INVALID_OR_EXPIRED');
  assertUnapplied(plan.before);
  if (current && hash(current) !== hash(plan.before)) fail('CLINICAL_SCHEMA_PLAN_DRIFT');
}
function validateBackupManifest(backup, plan) {
  if (backup.version !== 'cliniccloud-operator-backup/1' || backup.database_target !== 'dev' || backup.database_name !== 'clinicaclick_dev_isolated'
    || hash(backup.server_name) !== plan.before.server_sha256 || !backup.full_gzip_verified || !backup.dump_completion_verified
    || !PARENTS.every(name => backup.tables?.includes(name)) || !Number.isFinite(Date.parse(backup.generated_at))
    || Date.parse(backup.generated_at) > Date.now() || Date.now() - Date.parse(backup.generated_at) > 7200000) fail('CLINICAL_SCHEMA_FRESH_BACKUP_REQUIRED');
}
async function run(args) {
  const options = parseArgs(args, ['--mode', '--target', '--private-output', '--plan', '--approved-plan-sha256', '--backup-manifest', '--private-journal']);
  const mode = options['--mode'];
  if (options['--target'] !== 'dev' || !['inspect', 'prepare', 'apply', 'verify'].includes(mode)) fail('CLINICAL_SCHEMA_EXPLICIT_DEV_MODE_REQUIRED');
  const info = source({ clean: mode !== 'inspect' }), config = databaseOptions('dev');
  const sql = new Sequelize(config.database, config.user, config.password, { host: config.host, port: config.port,
    dialect: 'mysql', dialectOptions: { ...(config.ssl ? { ssl: config.ssl } : {}), dateStrings: true }, timezone: '+00:00', logging: false,
    pool: { min: 0, max: 1, idle: 1000, acquire: 15000 } });
  let journal, locked = false;
  try {
    await sql.query('SET SESSION lock_wait_timeout=10'); await sql.query('SET SESSION innodb_lock_wait_timeout=5');
    if (mode !== 'apply') {
      if (!options['--private-output']) fail('CLINICAL_SCHEMA_PRIVATE_OUTPUT_REQUIRED');
      await sql.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      let state; try { state = await capture(sql); } finally { await sql.query('ROLLBACK'); }
      if (mode === 'prepare') assertUnapplied(state);
      if (mode === 'verify') {
        const plan = privateJson(options['--plan']); validatePlan(plan, info, null, { fresh: false }); verifyAfter(plan.before, state);
      }
      const output = { version: VERSION, target: 'dev', status: mode === 'verify' ? 'verified' : mode === 'prepare' ? 'prepared' : 'inspected',
        source_commit: info.commit, dirty_source: info.dirty, migrations: info.migrations, generated_at: new Date().toISOString(), before: state,
        patient_rows_read: false, business_dml_executed: false, metadata_only: true };
      writePrivateJson(options['--private-output'], output);
      return { status: output.status, target: 'dev', database: state.database_name, fictional_anchor_verified: true, source_commit: info.commit,
        dirty_source: info.dirty, plan_sha256: hash(output), migrations: info.migrations, metadata_only: true };
    }
    if (!options['--plan'] || !options['--backup-manifest'] || !options['--private-journal']) fail('CLINICAL_SCHEMA_APPROVED_PLAN_BACKUP_JOURNAL_REQUIRED');
    const plan = privateJson(options['--plan']), backup = privateJson(options['--backup-manifest']);
    validatePlan(plan, info);
    if (options['--approved-plan-sha256'] !== hash(plan)) fail('CLINICAL_SCHEMA_APPROVED_PLAN_HASH_REQUIRED');
    validateBackupManifest(backup, plan); await validateBackup(options['--backup-manifest']); assertStopped();
    if (fs.existsSync(options['--private-journal'])) fail('CLINICAL_SCHEMA_NEW_JOURNAL_REQUIRED');
    const [[lock]] = await sql.query("SELECT GET_LOCK('clinicaclick_dev_schema_release',0) AS acquired");
    if (Number(lock.acquired) !== 1) fail('CLINICAL_SCHEMA_OTHER_OPERATOR_ACTIVE'); locked = true;
    const before = await capture(sql); validatePlan(plan, info, before);
    journal = newJournal(options['--private-journal'], hash(plan));
    await journal.append({ phase: 'before_ddl', target: 'dev', source_commit: info.commit, migrations: info.migrations, before_sha256: hash(before), backup_manifest_sha256: hash(backup) });
    const qi = sql.getQueryInterface();
    for (const { name, sha256 } of info.migrations) {
      if (!MIGRATIONS.includes(name) || hash(fs.readFileSync(path.join(ROOT, 'migrations', name))) !== sha256) fail('CLINICAL_SCHEMA_MIGRATION_BYTES_CHANGED');
      await require(path.join(ROOT, 'migrations', name)).up(qi, Sequelize);
      await journal.append({ phase: 'ddl_completed', migration: name, migration_sha256: sha256 });
    }
    verifyAfter(before, await capture(sql), false);
    for (const name of MIGRATIONS) await sql.query('INSERT INTO SequelizeMeta(name) VALUES (:name)', { replacements: { name } });
    const after = await capture(sql); verifyAfter(before, after);
    await journal.append({ phase: 'verified', metadata_sha256: hash(after), patient_rows_read: false, business_dml_executed: false,
      process_restarted: false, configuration_changed: false });
    return { status: 'applied_verified', target: 'dev', source_commit: info.commit, migrations: info.migrations, metadata_only: true };
  } catch (error) {
    if (journal) await journal.append({ phase: 'failed_preserve_additive_schema', instruction: 'Keep DEV stopped, inspect private journal/schema; no down, blind retry or global restore over later writes.' });
    throw error;
  } finally {
    try { if (locked) await sql.query("SELECT RELEASE_LOCK('clinicaclick_dev_schema_release')"); }
    finally { try { journal?.close(); } finally { await sql.close(); } }
  }
}
if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(/^CLINICAL_SCHEMA_[A-Z_]+$/.test(error.message) ? error.message : 'CLINICAL_SCHEMA_FAILED_INSPECT_PRIVATE_EVIDENCE'); process.exitCode = 1;
});
module.exports = { VERSION, MIGRATIONS, PARENTS, NEW_TABLES, source, assertIdentity, capture, assertUnapplied, verifySchema, verifyAfter,
  assertStopped, validatePlan, validateBackupManifest, run };

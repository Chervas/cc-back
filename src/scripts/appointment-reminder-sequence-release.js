#!/usr/bin/env node
'use strict';

// Explicit operator only. Schema and live operational flag are separate
// actions; no app model bootstrap, patient/appointment/message DML or replay.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson, syncDirectory } = require('../lib/cliniccloud-import/io');
const { databaseOptions, connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { privateJson } = require('./cliniccloud-import-appointments-apply');
const { newJournal } = require('./program-commercial-schema-release');
const operations = require('../lib/whatsappImportedAppointmentOperations');
const ROOT = '/home/ubuntu/wt/back-dev';
const VERSION = 'appointment-reminder-sequence-release/1';
const NAME = '20261014120000-create-appointment-reminder-sequences.js';
const TABLE = 'AppointmentReminderSequences';
const MIGRATION_SHA256 = '0c55c8509cfe87984aa8f7704fd287658f1c18cb5c4530ef590ebb6d0b059dc5';
const PARENTS = { Clinicas: 'id_clinica', Pacientes: 'id_paciente', CitasPacientes: 'id_cita', Messages: 'id' };
const TABLES = [...Object.keys(PARENTS), 'SequelizeMeta', TABLE];
const FIELDS = {
  id: ['varchar(36)', false], clinic_id: ['int', false], patient_id: ['int', false], local_date: ['date', false],
  time_zone: ['varchar(64)', false], anchor_appointment_id: ['int', false], arrival_at: ['datetime(3)', false],
  claims: ['json', false], response_message_id: ['int', true], response_received_at: ['datetime(3)', true],
  attendance_confirmed_at: ['datetime(3)', true], created_at: ['datetime(3)', false], updated_at: ['datetime(3)', false],
};
const FOREIGN = { clinic_id: ['Clinicas', 'id_clinica'], patient_id: ['Pacientes', 'id_paciente'],
  anchor_appointment_id: ['CitasPacientes', 'id_cita'], response_message_id: ['Messages', 'id'] };
const fail = suffix => { throw Error('REMINDER_RELEASE_' + suffix); };
const equal = (a, b) => hash(a) === hash(b);
const normalizedType = value => String(value).toLowerCase().replace(/^int\(11\)$/, 'int');

function source() {
  if (process.cwd() !== ROOT || path.resolve(__dirname, '../..') !== ROOT
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev'
    || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) fail('COMMITTED_CANONICAL_DEV_REQUIRED');
  const files = ['migrations/' + NAME, 'models/appointmentremindersequence.js',
    'src/lib/appointment-reminder-sequence.js', 'src/services/appointmentReminderSequence.service.js',
    'src/services/appointmentAutomationV2Runtime.service.js', 'src/lib/whatsappImportedAppointmentOperations.js',
    'src/lib/whatsappAppointmentEligibility.js', 'src/services/whatsapp.service.js',
    'src/services/consentimientos.service.js', 'src/services/marketingBulkSends.service.js',
    'src/services/marketingEmailDispatch.service.js', 'src/services/emailDelivery.service.js',
    'src/services/emailProvider.service.js', 'src/scripts/appointment-reminder-sequence-release.js'];
  const pins = Object.fromEntries(files.map(file => [file, hash(readBytes(path.join(ROOT, file)))]));
  if (pins['migrations/' + NAME] !== MIGRATION_SHA256) fail('REVIEWED_MIGRATION_CHANGED');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('SOURCE_INVALID');
  return { commit, pins };
}

async function capture(connection, configuration) {
  const q = async (sql, values = []) => (await connection.query(sql, values))[0];
  const [identity] = await q('SELECT DATABASE() AS database_name,CURRENT_USER() AS database_user,@@hostname AS server_name,@@collation_database AS database_collation');
  if (identity?.database_name !== configuration.database || !/^utf8mb4_[a-zA-Z0-9_]+$/.test(identity.database_collation)) fail('DATABASE_IDENTITY_OR_COLLATION_INVALID');
  const tables = await q('SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME', [TABLES]);
  const columns = await q('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,COLLATION_NAME,GENERATION_EXPRESSION,ORDINAL_POSITION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,ORDINAL_POSITION', [TABLES]);
  const indexes = await q('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX', [TABLES]);
  const foreignKeys = await q(`SELECT k.TABLE_NAME,k.COLUMN_NAME,k.CONSTRAINT_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE
    FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME IN (?) ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION`, [TABLES]);
  const triggers = await q('SELECT EVENT_OBJECT_TABLE,TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (?) ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME', [TABLES]);
  const metadata = await q('SELECT name FROM SequelizeMeta ORDER BY name');
  return { database_name: identity.database_name, database_collation: identity.database_collation, identity_sha256: hash(identity),
    tables, columns, indexes, foreignKeys, triggers, metadata_names: metadata.map(row => row.name).sort() };
}
function assertParents(state) {
  for (const [table, key] of Object.entries(PARENTS)) {
    if (!state.tables.some(row => row.TABLE_NAME === table && row.ENGINE === 'InnoDB')
      || !state.columns.some(row => row.TABLE_NAME === table && row.COLUMN_NAME === key
        && normalizedType(row.COLUMN_TYPE) === 'int' && row.IS_NULLABLE === 'NO')) fail('PARENT_INTEGER_INNODB_REQUIRED');
  }
  if (!state.tables.some(row => row.TABLE_NAME === 'SequelizeMeta' && row.ENGINE === 'InnoDB')
    || state.triggers.some(row => ['SequelizeMeta', TABLE].includes(row.EVENT_OBJECT_TABLE))) fail('METADATA_OR_LEDGER_TRIGGERS_UNEXPECTED');
}
function assertUnapplied(state) {
  assertParents(state);
  if (state.metadata_names.includes(NAME) || state.tables.some(row => row.TABLE_NAME === TABLE)
    || state.columns.some(row => row.TABLE_NAME === TABLE)) fail('EXISTING_OR_PARTIAL_DDL_REQUIRES_REVIEW');
}
function verifySchema(state, { registered = true } = {}) {
  assertParents(state);
  const table = state.tables.find(row => row.TABLE_NAME === TABLE);
  if (!table || table.ENGINE !== 'InnoDB' || table.TABLE_COLLATION !== state.database_collation) fail('LEDGER_TABLE_INVALID');
  const columns = state.columns.filter(row => row.TABLE_NAME === TABLE);
  if (!equal(columns.map(row => row.COLUMN_NAME), Object.keys(FIELDS)) || Object.entries(FIELDS).some(([name, [type, nullable]]) => {
    const column = columns.find(row => row.COLUMN_NAME === name);
    return !column || normalizedType(column.COLUMN_TYPE) !== type || column.IS_NULLABLE !== (nullable ? 'YES' : 'NO')
      || column.COLUMN_DEFAULT !== null || column.EXTRA || column.GENERATION_EXPRESSION
      || type.startsWith('varchar') && column.COLLATION_NAME !== table.TABLE_COLLATION;
  })) fail('LEDGER_COLUMNS_INVALID');
  const indexGroups = new Map();
  for (const index of state.indexes.filter(row => row.TABLE_NAME === TABLE)) {
    if (index.SUB_PART != null || index.INDEX_TYPE !== 'BTREE') fail('LEDGER_INDEX_INVALID');
    const rows = indexGroups.get(index.INDEX_NAME) || []; rows.push(index); indexGroups.set(index.INDEX_NAME, rows);
  }
  const named = (name, fields) => {
    const rows = indexGroups.get(name);
    return !!rows && equal(rows.map(row => row.COLUMN_NAME), fields) && rows.every(row => Number(row.NON_UNIQUE) === 0);
  };
  if (!named('PRIMARY', ['id']) || !named('ars_patient_clinic_day', ['patient_id', 'clinic_id', 'local_date'])) fail('UNIQUE_PATIENT_CLINIC_DAY_REQUIRED');
  for (const [name, rows] of indexGroups) {
    if (['PRIMARY', 'ars_patient_clinic_day'].includes(name)) continue;
    if (rows.length !== 1 || !Object.hasOwn(FOREIGN, rows[0].COLUMN_NAME) || Number(rows[0].NON_UNIQUE) !== 1) fail('LEDGER_EXTRA_INDEX_REQUIRES_REVIEW');
  }
  const fks = state.foreignKeys.filter(row => row.TABLE_NAME === TABLE);
  if (fks.length !== Object.keys(FOREIGN).length || Object.entries(FOREIGN).some(([column, [table, key]]) => !fks.some(row =>
    row.COLUMN_NAME === column && row.REFERENCED_TABLE_NAME === table && row.REFERENCED_COLUMN_NAME === key
    && row.UPDATE_RULE === 'RESTRICT' && row.DELETE_RULE === 'RESTRICT'))) fail('LEDGER_FOREIGN_KEY_RESTRICTIONS_INVALID');
  if (state.metadata_names.includes(NAME) !== registered) fail('MIGRATION_REGISTRATION_INVALID');
}
function protectedState(state) {
  return { ...state, tables: state.tables.filter(row => row.TABLE_NAME !== TABLE),
    columns: state.columns.filter(row => row.TABLE_NAME !== TABLE), indexes: state.indexes.filter(row => row.TABLE_NAME !== TABLE),
    foreignKeys: state.foreignKeys.filter(row => row.TABLE_NAME !== TABLE),
    metadata_names: state.metadata_names.filter(name => name !== NAME) };
}
function verifyAfter(before, after, { registered = true } = {}) {
  verifySchema(after, { registered });
  if (!equal(protectedState(before), protectedState(after))) fail('UNRELATED_SCHEMA_OR_METADATA_CHANGED');
}
function validatePlan(plan, info, target, configuration, { now = Date.now() } = {}) {
  if (plan?.version !== VERSION || plan.target !== target || !['schema', 'same-day'].includes(plan.action)
    || plan.action === 'same-day' && target !== 'crm' || plan.migration !== NAME || !equal(plan.source, info)
    || plan.configuration_sha256 !== hash(configuration) || plan.before?.database_name !== configuration.database
    || !Number.isFinite(Date.parse(plan.generated_at)) || Date.parse(plan.generated_at) > now
    || now - Date.parse(plan.generated_at) > 7200000) fail('PLAN_INVALID_OR_EXPIRED');
  if (plan.action === 'schema') assertUnapplied(plan.before); else {
    verifySchema(plan.before); operations.validate(plan.policy_before.policy, { now });
    if (plan.policy_before.policy.sameDayAllowed !== false || plan.policy_before.file !== operations.FILE) fail('POLICY_SCOPE_OR_EXISTING_FLAG_INVALID');
  }
}
function validateRuntimeReady(proof, info, { now = Date.now() } = {}) {
  const flags = ['schema_compatible', 'runtime_restarted', 'protected_gates_verified', 'no_manual_replay'];
  if (proof?.version !== 'appointment-reminder-runtime-ready/1' || proof.target !== 'crm' || proof.source_commit !== info.commit
    || !Number.isFinite(Date.parse(proof.verified_at)) || Date.parse(proof.verified_at) > now
    || now - Date.parse(proof.verified_at) > 7200000 || flags.some(flag => proof.checks?.[flag] !== true)) fail('VERIFIED_DEPLOYED_RUNTIME_PROOF_REQUIRED');
}
function readPolicy() {
  const file = operations.FILE, stat = fs.lstatSync(file);
  if (fs.realpathSync(file) !== file || !stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077
    || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.size > 65536) fail('PRIVATE_POLICY_FILE_INVALID');
  const bytes = readBytes(file), policy = JSON.parse(bytes.toString('utf8'));
  operations.validate(policy);
  return { file, bytes_base64: bytes.toString('base64'), file_sha256: hash(bytes), policy,
    uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777, inode: stat.ino };
}
function enablePolicy(before) {
  const current = readPolicy();
  if (!equal(current, before)) fail('POLICY_CHANGED_BEFORE_ATOMIC_RENAME');
  const after = { ...current.policy, sameDayAllowed: true };
  operations.validate(after);
  const bytes = Buffer.from(JSON.stringify(after, null, 2) + '\n'), temporary = before.file + '.operator-' + randomUUID();
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, before.mode);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, before.mode); fs.fchownSync(fd, before.uid, before.gid); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  // No await between the final byte/inode comparison and atomic replacement.
  if (!equal(readPolicy(), before)) fail('POLICY_CHANGED_BEFORE_ATOMIC_RENAME');
  fs.renameSync(temporary, before.file); syncDirectory(path.dirname(before.file));
  const verified = readPolicy();
  if (verified.file_sha256 !== hash(bytes) || !equal(verified.policy, after)
    || !equal({ ...verified.policy, sameDayAllowed: false }, before.policy)) fail('POLICY_VERIFICATION_FAILED_PRESERVE_BACKUP');
  return verified;
}
function boundedQueryInterface(connection, Sequelize, collation) {
  let created = false, indexed = false;
  return {
    createTable: async (table, attributes) => {
      if (created || table !== TABLE || !equal(Object.keys(attributes), Object.keys(FIELDS))) fail('UNEXPECTED_DDL');
      for (const [field, [type, nullable]] of Object.entries(FIELDS)) {
        const spec = attributes[field], datatype = spec?.type;
        const actual = datatype?.key === 'INTEGER' && !datatype.options?.unsigned ? 'int'
          : datatype?.key === 'STRING' ? `varchar(${datatype.options?.length})`
            : datatype?.key === 'DATE' ? `datetime(${datatype.options?.length})`
              : datatype?.key === 'DATEONLY' ? 'date' : datatype?.key === 'JSON' ? 'json' : null;
        if (actual !== type || spec.allowNull !== nullable) fail('UNEXPECTED_DDL');
        const reference = FOREIGN[field];
        if (reference && (!equal(spec.references, { model: reference[0], key: reference[1] })
          || spec.onDelete !== 'RESTRICT' || spec.onUpdate !== 'RESTRICT')) fail('UNEXPECTED_DDL');
        const keys = ['allowNull', 'type', ...(field === 'id' ? ['primaryKey'] : []), ...(reference ? ['references', 'onDelete', 'onUpdate'] : [])];
        if (!equal(Object.keys(spec).sort(), keys.sort()) || field === 'id' && spec.primaryKey !== true) fail('UNEXPECTED_DDL');
      }
      if (!/^utf8mb4_[a-zA-Z0-9_]+$/.test(collation)) fail('COLLATION_INVALID');
      // Atomic full table definition, including its unique identity. The
      // migration's subsequent addIndex call verifies this same reviewed key.
      const columns = Object.entries(FIELDS).map(([field, [type, nullable]]) => `\`${field}\` ${type.toUpperCase()} ${nullable ? 'NULL' : 'NOT NULL'}`);
      const foreign = Object.entries(FOREIGN).map(([field, [table, key]]) => `FOREIGN KEY (\`${field}\`) REFERENCES \`${table}\` (\`${key}\`) ON DELETE RESTRICT ON UPDATE RESTRICT`);
      await connection.query(`CREATE TABLE \`${TABLE}\` (${[...columns, 'PRIMARY KEY (`id`)',
        'UNIQUE KEY `ars_patient_clinic_day` (`patient_id`,`clinic_id`,`local_date`)', ...foreign].join(',')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${collation}`);
      created = true;
    },
    addIndex: async (table, fields, options) => {
      if (!created || indexed || table !== TABLE || !equal(fields, ['patient_id', 'clinic_id', 'local_date'])
        || !equal(options, { name: 'ars_patient_clinic_day', unique: true })) fail('UNEXPECTED_DDL');
      indexed = true;
    },
  };
}
async function applyPlan({ connection, plan, info, target, configuration, journal, backupPath, runtimeProof,
  captureState = capture, saveBackup = writePrivateJson, loadPolicy = readPolicy, writePolicy = enablePolicy,
  loadMigration = () => require(path.join(ROOT, 'migrations', NAME)), migrationInterfaceFactory = boundedQueryInterface }) {
  validatePlan(plan, info, target, configuration);
  if (plan.action === 'same-day') validateRuntimeReady(runtimeProof, info);
  const lockKey = 'cc-appointment-reminder-release:' + target;
  const [[lock]] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [lockKey]);
  if (Number(lock.acquired) !== 1) fail('ANOTHER_OPERATOR_ACTIVE');
  let transaction = false;
  try {
    const current = await captureState(connection, configuration);
    if (!equal(current, plan.before)) fail('SCHEMA_PLAN_DRIFT');
    const policy = plan.action === 'same-day' ? loadPolicy() : null;
    if (policy && !equal(policy, plan.policy_before)) fail('POLICY_PLAN_DRIFT');
    const backup = { version: VERSION + ':backup', plan_sha256: hash(plan), target, action: plan.action,
      source: info, generated_at: new Date().toISOString(), before: current, policy_before: policy };
    saveBackup(backupPath, backup);
    await journal.append({ phase: 'backup_durable_before_mutation', backup_sha256: hash(backup), backup_path: backupPath });
    if (plan.action === 'schema') {
      await journal.append({ phase: 'before_reviewed_additive_ddl', migration: NAME, migration_sha256: MIGRATION_SHA256 });
      const Sequelize = require('sequelize');
      await loadMigration().up(migrationInterfaceFactory(connection, Sequelize, current.database_collation), Sequelize);
      verifyAfter(current, await captureState(connection, configuration), { registered: false });
      await journal.append({ phase: 'ddl_verified_before_metadata_commit' });
      await connection.beginTransaction(); transaction = true;
      const [insert] = await connection.query('INSERT INTO SequelizeMeta(name) VALUES (?)', [NAME]);
      if (Number(insert.affectedRows) !== 1) fail('METADATA_WRITE_UNEXPECTED');
      verifyAfter(current, await captureState(connection, configuration));
      await journal.append({ phase: 'metadata_verified_before_commit' });
      await connection.commit(); transaction = false;
      verifyAfter(current, await captureState(connection, configuration));
    } else {
      await journal.append({ phase: 'before_same_day_flag_only', original_policy_sha256: policy.file_sha256,
        expected_policy_sha256: hash(Buffer.from(JSON.stringify({ ...policy.policy, sameDayAllowed: true }, null, 2) + '\n')),
        runtime_ready_sha256: hash(runtimeProof) });
      const after = writePolicy(policy);
      if (!equal(after.policy, { ...policy.policy, sameDayAllowed: true })) fail('POLICY_VERIFICATION_FAILED_PRESERVE_BACKUP');
      if (!equal(await captureState(connection, configuration), current)) fail('SCHEMA_CHANGED_DURING_POLICY_WRITE');
    }
    await journal.append({ phase: 'verified', target, action: plan.action, no_business_dml: true,
      patient_hold_unchanged: true, no_replay_or_dispatch: true, protected_approved_at_unchanged: true });
    return { status: 'applied_verified', target, action: plan.action, migration: NAME,
      business_data_written: false, patient_hold_unchanged: true, automations_dispatched: 0 };
  } catch (error) {
    if (transaction) await connection.rollback();
    await journal.append({ phase: 'failed_preserve_additive_schema_and_backups',
      instruction: 'Inspect schema/policy/journal. No automatic down, delete, global restore, replay or blind retry.' });
    throw error;
  } finally { await connection.query('SELECT RELEASE_LOCK(?)', [lockKey]); }
}

async function run(args) {
  const options = parseArgs(args, ['--mode', '--target', '--action', '--private-output', '--plan',
    '--approved-plan-sha256', '--private-journal', '--private-backup', '--runtime-ready-proof']);
  const mode = options['--mode'], target = options['--target'], action = options['--action'];
  if (!['prepare', 'apply', 'check'].includes(mode) || !['dev', 'crm'].includes(target)
    || !['schema', 'same-day'].includes(action) || action === 'same-day' && target !== 'crm') fail('EXPLICIT_MODE_TARGET_ACTION_REQUIRED');
  const info = source(), configuration = databaseOptions(target), connection = await connectOperatorDatabase(target);
  let journal;
  try {
    await connection.query('SET SESSION lock_wait_timeout=10');
    if (mode !== 'apply') {
      if (!options['--private-output']) fail('PRIVATE_OUTPUT_REQUIRED');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      let state; try { state = await capture(connection, configuration); } finally { await connection.rollback(); }
      if (mode === 'check') {
        verifySchema(state);
        const policy = action === 'same-day' ? readPolicy() : null;
        if (policy && policy.policy.sameDayAllowed !== true) fail('SAME_DAY_FLAG_NOT_ENABLED');
        writePrivateJson(options['--private-output'], { status: 'compatible', target, action, source: info, state,
          policy_sha256: policy?.file_sha256 || null, patient_rows_read: false, no_business_dml: true });
        return { status: 'compatible', target, action, no_business_dml: true };
      }
      if (action === 'schema') assertUnapplied(state); else verifySchema(state);
      const plan = { version: VERSION, target, action, migration: NAME, source: info, configuration_sha256: hash(configuration),
        generated_at: new Date().toISOString(), before: state, policy_before: action === 'same-day' ? readPolicy() : null };
      validatePlan(plan, info, target, configuration); writePrivateJson(options['--private-output'], plan);
      return { status: 'prepared_no_changes', target, action, plan_sha256: hash(plan), migration: NAME };
    }
    if (!options['--plan'] || !options['--private-journal'] || !options['--private-backup']) fail('APPROVED_PLAN_BACKUP_JOURNAL_REQUIRED');
    const plan = privateJson(options['--plan']);
    if (plan.action !== action || hash(plan) !== options['--approved-plan-sha256']) fail('EXACT_APPROVED_PLAN_HASH_REQUIRED');
    const runtimeProof = action === 'same-day' ? privateJson(options['--runtime-ready-proof']) : null;
    validatePlan(plan, info, target, configuration);
    journal = newJournal(options['--private-journal'], hash(plan));
    return await applyPlan({ connection, plan, info, target, configuration, journal, backupPath: options['--private-backup'], runtimeProof });
  } finally { try { journal?.close(); } finally { await connection.end(); } }
}
module.exports = { VERSION, NAME, TABLE, MIGRATION_SHA256, FIELDS, FOREIGN, PARENTS, source, capture,
  assertParents, assertUnapplied, verifySchema, protectedState, verifyAfter, validatePlan, validateRuntimeReady,
  readPolicy, enablePolicy, boundedQueryInterface, applyPlan, run };
if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(/^REMINDER_RELEASE_[A-Z_]+$/.test(error.message) ? error.message : 'REMINDER_RELEASE_FAILED_INSPECT_PRIVATE_JOURNAL');
  process.exitCode = 1;
});

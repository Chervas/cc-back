#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { readBytes, writePrivateJson, parseArgs, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const { COLUMNS, VERSION, candidates, validateCurrent, packageHash, validatePackage } = require('../lib/cliniccloud-import/contacts-apply');
const fail = code => { throw new Error(code); };
function privateFile(filename) {
  const real = fs.realpathSync(filename);
  const stat = fs.statSync(real);
  if (!real.startsWith(`${fs.realpathSync(PRIVATE_ROOT)}/`) || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('PRIVATE_INPUT_REQUIRED');
  return real;
}
const readPrivate = filename => JSON.parse(readBytes(privateFile(filename)));
async function digest(filename) { const sha = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(filename)) sha.update(chunk); return sha.digest('hex'); }
async function validateBackup(filename) {
  const manifest = readPrivate(filename);
  const generated = Date.parse(manifest.generated_at);
  if (!Number.isFinite(generated) || generated > Date.now() || Date.now() - generated > 12 * 60 * 60 * 1000 || manifest.backup?.file !== 'database-before.sql.gz') fail('FRESH_COMPLETE_BACKUP_REQUIRED');
  const backup = privateFile(path.join(path.dirname(filename), manifest.backup.file));
  if (fs.statSync(backup).size !== manifest.backup.bytes || await digest(backup) !== manifest.backup.sha256) fail('BACKUP_HASH_MISMATCH');
  return { manifest_sha256: hash(manifest), backup_sha256: manifest.backup.sha256, generated_at: manifest.generated_at };
}
async function patientState(connection, id, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const [patients] = await connection.query(`SELECT * FROM Pacientes WHERE id_paciente = ?${suffix}`, [id]);
  const [links] = await connection.query(`SELECT id, paciente_id, clinica_id, field_key, source, source_column, value FROM PatientCustomFields WHERE paciente_id = ? AND clinica_id IN (66,72) AND source = 'cliniccloud' ORDER BY id${suffix}`, [id]);
  return { row: patients[0], links };
}
async function uniqueIdentities(connection, operations) {
  const [rows] = await connection.query("SELECT paciente_id, field_key, source, source_column, value FROM PatientCustomFields WHERE clinica_id IN (66,72) AND source = 'cliniccloud' AND (source_column IN ('idContacto','contacto_1.csv') OR field_key = 'cliniccloud_source_contact_id')");
  const { sourceIds } = require('../lib/cliniccloud-import/contacts-apply');
  const wanted = new Set(operations.map(op => String(op.source_contact_id)));
  const matches = new Map();
  for (const row of rows) for (const id of sourceIds([row])) if (wanted.has(id)) { if (!matches.has(id)) matches.set(id, new Set()); matches.get(id).add(Number(row.paciente_id)); }
  for (const op of operations) if (matches.get(String(op.source_contact_id))?.size !== 1 || !matches.get(String(op.source_contact_id)).has(Number(op.patient_id))) fail('SOURCE_IDENTITY_NOT_UNIQUE');
}
async function scope(connection, groupId) {
  const [rows] = await connection.query('SELECT id_clinica, grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72)');
  if (rows.length !== 2 || !groupId || rows.some(row => Number(row.grupoClinicaId) !== Number(groupId))) fail('CLINIC_GROUP_DRIFT');
}
async function noTriggers(connection) {
  const [rows] = await connection.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'Pacientes'");
  if (rows.length) fail('PATIENT_TRIGGERS_REQUIRE_REVIEW');
}
function verifySources(files) {
  const known = { contacts: '/home/ubuntu/frontend_clinicaclick/temp/BACKUP_CONTACTOS_2026-09-05.csv', historic_contacts: '/home/ubuntu/secure-imports/clinic-real-20260722/review/backup_data/contacto_1.csv' };
  if (!Array.isArray(files) || files.length !== 2 || new Set(files.map(file => file.role)).size !== 2) fail('SOURCE_FILES_REQUIRED');
  for (const file of files) if (!known[file.role] || hash(readBytes(known[file.role])) !== file.sha256) fail('SOURCE_FILE_CHANGED');
}
async function applyPatches(connection, payload) {
  const after = [];
  for (const op of payload.operations) {
    const { row, links } = await patientState(connection, op.patient_id, true);
    validateCurrent(op, row, links);
    if (hash(row) !== op.before_sha256 || hash(links) !== op.identity_sha256) fail('PREPARED_ROW_OR_IDENTITY_DRIFT');
    const entries = Object.entries(op.fields_patch);
    const sql = `UPDATE Pacientes SET ${entries.map(([key]) => `\`${COLUMNS[key]}\` = ?`).join(', ')}, updatedAt = UTC_TIMESTAMP() WHERE id_paciente = ?`;
    const values = entries.map(([key, value]) => key === 'birth_date' ? `${value} 00:00:00` : value);
    const [result] = await connection.query(sql, [...values, op.patient_id]);
    if (result.affectedRows !== 1) fail('PATIENT_UPDATE_COUNT_INVALID');
    const current = await patientState(connection, op.patient_id);
    const expected = { ...row, ...Object.fromEntries(entries.map(([key], i) => [COLUMNS[key], values[i]])), updatedAt: current.row?.updatedAt };
    if (!current.row || hash(current.row) !== hash(expected) || hash(current.links) !== op.identity_sha256) fail('POST_WRITE_VERIFICATION_FAILED');
    after.push({ patient_id: op.patient_id, action_key: op.action_key, before_sha256: op.before_sha256, after: current.row, after_sha256: hash(current.row) });
  }
  return after;
}
async function run(args) {
  const options = parseArgs(args, ['--mode', '--plan', '--snapshot', '--package', '--approved-sha256', '--backup-manifest', '--private-output']);
  if (!['prepare', 'apply'].includes(options['--mode']) || !options['--private-output']) fail('MODE_AND_PRIVATE_OUTPUT_REQUIRED');
  if (path.resolve(__dirname, '../..') !== '/home/ubuntu/wt/back-dev' || process.cwd() !== '/home/ubuntu/wt/back-dev' || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev') fail('DEV_WORKTREE_REQUIRED');
  let payload;
  let backup;
  if (options['--mode'] === 'prepare') {
    const plan = readPrivate(options['--plan']); const snapshot = readPrivate(options['--snapshot']);
    payload = { version: VERSION, generated_at: new Date().toISOString(), source_account: plan.manifest.source_account, source_plan_sha256: plan.plan_sha256, source_snapshot_sha256: hash(snapshot), source_files: plan.manifest.files.filter(file => ['contacts', 'historic_contacts'].includes(file.role)), database_group_id: snapshot.database_group_id, automation_policy: 'hold', whatsapp_column_policy: 'ignored_no_consent_mutation', operations: candidates(plan, snapshot) };
    if (!payload.operations.length || payload.operations.length > 200) fail('BATCH_SIZE_INVALID');
  } else {
    payload = readPrivate(options['--package']); validatePackage(payload);
    if (options['--approved-sha256'] !== payload.package_sha256) fail('EXACT_PACKAGE_APPROVAL_REQUIRED');
    if (Date.now() - Date.parse(payload.generated_at) > 2 * 60 * 60 * 1000 || !Number.isFinite(Date.parse(payload.generated_at))) fail('PACKAGE_EXPIRED');
    backup = await validateBackup(options['--backup-manifest']);
  }
  verifySources(payload.source_files);
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  const connection = await require('mysql2/promise').createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, timezone: 'Z', dateStrings: true, multipleStatements: false, ...require('../lib/databaseTlsConfig').buildDatabaseTlsOptions(process.env) });
  let commitAttempted = false;
  let intentWritten = false;
  try {
    await connection.query('SET SESSION innodb_lock_wait_timeout = 5');
    if (options['--mode'] === 'prepare') {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      await scope(connection, payload.database_group_id); await noTriggers(connection); await uniqueIdentities(connection, payload.operations);
      for (const op of payload.operations) {
        const { row, links } = await patientState(connection, op.patient_id);
        validateCurrent(op, row, links); op.before = row; op.before_sha256 = hash(row); op.identity_rows = links; op.identity_sha256 = hash(links);
      }
      await connection.rollback(); payload.package_sha256 = packageHash(payload); validatePackage(payload); writePrivateJson(options['--private-output'], payload);
      return { mode: 'read_only_prepare', operations: payload.operations.length, package_sha256: payload.package_sha256, business_data_changed: false };
    }
    // Durable intent BEFORE any SQL writes. Reusing the output path fails closed.
    // A crash without a result requires manual reconciliation, never blind replay.
    writePrivateJson(options['--private-output'], { version: VERSION, status: 'intent_manual_review_if_no_result', created_at: new Date().toISOString(), package_sha256: payload.package_sha256, backup, operations: payload.operations }); intentWritten = true;
    await connection.beginTransaction(); await scope(connection, payload.database_group_id); await noTriggers(connection); await uniqueIdentities(connection, payload.operations);
    const after = await applyPatches(connection, payload);
    commitAttempted = true; await connection.commit();
    writePrivateJson(`${options['--private-output']}.result.json`, { status: 'committed', package_sha256: payload.package_sha256, completed_at: new Date().toISOString(), operations: after, automation_activated: false, consent_changed: false });
    return { mode: 'apply_existing_contact_patches', updated_patients: after.length, changed_fields: payload.operations.reduce((n, op) => n + Object.keys(op.fields_patch).length, 0), created_patients: 0, automation_activated: false, consent_changed: false, package_sha256: payload.package_sha256 };
  } catch (error) {
    try { await connection.rollback(); } catch { /* connection may be gone */ }
    if (intentWritten && !commitAttempted) writePrivateJson(`${options['--private-output']}.result.json`, { status: 'rolled_back', error_code: /^[A-Z_]+$/.test(error.message) ? error.message : 'CONTACT_PATCH_FAILED', package_sha256: payload.package_sha256 });
    if (commitAttempted) fail('COMMIT_RESULT_REQUIRES_PRIVATE_JOURNAL_REVIEW');
    throw error;
  } finally { await connection.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => { process.stderr.write(`${/^[A-Z_]+$/.test(error.message) ? error.message : 'CONTACT_IMPORT_STOPPED_REVIEW_PRIVATE_JOURNAL'}\n`); process.exitCode = 1; });
module.exports = { run, validateBackup, applyPatches };

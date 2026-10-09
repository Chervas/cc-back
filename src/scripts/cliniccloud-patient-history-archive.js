#!/usr/bin/env node
'use strict';

// Explicit operator target, private append-only evidence, bounded transactions.
// Never load application models/workers, infer identities, or invoke messaging.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { readCsv, readBytes, writePrivateJson, parseArgs } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { validateBackup } = require('./cliniccloud-import-contacts-apply');
const { storedBirthDateHold } = require('../lib/cliniccloud-import/reviewed-contact-resolutions');
const core = require('../lib/cliniccloud-import/patient-history-archive');

const BS_SCOPE = '(p.clinica_id IN (66,72) OR EXISTS (SELECT 1 FROM PacienteClinicas scope WHERE scope.paciente_id=p.id_paciente AND scope.clinica_id IN (66,72)))';
const LINK_COLUMNS = 'id,paciente_id,clinica_id,field_key,source,source_column,value';
const LINK_SCOPE = "source='cliniccloud' AND (source_column='idContacto' OR field_key='cliniccloud_source_contact_id')";
function privateInput(filename) {
  const real = fs.realpathSync(filename), stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || !real.startsWith('/home/ubuntu/secure-imports/')) throw Error('PRIVATE_INPUT_REQUIRED');
  return real;
}
function privateJson(filename) { return JSON.parse(readBytes(privateInput(filename))); }
function birthHold(fields) {
  for (const field of fields) {
    try { if (storedBirthDateHold(JSON.parse(field.value))) return true; } catch { throw Error('CANONICAL_DEMOGRAPHIC_HOLD_INVALID'); }
  }
  return false;
}
async function validateScope(connection) {
  const [clinics] = await connection.query('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica');
  assert(clinics.length === 2 && clinics.every(row => Number(row.grupoClinicaId) === 29), 'BS_GROUP_DRIFT');
  const [triggers] = await connection.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN ('Pacientes','PatientCustomFields')");
  assert.equal(triggers.length, 0, 'UNREVIEWED_IMPORT_TRIGGER');
}
async function capture(connection) {
  await validateScope(connection);
  const [patients] = await connection.query(`SELECT p.* FROM Pacientes p WHERE ${BS_SCOPE} ORDER BY p.id_paciente`);
  // Global owners: a source ID claimed outside BS must not become a second identity.
  const [sourceLinks] = await connection.query(`SELECT ${LINK_COLUMNS} FROM PatientCustomFields WHERE ${LINK_SCOPE} ORDER BY id`);
  const [memberships] = await connection.query(`SELECT m.* FROM PacienteClinicas m JOIN Pacientes p ON p.id_paciente=m.paciente_id WHERE ${BS_SCOPE} ORDER BY m.id`);
  const [existingArchives] = await connection.query(`SELECT f.* FROM PatientCustomFields f JOIN Pacientes p ON p.id_paciente=f.paciente_id WHERE ${BS_SCOPE} AND f.source='cliniccloud' AND f.field_key LIKE 'cliniccloud_history_contact_%' ORDER BY f.id`);
  const [snapshots] = await connection.query(`SELECT f.paciente_id,f.value FROM PatientCustomFields f JOIN Pacientes p ON p.id_paciente=f.paciente_id WHERE ${BS_SCOPE} AND f.source='cliniccloud' AND f.source_column='cliniccloud_contact_snapshot' ORDER BY f.id`);
  const birthDateHolds = [...new Set(snapshots.filter(field => birthHold([field])).map(field => Number(field.paciente_id)))];
  return { patients, sourceLinks, memberships, existingArchives, birthDateHolds };
}
async function uniqueOwners(connection, operations) {
  const ids = operations.map(item => String(item.source_contact_id));
  const [links] = await connection.query(`SELECT ${LINK_COLUMNS} FROM PatientCustomFields WHERE ${LINK_SCOPE} AND TRIM(value) IN (?) ORDER BY id FOR UPDATE`, [ids]);
  for (const item of operations) {
    const owned = links.filter(link => Number(link.value) === Number(item.source_contact_id));
    assert(owned.length && owned.every(link => Number(link.paciente_id) === Number(item.patient_id)), 'GLOBAL_SOURCE_IDENTITY_DRIFT');
  }
  return links;
}
async function patientState(connection, id, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const [patients] = await connection.query(`SELECT * FROM Pacientes WHERE id_paciente=?${suffix}`, [id]);
  const [memberships] = await connection.query(`SELECT * FROM PacienteClinicas WHERE paciente_id=? ORDER BY id${suffix}`, [id]);
  return { patient: patients[0], memberships };
}
async function applyBatch(connection, operations) {
  await validateScope(connection);
  const links = await uniqueOwners(connection, operations), verified = [];
  for (const item of operations) {
    const before = await patientState(connection, item.patient_id, true);
    assert(before.patient && hash(before.patient) === item.expected_patient_sha256, 'PATIENT_COMPARE_AND_SWAP_DRIFT');
    assert.equal(hash(before.memberships), item.expected_memberships_sha256, 'PATIENT_MEMBERSHIP_DRIFT');
    const [allPatientLinks] = await connection.query(`SELECT ${LINK_COLUMNS} FROM PatientCustomFields WHERE paciente_id=? AND ${LINK_SCOPE} ORDER BY id FOR UPDATE`, [item.patient_id]);
    assert.equal(hash(allPatientLinks), item.expected_identity_links_sha256, 'SOURCE_LINK_COMPARE_AND_SWAP_DRIFT');
    if (Object.keys(item.fields_patch).length) assert.equal(new Set(allPatientLinks.map(link => core.positiveId(link.value)).filter(Boolean)).size, 1, 'MULTIPLE_ALIASES_CANNOT_SUPPLY_NATIVE_FIELDS');
    assert(core.linkedClinicIds(before.patient, before.memberships).includes(item.clinic_id), 'ARCHIVE_CLINIC_LINK_DRIFT');
    const [archives] = await connection.query('SELECT * FROM PatientCustomFields WHERE paciente_id=? AND field_key=? ORDER BY id FOR UPDATE', [item.patient_id, item.field_key]);
    assert.equal(archives.length, item.archive_exists ? 1 : 0, 'IMMUTABLE_ARCHIVE_EXISTENCE_DRIFT');
    if (archives.length) assert(archives[0].value === item.value && Number(archives[0].clinica_id) === item.clinic_id && archives[0].source === 'cliniccloud', 'IMMUTABLE_ARCHIVE_VALUE_DRIFT');
    if (Object.hasOwn(item.fields_patch, 'fecha_nacimiento')) {
      const [holds] = await connection.query("SELECT value FROM PatientCustomFields WHERE paciente_id=? AND source='cliniccloud' AND source_column='cliniccloud_contact_snapshot' ORDER BY id FOR UPDATE", [item.patient_id]);
      assert(!birthHold(holds), 'CANONICAL_BIRTH_DATE_HOLD');
    }
    if (!archives.length) {
      const [inserted] = await connection.query(`INSERT INTO PatientCustomFields (paciente_id,clinica_id,field_key,label,value,value_type,source,source_column,last_imported_at,created_at,updated_at) VALUES (?,?,?,?,?,'json','cliniccloud',?,UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP())`,
        [item.patient_id, item.clinic_id, item.field_key, 'Ficha histórica original · ClinicCloud', item.value, JSON.parse(item.value).provenance.source_file_name]);
      assert.equal(inserted.affectedRows, 1, 'ARCHIVE_INSERT_COUNT_INVALID');
    }
    const patch = Object.fromEntries(Object.entries(item.fields_patch).map(([key, value]) => [key, key === 'fecha_nacimiento' ? `${value} 00:00:00` : value]));
    if (Object.keys(patch).length) {
      for (const [key] of Object.entries(patch)) assert(Object.hasOwn(core.NATIVE_FIELDS, key) && core.blank(before.patient[key]), 'NATIVE_FIELD_NOT_EMPTY_OR_ALLOWED');
      const [updated] = await connection.query(`UPDATE Pacientes SET ${Object.keys(patch).map(key => `\`${key}\`=?`).join(',')},updatedAt=UTC_TIMESTAMP() WHERE id_paciente=?`, [...Object.values(patch), item.patient_id]);
      assert.equal(updated.affectedRows, 1, 'PATIENT_UPDATE_COUNT_INVALID');
    }
    const after = await patientState(connection, item.patient_id);
    const expected = { ...before.patient, ...patch, updatedAt: after.patient.updatedAt };
    assert.equal(hash(after.patient), hash(expected), 'NON_ALLOWLIST_PATIENT_FIELD_CHANGED');
    assert.equal(hash(after.memberships), hash(before.memberships), 'MEMBERSHIP_CHANGED_BY_ARCHIVE');
    const [retained] = await connection.query('SELECT id,value,clinica_id,source,source_column FROM PatientCustomFields WHERE paciente_id=? AND field_key=?', [item.patient_id, item.field_key]);
    assert(retained.length === 1 && retained[0].value === item.value && retained[0].source === 'cliniccloud' && Number(retained[0].clinica_id) === item.clinic_id
      && retained[0].source_column === JSON.parse(item.value).provenance.source_file_name, 'ARCHIVE_POST_WRITE_VERIFICATION_FAILED');
    verified.push({ patient_id: item.patient_id, source_contact_id: item.source_contact_id, archive_id: retained[0].id,
      before_sha256: hash(before.patient), after_sha256: hash(after.patient), native_fields: Object.keys(patch), archive_inserted: !archives.length });
  }
  return verified;
}

async function run(args) {
  const options = parseArgs(args, ['--mode', '--target', '--contacts', '--private-directory', '--plan', '--approved-sha256', '--backup-manifest', '--today']);
  const mode = options['--mode'], target = options['--target'];
  if (!['prepare', 'rehearse', 'apply'].includes(mode) || !['dev', 'crm'].includes(target)) throw Error('EXPLICIT_MODE_AND_TARGET_REQUIRED');
  const root = fs.realpathSync(options['--private-directory']), stat = fs.lstatSync(root);
  if (!root.startsWith('/home/ubuntu/secure-imports/') || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('PRIVATE_DIRECTORY_REQUIRED');
  const contactsPath = privateInput(options['--contacts']);
  const match = /^BACKUP_CONTACTOS_(\d{4}-\d{2}-\d{2})\.csv$/.exec(path.basename(contactsPath));
  if (!match) throw Error('DATED_SOURCE_CONTACTS_REQUIRED');
  const source = readCsv(contactsPath, 'contacts', ['IDCONTACTO', 'NOMBRE', 'APELLIDOS']);
  const proof = { account: core.SOURCE_ACCOUNT, name: path.basename(contactsPath), date: match[1], sha256: source.file.sha256, rows: source.rows };
  let plan, backup, backupManifest;
  if (mode !== 'prepare') {
    plan = core.validatePlan(privateJson(options['--plan']));
    assert.equal(options['--approved-sha256'], plan.plan_sha256, 'EXACT_REVIEWED_PLAN_REQUIRED');
    assert.equal(plan.database_target, target, 'DATABASE_TARGET_DRIFT');
    assert.equal(plan.source_sha256, source.file.sha256, 'SOURCE_FILE_CHANGED');
    assert.equal(plan.source_file, proof.name, 'SOURCE_FILE_NAME_CHANGED');
    assert.equal(plan.source_date, proof.date, 'SOURCE_DATE_CHANGED');
    backupManifest = privateJson(options['--backup-manifest']);
    assert(backupManifest.database_target === target && backupManifest.full_gzip_verified === true && backupManifest.dump_completion_verified === true, 'VERIFIED_TARGET_BACKUP_REQUIRED');
    backup = await validateBackup(options['--backup-manifest']);
    if (mode === 'apply') {
      const rehearsal = privateJson(path.join(root, 'rehearse-result.json'));
      assert(rehearsal.rolled_back === true && rehearsal.plan_sha256 === plan.plan_sha256 && rehearsal.completed_operations === plan.operations.length, 'EXACT_ROLLBACK_REHEARSAL_REQUIRED');
    }
  }
  const c = await connectOperatorDatabase(target);
  let lastCommitAttempted = false, batchIndex = 0;
  try {
    await c.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    if (backupManifest) {
      const [[identity]] = await c.query('SELECT DATABASE() database_name,@@hostname server_name');
      assert(identity.database_name === backupManifest.database_name && identity.server_name === backupManifest.server_name, 'BACKUP_DATABASE_IDENTITY_MISMATCH');
    }
    if (mode === 'prepare') {
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const state = await capture(c);
      plan = core.buildArchivePlan({ source: proof, ...state, today: options['--today'] });
      const { plan_sha256, ...body } = plan;
      const scoped = { ...body, database_target: target };
      plan = { ...scoped, plan_sha256: hash(scoped) };
      core.validatePlan(plan);
      await c.rollback();
      writePrivateJson(path.join(root, 'prepared-patients-before.json'), state);
      writePrivateJson(path.join(root, 'archive-plan.json'), plan);
      return { mode, target, operations: plan.operations.length, holds: plan.holds.length, unchanged: plan.unchanged.length,
        native_fields: plan.operations.reduce((n, item) => n + Object.keys(item.fields_patch).length, 0), plan_sha256: plan.plan_sha256, database_writes: 0 };
    }
    const [lock] = await c.query('SELECT GET_LOCK(?,0) acquired', ['cc-new-patients:cliniccloud-5880']);
    assert.equal(Number(lock[0].acquired), 1, 'SOURCE_IMPORT_ALREADY_RUNNING');
    const verified = [];
    for (let offset = 0; offset < plan.operations.length; offset += 100) {
      core.validatePlan(plan);
      assert.equal(hash(readBytes(contactsPath)), plan.source_sha256, 'SOURCE_FILE_CHANGED');
      const operations = plan.operations.slice(offset, offset + 100);
      const stem = `${mode}-batch-${String(++batchIndex).padStart(4, '0')}`;
      writePrivateJson(path.join(root, `${stem}-intent.json`), { mode, target, plan_sha256: plan.plan_sha256, backup,
        status: 'intent_manual_review_required_if_no_result', operations });
      await c.beginTransaction();
      try {
        const after = await applyBatch(c, operations);
        if (mode === 'rehearse') {
          await c.rollback();
          for (const item of operations) {
            const actual = await patientState(c, item.patient_id);
            assert.equal(hash(actual.patient), item.expected_patient_sha256, 'REHEARSAL_PATIENT_ROLLBACK_FAILED');
            const [retained] = await c.query('SELECT id FROM PatientCustomFields WHERE paciente_id=? AND field_key=?', [item.patient_id, item.field_key]);
            assert.equal(retained.length, item.archive_exists ? 1 : 0, 'REHEARSAL_ARCHIVE_ROLLBACK_FAILED');
          }
        } else {
          // Durable post-write proof is persisted before attempting the commit.
          writePrivateJson(path.join(root, `${stem}-precommit.json`), { plan_sha256: plan.plan_sha256, verified: after });
          lastCommitAttempted = true;
          await c.commit();
        }
        writePrivateJson(path.join(root, `${stem}-result.json`), { status: mode === 'rehearse' ? 'rolled_back_verified' : 'committed', plan_sha256: plan.plan_sha256, verified: after });
        lastCommitAttempted = false;
        verified.push(...after);
        if (batchIndex % 10 === 0) process.stdout.write(JSON.stringify({ mode, completed_operations: verified.length, total: plan.operations.length }) + '\n');
      } catch (error) {
        try { await c.rollback(); } catch { /* original error and intent retained */ }
        if (lastCommitAttempted) throw Error('COMMIT_OUTCOME_REQUIRES_PRIVATE_RECONCILIATION_NO_REPLAY');
        writePrivateJson(path.join(root, `${stem}-failure.json`), { status: 'rolled_back', reason: /^[A-Z_]+$/.test(error.message) ? error.message : 'ARCHIVE_BATCH_FAILED' });
        throw error;
      }
    }
    const result = { mode, target, plan_sha256: plan.plan_sha256, completed_operations: verified.length, rolled_back: mode === 'rehearse',
      archive_insertions: verified.filter(item => item.archive_inserted).length, native_fields: verified.reduce((n, item) => n + item.native_fields.length, 0),
      clinical_forms_created: 0, appointments_changed: 0, consent_changes: 0, economic_changes: 0, messages_sent: 0, verified };
    writePrivateJson(path.join(root, `${mode}-result.json`), result);
    const { verified: privateEvidence, ...summary } = result;
    return summary;
  } finally { await c.end(); }
}

if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify({ status: 'stopped', reason: /^[A-Z_]+$/.test(error.message) ? error.message : 'ARCHIVE_FAILED_REVIEW_PRIVATE_EVIDENCE' }) + '\n');
  process.exitCode = 1;
});
module.exports = { run, capture, applyBatch, patientState, privateInput, birthHold, validateScope };

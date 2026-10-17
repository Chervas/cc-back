#!/usr/bin/env node
'use strict';

// Explicit operator only. No app/models/workers, patient mutation or delivery.
// Default plan is read-only. Dry-run takes real locks then rolls back. Apply
// needs the exact reviewed private plan hash and writes a durable before-image.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { connectOperatorDatabase, databaseOptions } = require('../lib/cliniccloud-import/operator-database');
const { parseArgs, writePrivateJson, readBytes, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const registration = require('../lib/registration-privacy-template');
const settings = require('../lib/registration-privacy-configuration');
const digital = require('../lib/bs-privacy-digital-template');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value))))).digest('hex');
const fail = code => { throw Error('REGISTRATION_PRIVACY_' + code); };
const VERSION = 'registration-privacy-settings-release/v1', CLINICS = [66, 72];
const LOCK = 'cc-registration-privacy-settings-release-v1';
const controller = Object.freeze({ legal_name: 'INSTITUTO OBES ALICANTE S.L.', tax_id: 'B54847090',
  address: 'C/ ARQUITECTO MORELL 9 BAJO 03003 ALICANTE', phone: '966283955', email: 'info@bsmedical.es',
  dpo_name: '', dpo_email: 'dpo@bsmedical.es' });
function privateInput(filename) {
  if (!path.isAbsolute(filename || '')) fail('PRIVATE_PLAN_REQUIRED');
  const actual = fs.realpathSync(filename), root = fs.realpathSync(PRIVATE_ROOT), stat = fs.lstatSync(filename);
  if (!actual.startsWith(root + path.sep) || actual !== filename || stat.isSymbolicLink() || !stat.isFile()
    || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077) fail('PRIVATE_PLAN_INVALID');
  return JSON.parse(readBytes(filename));
}
async function capture(connection, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const [identity] = await connection.query('SELECT DATABASE() AS database_name');
  const [clinics] = await connection.query('SELECT * FROM Clinicas WHERE id_clinica IN (?,?) ORDER BY id_clinica' + suffix, CLINICS);
  const [templates] = await connection.query("SELECT * FROM ClinicConsentTemplates WHERE clinic_id IN (?,?) AND catalog_key=? ORDER BY id" + suffix, [...CLINICS, settings.BS_KEY]);
  if (clinics.length !== 2 || templates.length !== 2 || CLINICS.some(id => templates.filter(row => Number(row.clinic_id) === id).length !== 1)) fail('EXACT_BS_SCOPE_REQUIRED');
  const [versions] = await connection.query('SELECT * FROM ClinicConsentTemplateVersions WHERE clinic_template_id IN (?,?) ORDER BY clinic_template_id,version DESC,id DESC LIMIT 203' + suffix, templates.map(row => row.id));
  if (versions.length > 202) fail('VERSION_LIMIT_EXCEEDED');
  return { database: identity[0].database_name, clinics, templates, versions };
}
function entries(before) {
  const body = registration.bsDraft();
  return CLINICS.map(id => {
    const clinic = before.clinics.find(row => Number(row.id_clinica) === id), template = before.templates.find(row => Number(row.clinic_id) === id);
    if (!clinic || template?.status !== 'active' || template.purpose !== 'data_protection' || !template.is_default || template.blocking_policy !== 'hard') fail('ACTIVE_APPROVED_TEMPLATE_REQUIRED');
    const versions = before.versions.filter(row => Number(row.clinic_template_id) === Number(template.id));
    const published = versions.find(row => row.status === 'published' && row.locale === 'es');
    const already = published && hash(settings.object(published.body_json)) === hash(body.body_json) && published.body_html === body.body_html;
    if (!already && !require('../lib/registration-privacy-paper').isApprovedPaperFamilyVersion(published)) fail('APPROVED_LEGAL_SOURCE_REQUIRED');
    const intake = { ...settings.object(settings.object(clinic.configuracion).patient_intake), privacy_enabled: true,
      privacy_before_first_care: true, privacy_template_id: Number(template.id), medical_questionnaire_enabled: false,
      additional_documents: [], privacy_controller: { ...controller } };
    const configuration = { ...settings.object(clinic.configuracion), patient_intake: intake };
    return { clinic_id: id, template_id: Number(template.id), configuration, create_version: !already,
      version: already ? Number(published.version) : Math.max(0, ...versions.map(row => Number(row.version))) + 1,
      body, expected_published_id: Number(published.id) };
  });
}
function makePlan(before, target, actorId) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail('ACTOR_REQUIRED');
  return { schema_version: VERSION, target, actor_id: actorId, before, before_sha256: hash(before),
    entries: entries(before), source_sha256: hash(registration.bsDraft()), policy: {
      clinics: CLINICS, additive_versions_only: true, signed_documents_unchanged: true, no_messages: true,
      import_holds_unchanged: true, old_sms_not_whatsapp: true, additional_documents_empty: true, medical_questionnaire_disabled: true } };
}
async function execute({ connection, plan, approvedHash, backupPath, dryRun = true, saveBackup = writePrivateJson }) {
  if (!plan || plan.schema_version !== VERSION || hash(plan) !== approvedHash || hash(registration.bsDraft()) !== plan.source_sha256
    || !['crm', 'dev'].includes(plan.target) || hash(plan.before) !== plan.before_sha256
    || hash(plan.entries) !== hash(entries(plan.before))) fail('EXACT_REVIEWED_PLAN_REQUIRED');
  const [[guard]] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [LOCK]);
  if (Number(guard.acquired) !== 1) fail('OPERATOR_BUSY');
  let transaction = false;
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.beginTransaction(); transaction = true;
    const before = await capture(connection, true);
    if (hash(before) !== plan.before_sha256) fail('PLAN_CHANGED_REPLAN_REQUIRED');
    const [actors] = await connection.query('SELECT id_usuario,estado_cuenta FROM Usuarios WHERE id_usuario=? FOR SHARE', [plan.actor_id]);
    if (actors.length !== 1 || actors[0].estado_cuenta !== 'activo' || !require('../lib/role-helpers').isGlobalAdmin(actors[0].id_usuario)) fail('CURRENT_GLOBAL_ADMIN_REQUIRED');
    // Backup is durable before any DML, including a rolled-back rehearsal.
    saveBackup(backupPath, { schema_version: VERSION + ':backup', plan_sha256: hash(plan), before,
      restoration: 'Manual reviewed compensation only. Never overwrite later settings or signed snapshots.' });
    const inserted = [];
    for (const entry of plan.entries) {
      if (entry.create_version) {
        const [result] = await connection.query("INSERT INTO ClinicConsentTemplateVersions (clinic_template_id,version,locale,title,body_json,body_html,variable_schema,status,published_at,created_by,createdAt,updatedAt) VALUES (?,?,'es',?,?,?,?,'published',UTC_TIMESTAMP(),?,UTC_TIMESTAMP(),UTC_TIMESTAMP())",
          [entry.template_id, entry.version, entry.body.title, JSON.stringify(entry.body.body_json), entry.body.body_html,
            JSON.stringify({ consent_form: entry.body.body_json.consent_form }), plan.actor_id]);
        if (result.affectedRows !== 1) fail('VERSION_INSERT_FAILED');
        inserted.push(Number(result.insertId));
      }
      const [updated] = await connection.query('UPDATE Clinicas SET configuracion=? WHERE id_clinica=?',
        [JSON.stringify(entry.configuration), entry.clinic_id]);
      if (updated.affectedRows !== 1) fail('CLINIC_UPDATE_FAILED');
    }
    const after = await capture(connection, true);
    if (before.versions.some(old => !after.versions.some(row => Number(row.id) === Number(old.id) && hash(row) === hash(old)))) fail('HISTORICAL_VERSION_CHANGED');
    if (hash(before.templates) !== hash(after.templates)) fail('TEMPLATE_HEADERS_CHANGED');
    if (dryRun) await connection.rollback(); else await connection.commit(); transaction = false;
    return { schema_version: VERSION + ':receipt', mode: dryRun ? 'rolled_back_dry_run' : 'applied',
      plan_sha256: hash(plan), created_versions: inserted.length, clinics: CLINICS, source_sha256: plan.source_sha256 };
  } catch (error) { if (transaction) await connection.rollback(); throw error; }
  finally { await connection.query('SELECT RELEASE_LOCK(?)', [LOCK]); }
}
async function main(args) {
  const options = parseArgs(args, ['--mode', '--target', '--actor-id', '--output', '--plan', '--approved-plan-sha256', '--backup']);
  const target = options['--target'], mode = options['--mode'] || 'plan';
  if (!['plan', 'dry-run', 'apply'].includes(mode)) fail('MODE_INVALID');
  const configuration = databaseOptions(target), connection = await connectOperatorDatabase(target);
  try {
    if (mode === 'plan') {
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const before = await capture(connection); await connection.rollback();
      if (before.database !== configuration.database) fail('DATABASE_CHANGED');
      const plan = makePlan(before, target, Number(options['--actor-id'])); writePrivateJson(options['--output'], plan);
      return { mode, plan_sha256: hash(plan), clinics: CLINICS, created_versions: plan.entries.filter(row => row.create_version).length };
    }
    const plan = privateInput(options['--plan']);
    if (plan.target !== target || plan.before.database !== configuration.database) fail('TARGET_CHANGED');
    return await execute({ connection, plan, approvedHash: options['--approved-plan-sha256'], backupPath: options['--backup'], dryRun: mode === 'dry-run' });
  } finally { await connection.end(); }
}
if (require.main === module) main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { hash, capture, entries, makePlan, execute };

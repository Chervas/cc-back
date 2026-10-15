#!/usr/bin/env node
'use strict';

// Explicit retirement of the reviewed BS catalogue and its old requirements.
// No runtime bypass, patient document/token/signature mutation or dispatch.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const legacy = require('./bs-consent-catalog-withdrawal');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { parseArgs, readBytes, writePrivateJson, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const { connectOperatorDatabase, databaseOptions } = require('../lib/cliniccloud-import/operator-database');
const { privateJson } = require('./cliniccloud-import-appointments-apply');
const { newJournal } = require('./program-commercial-schema-release');

const ROOT = '/home/ubuntu/wt/back-dev';
const VERSION = 'bs-consent-requirements-retirement/1';
const AUTHORITY_LITERAL = 'Retirar también los requisitos antiguos; sin exigencia automática de momento';
// Share the previous operator's advisory lock: the old header-only operator
// must not interleave with this newly authorized combined transaction.
const LOCK_KEY = legacy.LOCK_KEY;
const REQUIRED_COUNT = 104, TREATMENT_COUNT = 94;
const FIELDS = Object.freeze(['id', 'tratamiento_id', 'clinica_id', 'clinic_template_id', 'catalog_template_id',
  'requirement_scope', 'condition_key', 'required', 'blocking_policy', 'sort_order', 'createdAt', 'updatedAt']);
const PIN_FILES = Object.freeze([...new Set([...legacy.PIN_FILES, 'src/scripts/bs-consent-requirements-retirement.js',
  'src/scripts/tests/bs_consent_requirements_retirement.test.js', 'models/tratamiento.js', 'src/lib/databaseTlsConfig.js'])]);
const POLICY = Object.freeze({ archive_non_data_protection_headers: 81, retire_exact_reviewed_requirements: REQUIRED_COUNT,
  preserve_data_protection_headers: 5, preserve_intake_privacy_configuration: true, treatments_unchanged: true,
  patient_documents_unchanged: true, signatures_unchanged: true, issued_links_unchanged: true,
  versions_unchanged: true, global_catalog_unchanged: true, other_requirements_unchanged: true,
  no_runtime_bypass: true, no_dispatch: true, automatic_restore_over_later_edits: false });
const CAUTION = 'Removing these catalogue requirements does not bypass historical-treatment review or the separate extraction/PRP parent guard. No runtime exemption is introduced; patient evidence remains intact.';
const fail = code => { throw Error('BS_CONSENT_RETIRE_' + code); };
const equal = (a, b) => hash(a) === hash(b);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function source() {
  const info = legacy.source();
  for (const file of PIN_FILES) {
    const filename = path.join(ROOT, file), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== filename) fail('SOURCE_FILE_INVALID');
    const bytes = readBytes(filename), committed = execFileSync('git', ['show', `${info.commit}:${file}`], { maxBuffer: 32 * 1024 * 1024 });
    if (hash(bytes) !== hash(committed)) fail('SOURCE_FILE_NOT_COMMITTED');
    info.pins[file] = hash(bytes);
  }
  return info;
}

function validateAuthority(authority) {
  if (authority?.literal !== AUTHORITY_LITERAL || authority.decision_date !== '2026-10-15' || authority.timezone !== 'Europe/Madrid'
    || !equal(authority.scope?.clinic_ids, [66, 72]) || authority.scope.group_id !== 29
    || authority.scope.requirements !== REQUIRED_COUNT || authority.scope.non_data_protection_headers !== 81
    || !equal(authority.scope.preserved_data_protection_header_ids, legacy.DATA_PROTECTION_IDS)
    || !sha(authority.scope.audited_requirements_sha256)) fail('EXPLICIT_AUTHORITY_REQUIRED');
}

function treatmentIds(rows) { return [...new Set(rows.map(row => Number(row.tratamiento_id)))].sort((a, b) => a - b); }
function assertTreatmentIds(ids) {
  if (!Array.isArray(ids) || ids.length !== TREATMENT_COUNT || ids.some(id => !positive(id))
    || !equal(ids, [...new Set(ids)].sort((a, b) => a - b))) fail('EXACT_TREATMENT_ANCHORS_REQUIRED');
}

async function capture(connection, configuration, { lock = false, expectedTreatmentIds = null } = {}) {
  const query = async (sql, values = [], limit = 10000) => {
    const [rows] = await connection.query(sql, values);
    if (!Array.isArray(rows) || rows.length > limit) fail('BOUNDED_SCOPE_EXCEEDED');
    return rows;
  };
  let treatments;
  if (lock) {
    assertTreatmentIds(expectedTreatmentIds);
    // Same anchor/order as canonical requirement saving and clinical reading.
    // Acquire these before the legacy header/protected-requirement locks.
    treatments = await query('SELECT * FROM Tratamientos WHERE id_tratamiento IN (?) ORDER BY id_tratamiento LIMIT 95 FOR UPDATE', [expectedTreatmentIds], TREATMENT_COUNT);
  }
  const base = await legacy.capture(connection, configuration, { lock });
  const schema = await query("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='TreatmentConsentRequirements' ORDER BY ORDINAL_POSITION");
  const triggers = await query("SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='TreatmentConsentRequirements' ORDER BY TRIGGER_NAME");
  const incoming = await query("SELECT CONSTRAINT_NAME,TABLE_NAME,COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='TreatmentConsentRequirements' ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION");
  if (triggers.length || incoming.length || !equal(schema.map(row => row.COLUMN_NAME).sort(), [...FIELDS].sort())) fail('REQUIREMENT_SCHEMA_OR_SIDE_EFFECTS_CHANGED');
  const requirements = await query('SELECT * FROM TreatmentConsentRequirements WHERE clinica_id IN (66,72) OR clinic_template_id IN (?) ORDER BY id LIMIT 105' + (lock ? ' FOR UPDATE' : ''), [legacy.EXPECTED_IDS], REQUIRED_COUNT);
  if (!equal(base.protected.requirements, legacy.digest(requirements))) fail('REQUIREMENT_CAPTURE_INCONSISTENT');
  const ids = expectedTreatmentIds || treatmentIds(requirements);
  assertTreatmentIds(ids);
  if (!treatments) treatments = await query('SELECT * FROM Tratamientos WHERE id_tratamiento IN (?) ORDER BY id_tratamiento LIMIT 95', [ids], TREATMENT_COUNT);
  const otherRequirements = await query('SELECT * FROM TreatmentConsentRequirements WHERE (clinica_id IS NULL OR clinica_id NOT IN (66,72)) AND (clinic_template_id IS NULL OR clinic_template_id NOT IN (?)) ORDER BY id LIMIT 10001' + (lock ? ' LOCK IN SHARE MODE' : ''), [legacy.EXPECTED_IDS]);
  return { ...base, requirements, treatment_ids: ids, treatments,
    requirement_schema_sha256: hash({ schema, triggers, incoming }), other_requirements: legacy.digest(otherRequirements) };
}

function validateState(state) {
  legacy.validateState(state);
  assertTreatmentIds(state.treatment_ids);
  if (!Array.isArray(state.treatments) || !equal(state.treatments.map(row => Number(row.id_tratamiento)), state.treatment_ids)
    || !Array.isArray(state.requirements) || state.requirements.length > REQUIRED_COUNT
    || !sha(state.requirement_schema_sha256) || !sha(state.other_requirements?.sha256)
    || !Number.isSafeInteger(state.other_requirements.count) || state.other_requirements.count < 0
    || !equal(state.protected.requirements, legacy.digest(state.requirements))) fail('EXTRA_PROTECTED_STATE_INVALID');
  for (const row of state.requirements) {
    const template = state.templates.find(item => Number(item.id) === Number(row.clinic_template_id));
    const treatment = state.treatments.find(item => Number(item.id_tratamiento) === Number(row.tratamiento_id));
    if (!positive(row.id) || !equal(Object.keys(row).sort(), [...FIELDS].sort()) || !template || !treatment
      || ![66, 72].includes(Number(row.clinica_id)) || Number(row.clinica_id) !== Number(template.clinic_id)
      || Number(treatment.clinica_id) !== Number(row.clinica_id) || row.catalog_template_id !== null) fail('REQUIREMENT_SCOPE_CHANGED');
  }
  if (!equal(state.requirements.map(row => Number(row.id)), [...new Set(state.requirements.map(row => Number(row.id)))].sort((a, b) => a - b))) fail('REQUIREMENT_IDENTITIES_CHANGED');
}

function makePlan({ before, info, authority, generatedAt = new Date().toISOString() }) {
  validateState(before); validateAuthority(authority);
  if (before.requirements.length !== REQUIRED_COUNT || hash(before.requirements) !== authority.scope.audited_requirements_sha256
    || !equal(treatmentIds(before.requirements), before.treatment_ids) || !Number.isFinite(Date.parse(generatedAt))) fail('AUDITED_REQUIREMENTS_CHANGED');
  const categories = {};
  for (const row of before.requirements) {
    const template = before.templates.find(item => Number(item.id) === Number(row.clinic_template_id));
    const key = template.purpose + ':' + row.blocking_policy;
    categories[key] = (categories[key] || 0) + 1;
  }
  if (!equal(categories, { 'clinical:hard': 100, 'clinical:soft': 2, 'clinical_image:soft': 1, 'data_protection:hard': 1 })) fail('REVIEWED_REQUIREMENT_CATEGORIES_CHANGED');
  const privacy = before.requirements.filter(row => legacy.DATA_PROTECTION_IDS.includes(Number(row.clinic_template_id)));
  if (privacy.length !== 1 || Number(privacy[0].id) !== 2 || Number(privacy[0].tratamiento_id) !== 46
    || Number(privacy[0].clinic_template_id) !== 2 || Number(privacy[0].required) !== 1) fail('EXACT_LEGACY_QA_PRIVACY_LINK_REQUIRED');
  const body = { version: VERSION, target: 'crm', group_id: 29, clinic_ids: [66, 72], generated_at: generatedAt,
    source: info, authority, authority_sha256: hash(authority), before, before_sha256: hash(before),
    header_operations: legacy.operationsFor(before, false),
    requirement_operations: before.requirements.map(row => ({ id: Number(row.id), before_sha256: hash(row) })),
    categories, policy: POLICY, caution: CAUTION };
  if (body.header_operations.length !== 81 || before.templates.filter(row => row.purpose !== 'data_protection').length !== 81) fail('HEADER_SCOPE_CHANGED');
  return { ...body, plan_sha256: hash(body) };
}

function validatePlan(plan, info, authority, configuration, { now = Date.now(), requireFresh = true } = {}) {
  if (plan?.version !== VERSION || plan.target !== 'crm' || !equal(plan.source, info) || !equal(plan.authority, authority)
    || plan.before?.configuration_sha256 !== hash(configuration)
    || !equal(plan, makePlan({ before: plan.before, info, authority, generatedAt: plan.generated_at }))) fail('PLAN_TAMPERED_OR_SOURCE_CHANGED');
  const generated = Date.parse(plan.generated_at);
  if (!Number.isFinite(generated) || generated > now || requireFresh && now - generated > 7200000) fail('PLAN_EXPIRED');
}

function verifyAfter(plan, after, mutationAt) {
  validateState(after);
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(mutationAt || '')) fail('MUTATION_TIMESTAMP_INVALID');
  const retired = new Set(plan.requirement_operations.map(row => row.id));
  const remaining = plan.before.requirements.filter(row => !retired.has(Number(row.id)));
  const expected = { ...plan.before, templates: plan.before.templates.map(row => plan.header_operations.some(op => op.id === row.id)
    ? { ...row, status: 'archived', is_default: 0, updatedAt: mutationAt } : row), requirements: remaining,
    protected: { ...plan.before.protected, requirements: legacy.digest(remaining) } };
  if (!equal(expected, after)) fail('POST_WRITE_OR_PROTECTED_STATE_CHANGED');
  return true;
}

function privateDestination(filename) {
  if (!path.isAbsolute(filename || '')) fail('PRIVATE_ARTIFACT_REQUIRED');
  const root = fs.realpathSync(PRIVATE_ROOT), parent = fs.realpathSync(path.dirname(filename));
  if (parent !== root && !parent.startsWith(root + path.sep)) fail('PRIVATE_ARTIFACT_REQUIRED');
  for (const dir of [root, parent]) { const stat = fs.lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail('PRIVATE_PERMISSIONS_INVALID'); }
  return path.join(parent, path.basename(filename));
}
async function independentCapture(configuration, ids) {
  const c = await connectOperatorDatabase('crm');
  try { await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'); const state = await capture(c, configuration, { expectedTreatmentIds: ids }); await c.rollback(); return state; }
  finally { await c.end(); }
}

async function execute({ connection, plan, info, authority, configuration, dryRun = false, backupPath, journal,
  captureState = capture, readIndependent = independentCapture, checkSource = source, checkAuthority,
  saveBackup = writePrivateJson }) {
  validatePlan(plan, info, authority, configuration);
  if (typeof checkAuthority !== 'function') fail('FRESH_AUTHORITY_READER_REQUIRED');
  const [[lock]] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [LOCK_KEY]);
  if (Number(lock?.acquired) !== 1) fail('ANOTHER_RETIREMENT_ACTIVE');
  let inTransaction = false, commitAttempted = false;
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.beginTransaction(); inTransaction = true;
    const before = await captureState(connection, configuration, { lock: true, expectedTreatmentIds: plan.before.treatment_ids });
    validateState(before);
    if (!equal(before, plan.before)) {
      const at = before.templates.find(row => plan.header_operations.some(op => op.id === row.id))?.updatedAt;
      verifyAfter(plan, before, at);
      if (!equal(checkSource(), info) || !equal(checkAuthority(), authority)) fail('SOURCE_OR_AUTHORITY_CHANGED');
      await connection.rollback(); inTransaction = false;
      const current = await readIndependent(configuration, plan.before.treatment_ids);
      if (!equal(before, current)) fail('REPLAY_READBACK_CHANGED');
      await journal.append({ phase: 'exact_replay_preserved_no_dml', after_sha256: hash(current) });
      return { version: VERSION + ':receipt', status: 'replay_preserved', plan_sha256: plan.plan_sha256, source: info,
        mutation_at: at, after: current, after_sha256: hash(current), changed_headers: 0, retired_requirements: 0, policy: POLICY, caution: CAUTION };
    }
    const [[clock]] = await connection.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-%d %H:%i:%s') AS mutation_at");
    const mutationAt = clock?.mutation_at;
    if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(mutationAt || '')) fail('MUTATION_TIMESTAMP_INVALID');
    const backup = { version: VERSION + ':backup', target: 'crm', source: info, authority, plan_sha256: plan.plan_sha256,
      generated_at: new Date().toISOString(), mutation_at: mutationAt, before, before_sha256: hash(before),
      restoration_policy: 'Restore only retired requirement rows and changed header fields after exact after-image comparison. Never restore patient tables or overwrite later human edits.' };
    saveBackup(backupPath, backup);
    await journal.append({ phase: 'backup_durable_before_mutation', backup_path: backupPath, backup_sha256: hash(backup),
      headers: plan.header_operations.length, requirements: plan.requirement_operations.length });
    if (!equal(checkSource(), info) || !equal(checkAuthority(), authority)) fail('SOURCE_OR_AUTHORITY_CHANGED');
    const [[ownership]] = await connection.query('SELECT IS_USED_LOCK(?)=CONNECTION_ID() AS owned', [LOCK_KEY]);
    if (Number(ownership?.owned) !== 1) fail('EXECUTOR_LOCK_LOST');
    await journal.append({ phase: 'before_exact_header_and_requirement_cas', mutation_at: mutationAt,
      treatment_anchor_sha256: hash(before.treatments), policy: POLICY });
    for (const op of plan.header_operations) {
      const row = before.templates.find(item => Number(item.id) === op.id);
      if (!row || hash(row) !== op.before_sha256 || row.purpose === 'data_protection') fail('HEADER_CAS_INVALID');
      const [result] = await connection.query("UPDATE ClinicConsentTemplates SET status='archived',is_default=0,updatedAt=? WHERE id=? AND clinic_id=? AND purpose=? AND status=? AND is_default=? AND updatedAt <=> ?",
        [mutationAt, row.id, row.clinic_id, row.purpose, row.status, row.is_default, row.updatedAt]);
      if (Number(result?.affectedRows) !== 1) fail('HEADER_CAS_FAILED');
    }
    for (const op of plan.requirement_operations) {
      const row = before.requirements.find(item => Number(item.id) === op.id);
      if (!row || hash(row) !== op.before_sha256) fail('REQUIREMENT_CAS_INVALID');
      // Identifiers are a fixed reviewed schema, values are bound. This exact
      // complete-row CAS is additionally protected by the locked before hash.
      const [result] = await connection.query('DELETE FROM TreatmentConsentRequirements WHERE ' + FIELDS.map(field => '`' + field + '` <=> ?').join(' AND '), FIELDS.map(field => row[field]));
      if (Number(result?.affectedRows) !== 1) fail('REQUIREMENT_CAS_FAILED');
    }
    const after = await captureState(connection, configuration, { lock: true, expectedTreatmentIds: plan.before.treatment_ids });
    verifyAfter(plan, after, mutationAt);
    if (!equal(checkSource(), info) || !equal(checkAuthority(), authority)) fail('SOURCE_OR_AUTHORITY_CHANGED');
    await journal.append({ phase: 'headers_requirements_and_protected_evidence_verified_before_commit', mutation_at: mutationAt,
      after_sha256: hash(after), templates: after.templates, requirements: after.requirements, protected: after.protected });
    if (dryRun) {
      await connection.rollback(); inTransaction = false;
      const current = await readIndependent(configuration, plan.before.treatment_ids);
      if (!equal(current, before)) fail('ROLLBACK_OR_CONCURRENT_STATE_CHANGED');
      await journal.append({ phase: 'dry_run_rolled_back_and_independently_verified', snapshot_sha256: hash(current) });
      return { version: VERSION + ':receipt', status: 'rolled_back_and_verified', plan_sha256: plan.plan_sha256, source: info,
        mutation_at: mutationAt, after, after_sha256: hash(after), final_sha256: hash(current), changed_headers: 0,
        retired_requirements: 0, proposed_headers: plan.header_operations.length, proposed_requirements: REQUIRED_COUNT, policy: POLICY, caution: CAUTION };
    }
    commitAttempted = true; await connection.commit(); inTransaction = false;
    await journal.append({ phase: 'committed', after_sha256: hash(after), changed_headers: plan.header_operations.length, retired_requirements: REQUIRED_COUNT });
    const current = await readIndependent(configuration, plan.before.treatment_ids);
    verifyAfter(plan, current, mutationAt);
    if (!equal(current, after)) fail('INDEPENDENT_READBACK_CHANGED');
    await journal.append({ phase: 'committed_and_independently_verified', after_sha256: hash(current), protected: current.protected });
    return { version: VERSION + ':receipt', status: 'committed_and_verified', plan_sha256: plan.plan_sha256, source: info,
      mutation_at: mutationAt, after: current, after_sha256: hash(current), changed_headers: plan.header_operations.length,
      retired_requirements: REQUIRED_COUNT, policy: POLICY, caution: CAUTION };
  } catch (error) {
    if (inTransaction) await connection.rollback().catch(() => {});
    await journal.append({ phase: commitAttempted ? 'commit_outcome_requires_private_review_no_blind_retry' : 'rolled_back_no_commit_attempt',
      error_code: /^BS_CONSENT_RETIRE_[A-Z_]+$/.test(error.message) ? error.message : 'BOUNDED_OPERATOR_FAILED' }).catch(() => {});
    if (commitAttempted) fail('COMMIT_RESULT_REQUIRES_PRIVATE_JOURNAL_REVIEW');
    throw error;
  } finally { await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_KEY]).catch(() => {}); }
}

function parseOptions(args) {
  const options = parseArgs(args, ['--mode', '--target', '--authority', '--private-output', '--plan', '--approved-plan-sha256', '--private-backup', '--private-journal', '--receipt']);
  if (!['prepare', 'dry-run', 'apply', 'check'].includes(options['--mode']) || options['--target'] !== 'crm'
    || !options['--authority'] || !options['--private-output']) fail('EXPLICIT_CRM_MODE_AUTHORITY_AND_OUTPUT_REQUIRED');
  return options;
}
async function run(args) {
  const options = parseOptions(args), mode = options['--mode']; privateDestination(options['--private-output']);
  const authority = privateJson(options['--authority']); validateAuthority(authority);
  const info = source(), configuration = databaseOptions('crm'); let plan;
  if (mode !== 'prepare') { plan = privateJson(options['--plan']); validatePlan(plan, info, authority, configuration, { requireFresh: mode !== 'check' }); }
  if (['dry-run', 'apply'].includes(mode)) {
    if (options['--approved-plan-sha256'] !== plan.plan_sha256 || !options['--private-backup'] || !options['--private-journal']) fail('EXACT_APPROVAL_BACKUP_AND_JOURNAL_REQUIRED');
    const paths = [options['--private-output'], options['--private-backup'], options['--private-journal']].map(privateDestination);
    if (new Set(paths).size !== paths.length || paths.some(filename => fs.existsSync(filename))) fail('FRESH_DISTINCT_ARTIFACTS_REQUIRED');
  }
  const c = await connectOperatorDatabase('crm'); let journal;
  try {
    await c.query('SET SESSION lock_wait_timeout = 10');
    if (mode === 'prepare' || mode === 'check') {
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const state = await capture(c, configuration, { expectedTreatmentIds: plan?.before.treatment_ids || null }); validateState(state); await c.rollback();
      if (mode === 'prepare') {
        plan = makePlan({ before: state, info, authority }); writePrivateJson(options['--private-output'], plan);
        return { status: 'prepared_read_only', plan_sha256: plan.plan_sha256, headers: plan.header_operations.length, requirements: REQUIRED_COUNT, policy: POLICY, caution: CAUTION };
      }
      let status;
      if (options['--receipt']) {
        const receipt = privateJson(options['--receipt']);
        if (receipt.version !== VERSION + ':receipt' || !['committed_and_verified', 'replay_preserved'].includes(receipt.status)
          || receipt.plan_sha256 !== plan.plan_sha256 || !equal(receipt.source, info) || receipt.after_sha256 !== hash(receipt.after)
          || !equal(receipt.policy, POLICY) || receipt.caution !== CAUTION) fail('COMMITTED_RECEIPT_REQUIRED');
        verifyAfter(plan, state, receipt.mutation_at);
        if (!equal(state, receipt.after)) fail('RECEIPT_READBACK_CHANGED');
        status = 'checked_committed_read_only';
      } else { if (!equal(state, plan.before)) fail('PREPARED_STATE_CHANGED'); status = 'checked_unchanged_read_only'; }
      const proof = { version: VERSION + ':check', status, checked_at: new Date().toISOString(), plan_sha256: plan.plan_sha256,
        snapshot_sha256: hash(state), source: info, protected: state.protected, remaining_requirements: state.requirements.length, policy: POLICY, caution: CAUTION };
      writePrivateJson(options['--private-output'], proof); return proof;
    }
    journal = newJournal(options['--private-journal'], plan.plan_sha256);
    const receipt = await execute({ connection: c, plan, info, authority, configuration, dryRun: mode === 'dry-run', backupPath: options['--private-backup'], journal,
      checkAuthority: () => { const current = privateJson(options['--authority']); validateAuthority(current); return current; } });
    try { writePrivateJson(options['--private-output'], receipt); }
    catch (error) { if (receipt.status === 'committed_and_verified') fail('COMMITTED_RECEIPT_WRITE_FAILED_REVIEW_PRIVATE_JOURNAL'); throw error; }
    return { status: receipt.status, plan_sha256: plan.plan_sha256, changed_headers: receipt.changed_headers, retired_requirements: receipt.retired_requirements, policy: POLICY, caution: CAUTION };
  } finally { journal?.close(); await c.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
  process.stderr.write((/^BS_CONSENT_RETIRE_[A-Z_]+$/.test(error.message) ? error.message : 'BS_CONSENT_RETIRE_FAILED_REVIEW_PRIVATE_JOURNAL') + '\n'); process.exitCode = 1;
});
module.exports = { VERSION, AUTHORITY_LITERAL, LOCK_KEY, REQUIRED_COUNT, TREATMENT_COUNT, FIELDS, PIN_FILES, POLICY, CAUTION,
  source, validateAuthority, treatmentIds, assertTreatmentIds, capture, validateState, makePlan, validatePlan, verifyAfter, execute, parseOptions, run };

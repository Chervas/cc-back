#!/usr/bin/env node
'use strict';

// Deliberately standalone: no application/model bootstrap, hooks, jobs or
// provider calls. Withdraw clinic template headers, never patient evidence.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { readBytes, writePrivateJson, parseArgs, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const { databaseOptions, connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { privateJson } = require('./cliniccloud-import-appointments-apply');
const { newJournal } = require('./program-commercial-schema-release');

const ROOT = '/home/ubuntu/wt/back-dev';
const VERSION = 'bs-consent-catalog-withdrawal/1';
const CLINIC_IDS = Object.freeze([66, 72]);
// Reviewed inventory, not a broad UPDATE by clinic. A new/deleted/moved template
// requires a new code review rather than silently extending this instruction.
const EXPECTED_IDS = Object.freeze([2, 3, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77,
  90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101,
  ...Array.from({ length: 60 }, (_, index) => 122 + index), 248]);
// These reviewed identities cannot become eligible merely because somebody
// changes a valid purpose before preparing a new plan (or vice versa).
const DATA_PROTECTION_IDS = Object.freeze([2, 73, 90, 92, 154]);
const TABLES = Object.freeze(['ClinicConsentTemplates', 'ClinicConsentTemplateVersions', 'TreatmentConsentRequirements',
  'PatientConsentDocuments', 'ConsentSignaturePackages', 'ConsentTemplateCatalogs', 'ConsentTemplateCatalogVersions']);
const PIN_FILES = Object.freeze(['src/scripts/bs-consent-catalog-withdrawal.js',
  'src/scripts/tests/bs_consent_catalog_withdrawal.test.js', 'src/lib/cliniccloud-import/operator-database.js',
  'src/lib/cliniccloud-import/io.js', 'src/lib/cliniccloud-import/adapter.js',
  'src/scripts/cliniccloud-import-appointments-apply.js', 'src/scripts/program-commercial-schema-release.js',
  'models/clinicconsenttemplate.js', 'models/clinicconsenttemplateversion.js', 'models/patientconsentdocument.js',
  'models/consentsignaturepackage.js', 'models/treatmentconsentrequirement.js',
  'src/services/consentimientos.service.js', 'src/services/appointmentConsentEligibility.service.js',
  'src/lib/patient-intake-consents.js']);
const ROW_LIMIT = 10000;
const LOCK_KEY = 'cc-bs-consent-catalog-withdrawal:crm';
const fail = code => { throw Error('BS_CONSENT_WITHDRAWAL_' + code); };
const equal = (left, right) => hash(left) === hash(right);
const POLICY = Object.freeze({ clinic_headers_only: true, patient_documents_unchanged: true,
  signatures_unchanged: true, issued_links_unchanged: true, requirements_unchanged: true,
  versions_unchanged: true, global_catalog_unchanged: true, no_dispatch: true,
  no_automatic_rollback_over_later_human_edits: true });

function source() {
  if (process.cwd() !== ROOT || path.resolve(__dirname, '../..') !== ROOT || fs.realpathSync(ROOT) !== ROOT
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev'
    || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) fail('CLEAN_COMMITTED_DEV_REQUIRED');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('SOURCE_INVALID');
  const pins = {};
  for (const file of PIN_FILES) {
    const filename = path.join(ROOT, file), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== filename) fail('SOURCE_FILE_INVALID');
    const bytes = readBytes(filename), committed = execFileSync('git', ['show', `${commit}:${file}`], { maxBuffer: 32 * 1024 * 1024 });
    if (hash(bytes) !== hash(committed)) fail('SOURCE_FILE_NOT_COMMITTED');
    pins[file] = hash(bytes);
  }
  return { commit, pins };
}

function digest(rows) {
  const statuses = {};
  for (const row of rows) if (Object.hasOwn(row, 'status')) statuses[String(row.status)] = (statuses[String(row.status)] || 0) + 1;
  return { count: rows.length, sha256: hash(rows), statuses };
}

async function capture(connection, configuration, { lock = false } = {}) {
  const query = async (sql, values = [], limit = ROW_LIMIT) => {
    const [rows] = await connection.query(sql, values);
    if (!Array.isArray(rows) || rows.length > limit) fail('BOUNDED_SCOPE_EXCEEDED');
    return rows;
  };
  const [identity] = await query('SELECT DATABASE() AS database_name,CURRENT_USER() AS database_user,@@hostname AS server_name');
  if (identity?.database_name !== configuration.database) fail('DATABASE_IDENTITY_CHANGED');
  const tables = await query('SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME', [TABLES]);
  const columns = await query('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,ORDINAL_POSITION', [TABLES]);
  const indexes = await query('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX', [TABLES]);
  const triggers = await query('SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (?) ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME', [TABLES]);
  if (TABLES.some(name => !tables.some(row => row.TABLE_NAME === name && row.ENGINE === 'InnoDB'))
    || triggers.some(row => row.EVENT_OBJECT_TABLE === 'ClinicConsentTemplates')) fail('TRANSACTIONAL_SCHEMA_OR_TRIGGERS_INVALID');
  const field = name => columns.find(row => row.TABLE_NAME === 'ClinicConsentTemplates' && row.COLUMN_NAME === name);
  if (!field('status')?.COLUMN_TYPE.includes("'archived'") || !/^tinyint(?:\(1\))?$/.test(field('is_default')?.COLUMN_TYPE || '')
    || !/^datetime(?:\(0\))?$/.test(field('updatedAt')?.COLUMN_TYPE || '')) fail('REVIEWED_HEADER_COLUMNS_REQUIRED');
  const share = lock ? ' LOCK IN SHARE MODE' : '';
  const clinics = await query('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN (66,72) ORDER BY id_clinica' + share);
  const templates = await query('SELECT * FROM ClinicConsentTemplates WHERE clinic_id IN (66,72) ORDER BY id LIMIT 101' + (lock ? ' FOR UPDATE' : ''), [], 100);
  const protectedState = {};
  const protectedQueries = {
    versions: ['SELECT * FROM ClinicConsentTemplateVersions WHERE clinic_template_id IN (?) ORDER BY id', [EXPECTED_IDS]],
    requirements: ['SELECT * FROM TreatmentConsentRequirements WHERE clinica_id IN (66,72) OR clinic_template_id IN (?) ORDER BY id', [EXPECTED_IDS]],
    documents: ['SELECT * FROM PatientConsentDocuments WHERE clinica_id IN (66,72) OR clinic_template_id IN (?) ORDER BY id', [EXPECTED_IDS]],
    packages: ['SELECT * FROM ConsentSignaturePackages WHERE clinica_id IN (66,72) OR id IN (SELECT package_id FROM PatientConsentDocuments WHERE clinic_template_id IN (?)) ORDER BY id', [EXPECTED_IDS]],
    global_catalog: ['SELECT * FROM ConsentTemplateCatalogs ORDER BY id', []],
    global_catalog_versions: ['SELECT * FROM ConsentTemplateCatalogVersions ORDER BY id', []],
    other_clinic_templates: ['SELECT * FROM ClinicConsentTemplates WHERE clinic_id NOT IN (66,72) ORDER BY id', []],
  };
  // Hash the complete frozen evidence in memory. No patient names, snapshots,
  // signatures, recipients or public/tokenized links are written to artifacts.
  for (const [key, [sql, values]] of Object.entries(protectedQueries)) {
    protectedState[key] = digest(await query(sql + ` LIMIT ${ROW_LIMIT + 1}` + share, values));
  }
  return { identity_sha256: hash(identity), configuration_sha256: hash(configuration),
    schema_sha256: hash({ tables, columns, indexes, triggers }), clinics, templates, protected: protectedState };
}

function validateState(state) {
  if (!state || !Array.isArray(state.clinics) || state.clinics.length !== 2
    || !CLINIC_IDS.every(id => state.clinics.some(row => Number(row.id_clinica) === id && Number(row.grupoClinicaId) === 29))
    || !Array.isArray(state.templates) || !equal(state.templates.map(row => Number(row.id)), EXPECTED_IDS)
    || state.templates.some(row => !CLINIC_IDS.includes(Number(row.clinic_id))
      || !['active', 'draft', 'archived'].includes(row.status) || ![0, 1].includes(Number(row.is_default))
      || !['clinical', 'data_protection', 'clinical_image', 'marketing_image', 'commercial_communications', 'financial', 'revocation', 'other'].includes(row.purpose))) fail('EXACT_CLINIC_TEMPLATE_INVENTORY_CHANGED');
  if (!equal(state.templates.filter(row => row.purpose === 'data_protection').map(row => Number(row.id)), DATA_PROTECTION_IDS)) fail('REVIEWED_PATIENT_DATA_IDENTITIES_OR_PURPOSE_CHANGED');
  for (const key of ['identity_sha256', 'configuration_sha256', 'schema_sha256']) if (!/^[a-f0-9]{64}$/.test(state[key])) fail('STATE_DIGEST_INVALID');
  const keys = ['versions', 'requirements', 'documents', 'packages', 'global_catalog', 'global_catalog_versions', 'other_clinic_templates'];
  if (!equal(Object.keys(state.protected || {}), keys)) fail('PROTECTED_STATE_INVALID');
  for (const item of Object.values(state.protected)) if (!Number.isInteger(item.count) || item.count < 0 || item.count > ROW_LIMIT
    || !/^[a-f0-9]{64}$/.test(item.sha256) || !item.statuses || typeof item.statuses !== 'object') fail('PROTECTED_STATE_INVALID');
}

function operationsFor(state, includePatientData) {
  return state.templates.filter(row => (includePatientData || row.purpose !== 'data_protection')
    && (row.status !== 'archived' || Number(row.is_default) !== 0))
    .map(row => ({ id: row.id, clinic_id: row.clinic_id, purpose: row.purpose, before_sha256: hash(row),
      after: { status: 'archived', is_default: 0 } }));
}

function makePlan({ before, info, includePatientData = false, generatedAt = new Date().toISOString() }) {
  validateState(before);
  if (typeof includePatientData !== 'boolean') fail('EXPLICIT_PATIENT_DATA_CHOICE_REQUIRED');
  const body = { version: VERSION, target: 'crm', clinic_ids: CLINIC_IDS, group_id: 29,
    source: info, generated_at: generatedAt, include_patient_data: includePatientData,
    scope: includePatientData ? 'all_clinic_templates' : 'templates_except_data_protection',
    before, before_sha256: hash(before), operations: operationsFor(before, includePatientData), policy: POLICY,
    cautions: ['Existing issued patient documents and links remain unchanged, including pending requests.',
      'Preserved hard clinical requirements referencing archived templates prevent clinical start/completion until reviewed.',
      ...(includePatientData ? ['Withdrawing data_protection templates also prevents preparation of new patient-intake signature packages.'] : [])] };
  return { ...body, plan_sha256: hash(body) };
}

function validatePlan(plan, info, configuration, { includePatientData = false, now = Date.now(), requireFresh = true } = {}) {
  if (!plan || plan.version !== VERSION || plan.target !== 'crm' || !equal(plan.source, info)
    || !equal(plan.clinic_ids, CLINIC_IDS) || plan.group_id !== 29 || plan.include_patient_data !== includePatientData
    || plan.before?.configuration_sha256 !== hash(configuration)) fail('PLAN_SOURCE_TARGET_OR_PATIENT_DATA_CHOICE_CHANGED');
  const expected = makePlan({ before: plan.before, info, includePatientData, generatedAt: plan.generated_at });
  if (!equal(expected, plan)) fail('PLAN_TAMPERED');
  const generated = Date.parse(plan.generated_at);
  if (!Number.isFinite(generated) || generated > now || requireFresh && now - generated > 7200000) fail('PLAN_EXPIRED');
}

function verifyAfter(before, after, operations, mutationAt) {
  validateState(after);
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(mutationAt || '')) fail('MUTATION_TIMESTAMP_INVALID');
  const expected = { ...before, templates: before.templates.map(row => operations.some(op => Number(op.id) === Number(row.id))
    ? { ...row, status: 'archived', is_default: 0, updatedAt: mutationAt } : row) };
  if (!equal(expected, after)) fail('POST_WRITE_OR_PROTECTED_EVIDENCE_CHANGED');
  return true;
}

function privateDestination(filename) {
  if (!path.isAbsolute(filename || '')) fail('PRIVATE_ARTIFACT_PATH_REQUIRED');
  const root = fs.realpathSync(PRIVATE_ROOT), parent = fs.realpathSync(path.dirname(filename));
  if (parent !== root && !parent.startsWith(root + path.sep)) fail('PRIVATE_ARTIFACT_PATH_REQUIRED');
  for (const directory of [root, parent]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail('PRIVATE_ARTIFACT_PERMISSIONS_INVALID');
  }
  return path.join(parent, path.basename(filename));
}

async function independentCapture(configuration) {
  const connection = await connectOperatorDatabase('crm');
  try {
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const state = await capture(connection, configuration);
    await connection.rollback();
    return state;
  } finally { await connection.end(); }
}

async function execute({ connection, plan, info, configuration, includePatientData = false, dryRun = false,
  backupPath, journal, captureState = capture, readIndependent = independentCapture,
  checkSource = source, saveBackup = writePrivateJson }) {
  validatePlan(plan, info, configuration, { includePatientData });
  if (!plan.operations.length) fail('EMPTY_PLAN');
  const [[lock]] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [LOCK_KEY]);
  if (Number(lock?.acquired) !== 1) fail('ANOTHER_WITHDRAWAL_ACTIVE');
  let inTransaction = false, commitAttempted = false;
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.beginTransaction(); inTransaction = true;
    const before = await captureState(connection, configuration, { lock: true });
    validateState(before);
    if (!equal(before, plan.before)) fail('PREPARED_ROWS_OR_PROTECTED_EVIDENCE_DRIFT');
    const [[clock]] = await connection.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-%d %H:%i:%s') AS mutation_at");
    const mutationAt = clock?.mutation_at;
    if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(mutationAt || '')) fail('MUTATION_TIMESTAMP_INVALID');
    const backup = { version: VERSION + ':backup', target: 'crm', source: info, plan_sha256: plan.plan_sha256,
      generated_at: new Date().toISOString(), mutation_at: mutationAt, before, before_sha256: hash(before),
      restoration_policy: 'Restore only the three changed header fields, after exact comparison with the committed after image. Never overwrite later human edits or restore patient tables.' };
    saveBackup(backupPath, backup);
    await journal.append({ phase: 'backup_durable_before_mutation', backup_path: backupPath,
      backup_sha256: hash(backup), planned_headers: plan.operations.length, include_patient_data: includePatientData });
    if (!equal(checkSource(), info)) fail('SOURCE_CHANGED_BEFORE_MUTATION');
    const [[ownership]] = await connection.query('SELECT IS_USED_LOCK(?)=CONNECTION_ID() AS owned', [LOCK_KEY]);
    if (Number(ownership?.owned) !== 1) fail('EXECUTOR_LOCK_LOST');
    await journal.append({ phase: 'before_header_cas_only', mutation_at: mutationAt, ids: plan.operations.map(op => op.id),
      protected: before.protected, policy: POLICY });
    for (const operation of plan.operations) {
      const row = before.templates.find(item => Number(item.id) === Number(operation.id));
      if (!row || hash(row) !== operation.before_sha256 || row.purpose === 'data_protection' && !includePatientData) fail('EXACT_ROW_CAS_INVALID');
      const [result] = await connection.query("UPDATE ClinicConsentTemplates SET status='archived',is_default=0,updatedAt=? WHERE id=? AND clinic_id=? AND purpose=? AND status=? AND is_default=? AND updatedAt <=> ?",
        [mutationAt, row.id, row.clinic_id, row.purpose, row.status, row.is_default, row.updatedAt]);
      if (Number(result?.affectedRows) !== 1) fail('EXACT_ROW_CAS_FAILED');
    }
    const after = await captureState(connection, configuration, { lock: true });
    verifyAfter(before, after, plan.operations, mutationAt);
    if (!equal(checkSource(), info)) fail('SOURCE_CHANGED_BEFORE_COMMIT');
    await journal.append({ phase: 'headers_and_protected_evidence_verified_before_commit', after_sha256: hash(after),
      mutation_at: mutationAt, templates: after.templates, protected: after.protected });
    if (dryRun) {
      await connection.rollback(); inTransaction = false;
      const readback = await readIndependent(configuration);
      if (!equal(readback, before)) fail('ROLLBACK_OR_CONCURRENT_EVIDENCE_REQUIRES_REVIEW');
      await journal.append({ phase: 'dry_run_rolled_back_and_independently_verified', snapshot_sha256: hash(readback) });
      return { version: VERSION + ':receipt', status: 'rolled_back_and_verified', plan_sha256: plan.plan_sha256,
        source: info, mutation_at: mutationAt, after, after_sha256: hash(after), final_sha256: hash(readback),
        proposed: plan.operations.length, changed_headers: 0, policy: POLICY };
    }
    commitAttempted = true;
    await connection.commit(); inTransaction = false;
    await journal.append({ phase: 'committed', after_sha256: hash(after), changed_headers: plan.operations.length });
    const readback = await readIndependent(configuration);
    verifyAfter(before, readback, plan.operations, mutationAt);
    if (!equal(readback, after)) fail('INDEPENDENT_READBACK_CHANGED');
    await journal.append({ phase: 'committed_and_independently_verified', after_sha256: hash(readback), protected: readback.protected });
    return { version: VERSION + ':receipt', status: 'committed_and_verified', plan_sha256: plan.plan_sha256,
      source: info, mutation_at: mutationAt, after: readback, after_sha256: hash(readback),
      changed_headers: plan.operations.length, policy: POLICY };
  } catch (error) {
    if (inTransaction) await connection.rollback().catch(() => {});
    await journal.append({ phase: commitAttempted ? 'commit_outcome_requires_manual_review_no_replay' : 'rolled_back_no_commit_attempt',
      error_code: /^BS_CONSENT_WITHDRAWAL_[A-Z_]+$/.test(error.message) ? error.message : 'BOUNDED_OPERATOR_FAILED' }).catch(() => {});
    if (commitAttempted) fail('COMMIT_RESULT_REQUIRES_PRIVATE_JOURNAL_REVIEW');
    throw error;
  } finally { await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_KEY]).catch(() => {}); }
}

function parseOptions(args) {
  // This affirmative flag is intentionally required again at apply/check time
  // for an all-template plan. A forged/mislaid plan cannot broaden the default.
  const tokens = [];
  for (const token of args) {
    tokens.push(token);
    if (token === '--include-patient-data') tokens.push('true');
  }
  const options = parseArgs(tokens, ['--mode', '--target', '--private-output', '--plan', '--approved-plan-sha256',
    '--private-backup', '--private-journal', '--receipt', '--include-patient-data']);
  if (!['prepare', 'dry-run', 'apply', 'check'].includes(options['--mode']) || options['--target'] !== 'crm'
    || !options['--private-output']) fail('EXPLICIT_MODE_CRM_AND_PRIVATE_OUTPUT_REQUIRED');
  return options;
}

async function run(args) {
  const options = parseOptions(args), mode = options['--mode'], includePatientData = options['--include-patient-data'] === 'true';
  privateDestination(options['--private-output']);
  const info = source(), configuration = databaseOptions('crm');
  let plan;
  if (mode !== 'prepare') {
    plan = privateJson(options['--plan']);
    validatePlan(plan, info, configuration, { includePatientData, requireFresh: mode !== 'check' });
  }
  if (['apply', 'dry-run'].includes(mode)) {
    if (options['--approved-plan-sha256'] !== plan.plan_sha256 || !options['--private-backup'] || !options['--private-journal']) fail('EXACT_APPROVAL_BACKUP_AND_JOURNAL_REQUIRED');
    const paths = [options['--private-output'], options['--private-backup'], options['--private-journal']].map(privateDestination);
    if (new Set(paths).size !== paths.length || paths.some(filename => fs.existsSync(filename))) fail('FRESH_DISTINCT_ARTIFACTS_REQUIRED');
  }
  const connection = await connectOperatorDatabase('crm'); let journal;
  try {
    await connection.query('SET SESSION lock_wait_timeout = 10');
    if (mode === 'prepare' || mode === 'check') {
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const state = await capture(connection, configuration); validateState(state);
      await connection.rollback();
      if (mode === 'prepare') {
        plan = makePlan({ before: state, info, includePatientData });
        writePrivateJson(options['--private-output'], plan);
        return { status: 'prepared_read_only', plan_sha256: plan.plan_sha256, proposed: plan.operations.length,
          include_patient_data: includePatientData, protected: state.protected, policy: POLICY };
      }
      let result;
      if (options['--receipt']) {
        const receipt = privateJson(options['--receipt']);
        if (receipt.version !== VERSION + ':receipt' || receipt.status !== 'committed_and_verified'
          || receipt.plan_sha256 !== plan.plan_sha256 || !equal(receipt.source, info)
          || receipt.after_sha256 !== hash(receipt.after) || !equal(receipt.policy, POLICY)) fail('COMMITTED_RECEIPT_REQUIRED');
        verifyAfter(plan.before, state, plan.operations, receipt.mutation_at);
        if (!equal(receipt.after, state)) fail('RECEIPT_READBACK_CHANGED');
        result = { status: 'checked_committed_read_only', changed_headers: plan.operations.length };
      } else {
        if (!equal(state, plan.before)) fail('PREPARED_SNAPSHOT_CHANGED');
        result = { status: 'checked_unchanged_read_only', changed_headers: 0 };
      }
      const proof = { ...result, version: VERSION + ':check', checked_at: new Date().toISOString(),
        plan_sha256: plan.plan_sha256, snapshot_sha256: hash(state), source: info, protected: state.protected, policy: POLICY };
      writePrivateJson(options['--private-output'], proof);
      return proof;
    }
    journal = newJournal(options['--private-journal'], plan.plan_sha256);
    const receipt = await execute({ connection, plan, info, configuration, includePatientData, dryRun: mode === 'dry-run',
      backupPath: options['--private-backup'], journal });
    try { writePrivateJson(options['--private-output'], receipt); }
    catch (error) { if (receipt.status === 'committed_and_verified') fail('COMMITTED_RECEIPT_WRITE_FAILED_REVIEW_PRIVATE_JOURNAL'); throw error; }
    return { status: receipt.status, plan_sha256: plan.plan_sha256, changed_headers: receipt.changed_headers,
      ...(receipt.proposed == null ? {} : { proposed: receipt.proposed }), include_patient_data: includePatientData, policy: POLICY };
  } finally { journal?.close(); await connection.end(); }
}

if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
  process.stderr.write((/^BS_CONSENT_WITHDRAWAL_[A-Z_]+$/.test(error.message) ? error.message : 'BS_CONSENT_WITHDRAWAL_FAILED_REVIEW_PRIVATE_JOURNAL') + '\n');
  process.exitCode = 1;
});
module.exports = { VERSION, CLINIC_IDS, EXPECTED_IDS, DATA_PROTECTION_IDS, TABLES, PIN_FILES, POLICY, LOCK_KEY, source, digest, capture,
  validateState, operationsFor, makePlan, validatePlan, verifyAfter, execute, parseOptions, run };

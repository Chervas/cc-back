#!/usr/bin/env node
'use strict';

// Standalone, three reviewed drafts only. No application/model bootstrap,
// booking writer, event, consent preparation, price decision or provider call.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { hash, norm } = require('../lib/cliniccloud-import/adapter');
const { normalizeBookingProfile } = require('../lib/booking-profile');
const { readBytes, writePrivateJson, parseArgs, PRIVATE_ROOT } = require('../lib/cliniccloud-import/io');
const { databaseOptions, connectOperatorDatabase } = require('../lib/cliniccloud-import/operator-database');
const { newJournal } = require('./program-commercial-schema-release');

const ROOT = '/home/ubuntu/wt/back-dev';
const VERSION = 'bs-client-surgical-profiles/1';
const WORKBOOK_SHA = 'c6cec4e16ee74eced9237a181288b61d3fb2d8ba1dec78cac06a86f6fb6880b0';
const ORIGINAL_CATALOG_SHA = 'cc1beeda3e882f2811f08a0111b5ddab660dff973b7d79d1bec48367ef0705aa';
const PROTOCOL_PACKAGE_SHA = '16f9656756c97d9dd0dbd3140e3c3010b760908a57a2614b27ca7e132b044b44';
const PROTOCOL_SHA = '472dfeecb86324553bbf56e23b2541ee34af2884b46b77c8640cb83b61baeb50';
const PROTOCOL_PAGE_SHA = 'e33ce2e480027dcbde5686883f25dc9449320026e0e09316eb75361200dd0c3f';
const LOCK_KEY = 'cc-bs-client-surgical-profiles:crm';
const LIMIT = 10000;
const SPECS = Object.freeze([
  { id: 1994, code: 'BS26-f16d78384feca440ea87', source_row: 15,
    source_row_sha256: 'e957db60cf9a2bcabefecde61c13214143103b0c7abf1b6fbdf306b85994b5ca', minutes: 450, reference: 'CAP-DHI-1', answer_row: 9 },
  { id: 1997, code: 'BS26-ab1466b204a3c8389049', source_row: 18,
    source_row_sha256: '9f783d394f879e1e44df00cfb9f690c72cca322135c4dc3b7ac7667f5dfa1fc1', minutes: 240, reference: 'CAP-APOYO', answer_row: 19 },
  { id: 1998, code: 'BS26-cba9d0095c25ecccd863', source_row: 19,
    source_row_sha256: '52fd45477c14e12d3915e57c6423d201bad60d25ffedbe8e30700295475a0d3b', minutes: 180, reference: 'CAP-APOYO', answer_row: 19 },
]);
const PIN_FILES = Object.freeze(['src/scripts/bs-client-surgical-profiles.js', 'src/scripts/tests/bs_client_surgical_profiles.test.js',
  'src/lib/cliniccloud-import/xlsx_catalog.py', 'src/lib/cliniccloud-import/io.js', 'src/lib/cliniccloud-import/adapter.js',
  'src/lib/cliniccloud-import/operator-database.js', 'src/lib/databaseTlsConfig.js', 'src/lib/booking-profile.js',
  'src/lib/booking-equipment.js', 'src/lib/booking-attention.js', 'src/scripts/program-commercial-schema-release.js']);
const POLICY = Object.freeze({ exact_drafts_only: true, duration_and_profile_only: true, price_unchanged: true,
  activation: false, patient_appointments_unchanged: true, consent_unchanged: true, no_messages: true,
  whole_team_reserved: true, partial_attention_inferred: false, fixed_start_clock_enforced: false,
  automatic_rollback_over_human_edits: false });
const fail = code => { throw Error('BS_SURGICAL_' + code); };
const equal = (a, b) => hash(a) === hash(b);
const copy = value => JSON.parse(JSON.stringify(value));
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const isSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function source() {
  if (process.cwd() !== ROOT || path.resolve(__dirname, '../..') !== ROOT || fs.realpathSync(ROOT) !== ROOT
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev'
    || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) fail('CLEAN_COMMITTED_DEV_REQUIRED');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pins = {};
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('SOURCE_COMMIT_INVALID');
  for (const file of PIN_FILES) {
    const filename = path.join(ROOT, file), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== filename) fail('SOURCE_FILE_INVALID');
    const bytes = readBytes(filename), committed = execFileSync('git', ['show', `${commit}:${file}`], { maxBuffer: 32 * 1024 * 1024 });
    if (hash(bytes) !== hash(committed)) fail('SOURCE_FILE_NOT_COMMITTED');
    pins[file] = hash(bytes);
  }
  return { commit, pins };
}

function workbookEvidence(sheets, workbookSha) {
  if (workbookSha !== WORKBOOK_SHA || !Array.isArray(sheets)) fail('WORKBOOK_SOURCE_CHANGED');
  const matches = sheets.filter(sheet => sheet.name === 'Tratamientos');
  if (matches.length !== 1) fail('WORKBOOK_SHEET_CHANGED');
  const evidence = [];
  for (const rowNumber of [9, 19]) {
    const found = matches[0].rows.filter(row => row.source_row === rowNumber);
    if (found.length !== 1) fail('WORKBOOK_ROW_CHANGED');
    const cells = found[0].cells;
    const dhi = rowNumber === 9;
    if (norm(cells.A) !== (dhi ? 'CAP-DHI-1' : 'CAP-APOYO') || norm(cells.B) !== 'BS CAPILAR'
      || norm(cells.F) !== norm(dhi ? 'Mantener 07:00–14:30' : 'Ainhoa durante toda la intervención, en ambos casos')
      || norm(cells.G) || norm(cells.O)
      || (dhi ? !norm(cells.E).includes('07:00–14:30 (450 MIN)')
        : !norm(cells.E).includes('BARBA 240 MIN; CEJAS 180 MIN'))
      || !norm(cells.E).includes('DR. LOZA') || !norm(cells.E).includes('C6')
      || norm(cells.M) !== (dhi ? '1994' : '1997, 1998')) fail('WORKBOOK_EXPLICIT_ANSWER_REQUIRED');
    evidence.push({ reference: cells.A, sheet: 'Tratamientos', source_row: rowNumber,
      row_sha256: hash(cells), proposal: cells.E, answer: cells.F });
  }
  return { workbook_sha256: workbookSha, answers: evidence };
}

function protocolEvidence(document, packageSha) {
  const result = document?.results?.find(item => item.source_file === 'BS-Medical-Protocolos-V3-Capilar.pdf');
  if (packageSha !== PROTOCOL_PACKAGE_SHA || result?.source_sha256 !== PROTOCOL_SHA
    || result.page_sha256?.[40] !== PROTOCOL_PAGE_SHA || !Array.isArray(result.parts)) fail('PROTOCOL_SOURCE_CHANGED');
  const text = result.parts.map(part => String(part.content || '')).join('\n');
  const page = text.split(/(?=## Página \d+ del PDF)/).find(item => item.startsWith('## Página 41 del PDF'));
  if (!page || !norm(page).includes('CAP-14 INJERTO DE BARBA 4H') || !norm(page).includes('CAP-15 INJERTO DE CEJAS 3H')) fail('PROTOCOL_DURATIONS_NOT_EXPLICIT');
  return { package_sha256: packageSha, source_file: result.source_file, source_sha256: PROTOCOL_SHA,
    pdf_page: 41, page_sha256: PROTOCOL_PAGE_SHA, clinical_approval: false };
}

function readEvidence(workbook, protocolPackage) {
  const workbookBytes = readBytes(workbook);
  if (hash(workbookBytes) !== WORKBOOK_SHA) fail('WORKBOOK_SOURCE_CHANGED');
  const sheets = JSON.parse(execFileSync('python3', [path.join(ROOT, 'src/lib/cliniccloud-import/xlsx_catalog.py'), workbook],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000 }));
  if (hash(readBytes(workbook)) !== WORKBOOK_SHA) fail('WORKBOOK_CHANGED_DURING_READ');
  const bytes = readBytes(protocolPackage);
  return { ...workbookEvidence(sheets, WORKBOOK_SHA), protocol: protocolEvidence(JSON.parse(bytes), hash(bytes)) };
}

function profile(spec) {
  return normalizeBookingProfile({ version: 1, phases: [{ key: 'phase_1', label: 'Cirugía capilar · equipo completo',
    duration_minutes: spec.minutes, installation_ids: [78], professionals: { mode: 'all', ids: [120, 50], preferred_id: null } }] });
}

async function capture(connection, configuration, { lock = false } = {}) {
  const query = async (sql, values = [], limit = LIMIT) => {
    const [rows] = await connection.query(sql, values);
    if (!Array.isArray(rows) || rows.length > limit) fail('BOUNDED_SCOPE_EXCEEDED');
    return rows;
  };
  const identity = await query('SELECT DATABASE() AS database_name,CURRENT_USER() AS database_user,@@hostname AS server_name');
  if (identity.length !== 1 || identity[0].database_name !== configuration.database) fail('DATABASE_IDENTITY_CHANGED');
  const tableNames = ['Tratamientos', 'Instalaciones', 'DoctorClinicas', 'Clinicas', 'CitasPacientes'];
  const tables = await query('SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME', [tableNames]);
  const columns = await query('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME,ORDINAL_POSITION', [tableNames]);
  const triggers = await query("SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='Tratamientos' ORDER BY TRIGGER_NAME");
  if (tableNames.some(name => !tables.some(row => row.TABLE_NAME === name && row.ENGINE === 'InnoDB')) || triggers.length
    || !columns.some(row => row.TABLE_NAME === 'Tratamientos' && row.COLUMN_NAME === 'clinical_config' && row.COLUMN_TYPE.toLowerCase() === 'json')
    || !columns.some(row => row.TABLE_NAME === 'Tratamientos' && row.COLUMN_NAME === 'updatedAt' && /^datetime(?:\(0\))?$/.test(row.COLUMN_TYPE))) fail('TRANSACTIONAL_SCHEMA_REQUIRED');
  const share = lock ? ' LOCK IN SHARE MODE' : '';
  const clinics = await query('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica=66 LIMIT 2' + share, [], 1);
  const treatmentsRaw = await query('SELECT *,SHA2(CAST(clinical_config AS CHAR),256) AS _config_sql_sha256 FROM Tratamientos WHERE id_tratamiento IN (1994,1997,1998) ORDER BY id_tratamiento LIMIT 4' + (lock ? ' FOR UPDATE' : ''), [], 3);
  const config_sql_sha256 = {};
  const treatments = treatmentsRaw.map(({ _config_sql_sha256, ...row }) => {
    config_sql_sha256[row.id_tratamiento] = _config_sql_sha256;
    return { ...row, clinical_config: decode(row.clinical_config) };
  });
  const rooms = await query('SELECT * FROM Instalaciones WHERE id=78 LIMIT 2' + share, [], 1);
  const staff = await query('SELECT id,doctor_id,clinica_id,activo,recibe_citas FROM DoctorClinicas WHERE clinica_id=66 AND doctor_id IN (50,120) ORDER BY doctor_id LIMIT 3' + share, [], 2);
  // Complete appointment rows are hashed in memory only: no patient fields are
  // persisted in artifacts, and no CitasPacientes DML exists in this operator.
  const appointments = await query('SELECT * FROM CitasPacientes WHERE tratamiento_id IN (1994,1997,1998) ORDER BY id_cita LIMIT 10001' + share);
  return { target: 'crm', identity_sha256: hash(identity), configuration_sha256: hash(configuration),
    schema_sha256: hash({ tables, columns, triggers }), clinics, treatments, config_sql_sha256, rooms, staff,
    appointments: { count: appointments.length, sha256: hash(appointments) } };
}

function validateState(state) {
  if (state?.target !== 'crm' || !Array.isArray(state.clinics) || state.clinics.length !== 1
    || Number(state.clinics[0].id_clinica) !== 66 || Number(state.clinics[0].grupoClinicaId) !== 29
    || !Array.isArray(state.treatments) || !equal(state.treatments.map(row => Number(row.id_tratamiento)), SPECS.map(spec => spec.id))
    || !Array.isArray(state.rooms) || state.rooms.length !== 1 || !Array.isArray(state.staff) || state.staff.length !== 2) fail('EXACT_SCOPE_CHANGED');
  for (const key of ['identity_sha256', 'configuration_sha256', 'schema_sha256']) if (!isSha(state[key])) fail('STATE_DIGEST_INVALID');
  const room = state.rooms[0], allowed = decode(room.profesionales_permitidos);
  if (Number(room.id) !== 78 || Number(room.clinica_id) !== 66 || Number(room.activo) !== 1 || Number(room.capacidad) !== 1
    || Number(room.requiere_preparacion) !== 0 || Number(room.tiempo_preparacion_minutos) !== 0
    || !Array.isArray(allowed) || ![50, 120].every(id => allowed.includes(id))) fail('ROOM_NOT_ELIGIBLE');
  if (![50, 120].every(id => state.staff.filter(row => Number(row.doctor_id) === id && Number(row.clinica_id) === 66
    && Number(row.activo) === 1 && Number(row.recibe_citas) === 1).length === 1)) fail('STAFF_NOT_ELIGIBLE');
  if (!Number.isSafeInteger(state.appointments?.count) || state.appointments.count < 0 || state.appointments.count > LIMIT
    || !isSha(state.appointments.sha256) || !equal(Object.keys(state.config_sql_sha256 || {}).sort(), SPECS.map(spec => String(spec.id)).sort())) fail('PROTECTED_APPOINTMENTS_INVALID');
  for (const spec of SPECS) {
    const row = state.treatments.find(value => Number(value.id_tratamiento) === spec.id), config = row.clinical_config;
    if (Number(row.clinica_id) !== 66 || row.codigo !== spec.code || Number(row.activo) !== 0 || config?.catalog_status !== 'draft'
      || config.product_type !== 'treatment' || config.import_batch !== 'cliniccloud-bs-catalog-individuals-20260921'
      || config.source_catalog?.file_sha256 !== ORIGINAL_CATALOG_SHA || config.source_catalog?.sheet !== 'Capilar · sesiones y bonos'
      || config.source_catalog?.source_row !== spec.source_row || config.source_catalog?.row_sha256 !== spec.source_row_sha256
      || !isSha(state.config_sql_sha256[spec.id])) fail('DRAFT_OR_ORIGINAL_SOURCE_CHANGED');
  }
}

function makePlan({ before, info, evidence, generatedAt = new Date().toISOString() }) {
  validateState(before);
  if (evidence?.workbook_sha256 !== WORKBOOK_SHA || evidence.protocol?.source_sha256 !== PROTOCOL_SHA
    || evidence.protocol?.page_sha256 !== PROTOCOL_PAGE_SHA || evidence.protocol?.package_sha256 !== PROTOCOL_PACKAGE_SHA
    || evidence.answers?.length !== 2 || !Number.isFinite(Date.parse(generatedAt))) fail('EXPLICIT_SOURCE_EVIDENCE_REQUIRED');
  const operations = SPECS.map(spec => {
    const row = before.treatments.find(value => Number(value.id_tratamiento) === spec.id), config = row.clinical_config;
    const answer = evidence.answers.find(value => value.reference === spec.reference && value.source_row === spec.answer_row);
    if (!answer || !isSha(answer.row_sha256) || row.duracion_min !== null || config.booking_profile != null
      || config.source_client_surgical_profile || !Array.isArray(config.import_issues)) fail('UNMODIFIED_DRAFT_WITHOUT_PROFILE_REQUIRED');
    const afterConfig = { ...copy(config), booking_profile: profile(spec),
      import_issues: config.import_issues.filter(code => !['DURATION_REQUIRES_CONFIGURATION', 'INSTALLATION_INACTIVE'].includes(code)),
      source_client_surgical_profile: { version: 1, workbook_sha256: WORKBOOK_SHA, sheet: 'Tratamientos',
        source_row: spec.answer_row, row_sha256: answer.row_sha256, reference: spec.reference, recorded_at: generatedAt,
        operational_minutes: spec.minutes, team_reserved_for_full_intervention: true,
        ...(spec.id === 1994 ? { source_clock: '07:00–14:30', fixed_clock_enforced_by_profile: false }
          : { protocol_source_sha256: PROTOCOL_SHA, protocol_pdf_page: 41, protocol_page_sha256: PROTOCOL_PAGE_SHA }),
        clinical_approval: false, activation: false, prices_reinterpreted: false } };
    return { id: spec.id, code: spec.code, before_sha256: hash(row), config_sql_sha256: before.config_sql_sha256[spec.id],
      minutes: spec.minutes, after_config: afterConfig, after_config_sha256: hash(afterConfig) };
  });
  const body = { version: VERSION, target: 'crm', clinic_id: 66, group_id: 29, generated_at: generatedAt,
    source: info, evidence, before, before_sha256: hash(before), operations, policy: POLICY };
  return { ...body, plan_sha256: hash(body) };
}

function validatePlan(plan, info, evidence, configuration, { now = Date.now(), requireFresh = true } = {}) {
  if (plan?.version !== VERSION || plan.target !== 'crm' || plan.clinic_id !== 66 || plan.group_id !== 29
    || !equal(plan.source, info) || !equal(plan.evidence, evidence) || plan.before?.configuration_sha256 !== hash(configuration)
    || !equal(plan, makePlan({ before: plan.before, info, evidence, generatedAt: plan.generated_at }))) fail('PLAN_TAMPERED_OR_SOURCE_CHANGED');
  const generated = Date.parse(plan.generated_at);
  if (!Number.isFinite(generated) || generated > now || requireFresh && now - generated > 7200000) fail('PLAN_EXPIRED');
}

function verifyAfter(plan, state, mutationAt) {
  validateState(state);
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(mutationAt || '')) fail('MUTATION_TIMESTAMP_INVALID');
  const expected = { ...plan.before, treatments: plan.before.treatments.map(row => {
    const operation = plan.operations.find(op => Number(row.id_tratamiento) === op.id);
    return { ...row, duracion_min: operation.minutes, clinical_config: operation.after_config, updatedAt: mutationAt };
  }), config_sql_sha256: state.config_sql_sha256 };
  if (!equal(expected, state)) fail('POST_WRITE_OR_PROTECTED_STATE_CHANGED');
  return true;
}

function privateDestination(filename) {
  if (!path.isAbsolute(filename || '')) fail('PRIVATE_ARTIFACT_REQUIRED');
  const root = fs.realpathSync(PRIVATE_ROOT), parent = fs.realpathSync(path.dirname(filename));
  if (parent !== root && !parent.startsWith(root + path.sep)) fail('PRIVATE_ARTIFACT_REQUIRED');
  for (const directory of [root, parent]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail('PRIVATE_ARTIFACT_PERMISSIONS_INVALID');
  }
  return path.join(parent, path.basename(filename));
}
function privateJson(filename) {
  const resolved = privateDestination(filename), stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.nlink !== 1) fail('PRIVATE_INPUT_INVALID');
  return JSON.parse(readBytes(resolved));
}
async function independentCapture(configuration) {
  const c = await connectOperatorDatabase('crm');
  try { await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'); const state = await capture(c, configuration); await c.rollback(); return state; }
  finally { await c.end(); }
}

async function execute({ connection, plan, info, evidence, configuration, dryRun = false, backupPath, journal,
  captureState = capture, readIndependent = independentCapture, checkSource = source, checkEvidence,
  saveBackup = writePrivateJson }) {
  validatePlan(plan, info, evidence, configuration);
  if (typeof checkEvidence !== 'function') fail('FRESH_EVIDENCE_READER_REQUIRED');
  const [[lock]] = await connection.query('SELECT GET_LOCK(?,0) AS acquired', [LOCK_KEY]);
  if (Number(lock?.acquired) !== 1) fail('ANOTHER_EXECUTOR_ACTIVE');
  let inTransaction = false, commitAttempted = false;
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.beginTransaction(); inTransaction = true;
    const before = await captureState(connection, configuration, { lock: true });
    // An exact replay requires all three after images and unchanged protected
    // evidence. A partial/uncertain commit is never completed by blind retry.
    const replayTimes = [...new Set(before.treatments.map(row => row.updatedAt))];
    if (!equal(before, plan.before) && replayTimes.length === 1) {
      try {
        verifyAfter(plan, before, replayTimes[0]);
        if (!equal(checkSource(), info) || !equal(checkEvidence(), evidence)) fail('SOURCE_CHANGED');
        await connection.rollback(); inTransaction = false;
        const readback = await readIndependent(configuration);
        if (!equal(readback, before)) fail('REPLAY_READBACK_CHANGED');
        await journal.append({ phase: 'exact_replay_preserved_no_dml', after_sha256: hash(readback) });
        return { version: VERSION + ':receipt', status: 'replay_preserved', plan_sha256: plan.plan_sha256, source: info,
          mutation_at: replayTimes[0], after: readback, after_sha256: hash(readback), changed_rows: 0, replayed: 3, policy: POLICY };
      } catch (error) {
        if (!inTransaction) throw error;
        if (!/^BS_SURGICAL_POST_WRITE_OR_PROTECTED_STATE_CHANGED$/.test(error.message)) throw error;
      }
    }
    if (!equal(before, plan.before)) fail('PREPARED_STATE_DRIFT');
    const [[clock]] = await connection.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-%d %H:%i:%s') AS mutation_at");
    const mutationAt = clock?.mutation_at;
    if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(mutationAt || '')) fail('MUTATION_TIMESTAMP_INVALID');
    const backup = { version: VERSION + ':backup', target: 'crm', source: info, evidence, plan_sha256: plan.plan_sha256,
      generated_at: new Date().toISOString(), mutation_at: mutationAt, before, before_sha256: hash(before),
      restoration_policy: 'Restore only duration/config/updatedAt after exact after-image comparison. Never overwrite later edits or restore patient rows.' };
    saveBackup(backupPath, backup);
    await journal.append({ phase: 'backup_durable_before_mutation', backup_path: backupPath, backup_sha256: hash(backup), ids: SPECS.map(spec => spec.id) });
    if (!equal(checkSource(), info) || !equal(checkEvidence(), evidence)) fail('SOURCE_CHANGED_BEFORE_MUTATION');
    const [[ownership]] = await connection.query('SELECT IS_USED_LOCK(?)=CONNECTION_ID() AS owned', [LOCK_KEY]);
    if (Number(ownership?.owned) !== 1) fail('EXECUTOR_LOCK_LOST');
    await journal.append({ phase: 'before_three_profile_cas_only', mutation_at: mutationAt, appointments: before.appointments, policy: POLICY });
    for (const operation of plan.operations) {
      const row = before.treatments.find(value => Number(value.id_tratamiento) === operation.id);
      if (hash(row) !== operation.before_sha256) fail('EXACT_ROW_CAS_INVALID');
      const [result] = await connection.query('UPDATE Tratamientos SET duracion_min=?,clinical_config=?,updatedAt=? WHERE id_tratamiento=? AND clinica_id=66 AND codigo=? AND activo=0 AND duracion_min IS NULL AND updatedAt <=> ? AND SHA2(CAST(clinical_config AS CHAR),256)=?',
        [operation.minutes, JSON.stringify(operation.after_config), mutationAt, operation.id, operation.code, row.updatedAt, operation.config_sql_sha256]);
      if (Number(result?.affectedRows) !== 1) fail('EXACT_ROW_CAS_FAILED');
    }
    const after = await captureState(connection, configuration, { lock: true });
    verifyAfter(plan, after, mutationAt);
    if (!equal(checkSource(), info) || !equal(checkEvidence(), evidence)) fail('SOURCE_CHANGED_BEFORE_COMMIT');
    await journal.append({ phase: 'profiles_and_protected_state_verified_before_commit', mutation_at: mutationAt,
      after_sha256: hash(after), treatments: after.treatments, appointments: after.appointments });
    if (dryRun) {
      await connection.rollback(); inTransaction = false;
      const readback = await readIndependent(configuration);
      if (!equal(readback, before)) fail('ROLLBACK_OR_CONCURRENT_STATE_CHANGED');
      await journal.append({ phase: 'dry_run_rolled_back_and_independently_verified', snapshot_sha256: hash(readback) });
      return { version: VERSION + ':receipt', status: 'rolled_back_and_verified', plan_sha256: plan.plan_sha256, source: info,
        mutation_at: mutationAt, after, after_sha256: hash(after), final_sha256: hash(readback), changed_rows: 0, proposed: 3, policy: POLICY };
    }
    commitAttempted = true; await connection.commit(); inTransaction = false;
    await journal.append({ phase: 'committed', after_sha256: hash(after), changed_rows: 3 });
    const readback = await readIndependent(configuration);
    verifyAfter(plan, readback, mutationAt);
    if (!equal(after, readback)) fail('INDEPENDENT_READBACK_CHANGED');
    await journal.append({ phase: 'committed_and_independently_verified', after_sha256: hash(readback) });
    return { version: VERSION + ':receipt', status: 'committed_and_verified', plan_sha256: plan.plan_sha256, source: info,
      mutation_at: mutationAt, after: readback, after_sha256: hash(readback), changed_rows: 3, policy: POLICY };
  } catch (error) {
    if (inTransaction) await connection.rollback().catch(() => {});
    await journal.append({ phase: commitAttempted ? 'commit_outcome_requires_manual_review_no_replay' : 'rolled_back_no_commit_attempt',
      error_code: /^BS_SURGICAL_[A-Z_]+$/.test(error.message) ? error.message : 'BOUNDED_OPERATOR_FAILED' }).catch(() => {});
    if (commitAttempted) fail('COMMIT_RESULT_REQUIRES_PRIVATE_JOURNAL_REVIEW');
    throw error;
  } finally { await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_KEY]).catch(() => {}); }
}

function parseOptions(args) {
  const options = parseArgs(args, ['--mode', '--target', '--workbook', '--protocol-package', '--private-output', '--plan',
    '--approved-plan-sha256', '--private-backup', '--private-journal', '--receipt']);
  if (!['prepare', 'dry-run', 'apply', 'check'].includes(options['--mode']) || options['--target'] !== 'crm'
    || !options['--private-output'] || !options['--workbook'] || !options['--protocol-package']) fail('EXPLICIT_CRM_MODE_AND_SOURCES_REQUIRED');
  return options;
}
async function run(args) {
  const options = parseOptions(args), mode = options['--mode'];
  privateDestination(options['--private-output']);
  const info = source(), evidence = readEvidence(options['--workbook'], options['--protocol-package']), configuration = databaseOptions('crm');
  let plan;
  if (mode !== 'prepare') { plan = privateJson(options['--plan']); validatePlan(plan, info, evidence, configuration, { requireFresh: mode !== 'check' }); }
  if (['apply', 'dry-run'].includes(mode)) {
    if (options['--approved-plan-sha256'] !== plan.plan_sha256 || !options['--private-backup'] || !options['--private-journal']) fail('EXACT_APPROVAL_BACKUP_AND_JOURNAL_REQUIRED');
    const paths = [options['--private-output'], options['--private-backup'], options['--private-journal']].map(privateDestination);
    if (new Set(paths).size !== paths.length || paths.some(filename => fs.existsSync(filename))) fail('FRESH_DISTINCT_ARTIFACTS_REQUIRED');
  }
  const c = await connectOperatorDatabase('crm'); let journal;
  try {
    await c.query('SET SESSION lock_wait_timeout = 10');
    if (mode === 'prepare' || mode === 'check') {
      await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const state = await capture(c, configuration); validateState(state); await c.rollback();
      if (mode === 'prepare') {
        plan = makePlan({ before: state, info, evidence }); writePrivateJson(options['--private-output'], plan);
        return { status: 'prepared_read_only', plan_sha256: plan.plan_sha256, proposed: 3, policy: POLICY };
      }
      let status;
      if (options['--receipt']) {
        const receipt = privateJson(options['--receipt']);
        if (receipt.version !== VERSION + ':receipt' || !['committed_and_verified', 'replay_preserved'].includes(receipt.status)
          || receipt.plan_sha256 !== plan.plan_sha256 || !equal(receipt.source, info) || receipt.after_sha256 !== hash(receipt.after)
          || !equal(receipt.policy, POLICY)) fail('COMMITTED_RECEIPT_REQUIRED');
        verifyAfter(plan, state, receipt.mutation_at);
        if (!equal(receipt.after, state)) fail('RECEIPT_READBACK_CHANGED');
        status = 'checked_committed_read_only';
      } else { if (!equal(state, plan.before)) fail('PREPARED_STATE_CHANGED'); status = 'checked_unchanged_read_only'; }
      const proof = { version: VERSION + ':check', status, plan_sha256: plan.plan_sha256, snapshot_sha256: hash(state),
        checked_at: new Date().toISOString(), source: info, appointments: state.appointments, policy: POLICY };
      writePrivateJson(options['--private-output'], proof); return proof;
    }
    journal = newJournal(options['--private-journal'], plan.plan_sha256);
    const receipt = await execute({ connection: c, plan, info, evidence, configuration, dryRun: mode === 'dry-run',
      backupPath: options['--private-backup'], journal, checkEvidence: () => readEvidence(options['--workbook'], options['--protocol-package']) });
    try { writePrivateJson(options['--private-output'], receipt); }
    catch (error) { if (receipt.status === 'committed_and_verified') fail('COMMITTED_RECEIPT_WRITE_FAILED_REVIEW_PRIVATE_JOURNAL'); throw error; }
    return { status: receipt.status, plan_sha256: plan.plan_sha256, changed_rows: receipt.changed_rows, replayed: receipt.replayed || 0, policy: POLICY };
  } finally { journal?.close(); await c.end(); }
}
if (require.main === module) run(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
  process.stderr.write((/^BS_SURGICAL_[A-Z_]+$/.test(error.message) ? error.message : 'BS_SURGICAL_FAILED_REVIEW_PRIVATE_JOURNAL') + '\n');
  process.exitCode = 1;
});
module.exports = { VERSION, WORKBOOK_SHA, ORIGINAL_CATALOG_SHA, PROTOCOL_PACKAGE_SHA, PROTOCOL_SHA, PROTOCOL_PAGE_SHA,
  SPECS, PIN_FILES, POLICY, source, workbookEvidence, protocolEvidence, readEvidence, profile, capture, validateState,
  makePlan, validatePlan, verifyAfter, execute, parseOptions, run };

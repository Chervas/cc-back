#!/usr/bin/env node
'use strict';

// Operator-only future outbox reconciliation. No application model index,
// workers, scheduler, executions, Messages, appointment mutation or provider.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const S = require('sequelize');
const { hash } = require('../lib/cliniccloud-import/adapter');
const { databaseOptions } = require('../lib/cliniccloud-import/operator-database');
const { parseArgs, readBytes, writePrivateJson } = require('../lib/cliniccloud-import/io');
const { privateJson } = require('./cliniccloud-import-appointments-apply');
const { newJournal } = require('./program-commercial-schema-release');
const { readPolicy } = require('./appointment-reminder-sequence-release');
const policyLib = require('../lib/whatsappImportedAppointmentOperations');
const sequenceLib = require('../lib/appointment-reminder-sequence');
const { createAppointmentReminderSequenceService } = require('../services/appointmentReminderSequence.service');
const VERSION = 'appointment-reminder-future-outbox/1';
const ROOT = '/home/ubuntu/wt/back-dev';
const CLINICS = Object.freeze([66, 72]);
const GROUP = 29, LIMIT = 5000, TTL = 15 * 60000;
const UNTIL_LOCAL = null, UNTIL = null; // All future reservations, hard-bounded by LIMIT.
const TYPE = 'appointment_automation_schedule_fire', ORIGIN = 'appointment_automation_schedule', NAMESPACE = 'staging';
const ACTIVE = ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado', 'reprogramada'];
const JOB_ACTIVE = ['pending', 'waiting', 'queued', 'running'];
const FIELDS = ['id_cita', 'clinica_id', 'paciente_id', 'tratamiento_id', 'tipo_cita', 'estado', 'inicio', 'fin',
  'created_at', 'updated_at', 'source_system', 'source_reference', 'import_metadata', 'es_provisional', 'care_schedule_start',
  'hold_expires_at', 'titulo', 'motivo', 'arrived_at', 'care_started_at', 'care_completed_at', 'care_legacy_attendance'];
const FILES = ['src/services/appointmentAutomationV2Runtime.service.js', 'src/services/jobRequests.service.js',
  'src/lib/gatewayJobOwnership.js', 'src/lib/whatsappImportedAppointmentOperations.js', 'src/lib/whatsappAppointmentEligibility.js',
  'src/lib/whatsappAuthorizedBrokerClient.js', 'src/services/flowEngineV2.service.js', 'src/services/automationsV2Resume.service.js',
  'src/lib/appointment-reminder-sequence.js', 'src/services/appointmentReminderSequence.service.js',
  ...['citapaciente', 'clinica', 'tratamiento', 'automationflowcatalog', 'automationflowtemplatev2', 'jobrequest',
    'flowexecutionv2', 'flowexecutionlogv2', 'appointmentremindersequence', 'message', 'conversation'].map(file => 'models/' + file + '.js'),
  'migrations/20261014120000-create-appointment-reminder-sequences.js', 'src/scripts/appointment-reminder-sequence-reschedule.js'];
const LEDGER_FIELDS = {
  id: ['varchar(36)', 'NO'], clinic_id: ['int', 'NO'], patient_id: ['int', 'NO'], local_date: ['date', 'NO'],
  time_zone: ['varchar(64)', 'NO'], anchor_appointment_id: ['int', 'NO'], arrival_at: ['datetime(3)', 'NO'],
  claims: ['json', 'NO'], response_message_id: ['int', 'YES'], response_received_at: ['datetime(3)', 'YES'],
  attendance_confirmed_at: ['datetime(3)', 'YES'], created_at: ['datetime(3)', 'NO'], updated_at: ['datetime(3)', 'NO'] };
const fail = suffix => { throw Error('REMINDER_OUTBOX_' + suffix); };
const json = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => hash(json(a)) === hash(json(b));
const plain = row => json(row?.toJSON ? row.toJSON() : row);
const assertFuture = (value, now) => {
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at <= now) fail('FUTURE_WINDOW_EXPIRED');
};

function source() {
  if (process.cwd() !== ROOT || path.resolve(__dirname, '../..') !== ROOT
    || execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() !== 'dev'
    || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) fail('COMMITTED_CANONICAL_DEV_REQUIRED');
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    pins: Object.fromEntries(FILES.map(file => [file, hash(readBytes(path.join(ROOT, file)))])) };
}
function runtimeReady(proof, info, now = Date.now()) {
  if (proof?.version !== 'appointment-reminder-runtime-ready/1' || proof.target !== 'crm'
    || !/^[a-f0-9]{40}$/.test(proof.source_commit || '') || !Number.isFinite(Date.parse(proof.verified_at))
    || Date.parse(proof.verified_at) > now || now - Date.parse(proof.verified_at) > 7200000
    || ['schema_compatible', 'runtime_restarted', 'protected_gates_verified', 'no_manual_replay'].some(key => proof.checks?.[key] !== true)) fail('RUNTIME_PROOF_REQUIRED');
  for (const file of FILES.filter(file => !file.startsWith('src/scripts/'))) {
    const bytes = execFileSync('git', ['show', proof.source_commit + ':' + file], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
    if (hash(bytes) !== info.pins[file]) fail('DEPLOYED_RUNTIME_SOURCE_DIFFERS');
  }
}
function selectedModels(sql) {
  const db = { sequelize: sql, Sequelize: S };
  for (const file of ['citapaciente', 'clinica', 'tratamiento', 'automationflowcatalog', 'automationflowtemplatev2',
    'jobrequest', 'flowexecutionv2', 'flowexecutionlogv2', 'appointmentremindersequence', 'message', 'conversation']) {
    const model = require('../../models/' + file)(sql, S.DataTypes); db[model.name] = model;
  }
  return db; // Deliberately no associate(), sync(), app index or global env.
}
function standaloneDatabase(configuration) {
  const sql = new S.Sequelize(configuration.database, configuration.user, configuration.password, {
    host: configuration.host, port: configuration.port, dialect: 'mysql', timezone: '+00:00', logging: false,
    dialectOptions: { ...(configuration.ssl ? { ssl: configuration.ssl } : {}),
      ...(configuration.socketPath ? { socketPath: configuration.socketPath } : {}) },
    pool: { min: 0, max: 1, acquire: 15000, idle: 60000 } });
  sql.addHook('afterConnect', connection => new Promise((resolve, reject) => connection.query(
    'SET SESSION MAX_EXECUTION_TIME=15000, innodb_lock_wait_timeout=5, lock_wait_timeout=10', error => error ? reject(error) : resolve())));
  return sql;
}
function scopedModule(filename, overrides, now) {
  const local = createRequire(filename), module = { exports: {} };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Date: ClockDate,
    Buffer, Map, Set, Promise, Intl, console: { log() { fail('RUNTIME_SIDE_EFFECT'); }, warn() { fail('RUNTIME_SIDE_EFFECT'); }, error() { fail('RUNTIME_SIDE_EFFECT'); } },
    process: { env: { RUNTIME_ROLE: 'api', JOB_RUNTIME_NAMESPACE: NAMESPACE, RUNTIME_NAMESPACE: NAMESPACE,
      JOBS_WORKER_ENABLED: 'false', JOBS_CRON_LEADER: 'false', JOBS_AUTO_START: 'false' }, cwd: () => ROOT },
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) }, { filename });
  return module.exports;
}
function readonlyRuntime(db, policy, now) {
  const policySnapshot = { ...policyLib, read: () => policy };
  for (const key of ['allowsAppointment', 'allowsSameDayAppointment', 'allowsSuppressionOverride', 'permits', 'permitsSameDay', 'permitsPatientHoldOverride']) {
    policySnapshot[key] = (appointment, options) => policyLib[key](appointment, { ...options, policy, now });
  }
  const forbidden = () => fail('RUNTIME_SIDE_EFFECT');
  const file = path.resolve(__dirname, '../services/appointmentAutomationV2Runtime.service.js');
  const module = { exports: {} }, local = createRequire(file);
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const overrides = { '../../models': db, './jobRequests.service': new Proxy({}, { get: () => forbidden }),
    './jobScheduler.service': { triggerImmediate: forbidden }, './socket.service': { getIO: forbidden },
    '../lib/whatsappImportedAppointmentOperations': policySnapshot };
  const allowed = new Set(['../lib/whatsapp-template-locale', '../lib/appointment-template-scope', '../lib/review-automation-config',
    '../lib/appointment-care', '../lib/appointment-synthetic-guard', '../lib/whatsappSameDayRecovery', '../lib/whatsappImportedReminderRelease']);
  vm.runInNewContext(readBytes(file).toString('utf8') + '\nmodule.exports.__operatorReadonly = { importedTriggerHeld, shouldSuppressAppointmentTrigger };',
    { module, exports: module.exports, Date: ClockDate, Intl, Map, Set, Promise, process: { env: {} },
      require: name => Object.hasOwn(overrides, name) ? overrides[name] : allowed.has(name) ? local(name) : forbidden() }, { filename: file });
  return module.exports;
}
function nativeJobs(db, now) {
  const ownership = require('../lib/gatewayJobOwnership');
  const env = { RUNTIME_ROLE: 'api', JOB_RUNTIME_NAMESPACE: NAMESPACE };
  return scopedModule(path.resolve(__dirname, '../services/jobRequests.service.js'), { '../../models': db,
    '../lib/gatewayJobOwnership': { ...ownership, resolveEnqueueRuntimeNamespace: (current, requested) =>
      ownership.resolveEnqueueRuntimeNamespace(current, requested, env) } }, now);
}
async function databaseGuard(db, transaction, expectedName) {
  const [[identity]] = await db.sequelize.query('SELECT DATABASE() AS database_name,CURRENT_USER() AS database_user,@@hostname AS server_name', { transaction });
  if (identity.database_name !== expectedName) fail('DATABASE_SCOPE_INVALID');
  const [tables] = await db.sequelize.query(`SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME IN ('JobRequests','CitasPacientes','AppointmentReminderSequences') ORDER BY TABLE_NAME`, { transaction });
  if (tables.length !== 3 || tables.some(row => row.ENGINE !== 'InnoDB')) fail('ATOMIC_INNODB_LEDGER_REQUIRED');
  const [triggers] = await db.sequelize.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='JobRequests'", { transaction });
  if (triggers.length) fail('JOB_SIDE_EFFECT_TRIGGER_FORBIDDEN');
  const [columns] = await db.sequelize.query(`SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA,GENERATION_EXPRESSION
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='AppointmentReminderSequences'
    ORDER BY ORDINAL_POSITION`, { transaction });
  if (!equal(columns.map(row => row.COLUMN_NAME), Object.keys(LEDGER_FIELDS)) || columns.some(row => {
    const [type, nullable] = LEDGER_FIELDS[row.COLUMN_NAME] || [];
    return String(row.COLUMN_TYPE).replace(/^int\(11\)$/, 'int') !== type || row.IS_NULLABLE !== nullable
      || row.EXTRA || row.GENERATION_EXPRESSION;
  })) fail('LEDGER_SCHEMA_CHANGED');
  const [indexes] = await db.sequelize.query(`SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='AppointmentReminderSequences'
    ORDER BY INDEX_NAME,SEQ_IN_INDEX`, { transaction });
  const unique = indexes.filter(row => row.INDEX_NAME === 'ars_patient_clinic_day');
  if (!equal(unique.map(row => row.COLUMN_NAME), ['patient_id', 'clinic_id', 'local_date'])
    || unique.some(row => Number(row.NON_UNIQUE) !== 0 || row.SUB_PART != null || row.INDEX_TYPE !== 'BTREE')) fail('UNIQUE_DAY_SCHEMA_REQUIRED');
  const [[registered]] = await db.sequelize.query("SELECT COUNT(*) AS present FROM SequelizeMeta WHERE name='20261014120000-create-appointment-reminder-sequences.js'", { transaction });
  if (Number(registered.present) !== 1) fail('LEDGER_MIGRATION_UNREGISTERED');
  const clinics = await db.Clinica.findAll({ where: { id_clinica: { [S.Op.in]: CLINICS } },
    attributes: ['id_clinica', 'grupoClinicaId', 'configuracion'], order: [['id_clinica', 'ASC']], transaction, raw: true });
  if (clinics.length !== 2 || clinics.some(row => Number(row.grupoClinicaId) !== GROUP)) fail('BS_GROUP_SCOPE_INVALID');
  return { identity_sha256: hash(identity), ledger_schema_sha256: hash({ columns, indexes }), clinics: plain(clinics) };
}
async function capture({ db, policy, asOf, configuration, transaction, lock = false }) {
  const at = Date.parse(asOf);
  policyLib.validate(policy, { now: at });
  if (policy.sameDayAllowed !== true) fail('AUTHORIZED_SAME_DAY_RUNTIME_REQUIRED');
  if (!Number.isFinite(at)) fail('AS_OF_INVALID');
  const guard = await databaseGuard(db, transaction, configuration.database);
  const rows = await db.CitaPaciente.findAll({ where: { clinica_id: { [S.Op.in]: CLINICS },
    inicio: { [S.Op.gt]: new Date(at) }, estado: { [S.Op.in]: ACTIVE } },
    attributes: FIELDS, order: [['id_cita', 'ASC']], limit: LIMIT + 1, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (rows.length > LIMIT) fail('BOUNDED_FUTURE_LIMIT_EXCEEDED');
  const appointments = rows.map(plain).filter(row => !sequenceLib.placeholder(row)
    && policyLib.allowsSameDayAppointment(row, { policy, now: at })
    && require('../lib/appointment-care').allowsAppointmentAutomation(row, 'appointment_reminder_window'));
  const ids = appointments.map(row => row.id_cita);
  const jobs = ids.length ? (await db.JobRequest.findAll({ where: { type: TYPE, origin: ORIGIN,
    status: { [S.Op.in]: JOB_ACTIVE }, [S.Op.and]: db.Sequelize.literal(`CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.appointment_id')) AS UNSIGNED) IN (${ids.join(',')})
      AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.trigger_type'))='appointment_reminder_window'`) },
    order: [['id', 'ASC']], limit: LIMIT * 4 + 1, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) })).map(plain) : [];
  if (jobs.length > LIMIT * 4) fail('BOUNDED_JOB_LIMIT_EXCEEDED');
  const runtime = readonlyRuntime(db, policy, at), daily = createAppointmentReminderSequenceService({ db, now: () => new Date(at) });
  const desired = [], days = [], templates = [], reviews = [];
  for (const row of appointments) {
    const day = await daily.inspectAppointment({ appointment: row, transaction });
    days.push({ appointment_id: row.id_cita, anchor_id: day.anchor_appointment_id, arrival_at: day.arrival_at,
      key: day.key, local_date: day.scope.local_date, time_zone: day.scope.time_zone,
      attendance_confirmed: day.attendanceConfirmed, claims: day.sequence ? sequenceLib.claims(day.sequence.claims) : {} });
    if (day.follower) continue;
    const selected = await runtime.resolveScheduledTemplatesForCita(row, 'appointment_reminder_window', { transaction });
    for (const template of selected) {
      const config = runtime.getTemplateTriggerConfig(template), frozen = plain(template);
      templates.push({ appointment_id: row.id_cita, template: frozen });
      if (runtime.__operatorReadonly.importedTriggerHeld(row, template)
        || runtime.__operatorReadonly.shouldSuppressAppointmentTrigger(row, 'appointment_reminder_window', config)) continue;
      if (!['week_before', 'day_before', 'same_day'].includes(config.schedule_moment)) fail('UNKNOWN_REMINDER_STAGE');
      const claim = day.sequence && sequenceLib.claims(day.sequence.claims)[config.schedule_moment];
      if (claim?.attempted) continue;
      const scheduled = runtime.computeScheduledRunAt({ cita: row, triggerType: 'appointment_reminder_window', triggerConfig: config,
        timeZone: day.scope.time_zone, pastWindowGraceMs: 0 });
      if (!scheduled || +scheduled <= at) continue;
      desired.push({ appointment_id: row.id_cita, patient_id: row.paciente_id, clinic_id: row.clinica_id,
        local_date: day.scope.local_date, stage: config.schedule_moment, template_version_id: Number(template.id),
        template_key: template.template_key, scheduled_for: scheduled.toISOString(),
        window_identifier: runtime.buildScheduledWindowIdentifier({ triggerType: 'appointment_reminder_window', triggerConfig: config, scheduledFor: scheduled }) });
    }
  }
  const actions = [];
  for (const day of days) {
    const scoped = jobs.filter(job => Number(job.payload?.appointment_id) === day.appointment_id);
    for (const job of scoped) {
      if (day.anchor_id === day.appointment_id) continue; // Never reinterpret/retire owner's old delivery rights here.
      if (job.payload?.__runtime_namespace !== NAMESPACE) {
        reviews.push({ job_id: job.id, reason: 'follower_job_namespace_not_owned' }); continue;
      }
      if (!['waiting', 'pending'].includes(job.status) || Number(job.attempts) !== 0 || job.last_attempt_at
        || !job.next_run_at || Date.parse(job.next_run_at) <= at) {
        reviews.push({ job_id: job.id, reason: 'follower_job_not_definitely_unattempted_future' }); continue;
      }
      actions.push({ kind: 'cancel_follower', job_id: job.id, appointment_id: day.appointment_id,
        expected_sha256: hash(job), next_run_at: job.next_run_at, reason: 'appointment_day_uses_first_arrival' });
    }
  }
  for (const intent of desired) {
    const matching = jobs.filter(job => Number(job.payload?.appointment_id) === intent.appointment_id
      && job.payload?.template_key === intent.template_key && job.payload?.window_identifier === intent.window_identifier
      && (!job.payload?.__runtime_namespace || job.payload.__runtime_namespace === NAMESPACE));
    if (matching.length) continue;
    const dedupe_scope = 'appointment-day-schedule:' + hash([intent.clinic_id, intent.patient_id, intent.local_date,
      intent.stage, intent.template_key, intent.window_identifier]);
    actions.push({ kind: 'create_future', ...intent, dedupe_scope });
  }
  return json({ guard, appointments, jobs, days, templates, desired, reviews, actions });
}
function makePlan({ snapshot, source: info, configuration, policyProof, asOf }) {
  return { version: VERSION, target: 'crm', generated_at: asOf, scope: { clinic_ids: CLINICS, group_id: GROUP,
    until_local: UNTIL_LOCAL, time_zone: 'Europe/Madrid', limit: LIMIT, future_only: true },
    source: info, configuration_sha256: hash(configuration), policy_sha256: hash(policyProof), snapshot,
    snapshot_sha256: hash(snapshot), actions_sha256: hash(snapshot.actions),
    summary: { candidates: snapshot.appointments.length, desired_future: snapshot.desired.length,
      cancel_followers: snapshot.actions.filter(row => row.kind === 'cancel_follower').length,
      create_future: snapshot.actions.filter(row => row.kind === 'create_future').length, reviews: snapshot.reviews.length } };
}
function validatePlan(plan, info, configuration, policyProof, now = Date.now()) {
  if (plan?.version !== VERSION || plan.target !== 'crm' || !equal(plan.source, info)
    || plan.configuration_sha256 !== hash(configuration) || plan.policy_sha256 !== hash(policyProof)
    || plan.snapshot_sha256 !== hash(plan.snapshot) || plan.actions_sha256 !== hash(plan.snapshot.actions)
    || !Number.isFinite(Date.parse(plan.generated_at)) || Date.parse(plan.generated_at) > now
    || now - Date.parse(plan.generated_at) > TTL || !equal(plan.scope, { clinic_ids: CLINICS, group_id: GROUP,
      until_local: UNTIL_LOCAL, time_zone: 'Europe/Madrid', limit: LIMIT, future_only: true })) fail('PLAN_INVALID_OR_DRIFTED');
  for (const action of plan.snapshot.actions) {
    if (!['cancel_follower', 'create_future'].includes(action.kind)) fail('ACTION_FORBIDDEN');
    assertFuture(action.kind === 'create_future' ? action.scheduled_for : action.next_run_at, now);
  }
}
async function applyPlan({ db, plan, info, configuration, policyProof, journal, backupPath,
  saveBackup = writePrivateJson, now = Date.now(), refreshSource = source, refreshPolicy = readPolicy }) {
  validatePlan(plan, info, configuration, policyProof, now);
  let namedLock = false;
  try {
    const [[locked]] = await db.sequelize.query("SELECT GET_LOCK('cc-reminder-future-outbox:crm',0) AS acquired");
    if (Number(locked.acquired) !== 1) fail('ANOTHER_OPERATOR_ACTIVE');
    namedLock = true;
    const result = await db.sequelize.transaction({ isolationLevel: 'SERIALIZABLE' }, async transaction => {
      const current = await capture({ db, policy: policyProof.policy, asOf: plan.generated_at, configuration, transaction, lock: true });
      if (!equal(current, plan.snapshot)) fail('SNAPSHOT_CHANGED_BEFORE_APPLY');
      const [[owner]] = await db.sequelize.query("SELECT CONNECTION_ID() AS connection_id,IS_USED_LOCK('cc-reminder-future-outbox:crm') AS lock_owner", { transaction });
      if (Number(owner.connection_id) !== Number(owner.lock_owner)) fail('ADVISORY_SESSION_CHANGED');
      validatePlan(plan, refreshSource(), configuration, refreshPolicy(), Date.now());
      saveBackup(backupPath, { version: VERSION + ':backup', plan_sha256: hash(plan),
        generated_at: new Date().toISOString(), before_jobs: current.jobs, source: info, summary: plan.summary });
      await journal.append({ phase: 'future_job_before_images_durable', backup_path: backupPath, backup_sha256: hash(current.jobs) });
      const jobs = nativeJobs(db, Date.now()), created = [], cancelled = [];
      for (const action of current.actions) {
        assertFuture(action.kind === 'create_future' ? action.scheduled_for : action.next_run_at, Date.now());
        if (action.kind === 'cancel_follower') {
          const row = await db.JobRequest.findByPk(action.job_id, { transaction, lock: transaction.LOCK.UPDATE });
          if (!row || hash(plain(row)) !== action.expected_sha256) fail('JOB_CAS_CHANGED');
          await row.update({ status: 'cancelled', next_run_at: null, completed_at: new Date(), error_message: action.reason }, { transaction, hooks: false });
          cancelled.push(Number(row.id));
        } else {
          const result = await jobs.enqueueUniqueJobRequest({ type: TYPE, priority: 'high', status: 'waiting', origin: ORIGIN,
            payload: { appointment_id: action.appointment_id, trigger_type: 'appointment_reminder_window', template_key: action.template_key,
              window_identifier: action.window_identifier, scheduled_for: action.scheduled_for },
            requestedBy: null, requestedByRole: 'system', dedupeScope: action.dedupe_scope, nextRunAt: new Date(action.scheduled_for) },
          { transaction, transactionRetries: 1 });
          if (!result.created) fail('UNEXPECTED_EXISTING_UNIQUE_OUTBOX');
          created.push(Number(result.job.id));
        }
      }
      await journal.append({ phase: 'future_jobs_verified_before_commit', created_ids: created, cancelled_ids: cancelled });
      return { created, cancelled };
    });
    await journal.append({ phase: 'future_jobs_committed', ...result });
    return { success: true, created: result.created.length, cancelled: result.cancelled.length, reviews: plan.summary.reviews };
  } finally { if (namedLock) await db.sequelize.query("SELECT RELEASE_LOCK('cc-reminder-future-outbox:crm') AS released"); }
}
async function run(args) {
  const options = parseArgs(args, ['--mode', '--target', '--private-plan', '--approved-plan-sha256', '--private-backup', '--private-journal', '--runtime-proof']);
  if (!['prepare', 'apply'].includes(options['--mode']) || options['--target'] !== 'crm' || !options['--private-plan'] || !options['--runtime-proof']) fail('EXPLICIT_MODE_CRM_PLAN_AND_PROOF_REQUIRED');
  const info = source(), configuration = databaseOptions('crm'), policyProof = readPolicy();
  runtimeReady(privateJson(options['--runtime-proof']), info);
  if (!policyProof.policy.sameDayAllowed) fail('AUTHORIZED_SAME_DAY_RUNTIME_REQUIRED');
  const sql = standaloneDatabase(configuration), db = selectedModels(sql); let journal;
  try {
    await sql.authenticate();
    if (options['--mode'] === 'prepare') {
      const started = Date.now(), asOf = new Date(started).toISOString();
      // Sequelize's readOnly flag chooses the read pool but does not emit the
      // MySQL READ ONLY clause. Enforce it on this dedicated one-connection pool.
      await sql.query('SET SESSION TRANSACTION READ ONLY');
      const snapshot = await sql.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, transaction =>
        capture({ db, policy: policyProof.policy, asOf, configuration, transaction }));
      const plan = makePlan({ snapshot, source: info, configuration, policyProof, asOf });
      writePrivateJson(options['--private-plan'], plan);
      return { success: true, plan_sha256: hash(plan), prepare_elapsed_ms: Date.now() - started, summary: plan.summary };
    }
    await sql.query('SET SESSION TRANSACTION READ WRITE');
    const plan = privateJson(options['--private-plan']);
    if (hash(plan) !== options['--approved-plan-sha256'] || !options['--private-backup'] || !options['--private-journal']) fail('EXPLICIT_APPROVED_PLAN_AND_BACKUP_REQUIRED');
    journal = newJournal(options['--private-journal'], hash(plan));
    return await applyPlan({ db, plan, info, configuration, policyProof, journal, backupPath: options['--private-backup'] });
  } finally { try { journal?.close(); } finally { await sql.close(); } }
}
module.exports = { VERSION, CLINICS, GROUP, LIMIT, TTL, UNTIL, TYPE, ORIGIN, NAMESPACE, source, runtimeReady,
  selectedModels, standaloneDatabase, readonlyRuntime, nativeJobs, databaseGuard, capture, makePlan, validatePlan, applyPlan, run };
if (require.main === module) run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(/^REMINDER_OUTBOX_[A-Z_]+$/.test(error.message) ? error.message : 'REMINDER_OUTBOX_FAILED_INSPECT_PRIVATE_JOURNAL');
  process.exitCode = 1;
});

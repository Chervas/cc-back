'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('sequelize');
const operator = require('../appointment-reminder-sequence-reschedule');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createAppointmentReminderSequenceService } = require('../../services/appointmentReminderSequence.service');
const migration = require('../../../migrations/20261014120000-create-appointment-reminder-sequences');

const policy = { version: 1, purpose: 'appointment_operations', approvedBy: 1, approvalRef: 'owned_operator_fixture',
  approvedAt: '2026-07-01T00:00:00.000Z', clinicIds: [66, 72], sameDayAllowed: true, automaticBacklogReplay: false };
const proof = { policy, file: 'owned_fixture_policy', sha256: hash(policy) };
const info = { commit: 'f'.repeat(40), pins: { owned_fixture: 'a'.repeat(64) } };
const configuration = { database: 'campaign_optimization_qa' };
const clone = value => JSON.parse(JSON.stringify(value));
const bare = () => ({ appointments: [], desired: [], reviews: [], jobs: [], actions: [] });
function prepared(snapshot, at = new Date().toISOString()) {
  return operator.makePlan({ snapshot, source: info, configuration, policyProof: proof, asOf: at });
}

test('operator requires fresh exact pins, future actions and fixed all-future BS scope', () => {
  const now = Date.now(), at = new Date(now).toISOString();
  const valid = prepared(bare(), at);
  operator.validatePlan(valid, info, configuration, proof, now);
  assert.equal(valid.scope.until_local, null);
  assert.equal(valid.scope.future_only, true);
  assert.throws(() => operator.validatePlan(valid, { ...info, commit: 'e'.repeat(40) }, configuration, proof, now), /PLAN_INVALID/);
  assert.throws(() => operator.validatePlan(valid, info, configuration, { ...proof, policy: { ...policy, sameDayAllowed: false } }, now), /PLAN_INVALID/);
  assert.throws(() => operator.validatePlan(valid, info, configuration, proof, now + operator.TTL + 1), /PLAN_INVALID/);
  const tampered = clone(valid); tampered.snapshot.jobs.push({ id: 1 });
  assert.throws(() => operator.validatePlan(tampered, info, configuration, proof, now), /PLAN_INVALID/);
  const bad = prepared({ ...bare(), actions: [{ kind: 'send_now' }] }, at);
  assert.throws(() => operator.validatePlan(bad, info, configuration, proof, now), /ACTION_FORBIDDEN/);
  const due = prepared({ ...bare(), actions: [{ kind: 'create_future', scheduled_for: at }] }, at);
  assert.throws(() => operator.validatePlan(due, info, configuration, proof, now), /FUTURE_WINDOW_EXPIRED/);
  const wrongScope = clone(valid); wrongScope.scope.clinic_ids = [66];
  assert.throws(() => operator.validatePlan(wrongScope, info, configuration, proof, now), /PLAN_INVALID/);
  assert.throws(() => operator.runtimeReady({ version: 'appointment-reminder-runtime-ready/1', target: 'crm',
    source_commit: 'f'.repeat(40), verified_at: at, checks: { schema_compatible: true } }, info, now), /RUNTIME_PROOF/);
});

test('native standalone planner changes only definitely unattempted future canonical JobRequests',
  { skip: process.env.APPOINTMENT_REMINDER_RESCHEDULE_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql: fixtureSql, report }) => {
      const sql = operator.standaloneDatabase({ ...configuration, user: 'root', password: '', host: 'localhost',
        socketPath: fixtureSql.options.dialectOptions.socketPath });
      try {
      const D = S.DataTypes;
      // Actual selected factories, no application index, association wiring or worker.
      const db = operator.selectedModels(sql);
      db.Paciente = sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true }, import_metadata: D.JSON },
        { tableName: 'Pacientes', timestamps: false });
      sql.define('OwnedLeadParent', { id: { type: D.INTEGER, primaryKey: true } }, { tableName: 'LeadIntakes', timestamps: false });
      const meta = sql.define('OwnedMigrationMeta', { name: { type: D.STRING, primaryKey: true } }, { tableName: 'SequelizeMeta', timestamps: false });
      sql.modelManager.removeModel(db.AppointmentReminderSequence);
      delete sql.models.AppointmentReminderSequence;
      await sql.sync();
      await migration.up(sql.getQueryInterface(), S);
      await meta.create({ name: '20261014120000-create-appointment-reminder-sequences.js' });
      db.AppointmentReminderSequence = require('../../../models/appointmentremindersequence')(sql, D);
      await db.Clinica.bulkCreate([{ id_clinica: 66, grupoClinicaId: 29, configuracion: { timezone: 'Europe/Madrid' } },
        { id_clinica: 72, grupoClinicaId: 29, configuracion: { timezone: 'Europe/Madrid' } }]);
      await db.Paciente.bulkCreate(Array.from({ length: 8 }, (_, i) => ({ id_paciente: i + 1,
        import_metadata: { automation_policy: 'hold', provenance: 'owned_fictitious_fixture' } })));
      const at = new Date().toISOString(), future = '2030-01-09T18:00:00.000Z';
      const template = async (key, moment, patch = {}) => db.AutomationFlowTemplateV2.create({ public_id: key,
        template_key: key, version: 1, name: 'Owned reminder fixture', trigger_type: 'appointment_reminder_window',
        trigger_config: { schedule_moment: moment, schedule_time_mode: 'custom', custom_time: '09:00' },
        clinic_id: null, group_id: 29, entry_node_id: 'entry', nodes: [], created_by: 1, published_at: '2026-07-01', ...patch });
      await template('fixture_group_day', 'day_before');
      await template('fixture_group_same', 'same_day');
      await template('fixture_group_week', 'week_before');
      await template('fixture_clinic_day', 'day_before', { clinic_id: 66, group_id: null });
      const clinicSame = await template('fixture_clinic_same', 'same_day', { clinic_id: 66, group_id: null });
      await db.AutomationFlowCatalog.create({ name: 'owned_fixture', template_key: 'fixture_group_day',
        trigger_type: 'appointment_reminder_window', is_default_for_trigger: true, steps: [] });
      await db.Tratamiento.create({ id_tratamiento: 1, nombre: 'Owned fixture treatment', disciplina: 'general' });
      await db.Tratamiento.create({ id_tratamiento: 2, nombre: 'Owned disabled treatment', disciplina: 'general',
        automation_template_bindings: { appointment_before: { disabled: true } } });
      const appointment = (id, patient, patch = {}) => db.CitaPaciente.create({ id_cita: id, paciente_id: patient,
        clinica_id: 66, inicio: future, fin: '2030-01-09T18:30:00.000Z', created_at: '2026-07-01',
        estado: 'info_confirmada', import_metadata: {}, ...patch });
      const first = await appointment(101, 1, { source_system: 'cliniccloud', source_reference: 'owned:extraction',
        import_metadata: { cliniccloud_reconciliation: { automation_policy: 'hold' }, notification_suppression:
          { appointment_details: true, day_before: true, same_day: true } } });
      const follower = await appointment(102, 1, { inicio: '2030-01-09T18:15:00.000Z', fin: '2030-01-09T18:45:00.000Z' });
      await appointment(201, 2, { tratamiento_id: 1 });
      await appointment(301, 3, { tratamiento_id: 2 });
      await appointment(401, 4, { import_metadata: { automation_policy: 'hold', notification_suppression: { day_before: true, same_day: true } } });
      await appointment(501, 5, { source_system: 'cliniccloud', titulo: 'Histórico: actividad importada' });
      await appointment(601, 6, { inicio: new Date(Date.now() + 3600000), fin: new Date(Date.now() + 5400000) });
      await appointment(701, 7, { clinica_id: 72 });
      const rawJob = (appointmentId, extra = {}) => db.JobRequest.create({ type: operator.TYPE, origin: operator.ORIGIN,
        status: 'waiting', payload: { appointment_id: appointmentId, trigger_type: 'appointment_reminder_window',
          template_key: 'old_fixture', window_identifier: 'old_fixture', __runtime_namespace: 'staging' },
        next_run_at: '2030-01-08T08:00:00.000Z', ...extra });
      const followerWaiting = await rawJob(102);
      const followerAttempted = await rawJob(102, { attempts: 1, last_attempt_at: at });
      const followerRunning = await rawJob(102, { status: 'running' });
      const followerForeign = await rawJob(102, { payload: { appointment_id: 102, trigger_type: 'appointment_reminder_window', __runtime_namespace: 'dev' } });
      const followerUnscoped = await rawJob(102, { payload: { appointment_id: 102, trigger_type: 'appointment_reminder_window' } });
      const aftercare = await rawJob(102, { payload: { appointment_id: 102, trigger_type: 'appointment_after', __runtime_namespace: 'staging' } });
      const manual = await rawJob(102, { origin: 'manual' });
      const originalAppointments = (await db.CitaPaciente.findAll({ order: [['id_cita', 'ASC']], raw: true })).map(clone);
      const originalPatients = (await db.Paciente.findAll({ order: [['id_paciente', 'ASC']], raw: true })).map(clone);
      const count = async () => ({ messages: await db.Message.count(), executions: await db.FlowExecutionV2.count(),
        ledger: await db.AppointmentReminderSequence.count() });
      const originalProtected = await count();
      const prepare = async () => sql.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, transaction =>
        operator.capture({ db, policy, asOf: at, configuration, transaction }));
      await sql.query('SET SESSION TRANSACTION READ ONLY');
      const snapshot = await prepare();
      // Real SQL readonly session denies writes, not merely Sequelize's pool-routing flag.
      await assert.rejects(sql.transaction(transaction => db.JobRequest.create({ type: 'owned_probe', origin: 'owned', payload: {} }, { transaction })), /READ ONLY/i);
      await sql.query('SET SESSION TRANSACTION READ WRITE');
      assert.equal(snapshot.days.find(row => row.appointment_id === 102).anchor_id, 101);
      assert(snapshot.desired.every(row => row.appointment_id !== 102));
      assert(snapshot.desired.some(row => row.appointment_id === 101 && row.stage === 'same_day'));
      assert(snapshot.desired.some(row => row.appointment_id === 201 && row.template_key === clinicSame.template_key));
      assert(snapshot.desired.some(row => row.appointment_id === 101 && row.template_key === 'fixture_clinic_day'));
      assert.deepEqual(snapshot.desired.filter(row => [301, 401, 501, 601].includes(row.appointment_id)), [], 'disabled, manual, historical and already-past windows excluded');
      assert.equal(snapshot.actions.filter(row => row.kind === 'cancel_follower').length, 1);
      assert.equal(snapshot.actions.find(row => row.kind === 'cancel_follower').job_id, followerWaiting.id);
      assert.equal((await db.JobRequest.findByPk(followerWaiting.id)).status, 'waiting');
      assert.deepEqual(await count(), originalProtected);
      report.checks.push('actual standalone factories plus actual runtime selector honor clinic defaults and disabled treatment slot, all-future native/imported appointments, first extraction arrival, manual HOLD and no retroactive windows; prepare makes no writes');

      // Existing owner jobs, including unscoped legacy jobs, are retained as-is.
      const intent = snapshot.desired.find(row => row.appointment_id === 101 && row.stage === 'day_before');
      const owner = await rawJob(101, { payload: { appointment_id: 101, trigger_type: 'appointment_reminder_window',
        template_key: intent.template_key, window_identifier: intent.window_identifier }, next_run_at: intent.scheduled_for });
      const frozen = await prepare();
      assert(!frozen.actions.some(row => row.kind === 'create_future' && row.appointment_id === 101 && row.stage === 'day_before'));
      const plan = prepared(frozen, at), journalEvents = [], backups = [];
      const applyOptions = { db, plan, info, configuration, policyProof: proof, refreshSource: () => info, refreshPolicy: () => proof };
      const lockConnection = await fixtureSql.connectionManager.getConnection({ type: 'WRITE' });
      const lockedQuery = command => new Promise((resolve, reject) => lockConnection.query(command, (error, rows) => error ? reject(error) : resolve(rows)));
      try {
        await lockedQuery("SELECT GET_LOCK('cc-reminder-future-outbox:crm',0)");
        await assert.rejects(operator.applyPlan({ ...applyOptions, journal: { append: async () => {} },
          backupPath: 'never', saveBackup: () => assert.fail('second operator must not mutate') }), /ANOTHER_OPERATOR_ACTIVE/);
      } finally {
        await lockedQuery("SELECT RELEASE_LOCK('cc-reminder-future-outbox:crm')");
        await fixtureSql.connectionManager.releaseConnection(lockConnection);
      }
      await assert.rejects(operator.applyPlan({ ...applyOptions, refreshSource: () => ({ ...info, commit: 'e'.repeat(40) }),
        journal: { append: async () => {} }, backupPath: 'never', saveBackup: () => assert.fail('source drift must not mutate') }), /PLAN_INVALID/);
      await assert.rejects(operator.applyPlan({ ...applyOptions, refreshPolicy: () => ({ ...proof, policy: { ...policy, sameDayAllowed: false } }),
        journal: { append: async () => {} }, backupPath: 'never', saveBackup: () => assert.fail('policy revocation must not mutate') }), /PLAN_INVALID/);
      report.checks.push('actual standalone pool1 enforces MySQL READ ONLY prepare; separate native connection cannot acquire operator lock; changed source or revoked same-day policy aborts before backup and DML');
      const result = await operator.applyPlan({ ...applyOptions,
        journal: { append: async item => journalEvents.push(item) }, backupPath: 'owned_memory_backup',
        saveBackup: (name, backup) => backups.push({ name, backup }) });
      assert.equal(result.cancelled, 1); assert(result.created > 0);
      assert.equal(backups.length, 1); assert(backups[0].backup.before_jobs.some(row => row.id === followerWaiting.id));
      assert.deepEqual(journalEvents.map(row => row.phase), ['future_job_before_images_durable', 'future_jobs_verified_before_commit', 'future_jobs_committed']);
      assert.equal((await followerWaiting.reload()).status, 'cancelled');
      for (const kept of [followerAttempted, followerRunning, followerForeign, followerUnscoped, aftercare, manual, owner])
        assert.notEqual((await kept.reload()).status, 'cancelled');
      const generated = await db.JobRequest.findAll({ where: { id: { [S.Op.gt]: owner.id } }, raw: true });
      for (const row of generated) {
        assert.equal(row.status, 'waiting'); assert.equal(row.attempts, 0);
        assert.equal(row.payload.__runtime_namespace, 'staging');
        assert(row.payload.__dedupe_scope, 'native unique outbox carries dedupe scope');
        assert(Date.parse(row.next_run_at) > Date.now());
      }
      assert.deepEqual((await db.CitaPaciente.findAll({ order: [['id_cita', 'ASC']], raw: true })).map(clone), originalAppointments);
      assert.deepEqual((await db.Paciente.findAll({ order: [['id_paciente', 'ASC']], raw: true })).map(clone), originalPatients);
      assert.deepEqual(await count(), originalProtected);
      assert.equal((await prepare()).actions.length, 0, 'repeated prepare has no creation or cancellation action');
      await assert.rejects(operator.applyPlan({ ...applyOptions,
        journal: { append: async () => {} }, backupPath: 'never', saveBackup: () => assert.fail('drift must abort before backup') }), /SNAPSHOT_CHANGED/);
      report.checks.push('native SERIALIZABLE outbox commits only one definite future follower cancellation plus future waiting owners; attempted/running/foreign/unscoped/manual/aftercare and existing owner jobs retained; no Cita, patient HOLD, ledger, Message or execution mutation; repeat plan is empty and stale CAS refuses');

      // Forced durable-journal failure must roll back all JobRequests DML.
      await appointment(801, 8);
      const rollbackPlan = prepared(await prepare(), at), beforeRollback = await db.JobRequest.count();
      await assert.rejects(operator.applyPlan({ ...applyOptions, plan: rollbackPlan,
        journal: { append: async event => { if (event.phase === 'future_jobs_verified_before_commit') throw Error('owned_forced_journal_failure'); } },
        backupPath: 'owned_rollback', saveBackup: () => {} }), /owned_forced_journal_failure/);
      assert.equal(await db.JobRequest.count(), beforeRollback);
      report.checks.push('journal failure before transaction commit rolls back every inserted future job, no partial release');

      // SQL boolean projection 0 is not provider attempt proof.
      const reserve = await appointment(802, 8, { inicio: '2030-01-10T18:00:00.000Z', fin: '2030-01-10T18:30:00.000Z' });
      const daily = createAppointmentReminderSequenceService({ db });
      const execution = await db.FlowExecutionV2.create({ idempotency_key: 'owned_unattempted', template_version_id: 1,
        trigger_type: 'appointment_reminder_window', trigger_entity_type: 'appointment', trigger_entity_id: reserve.id_cita,
        clinic_id: 66, created_by: 1, status: 'running', context: { trigger: { schedule_moment: 'day_before' },
          appointment: { id_cita: reserve.id_cita, clinica_id: 66, paciente_id: 8, inicio: reserve.inicio.toISOString() } } });
      const conversation = await db.Conversation.create({ clinic_id: 66, patient_id: 8 });
      await db.Message.bulkCreate(['pending', 'failed'].map(status => ({ conversation_id: conversation.id, direction: 'outbound',
        message_type: 'template', status, sent_at: null, content: 'Owned no provider attempt',
        metadata: { execution_id: execution.id, template_name: 'clinicaclick_recordatorio_dia_antes', appointment_timeout: false } })));
      assert.equal((await daily.claimExecution({ appointment: reserve, executionId: execution.id, scheduleMoment: 'day_before' })).allowed, true,
        'missing wa_response projection is SQL 0, never attempt evidence');
      report.checks.push('native SQL pending and definitive failed receipt without sent_at/provider proof do not falsely consume reminder stage through numeric0 projection');
      } finally { await sql.close(); }
    });
  });

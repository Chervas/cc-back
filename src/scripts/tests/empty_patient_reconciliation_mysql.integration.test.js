'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createCanonicalLeadPatientMysqlFixture } = require('./fixtures/canonical_lead_patient_mysql.fixture');
const { inspectEmptyPatientReconciliation: inspect, applyEmptyPatientReconciliation: apply, digest, EVENT } = require('../../lib/empty-patient-identity-reconciliation');

test('selected empty patient reconciliation: raw SQL preimage/CAS, rollback, preserved jobs/history and idempotence',
  { skip: process.env.EMPTY_PATIENT_RECONCILIATION_MYSQL_TEST !== '1', timeout: 180000 }, async t => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createCanonicalLeadPatientMysqlFixture(context), { db, sql } = f, D = S.DataTypes;
      const define = (name, tableName, fields) => db[name] = sql.define(name, fields, { tableName, timestamps: false });
      define('FlowExecutionV2', 'FlowExecutionsV2', { id: { type: D.INTEGER, primaryKey: true }, trigger_entity_type: D.STRING,
        trigger_entity_id: D.INTEGER, status: D.STRING, data: D.JSON });
      define('FlowExecutionLogV2', 'FlowExecutionLogsV2', { id: { type: D.INTEGER, primaryKey: true }, flow_execution_id: D.INTEGER,
        node_key: D.STRING, status: D.STRING, data: D.JSON });
      define('JobRequest', 'JobRequests', { id: { type: D.INTEGER, primaryKey: true }, type: D.STRING, status: D.STRING,
        payload: D.JSON, attempts: D.INTEGER, next_run_at: D.DATE, created_at: D.DATE });
      define('UnexpectedPatientDependency', 'OwnedPatientDependencies', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
        owner_ref: { type: D.INTEGER, references: { model: 'Pacientes', key: 'id_paciente' } }, data: D.JSON });
      for (const name of ['FlowExecutionV2', 'FlowExecutionLogV2', 'JobRequest', 'UnexpectedPatientDependency']) await db[name].sync();
      const raw = async () => require('mysql2/promise').createConnection({ user: 'root', database: 'campaign_optimization_qa',
        socketPath: sql.options.dialectOptions.socketPath, dateStrings: true, timezone: 'Z', multipleStatements: false });
      const connection = await raw(), operator = { actorUserId: 1, authorizationRef: 'OWNED_QA_ONLY', backupRef: { path: '/owned/fictitious-backup.json', sha256: 'a'.repeat(64) } };
      const canonical = await db.Paciente.findByPk(1); let sequence = 900;
      const seed = async () => {
        const n = ++sequence, failedExecutionId = 10000 + n, executionJobId = 20000 + n, scheduledJobId = 30000 + n;
        const duplicate = await db.Paciente.create({ public_id: 'pac_owned_repair_' + n, clinica_id: 100,
          nombre: canonical.nombre, apellidos: canonical.apellidos, telefono_movil: canonical.telefono_movil });
        await db.PacienteClinica.create({ paciente_id: duplicate.id_paciente, clinica_id: 100, es_principal: true });
        const lead = await f.lead(n, { telefono: canonical.telefono_movil, nombre: canonical.nombre, status_lead: 'citado' });
        const start = new Date(Date.parse('2030-02-04T10:00:00Z') + (n - 901) * 30 * 60000), end = new Date(start.getTime() + 20 * 60000);
        // Manufacture the old bug's preimage using the real booking command;
        // the new controller guard intentionally cannot create this mismatch.
        const appointment = await f.physical.reserve({ appointmentValues: f.physical.values({ paciente_id: duplicate.id_paciente,
          tratamiento_id: null, lead_intake_id: n, inicio: start, fin: end }), force: true });
        await lead.update({ call_outcome_appointment_id: appointment.id_cita });
        const conversation = await f.conversation(n, canonical);
        await db.FlowExecutionV2.create({ id: failedExecutionId, trigger_entity_type: 'appointment', trigger_entity_id: appointment.id_cita,
          status: 'failed', data: { appointment_id: appointment.id_cita, patient_id: duplicate.id_paciente, reason: 'old_identity_conflict' } });
        await db.FlowExecutionLogV2.create({ id: failedExecutionId, flow_execution_id: failedExecutionId,
          node_key: 'N5', status: 'failed', data: { code: 'whatsapp_contact_identity_conflict', provider_called: false } });
        await db.JobRequest.bulkCreate([{ id: scheduledJobId, type: 'appointment_automation_schedule_fire', status: 'waiting',
          payload: { appointment_id: appointment.id_cita }, attempts: 0, next_run_at: '2030-02-03T08:00:00Z', created_at: new Date() },
        { id: executionJobId, type: 'appointment_automation_execute', status: 'completed', payload: { execution_id: failedExecutionId },
          attempts: 1, next_run_at: null, created_at: new Date() }]);
        return { duplicate, appointment, lead, conversation, recipe: { clinicId: 100, canonicalPatientId: canonical.id_paciente,
          duplicatePatientId: duplicate.id_paciente, appointmentId: appointment.id_cita, leadId: lead.id, conversationId: conversation.id,
          failedExecutionId, scheduledJobId, executionJobId, canonicalHistoryNumber: canonical.numero_historia,
          duplicateHistoryNumber: duplicate.numero_historia } };
      };
      const snapshot = async () => {
        const out = {}; for (const name of ['Paciente', 'PacienteClinica', 'PatientHistoryCounter', 'CitaPaciente', 'AppointmentBookingOccupancy',
          'AppointmentBookingResource', 'Conversation', 'LeadIntake', 'FlowExecutionV2', 'FlowExecutionLogV2', 'JobRequest', 'PatientOperationalEvent'])
          out[name] = await db[name].findAll({ order: [[db[name].primaryKeyAttribute, 'ASC']], raw: true });
        return JSON.parse(JSON.stringify(out));
      };
      try {
        await t.test('inspect is read-only, binds full preimage and discovers a nonstandard patient FK', async () => {
          const p = await seed(), before = await snapshot(), plan = await inspect(connection, p.recipe);
          assert.equal(plan.sha256, digest({ version: plan.version, recipe: plan.recipe, snapshot: plan.snapshot }));
          assert(plan.snapshot.dependencies.some(r => r.table === 'OwnedPatientDependencies' && r.column === 'owner_ref'));
          assert.deepEqual(await snapshot(), before);
        });
        await t.test('nonempty duplicate profile fields cannot enter an empty-record repair plan', async () => {
          const p = await seed();
          for (const [field, value] of [['dni', 'FICTITIOUS-DNI'], ['email', 'fictitious@example.invalid'], ['direccion', 'Fictitious address'],
            ['alergias', 'Fictitious allergy'], ['notas_paciente', 'Fictitious note'], ['fecha_nacimiento', '1980-01-01']]) {
            await db.Paciente.update({ [field]: value }, { where: { id_paciente: p.duplicate.id_paciente } });
            await assert.rejects(inspect(connection, p.recipe), error => /repair_duplicate/.test(error.code), field);
            await db.Paciente.update({ [field]: null }, { where: { id_paciente: p.duplicate.id_paciente } });
          }
        });
        await t.test('a newly attached patient FK blocks apply and leaves its preimage intact', async () => {
          const p = await seed(), plan = await inspect(connection, p.recipe);
          const extra = await db.UnexpectedPatientDependency.create({ owner_ref: p.duplicate.id_paciente, data: { synthetic: true } });
          const before = await snapshot();
          await assert.rejects(apply(connection, plan, operator), error => error.code === 'repair_duplicate_has_dependencies');
          assert.deepEqual(await snapshot(), before); await extra.destroy();
        });
        await t.test('tampered plan and an intervening patient edit cannot pass the compare-and-swap', async () => {
          const p = await seed(), plan = await inspect(connection, p.recipe), before = await snapshot();
          await assert.rejects(apply(connection, { ...plan, sha256: '0'.repeat(64) }, operator), error => error.code === 'repair_plan_hash_invalid');
          assert.deepEqual(await snapshot(), before);
          await db.Paciente.update({ profesion: 'Fictitious changed value' }, { where: { id_paciente: p.duplicate.id_paciente } });
          const changed = await snapshot(); await assert.rejects(apply(connection, plan, operator)); assert.deepEqual(await snapshot(), changed);
        });
        await t.test('failed execution and pending reminder changes reject a stale plan without replaying either', async () => {
          const p = await seed(), plan = await inspect(connection, p.recipe);
          await db.JobRequest.update({ attempts: 1 }, { where: { id: p.recipe.scheduledJobId } });
          const before = await snapshot(); await assert.rejects(apply(connection, plan, operator), e => e.code === 'repair_jobs_changed');
          assert.deepEqual(await snapshot(), before);
          await db.JobRequest.update({ attempts: 0 }, { where: { id: p.recipe.scheduledJobId } });
          const fresh = await inspect(connection, p.recipe);
          await db.FlowExecutionV2.update({ status: 'running' }, { where: { id: p.recipe.failedExecutionId } });
          const running = await snapshot(); await assert.rejects(apply(connection, fresh, operator), e => e.code === 'repair_execution_changed');
          assert.deepEqual(await snapshot(), running);
        });
        await t.test('failure after appointment UPDATE rolls back the appointment, resource anchor and all retirement effects', async () => {
          const p = await seed(), plan = await inspect(connection, p.recipe), before = await snapshot();
          const injected = { query: connection.query.bind(connection), beginTransaction: connection.beginTransaction.bind(connection),
            commit: connection.commit.bind(connection), rollback: connection.rollback.bind(connection), async execute(statement, parameters) {
              if (/^INSERT INTO PatientOperationalEvents/.test(statement)) throw Error('OWNED_AFTER_APPOINTMENT_UPDATE_FAILURE');
              return connection.execute(statement, parameters);
            } };
          await assert.rejects(apply(injected, plan, operator), /OWNED_AFTER_APPOINTMENT_UPDATE_FAILURE/);
          assert.deepEqual(await snapshot(), before);
        });
        await t.test('a conflicting canonical patient appointment prevents reassignment even in another room', async () => {
          const p = await seed();
          const conflict = await db.CitaPaciente.create({ clinica_id: 100, paciente_id: canonical.id_paciente, doctor_id: 2,
            instalacion_id: 102, estado: 'pendiente', inicio: p.appointment.inicio, fin: p.appointment.fin });
          try { await assert.rejects(inspect(connection, p.recipe), error => error.code === 'repair_canonical_patient_overlap'); }
          finally { await conflict.destroy(); }
        });
        await t.test('one successful repair preserves the canonical identity/history, reservation, occupancy, jobs and failed flow byte for byte', async () => {
          const p = await seed(), plan = await inspect(connection, p.recipe), before = await snapshot();
          // This seed uses a distinct canonical patient anchor absent at inspection.
          await db.AppointmentBookingResource.destroy({ where: { resource_key: 'patient:1' } });
          const result = await apply(connection, plan, operator); assert.equal(result.status, 'applied'); assert.equal(result.sends, 0);
          assert.equal(await db.Paciente.findByPk(p.duplicate.id_paciente), null);
          const after = await snapshot();
          assert.deepEqual(after.Paciente.find(r => r.id_paciente === 1), before.Paciente.find(r => r.id_paciente === 1));
          for (const name of ['PatientHistoryCounter', 'AppointmentBookingOccupancy', 'Conversation', 'LeadIntake', 'FlowExecutionV2', 'FlowExecutionLogV2', 'JobRequest'])
            assert.deepEqual(after[name], before[name], name);
          assert(await db.AppointmentBookingResource.findByPk('patient:1'));
          const updated = await db.CitaPaciente.findByPk(p.appointment.id_cita);
          assert.equal(updated.paciente_id, canonical.id_paciente); assert.equal(updated.estado, 'pendiente');
          assert.equal(updated.inicio.toISOString(), p.appointment.inicio.toISOString()); assert.equal(updated.fin.toISOString(), p.appointment.fin.toISOString());
          const event = await db.PatientOperationalEvent.findByPk(result.eventId); assert.equal(event.event_type, EVENT);
          assert.equal(event.source, 'operator_reconciliation');
          assert.equal(event.metadata.retired_patient_id, p.duplicate.id_paciente); assert.equal(event.metadata.retired_history_number, p.duplicate.numero_historia);
          assert.equal(event.metadata.plan_sha256, plan.sha256); assert.deepEqual(event.metadata.backup, operator.backupRef);
          const count = await db.PatientOperationalEvent.count(), once = await snapshot();
          const replay = await apply(connection, plan, operator); assert.equal(replay.status, 'replayed'); assert.equal(replay.eventId, result.eventId);
          assert.equal(await db.PatientOperationalEvent.count(), count); assert.deepEqual(await snapshot(), once);
        });
        await t.test('two concurrent applications of the same plan yield one applied repair and one replay', async () => {
          const p = await seed(), plan = await inspect(connection, p.recipe), other = await raw();
          try {
            const results = await Promise.all([apply(connection, plan, operator), apply(other, plan, operator)]);
            assert.deepEqual(results.map(r => r.status).sort(), ['applied', 'replayed']); assert.equal(results[0].eventId, results[1].eventId);
            assert.equal(await db.PatientOperationalEvent.count({ where: { event_type: EVENT, patient_id: 1 } }), 2);
          } finally { await other.end(); }
        });
        context.report.checks.push('empty selected duplicate repair: FK inventory, empty profile, CAS, rollback, preserved failed flow/reminder/history, missing canonical anchor and concurrent idempotence');
      } finally { await connection.end(); await f.close(); }
    });
  });

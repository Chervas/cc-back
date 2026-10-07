'use strict';

// Native FlowEngine + canonical status writer + durable JobRequest on OWNED
// MySQL, with no installed experimental visit tables. Provider and UI concerns
// are explicit fixture seams; no public SQL, WhatsApp or background worker.
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitConsumerFixture } = require('./helpers/owned-visit-consumer-fixture');

test('legacy confirmations survive absent managed tables; reviewed waits expire without a nudge and still accept replies',
  { skip: process.env.LEGACY_CONFIRMATION_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedVisitConsumerFixture(context), { db } = f;
      try {
        f.enable(false);
        for (const name of ['AppointmentVisitDispatches', 'AppointmentVisitBirthRequests',
          'AppointmentVisitCommunications', 'AppointmentVisitMembers', 'AppointmentVisits']) {
          await context.sql.query('DROP TABLE ' + name);
        }
        const engine = require('../../services/flowEngineV2.service');
        const template = await db.AutomationFlowTemplateV2.findByPk(42);
        const nodes = [
          { id: 'C1', type: 'action/change_status', config: { target_entity: 'appointment', new_status: 'recordatorio_enviado' }, outputs: { on_success: 'W' } },
          { id: 'W', type: 'delay/wait_response', config: { listens_to_node_id: 'S', timeout_duration: 60, timeout_unit: 'minutes' }, outputs: { on_response: 'C2', on_timeout: 'LATE' } },
          { id: 'C2', type: 'action/change_status', config: { target_entity: 'appointment', new_status: 'recordatorio_confirmado' }, outputs: { on_success: 'E' } },
          { id: 'LATE', type: 'control/end', config: {}, outputs: {} },
          { id: 'E', type: 'control/end', config: {}, outputs: {} },
        ];
        await template.update({ nodes, entry_node_id: 'C1' });
        let sequence = 0;
        const create = async () => {
          const row = await db.CitaPaciente.create(f.physical.values({ titulo: 'Sólo prueba aislada' }));
          const execution = await db.FlowExecutionV2.create({ idempotency_key: 'owned-confirmation-' + sequence++, template_version_id: 42,
            clinic_id: 100, created_by: 1, trigger_type: 'appointment_created', trigger_entity_type: 'appointment', trigger_entity_id: row.id_cita,
            current_node_id: 'C1', status: 'running', context: { appointment: row.toJSON(), outputs: { S: { status: 'success',
              message_preview: '¿Confirmas tu asistencia?', at: new Date().toISOString() } } } });
          const started = await engine.runExecution(execution.id);
          assert.equal(started.status, 'waiting', started.last_error);
          await row.reload(); assert.equal(row.estado, 'recordatorio_enviado');
          await execution.reload();
          await execution.update({ context: { ...execution.context, recovery_review: {
            kind: 'operator_reviewed_response_wait_recovery', source_execution_id: execution.id, clinic_id: 100,
            wait_node_id: 'W', source_outbound_id: 123, first_notice_replayed: false } },
            waiting_meta: { ...execution.waiting_meta, recovery_response_only: true }, wait_until: new Date(Date.now() - 1000) });
          return { execution, row };
        };
        const expired = await create();
        const job = await db.JobRequest.create({ type: 'automations_v2_execute', status: 'pending', priority: 'critical', origin: 'owned_response_recovery',
          payload: { execution_id: expired.execution.id, __runtime_namespace: 'visit_fixture' }, requested_by: 1, max_attempts: 1 });
        const handled = await f.claimAndHandle(job.id);
        assert.equal(handled.executorStatus, 'completed', JSON.stringify(handled));
        await expired.execution.reload();
        assert.equal(expired.execution.status, 'completed');
        assert.equal(expired.execution.context.outputs.W.timeout_notice_suppressed, true);
        assert.equal(expired.execution.context.outputs.LATE, undefined, 'the old timeout branch is never run');
        await expired.row.reload(); assert.equal(expired.row.estado, 'recordatorio_enviado');

        const answered = await create();
        const resumed = await engine.runExecution(answered.execution.id, { resumeMode: 'response', responseText: 'Hola. De acuerdo', responseBatchLoaded: true });
        assert.equal(resumed.status, 'completed', resumed.last_error);
        await answered.row.reload(); assert.equal(answered.row.estado, 'recordatorio_confirmado');
        assert.equal(resumed.context.outputs.W.status, 'responded');
        assert.equal(resumed.context.outputs.W.timeout_notice_suppressed, undefined);
        assert.equal(resumed.context.outputs.LATE, undefined);
        assert.equal((await engine.runExecution(answered.execution.id)).status, 'completed');
        assert.equal(f.attempts.length, 0, 'no provider, initial notice replay or consent send in this regression');
        context.report.checks.push('Actual legacy status mutation with absent managed schema reaches native waiting; claimed timeout job completes without old nudge; a response retains native status transition and terminal replay is idempotent. Classification is covered separately, not simulated as real AI here.');
      } finally { await f.close(); }
    });
  });

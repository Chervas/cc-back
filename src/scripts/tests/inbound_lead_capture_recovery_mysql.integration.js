'use strict';

const assert = require('node:assert/strict');
const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const config = require('../../services/inboundLeadCaptureConfig.service');
const captureModule = require('../../services/inboundLeadCapture.service');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.Sequelize = D;
  db.Clinica = sql.define(
    'Clinica',
    { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER, nombre_clinica: D.STRING },
    { tableName: 'Clinicas', timestamps: false },
  );
  await db.Clinica.sync();
  db.Paciente = sql.define(
    'Paciente',
    {
      id_paciente: { type: D.INTEGER, primaryKey: true },
      clinica_id: D.INTEGER,
      nombre: D.STRING,
      apellidos: D.STRING,
      telefono_movil: D.STRING,
      telefono_secundario: D.STRING,
      email: D.STRING,
    },
    { tableName: 'Pacientes' },
  );
  db.PacienteClinica = sql.define(
    'PacienteClinica',
    { paciente_id: D.INTEGER, clinica_id: D.INTEGER },
    { tableName: 'PacienteClinicas' },
  );
  db.Paciente.hasMany(db.PacienteClinica, { as: 'clinicasVinculadas', foreignKey: 'paciente_id' });
  await db.Paciente.sync();
  await db.PacienteClinica.sync();
  await db.Clinica.create({ id_clinica: 41 });
  for (const name of [
    'AutomationFlowTemplateV2',
    'FlowExecutionV2',
    'FlowExecutionLogV2',
    'JobRequest',
    'LeadIntake',
    'LeadAttributionAudit',
    'Conversation',
    'Message',
    'AutomationInboundMessageClaim',
    'SocialInboxReceipt',
  ]) {
    db[name] = require('../../../models/' + name.toLowerCase())(sql, D.DataTypes);
    await db[name].sync();
  }
  db.FlowExecutionV2.associate(db);
  db.MarketingCompetitionHeatmapCache = require('../../../models/marketingcompetitionheatmapcache')(
    sql,
    D.DataTypes,
  );
  const qi = sql.getQueryInterface();
  await qi.addIndex('FlowExecutionsV2', ['idempotency_key'], { unique: true });
  await qi.addIndex('LeadIntakes', ['external_source', 'external_id'], { unique: true });
  process.env.JOB_RUNTIME_NAMESPACE = 'dev';
  const queue = require('../../services/jobRequests.service');
  const scheduler = require('../../services/jobScheduler.service');
  scheduler.triggerImmediate = async () => {};
  const runner = require('../../services/jobExecutor.service');
  const refresh = [];
  require('../../services/socket.service').emit = (event, packet, rooms) => refresh.push({ event, packet, rooms });
  const published = [];
  const route = {
    appId: '123',
    pageId: '599',
    accountId: '500',
    clinicId: 41,
    channel: 'instagram',
    connectionRef: 'r',
    enrollmentId: 'e',
    tenantRef: 'clinic:41',
  };
  let classify = async () => ({ kind: 'interest', privateRequested: false });
  const capture = captureModule.create({
    db,
    createExecution: (row) => db.FlowExecutionV2.create(row),
    enqueueJob: queue.enqueueUniqueJobRequest,
    publishLead: async ({ lead }) => published.push(lead.id),
    restrictions: async () => ({}),
    classify: (...args) => classify(...args),
    readSocial: async (key) => (await db.SocialInboxReceipt.findByPk(key))?.event,
    resolveRoute: async () => route,
  });
  let sequence = 0;
  async function admit(content = 'INFO') {
    await config.save(db, 41, 'whatsapp', 11, true);
    const conversation = await db.Conversation.create({
      clinic_id: 41,
      channel: 'whatsapp',
      contact_id: String(34600010000 + ++sequence),
    });
    const mid = 'wamid.recovery' + sequence;
    const message = await db.Message.create({
      direction: 'inbound',
      conversation_id: conversation.id,
      message_type: 'text',
      content,
      status: 'delivered',
      sent_at: new Date(),
      metadata: {
        wamid: mid,
        phone_number_id: '123',
        waba_id: '456',
        provider_type: 'text',
        provider_sent_at: new Date().toISOString(),
      },
    });
    const claim = await db.AutomationInboundMessageClaim.create({
      message_id: message.id,
      conversation_id: conversation.id,
      clinic_id: 41,
      channel: 'whatsapp',
      provider_message_id: mid,
      claim_key: mid,
    });
    const started = await capture.enqueue({ message, conversation, claim });
    assert.equal(started.pending, true);
    const execution = await db.FlowExecutionV2.findByPk(started.execution_id);
    const job = await db.JobRequest.findOne({
      where: { type: 'automations_v2_execute', 'payload.execution_id': execution.id },
    });
    assert.ok(job);
    return { message, execution, job, claim };
  }
  async function work(fixture, action) {
    captureModule.run = action;
    const job = await queue.claimJobById(fixture.job.id);
    assert.ok(job);
    const result = await runner.runJob(job);
    await scheduler._settleJobResult(job, result);
    await fixture.execution.reload();
    await fixture.job.reload();
    return result;
  }
  async function makeDue({ execution, job }) {
    const past = new Date(Date.now() - 2500);
    await execution.update({ wait_until: past });
    await job.update({ next_run_at: past });
  }
  const fault = (code) => Object.assign(new Error('simulated provider detail'), { code });
  const logs = (fixture, node = 'N2') =>
    db.FlowExecutionLogV2.findAll({
      where: {
        flow_execution_id: fixture.execution.id,
        node_id: node,
      },
      order: [['id', 'ASC']],
    });

  // Same execution, claim and job across a real MySQL retryable error and settlement.
  const transient = await admit();
  const first = await work(transient, () =>
    sql.query("SIGNAL SQLSTATE '40001' SET MYSQL_ERRNO=1213, MESSAGE_TEXT='test deadlock'"),
  );
  assert.equal(first.status, 'waiting', first.error?.stack);
  assert.equal(transient.job.status, 'waiting');
  assert.equal(transient.execution.current_node_id, 'N2');
  assert.equal(transient.execution.waiting_meta.kind, 'inbound_lead_capture_retry');
  assert.equal(transient.execution.context.outputs.N2.error_code, 'inbound_capture_database_unavailable');
  assert.equal((await logs(transient))[0].audit_snapshot.node_output_after.capture_retry.will_retry, true);
  assert.ok(transient.job.next_run_at > Date.now());
  assert.equal(await queue.claimJobById(transient.job.id), null);
  assert.deepEqual(refresh.at(-1), {
    event: 'message:refresh',
    packet: { id: transient.message.id, conversation_id: transient.message.conversation_id },
    rooms: ['clinic:41'],
  });
  assert.equal(await db.LeadIntake.count(), 0);
  await makeDue(transient);
  assert.equal((await work(transient, capture.run)).status, 'completed');
  const fresh = (await transient.message.reload()).metadata.inboundLeadCapture;
  assert.ok(fresh.leadId);
  assert.equal(transient.execution.context.outputs.N2.leadId, fresh.leadId);
  assert.equal(transient.execution.context.outputs.N2.capture_retry, undefined);
  assert.deepEqual(
    (await logs(transient)).map((log) => log.status),
    ['error', 'success'],
  );
  assert.equal(
    await db.FlowExecutionV2.count({ where: { idempotency_key: transient.execution.idempotency_key } }),
    1,
  );

  // The budget is stored with the N2 error, survives retries and is exhausted.
  const exhausted = await admit();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = attempt === 2 ? 'inbound_capture_classifier_invalid' : 'inbound_capture_classifier_unavailable';
    const result = await work(exhausted, async () => {
      throw fault(code);
    });
    const output = exhausted.execution.context.outputs.N2;
    assert.equal(output.error_code, code);
    assert.deepEqual(output.capture_retry, { attempt, max_attempts: 3, will_retry: attempt < 3 });
    if (attempt < 3) {
      assert.equal(result.status, 'waiting');
      await makeDue(exhausted);
    } else {
      assert.equal(result.retryable, false);
      assert.equal(exhausted.job.status, 'failed');
      assert.equal(exhausted.execution.status, 'failed');
      assert.equal(await queue.claimJobById(exhausted.job.id), null);
    }
  }
  assert.equal(await db.LeadIntake.count(), 1);

  // Unknown or explicit permanent failures do not acquire a retry budget.
  const permanent = await admit();
  const rejected = await work(permanent, async () => {
    throw Error('permanent_validation_failure');
  });
  assert.equal(permanent.execution.status, 'failed');
  assert.equal(rejected.retryable, false);
  assert.equal(permanent.job.status, 'failed');
  assert.equal(permanent.execution.context.outputs.N2.capture_retry, undefined);
  // A duplicate job for an already failed execution cannot revive it.
  await permanent.job.update({ status: 'queued' });
  assert.equal(
    (
      await work(permanent, async () => {
        assert.fail('terminal action replayed');
      })
    ).result.result.already_terminal,
    true,
  );

  const permanentAfterWait = await admit();
  await work(permanentAfterWait, async () => {
    throw fault('inbound_capture_classifier_invalid');
  });
  await makeDue(permanentAfterWait);
  await work(permanentAfterWait, async () => {
    throw Error('permanent validation failure');
  });
  assert.equal(permanentAfterWait.job.status, 'failed');
  assert.equal(permanentAfterWait.execution.waiting_meta, null);
  assert.equal(permanentAfterWait.execution.wait_until, null);
  assert.equal(permanentAfterWait.execution.context.outputs.N2.capture_retry, undefined);

  // The actual classification reservation releases a confirmed provider failure
  // and allows one new decision, under the same job, message and execution.
  const classifierRecovery = await admit('Seguía interesada en el tratamiento');
  let calls = 0;
  classify = async () => {
    if (++calls === 1) throw fault('inbound_capture_classifier_unavailable');
    return { kind: 'interest', privateRequested: false };
  };
  await work(classifierRecovery, capture.run);
  assert.equal(classifierRecovery.execution.status, 'waiting');
  assert.equal(
    (await classifierRecovery.message.reload()).metadata.inboundLeadCaptureClassification.failureCode,
    'inbound_capture_classifier_unavailable',
  );
  await makeDue(classifierRecovery);
  await work(classifierRecovery, capture.run);
  assert.equal(classifierRecovery.execution.status, 'completed');
  assert.equal(classifierRecovery.execution.context.outputs.N2.outcome, 'created');
  assert.equal(calls, 2);

  // Reproduce the auditor crash after SQL commit and before the calculation of
  // the next node. Keep the in-flight log as a worker would leave it on failure.
  for (const pause of [false, true]) {
    const fixture = await admit();
    const before = await db.LeadIntake.count();
    const claimed = await queue.claimJobById(fixture.job.id);
    assert.ok(claimed);
    await fixture.execution.update({ current_node_id: 'N2' });
    await db.FlowExecutionLogV2.create({
      flow_execution_id: fixture.execution.id,
      node_id: 'N2',
      node_type: 'action/inbound_lead_capture',
      status: 'running',
      started_at: new Date(),
    });
    const receipt = await capture.run(fixture.execution);
    assert.ok(receipt.leadId);
    if (pause) await config.save(db, 41, 'whatsapp', 11, false);
    await queue.resetRunningJobs();
    assert.equal(
      (
        await work(fixture, async () => {
          assert.fail('already committed action replayed');
        })
      ).status,
      'completed',
    );
    assert.equal(fixture.execution.status, 'completed');
    assert.equal(fixture.execution.context.outputs.N2.leadId, receipt.leadId);
    const captured = await logs(fixture);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].status, 'success');
    assert.equal(captured[0].audit_snapshot.reconciled, true);
    assert.equal(await db.LeadIntake.count(), before + 1);
    assert.equal(published.filter((id) => id === receipt.leadId).length, 1);
    const audits = await db.LeadAttributionAudit.findAll({ where: { lead_intake_id: receipt.leadId } });
    assert.equal(
      audits.filter((a) => a.attribution_steps.inbound_capture?.execution_id === fixture.execution.id).length,
      1,
    );
  }

  // A stop that already marked the execution cancelled may reconcile its
  // confirmed result, but the guard must keep its terminal status on redelivery.
  const terminalStop = await admit();
  const confirmed = await capture.run(terminalStop.execution);
  await config.save(db, 41, 'whatsapp', 11, false);
  await terminalStop.execution.update({ status: 'cancelled', last_error: 'automation_deactivated' });
  await work(terminalStop, async () => {
    assert.fail('cancelled execution reopened');
  });
  assert.equal(terminalStop.execution.status, 'cancelled');
  assert.equal(terminalStop.execution.context.outputs.N2.leadId, confirmed.leadId);
  const countBeforeDuplicate = refresh.length;
  await terminalStop.job.update({ status: 'queued' });
  await work(terminalStop, async () => {
    assert.fail('terminal duplicate executed');
  });
  assert.equal((await logs(terminalStop)).length, 1);
  assert.equal(refresh.length, countBeforeDuplicate);

  const noReceipt = await admit();
  await config.save(db, 41, 'whatsapp', 11, false);
  await work(noReceipt, async () => {
    assert.fail('disabled capture ran');
  });
  assert.equal(noReceipt.execution.status, 'cancelled');
  assert.equal(noReceipt.execution.context.outputs.N2, undefined);

  const scoped = await admit();
  const otherMark = { ...fresh, key: scoped.execution.idempotency_key };
  await scoped.message.update({ metadata: { ...scoped.message.metadata, inboundLeadCapture: otherMark } });
  await config.save(db, 41, 'whatsapp', 11, false);
  await work(scoped, async () => {
    assert.fail('unconfirmed action ran');
  });
  assert.equal(scoped.execution.context.outputs.N2, undefined);
  assert.equal(scoped.execution.status, 'cancelled');

  // The recovery privilege does not apply to another action or a modified graph.
  const other = await admit();
  const template = await db.AutomationFlowTemplateV2.findByPk(other.execution.template_version_id);
  const altered = template.nodes.map((node) =>
    node.id === 'N2' ? { ...node, outputs: { ...node.outputs, on_fail: 'N3' } } : node,
  );
  assert.equal(
    require('../../services/inboundLeadCaptureRecovery.service').captureNode(other.execution, {
      ...template.get({ plain: true }),
      nodes: altered,
    }),
    null,
  );
  // An equally transient exception on a different V2 action follows its original terminal flow policy.
  await template.update({
    nodes: template.nodes.map((node) =>
      node.id === 'N2' ? { ...node, type: 'action/social_lead_interest' } : node,
    ),
  });
  const socialModule = require('../../services/socialLeadAutomation.service');
  const socialRun = socialModule.run;
  try {
    socialModule.run = async () => {
      throw fault('inbound_capture_classifier_unavailable');
    };
    await work(other, async () => {
      assert.fail('incorrect action reached');
    });
    assert.equal(other.execution.status, 'failed');
    assert.equal(other.execution.context.outputs.N2.capture_retry, undefined);
  } finally {
    socialModule.run = socialRun;
  }

  // A confirmed social receipt is eligible even when its realtime notification is still pending.
  await config.save(db, 41, 'social', 11, true);
  const social = await db.Conversation.create({
    clinic_id: 41,
    channel: 'instagram',
    contact_id: '9933',
    social_account_id: route.accountId,
  });
  const event = {
    channel: 'instagram',
    senderId: social.contact_id,
    accountId: route.accountId,
    eventId: 'mid-test',
    clinicId: 41,
    source: 'new',
    echo: false,
    type: 'dm',
    at: new Date().toISOString(),
    text: 'INFO',
    conversationId: social.id,
  };
  const message = await db.Message.create({
    conversation_id: social.id,
    direction: 'inbound',
    message_type: 'text',
    sent_at: new Date(),
    content: 'INFO',
    metadata: { providerId: event.eventId },
  });
  event.messageId = message.id;
  const pk = require('../../services/socialInboxEvents').eventKey(event);
  await db.SocialInboxReceipt.create({ key: pk, event, route, message_id: message.id, state: 'notify' });
  const sa = await db.AutomationInboundMessageClaim.create({
    clinic_id: 41,
    channel: 'instagram',
    conversation_id: social.id,
    message_id: message.id,
    claim_key: pk,
    provider_message_id: pk,
  });
  const started = await capture.enqueue({ message, conversation: social, claim: sa });
  assert.equal(started.pending, true);
  const socialExecution = await db.FlowExecutionV2.findByPk(started.execution_id);
  const socialJob = await db.JobRequest.findOne({
    where: { type: 'automations_v2_execute', 'payload.execution_id': socialExecution.id },
  });
  const savedSocial = await capture.run(socialExecution);
  assert.ok(savedSocial.leadId);
  await config.save(db, 41, 'social', 11, false);
  await work({ execution: socialExecution, job: socialJob }, async () => {
    assert.fail('social receipt replayed');
  });
  assert.equal(socialExecution.context.outputs.N2.leadId, savedSocial.leadId);
  assert.equal(socialExecution.status, 'completed');
  assert.equal(await db.Message.count({ where: { direction: 'outbound' } }), 0);
  report.checks.push(
    'same_execution_sql_retry',
    'classifier_retry_budget',
    'permanent_and_failed_stay_terminal',
    'committed_receipt_recovered_active_and_paused',
    'no_writes_or_actions_after_pause',
    'no_outbound_messages',
  );
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

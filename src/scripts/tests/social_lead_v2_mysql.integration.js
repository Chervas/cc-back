'use strict';
const assert = require('node:assert/strict');
const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { create: createInbox } = require('../../services/socialInbox.service');
const { create: createAutomation } = require('../../services/socialLeadAutomation.service');
const { events, eventKey } = require('../../services/socialInboxEvents');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.Sequelize = D;
  const q = sql.getQueryInterface();
  db.Clinica = sql.define(
    'Clinica',
    {
      id_clinica: { type: D.INTEGER, primaryKey: true },
      grupoClinicaId: D.INTEGER,
      nombre_clinica: D.STRING,
      direccion: D.STRING,
      telefono: D.STRING,
      url_web: D.STRING,
      url_ficha_local: D.STRING,
      configuracion: D.JSON,
    },
    { tableName: 'Clinicas', timestamps: false },
  );
  await db.Clinica.sync();
  await q.createTable('Pacientes', { id_paciente: { type: D.INTEGER, primaryKey: true } });
  await db.Clinica.bulkCreate([
    { id_clinica: 41, nombre_clinica: 'Demo A' },
    { id_clinica: 42, nombre_clinica: 'Demo B' },
  ]);
  const models = [
    'LeadIntake',
    'LeadAttributionAudit',
    'Conversation',
    'Message',
    'SocialInboxReceipt',
    'AutomationFlowTemplateV2',
    'FlowExecutionV2',
    'AutomationInboundMessageClaim',
    'JobRequest',
    'Notification',
    'UsuarioClinica',
  ];
  for (const name of models) {
    db[name] = require('../../../models/' + name.toLowerCase())(sql, D.DataTypes);
    await db[name].sync();
  }
  await db.UsuarioClinica.bulkCreate([
    {
      id_clinica: 41,
      id_usuario: 85,
      rol_clinica: 'personaldeclinica',
      subrol_clinica: 'Recepción / Comercial ventas',
      estado_invitacion: 'aceptada',
    },
    {
      id_clinica: 41,
      id_usuario: 86,
      rol_clinica: 'personaldeclinica',
      subrol_clinica: 'Recepción / Comercial ventas',
      estado_invitacion: 'pendiente',
    },
    {
      id_clinica: 42,
      id_usuario: 87,
      rol_clinica: 'personaldeclinica',
      subrol_clinica: 'Recepción / Comercial ventas',
      estado_invitacion: 'aceptada',
    },
  ]);
  await q.addIndex('LeadIntakes', ['external_source', 'external_id'], { unique: true });
  await q.addIndex('FlowExecutionsV2', ['idempotency_key'], { unique: true });
  await q.addIndex('Conversations', ['clinic_id', 'channel', 'social_account_id', 'contact_id'], {
    unique: true,
  });
  const at = Date.now(),
    rule = { action: 'message', text: 'Gracias por solicitar información.' };
  const flow = await db.AutomationFlowTemplateV2.create({
    public_id: 'test_flow',
    template_key: 'lead_auto_reply_system__clinic_41',
    version: 1,
    name: 'Prueba',
    clinic_id: 41,
    created_by: 23,
    published_by: 23,
    published_at: new Date(at - 60000),
    entry_node_id: 'N1',
    nodes: [],
    trigger_type: 'lead_nuevo',
    is_active: true,
    trigger_config: {
      managed_feature: 'lead_auto_reply',
      configured: true,
      social_entries: { instagram_comment: rule, instagram_dm: rule, messenger_dm: { action: 'notify' } },
    },
  });
  const accounts = { 501: 41, 502: 42, 401: 41 };
  const resolve = async (_, { channel, accountId }) =>
    !accounts[accountId]
      ? null
      : {
          clinicId: accounts[accountId],
          channel,
          accountId,
          pageId: accountId === '502' ? '402' : '401',
          appId: '123',
          connectionRef: 'demo',
          enrollmentId: 'demo',
          tenantRef: 'group-test',
        };
  let automation;
  const scheduler = require.resolve('../../services/jobScheduler.service');
  require.cache[scheduler] = {
    id: scheduler,
    filename: scheduler,
    loaded: true,
    exports: { triggerImmediate: async () => {} },
  };
  const dispatch = require('../../services/automationInboundMessage.service');
  const queue = require('../../services/jobRequests.service');
  const runtime = require('../../lib/automation-runtime-stop');
  const jobs = [],
    claims = [],
    posts = [],
    executions = [],
    published = [];
  const provider = {
    receive: async () => ({
      available: true,
      post: { caption: 'Comenta INFO para que te escribamos por privado' },
    }),
    availability: async () => ({ available: true }),
    send: async (r, kind, recipient, text, attemptId) => {
      posts.push({ kind, recipient, text, attemptId });
      return { available: true, messageId: 'sent-' + attemptId, recipientId: '771' };
    },
  };
  const social = createInbox({
    db,
    provider,
    resolve,
    enqueue: async (j) => jobs.push(j),
    publish: async () => {},
    dispatchInbound: (e) => automation.enqueue(e),
  });
  automation = createAutomation({
    db,
    social,
    resolve,
    dispatch: async (p, { transaction }) => {
      const result = await dispatch.enqueueInboundDispatch(p, { transaction });
      assert.equal(result.claim.metadata.social_template_id, flow.id);
      transaction.afterCommit(() =>
        claims.push({
          id: result.claim.id,
          jobId: result.job.id,
          provider_message_id: result.claim.provider_message_id,
          threadId: result.claim.conversation_id,
        }),
      );
    },
    createExecution: runtime.createExecution,
    enqueueJob: async (job) => {
      await queue.enqueueUniqueJobRequest(job);
      executions.push(job.payload.execution_id);
    },
    classify: async (e, { beforeDispatch }) => {
      await beforeDispatch();
      assert.equal(e.source, 'new');
      return {
        kind: e.text === 'STOP' ? 'opt_out' : e.text === 'Duda' ? 'review' : 'interest',
        privateRequested: true,
      };
    },
    checkPatientRestrictions: async () => ({ marketing_opt_out: false }),
    publishLead: ({ lead }) => published.push(lead.id),
  });
  const owner = require('../../services/socialLeadAutomation.service');
  owner.start = automation.start;
  owner.run = automation.run;
  const dm = (channel, accountId, id, text, sender = '771', echo = false) => ({
    object: channel === 'messenger' ? 'page' : 'instagram',
    entry: [
      {
        id: accountId,
        messaging: [
          {
            timestamp: at,
            sender: { id: echo ? accountId : sender },
            recipient: { id: echo ? sender : accountId },
            message: { mid: id, text, is_echo: echo },
          },
        ],
      },
    ],
  });
  const comment = {
    object: 'instagram',
    entry: [
      {
        id: '501',
        time: Math.floor(at / 1000),
        changes: [
          {
            field: 'comments',
            value: {
              id: '991',
              from: { id: '771', username: 'luna_test' },
              media: { id: '881' },
              text: 'INFO',
            },
          },
        ],
      },
    ],
  };
  async function receive(body, history = false) {
    const key = eventKey(events(body)[0]);
    await social.accept(body, { appId: '123', namespace: 'dev', history });
    await social.importReceipt(key);
    return key;
  }
  async function begin(index) {
    const pending = claims[index];
    const job = await db.JobRequest.findByPk(pending.jobId);
    assert.equal(job.type, 'automation_inbound_dispatch');
    await dispatch.runInboundDispatchJob(job.payload, job);
    const claim = await db.AutomationInboundMessageClaim.findByPk(pending.id);
    assert.equal(claim.status, 'completed');
    assert.equal(claim.owner_type, 'social_lead_interest');
    return db.FlowExecutionV2.findByPk(claim.owner_reference_id);
  }
  const key = await receive(comment);
  await receive(comment);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].provider_message_id, key);
  const first = await begin(0),
    replay = await begin(0);
  assert.equal(first.id, replay.id);
  const concurrent = await Promise.all([automation.run(first), automation.run(replay)]);
  const result = concurrent.find((row) => row.outcome === 'sent');
  assert.ok(result, 'one concurrent attempt must reach the provider');
  assert.equal(new Set(concurrent.map((row) => row.lead_id)).size, 1);
  assert.equal(posts[0].kind, 'comment');
  assert.equal(posts[0].recipient, '991');
  assert.equal((await automation.run(replay)).outcome, 'sent');
  assert.equal(posts.length, 1);
  const c = await db.Conversation.findByPk(claims[0].threadId);
  assert.equal(c.lead_id, result.lead_id);
  assert.equal(published.length, 1);
  const lead = await db.LeadIntake.findByPk(c.lead_id);
  assert.equal(lead.telefono, null);
  assert.equal(lead.email, null);
  assert.equal(lead.utm_source, null);
  const attribution = require('../../lib/lead-attribution-view');
  assert.equal(attribution.resolveLeadMarketingOrigin(lead), 'social_inbox');
  assert.equal(attribution.resolveLeadContactMethod(lead), 'instagram_comment');
  assert.equal(lead.external_source, 'quickchat_social');
  assert.equal(lead.nombre, 'luna_test');
  await receive(dm('instagram', '501', 'followup', 'INFO'));
  assert.equal((await automation.run(await begin(1))).lead_id, lead.id);
  assert.equal(await db.LeadIntake.count(), 1);
  await receive(dm('messenger', '401', 'test-messenger', 'INFO'));
  const messengerExecution = await begin(2);
  const notice = await automation.run(messengerExecution);
  assert.equal(notice.attention, true);
  assert.notEqual(notice.lead_id, lead.id);
  assert.equal(posts.length, 2);
  const graph = require('../../services/leadAutoReply.service').buildManagedNodes({
    ...flow.trigger_config,
    sources: [],
  });
  const engine = require('../../services/flowEngineV2.service');
  const step = (id, context) =>
    engine._processNode(
      graph.find((n) => n.id === id),
      context,
      { execution: messengerExecution },
    );
  let context = messengerExecution.context;
  const triggered = await step('N1', context);
  const routed = await step(triggered.next_node_id, context);
  assert.equal(routed.next_node_id, 'social_interest');
  const captured = await step(routed.next_node_id, context);
  assert.equal(captured.next_node_id, 'social_notify');
  context = { ...context, ...captured.context_patch };
  const notified = await step(captured.next_node_id, context);
  assert.equal(notified.next_node_id, 'N10');
  await step(captured.next_node_id, context);
  const alerts = await db.Notification.findAll({ attributes: ['userId', 'clinicaId', 'data'], raw: true });
  assert.deepEqual(
    alerts.map((row) => [row.userId, row.clinicaId]),
    [[85, 41]],
  );
  assert.equal(alerts[0].data.quickChatConversationId, claims[2].threadId);
  await receive(dm('instagram', '502', 'foreign', 'INFO'));
  await receive(dm('instagram', '501', 'history', 'INFO'), true);
  await receive(dm('instagram', '501', 'echo', 'INFO', '771', true));
  assert.equal(claims.length, 3);
  await receive(dm('instagram', '501', 'stop', 'STOP'));
  assert.equal((await automation.run(await begin(3))).reason, 'opt_out');
  await receive(dm('instagram', '501', 'after-stop', 'INFO'));
  const stopped = await automation.run(await begin(4));
  assert.equal(stopped.attention, true);
  assert.equal(stopped.reason, 'marketing_opt_out');
  assert.equal(posts.length, 2);
  await receive(dm('instagram', '501', 'medical', 'Duda', '773'));
  const review = await automation.run(await begin(5));
  assert.equal(review.attention, true);
  assert.equal(review.lead_id, null);
  await receive(dm('instagram', '501', 'paused', 'INFO', '775'));
  const suspended = await begin(6);
  await flow.update({ is_active: false });
  assert.equal((await automation.run(suspended)).reason, 'social_entry_disabled');
  assert.equal(await db.LeadIntake.count(), 2);
  assert.equal(posts.length, 2);
  report.assertions = [
    'Live comment → scoped lead and one private reply',
    'duplicate webhook and worker',
    'DM continuation reuses lead',
    'Messenger team notification',
    'history and echoes excluded',
    'clinic isolation',
    'opt-out and clinical review',
    'pause before execution',
  ];
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

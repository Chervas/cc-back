'use strict';

const assert = require('node:assert/strict');
const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const config = require('../../services/inboundLeadCaptureConfig.service');
const { create } = require('../../services/inboundLeadCapture.service');
const { eventKey } = require('../../services/socialInboxEvents');

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
  await db.Clinica.bulkCreate([{ id_clinica: 41 }, { id_clinica: 42 }]);
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
  db.MarketingPatientList = sql.define('MarketingPatientList', {
    clinica_id: D.INTEGER,
    objective_id: D.STRING,
    name: D.STRING,
    criteria: D.JSON,
  });
  db.MarketingPatientListItem = sql.define('MarketingPatientListItem', {
    list_id: D.INTEGER,
    clinica_id: D.INTEGER,
    phone: D.STRING,
    name: D.STRING,
  });
  await db.MarketingPatientList.sync();
  await db.MarketingPatientListItem.sync();
  const qi = sql.getQueryInterface();
  await qi.addIndex('FlowExecutionsV2', ['idempotency_key'], { unique: true });
  await qi.addIndex('LeadIntakes', ['external_source', 'external_id'], { unique: true });
  const old = await config.current(db, 41, 'whatsapp');
  assert.equal(config.status('whatsapp', old).active, false);
  const [first, same] = await Promise.all([
    config.save(db, 41, 'whatsapp', 11, true),
    config.save(db, 41, 'whatsapp', 11, true),
  ]);
  assert.equal(first.template_id, same.template_id);
  assert.ok(first.public_id);
  assert.equal(first.version, 1);
  assert.equal(await config.current(db, 42, 'whatsapp'), null);
  assert.equal(await config.current(db, 41, 'social'), null);
  const flow = await db.AutomationFlowTemplateV2.findByPk(first.template_id);
  const originalStart = Date.parse(flow.trigger_config.effective_from);
  const since = new Date(Date.now() - 3600000).toISOString();
  await flow.update({ trigger_config: { ...flow.trigger_config, effective_from: since } });
  const timestamp = Date.now() - 1000,
    route = {
      clinicId: 41,
      channel: 'instagram',
      accountId: '501',
      pageId: '600',
      appId: '123',
      connectionRef: 'x',
      enrollmentId: 'y',
      tenantRef: 'clinic:41',
    };
  process.env.JOB_RUNTIME_NAMESPACE = 'dev';
  const scheduler = require.resolve('../../services/jobScheduler.service');
  require.cache[scheduler] = {
    id: scheduler,
    filename: scheduler,
    loaded: true,
    exports: { triggerImmediate: async () => {} },
  };
  const queue = require('../../services/jobRequests.service');
  const socialEntries = new Map(),
    jobs = new Set(),
    published = [];
  let classified = 0;
  const capture = create({
    db,
    readSocial: async (key) => socialEntries.get(key),
    resolveRoute: async (_, event) => ({ ...route, channel: event.channel }),
    createExecution: (row) => db.FlowExecutionV2.create(row),
    enqueueJob: async (input) => {
      jobs.add(input.dedupeScope);
      return queue.enqueueUniqueJobRequest(input);
    },
    publishLead: async (e) => published.push(e.lead.id),
    restrictions: async () => ({}),
    classify: async (entry) => {
      classified++;
      return { kind: entry.text === 'INFO' ? 'interest' : 'ignore', privateRequested: false };
    },
  });
  require('../../services/inboundLeadCapture.service').run = capture.run;
  async function engine(input) {
    const enqueued = await capture.enqueue(input);
    assert.equal(enqueued.pending, true);
    const job = await db.JobRequest.findOne({
      where: { type: 'automations_v2_execute', 'payload.execution_id': enqueued.execution_id },
    });
    assert.ok(job);
    const claimed = await queue.claimJobById(job.id);
    assert.ok(claimed);
    const result = await require('../../services/jobExecutor.service').runJob(claimed);
    assert.equal(result.status, 'completed', result.error?.stack || JSON.stringify(result));
    const execution = await db.FlowExecutionV2.findByPk(enqueued.execution_id);
    assert.equal(execution.status, 'completed', execution.last_error);
    assert.equal(execution.context.outputs.N1.trigger_type, 'message_received');
    assert.equal(
      execution.context.outputs.N2.leadId,
      (await input.message.reload()).metadata.inboundLeadCapture.leadId,
    );
    const logs = await db.FlowExecutionLogV2.findAll({
      where: { flow_execution_id: execution.id },
      order: [['id', 'ASC']],
    });
    assert.deepEqual(
      logs.map((row) => [row.node_id, row.status]),
      [
        ['N1', 'success'],
        ['N2', 'success'],
        ['N3', 'success'],
      ],
    );
    let listing;
    await require('../../controllers/automationsV2.controller').listExecutions(
      {
        userData: { userId: 1 },
        query: { clinic_id: '41', template_version_id: String(execution.template_version_id) },
      },
      {
        json: (value) => {
          listing = value;
        },
        status(code) {
          throw Error('listing_http_' + code);
        },
      },
    );
    assert(listing.data.some((row) => row.id === execution.id));
    return { result: execution.context.outputs.N2, execution };
  }
  async function contact(channel, contactId) {
    return db.Conversation.create({
      clinic_id: 41,
      channel,
      contact_id: contactId,
      ...(channel !== 'whatsapp' ? { social_account_id: '501' } : {}),
    });
  }
  let n = 0;
  async function inbound(thread, content, extra = {}, dispatchSocial = false) {
    n++;
    const wa = thread.channel === 'whatsapp',
      mid = wa ? 'wamid.fixture' + n : 'social-mid-' + n;
    const entry = {
      source: 'new',
      echo: false,
      type: 'dm',
      at: new Date(timestamp).toISOString(),
      senderId: thread.contact_id,
      accountId: '501',
      channel: thread.channel,
      eventId: mid,
      text: content,
      ...(!wa ? extra : {}),
    };
    const metadata = wa
      ? {
          wamid: mid,
          phone_number_id: '501',
          waba_id: '801',
          provider_type: 'text',
          provider_sent_at: new Date(timestamp).toISOString(),
          ...extra,
        }
      : { providerId: mid, social: entry };
    const m = await db.Message.create({
      conversation_id: thread.id,
      direction: 'inbound',
      message_type: 'text',
      content,
      metadata,
      sent_at: new Date(timestamp),
    });
    const pk = wa ? mid : eventKey(entry);
    let dispatchJob;
    let claim = dispatchSocial
      ? null
      : await db.AutomationInboundMessageClaim.create({
          claim_key: pk,
          message_id: m.id,
          conversation_id: thread.id,
          channel: thread.channel,
          clinic_id: 41,
          provider_message_id: pk,
        });
    if (!wa) {
      Object.assign(entry, { messageId: m.id, conversationId: thread.id, clinicId: 41 });
      socialEntries.set(pk, entry);
      await db.SocialInboxReceipt.create({
        key: pk,
        event: entry,
        route: { ...route, channel: entry.channel },
        message_id: m.id,
        state: 'persisted',
      });
      if (dispatchSocial) {
        const module = require('../../services/socialLeadAutomation.service');
        const dispatch = require('../../services/automationInboundMessage.service');
        const workflow = module.create({
          db,
          social: { readEntry: async (key) => socialEntries.get(key) },
          resolve: async () => route,
          dispatch: async (payload, options) => {
            const out = await dispatch.enqueueInboundDispatch(payload, options);
            claim = out.claim;
            dispatchJob = out.job;
          },
        });
        module.start = workflow.start;
        require('../../services/inboundLeadCapture.service').enqueueSocial = capture.enqueue;
        await db.sequelize.transaction((transaction) =>
          workflow.enqueue({ entry, receiptKey: pk, conversation: thread, message: m, transaction }),
        );
      }
    }
    return { claim, message: m, conversation: thread, dispatchJob };
  }
  async function perform(input) {
    const e = await capture.enqueue(input);
    assert.equal(e.pending, true);
    const execution = await db.FlowExecutionV2.findByPk(e.execution_id);
    const result = await capture.run(execution);
    await execution.update({ status: 'completed' });
    return { result, execution };
  }
  const plain = await contact('whatsapp', '34600000041');
  const older = await inbound(plain, 'INFO', {
    provider_sent_at: new Date(Date.parse(since) - 1000).toISOString(),
  });
  assert.equal((await capture.enqueue(older)).pending, false);
  const recovered = await inbound(plain, 'INFO', { historical: true });
  assert.equal((await capture.enqueue(recovered)).pending, false);
  const original = await inbound(plain, 'INFO');
  const [one, two] = await Promise.all([capture.enqueue(original), capture.enqueue(original)]);
  assert.equal(one.execution_id, two.execution_id);
  const execution = await db.FlowExecutionV2.findByPk(one.execution_id);
  const parallel = await Promise.all([capture.run(execution), capture.run(execution)]);
  const winner = parallel.find((row) => row.leadId);
  assert.ok(winner);
  assert(parallel.every((row) => row.pending || row.leadId === winner.leadId));
  await execution.update({ status: 'completed' });
  assert.equal((await capture.enqueue(original)).lead_id, winner.leadId);
  const second = await perform(await inbound(await plain.reload(), '¿Tenéis promociones?'));
  assert.equal(second.result.leadId, winner.leadId);
  const before = await db.LeadIntake.count();
  await perform(await inbound(await contact('whatsapp', '34600000043'), 'STOP'));
  assert.equal(await db.LeadIntake.count(), before);
  const sg = await config.save(db, 41, 'social', 11, true);
  const sf = await db.AutomationFlowTemplateV2.findByPk(sg.template_id);
  await sf.update({ trigger_config: { ...sf.trigger_config, effective_from: since } });
  const profile = await contact('instagram', '771');
  assert.equal((await capture.enqueue(await inbound(profile, 'INFO', { source: 'history' }))).pending, false);
  const commercial = await inbound(profile, 'INFO', {}, true);
  assert.equal(commercial.dispatchJob.type, 'automation_inbound_dispatch');
  const jobRunner = require('../../services/jobExecutor.service');
  const claimed = await queue.claimJobById(commercial.dispatchJob.id);
  const held = await jobRunner.runJob(claimed);
  assert.equal(held.status, 'waiting', held.error?.stack || JSON.stringify(held));
  assert.equal((await commercial.claim.reload()).status, 'queued');
  const active = await engine(commercial);
  await queue.markWaiting(claimed.id, {
    nextRunAt: new Date(Date.now() - 1000),
    expectedAttempt: claimed.attempts,
  });
  const next = await queue.claimJobById(claimed.id);
  const completed = await jobRunner.runJob(next);
  assert.equal(completed.status, 'completed', completed.error?.stack || JSON.stringify(completed));
  assert.equal((await commercial.claim.reload()).status, 'completed');
  assert.equal(commercial.claim.owner_type, 'inbound_lead_capture');
  assert.equal(commercial.claim.owner_reference_id, active.execution.id);
  const beforeClassification = classified;
  const ambiguous = await inbound(profile, 'Ficticio ambiguo');
  const ambiguousKey = await capture.enqueue(ambiguous);
  const ambiguousExecution = await db.FlowExecutionV2.findByPk(ambiguousKey.execution_id);
  await Promise.all([capture.run(ambiguousExecution), capture.run(ambiguousExecution)]);
  assert.equal(classified, beforeClassification + 1);
  assert.equal((await ambiguous.message.reload()).metadata.inboundLeadCapture.reason, 'ignore');
  assert.equal(active.result.origin, 'instagram');
  assert.ok(active.result.leadId);
  assert.equal((await capture.run(active.execution)).leadId, active.result.leadId);
  const messenger = await contact('messenger', '779');
  const messengerDm = await engine(await inbound(messenger, 'Gracias'));
  assert.equal(messengerDm.result.origin, 'messenger');
  assert.equal(messengerDm.result.reason, 'ignore');
  assert.equal(messengerDm.result.leadId, null);
  const cancelled = await capture.enqueue(await inbound(profile, 'INFO'));
  const sgOff = await config.save(db, 41, 'social', 11, false);
  const cancelledExecution = await db.FlowExecutionV2.findByPk(cancelled.execution_id);
  assert.equal((await capture.run(cancelledExecution)).reason, 'capture_not_eligible');
  assert.equal(sgOff.version, 2);
  assert.equal((await capture.enqueue(await inbound(profile, 'INFO'))).pending, false);
  assert.equal((await config.current(db, 41, 'whatsapp')).is_active, true);
  const campaign = await db.MarketingPatientList.create({
    clinica_id: 41,
    name: 'Campaña ficticia',
    objective_id: 'mass_sends',
    criteria: { record_kind: 'campaign', template_commercial: true },
  });
  const target = await contact('whatsapp', '34600000042');
  const item = await db.MarketingPatientListItem.create({
    list_id: campaign.id,
    clinica_id: 41,
    phone: target.contact_id,
  });
  async function send(policy, at, mid, overrides = {}) {
    return db.Message.create({
      conversation_id: target.id,
      direction: 'outbound',
      message_type: 'template',
      status: 'sent',
      content: 'Campaña ficticia',
      createdAt: new Date(at),
      metadata: {
        kind: 'mass_campaign_send',
        source: 'marketing_bulk_sends',
        dispatch_context: 'campaign',
        list_id: campaign.id,
        item_id: item.id,
        delivery_clinic_id: 41,
        phoneNumberId: '501',
        wabaId: '801',
        wamid: mid,
        template_commercial: true,
        recipient: target.contact_id,
        ...(policy ? { whatsapp_lead_capture_policy: policy } : {}),
        ...overrides,
      },
    });
  }
  await send(null, Date.parse(since) - 3000, 'wamid.old');
  const noRetro = await perform(await inbound(target, 'INFO', { context: { id: 'wamid.old' } }));
  assert.equal(noRetro.result.reason, 'campaign_excluded');
  await send('disabled', timestamp - 15000, 'wamid.disabled');
  const excluded = await perform(await inbound(target, 'INFO', { context: { id: 'wamid.disabled' } }));
  assert.equal(excluded.result.leadId, null);
  await send('inherit', timestamp - 10000, 'wamid.active');
  const camp = await perform(await inbound(target, 'INFO', { context: { id: 'wamid.active' } }));
  assert.equal(camp.result.campaignId, campaign.id);
  assert.ok(camp.result.leadId);
  const ca = await perform(
    await inbound(await target.reload(), '¿Qué promociones hay?', { context: { id: 'wamid.active' } }),
  );
  assert.equal(ca.result.leadId, camp.result.leadId);
  assert.equal(await db.LeadIntake.count(), before + 2);
  const audits = await db.LeadAttributionAudit.findAll({ attributes: ['attribution_steps'], raw: true });
  assert.equal(
    audits.filter((row) => row.attribution_steps.inbound_capture || row.attribution_steps.whatsapp_bulk_send)
      .length,
    3,
  );
  assert.equal(published.length, 3);
  assert.ok(classified > 0);
  assert.ok(jobs.size > 2);
  assert.ok(originalStart > Date.parse(since));
  assert.equal(await db.Message.count({ where: { direction: 'outbound', message_type: 'text' } }), 0);
  const paused = await config.save(db, 41, 'whatsapp', 11, false);
  assert.equal(paused.active, false);
  const legacy = await db.MarketingPatientList.create({
    clinica_id: 41,
    name: 'Campaña antigua',
    objective_id: 'mass_sends',
    criteria: { record_kind: 'campaign', capture_whatsapp_info_leads: true },
  });
  const legacyItem = await db.MarketingPatientListItem.create({
    list_id: legacy.id,
    clinica_id: 41,
    phone: target.contact_id,
  });
  await send(null, timestamp - 20000, 'wamid.classic', {
    list_id: legacy.id,
    item_id: legacyItem.id,
    capture_whatsapp_info_leads: true,
  });
  const { attributeCampaignInfoReply } = require('../../services/marketingWhatsappReplyLead.service');
  async function attributeClassic(metadata, id) {
    const input = await inbound(target, 'INFO', { ...metadata, context: { id } });
    assert.equal((await capture.enqueue(input)).pending, false);
    return sql.transaction((transaction) =>
      attributeCampaignInfoReply({
        db,
        conversation: target,
        message: input.message,
        binding: { clinicId: 41, phoneId: '501', wabaId: '801' },
        freshDispatch: true,
        transaction,
      }),
    );
  }
  const classicNative = await attributeClassic({ phoneId: '501', wabaId: '801' }, 'wamid.classic');
  const classicFresh = await attributeClassic(
    { passive_recovery: true, fresh_inbound_authorization_id: 'fixture' },
    'wamid.classic',
  );
  assert.equal(classicNative.lead.id, classicFresh.lead.id);
  assert.equal(classicFresh.duplicate, true);
  assert.equal(await attributeClassic({}, 'wamid.disabled'), null);
  assert.equal(await attributeClassic({}, 'wamid.active'), null);
  assert.equal(await db.LeadIntake.count(), 4);
  report.capture = {
    queueToEngineToExecutionListing: true,
    distinctLeads: 4,
    historicalCampaignStillCapturesWhilePaused: true,
    unconfiguredSocialReplySkipped: true,
    messengerInbox: true,
    providerSends: 0,
    concurrentReplay: true,
    independentPublications: true,
  };
}).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

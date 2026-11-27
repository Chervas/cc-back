'use strict';
const assert = require('node:assert/strict');
const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { create: createInbox } = require('../../services/socialInbox.service');
const { create: createAutomation } = require('../../services/socialLeadAutomation.service');
const { classifyInterest } = require('../../services/socialLeadInterestClassification.service');
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
    'LeadAssistantPublication',
    'LeadAssistantSession',
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
  const changedThreads = [];
  const scheduler = require.resolve('../../services/jobScheduler.service');
  require.cache[scheduler] = {
    id: scheduler,
    filename: scheduler,
    loaded: true,
    exports: { triggerImmediate: async () => {} },
  };
  const configService = require('../../services/leadAutoReply.service');
  const rule = { action: 'message', text: 'Gracias por solicitar información.' };
  const entries = { instagram_comment: rule, instagram_dm: rule, messenger_dm: { action: 'notify' } };
  const status = await configService.saveConfig({
    actorUserId: 23, clinicId: 41, input: { sources: [], social_entries: entries, active: true },
  });
  assert.equal(status.active, true);
  assert.equal(status.readiness.ready, true);
  assert.deepEqual((await configService.getStatus(41)).config.social_entries, entries);
  const flow = await db.AutomationFlowTemplateV2.findByPk(status.flow.id);
  let expectedFlowId = flow.id;
  const at = Math.max(Date.now(), flow.published_at.getTime());
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
    send: async (r, kind, recipient, text, attemptId, imageUrl) => {
      posts.push({ kind, recipient, text, attemptId, ...(imageUrl ? {imageUrl} : {}) });
      return { available: true, messageId: 'sent-' + attemptId, recipientId: kind === 'dm' ? recipient : '771' };
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
      assert.equal(result.claim.metadata.social_template_id, expectedFlowId);
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
    classify: classifyInterest,
    analyzeAssistant:async request => {
      assert.equal(request.useCase,'lead_assistant_reply');
      assert.equal(request.requireBroker,true);
      assert(!request.inputText.includes('https://'));
      const choice = JSON.parse(request.inputText).promotion.images[0];
      await request.beforeDispatch();
      return {reply:'La oferta incluye una visita informativa.',imageId:choice.id};
    },
    checkPatientRestrictions: async () => ({ marketing_opt_out: false }),
    publishLead: ({ lead }) => published.push(lead.id),
    notifyConversation: (clinicId, packet) =>
      changedThreads.push({
        clinicId,
        body: require('../../lib/socket-payload').packetFor('message:refresh', packet).body,
      }),
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
  const sent = await db.Message.findAll({ where: { conversation_id: c.id, direction: 'outbound' } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, rule.text);
  assert.equal(sent[0].content, posts[0].text);
  assert.equal(sent[0].metadata.execution_id, first.id);
  assert.equal(sent[0].metadata.socialAttempt, posts[0].attemptId);
  assert.equal(sent[0].metadata.outcome, 'sent');
  assert.equal(published.length, 1);
  assert.deepEqual(changedThreads, [
    {
      clinicId: 41,
      body: { id: first.trigger_entity_id, conversation_id: c.id, realtime_refresh: true, metadata: {} },
    },
  ]);
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
  const graph = flow.nodes;
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
  await receive(dm('instagram', '501', 'after-stop', 'INFO'));
  // Dispatch the INFO before the worker assigned to the already persisted opt-out.
  const stopped = await automation.run(await begin(4));
  assert.equal(stopped.attention, true);
  assert.equal(stopped.reason, 'marketing_opt_out');
  assert.equal((await automation.run(await begin(3))).reason, 'opt_out');
  assert.equal(posts.length, 2);
  await receive(dm('instagram', '501', 'medical', 'Quiero información de la promo y tengo fiebre.', '773'));
  const review = await automation.run(await begin(5));
  assert.equal(review.attention, true);
  assert.equal(review.lead_id, null);
  await receive(dm('instagram', '501', 'paused', 'INFO', '775'));
  const suspended = await begin(6);
  await flow.update({ is_active: false });
  assert.equal((await automation.run(suspended)).reason, 'social_entry_disabled');
  await receive(dm('instagram', '501', 'paused-stop', 'No me escribas más', '775'));
  const pausedStop = await db.Message.findOne({ where: { 'metadata.providerId': 'paused-stop' } });
  assert.equal(pausedStop.metadata.socialContactOptOut, true);
  assert.equal(claims.length, 7);
  await flow.update({ is_active: true });
  const withdrawnKey = await receive(dm('instagram', '501', 'withdrawn-before-dispatch', 'INFO', '777'));
  const queuedExecution = await begin(7);
  const withdrawn = await db.SocialInboxReceipt.findByPk(withdrawnKey);
  await withdrawn.update({ state: 'withdrawn', event: { ...withdrawn.event, source: 'withdrawal', text: '' } });
  assert.equal((await automation.run(queuedExecution)).reason, 'social_entry_unavailable');
  assert.equal(await db.LeadIntake.count(), 2);
  assert.equal(posts.length, 2);
  const promo = 'C02-03 · Oferta ficticia\nImagen: https://media.example.com/november.png';
  const imageId = require('../../services/leadAssistantPromotionImages.service').catalog(promo).get('C02-03')[0].id;
  const pictureThread = await db.Conversation.create({ clinic_id:41, channel:'instagram', social_account_id:'501',
    contact_id:'778', last_inbound_at:new Date(), last_message_at:new Date() });
  const incoming = await db.Message.create({conversation_id:pictureThread.id, direction:'inbound', content:'¿Puedo ver la foto?',
    metadata:{leadAssistantTurn:{templateId:flow.id,publicationVersion:4,executionId:73,promotionKey:'C02-03'}}});
  await db.LeadAssistantPublication.create({clinic_id:41,version:4,approved_at:new Date(),approved_by:7,fields:{tone:'Cercano',context:'Información comercial',guardrails:'Derivar cuestiones clínicas',booking:'Solicitar confirmación',promotions:promo}});
  await db.LeadAssistantSession.create({clinic_id:41,conversation_id:pictureThread.id,template_id:flow.id,publication_version:4,
    origin_message_id:incoming.id,origin_input:'instagram_dm',state:'active',updated_at:new Date()});
  const selection = {templateId:flow.id,version:4,executionId:73,messageId:incoming.id,key:'C02-03',id:imageId};
  const command = {selection,actorId:7,attemptId:require('node:crypto').randomUUID()};
  const args = {executionId:73,blockReason:async()=>null};
  const delivered = await social.replyWithPromotionImage(pictureThread,command,args);
  assert.equal(delivered.outcome,'sent'); assert.equal(delivered.message.message_type,'image');
  assert.equal(delivered.message.metadata.promotionImage.url,'https://media.example.com/november.png');
  assert.equal(posts.at(-1).recipient,'778'); assert.equal(posts.at(-1).imageUrl,delivered.message.metadata.promotionImage.url);
  assert.equal((await social.replyWithPromotionImage(pictureThread,command,args)).outcome,'sent');
  assert.equal(posts.length,3);
  const closed = { ...command, attemptId:require('node:crypto').randomUUID() };
  await pictureThread.update({last_inbound_at:new Date(Date.now()-25*3600000)});
  assert.equal((await social.replyWithPromotionImage(pictureThread,closed,args)).reason,'dm_window_closed');
  assert.equal(posts.length,3);

  const configured = await configService.saveConfig({clinicId:41,actorUserId:1,input:{active:true,sources:[],
    schedule_scope:'all_days',social_entries:{instagram_dm:{action:'assistant',version:4,audience:'leads',origins:['social_inbox']},whatsapp_dm:{action:'assistant',version:4,audience:'leads',origins:['google_ads']}}}});
  const activeAssistant = await db.AutomationFlowTemplateV2.findByPk(configured.flow.id);
  assert.deepEqual(activeAssistant.trigger_config.social_entries.whatsapp_dm.origins, ['google_ads']);
  const sourceCheck = require('../../services/leadAssistantOrigin.service');
  assert.equal(sourceCheck.validOrigins(['unrecognised']), false);
  assert.equal(sourceCheck.validOrigins([]), false);
  const filter = { origins: ['meta_ads'] };
  assert.equal(await sourceCheck.acceptsOrigin(db, filter, pictureThread, { channel: 'instagram', ad: {} }), true);
  assert.equal(await sourceCheck.acceptsOrigin(db, filter, pictureThread, { channel: 'instagram' }), false);
  assert.equal(await sourceCheck.acceptsOrigin(db, {}, pictureThread, { channel: 'instagram' }), true);

  expectedFlowId = activeAssistant.id;
  assert(activeAssistant.nodes.some(node=>node.type === 'action/attend_with_lead_assistant'));
  const message = dm('instagram','501','assistant-asks-photo','¿Me pasas la foto de la promoción C02-03?','779');
  message.entry[0].messaging[0].timestamp = Math.max(Date.now(),activeAssistant.published_at.getTime());
  const nextClaim = claims.length;
  await receive(message);
  const assistantExecution = await begin(nextClaim);
  const invoke = await automation.run(assistantExecution);
  assert.equal(invoke.invoke_assistant,true);
  const response = await automation.run(assistantExecution,true);
  assert.equal(response.outcome,'sent', JSON.stringify(response));
  assert.equal(response.image,'sent', JSON.stringify(response));
  assert.match(posts.at(-2).text,/asistente de IA de Demo A/);
  assert.equal(posts.at(-1).imageUrl,'https://media.example.com/november.png');
  assert.equal(posts.at(-1).recipient,'779');
  const sentCount = posts.length;
  await automation.run(assistantExecution,true);
  assert.equal(posts.length,sentCount);
  const whatsappApi = require('../../services/leadAssistantWhatsapp.service');
  const inboundWhatsapp = await db.Conversation.create({clinic_id:41,channel:'whatsapp',contact_id:'+34600000041'});
  const waMessage = await db.Message.create({conversation_id:inboundWhatsapp.id,direction:'inbound',message_type:'text',
    content:'¿Me pasas la foto de la promoción C02-03?',status:'sent',sent_at:new Date(),metadata:{wamid:'wamid.FICTICIO',phoneId:'10041',provider_sent_at:new Date().toISOString()}});
  const waClaim = await db.AutomationInboundMessageClaim.create({clinic_id:41,conversation_id:inboundWhatsapp.id,message_id:waMessage.id,
    channel:'whatsapp',claim_key:'whatsapp:wamid.FICTICIO',provider_message_id:'wamid.FICTICIO'});
  const waConfig = {phoneNumberId:'10041',authorizedBroker:{sendEnabled:true}};
  const waPosts = [];
  const waAssistant = whatsappApi.create({db,createExecution:runtime.createExecution,enqueueJob:async()=>{},refresh:()=>{},
    resolveRoute:async(c,number)=>c.id===inboundWhatsapp.id && number===waConfig.phoneNumberId ? waConfig : null,
    restrictions:async()=>({}),analyze:async request=>{
      await request.beforeDispatch();
      assert(!request.inputText.includes('https://'));
      return {reply:'Aquí tienes la foto de la promoción.',imageId:JSON.parse(request.inputText).promotion.images[0].id};
    },send:async payload=>{
      assert.equal(payload.useTemplate,false);
      assert.equal(payload.to,inboundWhatsapp.contact_id);
      assert.equal(payload.image.link,'https://media.example.com/november.png');
      assert.match(payload.body,/asistente de IA de Demo A/);
      const message = await db.Message.findByPk(payload.healthContext.messageId);
      const intent = {replyWindowEndsAt:payload.healthContext.replyWindowEndsAt,message:{to:payload.to,type:'image',image:{...payload.image,caption:payload.body}}};
      const authorize = (copy,binding={phoneId:'10041'})=>whatsappApi.authorizeDelivery(db,{message,conversation:inboundWhatsapp,intent:copy,selectedBinding:binding});
      assert(await authorize(intent));
      assert.equal(await authorize({...intent,message:{...intent.message,to:'+34600000099'}}),false);
      assert.equal(await authorize({...intent,message:{...intent.message,image:{...intent.message.image,link:'https://media.example.com/otro.png'}}}),false);
      assert.equal(await authorize(intent,{phoneId:'1234'}),false);
      waPosts.push(payload);return {messages:[{id:'wamid.FICTICIO.foto'}]};
    }});
  const input = {claim:waClaim,message:waMessage,conversation:inboundWhatsapp};
  assert.equal(await waAssistant.start(input), null);
  const webLead = await db.LeadIntake.create({ clinica_id:41, source:'web', gclid:'ficticio', status_lead:'nuevo' });
  await inboundWhatsapp.update({ lead_id: webLead.id });
  const initiated = await waAssistant.start(input);
  assert(initiated?.execution_id);
  assert.equal((await waAssistant.start(input)).execution_id,initiated.execution_id);
  const waExecution = await db.FlowExecutionV2.findByPk(initiated.execution_id);
  const deliveredPhoto = await waAssistant.run(waExecution);
  assert.equal(deliveredPhoto.outcome,'sent',JSON.stringify(deliveredPhoto));
  assert.equal((await waAssistant.run(waExecution)).outcome,'sent');
  assert.equal(waPosts.length,1);
  await waMessage.update({metadata:{...waMessage.metadata,provider_sent_at:new Date(Date.now()-24*3600000).toISOString()}});
  assert.equal(await waAssistant.start(input),null);
  assert.equal((await waAssistant.run(waExecution)).reason,'whatsapp_entry_unavailable');
  assert.equal(waPosts.length,1);
  report.assertions = [
    'Filtro de origen por canal aplicado antes de ejecutar y enviar, con atribución de Leads o de anuncio Meta y reglas anteriores sin filtro.',
    'WhatsApp atiende una entrada con una foto y pie sin plantilla. Misma ejecución, conversación, número, foto aprobada y plazo de 24 h.',
    'Entrada → selector V2 → asistente simulado → respuesta e imagen indicada por la clínica en el mismo DM',
    'Foto de la promoción aprobada en el DM, control de ventana y deduplicación del envío',
    'Saved social-only clinic configuration → persisted V2 graph',
    'Live comment → scoped lead and one private reply',
    'duplicate webhook and worker',
    'DM continuation reuses lead',
    'Messenger team notification',
    'history and echoes excluded',
    'clinic isolation',
    'opt-out before classification and while paused, withdrawn DM, and clinical review',
    'pause before execution',
  ];
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

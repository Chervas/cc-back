'use strict';
const assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');
const C = require('../../lib/patient-mobile-verification');
const { createRuntime } = require('../../services/patientMobileVerification.service');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.Sequelize = S;
  const D = S.DataTypes, pk = { type: D.INTEGER, primaryKey: true, autoIncrement: true };
  const simple = (name, fields, table = name + 's') => sql.define(name, fields, { tableName: table, timestamps: false });
  for (const [name, file] of Object.entries({ PatientOperationalEvent: 'patientoperationalevent',
    AutomationFlowTemplateV2: 'automationflowtemplatev2', FlowExecutionV2: 'flowexecutionv2', FlowExecutionLogV2: 'flowexecutionlogv2', Message: 'message',
    Notification: 'notification', AutomationFlowCatalog: 'automationflowcatalog', WhatsappTemplateCatalog: 'whatsapptemplatecatalog' })) {
    db[name] = require('../../../models/' + file)(sql, D);
  }
  db.Clinica = simple('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, nombre_clinica: D.STRING }, 'Clinicas');
  db.Paciente = simple('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, telefono_movil: D.STRING }, 'Pacientes');
  db.PacienteClinica = simple('PacienteClinica', { id: pk, paciente_id: D.INTEGER, clinica_id: D.INTEGER });
  db.PatientConsentDocument = simple('PatientConsentDocument', { id: pk, paciente_id: D.INTEGER, clinica_id: D.INTEGER,
    status: D.STRING, revoked_at: D.DATE, snapshot_hash: D.STRING });
  db.Conversation = simple('Conversation', { id: pk, clinic_id: D.INTEGER, patient_id: D.INTEGER, lead_id: D.INTEGER,
    channel: D.STRING, contact_id: D.STRING, unread_count: D.INTEGER });
  db.WhatsappTemplate = simple('WhatsappTemplate', { id: pk, waba_id: D.STRING, name: D.STRING, language: D.STRING,
    status: D.STRING, category: D.STRING, is_active: D.BOOLEAN, components: D.JSON });
  db.JobRequest = require('../../../models/jobrequest')(sql, D);
  db.PatientOperationalEvent.options.indexes.forEach((index, i) => { index.name = `qa_mobile_verification_${i}`; });
  db.FlowExecutionV2.belongsTo(db.AutomationFlowTemplateV2, { foreignKey: 'template_version_id', as: 'templateVersion' });
  await sql.sync();
  await sql.getQueryInterface().addIndex('AutomationFlowTemplatesV2', ['public_id', 'version'], { unique: true });
  await sql.getQueryInterface().addIndex('FlowExecutionsV2', ['idempotency_key'], { unique: true });
  const check = text => report.checks.push(text);
  const migration = require('../../../migrations/20261018100000-prepare-patient-mobile-verification-v2');
  await migration.up(sql.getQueryInterface()); await migration.up(sql.getQueryInterface());
  assert.equal(await db.AutomationFlowTemplateV2.count(), 1);
  assert.equal(await db.AutomationFlowCatalog.count({ where: { is_active: false } }), 1);
  assert.equal(await db.WhatsappTemplateCatalog.count({ where: { is_active: false } }), 1);
  assert.equal(await db.JobRequest.count() + await db.Message.count(), 0);
  check('data-only migration is repeatable and prepares inactive catalogues without jobs/provider calls');
  let clock = new Date('2026-10-20T12:00:00Z'), enabled = false, blocked = false, held = false, handoffFailures = 0;
  const queued = [], sender = { originId: 30, phoneNumberId: 'TESTONLY-PHONE', wabaId: 'TESTONLY-WABA' };
  const engine = loadSource('flowEngineV2.service', { '../../models': db,
    './jobRequests.service': { getCurrentRuntimeNamespace: () => 'TESTONLY' } }, {}, 10000);
  const requests = loadSource('jobRequests.service', { '../../models': db }, { JOB_RUNTIME_NAMESPACE: 'TESTONLY' });
  const enqueueJob = requests.enqueueUniqueJobRequest;
  const deps = { db, now: () => clock, enabled: () => enabled, enqueueJob,
    assignees: async () => [15, 15, 16], authorizeActor: async () => { if (blocked) throw Error('access_denied'); },
    patientHeld: async () => held, communicationAllowed: async () => { if (blocked) throw Error('blocked'); },
    checkCorrection: async () => { if (blocked) throw Error('collision'); }, groupClinicIds: async () => [72, 73],
    stop: { createExecution: v => db.FlowExecutionV2.create(v), isStop: () => false },
    engine: { computeQuietHoursDelayMs: engine.computeQuietHoursDelayMs,
      findOrCreateAutomationWhatsappMessage: args => engine.findOrCreateAutomationWhatsappMessage({ ...args,
        values: { ...args.values, createdAt: clock } }),
      resolveScheduledWhatsappSenderConfig: async () => sender,
      enqueueAutomationWhatsappTransport: async ({ msg, recipient }) => {
        await msg.update({ metadata: { ...msg.metadata, automation_transport_job_id: 'TESTONLY-' + msg.id } });
        if (handoffFailures-- > 0) throw Error('TESTONLY queue unavailable after ID persisted');
        queued.push({ id: msg.id, recipient });
      } }, wake: async () => {} };
  let runtime = createRuntime(deps);
  await db.Clinica.bulkCreate([{ id_clinica: 72, nombre_clinica: 'TESTONLY Medical' }, { id_clinica: 73, nombre_clinica: 'TESTONLY Capilar' }]);
  const local = await db.AutomationFlowTemplateV2.create({ ...C.definition(72), is_active: true, published_at: clock,
    trigger_config: { configured: true, enabled_after: '2026-10-20T11:00:00Z', response_timeout_minutes: 60 } });
  const approved = await db.WhatsappTemplate.create({ ...sender, waba_id: sender.wabaId, name: C.TEMPLATE, language: 'es_ES',
    category: 'UTILITY', status: 'APPROVED', is_active: true,
    components: [{ type: 'BODY', text: C.BODY }, { type: 'BUTTONS', buttons: C.BUTTONS.map(text => ({ type: 'QUICK_REPLY', text })) }] });
  let patientSeq = 100;
  async function source({ clinic = 72, phone, permitted } = {}) {
    const patientId = ++patientSeq, number = phone || '34600' + String(patientId).padStart(6, '0');
    await db.Paciente.create({ id_paciente: patientId, clinica_id: clinic, telefono_movil: number });
    const doc = await db.PatientConsentDocument.create({ paciente_id: patientId, clinica_id: clinic,
      status: 'signed', snapshot_hash: 'TESTONLY-' + patientId });
    const request = await sql.transaction(async transaction => runtime.recordRequest({ patient_id: patientId, clinic_id: clinic,
      actor_user_id: 15, source: 'privacy_profile_review', channel: 'internal', occurred_at: clock,
      metadata: { document_id: doc.id, snapshot_hash: doc.snapshot_hash, previous_phone: '34699000000', phone: number } }, { transaction }));
    if (permitted !== undefined) assert.equal(request.metadata.delivery_enabled, permitted);
    return request;
  }
  async function execution(request) {
    const r = await runtime.dispatch({ request_event_id: request.id, clinic_id: request.clinic_id });
    return r.result.execution_id ? db.FlowExecutionV2.findByPk(r.result.execution_id) : null;
  }
  const nodes = local.nodes, send = nodes[1], wait = nodes[2], review = nodes[3];
  const processEngine = loadSource('flowEngineV2.service', { '../../models': db,
    './patientMobileVerification.service': { current: () => runtime },
    './jobRequests.service': { getCurrentRuntimeNamespace: () => 'TESTONLY' } }, {}, 10000);
  const process = (node, exec, context = exec.context) => processEngine._processNode(node, context, { execution: exec });
  const transportArgs = message => ({ message, to: message.metadata.recipient, sender, useTemplate: true,
    templateName: message.metadata.template_name, templateLanguage: message.metadata.template_language,
    templateComponents: message.metadata.template_components });
  async function sent(request) {
    const exec = await execution(request), result = await process(send, exec);
    assert.equal(result.next_node_id, 'N3');
    const message = await db.Message.findByPk(result.output.message_id);
    return { exec, message };
  }
  async function accept(message, at = clock) {
    await message.update({ metadata: { ...message.metadata, wamid: 'wamid.TESTONLY.' + message.id,
      provider_acceptance_at: at.toISOString(), provider_acceptance_status: 'accepted' } });
  }
  async function reply(request, message, answer, extra = {}) {
    const inbound = await db.Message.create({ conversation_id: message.conversation_id, direction: 'inbound', content: answer || 'TESTONLY free text',
      message_type: 'text', status: 'delivered', sent_at: clock, metadata: { automatic_actions_allowed: true,
        historical: false, inbox_receipt: 'TESTONLY', fresh_inbound_dispatched_at: clock.toISOString(),
        phone_number_id: sender.phoneNumberId, waba_id: sender.wabaId, context: { id: message.metadata.wamid },
        ...(answer ? { button: { payload: `pmv:${request.id}:${request.metadata.reply_token}:${answer}` } } : {}), ...extra } });
    const conversation = await db.Conversation.findByPk(message.conversation_id);
    return { inbound, conversation, result: await runtime.inbound({ message: inbound, conversation }) };
  }
  async function task(exec, reason) { return process(review, exec, { ...exec.context, outputs: { result: { reason } } }); }
  async function manual(request, action, rest = {}) {
    const s = await runtime.state(request);
    return sql.transaction(transaction => runtime.manual({ patientId: request.patient_id, clinicId: request.clinic_id,
      actorId: 16, transaction, authorizeCurrent: async () => {}, payload: { request_event_id: request.id, revision: s.revision, action, ...rest } }));
  }

  const disabled = await source({ permitted: false });
  assert.equal(await execution(disabled), null); assert.equal(await db.JobRequest.count(), 0);
  enabled = true;
  assert.equal(await execution(disabled), null);
  const missingScope = await source({ clinic: 73, permitted: false }); assert.equal(await execution(missingScope), null);
  check('global switch off, missing scoped activation and historical disabled requests never dispatch');
  const first = await source({ permitted: true });
  const dispatches = await Promise.all(Array.from({ length: 12 }, () => runtime.dispatch({ request_event_id: first.id, clinic_id: 72 })));
  assert.equal(new Set(dispatches.map(r => r.result.execution_id)).size, 1);
  assert.equal(await db.FlowExecutionV2.count(), 1);
  assert.equal(await db.JobRequest.count({ where: { type: 'automations_v2_execute' } }), 1);
  const firstSent = await sent(first);
  await process(send, firstSent.exec);
  runtime = createRuntime(deps); await process(send, firstSent.exec);
  assert.equal(queued.length, 1); assert.equal(queued[0].recipient, first.metadata.phone);
  assert.equal(firstSent.exec.trigger_entity_type, 'patient_operational_event');
  assert.equal((await runtime.authorizeTransport(transportArgs(firstSent.message))).allowed, true);
  check('12 concurrent dispatches and repeated native V2 actions/restart use one execution/job/message/transport and frozen recipient');
  const yesWait = await process(wait, firstSent.exec); assert.equal(yesWait.waiting_meta.reason, 'awaiting_transport');
  clock = new Date(+clock + 2 * 3600000); await accept(firstSent.message);
  const timed = await process(wait, firstSent.exec); assert.equal(+timed.wait_until, +clock + 3600000);
  check('response clock starts at provider acceptance, not at request creation or queue publication');
  const yes = await reply(first, firstSent.message, 'yes');
  assert.equal(yes.result.state, 'confirmed'); assert.equal((await process(wait, firstSent.exec)).next_node_id, 'N5');
  assert.equal((await runtime.inbound({ message: yes.inbound, conversation: yes.conversation })).ignored, true);
  assert.equal((await runtime.state(first)).history.length, 1);
  assert.equal(await db.Notification.count(), 0);
  const laterChat = await db.Message.create({ conversation_id: firstSent.message.conversation_id, direction: 'inbound',
    message_type: 'text', content: 'TESTONLY unrelated conversation', sent_at: clock, metadata: {} });
  assert.equal((await runtime.inbound({ message: laterChat, conversation: yes.conversation })).handled, false);
  check('correlated positive reply verifies only the number; duplicate is harmless and no reception task is created');
  const rejected = await source(), rejectedSent = await sent(rejected); await accept(rejectedSent.message);
  await Promise.all([reply(rejected, rejectedSent.message, 'no'), reply(rejected, rejectedSent.message, 'no')]);
  const rejectedState = await runtime.state(rejected);
  assert.equal(rejectedState.reason, 'patient_rejected'); assert.equal(rejectedState.history.length, 1);
  assert.equal(await db.Notification.count(), 2);
  assert.equal((await db.Paciente.findByPk(rejected.patient_id)).telefono_movil, rejected.metadata.phone);
  await task(rejectedSent.exec, 'no_response'); assert.equal(await db.Notification.count(), 2);
  check('negative concurrent replies create one result and one task per reception employee; phone and commercial preferences are untouched');
  const timeout = await source(), timeoutSent = await sent(timeout); await accept(timeoutSent.message);
  clock = new Date(+clock + 61 * 60000);
  assert.equal((await process(wait, timeoutSent.exec)).next_node_id, 'N4');
  await task(timeoutSent.exec, 'no_response'); await task(timeoutSent.exec, 'no_response');
  assert.equal((await runtime.state(timeout)).reason, 'no_response');
  const late = await reply(timeout, timeoutSent.message, 'yes'); assert.equal(late.result.state, 'confirmed');
  const lateTasks = await db.Notification.findAll({ where: { dedupeKey: { [S.Op.like]: `patient-mobile-verification:${timeout.id}:%` } } });
  assert(lateTasks.every(n => n.isRead && n.data.resolved));
  const lateNoRequest = await source(), lateNoSent = await sent(lateNoRequest); await accept(lateNoSent.message);
  await task(lateNoSent.exec, 'no_response'); await reply(lateNoRequest, lateNoSent.message, 'no');
  const lateNoTasks = await db.Notification.findAll({ where: { dedupeKey: { [S.Op.like]: `patient-mobile-verification:${lateNoRequest.id}:%` } } });
  assert.equal(lateNoTasks.length, 2);
  assert(lateNoTasks.every(n => n.message === C.reasons.patient_rejected && n.data.reason === 'patient_rejected' && !n.isRead));
  check('no-response review is deduplicated; a current late yes closes all tasks without updating appointments');
  const manualReq = await source(), manualSent = await sent(manualReq); await accept(manualSent.message);
  await task(manualSent.exec, 'no_response'); await manual(manualReq, 'pending');
  assert.equal((await runtime.state(manualReq)).state, 'review_required');
  const beforeManual = (await runtime.state(manualReq)).revision;
  await manual(manualReq, 'confirm');
  const manualState = await runtime.state(manualReq);
  assert.equal(manualState.state, 'confirmed'); assert.equal(manualState.actor_user_id, 16); assert(manualState.manually_resolved);
  assert(manualState.resolved_at);
  assert.equal((await reply(manualReq, manualSent.message, 'no')).result.ignored, true);
  await assert.rejects(sql.transaction(transaction => runtime.manual({ patientId: manualReq.patient_id, clinicId: 72, actorId: 16,
    transaction, authorizeCurrent: async () => {}, payload: { request_event_id: manualReq.id, revision: beforeManual, action: 'pending' } })), /mobile_verification_changed/);
  check('manual confirm/keep-pending preserve employee/time/history, close tasks and reject stale revisions and later contradictory replies');
  const corrected = await source(), correctedSent = await sent(corrected); await accept(correctedSent.message);
  const nextPhone = '34601000199';
  const correction = await manual(corrected, 'correct', { phone: nextPhone, acknowledged: true });
  const next = await db.PatientOperationalEvent.findByPk(correction.request_event_id);
  assert.equal(next.metadata.phone, nextPhone); assert.equal(next.source, 'reception_mobile_verification');
  assert.equal((await runtime.state(corrected)).current, false);
  assert.equal((await reply(corrected, correctedSent.message, 'yes')).result.ignored, true);
  assert.equal((await runtime.authorizeTransport(transportArgs(correctedSent.message))).allowed, false);
  const backToA = await manual(next, 'correct', { phone: corrected.metadata.phone, acknowledged: true });
  assert(backToA.request_event_id > correction.request_event_id);
  assert.equal((await reply(corrected, correctedSent.message, 'yes')).result.ignored, true);
  check('reception correction makes a new request; ABA phone changes invalidate old transport and old replies by request ID');
  const failed = await source(), failedSent = await sent(failed);
  await failedSent.message.update({ status: 'failed' });
  assert.equal((await process(wait, failedSent.exec)).output.reason, 'delivery_failed');
  await task(failedSent.exec, 'delivery_failed');
  assert.equal((await runtime.state(failed)).reason, 'delivery_failed');
  check('failed delivery becomes an explicit reception delivery task, never a no-response result');
  const handoff = await source(), handoffExec = await execution(handoff); handoffFailures = 1;
  const unpublished = await process(send, handoffExec);
  assert.equal(unpublished.kind, 'waiting'); assert.equal(unpublished.waiting_meta.reason, 'transport_handoff');
  runtime = createRuntime(deps);
  const recoveredHandoff = await process(send, handoffExec);
  assert.equal(recoveredHandoff.next_node_id, 'N3');
  assert.equal(await db.Message.count({ where: { automation_delivery_key: `mobile-verification:${handoff.id}:outbound` } }), 1);
  check('a queue failure after persisting its job ID waits and resumes after restart using the same Message; no phantom successful publication');
  const uncertain = await source(), uncertainSent = await sent(uncertain);
  await uncertainSent.message.update({ metadata: { ...uncertainSent.message.metadata, delivery_unknown: true } });
  assert.equal((await process(wait, uncertainSent.exec)).waiting_meta.reason, 'awaiting_transport');
  const queuedBefore = queued.length; await process(send, uncertainSent.exec); assert.equal(queued.length, queuedBefore);
  await sql.query('UPDATE Messages SET createdAt=:at WHERE id=:id', {
    replacements: { at: new Date(+clock - 86401000), id: uncertainSent.message.id } });
  assert.equal((await process(wait, uncertainSent.exec)).output.reason, 'delivery_unknown');
  const quality = await source(), qualitySent = await sent(quality); await accept(qualitySent.message);
  await qualitySent.message.update({ metadata: { ...qualitySent.message.metadata, provider_acceptance_status: 'held_for_quality_assessment' } });
  assert.equal((await process(wait, qualitySent.exec)).waiting_meta.reason, 'awaiting_transport');
  await qualitySent.message.update({ status: 'delivered' });
  assert.equal((await process(wait, qualitySent.exec)).waiting_meta.reason, 'awaiting_mobile_verification');
  check('uncertain acceptance is reconciled without a second POST; quality-held delivery is not mistaken for silence');
  const blockedReq = await source(); blocked = true;
  const blockedExec = await execution(blockedReq);
  assert.equal((await process(send, blockedExec)).output.reason, 'communication_blocked'); blocked = false;
  held = true; assert.equal((await process(send, blockedExec)).output.reason, 'communication_blocked'); held = false;
  await approved.update({ status: 'PENDING' });
  assert.equal((await process(send, blockedExec)).output.reason, 'template_unavailable');
  await approved.update({ status: 'APPROVED' });
  check('existing access/communication restrictions, imported HOLDs and unavailable Utility templates stop only this flow');
  const secure = await source(), secureSent = await sent(secure); await accept(secureSent.message);
  const args = transportArgs(secureSent.message);
  for (const patch of [{ to: '34600000999' }, { useTemplate: false }, { sender: { ...sender, phoneNumberId: 'OTHER' } },
    { templateName: 'OTHER' }, { templateComponents: [] }]) assert.equal((await runtime.authorizeTransport({ ...args, ...patch })).allowed, false);
  blocked = true; assert.equal((await runtime.authorizeTransport(args)).allowed, false); blocked = false;
  held = true; assert.equal((await runtime.authorizeTransport(args)).allowed, false); held = false;
  for (const extra of [{ historical: true }, { automatic_actions_allowed: false }, { inbox_receipt: null },
    { recovery_without_automation: true }, { phone_number_id: 'OTHER' }, { waba_id: 'OTHER' },
    { button: { payload: `pmv:${secure.id}:${'a'.repeat(36)}:yes` } }]) {
    assert.equal((await reply(secure, secureSent.message, 'yes', extra)).result.ignored, true);
  }
  assert.equal((await runtime.state(secure)).state, 'pending');
  const wrongConversation = { ...(await db.Conversation.findByPk(secureSent.message.conversation_id)).toJSON(), clinic_id: 73 };
  const syntheticReply = (await reply(secure, secureSent.message, null)).inbound;
  assert.equal((await runtime.inbound({ message: syntheticReply, conversation: wrongConversation })).ignored, true);
  assert.equal((await runtime.state(secure)).reason, 'response_unclear');
  check('dispatch and inbound revalidate recipient/sender/template/clinic/patient/fresh signed receipt; free text stays with reception, not appointment AI');
  const deferred = await source(), deferredSent = await sent(deferred);
  const nightReq = await source(), nightExec = await execution(nightReq);
  clock = new Date('2026-10-20T21:00:00Z');
  const night = await process(send, nightExec); assert.equal(night.kind, 'waiting');
  assert.equal(night.waiting_meta.reason, 'quiet_hours');
  assert.equal(await db.Message.count({ where: { automation_delivery_key: `mobile-verification:${nightReq.id}:outbound` } }), 0);
  const nightGuard = await runtime.authorizeTransport(transportArgs(secureSent.message));
  assert.equal(nightGuard.allowed, false); // Previously answered requests cannot resurrect at night.
  const deferredGuard = await runtime.authorizeTransport(transportArgs(deferredSent.message));
  assert.equal(deferredGuard.allowed, true); assert(deferredGuard.deferredUntil > clock);
  check('night-time request remains a native V2 wait without a message, timeout or extra queue');
  const controller = loadSource('../controllers/patientMobileVerification.controller', { '../../models': db,
    '../lib/access-policy': { assertUserCanAccessFeature: async ({ actorId, clinicId, featureKey }) => {
      if (actorId !== 15 || clinicId !== 72 || featureKey === 'patients.edit' && blocked) throw Object.assign(Error('access_denied'), { statusCode: 403 });
    } },
    '../services/patientPrivacyStatus.service': { patientForPrivacyClinic: async ({ identifier, clinicId }) => {
      const patient = await db.Paciente.findByPk(Number(identifier));
      if (!patient || patient.clinica_id !== clinicId) throw Object.assign(Error('not_found'), { statusCode: 404 });
      return patient;
    } }, '../services/patientMobileVerification.service': { current: () => runtime } });
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } });
  const invoke = async (handler, req) => { const res = response(); await controller[handler](req, res, e => { throw e; }); return res; };
  const readReq = { userData: { userId: 15 }, params: { id: String(manualReq.patient_id) }, query: { clinic_id: 72 } };
  assert.equal((await invoke('get', readReq)).body.items[0].state, 'confirmed');
  assert.equal((await invoke('get', { ...readReq, userData: {} })).statusCode, 401);
  assert.equal((await invoke('get', { ...readReq, userData: { userId: 99 } })).statusCode, 403);
  assert.equal((await invoke('get', { ...readReq, query: { clinic_id: 73 } })).statusCode, 403);
  assert.equal((await invoke('get', { ...readReq, query: { clinic_id: 72, phone: 'forged' } })).statusCode, 400);
  blocked = true;
  assert.equal((await invoke('resolve', { ...readReq, body: { clinic_id: 72, action: 'confirm' } })).statusCode, 403); blocked = false;
  assert.equal((await invoke('resolve', { ...readReq, body: { clinic_id: 72, action: 'confirm', request_event_id: rejected.id, revision: rejectedState.revision } })).statusCode, 404);
  check('actual controller rejects unauthenticated, unauthorized, foreign-clinic, forged-query and wrong-patient mutations before writes');
  clock = new Date();
  await local.update({ trigger_config: { ...local.trigger_config, enabled_after: '2026-10-01T00:00:00Z' } });
  const nativeEngine = loadSource('flowEngineV2.service', { '../../models': db,
    './socket.service': { getIO: () => null }, './patientMobileVerification.service': { current: () => runtime },
    '../lib/automation-runtime-stop': { assertExecutionActive: async () => {}, isStop: () => false },
    './jobRequests.service': { getCurrentRuntimeNamespace: () => 'TESTONLY' } }, {}, 10000);
  const native = await source(), nativeExec = await execution(native);
  let persisted = await nativeEngine.runExecution(nativeExec.id);
  assert.equal(persisted.status, 'waiting'); assert.equal(persisted.current_node_id, 'N3');
  assert.equal(persisted.waiting_meta.resume_mode, 'retry_current_node');
  runtime = createRuntime(deps);
  const nativeMessage = await db.Message.findOne({ where: { automation_delivery_key: `mobile-verification:${native.id}:outbound` } });
  await accept(nativeMessage); await reply(native, nativeMessage, 'yes');
  persisted = await nativeEngine.runExecution(nativeExec.id, { resumeMode: 'retry_current_node' });
  assert.equal(persisted.status, 'completed'); assert.equal(persisted.last_error, null);
  assert.equal(await db.Message.count({ where: { automation_delivery_key: `mobile-verification:${native.id}:outbound` } }), 1);
  assert.equal(await db.FlowExecutionLogV2.count({ where: { flow_execution_id: nativeExec.id, status: 'error' } }), 0);
  const nativeTimeout = await source(), nativeTimeoutExec = await execution(nativeTimeout);
  await nativeEngine.runExecution(nativeTimeoutExec.id);
  const timeoutMessage = await db.Message.findOne({ where: { automation_delivery_key: `mobile-verification:${nativeTimeout.id}:outbound` } });
  await accept(timeoutMessage); clock = new Date(+clock + 61 * 60000);
  await db.FlowExecutionV2.update({ wait_until: new Date(0) }, { where: { id: nativeTimeoutExec.id } });
  persisted = await nativeEngine.runExecution(nativeTimeoutExec.id, { resumeMode: 'retry_current_node' });
  assert.equal(persisted.status, 'completed'); assert.equal((await runtime.state(nativeTimeout)).reason, 'no_response');
  check('actual V2 runExecution persists and resumes N3 after restart, reaches end on yes or timeout and records native logs without extra transport');
  const visible = await runtime.view({ patientId: manualReq.patient_id, clinicId: 72 });
  assert.equal(visible.items[0].state, 'confirmed'); assert(visible.items[0].history.length >= 3);
  assert.equal((await runtime.view({ patientId: manualReq.patient_id, clinicId: 73 })).items.length, 0);
  assert(!JSON.stringify(visible).includes('reply_token'));
  await assert.rejects(manual(corrected, 'correct', { phone: '34600000998', acknowledged: false }));
  await assert.rejects(first.update({ metadata: {} }), /append-only/);
  assert.equal(await db.AutomationFlowTemplateV2.count({ where: { is_system: true, is_active: true } }), 0);
  check('patient view is clinic-scoped and token-free, immutable evidence cannot be overwritten, system catalogue remains inactive');
}).catch(error => { console.error(error); process.exitCode = 1; });

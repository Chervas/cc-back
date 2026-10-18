'use strict';

const assert = require('node:assert/strict');
const S = require('sequelize');
const C = require('../../lib/patient-mobile-verification');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const createFixture = require('./fixtures/patient_mobile_verification_modular_runtime.fixture');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');

withIsolatedCampaignMysql(async scope => {
  const t = await createFixture(scope), { sql, report } = scope, { db, engine } = t;
  const check = text => report.checks.push(text);
  const byType = (type, predicate = () => true) => t.template.nodes.find(n => n.type === type && predicate(n));
  const send = byType('action/send_whatsapp'), wait = byType('delay/wait_response'), notify = byType('action/send_system_notification');
  const resultNode = (result, reason = '') => byType(C.RESULT_ACTION, n => n.config.result === result && (n.config.reason || '') === reason);
  const execution = request => db.FlowExecutionV2.findOne({ where: { trigger_entity_id: request.id, trigger_type: C.REQUEST } });
  const outbound = request => db.Message.findOne({ where: { automation_delivery_key: `mobile-verification:${request.id}:outbound` } });
  const tasks = request => db.Notification.findAll({ where: { dedupeKey: { [S.Op.like]: `patient-mobile-verification:${request.id}:%` } } });
  async function run(exec, mode) {
    const fresh = await db.FlowExecutionV2.findByPk(exec.id);
    return engine.runExecution(exec.id, { ...(fresh.status === 'waiting' ? { resumeMode: mode || 'retry_current_node' } : {}) });
  }
  async function start(request = null) {
    request ||= await t.source();
    const dispatch = await t.runtime.dispatch({ request_event_id: request.id, clinic_id: request.clinic_id });
    assert(dispatch.result.execution_id, JSON.stringify(dispatch));
    const exec = await db.FlowExecutionV2.findByPk(dispatch.result.execution_id);
    const persisted = await run(exec);
    if (persisted.last_error && persisted.status !== 'waiting') throw Error(persisted.last_error);
    const message = await outbound(request);
    if (!message || persisted.status !== 'waiting') {
      const errors = await db.FlowExecutionLogV2.findAll({ where: { flow_execution_id: exec.id, status: 'error' }, raw: true });
      throw Error('TESTONLY_SEND_NOT_REACHED:' + errors.map(e => e.error_message).join(','));
    }
    return { request, exec: persisted, message };
  }
  async function accept(message, at = t.clock, status = 'accepted') {
    await message.reload();
    await message.update({ metadata: { ...message.metadata, wamid: 'wamid.TESTONLY.' + message.id,
      provider_acceptance_at: at.toISOString(), provider_acceptance_status: status } });
  }
  async function reply(item, answer, text = 'TESTONLY free text', extra = {}) {
    await item.message.reload();
    const message = await db.Message.create({ conversation_id: item.message.conversation_id, direction: 'inbound',
      content: text, message_type: 'text', status: 'delivered', sent_at: t.clock, metadata: { historical: false,
        automatic_actions_allowed: true, inbox_receipt: 'TESTONLY', fresh_inbound_dispatched_at: t.clock.toISOString(),
        phone_number_id: t.sender.phoneNumberId, waba_id: t.sender.wabaId, context: { id: item.message.metadata.wamid },
        ...(answer ? { button: { payload: `pmv:${item.request.id}:${item.request.metadata.reply_token}:${answer}` } } : {}), ...extra } });
    const conversation = await db.Conversation.findByPk(message.conversation_id);
    return { message, conversation, result: await t.runtime.inbound({ message, conversation }) };
  }
  async function manual(request, action, extra = {}) {
    const state = await t.runtime.state(request);
    return sql.transaction(transaction => t.runtime.manual({ patientId: request.patient_id, clinicId: request.clinic_id,
      actorId: 16, transaction, authorizeCurrent: async () => {}, payload: { request_event_id: request.id, revision: state.revision, action, ...extra } }));
  }
  async function resolve(item, node, context) {
    const exec = await db.FlowExecutionV2.findByPk(item.exec.id);
    return engine._processNode(node, context || exec.context, { execution: exec });
  }
  const migration = require('../../../migrations/20261018100000-prepare-patient-mobile-verification-v2');
  await migration.up(sql.getQueryInterface()); await migration.up(sql.getQueryInterface());
  await t.approved.update({ catalog_template_id: (await db.WhatsappTemplateCatalog.findOne({ where: { name: C.TEMPLATE } })).id });
  assert.equal(await db.AutomationFlowTemplateV2.count({ where: { is_system: true } }), 1);
  assert.equal(await db.AutomationFlowCatalog.count({ where: { is_active: false } }), 1);
  assert.equal(await db.WhatsappTemplateCatalog.count({ where: { is_active: false } }), 1);
  assert.equal(await db.JobRequest.count() + await db.Message.count(), 0);
  const disabled = await t.source(); assert.equal(disabled.metadata.delivery_enabled, false);
  assert.equal((await t.runtime.dispatch({ request_event_id: disabled.id, clinic_id: 72 })).result.skipped, true);
  t.enabled = true;
  assert.equal((await t.runtime.dispatch({ request_event_id: disabled.id, clinic_id: 72 })).result.skipped, true);
  const missingScope = await t.source({ clinic: 73 }); assert.equal(missingScope.metadata.delivery_enabled, false);
  check('repeatable preparation stays inactive; flag-off, historical disabled and missing scoped requests cannot dispatch');

  const request = await t.source();
  const dispatches = await Promise.all(Array.from({ length: 12 }, () => t.runtime.dispatch({ request_event_id: request.id, clinic_id: 72 })));
  assert.equal(new Set(dispatches.map(r => r.result.execution_id)).size, 1);
  assert.equal(await db.JobRequest.count({ where: { type: 'automations_v2_execute' } }), 1);
  const first = await start(request);
  assert.equal(first.exec.status, 'waiting'); assert.equal(first.exec.current_node_id, wait.id);
  assert.equal(first.message.metadata.kind, 'patient_mobile_verification');
  assert(first.message.metadata.template_components[1].parameters[0].payload.startsWith(`pmv:${request.id}:`));
  assert.equal([...t.queued.values()][0].to, request.metadata.phone);
  const count = t.queued.size;
  await engine._processNode(send, first.exec.context, { execution: first.exec });
  t.restart(); await engine._processNode(send, first.exec.context, { execution: first.exec });
  assert.equal(t.queued.size, count); assert.equal(await db.Message.count(), 1);
  t.clock = new Date(+t.clock + 2 * 3600000); await accept(first.message);
  await run(first.exec, 'timeout');
  const deadline = await db.FlowExecutionV2.findByPk(first.exec.id);
  assert.equal(+deadline.wait_until, +t.clock + 3600000);
  const yes = await reply(first, 'yes', 'Yes');
  assert(yes.result.correlated); assert.equal((await t.runtime.state(request)).state, 'pending');
  assert.equal(await db.Notification.count(), 0);
  await run(first.exec);
  assert.equal((await t.runtime.state(request)).state, 'confirmed'); assert.equal(t.aiCalls.length, 0);
  assert.equal((await t.runtime.inbound({ message: yes.message, conversation: yes.conversation })).ignored, true);
  assert.equal((await t.runtime.state(request)).history.length, 1);
  check('real handleSendWhatsapp/native wait restart use one frozen-recipient message; acceptance starts clock; button YES traverses comparator/result without AI');

  const rejected = await start(); await accept(rejected.message);
  await Promise.all([reply(rejected, 'no', 'No'), reply(rejected, 'no', 'No')]);
  assert.equal((await t.runtime.state(rejected.request)).state, 'pending'); await run(rejected.exec);
  assert.equal((await t.runtime.state(rejected.request)).reason, 'patient_rejected'); assert.equal((await tasks(rejected.request)).length, 2);
  await engine._processNode(notify, (await execution(rejected.request)).context, { execution: await execution(rejected.request) });
  assert.equal((await tasks(rejected.request)).length, 2);
  assert((await tasks(rejected.request)).every(n => n.event === 'automation.persistent_alert' && n.data.request_event_id === rejected.request.id));
  await manual(rejected.request, 'confirm');
  assert((await tasks(rejected.request)).every(n => n.isRead && n.data.resolved));
  check('concurrent NO replies resolve atomically; generic persistent notification deduplicates per request/recipient');

  const timedOut = await start(); await accept(timedOut.message);
  assert.equal((await resolve(timedOut, resultNode('review_required', 'no_response'))).output.applied, false);
  t.clock = new Date(+t.clock + 61 * 60000); await run(timedOut.exec);
  assert.equal((await t.runtime.state(timedOut.request)).reason, 'no_response'); assert.equal((await tasks(timedOut.request)).length, 2);
  await db.JobRequest.update({ status: 'completed' }, { where: { type: 'automations_v2_execute' } });
  await reply(timedOut, 'yes', 'Yes'); assert.equal((await execution(timedOut.request)).status, 'waiting');
  assert.equal((await t.runtime.state(timedOut.request)).reason, 'no_response'); t.restart(); await run(timedOut.exec);
  assert.equal((await t.runtime.state(timedOut.request)).state, 'confirmed'); assert((await tasks(timedOut.request)).every(n => n.isRead && n.data.resolved));
  const lateNo = await start(); await accept(lateNo.message); t.clock = new Date(+t.clock + 61 * 60000); await run(lateNo.exec);
  await reply(lateNo, 'no', 'No'); await run(lateNo.exec); assert.equal((await tasks(lateNo.request)).length, 2);
  assert((await tasks(lateNo.request)).every(n => n.data.reason === 'patient_rejected' && !n.isRead));
  check('elapsed accepted deadline required; late YES/NO reopen native waits/jobs, close or update the same generic tasks');

  const manualPending = await start(); await accept(manualPending.message); await manual(manualPending.request, 'pending');
  assert.equal((await t.runtime.authorizeTransport({ message: manualPending.message, to: manualPending.request.metadata.phone,
    sender: t.sender, useTemplate: true, templateName: manualPending.message.metadata.template_name,
    templateLanguage: manualPending.message.metadata.template_language, templateComponents: manualPending.message.metadata.template_components })).allowed, false);
  assert.equal((await reply(manualPending, 'yes')).result.ignored, true); const revision = (await t.runtime.state(manualPending.request)).revision;
  await manual(manualPending.request, 'confirm'); assert.equal((await reply(manualPending, 'no')).result.ignored, true);
  assert((await t.runtime.state(manualPending.request)).manually_resolved);
  await assert.rejects(sql.transaction(transaction => t.runtime.manual({ patientId: manualPending.request.patient_id, clinicId: 72, actorId: 16,
    transaction, authorizeCurrent: async () => {}, payload: { action: 'pending', request_event_id: manualPending.request.id, revision } })), /mobile_verification_changed/);
  const corrected = await start(); await accept(corrected.message);
  const correction = await manual(corrected.request, 'correct', { phone: '34601000199', acknowledged: true });
  const next = await db.PatientOperationalEvent.findByPk(correction.request_event_id);
  assert.equal(next.metadata.phone, '34601000199'); assert.equal((await t.runtime.state(corrected.request)).current, false);
  assert.equal((await reply(corrected, 'yes')).result.ignored, true);
  await manual(next, 'correct', { phone: corrected.request.metadata.phone, acknowledged: true });
  assert.equal((await reply(corrected, 'yes')).result.ignored, true);
  check('manual pending/confirmation and correction override automation; stale revisions, superseded requests and ABA phones cannot resolve');

  const transportArgs = message => ({ message, to: message.metadata.recipient, sender: t.sender, useTemplate: true,
    templateName: message.metadata.template_name, templateLanguage: message.metadata.template_language, templateComponents: message.metadata.template_components });
  const secure = await start(); await accept(secure.message);
  for (const patch of [{ to: '34600000999' }, { useTemplate: false }, { sender: { ...t.sender, phoneNumberId: 'OTHER' } }, { templateName: 'OTHER' }, { templateComponents: [] }]) {
    assert.equal((await t.runtime.authorizeTransport({ ...transportArgs(secure.message), ...patch })).allowed, false);
  }
  for (const extra of [{ historical: true }, { automatic_actions_allowed: false }, { inbox_receipt: null }, { recovery_without_automation: true },
    { media_recovered_without_automation: true }, { phone_number_id: 'OTHER' }, { waba_id: 'OTHER' },
    { button: { payload: `pmv:${secure.request.id}:${'a'.repeat(36)}:yes` } }, { button: { payload: 'pmv:malformed' } }]) {
    assert.equal((await reply(secure, 'yes', 'Yes', extra)).result.ignored, true);
  }
  assert.equal((await t.runtime.state(secure.request)).state, 'pending');
  for (const key of ['blocked', 'held']) { t[key] = true; assert.equal((await t.runtime.authorizeTransport(transportArgs(secure.message))).allowed, false); t[key] = false; }
  t.enabled = false; assert.equal((await t.runtime.authorizeTransport(transportArgs(secure.message))).allowed, false); t.enabled = true;
  check('transport/inbound revalidate template, frozen recipient, sender, signed receipt, freshness and request identity with closed feature guard');

  for (const kind of ['failed', 'unknown', 'held']) {
    const item = await start();
    if (kind === 'failed') await item.message.update({ status: 'failed' });
    if (kind === 'unknown') await item.message.update({ metadata: { ...item.message.metadata, delivery_unknown: true } });
    if (kind === 'held') await accept(item.message, t.clock, 'held_for_quality_assessment');
    if (kind !== 'failed') {
      await run(item.exec); assert.equal((await t.runtime.state(item.request)).state, 'pending');
      await sql.query('UPDATE Messages SET createdAt=:at WHERE id=:id', { replacements: { at: new Date(+t.clock - 86401000), id: item.message.id } });
    }
    await db.FlowExecutionV2.update({ wait_until: new Date(0) }, { where: { id: item.exec.id } }); await run(item.exec);
    assert.equal((await t.runtime.state(item.request)).reason, 'delivery_failed', kind); assert.notEqual((await t.runtime.state(item.request)).delivery_status, 'accepted');
  }
  check('failed, unknown and quality-held delivery never become silence; bounded transport waits use explicit failure edge');

  const unavailable = await t.source(); await t.approved.update({ status: 'PENDING' });
  const unavailableDispatch = await t.runtime.dispatch({ request_event_id: unavailable.id, clinic_id: 72 }); await engine.runExecution(unavailableDispatch.result.execution_id);
  assert.equal((await t.runtime.state(unavailable)).reason, 'delivery_failed'); await t.approved.update({ status: 'APPROVED' });
  const blocked = await t.source(); t.blocked = true;
  const blockedDispatch = await t.runtime.dispatch({ request_event_id: blocked.id, clinic_id: 72 }); await engine.runExecution(blockedDispatch.result.execution_id); t.blocked = false;
  assert.equal((await t.runtime.state(blocked)).reason, 'delivery_failed');
  check('access/template preflight errors traverse explicit result and notification without sending');

  t.queueFailures = 1;
  const handoff = await start(); assert.equal(handoff.exec.current_node_id, send.id); assert.equal(handoff.exec.status, 'waiting');
  t.clock = new Date(+t.clock + 61000); t.restart(); await run(handoff.exec);
  assert.equal(await db.Message.count({ where: { automation_delivery_key: `mobile-verification:${handoff.request.id}:outbound` } }), 1);
  assert.equal((await execution(handoff.request)).current_node_id, wait.id);
  t.acceptOnPublication = true; t.markerFailure = true; const fastWorker = await start(); t.acceptOnPublication = false; await fastWorker.message.reload();
  assert(fastWorker.message.metadata.wamid); assert(fastWorker.message.metadata.provider_acceptance_at); assert.notEqual(fastWorker.message.status, 'failed');
  const beforeReplay = t.queued.size; await engine._processNode(send, fastWorker.exec.context, { execution: fastWorker.exec }); assert.equal(t.queued.size, beforeReplay);
  check('handoff retry uses one message; marker write failure after fast acceptance never erases provider receipt or resends');

  const day = t.clock; t.clock = new Date('2026-10-21T21:00:00Z');
  const nightCount = t.queued.size, night = await start();
  assert.equal(t.queued.size, nightCount); assert.equal(night.exec.status, 'waiting');
  assert(night.message.metadata.queued_by_quiet_hours);
  const nightGuard = await t.runtime.authorizeTransport(transportArgs(night.message));
  assert(nightGuard.allowed && nightGuard.deferredUntil > t.clock);
  assert.equal((await t.runtime.state(night.request)).accepted_at, null);
  t.clock = day;
  check('generic quiet-hours scheduling creates only durable local work; provider dispatch and response clock stay deferred');

  await require('./patient_mobile_verification_modular_runtime.test')({ t, sql, db, engine, byType, resultNode, start, run, accept, reply, resolve, execution, tasks, check });
  const controller = loadSource('../controllers/patientMobileVerification.controller', { '../../models': db,
    '../lib/access-policy': { assertUserCanAccessFeature: async ({ actorId, clinicId, featureKey }) => {
      if (actorId !== 15 || clinicId !== 72 || featureKey === 'patients.edit' && t.blocked) throw Object.assign(Error('access_denied'), { statusCode: 403 });
    } }, '../services/patientPrivacyStatus.service': { patientForPrivacyClinic: async ({ identifier, clinicId }) => {
      const patient = await db.Paciente.findByPk(Number(identifier));
      if (!patient || patient.clinica_id !== clinicId) throw Object.assign(Error('not_found'), { statusCode: 404 });
      return patient;
    } }, '../services/patientMobileVerification.service': { current: () => t.runtime } });
  const invoke = async (handler, req) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await controller[handler](req, res, e => { throw e; }); return res;
  };
  const readReq = { userData: { userId: 15 }, params: { id: String(manualPending.request.patient_id) }, query: { clinic_id: 72 } };
  assert.equal((await invoke('get', readReq)).body.items[0].state, 'confirmed');
  assert.equal((await invoke('get', { ...readReq, userData: {} })).statusCode, 401);
  assert.equal((await invoke('get', { ...readReq, userData: { userId: 99 } })).statusCode, 403);
  assert.equal((await invoke('get', { ...readReq, query: { clinic_id: 73 } })).statusCode, 403);
  assert.equal((await invoke('get', { ...readReq, query: { clinic_id: 72, phone: 'forged' } })).statusCode, 400);
  t.blocked = true; assert.equal((await invoke('resolve', { ...readReq, body: { clinic_id: 72, action: 'confirm' } })).statusCode, 403); t.blocked = false;
  assert.equal((await invoke('resolve', { ...readReq, body: { clinic_id: 72, action: 'confirm', request_event_id: rejected.request.id, revision: 1 } })).statusCode, 404);
  check('actual controller still rejects unauthenticated, unauthorized, foreign-clinic, forged-query and wrong-patient mutations');
  const visible = await t.runtime.view({ patientId: manualPending.request.patient_id, clinicId: 72 });
  assert.equal(visible.items[0].state, 'confirmed'); assert(visible.items[0].history.length >= 2);
  assert.equal((await t.runtime.view({ patientId: manualPending.request.patient_id, clinicId: 73 })).items.length, 0);
  assert(!JSON.stringify(visible).includes('reply_token')); await assert.rejects(request.update({ metadata: {} }), /append-only/);
  assert.equal(await db.AutomationFlowTemplateV2.count({ where: { is_system: true, is_active: true } }), 0);
  check('clinic-scoped projection hides tokens and preserves immutable history; prepared system catalogue remains inactive');
}).catch(error => { console.error(error); process.exitCode = 1; });

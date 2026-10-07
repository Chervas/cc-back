'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');
const gate = () => {
  let release; const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  require('./fixtures/security_offline_runtime.cjs');
  models.Sequelize = D;
  models.Clinica = require('../../../models/clinica')(sql, D);
  models.Conversation = sql.define('Conversation', { id: { type: D.INTEGER, primaryKey: true }, clinic_id: D.INTEGER,
    patient_id: D.INTEGER, lead_id: D.INTEGER, channel: D.STRING, contact_id: D.STRING,
    last_message_at: D.DATE, last_inbound_at: D.DATE, unread_count: D.INTEGER }, { tableName: 'Conversations' });
  for (const [name, file] of [['AutomationFlowTemplateV2', 'automationflowtemplatev2'],
    ['FlowExecutionV2', 'flowexecutionv2'], ['FlowExecutionLogV2', 'flowexecutionlogv2'],
    ['JobRequest', 'jobrequest'], ['Message', 'message'], ['CitaPaciente', 'citapaciente'], ['EmailMessage', 'emailmessage'],
    ['ConversationAutomationState', 'conversationautomationstate']]) {
    models[name] = require('../../../models/' + file)(sql, D);
  }
  models.FlowExecutionV2.associate(models);
  await sql.sync();
  await models.Clinica.bulkCreate([{ id_clinica: 35, grupoClinicaId: 5 }, { id_clinica: 59, grupoClinicaId: 5 }]);
  await models.Conversation.bulkCreate([{ id: 535, clinic_id: 35, channel: 'whatsapp' }, { id: 559, clinic_id: 59, channel: 'whatsapp' }]);
  await models.CitaPaciente.bulkCreate([35, 59].map(clinic => ({ id_cita: clinic, clinica_id: clinic,
    paciente_id: clinic, estado: 'info_enviada', inicio: new Date('2030-01-01T12:00:00Z'), fin: new Date('2030-01-01T12:30:00Z') })));
  const stop = require('../../lib/automation-runtime-stop');
  const stateEvents = [];
  const socketFile = require.resolve('../../services/socket.service');
  require.cache[socketFile] = { id: socketFile, filename: socketFile, loaded: true,
    exports: { getIO: () => ({ to: room => ({ emit: (event, payload) => stateEvents.push({ room, event, payload }) }) }) } };
  const nodes = [
    { id: 'wait', type: 'delay/wait_response', config: { timeout_duration: 1, timeout_unit: 'minutes' }, outputs: { on_timeout: 'cancel', on_response: 'confirm' } },
    { id: 'cancel', type: 'action/change_status', config: { target_entity: 'appointment', new_status: 'cancelada' }, outputs: {} },
    { id: 'confirm', type: 'action/change_status', config: { target_entity: 'appointment', new_status: 'info_confirmada' }, outputs: {} },
  ];
  const sourceKey = 'system_cancel_unconfirmed_appointment_night_before';
  const templateValues = { version: 1, engine_version: 'v2', name: 'Fictitious cancellation', trigger_type: 'appointment_reminder_window',
    published_at: new Date(), created_by: 1, entry_node_id: 'wait', nodes };
  const master = await models.AutomationFlowTemplateV2.create({ ...templateValues, public_id: 'master', template_key: sourceKey, is_system: true });
  const old = await models.AutomationFlowTemplateV2.create({ ...templateValues, public_id: 'local35', template_key: sourceKey + '__clinic_35', clinic_id: 35, group_id: 5, is_active: false });
  const local = await models.AutomationFlowTemplateV2.create({ ...old.toJSON(), id: undefined, version: 2, is_active: true });
  const other = await models.AutomationFlowTemplateV2.create({ ...templateValues, public_id: 'local59', template_key: sourceKey + '__clinic_59', clinic_id: 59, group_id: 5 });
  const duplicate = await models.AutomationFlowTemplateV2.create({ ...templateValues, public_id: 'custom35', template_key: 'custom_cancel', clinic_id: 35, group_id: 5 });
  let sequence = 0;
  const create = (template, values = {}) => stop.createExecution({
    idempotency_key: 'fictitious-' + ++sequence, template_version_id: template.id,
    clinic_id: template.clinic_id || 35, group_id: 5, created_by: 1, status: 'waiting', current_node_id: 'wait',
    trigger_type: template.trigger_type, trigger_entity_type: 'appointment', trigger_entity_id: template.clinic_id || 35,
    context: { appointment: { id: template.clinic_id || 35, clinica_id: template.clinic_id || 35, estado: 'info_enviada' }, outputs: {} },
    wait_until: new Date(Date.now() + 1000), waiting_meta: { type: 'delay/wait_response', pending_response_message_ids: [111] },
    ...values,
  });
  const waitingOld = await create(old), waitingCurrent = await create(local), inherited = await create(master);
  const paused = await create(local, { status: 'paused' }), inProgress = await create(old, { status: 'running' });
  const foreign = await create(other), custom = await create(duplicate);
  await models.ConversationAutomationState.create({ conversation_id: 535, clinic_id: 35, execution_id: waitingOld.id,
    stage: 'analyzing', source_message_id: 111, needs_response: true });
  const simulation = await create(local, { context: { __simulation: true } });
  const queuedJob = await models.JobRequest.create({ type: 'automations_v2_execute', status: 'waiting', payload: { execution_id: waitingOld.id } });
  const schedule = await models.JobRequest.create({ type: 'appointment_automation_schedule_fire', status: 'waiting',
    payload: { appointment_id: 35, template_key: local.template_key } });
  const claimedSchedule = await models.JobRequest.create({ type: 'appointment_automation_schedule_fire', status: 'running',
    attempts: 1, last_attempt_at: new Date(),
    payload: { __runtime_namespace: 'staging', appointment_id: 35, template_key: master.template_key } });
  const scheduleClaim = require('../../services/jobClaim.service').createJobClaim(claimedSchedule,
    { models, isActive: () => true, namespace: () => 'staging' });
  await scheduleClaim.assert();
  const foreignSchedule = await models.JobRequest.create({ type: 'appointment_automation_schedule_fire', status: 'waiting',
    payload: { appointment_id: 59, template_key: master.template_key } });
  const makeMessage = (execution, values = {}) => models.Message.create({ conversation_id: 500 + execution.clinic_id,
    direction: 'outbound', message_type: 'text', content: 'Fictitious unsent message', status: 'pending',
    metadata: { source: 'automations_v2', execution_id: execution.id }, ...values });
  const completed = await create(local, { status: 'completed', current_node_id: null });
  const queued = await makeMessage(completed), foreignMessage = await makeMessage(foreign);
  const quietJob = await models.JobRequest.create({ type: 'automation_whatsapp_quiet_send', status: 'waiting', payload: { message_id: queued.id } });
  const accepted = await makeMessage(completed, { metadata: { source: 'automations_v2', execution_id: completed.id, wamid: 'fictitious-accepted' } });
  const uncertain = await makeMessage(completed, { metadata: { source: 'automations_v2', execution_id: completed.id, delivery_unknown: true } });
  const email = await models.EmailMessage.create({ public_id: 'fictitious-email', template_key: 'fictitious', recipient_hash: 'a'.repeat(64),
    stream: 'automation', related_type: 'flow_execution_v2', related_id: String(completed.id), clinica_id: 35 });
  const clinicalBefore = (await models.CitaPaciente.findByPk(35)).toJSON();

  // Exercise the actual published-version switch controller, not a substitute API.
  const controllerSource = fs.readFileSync(require.resolve('../../controllers/automationsV2.controller'), 'utf8');
  const start = controllerSource.indexOf('exports.updateTemplateDraft =');
  const end = controllerSource.indexOf('\nexports.', start + 10);
  const exports = {};
  vm.runInNewContext(controllerSource.slice(start, end), { exports, console,
    AutomationFlowTemplateV2: models.AutomationFlowTemplateV2,
    resolveAccess: async () => ({ is_admin: true }), resolveTemplateFamilyWhere: async ref => ({ public_id: ref }),
    parseIntOrNull: Number, parseBool: value => value, hasScopeAccess: () => true,
    leadAutoReplyService: { validateFlowActivation: async () => ({ managed: false }) },
    findMessageReceivedTriggerConflict: async () => null, findAppointmentReminderTriggerConflict: async () => null,
    runScheduledTemplateBackfill: async () => null, loadClinicNameMapFromRows: async () => new Map(),
    loadCatalogBindingMapForRows: async () => new Map(), loadLatestActivePublishedVersionMap: async () => new Map(),
    mapTemplateWithLifecycle: row => row.toJSON(), require: name => {
      assert.equal(name, '../lib/automation-runtime-stop'); return stop;
    },
  });
  const toggle = async active => {
    let result, status = 200;
    await exports.updateTemplateDraft({ params: { template_ref: 'local35', version: 2 }, body: { is_active: active } },
      { status(value) { status = value; return this; }, json(value) { result = value; return this; } });
    assert.equal(status, 200, JSON.stringify(result)); assert.equal(result.success, true); return result;
  };
  const off = await toggle(false);
  assert.equal(off.stopped.cancelled_executions, 5);
  for (const execution of [waitingOld, waitingCurrent, inherited, paused, inProgress]) {
    await execution.reload(); assert.equal(execution.status, 'cancelled'); assert.equal(execution.last_error, stop.STOP_REASON);
    assert.equal(execution.wait_until, null); assert.deepEqual(execution.waiting_meta.pending_response_message_ids, [111]);
  }
  for (const execution of [foreign, custom, simulation]) { await execution.reload(); assert.equal(execution.status, 'waiting'); }
  await queuedJob.reload(); await schedule.reload(); await foreignSchedule.reload();
  assert.equal(queuedJob.status, 'cancelled'); assert.equal(schedule.status, 'cancelled'); assert.equal(foreignSchedule.status, 'waiting');
  await queued.reload(); await foreignMessage.reload(); await accepted.reload(); await uncertain.reload(); await email.reload();
  assert.equal(queued.metadata.cancelled, true); assert.equal(queued.status, 'failed'); assert.equal(email.status, 'cancelled');
  assert.equal(foreignMessage.status, 'pending'); assert.equal(accepted.metadata.wamid, 'fictitious-accepted');
  await quietJob.reload(); assert.equal(quietJob.status, 'cancelled');
  assert.equal(accepted.metadata.cancelled, undefined); assert.equal(uncertain.metadata.cancelled, undefined);
  const stoppedState = await models.ConversationAutomationState.findOne({ where: { conversation_id: 535 } });
  assert.equal(stoppedState.status, 'review'); assert.equal(stoppedState.manual_action_required, true);
  assert.equal(stoppedState.needs_response, true); assert.equal(stateEvents[0].payload.automation_response_processing, false);
  assert.deepEqual((await models.CitaPaciente.findByPk(35)).toJSON(), clinicalBefore);
  await assert.rejects(create(local), { code: stop.STOP_REASON });
  await toggle(true);
  await assert.rejects(stop.createExecution({ ...waitingOld.toJSON(), id: undefined, idempotency_key: 'stale-schedule' },
    { jobClaim: scheduleClaim }), { code: 'job_claim_lost' });
  for (const execution of [waitingOld, waitingCurrent, inherited]) await assert.rejects(stop.assertExecutionActive(execution), { code: 'automation_execution_stopped' });
  await assert.rejects(stop.assertMessageCanDispatch(queued.id), { code: stop.STOP_REASON });
  const staleQueued = models.Message.build({ ...queued.toJSON(), metadata: { source: 'automations_v2', execution_id: completed.id } }, { isNewRecord: false });
  await assert.rejects(stop.prepareMessageForDispatch(staleQueued, { status: 'pending', metadata: { enqueue_error: null } }), { code: stop.STOP_REASON });
  await stop.cancelMessage(uncertain.id); await uncertain.reload(); assert.equal(uncertain.metadata.cancelled, undefined);
  await assert.rejects(stop.assertEmailCanDispatch(email), { code: stop.STOP_REASON });
  const fresh = await create(old); await stop.assertExecutionActive(fresh);
  await assert.rejects(stop.updateExecution(waitingOld, { status: 'waiting' }), { code: 'automation_execution_stopped' });
  const inheritedStillOff = await create(master);
  await toggle(false);
  await assert.rejects(stop.assertExecutionActive(inheritedStillOff), { code: stop.STOP_REASON });
  await toggle(true);
  report.checks.push('real controller toggle atomically cancels waits, paused/running predecessors, inherited source and scheduled jobs in this clinic only',
    'duplicates, other clinic, explicit simulations, accepted/uncertain provider outcomes and clinical data remain intact; unanswered reply persists as review with realtime processing cleared',
    'reactivation does not revive executions, scheduled jobs, queued WhatsApp or email; old pinned graph can still run when latest release is active');

  // Execute the actual final WhatsApp dispatch boundary with a fake transport.
  const waSource = fs.readFileSync(require.resolve('../../services/whatsapp.service'), 'utf8');
  const dispatchStart = waSource.indexOf('    async dispatchMessage(');
  const dispatchEnd = waSource.indexOf('\n    /**', dispatchStart);
  let fakePosts = 0;
  const sandbox = { require: name => { assert.equal(name, '../lib/automation-runtime-stop'); return stop; },
    whatsappAuthorizedBroker: { send: async () => { fakePosts++; return { messages: [{ id: 'fictitious-wamid' }] }; } },
  };
  vm.runInNewContext('this.service = new (class {\n' + waSource.slice(dispatchStart, dispatchEnd) + '\n})()', sandbox);
  const config = { phoneNumberId: '123', wabaId: '456', clinicId: 35, originId: 1,
    authorizedBroker: { phoneId: '123', wabaId: '456' } };
  await assert.rejects(sandbox.service.dispatchMessage({ type: 'text' }, config, { messageId: queued.id }), { code: stop.STOP_REASON });
  assert.equal(fakePosts, 0);
  await sandbox.service.dispatchMessage({ type: 'text' }, { ...config, clinicId: 59 }, { messageId: foreignMessage.id });
  assert.equal(fakePosts, 1);
  report.checks.push('actual final WhatsApp dispatcher rejects a stopped queued message before transport, while unaffected automatic traffic still dispatches to a fake transport');

  let activityWrites = 0;
  let aiStarted = gate(), aiRelease = gate();
  const engine = loadSource('flowEngineV2.service', { '../../models': models, './socket.service': { getIO: () => null },
    './jobRequests.service': { getCurrentRuntimeNamespace: () => 'staging' },
    './marketingBulkSends.service': { normalizeWhatsappPhone: value => value },
    './queue.service': {}, './conversationPendingReply.service': { emitAutomationResponseProcessing() {} },
    './appointmentActivity.service': { recordAppointmentStatusChange: async () => { activityWrites++; } },
    './appointmentNotificationCleanup.service': { markAutomationNotificationsReadForAppointment: async () => {} },
    './appointmentAutomationV2Runtime.service': { cancelActiveExecutionsForCita: async () => {}, syncScheduledTriggersForCita: async () => {} },
    './treatmentBookingProfile.service': { bookingCapabilities: () => ({ simple: false }) },
    './appointmentConsentEligibility.service': { assertClinicalCompletion: async () => {} },
    './aiOrchestrator.service': { analyzeStructured: async () => { aiStarted.release(); await aiRelease.promise; return { ready: true }; } },
  }, { JOB_RUNTIME_NAMESPACE: 'staging', RUNTIME_ROLE: 'gateway' });
  await toggle(false);
  const quietResult = await engine.runScheduledWhatsappSendJob({ message_id: queued.id });
  assert.equal(quietResult.result.reason, 'automation_deactivated');
  for (const mode of ['timeout', 'response', 'form_submission', 'retry_current_node']) {
    const result = await engine.runExecution(waitingOld.id, { resumeMode: mode, responseText: 'Fictitious confirmation' });
    assert.equal(result.status, 'cancelled');
  }
  await toggle(true);
  await assert.rejects(engine._handleChangeStatus(nodes[1], fresh.context, { execution: waitingOld }), { code: 'automation_execution_stopped' });
  assert.equal(activityWrites, 0);
  const active = await create(local, { status: 'running', current_node_id: 'confirm' });
  await engine.runExecution(active.id); await active.reload();
  assert.equal(active.status, 'completed'); assert.equal((await models.CitaPaciente.findByPk(35)).estado, 'info_confirmada');
  assert.equal(activityWrites, 1);
  await models.CitaPaciente.update({ estado: 'info_enviada' }, { where: { id_cita: 35 } });
  report.checks.push('native engine timeout/response/form/retry paths cannot resume a cancelled execution',
    'guarded clinical transaction blocks cancelled writer while an active confirmation still completes through the actual engine');

  // A real engine call remains awaiting a fake provider result while the real
  // switch commits. No model or provider network is reachable in this fixture.
  const aiNodes = [{ id: 'ai', type: 'condition/ai_analysis', config: { instruction: 'Fictitious check',
    context_sources: [{ key: 'appointment', path: '{{appointment}}' }],
    output_fields: [{ name: 'ready', type: 'boolean' }] }, outputs: { on_success: 'cancel' } }, nodes[1]];
  const aiTemplate = await models.AutomationFlowTemplateV2.create({ ...templateValues, public_id: 'ai35', template_key: 'ai35',
    clinic_id: 35, group_id: 5, entry_node_id: 'ai', nodes: aiNodes });
  const analyzing = await create(aiTemplate, { status: 'running', current_node_id: 'ai', context: { appointment: {
    id: 35, clinica_id: 35, estado: 'info_enviada' }, outputs: {} } });
  const running = engine.runExecution(analyzing.id);
  await Promise.race([aiStarted.promise, running.then(result => { throw Error('AI was not reached: ' + result.last_error); })]);
  await stop.setActive(aiTemplate, false); aiRelease.release();
  assert.equal((await running).status, 'cancelled');
  assert.equal((await models.CitaPaciente.findByPk(35)).estado, 'info_enviada'); assert.equal(activityWrites, 1);
  assert.equal(await models.Message.count(), 4);
  report.checks.push('deactivation while actual engine awaits a simulated IA result prevents cancellation, failure fallback and any outbound materialization');

  // Serialize a stale creator behind the off switch using actual InnoDB locks.
  await toggle(true);
  const hold = await sql.transaction({ isolationLevel: 'READ COMMITTED' });
  await models.AutomationFlowTemplateV2.findAll({ where: { public_id: local.public_id }, transaction: hold, lock: hold.LOCK.UPDATE });
  const stopping = toggle(false);
  await new Promise(resolve => setTimeout(resolve, 30));
  const creating = create(local).then(() => ({ created: true }), error => ({ code: error.code }));
  await hold.commit(); await stopping;
  assert.equal((await creating).code, stop.STOP_REASON);
  report.checks.push('actual SQL lock race: a creator that resolved the active template earlier cannot insert behind a committed stop');

  await toggle(true);
  const writer = await create(local, { status: 'running', current_node_id: 'cancel' });
  const writerHold = await sql.transaction({ isolationLevel: 'READ COMMITTED' });
  await models.AutomationFlowTemplateV2.findAll({ where: { public_id: local.public_id }, transaction: writerHold, lock: writerHold.LOCK.UPDATE });
  const writerStop = toggle(false);
  await new Promise(resolve => setTimeout(resolve, 30));
  const changing = engine._handleChangeStatus(nodes[1], writer.context, { execution: writer })
    .then(() => ({ changed: true }), error => ({ code: error.code }));
  await writerHold.commit(); await writerStop;
  assert.equal((await changing).code, stop.STOP_REASON);
  assert.equal((await models.CitaPaciente.findByPk(35)).estado, 'info_enviada');
  report.checks.push('actual SQL lock race: clinical writer waiting behind deactivation cannot change appointment status');

  const hours = { id: 'hours', type: 'action/update_google_special_hours', config: {
    auto_deactivate_after_execution: true, period: { startDate: '2030-01-01', endDate: '2030-01-01' } }, outputs: { on_success: 'end' } };
  const hoursTemplate = await models.AutomationFlowTemplateV2.create({ ...templateValues, public_id: 'hours35',
    template_key: 'hours35', clinic_id: 35, group_id: 5, entry_node_id: 'hours',
    trigger_config: { managed_feature: 'google_special_hours' }, nodes: [hours, { id: 'end', type: 'control/end', outputs: {} }] });
  const hoursExecution = await create(hoursTemplate, { status: 'running', current_node_id: 'hours' });
  let fakeHoursCalls = 0;
  const hoursEngine = loadSource('flowEngineV2.service', { '../../models': models,
    './socket.service': { getIO: () => null }, './queue.service': {},
    './jobRequests.service': { getCurrentRuntimeNamespace: () => 'staging' },
    './conversationPendingReply.service': { emitAutomationResponseProcessing() {} },
    './businessProfileAutomation.service': { run: async () => null },
    './businessProfileLocal.service': { applyScheduledSpecialHoursPeriod: async () => { fakeHoursCalls++; return {}; } },
  }, { RUNTIME_ROLE: 'gateway', JOB_RUNTIME_NAMESPACE: 'staging' });
  await hoursEngine.runExecution(hoursExecution.id); await hoursExecution.reload(); await hoursTemplate.reload();
  assert.equal(hoursExecution.status, 'completed'); assert.equal(hoursTemplate.is_active, false); assert.equal(fakeHoursCalls, 1);
  const forgedEnd = await models.FlowExecutionV2.create({ ...hoursExecution.toJSON(), id: undefined,
    idempotency_key: 'unaudited-self-stop', status: 'running', current_node_id: 'end' });
  await assert.rejects(stop.assertExecutionActive(forgedEnd, undefined, { allowSelfDeactivatedEnd: true }), { code: stop.STOP_REASON });
  report.checks.push('running scheduled claim cannot create after off/on; audited one-shot legacy hours finish their pure end, but copied context without its execution log cannot bypass a manual stop');

  // Repeated interleavings use persisted fictitious records, not production data.
  let runs = 0;
  for (let i = 0; i < 100; i++) {
    await toggle(true);
    const e = await create(i % 2 ? old : local, { status: i % 3 ? 'waiting' : 'running' });
    await toggle(false); await toggle(true);
    await assert.rejects(stop.assertExecutionActive(e), { code: 'automation_execution_stopped' });
    await e.reload(); assert.equal(e.status, 'cancelled'); runs++;
  }
  report.checks.push('100 repeated off/on interleavings retain terminal cancellation across historical/current versions and running/waiting states');

  // Persisted fixtures exercise the real final gates, not an extracted helper.
  // Adding a QA marker after enqueue must still stop WhatsApp and email, while
  // accepted/unknown delivery evidence and unrelated clinical rows stay intact.
  const qaExecution = await create(local, { status: 'running' });
  const qaMessage = await makeMessage(qaExecution);
  const qaEmail = { related_type: 'flow_execution_v2', related_id: qaExecution.id };
  await stop.assertMessageCanDispatch(qaMessage.id);
  const qaAppointmentBefore = (await models.CitaPaciente.findByPk(35)).toJSON();
  await models.CitaPaciente.update({ import_metadata: { qa_demo: { fixture: 'isolated-visit' } } }, { where: { id_cita: 35 } });
  await assert.rejects(stop.assertMessageCanDispatch(qaMessage.id), { code: 'synthetic_communication_forbidden' });
  await assert.rejects(stop.assertEmailCanDispatch(qaEmail), { code: 'synthetic_communication_forbidden' });
  await assert.rejects(stop.prepareMessageForDispatch(qaMessage, { status: 'sending' }), { code: 'synthetic_communication_forbidden' });
  await qaMessage.reload(); assert.equal(qaMessage.status, 'failed');
  const qaAccepted = await makeMessage(qaExecution, { metadata: { source: 'automations_v2', execution_id: qaExecution.id, wamid: 'synthetic-accepted' } });
  const qaUnknown = await makeMessage(qaExecution, { metadata: { source: 'automations_v2', execution_id: qaExecution.id, outcome_unknown: true } });
  await qaAccepted.reload(); await qaUnknown.reload();
  const acceptedBefore = qaAccepted.toJSON(), unknownBefore = qaUnknown.toJSON();
  await stop.cancelMessage(qaAccepted.id); await stop.cancelMessage(qaUnknown.id);
  await qaAccepted.reload(); await qaUnknown.reload();
  assert.deepEqual(qaAccepted.toJSON(), acceptedBefore); assert.deepEqual(qaUnknown.toJSON(), unknownBefore);
  await models.CitaPaciente.update({ import_metadata: qaAppointmentBefore.import_metadata }, { where: { id_cita: 35 } });
  const restoredAppointment = (await models.CitaPaciente.findByPk(35)).toJSON();
  for (const field of ['paciente_id', 'clinica_id', 'doctor_id', 'instalacion_id', 'tratamiento_id', 'estado', 'inicio', 'fin', 'nota']) {
    assert.deepEqual(restoredAppointment[field], qaAppointmentBefore[field]);
  }
  const simulationOnly = await create(local, { context: { __simulation: true }, status: 'running' });
  assert.equal((await stop.assertExecutionActive(simulationOnly)).id, simulationOnly.id, 'isolated execution itself remains possible');
  const simulatedMessage = await makeMessage(simulationOnly);
  await assert.rejects(stop.assertMessageCanDispatch(simulatedMessage.id), { code: 'synthetic_communication_forbidden' });
  const unmarkedExecution = await create(local, { status: 'running' });
  const unmarkedMessage = await makeMessage(unmarkedExecution);
  await stop.assertMessageCanDispatch(unmarkedMessage.id);
  report.checks.push('actual MySQL QA marker added after enqueue rejects WhatsApp/email preparation; accepted/unknown evidence and clinical fields survive, simulation cannot dispatch, normal traffic stays eligible');
  report.coverage = { repeatedInterleavings: runs, networkProviderCalls: 0, realPatientsTouched: 0,
    actualMysql: true, actualToggleController: true, actualEngine: true, syntheticFinalDispatchGuards: true, graphOrPromptEdits: false };
}).catch(error => { console.error(error.stack); process.exitCode = 1; });

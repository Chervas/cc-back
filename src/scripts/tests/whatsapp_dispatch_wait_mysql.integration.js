'use strict';
const assert = require('node:assert/strict'); const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
process.env.JOB_RUNTIME_NAMESPACE = 'staging'; process.env.RUNTIME_NAMESPACE = 'staging'; process.env.RUNTIME_ROLE = 'api';
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  models.Sequelize = D;
  models.Conversation = sql.define('Conversation', { id: { type: D.INTEGER, primaryKey: true }, clinic_id: D.INTEGER,
    patient_id: D.INTEGER, lead_id: D.INTEGER, channel: D.STRING }, { tableName: 'Conversations' });
  for (const [name, file] of [['Message', 'message'], ['JobRequest', 'jobrequest'],
    ['AutomationFlowTemplateV2', 'automationflowtemplatev2'], ['FlowExecutionV2', 'flowexecutionv2'],
    ['AutomationInboundMessageClaim', 'automationinboundmessageclaim']]) models[name] = require('../../../models/' + file)(sql, D);
  models.FlowExecutionV2.belongsTo(models.AutomationFlowTemplateV2, { foreignKey: 'template_version_id', as: 'templateVersion' });
  await sql.sync();
  await models.Conversation.create({ id: 71, clinic_id: 2, channel: 'whatsapp' });
  const native = require('../../services/whatsappDispatchWait.service');
  const jobs = require('../../services/jobRequests.service');
  const message = await models.Message.create({ conversation_id: 71, direction: 'outbound', message_type: 'text',
    content: 'FICTITIOUS_SQL_ONLY', status: 'pending', metadata: {} });
  const intent = { messageId: String(message.id), clinicId: 2, assetId: 3, expectedBinding: { phoneId: '123', wabaId: '456' },
    message: { type: 'text', messaging_product: 'whatsapp', to: '34000000123', text: { body: 'FICTITIOUS_SQL_ONLY' } } };
  const error = { dispatchDeferred: true, code: 'rate_limited', dispatchIntent: intent,
    dispatchPayload: { authorizationId: 'synthetic', phoneId: '123', message: intent.message } };
  await Promise.all(Array.from({ length: 12 }, () => native.defer(error)));
  assert.equal(await models.Message.count(), 1);
  assert.equal(await models.JobRequest.count({ where: { type: native.TYPE } }), 1);
  await message.reload(); const first = structuredClone(message.metadata.dispatch_wait);
  assert.equal(first.state, 'waiting'); assert.equal(first.intent.messageId, String(message.id));
  const originalEnqueue = jobs.enqueueUniqueJobRequest;
  jobs.enqueueUniqueJobRequest = async () => { throw Error('FICTITIOUS_JOB_INSERT_FAILURE'); };
  await assert.rejects(native.defer({ ...error, code: 'whatsapp_capacity_minute' }), /FICTITIOUS_JOB_INSERT_FAILURE/);
  jobs.enqueueUniqueJobRequest = originalEnqueue;
  await message.reload(); assert.deepEqual(message.metadata.dispatch_wait, first);
  report.checks.push('12 concurrent deferrals commit exactly one Message and one native JobRequest; SQL rollback preserves original intent if job insertion fails');
  const stub = (file, exports) => { const filename = require.resolve(file); require.cache[filename] = { id: filename, filename, loaded: true, exports }; };
  let posts = 0;
  stub('../../lib/automation-runtime-stop', { assertMessageCanDispatch: async () => {}, isStop: () => false });
  stub('../../lib/whatsappAuthorizedBrokerClient', { send: async value => { posts++; assert.deepEqual(value, intent); return { messages: [{ id: 'wamid.FICTITIOUS_SQL', message_status: 'accepted' }] }; } });
  stub('../../services/whatsappAccountHealth.service', { assertCanSend: async () => {} });
  stub('../../services/whatsapp.service', { assertRecipientCanReceive: async () => {} });
  stub('../../services/socket.service', { getIO: () => null });
  const inbound = await models.Message.create({ conversation_id: 71, direction: 'inbound', message_type: 'text', content: 'FICTITIOUS', status: 'delivered' });
  const job = await models.JobRequest.findOne({ where: { type: native.TYPE } });
  await job.update({ status: 'running', attempts: 1, last_attempt_at: new Date() });
  const claim = require('../../services/jobClaim.service').createJobClaim(job, { models, isActive: () => true, namespace: () => 'staging' });
  assert.equal((await native.run({ message_id: message.id, clinicId: 2 }, job, claim)).result.provider_accepted, true);
  await native.run({ message_id: message.id, clinicId: 2 }, job, claim);
  assert.equal(posts, 1); await message.reload(); assert.equal(message.metadata.wamid, 'wamid.FICTITIOUS_SQL');
  assert.equal(message.status, 'pending');
  report.checks.push('real SQL Message acceptance persisted separately from delivery; a repeated native job performs no second POST');
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../services/sendQueues.service'), 'utf8');
  const fn = source.slice(source.indexOf('async function whatsappTransportQueues('), source.indexOf('\nasync function listSendQueues('));
  const context = { db: models, Date, require: file => file === './jobRequests.service' ? jobs : null };
  vm.createContext(context); vm.runInContext(fn, context);
  await job.update({ status: 'completed' });
  await jobs.enqueueUniqueJobRequest({ type: native.TYPE, payload: { message_id: message.id, clinicId: 2 }, priority: 'high', maxAttempts: 4096 });
  const groups = await context.whatsappTransportQueues({ clinicIds: [2], clinicNameById: new Map([[2, 'Synthetic']]) });
  assert.equal(groups.length, 1); assert.equal(groups[0].total, 1);
  assert.equal(groups[0].status, 'awaiting_delivery'); assert.equal(groups[0].processed, 0);
  assert.equal((await context.whatsappTransportQueues({ clinicIds: [3], clinicNameById: new Map() })).length, 0);
  report.checks.push('monitor SQL counts one Message despite historical retry jobs, keeps foreign clinics out and distinguishes acceptance from delivery');
  stub('../../services/jobScheduler.service', { triggerImmediate: async () => {} });
  stub('../../services/conversationPendingReply.service', { emitAutomationResponseProcessing: () => {} });
  stub('../../services/conversationAutomationState.service', { setState: async () => ({}), emitState: () => {} });
  stub('../../services/marketingOptOut.service', { applyInboundOptOutIfNeeded: async () => ({ applied: false }) });
  stub('../../services/marketingBulkSends.service', { materializeInboundReply() { throw Error('EARLY_REPLY_MUST_NOT_START_GENERIC_OR_COMMERCIAL_FLOW'); } });
  stub('../../services/automationAttentionReconciliation.service', { reconcilePendingAutomationAttentionForInboundMessage() { throw Error('EARLY_REPLY_MUST_WAIT_FOR_NATIVE_BUFFER'); } });
  stub('../../services/clinicOpeningHours.service', {});
  const template = await models.AutomationFlowTemplateV2.create({ public_id: 'synthetic', template_key: 'synthetic', version: 1,
    trigger_type: 'appointment_reminder_window', clinic_id: 2, name: 'Synthetic', entry_node_id: 'N2', published_at: new Date(), created_by: 1,
    nodes: [{ id: 'N2', type: 'action/send_whatsapp' }, { id: 'N5', type: 'delay/wait_response', config: { response_buffer_enabled: true }, outputs: { on_response: 'N3' } }] });
  const execution = await models.FlowExecutionV2.create({ idempotency_key: 'synthetic-flow', template_version_id: template.id,
    status: 'waiting', current_node_id: 'N2', clinic_id: 2, trigger_type: 'appointment_reminder_window', trigger_entity_type: 'conversation', trigger_entity_id: 71,
    context: { conversation: { id: 71 }, outputs: {} }, waiting_meta: { kind: 'whatsapp_dispatch', message_id: message.id }, created_by: 1 });
  await message.update({ metadata: { ...message.metadata, execution_id: execution.id,
    dispatch_wait: { ...message.metadata.dispatch_wait, post_attempt_at: new Date(Date.now() - 1000).toISOString() } } });
  await inbound.update({ sent_at: new Date(), metadata: { automatic_actions_allowed: true, historical: false, inbox_receipt: 'synthetic',
    fresh_inbound_dispatched_at: new Date().toISOString(), phone_number_id: '123', waba_id: '456' } });
  const inboundService = require('../../services/automationInboundMessage.service');
  const claimRow = await models.AutomationInboundMessageClaim.create({ claim_key: 'synthetic-inbound', message_id: inbound.id,
    conversation_id: 71, clinic_id: 2, channel: 'whatsapp', status: 'queued', owner_type: 'dispatching', claimed_at: new Date(), metadata: {} });
  const input = { claim_id: claimRow.id, message_id: inbound.id, clinic_id: 2, conversation_id: 71, channel: 'whatsapp' };
  const inboundJob = await jobs.enqueueJobRequest({ type: 'automation_inbound_dispatch', payload: input, priority: 'critical', maxAttempts: 5 });
  await inboundJob.update({ status: 'running', attempts: 1, last_attempt_at: new Date() });
  assert.equal((await inboundService.runInboundDispatchJob(input, inboundJob)).status, 'waiting');
  await claimRow.reload(); await inboundJob.reload();
  assert.equal(claimRow.status, 'queued'); assert.equal(claimRow.processed_at, null); assert.equal(inboundJob.max_attempts, 4096);
  assert.equal(posts, 1);
  await execution.update({ status: 'waiting', current_node_id: 'N5', waiting_meta: { type: 'delay/wait_response', runtime_namespace: 'staging', response_buffer_enabled: true },
    wait_until: new Date(Date.now() + 2400000) });
  await inboundJob.update({ attempts: 2 });
  const resumed = await inboundService.runInboundDispatchJob(input, inboundJob);
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.result.owner, 'wait_response');
  await execution.reload(); await claimRow.reload();
  assert.deepEqual(execution.waiting_meta.pending_response_message_ids, [inbound.id]); assert.equal(claimRow.status, 'completed');
  await inboundService.runInboundDispatchJob(input, inboundJob);
  assert.equal(await models.JobRequest.count({ where: { type: 'automations_v2_execute' } }), 1);
  assert.equal(posts, 1);
  report.checks.push('real inbound claim/job waits through recovered-send transition, reaches the unchanged native response buffer exactly once, and never starts generic AI or repeats Meta');
});

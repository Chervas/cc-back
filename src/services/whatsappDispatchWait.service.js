'use strict';
const W = require('../lib/whatsapp-dispatch-wait');
const db = () => require('../../models');
const jobs = () => require('./jobRequests.service');
const TYPE = 'whatsapp_authorized_dispatch_retry';
async function defer(error, { transaction: existingTransaction = null } = {}) {
  if (!W.deferred(error) || !error.dispatchIntent || !error.dispatchPayload) throw error;
  const intent = error.dispatchIntent;
  const models = db();
  const write = async transaction => {
    const message = await models.Message.findByPk(Number(intent.messageId), { transaction, lock: transaction.LOCK.UPDATE });
    if (!message || W.accepted(message)) return;
    const previous = message.metadata?.dispatch_wait;
    const now = Date.now();
    const wait = { version: 1, state: error.delivery_unknown ? 'reconciling' : 'waiting', reason: error.code,
      lane: error.dispatchPayload.dispatchLane || 'clinical', created_at: previous?.created_at || new Date(now).toISOString(),
      expires_at: previous?.expires_at || new Date(now + 86400000).toISOString(),
      intent: previous?.intent || intent, send: previous?.send || error.dispatchPayload,
      post_attempt_at: error.dispatchAttemptAt || previous?.post_attempt_at || null,
      next_attempt_at: W.retryAt(message.id, now, error.code).toISOString() };
    await message.update({ status: 'pending', metadata: { ...message.metadata, error: null, dispatch_wait: wait,
      ...(error.delivery_unknown ? { delivery_unknown: true } : {}) } }, { transaction });
    await jobs().enqueueUniqueJobRequest({ type: TYPE, payload: { message_id: message.id, clinicId: intent.clinicId },
      priority: wait.lane === 'commercial' ? 'low' : 'high', status: 'waiting', origin: 'whatsapp_transport',
      maxAttempts: 4096, nextRunAt: new Date(wait.next_attempt_at), dedupeScope: 'whatsapp-message:' + message.id,
    }, { transaction });
  };
  if (existingTransaction) await write(existingTransaction);
  else await models.sequelize.transaction(write);
}
function waiting(message, reason) {
  return { status: 'waiting', nextAllowedAt: W.retryAt(message.id, Date.now(), reason),
    result: { message_id: message.id, dispatch_status: message.metadata.dispatch_wait.state, reason, auto_resume: true } };
}
async function terminal(message, claim, state, reason, status = 'failed') {
  const models = db();
  await models.sequelize.transaction(async transaction => {
    await claim.assert({ transaction });
    const fresh = await models.Message.findByPk(message.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!fresh || W.accepted(fresh)) return;
    await fresh.update({ status, metadata: { ...fresh.metadata, error: reason,
      dispatch_wait: { ...fresh.metadata.dispatch_wait, state, auto_resume: false } } }, { transaction });
  });
  await message.reload();
}
async function run(payload, _job, claim) {
  const models = db();
  let message = await models.Message.findByPk(Number(payload.message_id));
  if (!message || W.accepted(message)) {
    if (message?.metadata?.google_publication_reminder_enabled === true) {
      try { await require('./googleReviewReminder.service').current().registerAcceptedLink(message, Number(payload.clinicId)); }
      catch { return { status: 'waiting', nextAllowedAt: W.retryAt(message.id), result: { provider_accepted: true, followup_schedule_pending: true } }; }
    }
    return { status: 'completed', result: { already_accepted: !!message } };
  }
  const wait = message.metadata?.dispatch_wait;
  if (!wait || wait.version !== 1 || !['waiting', 'reconciling'].includes(wait.state)
    || !Number.isFinite(Date.parse(wait.expires_at))
    || String(message.id) !== wait.intent?.messageId || Number(payload.clinicId) !== wait.intent.clinicId) {
    return { status: 'failed', retryable: false, error_message: 'whatsapp_dispatch_wait_invalid' };
  }
  const broker = require('../lib/whatsappAuthorizedBrokerClient');
  const stop = require('../lib/automation-runtime-stop');
  try {
    if (!require('./jobClaim.service').isJobClaim(claim)) throw Object.assign(Error('job_claim_lost'), { code: 'job_claim_lost' });
    await claim?.assert({});
    await stop.assertMessageCanDispatch(message.id);
    if (Date.now() >= Date.parse(wait.expires_at)) {
      await terminal(message, claim, wait.state === 'reconciling' ? 'review' : 'expired',
        wait.state === 'reconciling' ? 'whatsapp_delivery_unknown' : 'whatsapp_dispatch_expired',
        wait.state === 'reconciling' ? 'pending' : 'failed');
      return { status: 'failed', retryable: false, error_message: 'whatsapp_dispatch_expired' };
    }
    if (message.metadata?.source === 'marketing_bulk_sends') {
      const list = await models.MarketingPatientList.findByPk(Number(message.metadata.list_id));
      if (!list || ['archived', 'paused'].includes(list.status) || list.criteria?.dispatch?.cancel_requested
        || list.criteria?.dispatch?.requires_admin_review) {
        return waiting(message, 'campaign_paused');
      }
      const nextAllowed = await require('./marketingBulkSends.service').deferredDispatchAllowedAt(list);
      if (nextAllowed) return { ...waiting(message, 'outside_business_hours'), nextAllowedAt: nextAllowed };
      const scope = require('./marketingOptOut.service');
      await scope.assertAutomationCommunicationAllowed({ clinicId: wait.intent.clinicId,
        patientId: Number(message.metadata.recipient_patient_id) || null, phone: wait.intent.message.to,
        scope: message.metadata.communication_scope || 'marketing' });
    }
    let result;
    if (wait.state === 'reconciling') {
      const receipt = await broker.sendReceipt(wait.intent, wait.send);
      if (receipt.state === 'unknown') return waiting(message, 'outcome_unknown');
      if (receipt.state === 'accepted') result = receipt.result;
      else {
        // Only a scoped, authenticated ledger lookup can release an unknown
        // outcome. Reusing the UUID keeps a race with the first POST idempotent.
        await models.sequelize.transaction(async transaction => {
          await claim?.assert({ transaction });
          const fresh = await models.Message.findByPk(message.id, { transaction, lock: transaction.LOCK.UPDATE });
          if (W.accepted(fresh)) return;
          await fresh.update({ metadata: { ...fresh.metadata, delivery_unknown: false,
            dispatch_wait: { ...fresh.metadata.dispatch_wait, state: 'waiting' } } }, { transaction });
        });
        await message.reload();
      }
    }
    if (!result && Date.now() >= Date.parse(wait.expires_at)) {
      await terminal(message, claim, 'expired', 'whatsapp_dispatch_expired');
      return { status: 'failed', retryable: false, error_message: 'whatsapp_dispatch_expired' };
    }
    if (!result) {
      const binding = wait.intent.expectedBinding;
      const config = { clinicId: wait.intent.clinicId, originId: wait.intent.assetId,
        phoneNumberId: binding.phoneId, wabaId: binding.wabaId, authorizedBroker: binding };
      if (message.metadata.kind === 'patient_mobile_verification' || Object.hasOwn(message.metadata, 'mobile_verification_request_id')) {
        const check = await require('./patientMobileVerification.service').current().authorizeTransport({
          message, to: wait.intent.message.to, useTemplate: wait.intent.message.type === 'template', sender: config,
          templateName: wait.intent.message.template?.name, templateLanguage: wait.intent.message.template?.language?.code,
          templateComponents: wait.intent.message.template?.components,
        });
        if (!check.allowed) {
          await terminal(message, claim, 'review', check.reason);
          return { status: 'completed', result: { skipped: true, reason: check.reason } };
        }
        if (check.deferredUntil) return { ...waiting(message, 'quiet_hours'), nextAllowedAt: check.deferredUntil };
      }
      if (message.metadata.google_review_link_event_id) {
        const check = await require('./googleReviewReminder.service').current().authorizeTransport({
          message, to: wait.intent.message.to, useTemplate: wait.intent.message.type === 'template', sender: config,
        });
        if (!check.allowed) return { status: 'completed', result: { skipped: true, reason: check.reason } };
      }
      await require('./whatsappAccountHealth.service').assertCanSend({ clinicConfig: config,
        source: 'whatsapp_dispatch_retry', messageId: message.id, jobId: claim.id });
      await require('./whatsapp.service').assertRecipientCanReceive({ to: wait.intent.message.to, clinicConfig: config });
      if (message.metadata.communication_scope) await require('./marketingOptOut.service').assertAutomationCommunicationAllowed({
        clinicId: wait.intent.clinicId, patientId: message.metadata.recipient_patient_id || null,
        phone: wait.intent.message.to, scope: message.metadata.communication_scope });
      if (wait.intent.message.type === 'template') {
        await require('./whatsappTemplateScope.service').assertTemplateInWaba({ wabaId: binding.wabaId,
          clinicId: wait.intent.clinicId, name: wait.intent.message.template.name, language: wait.intent.message.template.language.code });
        await require('./securityMonitoring.service').assertTemplateAllowed(binding.wabaId,
          wait.intent.message.template.name, wait.intent.message.template.language.code);
      } else {
        const inbound = await models.Message.findOne({ where: { conversation_id: message.conversation_id, direction: 'inbound' }, order: [['createdAt', 'DESC']], raw: true });
        if (!inbound || Date.now() - new Date(inbound.createdAt).getTime() >= 86400000) throw Object.assign(Error('whatsapp_session_expired'), { code: 'whatsapp_session_expired' });
      }
      if (message.metadata?.source === 'marketing_bulk_sends') {
        const list = await models.MarketingPatientList.findByPk(Number(message.metadata.list_id));
        const nextAllowed = list && await require('./marketingBulkSends.service').deferredDispatchAllowedAt(list);
        if (!list || ['archived', 'paused'].includes(list.status) || list.criteria?.dispatch?.cancel_requested
          || list.criteria?.dispatch?.requires_admin_review) return waiting(message, 'campaign_paused');
        if (nextAllowed) return { ...waiting(message, 'outside_business_hours'), nextAllowedAt: nextAllowed };
      }
      await models.sequelize.transaction(async transaction => {
        await claim.assert({ transaction });
        const fresh = await models.Message.findByPk(message.id, { transaction, lock: transaction.LOCK.UPDATE });
        if (W.accepted(fresh)) return;
        await fresh.update({ metadata: { ...fresh.metadata,
          dispatch_wait: { ...fresh.metadata.dispatch_wait, post_attempt_at: new Date().toISOString() } } }, { transaction });
      });
      await claim.assert({}); await stop.assertMessageCanDispatch(message.id); result = await broker.send(wait.intent);
    }
    await models.sequelize.transaction(async transaction => {
      await claim?.assert({ transaction });
      message = await models.Message.findByPk(message.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!W.accepted(message)) await message.update({ status: 'pending', sent_at: null,
        metadata: { ...message.metadata, error: null, delivery_unknown: false, wa_response: result,
          wamid: result.messages[0].id, provider_acceptance_status: result.messages[0].message_status || 'accepted',
          provider_acceptance_at: new Date().toISOString(),
          dispatch_wait: { ...message.metadata.dispatch_wait, state: 'accepted', accepted_at: new Date().toISOString() } } }, { transaction });
      if (message.metadata?.source === 'marketing_bulk_sends' && message.metadata.item_id
        && message.metadata.kind !== 'mass_campaign_test' && message.metadata.test_send !== true) {
        await models.MarketingPatientListItem.update({ dispatch_status: result.messages[0].message_status === 'held_for_quality_assessment' ? 'held_quality' : 'accepted', provider_message_id: result.messages[0].id,
          last_error_code: null, last_error_message: null }, { where: { id: message.metadata.item_id,
            list_id: message.metadata.list_id, app_message_id: message.id }, transaction });
      }
    });
    if (message.metadata.execution_id) await wakeExecution(message).catch(() => null);
    if (message.metadata.google_publication_reminder_enabled === true) {
      try { await require('./googleReviewReminder.service').current().registerAcceptedLink(message, wait.intent.clinicId); }
      catch { return { status: 'waiting', nextAllowedAt: W.retryAt(message.id), result: { provider_accepted: true, followup_schedule_pending: true } }; }
    }
    if (wait.intent.message.type === 'template') {
      await require('./whatsappDeliveryGovernance.service').recordImmediateSendResponse({ response: result,
        clinicId: wait.intent.clinicId, wabaId: wait.intent.expectedBinding.wabaId,
        phoneNumberId: wait.intent.expectedBinding.phoneId, messageId: message.id,
        template: { id: message.metadata.template_id || null, name: wait.intent.message.template.name,
          language: wait.intent.message.template.language.code },
        ...(message.metadata.kind !== 'mass_campaign_test' && message.metadata.test_send !== true
          ? { listId: message.metadata.list_id || null, itemId: message.metadata.item_id || null } : {}) }).catch(() => null);
    }
    const io = require('./socket.service').getIO();
    io?.to('clinic:' + wait.intent.clinicId).emit('message:updated', { id: message.id, conversation_id: message.conversation_id, status: message.status });
    return { status: 'completed', result: { message_id: message.id, provider_accepted: true, delivered: false } };
  } catch (error) {
    if (error.code === 'job_claim_lost') throw error;
    if (stop.isStop(error)) {
      await stop.cancelMessage(message.id);
      return { status: 'completed', result: { cancelled: true, reason: error.code } };
    }
    if (W.deferred(error)) { await defer(error); await message.reload(); return waiting(message, error.code); }
    if (W.CAPACITY.has(error.code)) return waiting(message, error.code);
    // A transport result cannot turn a revoked scope or an uncertain delivery
    // into permission to POST. Keep it visible for reconciliation/review.
    if (['broker_unavailable', 'broker_timeout', 'broker_response_invalid'].includes(error.code)) return waiting(message, error.code);
    await message.reload();
    if (!W.accepted(message)) await terminal(message, claim, 'review', error.response?.data || error.code || 'whatsapp_dispatch_review_required');
    await require('./appointmentWhatsappDeliveryAlert.service').reconcileAppointmentWhatsappDelivery({ message, mappedStatus: 'failed', clinicId: wait.intent.clinicId });
    return { status: 'failed', retryable: false, error_message: error.code || 'whatsapp_dispatch_review_required' };
  }
}
async function wakeExecution(message) {
  const models = db(); const namespace = jobs().getCurrentRuntimeNamespace();
  await models.sequelize.query("UPDATE JobRequests SET next_run_at=UTC_TIMESTAMP(),priority='critical' WHERE type='automations_v2_execute' AND status IN ('pending','waiting') AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.execution_id'))=:execution AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.__runtime_namespace'))=:namespace", {
    replacements: { execution: String(message.metadata.execution_id), namespace } });
}
async function inboundTransition(message, conversation) {
  const m = message.metadata || {};
  if (conversation.channel !== 'whatsapp' || message.direction !== 'inbound' || m.automatic_actions_allowed !== true
    || !m.inbox_receipt || !m.fresh_inbound_dispatched_at || m.historical !== false || m.recovery_without_automation === true
    || m.media_recovered_without_automation === true || Date.now() - new Date(message.sent_at).getTime() > 86400000) return null;
  const models = db(), { Op } = models.Sequelize;
  const outbound = await models.Message.findOne({ where: { conversation_id: conversation.id, direction: 'outbound',
    id: { [Op.lt]: message.id }, [Op.and]: models.sequelize.where(models.sequelize.literal("JSON_EXTRACT(metadata,'$.dispatch_wait.version')"), 1) },
    order: [['id', 'DESC']] });
  const wait = outbound?.metadata?.dispatch_wait, executionId = Number(outbound?.metadata?.execution_id);
  if (wait?.intent?.expectedBinding && (m.phone_number_id !== wait.intent.expectedBinding.phoneId
    || m.waba_id !== wait.intent.expectedBinding.wabaId)) return null;
  const attempted = Date.parse(wait?.post_attempt_at || '');
  if (!executionId || !Number.isFinite(attempted) || !Number.isFinite(new Date(message.sent_at).getTime())
    || new Date(message.sent_at).getTime() < attempted - 1000) return null;
  const execution = await models.FlowExecutionV2.findByPk(executionId, {
    include: [{ model: models.AutomationFlowTemplateV2, as: 'templateVersion', attributes: ['nodes', 'is_active'] }] });
  if (!execution || Number(execution.clinic_id) !== Number(conversation.clinic_id) || !execution.templateVersion?.is_active) return null;
  if (!W.accepted(outbound) && (wait.state === 'review' || Date.now() >= Date.parse(wait.expires_at))) {
    return { executionId, review: true, reason: 'whatsapp_delivery_requires_review' };
  }
  if (!['waiting','running'].includes(execution.status)) return null;
  const node = execution.templateVersion.nodes?.find(n => n.id === execution.current_node_id);
  const transition = execution.waiting_meta?.kind === 'whatsapp_dispatch'
    || execution.status === 'running' && ['action/send_whatsapp','delay/wait_response'].includes(node?.type);
  if (!transition || !W.accepted(outbound) && wait.state !== 'reconciling') return null;
  return { executionId, nextAllowedAt: new Date(Date.now() + (W.accepted(outbound) ? 5000 : 60000)), reason: 'native_transport_transition' };
}
module.exports = { TYPE, defer, run, inboundTransition, wakeExecution };

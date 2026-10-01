'use strict';
const { canResendFailedTemplate, retryMetadata } = require('../lib/whatsapp-template-resend');
const fail = (code, status = 409) => { throw Object.assign(Error(code), { code, status }); };

async function assertReady({ message, conversation, transaction }) {
  const db = require('../../models'), m = message.metadata;
  const broker = require('../lib/whatsappAuthorizedBrokerClient');
  broker.assertMessageEligible(message);
  const original = await db.Message.findByPk(m.manual_retry_of_message_id, { transaction });
  if (!original || Number(original.conversation_id) !== Number(conversation.id)
    || original.metadata?.manual_retry_message_id && Number(original.metadata.manual_retry_message_id) !== Number(message.id)
    || !canResendFailedTemplate({ ...original.toJSON(), metadata: { ...original.metadata, manual_retry_message_id: null } })) fail('whatsapp_template_retry_not_safe');
  // Reuse the original age/security holds for a NEW intent; never present its
  // failed status or accepted WAMID as an eligible transport identity.
  const originalIntent = { id: original.id, direction: 'outbound', status: 'pending', createdAt: original.createdAt,
    metadata: retryMetadata(original, m.manual_retry_requested_by, new Date()) };
  broker.assertMessageEligible(originalIntent);
  const sender = await require('./flowEngineV2.service').resolveScheduledWhatsappSenderConfig({ metadata: m, clinicId: conversation.clinic_id });
  if (!sender?.authorizedBroker?.sendEnabled) fail('whatsapp_authorized_send_paused');
  if (sender.authorizedBroker.messageNotBefore) broker.assertMessageEligibility(message, sender.authorizedBroker.messageNotBefore);
  if (sender.authorizedBroker.messageNotBefore) broker.assertMessageEligibility(originalIntent, sender.authorizedBroker.messageNotBefore);
  if (m.wabaId !== sender.wabaId || (m.phoneNumberId || m.phoneId) !== sender.phoneNumberId) fail('whatsapp_sender_snapshot_scope_mismatch');
  const template = await db.WhatsappTemplate.findByPk(m.template_id, { transaction });
  if (!template || template.name !== m.template_name || template.language !== m.template_language
    || String(template.waba_id) !== String(sender.wabaId) || template.status !== 'APPROVED' || !template.is_active
    || template.retired_at || template.superseded_by_template_id) fail('whatsapp_template_not_available');
  await require('./whatsappAccountHealth.service').assertCanSend({ clinicConfig: sender, source: 'manual_template_resend' });
  await require('./securityMonitoring.service').assertTemplateAllowed(sender.wabaId, template.name, template.language);
  const recipient = require('./whatsapp.service').normalizePhoneNumber(m.recipient);
  if (!recipient || recipient !== require('./whatsapp.service').normalizePhoneNumber(conversation.contact_id)) fail('whatsapp_contact_identity_conflict');
  const contact = conversation.patient_id ? await db.Paciente.findByPk(conversation.patient_id, { transaction })
    : conversation.lead_id ? await db.LeadIntake.findByPk(conversation.lead_id, { transaction }) : null;
  if (contact && recipient !== require('./whatsapp.service').normalizePhoneNumber(contact.telefono_movil || contact.telefono)) fail('whatsapp_contact_identity_conflict');
  await require('./marketingOptOut.service').assertAutomationCommunicationAllowed({ clinicId: conversation.clinic_id,
    patientId: conversation.patient_id, phone: recipient, scope: m.communication_scope || (template.category === 'MARKETING' ? 'marketing' : 'care') });
  const eligibility = require('../lib/whatsappAppointmentEligibility');
  const loadExecution = id => db.FlowExecutionV2.findByPk(id, { transaction, raw: true });
  const loadAppointment = id => db.CitaPaciente.findByPk(id, { transaction, raw: true });
  await eligibility.assertAutomatedMessageEligibility({ message, conversation, loadExecution, loadAppointment,
    patientHeld: eligibility.patientImportHeld, payload: { type: 'template', template: { name: template.name } } });
  if (Number(m.execution_id) > 0) {
    const e = await loadExecution(Number(m.execution_id));
    if (e?.trigger_entity_type === 'appointment') {
      const a = await loadAppointment(e.trigger_entity_id);
      if (/^clinicaclick_confirmacion_datos_cita_/.test(template.name)
        && ['info_confirmada', 'recordatorio_confirmado'].includes(a?.estado)) fail('whatsapp_appointment_already_confirmed');
    }
  }
}

function createService({ models = () => require('../../models'), checkReady = assertReady,
  enqueue = (payload, options) => require('./queue.service').queues.outboundWhatsApp.add('send', payload, options),
  namespace = () => require('./jobRequests.service').getCurrentRuntimeNamespace(), now = () => new Date() } = {}) {
  const db = () => typeof models === 'function' ? models() : models;
  async function resend({ messageId, userId, authorize }) {
    const result = await db().sequelize.transaction(async transaction => {
      const original = await db().Message.findByPk(messageId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!original) fail('message_not_found', 404);
      const conversation = await db().Conversation.findByPk(original.conversation_id, { transaction });
      if (!conversation) fail('conversation_not_found', 404);
      await authorize(conversation);
      if (conversation.channel !== 'whatsapp') fail('not_whatsapp_outbound_message', 400);
      const existing = await db().Message.findOne({ where: { automation_delivery_key: `manual-template-retry-${original.id}` }, transaction });
      if (existing) return { message: existing, conversation, original, reused: true };
      if (!canResendFailedTemplate(original)) fail('whatsapp_template_retry_not_safe');
      const metadata = retryMetadata(original, userId, now());
      // Validate the ORIGINAL age as well: manual retry cannot bypass the security cutoff.
      await checkReady({ message: { id: original.id, direction: 'outbound', status: 'pending', metadata, createdAt: original.createdAt }, conversation, transaction });
      const message = await db().Message.create({ conversation_id: original.conversation_id, sender_id: userId,
        direction: 'outbound', content: original.content, message_type: 'template', status: 'pending',
        automation_delivery_key: `manual-template-retry-${original.id}`, metadata }, { transaction });
      const { DateTime } = require('luxon');
      const local = DateTime.fromJSDate(now(), { zone: 'Europe/Madrid' });
      const quiet = metadata.quiet_hours_enabled === true && (local.hour >= 22 || local.hour < 7);
      const scheduled = quiet ? (local.hour >= 22 ? local.plus({ days: 1 }) : local).set({ hour: 7, minute: 0, second: 0, millisecond: 0 }).toJSDate() : now();
      if (quiet) await message.update({ metadata: { ...metadata, queued_by_quiet_hours: true, scheduled_for: scheduled.toISOString() } }, { transaction });
      // Commit the dispatch request with the message. Redis/network failures
      // cannot strand it or require a second patient-facing send identity.
      await db().JobRequest.create({ type: 'whatsapp_manual_template_resend', priority: 'high', status: 'waiting',
        origin: 'quickchat_manual_template_resend', requested_by: userId, max_attempts: 5, next_run_at: scheduled,
        payload: { message_id: message.id, __runtime_namespace: namespace() } }, { transaction });
      await original.update({ metadata: { ...original.metadata, manual_retry_message_id: message.id } }, { transaction });
      return { message, conversation, original, reused: false };
    });
    return result;
  }
  async function dispatch({ message_id: messageId }) {
    const message = await db().Message.findByPk(messageId);
    if (!message || message.status !== 'pending' || message.metadata?.wamid) return { status: 'completed', result: { skipped: true } };
    const conversation = await db().Conversation.findByPk(message.conversation_id);
    if (!conversation || !message.metadata?.manual_retry_of_message_id) fail('whatsapp_template_retry_not_safe');
    const m = message.metadata;
    try { await checkReady({ message, conversation }); }
    catch (error) {
      if (Number(error?.status || error?.statusCode) >= 500) throw error;
      await message.update({ status: 'failed', metadata: { ...m, manual_retry_blocked: true,
        manual_retry_blocked_at: now().toISOString(), error: 'whatsapp_manual_retry_preflight_blocked' } });
      return { status: 'completed', result: { skipped: true, reason: 'preflight_blocked', message_id: message.id } };
    }
    const options = require('../lib/appointment-access-guidance-template').buildAutomationWhatsappTransportJobOptions(message.id);
    await enqueue({ messageId: message.id, conversationId: conversation.id, clinicId: conversation.clinic_id,
      to: m.recipient, body: message.content, useTemplate: true, templateName: m.template_name,
      templateLanguage: m.template_language, templateParams: m.template_params || m.templateParams,
      templateComponents: m.template_components || m.templateComponents, retryOnFailure: false,
      resolveClinicConfigAtSend: true }, { ...options, attempts: 1 });
    return { status: 'completed', result: { message_id: message.id } };
  }
  return { resend, dispatch };
}
module.exports = { createService, assertReady, ...createService() };

'use strict';

const FAMILY = 'review_google_publication_reminder_v1';
const DELAY_MS = 20 * 60 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MARGIN_MS = 60 * 1000;
const id = value => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const text = value => String(value || '').trim();
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function definition(clinicId = null, master = null) {
  const node = (nodeId, type, config, outputs, x, y) => ({ id: nodeId, type, config, outputs, position: { x, y } });
  return {
    public_id: clinicId ? `flw_review_google_reminder_${clinicId}` : 'flw_review_google_reminder',
    template_key: clinicId ? `${FAMILY}__clinic_${clinicId}` : FAMILY,
    version: 1, engine_version: 'v2',
    name: 'Recordar la publicación de la reseña en Google',
    description: 'Un único seguimiento de nuevos enlaces, a partir de 20 h, con comprobación local reciente, horario seguro y ventana WhatsApp abierta. Sin plantilla de pago ni recuperación histórica.',
    trigger_type: 'review_google_link_sent', trigger_config: { managed_feature: 'review_google_publication_reminder', future_links_only: true },
    is_active: true, is_system: !clinicId, clinic_id: clinicId, group_id: null, entry_node_id: 'N1',
    nodes: master?.nodes || [
      node('N1', 'trigger/review_google_link_sent', {}, { on_success: 'N2' }, 0, 0),
      node('N2', 'delay/wait_until', { datetime_expression: '{{trigger.data.followup_due_at}}' }, { on_complete: 'N3' }, 0, 130),
      node('N3', 'condition/google_review_check', { list_id: '{{trigger.data.list_id}}', item_id: '{{trigger.data.item_id}}' },
        { on_found: 'N5', on_not_detected: 'N4', on_unknown: 'N5' }, 0, 260),
      node('N4', 'action/remind_google_review', {}, { on_success: 'N5' }, 0, 410),
      node('N5', 'control/end', {}, {}, 0, 560),
    ],
    published_at: new Date(), published_by: master?.created_by || 1, created_by: master?.created_by || 1,
  };
}

// Intersect existing campaign/clinic hours with the platform quiet-hours policy.
// A late queue is not permission to send outside the original 24 h window.
async function allowedSlot({ now, dueAt, expiresAt, clinicSlot, quietWindow }) {
  let candidate = new Date(Math.max(+new Date(now), +new Date(dueAt)));
  if (![+candidate, +new Date(expiresAt)].every(Number.isFinite)) return { reason: 'invalid_time_window' };
  for (let step = 0; step < 10 && candidate < expiresAt; step += 1) {
    const clinic = await clinicSlot(candidate);
    if (!clinic?.at) return { reason: clinic?.reason || 'clinic_schedule_unavailable' };
    const clinicAt = new Date(clinic.at);
    if (!Number.isFinite(+clinicAt) || clinicAt < candidate) return { reason: 'invalid_clinic_slot' };
    const quiet = quietWindow({ now: clinicAt });
    const next = quiet.delayMs > 0 ? new Date(quiet.scheduledAt) : clinicAt;
    if (!Number.isFinite(+next) || next >= expiresAt) break;
    if (+next === +candidate) return { at: candidate };
    candidate = next;
  }
  return { reason: 'no_allowed_slot_before_whatsapp_expiry' };
}

function createRuntime(deps) {
  const { db, bulk, engine, serviceWindow, enqueueJob, triggerJob, stop } = deps;

  async function ensureCatalog(clinicId = null) {
    const latest = key => db.AutomationFlowTemplateV2.findOne({ where: { template_key: key, published_at: { [db.Sequelize.Op.ne]: null } }, order: [['version', 'DESC'], ['id', 'DESC']] });
    let master = await latest(FAMILY);
    if (!master) [master] = await db.AutomationFlowTemplateV2.findOrCreate({ where: { public_id: 'flw_review_google_reminder', version: 1 }, defaults: definition() });
    if (!clinicId || !master.is_active) return master;
    let local = await latest(`${FAMILY}__clinic_${clinicId}`);
    if (!local) [local] = await db.AutomationFlowTemplateV2.findOrCreate({
      where: { public_id: `flw_review_google_reminder_${clinicId}`, version: 1 }, defaults: definition(clinicId, master),
    });
    return local;
  }

  async function schedule(event) {
    const payload = object(event?.payload);
    if (event?.event_type !== 'review_rating_followup_sent' || payload.google_publication_reminder_enabled !== true
      || payload.test_send || payload.status !== 'sent' || payload.kind !== 'review_google_link_followup'
      || ![event.list_id, event.item_id, payload.clinic_id, payload.conversation_id, payload.sender_origin_id].every(id)
      || !text(payload.phoneNumberId)) return { skipped: true, reason: 'not_a_new_confirmed_google_link' };
    const dueAt = new Date(+new Date(payload.google_link_sent_at) + DELAY_MS);
    if (!Number.isFinite(+dueAt)) return { skipped: true, reason: 'invalid_link_time' };
    const template = await ensureCatalog(id(payload.clinic_id));
    if (!template.is_active) return { skipped: true, reason: 'automation_deactivated' };
    const key = `google-review-publication:${payload.clinic_id}:${event.list_id}:${event.item_id}`;
    let execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: key } });
    if (!execution) {
      try {
        execution = await stop.createExecution({ idempotency_key: key, template_version_id: template.id,
          engine_version: 'v2', status: 'running', current_node_id: template.entry_node_id,
          clinic_id: id(payload.clinic_id), group_id: null, created_by: template.created_by,
          trigger_type: 'review_google_link_sent', trigger_entity_type: 'marketing_contact_event', trigger_entity_id: event.id,
          context: { trigger: { type: 'review_google_link_sent', data: { link_event_id: event.id,
            list_id: event.list_id, item_id: event.item_id, clinic_id: id(payload.clinic_id),
            conversation_id: id(payload.conversation_id), followup_due_at: dueAt.toISOString() } } },
        });
      } catch (error) {
        if (stop.isStop(error)) return { skipped: true, reason: 'automation_deactivated' };
        if (error.name !== 'SequelizeUniqueConstraintError') throw error;
        execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: key } });
        if (!execution) throw error;
      }
    }
    if (!['running', 'waiting'].includes(execution.status)) return { execution_id: execution.id, deduplicated: true };
    const { job } = await enqueueJob({ type: 'automations_v2_execute', priority: 'normal', status: 'waiting',
      origin: 'review_google_publication_reminder', nextRunAt: dueAt,
      payload: { execution_id: execution.id }, dedupeScope: `flow_execution:${execution.id}`,
      requestedBy: template.created_by, requestedByRole: 'system' });
    if (job && dueAt <= new Date()) triggerJob(job.id).catch(() => {});
    return { execution_id: execution.id, job_id: job?.id || null, due_at: dueAt.toISOString() };
  }

  async function registerAcceptedLink(message, clinicId) {
    const p = object(message?.metadata);
    if (p.source !== 'marketing_bulk_sends' || p.kind !== 'review_google_link_followup'
      || p.google_publication_reminder_enabled !== true || p.test_send || !text(p.wamid)) return;
    const existing = await db.MarketingPatientContactEvent.findOne({ where: { list_id: p.list_id,
      item_id: p.item_id, event_type: 'review_rating_followup_sent',
      [db.Sequelize.Op.and]: db.sequelize.where(db.sequelize.json('payload.app_message_id'), message.id) } });
    const event = existing || await db.MarketingPatientContactEvent.create({ list_id: p.list_id, item_id: p.item_id,
      paciente_id: p.recipient_patient_id || null, event_type: 'review_rating_followup_sent', channel: 'whatsapp',
      occurred_at: new Date(), payload: { status: 'sent', kind: p.kind, test_send: false,
        google_review_url_sent: true, google_publication_reminder_enabled: true,
        google_review_url: p.google_review_url, google_link_sent_at: p.provider_acceptance_at || new Date(message.sent_at || Date.now()).toISOString(),
        clinic_id: clinicId, conversation_id: message.conversation_id, recipient: p.recipient,
        app_message_id: message.id, provider_message_id: p.wamid, trigger_message_id: p.trigger_message_id,
        sender_origin_id: p.sender_origin_id, phoneNumberId: p.phoneNumberId, wabaId: p.wabaId || null } });
    return schedule(event);
  }

  async function inspect({ eventId, clinicId, conversationId, now = new Date() }) {
    const skip = reason => ({ state: 'skip', reason });
    const event = await db.MarketingPatientContactEvent.findByPk(id(eventId));
    const p = object(event?.payload);
    if (!event || event.event_type !== 'review_rating_followup_sent' || p.google_publication_reminder_enabled !== true
      || p.test_send || p.kind !== 'review_google_link_followup' || p.status !== 'sent'
      || id(p.clinic_id) !== id(clinicId) || !id(clinicId) || id(p.conversation_id) !== id(conversationId)) return skip('link_scope_mismatch');
    const [list, item, conversation, source] = await Promise.all([
      db.MarketingPatientList.findByPk(event.list_id), db.MarketingPatientListItem.findByPk(event.item_id),
      db.Conversation.findByPk(conversationId), db.Message.findByPk(p.app_message_id),
    ]);
    if (!list || !item || ['archived', 'paused'].includes(list.status) || list.criteria?.dispatch?.cancel_requested
      || Number(item.list_id) !== Number(list.id)
      || Number(item.clinica_id || list.clinica_id) !== Number(clinicId)
      || Number(conversation?.clinic_id) !== Number(clinicId)
      || Number(source?.conversation_id) !== Number(conversationId)
      || (conversation?.patient_id && item.paciente_id && Number(conversation.patient_id) !== Number(item.paciente_id))
      || ['failed', 'cancelled'].includes(text(source?.status)) || !text(p.provider_message_id)
      || text(source?.metadata?.wamid) !== text(p.provider_message_id)) return skip('original_link_not_confirmed');
    const normalize = deps.normalizePhone;
    const recipient = normalize(item.phone);
    if (!recipient || recipient !== normalize(p.recipient)) return skip('recipient_changed');
    let url;
    try { url = new URL(p.google_review_url); } catch { return skip('google_link_missing'); }
    if (url.protocol !== 'https:') return skip('google_link_missing');
    try { await bulk.assertReviewRequestCommunicationAllowed({ list, item, conversation, forceReview: true, channel: 'whatsapp' }); }
    catch { return skip('communication_not_allowed'); }
    let sender;
    try { sender = await engine.resolveScheduledWhatsappSenderConfig({ metadata: p, clinicId }); }
    catch { return skip('original_sender_unavailable'); }
    if (!id(p.sender_origin_id) || !text(p.phoneNumberId) || text(sender?.phoneNumberId) !== text(p.phoneNumberId)) return skip('original_sender_changed');
    const window = await serviceWindow({ conversation, activePhoneNumberId: p.phoneNumberId, now });
    if (!window.open || window.matchedBy !== 'message_phone_number_id') return skip('whatsapp_window_not_proven');
    const expiresAt = new Date(+new Date(window.lastInboundAt) + WINDOW_MS - MARGIN_MS);
    const dueAt = new Date(+new Date(p.google_link_sent_at) + DELAY_MS);
    const slot = await allowedSlot({ now, dueAt, expiresAt,
      clinicSlot: reference => bulk.reviewReminderAllowedAt(list, reference), quietWindow: engine.computeQuietHoursDelayMs });
    if (!slot.at) return skip(slot.reason);
    if (+slot.at > +new Date(now)) return { state: 'waiting', at: slot.at, expires_at: expiresAt };
    const publication = await bulk.getGoogleReviewPublicationState({ clinicId, listId: list.id, itemId: item.id });
    if (publication.state !== 'not_detected') return skip(publication.state === 'found' ? 'google_review_found' : publication.reason || 'google_observation_unavailable');
    return { state: 'ready', event, list, item, conversation, recipient, sender, url: url.href, expires_at: expiresAt };
  }

  async function action({ execution, context, node }) {
    const data = context?.trigger?.data || {};
    const done = output => ({ kind: 'success', output, next_node_id: node.outputs?.on_success || null });
    if (context?.__simulation || execution?.context?.__simulation) return done({ status: 'simulated', no_send: true });
    let result;
    try { result = await inspect({ eventId: data.link_event_id, clinicId: execution.clinic_id, conversationId: data.conversation_id,
      now: deps.now ? deps.now() : new Date() }); }
    catch { return done({ status: 'skipped', reason: 'review_guard_unavailable' }); }
    if (result.state === 'waiting') return { kind: 'waiting', wait_until: result.at,
      waiting_meta: { reason: 'review_google_allowed_slot', expires_at: result.expires_at.toISOString() } };
    if (result.state !== 'ready') return done({ status: 'skipped', reason: result.reason });
    const p = result.event.payload;
    const { message, created } = await engine.findOrCreateAutomationWhatsappMessage({
      deliveryKey: `google-review-reminder:${execution.clinic_id}:${result.list.id}:${result.item.id}`, messageType: 'text',
      values: { conversation_id: result.conversation.id, sender_id: null, direction: 'outbound',
        content: `¡Hola! ¿Pudiste publicar tu opinión en Google? Puedes hacerlo aquí: ${result.url}\n\nGracias.`,
        message_type: 'text', status: 'pending', metadata: { source: 'automations_v2', execution_id: execution.id,
          node_id: node.id, kind: 'review_google_publication_reminder', google_review_link_event_id: result.event.id,
          communication_scope: 'marketing', recipient_patient_id: result.item.paciente_id || null,
          recipient: result.recipient, list_id: result.list.id, item_id: result.item.id,
          sender_origin_id: p.sender_origin_id, phoneNumberId: p.phoneNumberId, wabaId: p.wabaId || null } },
    });
    if (created || message.status === 'pending' && !message.metadata?.automation_transport_job_id)
      await engine.enqueueAutomationWhatsappTransport({ msg: message, conversation: result.conversation,
      recipient: result.recipient, dispatchKind: 'google_review_reminder', retryOnFailure: true });
    return done({ status: created ? 'queued' : 'already_recorded', message_id: message.id });
  }

  async function authorizeTransport({ message, to, useTemplate, sender, now = new Date() }) {
    const p = object(message.metadata);
    if (!p.google_review_link_event_id) return { allowed: true };
    if (p.google_review_reminder_skipped || p.cancelled) return { allowed: false, reason: p.cancellation_reason || 'reminder_cancelled' };
    const execution = await db.FlowExecutionV2.findByPk(p.execution_id);
    let result;
    try { result = await inspect({ eventId: p.google_review_link_event_id, clinicId: execution?.clinic_id,
      conversationId: message.conversation_id, now }); }
    catch { result = { state: 'skip', reason: 'review_guard_unavailable' }; }
    const allowed = result.state === 'ready' && !useTemplate
      && deps.normalizePhone(to) === result.recipient
      && text(sender?.phoneNumberId) === text(result.sender.phoneNumberId)
      && id(sender?.originId) === id(result.sender.originId);
    if (allowed) return { allowed: true };
    const reason = result.reason || (result.state === 'waiting' ? 'queued_outside_allowed_slot' : 'review_transport_scope_mismatch');
    await message.update({ status: 'failed', metadata: { ...p, cancelled: true,
      cancellation_reason: reason, google_review_reminder_skipped: true, skipped_at: new Date(now).toISOString() } });
    return { allowed: false, reason };
  }

  return { ensureCatalog, schedule, registerAcceptedLink, inspect, action, authorizeTransport };
}

let runtime;
function current() {
  if (!runtime) runtime = createRuntime({ db: require('../../models'), bulk: require('./marketingBulkSends.service'),
    engine: require('./flowEngineV2.service'), serviceWindow: require('./whatsappServiceWindow.service').resolveWhatsappServiceWindow,
    normalizePhone: require('./whatsapp.service').normalizePhoneNumber,
    enqueueJob: require('./jobRequests.service').enqueueUniqueJobRequest,
    triggerJob: require('./jobScheduler.service').triggerImmediate, stop: require('../lib/automation-runtime-stop') });
  return runtime;
}

module.exports = { FAMILY, DELAY_MS, definition, allowedSlot, createRuntime, current };

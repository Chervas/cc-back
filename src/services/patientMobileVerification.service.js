'use strict';

const { randomBytes } = require('node:crypto');
const C = require('../lib/patient-mobile-verification');
const plain = row => row?.toJSON ? row.toJSON() : row;
const fail = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
const rawTime = value => value ? new Date(value).getTime() : NaN;

function createRuntime(deps) {
  const { db } = deps, { Op } = db.Sequelize;
  const now = () => new Date(deps.now ? deps.now() : Date.now());
  const enabled = () => deps.enabled ? deps.enabled() === true : process.env.PATIENT_MOBILE_VERIFICATION_ENABLED === 'true';
  const events = db.PatientOperationalEvent;
  const requestKey = request => `patient-mobile-verification:${request.clinic_id}:${request.id}`;

  async function latest(patientId, transaction) {
    return events.findOne({ where: { patient_id: patientId, event_type: C.REQUEST }, order: [['id', 'DESC']], transaction });
  }
  async function state(request, transaction) {
    const rows = await events.findAll({ where: { patient_id: request.patient_id, clinic_id: request.clinic_id,
      event_type: { [Op.in]: [C.TRANSITION, C.RESOLVED] },
      [Op.and]: db.Sequelize.where(db.Sequelize.literal("JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.request_event_id'))"), String(request.id)) },
      order: [['id', 'ASC']], transaction });
    return C.stateFrom(plain(request), rows.map(plain));
  }
  async function lockPatient(request, transaction) {
    await db.Clinica.findByPk(request.clinic_id, { transaction, lock: transaction.LOCK.SHARE });
    const patient = await db.Paciente.findByPk(request.patient_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!patient) throw fail('mobile_verification_patient_missing', 404);
    return patient;
  }
  async function current(request, patient, transaction) {
    const m = request.metadata || {};
    if (request.event_type !== C.REQUEST || m.schema_version !== C.SCHEMA || !C.id(request.actor_user_id)
      || !['privacy_profile_review', 'reception_mobile_verification'].includes(request.source)
      || !C.phone(m.phone) || C.phone(patient.telefono_movil) !== C.phone(m.phone)) return false;
    const newest = await latest(request.patient_id, transaction);
    if (Number(newest?.id) !== Number(request.id)) return false;
    if (!(await state(request, transaction)).current) return false;
    const belongs = Number(patient.clinica_id) === Number(request.clinic_id) || await db.PacienteClinica.findOne({
      where: { paciente_id: request.patient_id, clinica_id: request.clinic_id }, transaction });
    if (!belongs) return false;
    const document = await db.PatientConsentDocument.findByPk(m.document_id, { transaction });
    return !!document && Number(document.paciente_id) === Number(request.patient_id)
      && Number(document.clinica_id) === Number(request.clinic_id) && document.status === 'signed'
      && !document.revoked_at && document.snapshot_hash === m.snapshot_hash;
  }
  async function transition(request, previous, patch, transaction, terminal = false) {
    const metadata = { ...previous, history: undefined, reason_text: undefined, revision: undefined,
      ...patch, request_event_id: Number(request.id), schema_version: C.SCHEMA, phone: C.phone(request.metadata.phone) };
    const row = await events.create({ patient_id: request.patient_id, clinic_id: request.clinic_id,
      actor_user_id: patch.actor_user_id || null, event_type: terminal ? C.RESOLVED : C.TRANSITION,
      source: 'patient_mobile_verification', channel: patch.provenance === 'patient_reply' ? 'whatsapp' : 'internal',
      occurred_at: now(), metadata }, { transaction });
    return { ...metadata, revision: Number(row.id) };
  }
  async function closeTasks(request, transaction, reason) {
    const notifications = await db.Notification.findAll({ where: { clinicaId: request.clinic_id,
      event: { [Op.in]: ['patient.mobile_verification_review', 'automation.persistent_alert', 'automation.system_notification'] },
      [Op.and]: db.Sequelize.where(db.Sequelize.literal("JSON_UNQUOTE(JSON_EXTRACT(data,'$.request_event_id'))"), String(request.id)) }, transaction });
    for (const notification of notifications) {
      await notification.update({ isRead: true, readAt: now(),
        data: { ...notification.data, resolved: true, resolution: reason, resolvedAt: now().toISOString(), requiresAcknowledgement: false } }, { transaction });
      if (deps.notificationUpdated) transaction.afterCommit(() => deps.notificationUpdated(notification));
    }
  }
  async function wake(request, transaction, dueAt = now()) {
    const execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: requestKey(request) }, transaction });
    if (!execution || execution.status !== 'waiting') return;
    await execution.update({ wait_until: dueAt }, { transaction });
    if (deps.wake) await deps.wake(execution, transaction);
    if (deps.enqueueJob) await deps.enqueueJob({ type: 'automations_v2_execute',
      payload: { execution_id: execution.id, __runtime_namespace: execution.waiting_meta?.runtime_namespace
        || execution.context?.mobile_verification?.runtime_namespace }, priority: 'high', status: 'pending', origin: 'patient_mobile_verification',
      nextRunAt: dueAt, dedupeScope: `flow_execution:${execution.id}`, requestedBy: request.actor_user_id, requestedByRole: 'system' }, { transaction });
  }
  async function withNotification({ execution, node }, createNotification) {
    const request = await fromExecution(execution);
    return db.sequelize.transaction(async transaction => {
      const patient = await lockPatient(request, transaction), snapshot = await state(request, transaction);
      if (!await current(request, patient, transaction) || !snapshot.current || snapshot.state !== 'review_required'
        || snapshot.manually_resolved || snapshot.provenance === 'manual_review') {
        return { kind: 'success', output: { status: 'review_not_required', notifications_created: 0 }, next_node_id: node.outputs?.on_success || null };
      }
      return createNotification({ request, snapshot, transaction });
    });
  }
  async function localTemplate(clinicId, transaction) {
    const rows = await db.AutomationFlowTemplateV2.findAll({ where: { clinic_id: clinicId, trigger_type: C.REQUEST,
      is_active: true, is_system: false, published_at: { [Op.ne]: null } }, order: [['version', 'DESC']], limit: 2, transaction });
    if (rows.length !== 1 || !C.configValid(rows[0].trigger_config) || !C.graphValid(rows[0].nodes)) return null;
    return rows[0];
  }

  async function invalidateForPhoneChange({ patientId, actorId, previousPhone, nextPhone, transaction }) {
    if (C.phone(previousPhone) === C.phone(nextPhone)) return { invalidated: false };
    const request = await latest(patientId, transaction);
    if (!request) return { invalidated: false };
    const previous = await state(request, transaction);
    if (!previous.current) return { invalidated: false };
    // A generic master edit does not request another verification. It only
    // retires existing evidence, so A -> B -> A cannot revive an old reply.
    await transition(request, previous, { current: false, reason: 'phone_changed', provenance: 'manual_review',
      actor_user_id: actorId, resolved_at: now().toISOString() }, transaction, true);
    await closeTasks(request, transaction, 'superseded');
    await wake(request, transaction);
    return { invalidated: true, request_event_id: Number(request.id) };
  }
  // Only explicit reception acceptance/correction calls this producer. There
  // is deliberately no scan for historical requests or generic phone changes.
  async function recordRequest(values, { transaction }) {
    const previous = await latest(values.patient_id, transaction);
    if (previous) {
      const old = await state(previous, transaction);
      if (old.current) {
        await transition(previous, old, { current: false, reason: 'phone_corrected', provenance: 'manual_review',
          actor_user_id: values.actor_user_id, resolved_at: now().toISOString() }, transaction, true);
        await closeTasks(previous, transaction, 'superseded');
        await wake(previous, transaction);
      }
    }
    const template = enabled() ? await localTemplate(values.clinic_id, transaction) : null;
    const permitted = !!template && rawTime(template.trigger_config.enabled_after) <= +now()
      && rawTime(values.occurred_at || now()) >= rawTime(template.trigger_config.enabled_after)
      && (!deps.deliveryReady || await deps.deliveryReady(values.clinic_id, transaction));
    const request = await events.create({ ...values, event_type: C.REQUEST, metadata: { ...values.metadata,
      schema_version: C.SCHEMA, phone: C.phone(values.metadata.phone), state: 'pending', delivery_enabled: permitted,
      reply_token: randomBytes(18).toString('hex'),
      template_version_id: permitted ? template.id : null,
      response_timeout_minutes: permitted ? template.trigger_config.response_timeout_minutes : null,
    } }, { transaction });
    if (permitted) await deps.enqueueJob({ type: 'patient_mobile_verification_dispatch',
      payload: { request_event_id: Number(request.id), clinic_id: request.clinic_id }, priority: 'high',
      status: 'pending', origin: 'patient_mobile_verification', dedupeScope: requestKey(request),
      requestedBy: values.actor_user_id, requestedByRole: 'system' }, { transaction });
    return request;
  }

  async function dispatch({ request_event_id: eventId, clinic_id: clinicId }) {
    const request = await events.findByPk(C.id(eventId));
    if (!request || request.event_type !== C.REQUEST || Number(request.clinic_id) !== Number(clinicId)
      || !enabled() || request.metadata?.delivery_enabled !== true) return { status: 'completed', result: { skipped: true, reason: 'delivery_disabled' } };
    const patient = await db.Paciente.findByPk(request.patient_id);
    if (!patient || !await current(request, patient)) return { status: 'completed', result: { skipped: true, reason: 'superseded' } };
    const template = await db.AutomationFlowTemplateV2.findByPk(request.metadata.template_version_id);
    if (!template?.is_active || template.is_system || template.trigger_type !== C.REQUEST || !C.graphValid(template.nodes)
      || Number(template.clinic_id) !== Number(request.clinic_id) || !template.published_at
      || !C.configValid(template.trigger_config) || rawTime(request.occurred_at) < rawTime(template.trigger_config.enabled_after)) {
      return { status: 'completed', result: { skipped: true, reason: 'automation_unconfigured_or_inactive' } };
    }
    let execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: requestKey(request) } });
    if (!execution) {
      try { execution = await deps.stop.createExecution({ idempotency_key: requestKey(request), template_version_id: template.id,
        engine_version: 'v2', status: 'running', current_node_id: template.entry_node_id, created_by: request.actor_user_id,
        trigger_type: C.REQUEST, trigger_entity_type: 'patient_operational_event', trigger_entity_id: Number(request.id),
        clinic_id: request.clinic_id, group_id: null, context: { trigger: { type: C.REQUEST,
          data: { request_event_id: Number(request.id), patient_id: request.patient_id, clinic_id: request.clinic_id,
            phone: request.metadata.phone, response_timeout_minutes: request.metadata.response_timeout_minutes } } } }); }
      catch (error) {
        if (deps.stop.isStop(error)) return { status: 'completed', result: { skipped: true, reason: 'automation_inactive' } };
        if (error.name !== 'SequelizeUniqueConstraintError') throw error;
        execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: requestKey(request) } });
        if (!execution) throw error;
      }
    }
    await db.sequelize.transaction(async transaction => {
      const locked = await db.FlowExecutionV2.findByPk(execution.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (['running', 'waiting'].includes(locked.status)) await deps.enqueueJob({ type: 'automations_v2_execute',
        payload: { execution_id: execution.id }, priority: 'high', status: 'pending', origin: 'patient_mobile_verification',
        dedupeScope: `flow_execution:${execution.id}`, requestedBy: request.actor_user_id, requestedByRole: 'system' }, { transaction });
    });
    return { status: 'completed', result: { execution_id: execution.id } };
  }
  async function fromExecution(execution) {
    if (execution?.trigger_type !== C.REQUEST || execution.trigger_entity_type !== 'patient_operational_event') throw fail('mobile_verification_execution_scope');
    const request = await events.findByPk(C.id(execution.trigger_entity_id));
    if (!request || request.event_type !== C.REQUEST || Number(execution.clinic_id) !== Number(request.clinic_id)
      || Number(execution.template_version_id) !== Number(request.metadata?.template_version_id)
      || Number(execution.context?.trigger?.data?.request_event_id) !== Number(request.id)) throw fail('mobile_verification_execution_scope');
    return request;
  }
  async function communicationAllowed(request) {
    await deps.authorizeActor(request);
    if (await deps.patientHeld(request.patient_id)) throw fail('mobile_verification_patient_held');
    await deps.communicationAllowed({ clinicId: request.clinic_id, patientId: request.patient_id,
      phone: request.metadata.phone, scope: 'care' });
  }
  async function messageFor(request) {
    return db.Message.findOne({ where: { automation_delivery_key: `mobile-verification:${request.id}:outbound` } });
  }
  async function sendPreflight({ execution }) {
    const request = await fromExecution(execution), patient = await db.Paciente.findByPk(request.patient_id);
    const snapshot = await state(request);
    if (!enabled() || request.metadata.delivery_enabled !== true || !C.timeout(request.metadata.response_timeout_minutes)
      || !patient || !await current(request, patient) || !snapshot.current || snapshot.state !== 'pending'
      || snapshot.provenance === 'manual_review') return { suppressed: true };
    if (deps.deliveryReady && !await deps.deliveryReady(request.clinic_id)) {
      const accepted = await messageFor(request);
      // Re-entering N2 after provider acceptance only reuses its receipt. A
      // later loss of availability must not discard the existing response wait.
      if (!accepted?.metadata?.wamid || !Number.isFinite(rawTime(accepted.metadata.provider_acceptance_at))) {
        throw fail('mobile_verification_communication_blocked');
      }
    }
    await communicationAllowed(request);
    const candidates = await db.Conversation.findAll({ where: { clinic_id: request.clinic_id, channel: 'whatsapp',
      contact_id: { [Op.in]: require('../lib/phone').getPhoneIdentityCandidates(request.metadata.phone) } }, limit: 3 });
    if (candidates.length > 1 || candidates.some(c => Number(c.patient_id) !== Number(request.patient_id) || c.lead_id)) {
      throw fail('mobile_verification_conversation_conflict');
    }
    return { request, delivery_key: `mobile-verification:${request.id}`, recipient: C.phone(request.metadata.phone) };
  }
  async function sendEnvelope({ request, template, templateParams, sender, conversation, recipient }) {
    const storedTemplate = template?.id ? await db.WhatsappTemplate.findByPk(template.id) : null;
    if (!C.templateValid(storedTemplate) || String(storedTemplate.waba_id) !== String(sender.wabaId)) throw fail('mobile_verification_template_unavailable');
    if (Number(conversation?.clinic_id) !== Number(request.clinic_id) || Number(conversation?.patient_id) !== Number(request.patient_id)
      || conversation?.lead_id || C.phone(conversation?.contact_id) !== C.phone(request.metadata.phone)
      || C.phone(recipient) !== C.phone(request.metadata.phone)) throw fail('mobile_verification_recipient_mismatch');
    const token = request.metadata.reply_token;
    if (!/^[a-f0-9]{36}$/.test(token || '')) throw fail('mobile_verification_source_changed');
    return { metadata: { kind: 'patient_mobile_verification', mobile_verification_request_id: Number(request.id) },
      template_components: [{ type: 'body', parameters: [{ type: 'text', text: String(templateParams[1] || '') }] },
        ...['yes', 'no'].map((answer, index) => ({ type: 'button', sub_type: 'quick_reply', index: String(index),
          parameters: [{ type: 'payload', payload: `pmv:${request.id}:${token}:${answer}` }] }))] };
  }
  async function authorizeTransport({ message, to, sender, useTemplate, templateName, templateLanguage, templateComponents }) {
    const requestId = C.id(message.metadata?.mobile_verification_request_id);
    if (!requestId) return message.metadata?.kind === 'patient_mobile_verification'
      || Object.hasOwn(message.metadata || {}, 'mobile_verification_request_id')
      ? { allowed: false, reason: 'mobile_verification_recipient_mismatch' } : { allowed: true };
    const deny = reason => ({ allowed: false, reason });
    if (!enabled()) return deny('mobile_verification_delivery_disabled');
    const execution = await db.FlowExecutionV2.findByPk(message.metadata.execution_id);
    const request = execution && await fromExecution(execution);
    if (!request || Number(request.id) !== requestId || request.metadata.delivery_enabled !== true
      || message.automation_delivery_key !== `mobile-verification:${requestId}:outbound`
      || C.phone(to) !== C.phone(request.metadata.phone) || !useTemplate) return deny('mobile_verification_recipient_mismatch');
    if (deps.deliveryReady && !await deps.deliveryReady(request.clinic_id)) return deny('mobile_verification_delivery_unavailable');
    const patient = await db.Paciente.findByPk(request.patient_id), snapshot = await state(request);
    if (!patient || !await current(request, patient) || !snapshot.current || snapshot.state !== 'pending'
      || snapshot.provenance === 'manual_review') return deny('mobile_verification_superseded');
    const conversation = await db.Conversation.findByPk(message.conversation_id);
    if (!conversation || Number(conversation.clinic_id) !== Number(request.clinic_id)
      || Number(conversation.patient_id) !== Number(request.patient_id) || C.phone(conversation.contact_id) !== C.phone(to)
      || conversation.lead_id || String(sender.phoneNumberId) !== String(message.metadata.phoneNumberId)
      || String(sender.wabaId) !== String(message.metadata.wabaId)) return deny('mobile_verification_scope_mismatch');
    const template = await db.WhatsappTemplate.findByPk(message.metadata.template_id);
    if (!C.templateValid(template) || String(template.waba_id) !== String(sender.wabaId)
      || templateName !== template.name || templateLanguage !== template.language
      || JSON.stringify(templateComponents) !== JSON.stringify(message.metadata.template_components)) return deny('mobile_verification_template_unavailable');
    try { await communicationAllowed(request); } catch { return deny('mobile_verification_communication_blocked'); }
    const quiet = deps.engine.computeQuietHoursDelayMs({ now: now(), enabled: true });
    if (quiet.delayMs > 0) return { allowed: true, deferredUntil: quiet.scheduledAt };
    return { allowed: true };
  }
  async function delivery(request) {
    const message = await messageFor(request), m = message?.metadata || {};
    const acceptedAt = rawTime(m.provider_acceptance_at);
    const held = m.provider_acceptance_status === 'held_for_quality_assessment' && !['sent', 'delivered', 'read'].includes(message?.status);
    const expired = +now() - rawTime(message?.createdAt || message?.created_at) >= 86400000;
    if (!message || message.status === 'failed' || m.cancelled || expired && (!Number.isFinite(acceptedAt) || !m.wamid || held)) {
      return { status: 'delivery_failed', delivery_status: m.delivery_unknown ? 'unknown' : held ? 'held' : 'not_sent', message };
    }
    if (!Number.isFinite(acceptedAt) || !m.wamid || held) return { status: 'awaiting_transport', message };
    const deadline = new Date(acceptedAt + C.timeout(request.metadata.response_timeout_minutes) * 60000);
    return { status: +now() >= +deadline ? 'timed_out' : 'awaiting_response', delivery_status: 'accepted', message,
      accepted_at: new Date(acceptedAt).toISOString(), deadline_at: deadline.toISOString() };
  }
  async function waitContext({ execution, timeoutMinutes }) {
    const request = await fromExecution(execution), patient = await db.Paciente.findByPk(request.patient_id);
    const snapshot = await state(request);
    if (!patient || !await current(request, patient) || !snapshot.current || snapshot.manually_resolved
      || snapshot.provenance === 'manual_review' || snapshot.state === 'confirmed'
      || snapshot.state === 'review_required' && snapshot.reason !== 'no_response') return { status: 'superseded' };
    if (C.timeout(timeoutMinutes) !== C.timeout(request.metadata.response_timeout_minutes) || !C.timeout(timeoutMinutes)) {
      throw fail('mobile_verification_timeout_invalid');
    }
    const fresh = await db.FlowExecutionV2.findByPk(execution.id);
    const reply = fresh?.context?.mobile_verification || {};
    if (reply.response_message_id && !snapshot.history.some(e => e.inbound_message_id === Number(reply.response_message_id))) {
      if (rawTime(reply.response_buffer_until) > +now()) return { status: 'buffering', reply, wait_until: new Date(reply.response_buffer_until) };
      return { status: 'responded', reply };
    }
    const transport = await delivery(request);
    return { ...transport, wait_until: transport.status === 'awaiting_transport' ? new Date(+now() + 60000)
      : transport.status === 'awaiting_response' ? new Date(transport.deadline_at) : null };
  }
  async function replyProof(request, outbound, message, conversation) {
    const m = message?.metadata || {}, payload = m.button?.payload || m.interactive?.button_reply?.id || '';
    const match = /^pmv:([1-9]\d*):([a-f0-9]{36}):(yes|no)$/.exec(payload);
    const inboundAt = rawTime(message?.sent_at || message?.createdAt);
    if (!message || message.direction !== 'inbound' || conversation?.channel !== 'whatsapp'
      || Number(message.conversation_id) !== Number(conversation.id)
      || Number(conversation.clinic_id) !== Number(request.clinic_id) || Number(conversation.patient_id) !== Number(request.patient_id)
      || conversation.lead_id || C.phone(conversation.contact_id) !== C.phone(request.metadata.phone)
      || m.historical !== false || m.recovery_without_automation === true || m.media_recovered_without_automation === true
      || m.automatic_actions_allowed !== true || !m.inbox_receipt || !m.fresh_inbound_dispatched_at
      || !outbound || outbound.automation_delivery_key !== `mobile-verification:${request.id}:outbound`
      || Number(outbound.metadata?.mobile_verification_request_id) !== Number(request.id)
      || Number(outbound.conversation_id) !== Number(conversation.id) || !outbound.metadata?.wamid
      || String(m.phone_number_id || m.phoneNumberId || '') !== String(outbound.metadata.phoneNumberId)
      || String(m.waba_id || m.wabaId || '') !== String(outbound.metadata.wabaId)
      || !Number.isFinite(rawTime(outbound.metadata.provider_acceptance_at)) || !Number.isFinite(inboundAt)
      || inboundAt > +now() + 60000 || inboundAt < rawTime(outbound.metadata.provider_acceptance_at)
      || m.context?.id && m.context.id !== outbound.metadata.wamid
      || payload.startsWith('pmv:') && (!match || Number(match[1]) !== Number(request.id) || match[2] !== request.metadata.reply_token)) return null;
    if (!m.context?.id && !match) {
      const last = await db.Message.findOne({ where: { conversation_id: conversation.id, direction: 'outbound', message_type: { [Op.ne]: 'event' } }, order: [['id', 'DESC']] });
      if (Number(last?.id) !== Number(outbound.id)) return null;
    }
    return { reply_answer: match?.[3] || null, response_text: String(message.content || ''), response_message_id: Number(message.id) };
  }
  async function replyBatch(request, outbound, ids, conversation, transaction) {
    const rows = await db.Message.findAll({ where: { id: { [Op.in]: ids }, conversation_id: conversation.id, direction: 'inbound' },
      order: [['sent_at', 'ASC'], ['createdAt', 'ASC'], ['id', 'ASC']], transaction });
    if (rows.length !== ids.length) return null;
    const proofs = [];
    for (const message of rows) {
      if (require('../lib/automation-conversation-context').isRevokedMessage(message)) return null;
      const proof = await replyProof(request, outbound, message, conversation);
      if (!proof) return null;
      proofs.push(proof);
    }
    const last = proofs.at(-1), answer = proofs[0]?.reply_answer;
    const messageIds = proofs.map(p => p.response_message_id);
    return { ...last, reply_answer: answer && proofs.every(p => p.reply_answer === answer) ? answer : null,
      response_text: proofs.map(p => p.response_text).join('\n'), response_message_ids: messageIds,
      response_version: messageIds.join(':') };
  }
  async function resolveAction({ execution, node, context = {} }) {
    const done = (key, output) => ({ kind: 'success', output, context_patch: { mobile_verification: output }, next_node_id: node.outputs?.[key] || null });
    const result = node.config?.result, reason = node.config?.reason || null;
    if (!['confirmed', 'review_required'].includes(result) || result === 'confirmed' && reason
      || result === 'review_required' && !['patient_rejected', 'response_unclear', 'no_response', 'delivery_failed'].includes(reason)) throw fail('mobile_verification_result_invalid');
    if (context.__simulation) return done('on_success', { simulated: true, no_send: true });
    const request = await fromExecution(execution);
    return db.sequelize.transaction(async transaction => {
      const patient = await lockPatient(request, transaction), previous = await state(request, transaction);
      if (!await current(request, patient, transaction) || !previous.current || previous.manually_resolved
        || previous.provenance === 'manual_review' || previous.state === 'confirmed' && result !== 'confirmed'
        || previous.state === 'review_required' && previous.reason !== 'no_response' && (result !== previous.state || reason !== previous.reason)) {
        return done('on_fail', { applied: false, reason: 'source_changed' });
      }
      const fresh = await db.FlowExecutionV2.findByPk(execution.id, { transaction, lock: transaction.LOCK.UPDATE });
      const reply = fresh.context?.mobile_verification || {};
      const retryReply = () => ({ kind: 'success', output: { applied: false, reason: 'response_changed' },
        next_node_id: reply.wait_node_id || node.outputs?.on_fail || null });
      if (C.id(context.mobile_verification?.response_message_id) !== C.id(reply.response_message_id)
        || context.mobile_verification?.response_version !== reply.response_version) {
        return retryReply();
      }
      if (rawTime(reply.response_buffer_until) > +now()) return retryReply();
      if (previous.state === result && previous.reason === reason) return done('on_success', { applied: false, result, reason, reason_text: C.reasons[reason] || null });
      const transport = await delivery(request);
      let proof;
      if (result === 'confirmed' || ['patient_rejected', 'response_unclear'].includes(reason)) {
        const message = reply.response_message_id ? await db.Message.findByPk(reply.response_message_id, { transaction }) : null;
        const conversation = message ? await db.Conversation.findByPk(message.conversation_id, { transaction }) : null;
        proof = conversation ? await replyBatch(request, transport.message, reply.response_message_ids || [], conversation, transaction) : null;
        if (!proof || proof.response_text !== reply.response_text || proof.reply_answer !== reply.reply_answer) return done('on_fail', { applied: false, reason: 'reply_not_correlated' });
        const intent = result === 'confirmed' ? 'correct' : 'incorrect';
        const aiProof = (execution.templateVersion?.nodes || (await db.AutomationFlowTemplateV2.findByPk(execution.template_version_id, { transaction })).nodes)
          .filter(n => n.type === 'condition/ai_analysis' && n.config?.preset_key === C.AI_PRESET)
          .some(n => {
            const output = context.outputs?.[n.id], evidence = typeof output?.evidence === 'string' ? output.evidence.trim() : '';
            return output?._mobile_verification_response_version === proof.response_version && output.intent === intent
              && typeof output.confidence === 'number' && output.confidence >= 0.9 && output.confidence <= 1
              && output.unequivocal === true && !!evidence && proof.response_text.includes(evidence);
          });
        if (reason !== 'response_unclear' && !(proof.reply_answer === (intent === 'correct' ? 'yes' : 'no') || !proof.reply_answer && aiProof)) {
          return done('on_fail', { applied: false, reason: 'reply_proof_required' });
        }
      } else if (reason === 'no_response') {
        if (reply.response_message_id) return retryReply();
        if (transport.status !== 'timed_out') return done('on_fail', { applied: false, reason: 'deadline_not_elapsed' });
      } else {
        const template = execution.templateVersion || await db.AutomationFlowTemplateV2.findByPk(execution.template_version_id, { transaction });
        const sendIds = template.nodes.filter(n => n.type === 'action/send_whatsapp').map(n => n.id);
        const failedSend = await db.FlowExecutionLogV2.findOne({ where: { flow_execution_id: execution.id, node_id: { [Op.in]: sendIds }, status: 'error' }, transaction });
        if (transport.status !== 'delivery_failed' || !transport.message && !failedSend) return done('on_fail', { applied: false, reason: 'delivery_failure_required' });
      }
      const updated = await transition(request, previous, { state: result, reason, provenance: proof ? 'patient_reply' : 'automation',
        actor_user_id: null,
        inbound_message_id: proof?.response_message_id || null, resolved_at: now().toISOString(),
        accepted_at: transport.message?.metadata?.provider_acceptance_at || null, delivery_status: transport.delivery_status || 'accepted' }, transaction, true);
      if (result === 'confirmed') await closeTasks(request, transaction, 'patient_confirmed');
      return done('on_success', { applied: true, result, reason, reason_text: C.reasons[reason] || null, revision: updated.revision });
    });
  }

  async function attestAnalysis({ execution, context, sourceEntries, resolvedSources }) {
    const request = await fromExecution(execution), outbound = await messageFor(request);
    const fresh = await db.FlowExecutionV2.findByPk(execution.id), reply = fresh?.context?.mobile_verification;
    const paths = sourceEntries.map(s => typeof s.path === 'string' ? s.path.replace(/\s+/g, '') : '');
    if (!outbound || !reply?.response_version || context.mobile_verification?.response_version !== reply.response_version
      || sourceEntries.length !== 2 || resolvedSources.length !== 2
      || !paths.includes('{{last_prompt}}') || !paths.includes('{{mobile_verification.response_text}}')) return null;
    const question = resolvedSources[paths.indexOf('{{last_prompt}}')]?.value;
    const response = resolvedSources[paths.indexOf('{{mobile_verification.response_text}}')]?.value;
    const conversation = await db.Conversation.findByPk(outbound.conversation_id);
    const batch = await replyBatch(request, outbound, reply.response_message_ids || [], conversation);
    if (!batch || question !== outbound.content || response !== batch.response_text || response !== reply.response_text
      || batch.response_version !== reply.response_version) return null;
    return reply.response_version;
  }

  async function inbound({ message, conversation }) {
    const m = message.metadata || {}, payload = m.button?.payload || m.interactive?.button_reply?.id || '';
    const match = /^pmv:([1-9]\d*):([a-f0-9]{36}):(yes|no)$/.exec(payload);
    let outbound = null;
    const implicit = !m.context?.id && !payload.startsWith('pmv:');
    if (m.context?.id) outbound = await db.Message.findOne({ where: { conversation_id: conversation.id, direction: 'outbound',
      [Op.and]: db.Sequelize.where(db.Sequelize.literal("JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wamid'))"), m.context.id) } });
    if (!m.context?.id && !match && enabled()) {
      const last = await db.Message.findOne({ where: { conversation_id: conversation.id, direction: 'outbound', message_type: { [Op.ne]: 'event' } }, order: [['id', 'DESC']] });
      if (last?.metadata?.mobile_verification_request_id) outbound = last;
    }
    const requestId = C.id(match?.[1] || outbound?.metadata?.mobile_verification_request_id);
    if (!requestId && !payload.startsWith('pmv:')) return { handled: false };
    // Claim even stale verification replies: they must never fall through to
    // appointment confirmation, lead intent or commercial opt-out handling.
    const ignored = reason => ({ handled: true, ignored: true, reason });
    const request = requestId ? await events.findByPk(requestId) : null;
    if (implicit && request) {
      const snapshot = await state(request);
      if (!snapshot.current || snapshot.manually_resolved || snapshot.state === 'confirmed'
        || snapshot.state === 'review_required' && snapshot.reason !== 'no_response') return { handled: false };
    }
    if (!request || request.metadata?.delivery_enabled !== true) return ignored('scope_mismatch');
    outbound = outbound || await messageFor(request);
    const proof = await replyProof(request, outbound, message, conversation);
    if (!proof) return ignored('reply_not_correlated');
    return db.sequelize.transaction(async transaction => {
      const patient = await lockPatient(request, transaction), previous = await state(request, transaction);
      if (!await current(request, patient, transaction) || !previous.current || previous.manually_resolved
        || previous.provenance === 'manual_review' || previous.state === 'confirmed') return ignored('resolved_or_superseded');
      if (previous.history.some(e => e.inbound_message_id === Number(message.id))) return ignored('duplicate');
      if (previous.state === 'review_required' && previous.reason !== 'no_response') return ignored('review_already_requested');
      const execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: requestKey(request) }, transaction, lock: transaction.LOCK.UPDATE });
      if (!execution || ['cancelled', 'failed'].includes(execution.status)) return ignored('execution_not_available');
      const template = await db.AutomationFlowTemplateV2.findByPk(execution.template_version_id, { transaction });
      const waits = template.nodes.filter(n => n.type === 'delay/wait_response'
        && (n.id === execution.context?.mobile_verification?.wait_node_id || n.config.listens_to_node_id === outbound.metadata.node_id));
      const wait = waits.find(n => n.id === execution.context?.mobile_verification?.wait_node_id) || (waits.length === 1 ? waits[0] : null);
      if (!wait) return ignored('wait_not_available');
      const previousReply = execution.context?.mobile_verification || {};
      const seen = previousReply.response_message_ids || [];
      if (seen.includes(Number(message.id))) return ignored('duplicate');
      const batch = await replyBatch(request, outbound, [...seen, Number(message.id)], conversation, transaction);
      if (!batch) return ignored('reply_batch_invalid');
      const firstAt = rawTime(previousReply.first_response_at) || +now();
      const delayMs = Number(wait.config.response_buffer_delay_ms ?? Number(wait.config.response_buffer_delay_seconds ?? 90) * 1000);
      const bufferUntil = wait.config.response_buffer_enabled !== false && !batch.reply_answer
        ? new Date(Math.min(+now() + (Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 90000), firstAt + 300000)) : now();
      const context = { ...execution.context, mobile_verification: { ...previousReply, ...batch,
        first_response_at: new Date(firstAt).toISOString(), response_buffer_until: bufferUntil.toISOString(),
        request_event_id: requestId, wait_node_id: wait.id,
        reason: null, reason_text: null } };
      // A late reply re-enters its native wait; only graph traversal may resolve it.
      const rearm = execution.status === 'completed' || execution.status === 'waiting';
      await execution.update({ context, ...(rearm ? { status: 'waiting', current_node_id: wait.id, wait_until: bufferUntil,
        waiting_meta: { type: 'delay/wait_response', resume_mode: 'retry_current_node', mobile_verification_protocol: true,
          runtime_namespace: execution.waiting_meta?.runtime_namespace || previousReply.runtime_namespace,
          listens_to_node_id: wait.config.listens_to_node_id } } : {}) }, { transaction });
      await wake(request, transaction, bufferUntil);
      return { handled: true, request_event_id: requestId, correlated: true };
    });
  }
  async function view({ patientId, clinicId, transaction }) {
    const requests = await events.findAll({ where: { patient_id: patientId, clinic_id: clinicId, event_type: C.REQUEST }, order: [['id', 'DESC']], limit: 30, transaction });
    const patient = await db.Paciente.findByPk(patientId, { transaction });
    const items = [];
    for (const request of requests) {
      const snapshot = await state(request, transaction);
      items.push({ ...snapshot, current: snapshot.current && !!patient && await current(request, patient, transaction) });
    }
    return { items };
  }
  async function manual({ patientId, clinicId, actorId, payload, transaction, authorizeCurrent }) {
    if (!payload || !['confirm', 'correct', 'pending'].includes(payload.action) || !C.id(payload.request_event_id)
      || !C.id(payload.revision) || Object.keys(payload).some(k => !['clinic_id', 'request_event_id', 'revision', 'action', 'phone', 'acknowledged'].includes(k))) throw fail('mobile_verification_payload_invalid', 400);
    const request = await events.findByPk(payload.request_event_id, { transaction });
    if (!request || request.event_type !== C.REQUEST || Number(request.patient_id) !== Number(patientId)
      || Number(request.clinic_id) !== Number(clinicId)) throw fail('mobile_verification_not_found', 404);
    if (payload.action === 'correct') {
      for (const clinic of await deps.groupClinicIds(db, clinicId, transaction)) {
        await db.Clinica.findByPk(clinic, { transaction, lock: transaction.LOCK.UPDATE });
      }
    }
    const patient = await lockPatient(request, transaction), previous = await state(request, transaction);
    await authorizeCurrent(patient);
    if (!await current(request, patient, transaction) || !previous.current || previous.revision !== Number(payload.revision)) throw fail('mobile_verification_changed');
    if (payload.action === 'correct') {
      const next = C.phone(payload.phone);
      if (!next || next === C.phone(request.metadata.phone) || payload.acknowledged !== true) throw fail('mobile_verification_phone_invalid', 400);
      await deps.checkCorrection({ db, patient: plain(patient), patch: { telefono_movil: next }, clinicIds: await deps.groupClinicIds(db, clinicId, transaction), transaction, allowExistingPatientChat: true });
      const previousPhone = patient.telefono_movil;
      await patient.update({ telefono_movil: next }, { transaction });
      const created = await recordRequest({ patient_id: patientId, clinic_id: clinicId, actor_user_id: actorId,
        source: 'reception_mobile_verification', channel: 'internal', metadata: { schema_version: C.SCHEMA,
          document_id: request.metadata.document_id, snapshot_hash: request.metadata.snapshot_hash,
          previous_phone: previousPhone, phone: next, corrected_request_event_id: Number(request.id) } }, { transaction });
      return { corrected: true, request_event_id: Number(created.id) };
    }
    if (previous.manually_resolved || previous.state === 'confirmed') return { unchanged: true };
    await transition(request, previous, { state: payload.action === 'confirm' ? 'confirmed' : previous.state,
      reason: payload.action === 'confirm' ? null : previous.reason,
      provenance: payload.action === 'confirm' ? 'manual_review' : 'manual_pending', actor_user_id: actorId,
      manually_resolved: payload.action === 'confirm', resolved_at: payload.action === 'confirm' ? now().toISOString() : previous.resolved_at }, transaction, payload.action === 'confirm');
    if (payload.action === 'confirm') await closeTasks(request, transaction, 'manual_confirmed');
    await wake(request, transaction);
    return { confirmed: payload.action === 'confirm', pending: payload.action === 'pending' };
  }
  return { recordRequest, invalidateForPhoneChange, dispatch, sendPreflight, sendEnvelope, waitContext, resolveAction, attestAnalysis, withNotification,
    authorizeTransport, inbound, view, manual, state, current };
}
function originRuntime(db) {
  return createRuntime({ db,
    deliveryReady: (clinicId, transaction) => require('./patientMobileVerificationLifecycle.service').current()
      .inspect(clinicId, { transaction }).then(state => state.ready && state.status === 'active'),
    enqueueJob: (...args) => require('./jobRequests.service').enqueueUniqueJobRequest(...args),
    wake: (execution, transaction) => wakeNativeJob(db, execution, transaction),
    notificationUpdated: notification => require('./notificationsRealtime.service').emitNotificationUpdated(notification),
  });
}
// Existing generic reception editors need invalidation, not a second producer.
// Keep their mobile write and retirement of the old verification atomic. Empty
// or equivalent-phone edits retain their ordinary save path and never emit work.
async function withPatientMobileChange({ db, patientId, clinicId, nextClinicId = clinicId,
  previousPhone, nextPhone, actorId, authorizeCurrent }, save) {
  if (C.phone(previousPhone) === C.phone(nextPhone)) return save();
  return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const clinicIds = new Set();
    for (const id of new Set([Number(clinicId), Number(nextClinicId)])) {
      for (const groupId of await require('./patientPrivacyProfile.service').groupClinicIds(db, id, transaction)) clinicIds.add(groupId);
    }
    for (const id of [...clinicIds].sort((a, b) => a - b)) {
      await db.Clinica.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    }
    const patient = await db.Paciente.findByPk(patientId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!patient || Number(patient.clinica_id) !== Number(clinicId)
      || C.phone(patient.telefono_movil) !== C.phone(previousPhone)) throw fail('mobile_verification_changed');
    if (authorizeCurrent) await authorizeCurrent(patient);
    const result = await save(transaction);
    await originRuntime(db).invalidateForPhoneChange({ patientId, actorId, previousPhone, nextPhone, transaction });
    return result;
  }).catch(error => {
    if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.original?.code || error.parent?.code || error.code)) {
      throw fail('mobile_verification_changed');
    }
    throw error;
  });
}

let runtime;
async function wakeNativeJob(db, execution, transaction) {
  await db.sequelize.query("UPDATE JobRequests SET next_run_at=:dueAt WHERE type='automations_v2_execute' AND status IN ('pending','waiting') AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.execution_id'))=:execution AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.__runtime_namespace'))=:namespace", {
    replacements: { execution: String(execution.id), dueAt: execution.wait_until || new Date(), namespace: execution.waiting_meta?.runtime_namespace
      || execution.context?.mobile_verification?.runtime_namespace || require('./jobRequests.service').getCurrentRuntimeNamespace() }, transaction });
}
function current() {
  if (!runtime) {
    const db = require('../../models');
    runtime = createRuntime({ db, engine: require('./flowEngineV2.service'), stop: require('../lib/automation-runtime-stop'),
      deliveryReady: (clinicId, transaction) => require('./patientMobileVerificationLifecycle.service').current()
        .inspect(clinicId, { transaction }).then(state => state.ready && state.status === 'active'),
      enqueueJob: require('./jobRequests.service').enqueueUniqueJobRequest,
      wake: (execution, transaction) => wakeNativeJob(db, execution, transaction),
      communicationAllowed: require('./marketingOptOut.service').assertAutomationCommunicationAllowed,
      patientHeld: id => require('../lib/whatsappAppointmentEligibility').patientImportHeld(id, db),
      authorizeActor: async request => {
        await require('../lib/access-policy').assertUserCanAccessFeature({ actorId: request.actor_user_id, clinicId: request.clinic_id, featureKey: 'patients.edit' });
      },
      groupClinicIds: require('./patientPrivacyProfile.service').groupClinicIds,
      checkCorrection: require('./patientPrivacyProfile.service').checkContactCollisions,
      notificationCreated: require('./notificationsRealtime.service').emitNotificationCreated,
      notificationUpdated: require('./notificationsRealtime.service').emitNotificationUpdated,
      assignees: async clinicId => {
        const engine = require('./flowEngineV2.service');
        const reception = await engine._resolveTaskAssigneeUserIds({ clinicId, assigneeType: 'role', assigneeId: 'recepcion', subrole: 'recepcion' });
        return reception.length ? reception : engine._resolveTaskAssigneeUserIds({ clinicId, assigneeType: 'role', assigneeId: 'admin', roleCode: 'admin' });
      },
    });
  }
  return runtime;
}
module.exports = { createRuntime, current, withPatientMobileChange,
  recordRequest: ({ db, ...values }, options) => originRuntime(db).recordRequest(values, options),
};

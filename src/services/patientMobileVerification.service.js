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
      event: 'patient.mobile_verification_review',
      [Op.and]: db.Sequelize.where(db.Sequelize.literal("JSON_UNQUOTE(JSON_EXTRACT(data,'$.request_event_id'))"), String(request.id)) }, transaction });
    for (const notification of notifications) {
      await notification.update({ isRead: true, readAt: now(),
        data: { ...notification.data, resolved: true, resolution: reason, resolvedAt: now().toISOString(), requiresAcknowledgement: false } }, { transaction });
      if (deps.notificationUpdated) transaction.afterCommit(() => deps.notificationUpdated(notification));
    }
  }
  async function wake(request, transaction) {
    const execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: requestKey(request) }, transaction });
    if (!execution || execution.status !== 'waiting') return;
    await execution.update({ wait_until: now() }, { transaction });
    if (deps.wake) await deps.wake(execution, transaction);
  }
  async function notify(request, snapshot, transaction, patient) {
    let recipients = await deps.assignees(request.clinic_id, transaction);
    if (!recipients.length) recipients = [request.actor_user_id];
    for (const userId of [...new Set(recipients.map(C.id).filter(Boolean))]) {
      const dedupeKey = `patient-mobile-verification:${request.id}:${userId}`;
      const patientName = [patient?.nombre, patient?.apellidos].filter(Boolean).join(' ').trim() || `Paciente #${request.patient_id}`;
      const message = C.reasons[snapshot.reason] || 'Verificación del móvil pendiente';
      const [notification, created] = await db.Notification.findOrCreate({ where: { dedupeKey }, defaults: {
        userId, clinicaId: request.clinic_id, category: 'general', event: 'patient.mobile_verification_review',
        title: `Revisar móvil: ${patientName}`.slice(0, 255), message,
        level: 'warning', icon: 'heroicons_outline:device-phone-mobile', dedupeKey,
        data: { source: 'automations_v2', patientId: request.patient_id, clinicId: request.clinic_id,
          request_event_id: Number(request.id), reason: snapshot.reason, displayMode: 'persistent_alert', requiresAcknowledgement: true,
          link: `/pacientes/detalle/${request.patient_id}/datos-personales?clinic_id=${request.clinic_id}`, resolved: false },
      }, transaction });
      if (created && deps.notificationCreated) transaction.afterCommit(() => deps.notificationCreated(notification));
      if (!created && notification.data?.reason !== snapshot.reason) {
        await notification.update({ message, isRead: false, readAt: null,
          data: { ...notification.data, reason: snapshot.reason } }, { transaction });
        if (deps.notificationUpdated) transaction.afterCommit(() => deps.notificationUpdated(notification));
      }
    }
  }
  async function localTemplate(clinicId, transaction) {
    const rows = await db.AutomationFlowTemplateV2.findAll({ where: { clinic_id: clinicId, trigger_type: C.REQUEST,
      is_active: true, is_system: false, published_at: { [Op.ne]: null } }, order: [['version', 'DESC']], limit: 2, transaction });
    if (rows.length !== 1 || !C.configValid(rows[0].trigger_config) || !C.graphValid(rows[0].nodes)) return null;
    return rows[0];
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
    const permitted = !!template && rawTime(template.trigger_config.enabled_after) <= +now();
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
  async function requestAction({ execution, node, context }) {
    const done = (key, output) => ({ kind: 'success', output, next_node_id: node.outputs?.[key] || null });
    if (context?.__simulation) return done('on_success', { simulated: true, no_send: true });
    const request = await fromExecution(execution), patient = await db.Paciente.findByPk(request.patient_id);
    if (!patient || !await current(request, patient)) return done('on_superseded', { reason: 'source_changed' });
    const snapshot = await state(request);
    if (!snapshot.current || snapshot.state === 'confirmed') return done('on_superseded', { reason: 'already_resolved' });
    if (snapshot.state === 'review_required') return done('on_review', { reason: snapshot.reason });
    if (!enabled() || request.metadata.delivery_enabled !== true || !C.timeout(request.metadata.response_timeout_minutes)) {
      return done('on_superseded', { reason: 'delivery_disabled' });
    }
    const quiet = deps.engine.computeQuietHoursDelayMs({ now: now(), enabled: true });
    if (quiet.delayMs > 0) return { kind: 'waiting', wait_until: quiet.scheduledAt,
      waiting_meta: { type: node.type, resume_mode: 'retry_current_node', reason: 'quiet_hours' } };
    let sender;
    try { await communicationAllowed(request); sender = await deps.engine.resolveScheduledWhatsappSenderConfig({
      metadata: {}, clinicId: request.clinic_id }); }
    catch { return done('on_review', { reason: 'communication_blocked' }); }
    const templates = await db.WhatsappTemplate.findAll({ where: { waba_id: String(sender.wabaId), status: 'APPROVED', is_active: true,
      name: { [Op.like]: `${C.TEMPLATE}%` } }, limit: 20, order: [['id', 'DESC']] });
    const template = templates.find(C.templateValid);
    if (!template) return done('on_review', { reason: 'template_unavailable' });
    let conversation;
    await db.sequelize.transaction(async transaction => {
      const locked = await lockPatient(request, transaction);
      if (!await current(request, locked, transaction)) return;
      const candidates = await db.Conversation.findAll({ where: { clinic_id: request.clinic_id, channel: 'whatsapp',
        contact_id: { [Op.in]: require('../lib/phone').getPhoneIdentityCandidates(request.metadata.phone) } }, limit: 3, transaction });
      if (candidates.length > 1 || candidates.some(c => Number(c.patient_id) !== Number(request.patient_id) || c.lead_id)) return;
      conversation = candidates[0] || await db.Conversation.create({ clinic_id: request.clinic_id, channel: 'whatsapp',
        patient_id: request.patient_id, contact_id: request.metadata.phone, unread_count: 0 }, { transaction });
    });
    if (!conversation) return done('on_review', { reason: 'conversation_conflict' });
    const clinic = await db.Clinica.findByPk(request.clinic_id, { attributes: ['nombre_clinica'] });
    const token = request.metadata.reply_token;
    if (!/^[a-f0-9]{36}$/.test(token || '')) return done('on_review', { reason: 'source_changed' });
    const templateComponents = [{ type: 'body', parameters: [{ type: 'text', text: clinic.nombre_clinica }] },
      ...['yes', 'no'].map((answer, index) => ({ type: 'button', sub_type: 'quick_reply', index: String(index),
        parameters: [{ type: 'payload', payload: `pmv:${request.id}:${token}:${answer}` }] }))];
    const { message, created } = await deps.engine.findOrCreateAutomationWhatsappMessage({ deliveryKey: `mobile-verification:${request.id}`,
      messageType: 'template', values: { conversation_id: conversation.id, direction: 'outbound', sender_id: null,
        content: C.BODY.replace('{{1}}', clinic.nombre_clinica), message_type: 'template', status: 'pending', metadata: {
          source: 'automations_v2', kind: 'patient_mobile_verification', communication_scope: 'care',
          mobile_verification_request_id: Number(request.id), execution_id: execution.id, node_id: node.id,
          recipient_patient_id: request.patient_id, recipient: request.metadata.phone,
          sender_origin_id: sender.originId, phoneNumberId: sender.phoneNumberId, wabaId: sender.wabaId,
          template_id: template.id, template_name: template.name, template_language: template.language,
          template_params: { 1: clinic.nombre_clinica }, template_components: templateComponents,
          template_buttons: C.BUTTONS.map(text => ({ type: 'QUICK_REPLY', text })),
        } } });
    if (!message.metadata?.wamid && !message.metadata?.delivery_unknown && !message.metadata?.dispatch_wait
      && (created || message.status === 'pending' && !message.metadata?.mobile_verification_transport_queued_at)) {
      try {
        await deps.engine.enqueueAutomationWhatsappTransport({ msg: message, conversation, recipient: request.metadata.phone,
          dispatchKind: 'patient_mobile_verification', retryOnFailure: true });
        await db.sequelize.transaction(async transaction => {
          const fresh = await db.Message.findByPk(message.id, { transaction, lock: transaction.LOCK.UPDATE });
          await fresh.update({ metadata: { ...fresh.metadata, mobile_verification_transport_queued_at: now().toISOString() } }, { transaction });
        });
      } catch {
        // Queue publication can fail after storing its deterministic ID. Retry
        // the same Message, never assume that ID proves a successful handoff.
        if (+now() - rawTime(message.createdAt || message.created_at) >= 86400000) return done('on_review', { reason: 'delivery_failed' });
        return { kind: 'waiting', wait_until: new Date(+now() + 60000),
          waiting_meta: { type: node.type, resume_mode: 'retry_current_node', reason: 'transport_handoff' } };
      }
    }
    return done('on_success', { message_id: message.id, conversation_id: conversation.id, request_event_id: Number(request.id) });
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
    const patient = await db.Paciente.findByPk(request.patient_id), snapshot = await state(request);
    if (!patient || !await current(request, patient) || !snapshot.current || snapshot.state !== 'pending') return deny('mobile_verification_superseded');
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
  async function waitAction({ execution, node, context }) {
    const done = (key, reason) => ({ kind: 'success', output: { reason }, next_node_id: node.outputs?.[key] || null });
    if (context?.__simulation) return done('on_confirmed', 'simulated');
    const request = await fromExecution(execution), patient = await db.Paciente.findByPk(request.patient_id);
    const snapshot = await state(request);
    if (!patient || !await current(request, patient) || !snapshot.current) return done('on_superseded', 'source_changed');
    if (snapshot.state === 'confirmed') return done('on_confirmed', 'confirmed');
    if (snapshot.state === 'review_required') return done('on_review', snapshot.reason);
    const message = await messageFor(request), m = message?.metadata || {};
    if (!message || message.status === 'failed' || m.cancelled) return done('on_delivery_failed', 'delivery_failed');
    const acceptedAt = rawTime(m.provider_acceptance_at);
    const timeoutMs = C.timeout(request.metadata.response_timeout_minutes) * 60000;
    if (!timeoutMs) return done('on_delivery_failed', 'source_changed');
    if (!Number.isFinite(acceptedAt) || !m.wamid
      || m.provider_acceptance_status === 'held_for_quality_assessment' && !['sent', 'delivered', 'read'].includes(message.status)) {
      if (+now() - rawTime(message.createdAt || message.created_at) >= 86400000) return done('on_delivery_failed', m.delivery_unknown ? 'delivery_unknown' : 'delivery_failed');
      return { kind: 'waiting', wait_until: new Date(+now() + 60000), waiting_meta: { type: node.type, resume_mode: 'retry_current_node', reason: 'awaiting_transport' } };
    }
    const dueAt = new Date(acceptedAt + timeoutMs);
    if (+now() >= +dueAt) return done('on_timeout', 'no_response');
    return { kind: 'waiting', output: { accepted_at: new Date(acceptedAt).toISOString(), deadline_at: dueAt.toISOString() },
      wait_until: dueAt, waiting_meta: { type: node.type, resume_mode: 'retry_current_node', reason: 'awaiting_mobile_verification' } };
  }
  async function reviewAction({ execution, node, context }) {
    if (!context?.__simulation) {
      const request = await fromExecution(execution);
      await db.sequelize.transaction(async transaction => {
        const patient = await lockPatient(request, transaction), previous = await state(request, transaction);
        if (!await current(request, patient, transaction) || !previous.current || previous.state === 'confirmed' || previous.manually_resolved) return;
        const reason = Object.values(context?.outputs || {}).map(v => v?.reason).filter(v => C.reasons[v]).at(-1) || 'delivery_failed';
        const message = await messageFor(request);
        const updated = previous.state === 'review_required' ? previous : await transition(request, previous,
          { state: 'review_required', reason, provenance: 'automation', resolved_at: now().toISOString(),
            accepted_at: message?.metadata?.provider_acceptance_at || null,
            delivery_status: reason === 'no_response' ? 'accepted' : reason === 'delivery_unknown' ? 'unknown' : 'not_sent' }, transaction, true);
        await notify(request, updated, transaction, patient);
      });
    }
    return { kind: 'success', output: { reception_review: true }, next_node_id: node.outputs?.on_success || null };
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
    if (!requestId || message.direction !== 'inbound' || conversation.channel !== 'whatsapp'
      || m.historical !== false || m.recovery_without_automation === true || m.media_recovered_without_automation === true
      || m.automatic_actions_allowed !== true || !m.inbox_receipt || !m.fresh_inbound_dispatched_at) return ignored('untrusted_or_historical');
    if (!request || request.metadata?.delivery_enabled !== true || Number(request.clinic_id) !== Number(conversation.clinic_id)
      || Number(request.patient_id) !== Number(conversation.patient_id)
      || C.phone(conversation.contact_id) !== C.phone(request.metadata?.phone)) return ignored('scope_mismatch');
    outbound = outbound || await messageFor(request);
    const inboundAt = rawTime(message.sent_at || message.createdAt);
    if (!outbound || Number(outbound.metadata?.mobile_verification_request_id) !== requestId
      || outbound.automation_delivery_key !== `mobile-verification:${requestId}:outbound`
      || Number(outbound.conversation_id) !== Number(conversation.id) || !outbound.metadata?.wamid
      || String(m.phone_number_id || m.phoneNumberId || '') !== String(outbound.metadata.phoneNumberId)
      || String(m.waba_id || m.wabaId || '') !== String(outbound.metadata.wabaId)
      || match && match[2] !== request.metadata.reply_token
      || !Number.isFinite(rawTime(outbound.metadata.provider_acceptance_at))
      || !Number.isFinite(inboundAt) || inboundAt > +now() + 60000
      || inboundAt < rawTime(outbound.metadata.provider_acceptance_at)) return ignored('reply_not_correlated');
    return db.sequelize.transaction(async transaction => {
      const patient = await lockPatient(request, transaction), previous = await state(request, transaction);
      if (!await current(request, patient, transaction) || !previous.current || previous.manually_resolved || previous.state === 'confirmed') return ignored('resolved_or_superseded');
      const answer = match?.[3];
      if (previous.history.some(e => e.inbound_message_id === Number(message.id))) return ignored('duplicate');
      if (previous.state === 'review_required' && previous.reason !== 'no_response') return ignored('review_already_requested');
      const updated = await transition(request, previous, { state: answer === 'yes' ? 'confirmed' : 'review_required',
        reason: answer === 'yes' ? null : answer === 'no' ? 'patient_rejected' : 'response_unclear',
        provenance: 'patient_reply', inbound_message_id: message.id, resolved_at: now().toISOString(),
        delivery_status: 'accepted', accepted_at: outbound.metadata.provider_acceptance_at }, transaction, true);
      if (answer === 'yes') await closeTasks(request, transaction, 'patient_confirmed');
      else await notify(request, updated, transaction, patient);
      await wake(request, transaction);
      return { handled: true, request_event_id: requestId, state: updated.state };
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
      reason: payload.action === 'confirm' ? null : previous.reason, provenance: 'manual_review', actor_user_id: actorId,
      manually_resolved: payload.action === 'confirm', resolved_at: payload.action === 'confirm' ? now().toISOString() : previous.resolved_at }, transaction, payload.action === 'confirm');
    if (payload.action === 'confirm') await closeTasks(request, transaction, 'manual_confirmed');
    await wake(request, transaction);
    return { confirmed: payload.action === 'confirm', pending: payload.action === 'pending' };
  }
  return { recordRequest, dispatch, requestAction, waitAction, reviewAction, authorizeTransport, inbound, view, manual, state, current };
}

let runtime;
async function wakeNativeJob(db, execution, transaction) {
  await db.sequelize.query("UPDATE JobRequests SET next_run_at=UTC_TIMESTAMP() WHERE type='automations_v2_execute' AND status IN ('pending','waiting') AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.execution_id'))=:execution AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.__runtime_namespace'))=:namespace", {
    replacements: { execution: String(execution.id), namespace: require('./jobRequests.service').getCurrentRuntimeNamespace() }, transaction });
}
function current() {
  if (!runtime) {
    const db = require('../../models');
    runtime = createRuntime({ db, engine: require('./flowEngineV2.service'), stop: require('../lib/automation-runtime-stop'),
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
module.exports = { createRuntime, current,
  recordRequest: ({ db, ...values }, options) => createRuntime({ db,
    enqueueJob: (...args) => require('./jobRequests.service').enqueueUniqueJobRequest(...args),
    wake: (execution, transaction) => wakeNativeJob(db, execution, transaction),
    notificationUpdated: notification => require('./notificationsRealtime.service').emitNotificationUpdated(notification),
  }).recordRequest(values, options),
};

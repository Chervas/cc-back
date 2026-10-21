'use strict';

// A typed V2 domain adapter, not another automation engine. It persists the
// receipt event/outbox, authenticates the existing send/wait/reply nodes and
// applies one atomic, audited details-only mutation to the frozen batch.
const { randomBytes } = require('node:crypto');
const C = require('../lib/patient-program-booking-confirmation');
const A = require('../lib/patient-program-appointment-flow');
function createRuntime(deps) {
  const { db } = deps, { Op } = db.Sequelize;
  const now = () => new Date(deps.now ? deps.now() : Date.now());
  const enabled = () => deps.enabled ? deps.enabled() === true : process.env.PATIENT_PROGRAM_APPOINTMENT_AUTOMATION_ENABLED === 'true';
  const native = deps.nativeOnly === true;
  const isRequest = request => native ? A.EVENTS.includes(request?.event_type) && request?.metadata?.native_protocol === A.PROTOCOL
    : request?.event_type === C.REQUEST;
  const key = request => `program-booking-notice:${request.clinic_id}:${request.id}`;
  const messageKey = request => `${key(request)}:outbound`;
  const eventWhere = (field, value) => db.Sequelize.where(db.Sequelize.literal(`JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.${field}'))`), String(value));
  const requestForVoucher = (voucherId, transaction, scope = {}) => db.PatientOperationalEvent.findOne({ where: { event_type: native ? { [Op.in]: A.EVENTS } : C.REQUEST,
    ...(scope.clinicId ? { clinic_id: scope.clinicId } : {}), ...(scope.patientId ? { patient_id: scope.patientId } : {}),
    [Op.and]: [eventWhere('notice.voucher_id', voucherId), ...(native ? [eventWhere('native_protocol', A.PROTOCOL)] : [])] }, order: [['id', 'DESC']], transaction,
  ...(scope.lock && transaction ? { lock: transaction.LOCK.SHARE } : {}) });
  const resultFor = (request, transaction) => db.PatientOperationalEvent.findOne({ where: { event_type: C.TRANSITION,
    patient_id: request.patient_id, clinic_id: request.clinic_id, [Op.and]: eventWhere('request_event_id', request.id) },
  order: [['id', 'DESC']], transaction });
  const messageFor = (request, transaction) => db.Message.findOne({ where: { automation_delivery_key: messageKey(request) }, transaction });
  async function members(voucher, transaction, lock = false) {
    const options = { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) };
    const sessions = await db.PatientProgramSession.findAll({ where: { voucher_id: voucher.id }, order: [['position', 'ASC']], ...options });
    const ids = sessions.map(row => Number(row.appointment_id)).filter(Boolean);
    const appointments = ids.length ? await db.CitaPaciente.findAll({ where: { id_cita: { [Op.in]: ids }, voucher_id: voucher.id,
      paciente_id: voucher.patient_id, clinica_id: voucher.clinic_id }, order: [['id_cita', 'ASC']], ...options }) : [];
    return { sessions, appointments };
  }
  async function snapshotFor(voucher, transaction) {
    if (voucher.budget_id == null) return require('../lib/patient-program-enrollment').readProgramEnrollment(voucher, { required: true });
    if (voucher.program_snapshot != null) C.fail('program_details_origin_conflict');
    const budget = await db.EconomicBudget.findOne({ where: { id: voucher.budget_id, clinic_id: voucher.clinic_id,
      patient_id: voucher.patient_id }, transaction });
    if (!budget || !['accepted', 'partially_accepted'].includes(budget.status)) C.fail('program_details_budget_not_accepted');
    if (budget.status === 'partially_accepted') {
      const acceptance = await db.EconomicBudgetEvent.findOne({ where: { budget_id: budget.id, version_number: budget.current_version,
        event_type: 'partially_accepted' }, order: [['id', 'DESC']], transaction });
      if (!(C.object(acceptance?.metadata).accepted_line_keys || []).includes(voucher.budget_line_key)) C.fail('program_details_budget_not_accepted');
    }
    const version = await db.EconomicBudgetVersion.findOne({ where: { budget_id: budget.id, version_number: budget.current_version }, transaction });
    const line = (typeof version?.lines === 'string' ? JSON.parse(version.lines) : version?.lines || []).find(row => row.key === voucher.budget_line_key);
    return require('../lib/economicProgramSnapshot').operationalSnapshot(line?.program_snapshot);
  }
  async function localTemplate(clinicId, transaction) {
    const rows = await db.AutomationFlowTemplateV2.findAll({ where: { clinic_id: clinicId, trigger_type: C.REQUEST,
      is_active: true, is_system: false, published_at: { [Op.ne]: null } }, order: [['version', 'DESC']], limit: 2, transaction });
    if (rows.length !== 1 || !C.configValid(rows[0].trigger_config) || !C.graphValid(rows[0].nodes)) return null;
    return rows[0];
  }
  async function recordBookingReceipt({ receipt, voucher, snapshot, clinic, actorId, transaction }) {
    // A closed deployment must remain schema-independent and cannot create
    // work that a later activation could replay. No event/outbox reads either.
    if (!enabled()) return { status: 'not_available', reason: 'runtime_disabled', sent: false };
    if (native) return recordNativeReceipt({ receipt, voucher, snapshot, clinic, actorId, transaction });
    if (!transaction || !C.id(actorId) || !C.id(receipt?.id)) C.fail('program_details_transactional_receipt_required');
    const previous = await requestForVoucher(voucher.id, transaction, { clinicId: voucher.clinic_id, patientId: voucher.patient_id });
    if (Number(previous?.metadata?.notice?.receipt_id) === Number(receipt.id)) return C.publicState(previous);
    const patient = await db.Paciente.findByPk(voucher.patient_id, { transaction });
    const template = await localTemplate(voucher.clinic_id, transaction), occurred = now();
    const membership = await members(voucher, transaction);
    let notice;
    try {
      notice = C.projection({ receipt, voucher, snapshot, clinic, ...membership, actorId, occurredAt: occurred,
        timeZone: require('../lib/availability-calendar').resolveClinicTimezone(clinic), communicationLanguage: patient?.idioma_preferido || 'es' });
    } catch (error) {
      // A valid clinical reservation is independent of its printable summary.
      // Persist a blocked receipt/event, never truncate or send only a subset.
      // SQL/integrity errors outside these pure representation limits still
      // abort the transaction, preserving the receipt/outbox invariant.
      if (!/^(?:program_details_(?:body_too_long|parameter_invalid|no_future_reservations)|program_notice_(?:batch_invalid|snapshot_invalid|language_unsupported|language_required|clinic_name_invalid|body_too_long|parameter_invalid))$/.test(error.code || '')) throw error;
      const request = await db.PatientOperationalEvent.create({ patient_id: voucher.patient_id, clinic_id: voucher.clinic_id,
        actor_user_id: actorId, event_type: C.REQUEST, source: 'program_booking', channel: 'internal', occurred_at: occurred,
        metadata: { schema_version: C.SCHEMA, notice: { voucher_id: Number(voucher.id), receipt_id: Number(receipt.id),
          payload_available: false }, delivery_enabled: false, delivery_disabled_reason: error.code,
          supersedes_event_id: previous?.id ? Number(previous.id) : null } }, { transaction });
      return C.publicState(request);
    }
    const recipient = C.phone(patient?.telefono_movil), configured = template && C.time(occurred) >= C.time(template.trigger_config.enabled_after);
    let ready = false;
    if (configured && recipient && !notice.overdue_count && notice.membership.every(row => row.native_program_booking)) {
      try { ready = await deps.deliveryReady(voucher.clinic_id, template, transaction); } catch { ready = false; }
    }
    const permitted = !!ready && notice.language === 'es';
    const request = await db.PatientOperationalEvent.create({ patient_id: voucher.patient_id, clinic_id: voucher.clinic_id,
      actor_user_id: actorId, event_type: C.REQUEST, source: 'program_booking', channel: 'internal', occurred_at: occurred,
      metadata: { schema_version: C.SCHEMA, notice, phone: recipient, reply_token: randomBytes(18).toString('hex'),
        delivery_enabled: permitted, delivery_disabled_reason: permitted ? null : !configured ? 'automation_unconfigured_or_inactive'
          : !recipient ? 'recipient_missing' : notice.overdue_count ? 'past_reservations_require_review'
            : notice.membership.some(row => !row.native_program_booking) ? 'non_native_reservations_require_review'
              : notice.language !== 'es' ? 'utility_language_unavailable' : 'sender_utility_unavailable',
        template_version_id: permitted ? Number(template.id) : null,
        graph_sha256: permitted ? C.hash({ nodes: template.nodes, trigger_config: template.trigger_config, entry_node_id: template.entry_node_id }) : null,
        response_timeout_minutes: permitted ? template.trigger_config.response_timeout_minutes : null,
        supersedes_event_id: previous?.id ? Number(previous.id) : null } }, { transaction });
    if (permitted) await deps.enqueueJob({ type: 'patient_program_booking_notice_dispatch',
      payload: { request_event_id: Number(request.id), clinic_id: Number(voucher.clinic_id) }, priority: 'high', status: 'pending',
      origin: 'patient_program_booking_notice', dedupeScope: key(request), requestedBy: actorId, requestedByRole: 'system' }, { transaction });
    return C.publicState(request);
  }
  async function recordNativeReceipt({ receipt, voucher, snapshot, clinic, actorId, transaction }) {
    if (!transaction || !C.id(actorId) || !C.id(receipt?.id)) C.fail('program_details_transactional_receipt_required');
    const op = A.operation(receipt);
    if (op.unchanged) return { status: 'not_requested', reason: 'appointment_time_unchanged', sent: false };
    if (op.reason === 'administrative_error' || op.declined) return { status: 'not_requested', reason: op.declined ? 'notice_declined_by_operator' : 'administrative_error', sent: false };
    const previous = await requestForVoucher(voucher.id, transaction, { clinicId: voucher.clinic_id, patientId: voucher.patient_id });
    if (Number(previous?.metadata?.notice?.receipt_id) === Number(receipt.id)) return C.publicState(previous);
    const membership = await members(voucher, transaction), owner = membership.appointments.find(row => Number(row.id_cita) === op.ownerId);
    if (!owner || !deps.resolveAppointmentTemplate) C.fail('program_details_native_owner_missing');
    const template = await deps.resolveAppointmentTemplate(owner, op.event);
    const occurred = now();
    // Never select another active family to bypass this family's manual stop,
    // binding, unreviewed composition or first-activation cutoff.
    if (!template?.is_active || !template.published_at || Number(template.clinic_id) !== Number(voucher.clinic_id)
      || !A.configured(template, occurred)) return { status: 'not_available', reason: 'program_automation_unconfigured_or_inactive', sent: false };
    const patient = await db.Paciente.findByPk(voucher.patient_id, { transaction });
    const notice = C.projection({ receipt, voucher, snapshot, clinic, ...membership, actorId, occurredAt: occurred,
      timeZone: require('../lib/availability-calendar').resolveClinicTimezone(clinic), communicationLanguage: patient?.idioma_preferido || 'es', native: true });
    const timeout = A.timeout(template, { startAt: owner.inicio, now: occurred, timeZone: notice.time_zone, reason: op.reason });
    const recipient = C.phone(patient?.telefono_movil);
    let blocked = notice.representation_error || (!recipient ? 'recipient_missing' : notice.overdue_count ? 'past_reservations_require_review'
      : notice.membership.some(row => !row.native_program_booking) ? 'non_native_reservations_require_review' : null);
    if (!blocked) {
      try { if (!await deps.deliveryReady(voucher.clinic_id, template, transaction, notice.language)) blocked = 'sender_utility_unavailable'; }
      catch { blocked = 'sender_utility_unavailable'; }
    }
    const request = await db.PatientOperationalEvent.create({ patient_id: voucher.patient_id, clinic_id: voucher.clinic_id,
      actor_user_id: actorId, event_type: op.event, source: 'program_booking', channel: 'internal', occurred_at: occurred,
      metadata: { schema_version: C.SCHEMA, native_protocol: A.PROTOCOL, owner_appointment_id: op.ownerId, reschedule_reason: op.reason,
        notice, phone: recipient, reply_token: randomBytes(18).toString('hex'), delivery_enabled: !blocked, review_only: !!blocked,
        delivery_disabled_reason: blocked, template_version_id: Number(template.id), response_timeout_minutes: timeout,
        graph_sha256: C.hash({ nodes: template.nodes, trigger_config: template.trigger_config, entry_node_id: template.entry_node_id }),
        supersedes_event_id: previous?.id ? Number(previous.id) : null } }, { transaction });
    // Keep the existing transactional outbox. Execution creation happens after
    // commit, retaining family -> execution -> clinical lock order; no second
    // sender and no family/voucher lock inversion inside a booking transaction.
    await deps.enqueueJob({ type: 'patient_program_booking_notice_dispatch',
      payload: { request_event_id: Number(request.id), clinic_id: Number(voucher.clinic_id) }, priority: 'high', status: 'pending',
      origin: 'appointment_automation_v2', dedupeScope: key(request), requestedBy: actorId, requestedByRole: 'system' }, { transaction });
    return C.publicState(request);
  }
  async function fromExecution(execution, transaction) {
    if (!C.isFlow(execution) || (native ? !A.nativeFlow(execution) : execution.trigger_entity_type !== 'patient_operational_event')) C.fail('program_details_execution_scope');
    const request = await db.PatientOperationalEvent.findByPk(C.id(native ? execution.context?.program_confirmation?.request_event_id : execution.trigger_entity_id), { transaction });
    if (!request || !isRequest(request) || Number(request.clinic_id) !== Number(execution.clinic_id)
      || native && (execution.trigger_type !== request.event_type || Number(execution.trigger_entity_id) !== Number(request.metadata?.owner_appointment_id))
      || request.metadata?.schema_version !== C.SCHEMA || Number(request.metadata.template_version_id) !== Number(execution.template_version_id)
      || Number(execution.context?.trigger?.data?.request_event_id) !== Number(request.id)) C.fail('program_details_execution_scope');
    return request;
  }
  async function currentSource(request, transaction, lock = false) {
    const m = request.metadata || {}, n = m.notice;
    if (!isRequest(request) || m.schema_version !== C.SCHEMA || !n || n.schema_version !== C.SCHEMA) return null;
    const voucher = await db.PatientVoucher.findOne({ where: { id: n.voucher_id, clinic_id: request.clinic_id,
      patient_id: request.patient_id, source_system: 'treatment_program', status: 'active' }, transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    // Book/replan serializes on this voucher. Re-read the latest event AFTER
    // that mutex, using a CURRENT locking read in a transaction; even a no-op
    // replan with identical dates supersedes the earlier receipt/token.
    const latest = await requestForVoucher(n.voucher_id, transaction, { clinicId: request.clinic_id, patientId: request.patient_id, lock });
    if (Number(latest?.id) !== Number(request.id)) return null;
    const clinic = await db.Clinica.findByPk(request.clinic_id, { transaction });
    const patient = await db.Paciente.findByPk(request.patient_id, { transaction });
    if (!voucher || !clinic || !patient || C.phone(patient.telefono_movil) !== C.phone(m.phone)
      || Number(patient.clinica_id) !== Number(request.clinic_id) && !await db.PacienteClinica.findOne({
        where: { paciente_id: request.patient_id, clinica_id: request.clinic_id }, transaction })) return null;
    const membership = await members(voucher, transaction, lock), snapshot = await snapshotFor(voucher, transaction);
    const receipt = await db.PatientProgramBookingRequest.findByPk(n.receipt_id, { transaction });
    const latestReceipt = await db.PatientProgramBookingRequest.findOne({ where: { voucher_id: voucher.id }, order: [['id', 'DESC']],
      transaction, ...(lock ? { lock: transaction.LOCK.SHARE } : {}) });
    // A newer booking also supersedes this token if it happened while the gate
    // was OFF (and intentionally created no notice event), or through linking.
    if (!receipt || Number(receipt.voucher_id) !== Number(voucher.id) || Number(latestReceipt?.id) !== Number(receipt.id)) return null;
    let actual;
    try { actual = C.projection({ receipt, voucher, snapshot, clinic, ...membership, actorId: request.actor_user_id,
      occurredAt: n.occurred_at, timeZone: require('../lib/availability-calendar').resolveClinicTimezone(clinic), communicationLanguage: n.language, native }); }
    catch { return null; }
    if (C.hash(actual) !== C.hash(n) || (!m.review_only && (n.membership.some(row => !row.native_program_booking)
      || n.overdue_count))) return null;
    const template = await db.AutomationFlowTemplateV2.findByPk(m.template_version_id, { transaction });
    if (!enabled() || (!m.delivery_enabled && !(native && m.review_only)) || !template?.is_active || template.is_system || !template.published_at
      || Number(template.clinic_id) !== Number(request.clinic_id)
      || (native ? template.trigger_type !== request.event_type || !A.configured(template, request.occurred_at)
        : template.trigger_type !== C.REQUEST || !C.configValid(template.trigger_config) || !C.graphValid(template.nodes)
          || C.time(request.occurred_at) < C.time(template.trigger_config.enabled_after))
      || C.hash({ nodes: template.nodes, trigger_config: template.trigger_config, entry_node_id: template.entry_node_id }) !== m.graph_sha256) return null;
    if (native) {
      const owner = membership.appointments.find(row => Number(row.id_cita) === Number(m.owner_appointment_id));
      const selected = owner && await deps.resolveAppointmentTemplate(owner, request.event_type);
      if (!selected || Number(selected.id) !== Number(template.id)) return null;
      if (membership.appointments.some(row => require('../lib/appointment-reschedule-notice').suppressRescheduleNotice(row)
        || row.reschedule_reason === 'administrative_error' && C.time(row.updated_at || row.updatedAt) > C.time(request.occurred_at))) return null;
    }
    return { voucher, clinic, patient, template, ...membership };
  }
  const hasStarted = request => request.metadata.notice.appointments.some(row => C.time(row.start_at) <= +now());
  async function current(request, transaction, lock = false) {
    const scope = await currentSource(request, transaction, lock);
    // Sending and confirming require future dates; closing an already started
    // follow-up must still retain every source, receipt, scope and gate check.
    return scope && !hasStarted(request) ? scope : null;
  }
  async function communicationAllowed(request) {
    await deps.authorizeActor(request);
    await deps.communicationAllowed({ clinicId: request.clinic_id, patientId: request.patient_id, phone: request.metadata.phone, scope: 'care' });
    // The patient HOLD is not changed. Only this verified native future batch
    // may pass the separate transport authorization below; no other purpose.
  }
  async function dispatch({ request_event_id: eventId, clinic_id: clinicId }) {
    const request = await db.PatientOperationalEvent.findByPk(C.id(eventId));
    if (!request || Number(request.clinic_id) !== Number(clinicId) || !await current(request)) return { status: 'completed', result: { skipped: true, reason: 'disabled_or_superseded' } };
    // Channel/actor vetoes belong to the existing send node's preflight. Let
    // that node fail into the audited review/notification branches, rather
    // than leaving a queued receipt with no execution or reception follow-up.
    const template = await db.AutomationFlowTemplateV2.findByPk(request.metadata.template_version_id);
    let execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: key(request) } });
    if (!execution) {
      const n = request.metadata.notice;
      try { execution = await deps.stop.createExecution({ idempotency_key: key(request), template_version_id: template.id,
        engine_version: 'v2', status: 'running', current_node_id: template.entry_node_id, created_by: request.actor_user_id,
        trigger_type: native ? request.event_type : C.REQUEST, trigger_entity_type: native ? 'appointment' : 'patient_operational_event',
        trigger_entity_id: native ? request.metadata.owner_appointment_id : Number(request.id), clinic_id: request.clinic_id,
        group_id: native ? template.group_id : null,
        context: { communication_language: n.language, trigger: { type: native ? request.event_type : C.REQUEST,
          data: { request_event_id: Number(request.id), patient_id: request.patient_id, clinic_id: request.clinic_id,
            reschedule_reason: request.metadata.reschedule_reason || null, response_timeout_minutes: request.metadata.response_timeout_minutes } },
          program_confirmation: { ...(native ? { protocol: A.PROTOCOL, response_timeout_minutes: request.metadata.response_timeout_minutes } : {}),
            request_event_id: Number(request.id), clinic_name: n.clinic_name, program_name: n.program_name,
            appointment_list: n.parameters[2], pending_count: n.pending_count } } }); }
      catch (error) { if (error.name !== 'SequelizeUniqueConstraintError') throw error;
        execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: key(request) } }); if (!execution) throw error; }
    }
    if (['running', 'waiting'].includes(execution.status)) await deps.enqueueJob({ type: 'automations_v2_execute', payload: { execution_id: execution.id },
      priority: 'high', status: 'pending', origin: 'patient_program_booking_notice', dedupeScope: `flow_execution:${execution.id}`,
      requestedBy: request.actor_user_id, requestedByRole: 'system' });
    return { status: 'completed', result: { execution_id: Number(execution.id) } };
  }
  async function sendPreflight({ execution }) {
    const request = await fromExecution(execution), scope = await current(request);
    const resolved = await resultFor(request);
    if (!scope || resolved) return { suppressed: true };
    if (request.metadata.review_only) C.fail(request.metadata.delivery_disabled_reason);
    await communicationAllowed(request);
    if (!await deps.deliveryReady(request.clinic_id, scope.template, undefined, request.metadata.notice.language)) C.fail('program_details_sender_utility_unavailable');
    const candidates = await db.Conversation.findAll({ where: { clinic_id: request.clinic_id, channel: 'whatsapp',
      contact_id: { [Op.in]: require('../lib/phone').getPhoneIdentityCandidates(request.metadata.phone) } }, limit: 3 });
    if (candidates.length > 1 || candidates.some(row => Number(row.patient_id) !== Number(request.patient_id) || row.lead_id)) C.fail('program_details_conversation_conflict');
    return { request, delivery_key: key(request), recipient: request.metadata.phone,
      language_code: ({ es: 'es_ES', ca: 'ca', en: 'en_US' })[request.metadata.notice.language],
      // Positional values belong to the frozen receipt, not to the generic
      // semantic-name inference (which may infer the same name more than once).
      template_params: Object.fromEntries(request.metadata.notice.parameters.map((value, index) => [String(index + 1), value])) };
  }
  async function sendEnvelope({ request, template, templateParams, sender, conversation, recipient }) {
    const stored = template?.id ? await db.WhatsappTemplate.findByPk(template.id) : null;
    if (!C.templateValid(stored, request.metadata.notice.language) || String(stored.waba_id) !== String(sender.wabaId)) C.fail('program_details_template_unavailable');
    if (Number(conversation?.clinic_id) !== Number(request.clinic_id) || Number(conversation?.patient_id) !== Number(request.patient_id)
      || conversation.lead_id || C.phone(conversation.contact_id) !== request.metadata.phone || C.phone(recipient) !== request.metadata.phone
      || !/^[a-f0-9]{36}$/.test(request.metadata.reply_token)) C.fail('program_details_recipient_or_payload_changed');
    if (C.hash([1, 2, 3, 4].map(position => String(templateParams[position] ?? ''))) !== C.hash(request.metadata.notice.parameters)) C.fail('program_details_parameters_changed');
    return { metadata: { kind: 'patient_program_booking_notice', program_booking_request_event_id: Number(request.id),
      program_booking_notice_sha256: request.metadata.notice.snapshot_sha256 }, template_components: [
      { type: 'body', parameters: request.metadata.notice.parameters.map(text => ({ type: 'text', text })) },
      ...['yes', 'no'].map((answer, index) => ({ type: 'button', sub_type: 'quick_reply', index: String(index),
        parameters: [{ type: 'payload', payload: `ppb:${request.id}:${request.metadata.reply_token}:${answer}` }] })),
    ] };
  }
  async function authorizeEligibility({ message, conversation, payload, execution }) {
    if (!enabled() || !C.isFlow(execution) || message.metadata?.kind !== 'patient_program_booking_notice'
      || payload?.type !== 'template' || payload.template?.name !== C.TEMPLATE) return false;
    const request = await fromExecution(execution), scope = await current(request), m = message.metadata || {};
    if (!scope || !request.metadata.delivery_enabled || request.metadata.review_only || await resultFor(request) || Number(m.program_booking_request_event_id) !== Number(request.id)
      || m.program_booking_notice_sha256 !== request.metadata.notice.snapshot_sha256 || message.automation_delivery_key !== messageKey(request)
      || Number(conversation?.patient_id) !== Number(request.patient_id) || Number(conversation?.clinic_id) !== Number(request.clinic_id)
      || conversation.lead_id || C.phone(conversation.contact_id) !== request.metadata.phone
      || C.hash(payload.template.components) !== C.hash(m.template_components)) return false;
    try { await communicationAllowed(request); return true; } catch { return false; }
  }
  async function authorizeTransport({ message, to, sender, useTemplate, templateName, templateLanguage, templateComponents }) {
    const execution = await db.FlowExecutionV2.findByPk(message.metadata?.execution_id);
    const conversation = await db.Conversation.findByPk(message.conversation_id);
    const request = execution && C.isFlow(execution) ? await fromExecution(execution) : null;
    if (!request || C.phone(to) !== request.metadata.phone || !useTemplate || templateName !== C.TEMPLATE
      || templateLanguage !== ({ es: 'es_ES', ca: 'ca', en: 'en_US' })[request.metadata.notice.language]
      || String(sender.phoneNumberId) !== String(message.metadata?.phoneNumberId) || String(sender.wabaId) !== String(message.metadata?.wabaId)
      || !await authorizeEligibility({ message, conversation, execution, payload: { type: 'template', template: { name: templateName, components: templateComponents } } })) {
      return { allowed: false, reason: 'program_details_transport_ineligible' };
    }
    const template = await db.WhatsappTemplate.findByPk(message.metadata.template_id);
    const scope = await current(request);
    if (!C.templateValid(template, request.metadata.notice.language) || String(template.waba_id) !== String(sender.wabaId) || !scope
      || !await deps.deliveryReady(request.clinic_id, scope.template, undefined, request.metadata.notice.language)) return { allowed: false, reason: 'program_details_template_unavailable' };
    const quiet = deps.engine.computeQuietHoursDelayMs({ now: now(), enabled: true, timeZone: request.metadata.notice.time_zone });
    return quiet.delayMs > 0 ? { allowed: true, deferredUntil: quiet.scheduledAt } : { allowed: true };
  }
  async function delivery(request) {
    const message = await messageFor(request), m = message?.metadata || {};
    const accepted = C.time(m.provider_acceptance_at), held = m.provider_acceptance_status === 'held_for_quality_assessment'
      && !['sent', 'delivered', 'read'].includes(message?.status);
    if (!message || message.status === 'failed' || m.cancelled || +now() - C.time(message.createdAt || message.created_at) >= 86400000
      && (!m.wamid || !Number.isFinite(accepted) || held)) return { status: 'delivery_failed', message };
    if (!m.wamid || !Number.isFinite(accepted) || held) return { status: 'awaiting_transport', message };
    const deadline = new Date(accepted + request.metadata.response_timeout_minutes * 60000);
    return { status: +now() >= +deadline ? 'timed_out' : 'awaiting_response', message,
      accepted_at: new Date(accepted).toISOString(), deadline_at: deadline.toISOString(), delivery_status: 'accepted' };
  }
  async function waitContext({ execution }) {
    const request = await fromExecution(execution);
    if (!await currentSource(request) || await resultFor(request)) return { status: 'superseded' };
    const fresh = await db.FlowExecutionV2.findByPk(execution.id), reply = fresh?.context?.program_confirmation || {};
    if (reply.response_message_id) return C.time(reply.response_buffer_until) > +now()
      ? { status: 'buffering', reply, wait_until: new Date(reply.response_buffer_until) } : { status: 'responded', reply };
    const transport = await delivery(request);
    return { ...transport, wait_until: transport.status === 'awaiting_transport' ? new Date(+now() + 60000)
      : transport.status === 'awaiting_response' ? new Date(native && !['delivered', 'read'].includes(transport.message?.status)
        ? Math.min(C.time(transport.deadline_at), +now() + 60000) : C.time(transport.deadline_at)) : null };
  }
  async function replyProof(request, outbound, message, conversation) {
    const m = message?.metadata || {}, payload = m.button?.payload || m.interactive?.button_reply?.id || '';
    const button = /^ppb:([1-9]\d*):([a-f0-9]{36}):(yes|no)$/.exec(payload), at = C.time(message?.sent_at || message?.createdAt);
    if (!message || message.direction !== 'inbound' || conversation?.channel !== 'whatsapp'
      || Number(message.conversation_id) !== Number(conversation.id) || Number(conversation.patient_id) !== Number(request.patient_id)
      || Number(conversation.clinic_id) !== Number(request.clinic_id) || conversation.lead_id || C.phone(conversation.contact_id) !== request.metadata.phone
      || m.historical !== false || m.automatic_actions_allowed !== true || !m.inbox_receipt || !m.fresh_inbound_dispatched_at
      || m.recovery_without_automation || m.media_recovered_without_automation || !outbound?.metadata?.wamid
      || Number(outbound.conversation_id) !== Number(conversation.id) || outbound.automation_delivery_key !== messageKey(request)
      || Number(outbound.metadata.program_booking_request_event_id) !== Number(request.id)
      || String(m.phone_number_id || m.phoneNumberId || '') !== String(outbound.metadata.phoneNumberId)
      || String(m.waba_id || m.wabaId || '') !== String(outbound.metadata.wabaId)
      || !Number.isFinite(at) || !Number.isFinite(C.time(outbound.metadata.provider_acceptance_at))
      // Messages.sent_at / Meta timestamps have whole-second precision. The
      // unique reply token + WAMID bind the response; do not reject a genuine
      // immediate click merely because acceptance has JSON milliseconds.
      || at < Math.floor(C.time(outbound.metadata.provider_acceptance_at) / 1000) * 1000 || at > +now() + 60000
      || at > C.time(outbound.metadata.provider_acceptance_at) + Number(request.metadata.response_timeout_minutes) * 60000
      || outbound.metadata.provider_acceptance_status === 'held_for_quality_assessment' && !['sent', 'delivered', 'read'].includes(outbound.status)
      || m.context?.id && m.context.id !== outbound.metadata.wamid
      || payload.startsWith('ppb:') && (!button || Number(button[1]) !== Number(request.id) || button[2] !== request.metadata.reply_token)) return null;
    if (!button && !m.context?.id) {
      const last = await db.Message.findOne({ where: { conversation_id: conversation.id, direction: 'outbound', message_type: { [Op.ne]: 'event' } }, order: [['id', 'DESC']] });
      if (Number(last?.id) !== Number(outbound.id)) return null;
    }
    return { response_message_id: Number(message.id), response_text: String(message.content || ''), reply_answer: button?.[3] || null };
  }
  async function replyBatch(request, outbound, ids, conversation, transaction) {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.length > 100) return null;
    const messages = await db.Message.findAll({ where: { id: { [Op.in]: ids }, conversation_id: conversation.id, direction: 'inbound' },
      order: [['sent_at', 'ASC'], ['createdAt', 'ASC'], ['id', 'ASC']], transaction });
    if (messages.length !== ids.length) return null;
    const proofs = [];
    for (const message of messages) {
      if (require('../lib/automation-conversation-context').isRevokedMessage(message)) return null;
      const proof = await replyProof(request, outbound, message, conversation); if (!proof) return null; proofs.push(proof);
    }
    const answer = proofs[0].reply_answer;
    return { ...proofs.at(-1), response_message_ids: proofs.map(row => row.response_message_id),
      response_version: proofs.map(row => row.response_message_id).join(':'), response_text: proofs.map(row => row.response_text).join('\n'),
      reply_conflict: new Set(proofs.map(row => row.reply_answer).filter(Boolean)).size > 1,
      reply_answer: answer && proofs.every(row => row.reply_answer === answer) ? answer : null };
  }
  async function inbound({ message, conversation }) {
    const m = message.metadata || {}, payload = m.button?.payload || m.interactive?.button_reply?.id || '';
    const button = /^ppb:([1-9]\d*):([a-f0-9]{36}):(yes|no)$/.exec(payload);
    let outbound = m.context?.id ? await db.Message.findOne({ where: { conversation_id: conversation.id, direction: 'outbound',
      [Op.and]: db.Sequelize.where(db.Sequelize.literal("JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wamid'))"), m.context.id) } }) : null;
    if (!outbound && !button && enabled()) {
      const last = await db.Message.findOne({ where: { conversation_id: conversation.id, direction: 'outbound', message_type: { [Op.ne]: 'event' } }, order: [['id', 'DESC']] });
      if (last?.metadata?.program_booking_request_event_id) outbound = last;
    }
    const eventId = C.id(button?.[1] || outbound?.metadata?.program_booking_request_event_id);
    if (!eventId && !payload.startsWith('ppb:')) return { handled: false };
    const ignored = reason => ({ handled: true, ignored: true, reason });
    const request = eventId ? await db.PatientOperationalEvent.findByPk(eventId) : null;
    if (!request || !await currentSource(request) || await resultFor(request)) return ignored('superseded_or_resolved');
    outbound ||= await messageFor(request);
    if (!await replyProof(request, outbound, message, conversation)) return ignored('reply_not_correlated');
    return db.sequelize.transaction(async transaction => {
      if (!await currentSource(request, transaction, true) || await resultFor(request, transaction)) return ignored('superseded_or_resolved');
      const execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: key(request) }, transaction, lock: transaction.LOCK.UPDATE });
      if (!execution || !['running', 'waiting'].includes(execution.status)) return ignored('execution_not_available');
      const template = await db.AutomationFlowTemplateV2.findByPk(execution.template_version_id, { transaction });
      const previous = execution.context?.program_confirmation || {};
      const waits = template.nodes.filter(node => node.type === 'delay/wait_response' && node.config?.listens_to_node_id === outbound.metadata.node_id);
      const wait = waits.find(node => node.id === previous.wait_node_id) || (waits.length === 1 ? waits[0] : null);
      if (!wait) return ignored('wait_missing');
      const ids = [...new Set([...(previous.response_message_ids || []), Number(message.id)])];
      const batch = await replyBatch(request, outbound, ids, conversation, transaction); if (!batch) return ignored('reply_batch_invalid');
      const delay = wait.config.response_buffer_enabled !== false && !batch.reply_answer ? 90000 : 0;
      const buffer = new Date(Math.min(+now() + delay, (C.time(previous.first_response_at) || +now()) + 300000));
      const context = { ...execution.context, program_confirmation: { ...previous, ...batch, request_event_id: eventId,
        first_response_at: previous.first_response_at || now().toISOString(), response_buffer_until: buffer.toISOString(), wait_node_id: wait.id } };
      await execution.update({ context, ...(execution.status === 'waiting' ? { current_node_id: wait.id, wait_until: buffer,
        waiting_meta: { ...execution.waiting_meta, type: 'delay/wait_response', resume_mode: 'retry_current_node', program_booking_protocol: true } } : {}) }, { transaction });
      await deps.enqueueJob({ type: 'automations_v2_execute', payload: { execution_id: execution.id,
        __runtime_namespace: execution.waiting_meta?.runtime_namespace || previous.runtime_namespace }, nextRunAt: buffer,
      priority: 'high', origin: 'patient_program_booking_notice', dedupeScope: `flow_execution:${execution.id}`, status: 'pending' }, { transaction });
      if (deps.wake) await deps.wake(execution, transaction, buffer);
      return { handled: true, request_event_id: eventId, correlated: true };
    });
  }
  async function attestAnalysis({ execution, context, sourceEntries, resolvedSources }) {
    const request = await fromExecution(execution), outbound = await messageFor(request);
    const fresh = await db.FlowExecutionV2.findByPk(execution.id), reply = fresh?.context?.program_confirmation;
    const paths = sourceEntries.map(row => String(row.path || '').replace(/\s+/g, ''));
    if (!outbound || !reply?.response_version || reply.response_version !== context.program_confirmation?.response_version
      || paths.length !== 2 || !paths.includes('{{last_prompt}}') || !paths.includes('{{program_confirmation.response_text}}')) return null;
    const conversation = await db.Conversation.findByPk(outbound.conversation_id);
    const batch = await replyBatch(request, outbound, reply.response_message_ids, conversation);
    return batch && !batch.reply_conflict && batch.response_version === reply.response_version && batch.response_text === reply.response_text
      && resolvedSources[paths.indexOf('{{last_prompt}}')]?.value === outbound.content
      && resolvedSources[paths.indexOf('{{program_confirmation.response_text}}')]?.value === batch.response_text ? reply.response_version : null;
  }
  async function resolveAction({ execution, node, context = {} }) {
    const outcome = node.config?.result, reason = node.config?.reason || null;
    const done = (edge, output) => ({ kind: 'success', output, context_patch: { program_confirmation: output }, next_node_id: node.outputs?.[edge] || null });
    if (!['confirmed', 'review_required'].includes(outcome) || outcome === 'confirmed' && reason
      || outcome === 'review_required' && !Object.hasOwn(C.reasons, reason)) C.fail('program_details_result_invalid');
    const request = await fromExecution(execution);
    return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      await deps.stop.assertExecutionActive(execution, transaction);
      const scope = await currentSource(request, transaction, true), previous = await resultFor(request, transaction);
      if (!scope) return done('on_fail', { applied: false, reason: 'source_changed' });
      if (previous) return done('on_success', { applied: false, result: previous.metadata.state, reason: previous.metadata.reason });
      const fresh = await db.FlowExecutionV2.findByPk(execution.id, { transaction, lock: transaction.LOCK.UPDATE });
      const reply = fresh.context?.program_confirmation || {}, supplied = context.program_confirmation || {};
      if (reply.response_version !== supplied.response_version || C.time(reply.response_buffer_until) > +now()) {
        return { kind: 'success', output: { applied: false, reason: 'response_changed' }, next_node_id: reply.wait_node_id || node.outputs?.on_fail || null };
      }
      const transport = await delivery(request); let proof = null;
      if (outcome === 'confirmed' || ['patient_requested_changes', 'response_unclear'].includes(reason)) {
        const conversation = transport.message && await db.Conversation.findByPk(transport.message.conversation_id, { transaction });
        proof = conversation && await replyBatch(request, transport.message, reply.response_message_ids, conversation, transaction);
        if (!proof || proof.response_version !== reply.response_version || proof.response_text !== reply.response_text || proof.reply_answer !== reply.reply_answer) return done('on_fail', { applied: false, reason: 'reply_not_correlated' });
        if (outcome === 'confirmed' && proof.reply_conflict) {
          await db.PatientOperationalEvent.create({ patient_id: request.patient_id, clinic_id: request.clinic_id, actor_user_id: null,
            event_type: C.TRANSITION, source: 'automation_v2', channel: 'whatsapp', occurred_at: now(), metadata: {
              schema_version: C.SCHEMA, request_event_id: Number(request.id), state: 'review_required', reason: 'response_unclear',
              receipt_id: request.metadata.notice.receipt_id, snapshot_sha256: request.metadata.notice.snapshot_sha256,
              inbound_message_ids: proof.response_message_ids, resolved_at: now().toISOString(), updated_appointment_ids: [], attendance_confirmed: false,
            } }, { transaction });
          return done('on_fail', { applied: true, result: 'review_required', reason: 'response_unclear', reason_text: C.reasons.response_unclear,
            appointment_ids: [], attendance_confirmed: false });
        }
        const intent = outcome === 'confirmed' ? 'correct' : 'changes';
        const aiProof = scope.template.nodes.filter(node => node.type === 'condition/ai_analysis' && node.config?.preset_key === 'custom').some(node => {
          const output = context.outputs?.[node.id], evidence = String(output?.evidence || '').trim();
          return output?._program_confirmation_response_version === proof.response_version && output.intent === intent && output.unequivocal === true
            && typeof output.confidence === 'number' && output.confidence >= 0.9 && output.confidence <= 1 && evidence && proof.response_text.includes(evidence);
        });
        if (reason !== 'response_unclear' && proof.reply_answer !== (outcome === 'confirmed' ? 'yes' : 'no') && !(!proof.reply_answer && aiProof)) return done('on_fail', { applied: false, reason: 'reply_proof_required' });
      } else if (reason === 'no_response') {
        if (reply.response_message_id || transport.status !== 'timed_out') return done('on_fail', { applied: false, reason: 'deadline_not_elapsed' });
      } else if (reason === 'delivery_failed') {
        const sends = scope.template.nodes.filter(node => node.type === 'action/send_whatsapp').map(node => node.id);
        const failed = await db.FlowExecutionLogV2.findOne({ where: { flow_execution_id: execution.id, node_id: { [Op.in]: sends }, status: 'error' }, transaction });
        if (transport.status !== 'delivery_failed' || !transport.message && !failed) return done('on_fail', { applied: false, reason: 'delivery_failure_required' });
      } else return done('on_fail', { applied: false, reason: 'result_not_supported' });
      const expiredConfirmation = outcome === 'confirmed' && hasStarted(request);
      const finalOutcome = expiredConfirmation ? 'review_required' : outcome;
      const finalReason = expiredConfirmation ? 'appointment_started' : reason;
      const changed = [];
      if (finalOutcome === 'confirmed') for (const appointment of scope.appointments) {
        if (!request.metadata.notice.membership.some(row => row.appointment_id === Number(appointment.id_cita))) continue;
        if (!['pendiente', 'info_enviada', 'reprogramada'].includes(appointment.estado)) continue;
        const before = appointment.estado;
        await appointment.update({ estado: 'info_confirmada' }, { transaction });
        await require('./appointmentActivity.service').recordAppointmentStatusChange({ appointment, previousStatus: before, newStatus: 'info_confirmada',
          actorUserId: null, source: 'automation_v2', transaction, eventModel: db.PatientOperationalEvent,
          metadata: { flow_execution_id: Number(execution.id), program_booking_request_event_id: Number(request.id),
            confirmation_kind: 'details_only', no_attendance: true } });
        changed.push(C.plain(appointment));
      }
      const resolved = await db.PatientOperationalEvent.create({ patient_id: request.patient_id, clinic_id: request.clinic_id,
        actor_user_id: null, event_type: C.TRANSITION, source: 'automation_v2', channel: proof ? 'whatsapp' : 'internal', occurred_at: now(),
        metadata: { schema_version: C.SCHEMA, request_event_id: Number(request.id), state: finalOutcome, reason: finalReason,
          receipt_id: request.metadata.notice.receipt_id, snapshot_sha256: request.metadata.notice.snapshot_sha256,
          inbound_message_ids: proof?.response_message_ids || [], resolved_at: now().toISOString(),
          updated_appointment_ids: changed.map(row => Number(row.id_cita)), attendance_confirmed: false } }, { transaction });
      if (changed.length && deps.emitAppointments) transaction.afterCommit(() => deps.emitAppointments(changed));
      return done(expiredConfirmation ? 'on_fail' : 'on_success', { applied: true, result: finalOutcome, reason: finalReason, reason_text: C.reasons[finalReason] || null,
        revision: Number(resolved.id), appointment_ids: changed.map(row => Number(row.id_cita)), attendance_confirmed: false });
    });
  }
  async function withNotification({ execution, node }, createNotification) {
    const request = await fromExecution(execution), resolved = await resultFor(request);
    if (!resolved || resolved.metadata.state !== 'review_required' || !await currentSource(request)) return { kind: 'success', output: { notifications_created: 0 }, next_node_id: node.outputs?.on_success || null };
    const blocked = request.metadata.delivery_disabled_reason;
    const explanation = blocked === 'program_details_body_too_long'
      ? 'El programa está guardado, pero no se ha enviado el resumen: todas las fechas no caben en un único mensaje. Revisa las citas con el paciente.'
      : C.reasons[resolved.metadata.reason] || 'Revisa las citas del programa';
    return createNotification({ request, snapshot: { ...resolved.metadata, reason_text: explanation } });
  }
  async function view({ voucherId }) {
    const request = await requestForVoucher(voucherId);
    if (!request) return { status: 'not_available', reason: enabled() ? 'not_requested' : 'runtime_disabled', sent: false };
    return C.publicState(request, await resultFor(request), await messageFor(request));
  }
  return { recordBookingReceipt, dispatch, sendPreflight, sendEnvelope, authorizeEligibility, authorizeTransport,
    waitContext, inbound, attestAnalysis, resolveAction, withNotification, view, current, fromExecution, delivery, replyProof, replyBatch };
}
function defaultDependencies(db) {
  const engine = () => require('./flowEngineV2.service');
  return { db, nativeOnly: true, engine: { computeQuietHoursDelayMs: options => engine().computeQuietHoursDelayMs(options) },
    enqueueJob: (...args) => require('./jobRequests.service').enqueueUniqueJobRequest(...args),
    stop: { createExecution: (...args) => require('../lib/automation-runtime-stop').createExecution(...args),
      assertExecutionActive: (...args) => require('../lib/automation-runtime-stop').assertExecutionActive(...args) },
    resolveAppointmentTemplate: (...args) => require('./appointmentAutomationV2Runtime.service').resolveTemplateForCitaEvent(...args),
    authorizeActor: request => require('../lib/access-policy').assertUserCanAccessFeature({ actorId: request.actor_user_id,
      clinicId: request.clinic_id, featureKey: 'appointments.manage' }),
    communicationAllowed: options => require('./marketingOptOut.service').assertAutomationCommunicationAllowed(options),
    wake: (execution, transaction, dueAt) => db.sequelize.query("UPDATE JobRequests SET next_run_at=:dueAt WHERE type='automations_v2_execute' AND status IN ('pending','waiting') AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.execution_id'))=:execution AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.__runtime_namespace'))=:namespace", {
      replacements: { dueAt, execution: String(execution.id), namespace: execution.waiting_meta?.runtime_namespace
        || execution.context?.program_confirmation?.runtime_namespace || require('./jobRequests.service').getCurrentRuntimeNamespace() }, transaction }),
    deliveryReady: async (clinicId, template, transaction, language = 'es') => {
      const sender = await engine().resolveScheduledWhatsappSenderConfig({ clinicId });
      if (!sender?.originId || !sender.phoneNumberId || !sender.wabaId || sender.routingUnavailable || sender.authorizedBroker?.sendEnabled !== true) return false;
      const asset = await db.ClinicMetaAsset.findByPk(sender.originId, { transaction });
      if (!asset?.isActive || String(asset.phoneNumberId) !== String(sender.phoneNumberId) || String(asset.wabaId) !== String(sender.wabaId)) return false;
      const health = require('./whatsappAccountHealth.service').summarizeAssetHealth(asset);
      if (health?.can_send !== true || health.is_stale || !['healthy', 'degraded'].includes(health.state)) return false;
      for (const node of template.nodes.filter(value => value.type === 'action/send_whatsapp'
        && (!A.EVENTS.includes(template.trigger_type) || A.programNodeIds(template).includes(value.id)))) {
        const selected = await engine()._loadConfiguredWhatsappTemplate(node.config, { trigger: { data: { clinic_id: clinicId } } },
          { targetWabaId: String(sender.wabaId), expectedLocale: language });
        const stored = selected?.id ? await db.WhatsappTemplate.findByPk(selected.id, { transaction }) : null;
        if (!C.templateValid(stored, language) || String(stored.waba_id) !== String(sender.wabaId)) return false;
      }
      return true;
    },
    emitAppointments: rows => {
      const io = require('./socket.service').getIO(); if (!io) return;
      for (const row of rows) io.to(`clinic:${row.clinica_id}`).emit('appointment:updated', { appointment_id: Number(row.id_cita),
        clinic_id: Number(row.clinica_id), patient_id: Number(row.paciente_id), doctor_id: row.doctor_id || null,
        instalacion_id: row.instalacion_id || null, tratamiento_id: row.tratamiento_id || null, estado: row.estado,
        inicio: row.inicio, fin: row.fin, updated_at: row.updatedAt || row.updated_at });
    } };
}
let runtime;
const current = () => runtime ||= createRuntime(defaultDependencies(require('../../models')));
module.exports = { createRuntime, current,
  recordBookingReceipt: ({ db, now, ...values }) => createRuntime({ ...defaultDependencies(db), ...(now ? { now: () => now } : {}) }).recordBookingReceipt(values) };

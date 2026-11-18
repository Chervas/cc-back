'use strict';

const { Op } = require('sequelize');
const { careState } = require('../lib/appointment-care');
const { TEMPORARY_FOCUSED_ACCOUNT, TEMPORARY_DIRECTOR_CLINICS } = require('../lib/temporary-quickchat-focus');

const SOURCE = 'temporary_patient_direction';
const KEY_PREFIX = 'temporary-patient-direction:';
const plain = row => row?.get ? row.get({ plain: true }) : row;
const scoped = row => row?.channel === 'whatsapp' && TEMPORARY_DIRECTOR_CLINICS.includes(Number(row.clinic_id));
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const terminalLead = lead => lead.archived_at || ['descartado', 'acudio_cita', 'convertido'].includes(lead.status_lead);
const abandonedLead = lead => lead.archived_at || lead.status_lead === 'descartado';

function createTemporaryPatientDirectionService(db, {
  notify = () => {}, warn = () => {}, now = () => new Date(), patientContextService = null, patientAttentionService = null,
  campaignResponsibility = null,
} = {}) {
  async function safe(work) {
    try { return await work(); }
    catch (error) { warn(error?.original?.code || error?.code || 'temporary_attention_unavailable'); return null; }
  }

  async function director() {
    const user = plain(await db.Usuario.findByPk(TEMPORARY_FOCUSED_ACCOUNT.userId, {
      attributes: ['id_usuario', 'email_usuario', 'nombre', 'avatar'],
    }));
    return String(user?.email_usuario || '').trim().toLowerCase() === TEMPORARY_FOCUSED_ACCOUNT.email ? user : null;
  }

  function eventWhere(conversationIds, leadIds = []) {
    return { [Op.or]: [{ conversation_id: { [Op.in]: conversationIds } },
      ...(leadIds.length ? [{ 'metadata.lead_intake_id': { [Op.in]: leadIds } }] : [])], message_type: 'event',
      automation_delivery_key: { [Op.like]: `${KEY_PREFIX}%` } };
  }

  function stateFrom(events, conversation, lead = null) {
    const valid = events.filter(row => row.metadata?.source === SOURCE
      && Number(row.metadata.clinic_id) === Number(conversation.clinic_id)
      && Number(row.metadata.director_user_id) === TEMPORARY_FOCUSED_ACCOUNT.userId
      && (positive(row.metadata.lead_intake_id)
        ? Number(row.metadata.lead_intake_id) === Number(lead?.id)
        : Number(row.conversation_id) === Number(conversation.id)
          // Legacy marks have no request identity. Only inherit marks occurring
          // during this request; an older handoff must not consume a new lead.
          && (!lead || !lead.created_at || !row.sent_at
            || new Date(row.sent_at) >= new Date(lead.created_at))));
    const start = valid.find(row => row.metadata.kind === 'temporary_patient_direction_started');
    const handoff = valid.find(row => row.metadata.kind === 'temporary_patient_direction_handoff');
    return { start, handoff };
  }

  function contexts() {
    if (!patientContextService) patientContextService = require('./leadPatientContext.service').createLeadPatientContextService(db);
    return patientContextService;
  }

  function attentionService() {
    // Lazy: the attention service imports the temporary scope constants too.
    if (!patientAttentionService) patientAttentionService = require('./leadPatientAttention.service').createLeadPatientAttentionService(db);
    return patientAttentionService;
  }

  function campaigns() {
    return campaignResponsibility || require('./leadCampaignResponsibility.service').createLeadCampaignResponsibilityService(db);
  }

  function requestFrom(lead, context, attention = {}, eligible = false) {
    context = context || { relationship: 'unknown', patient_id: null, clinic_id: null,
      clinic_name: null, same_clinic: null, captured_at: null, reason: 'context_unavailable', request_kind: 'commercial' };
    const decision = ['director', 'clinic'].includes(attention.decision) ? attention.decision : null;
    return { lead, context, decision, attention,
      review: ['existing_patient', 'possible_patient'].includes(context.relationship),
      blocked: Boolean(!eligible || (lead.asignado_a && Number(lead.asignado_a) !== TEMPORARY_FOCUSED_ACCOUNT.userId)
        || (decision === 'director' && Number(attention.director_user_id) !== TEMPORARY_FOCUSED_ACCOUNT.userId)),
    };
  }

  async function requestContext(conversation, { transaction = null, lead = null } = {}) {
    if (!positive(conversation.lead_id)) return null;
    lead = lead || plain(await db.LeadIntake.findByPk(conversation.lead_id, { transaction }));
    if (!lead || Number(lead.clinica_id) !== Number(conversation.clinic_id)) return { blocked: true };
    const attention = (await attentionService().decisions([Number(lead.id)], { transaction })).get(Number(lead.id));
    let context;
    try {
      context = await contexts().get(lead, { transaction });
    } catch (error) {
      warn(error?.code || 'lead_patient_context_unavailable');
    }
    const eligible = (await campaigns().forLeads([lead], { transaction })).get(Number(lead.id)) === true;
    return requestFrom(lead, context, attention, eligible);
  }

  async function requestContexts(rows) {
    const ids = [...new Set(rows.map(row => Number(row.lead_id)).filter(positive))];
    if (!ids.length) return new Map();
    const leads = (await db.LeadIntake.findAll({ where: { id: { [Op.in]: ids } }, raw: true })).map(plain);
    const byId = new Map(leads.map(lead => [Number(lead.id), lead]));
    const byContext = new Map();
    for (const row of rows) {
      const lead = byId.get(Number(row.lead_id));
      if (lead && Number(lead.clinica_id) === Number(row.clinic_id) && row.patient_context) {
        byContext.set(Number(lead.id), row.patient_context);
      }
    }
    const missing = leads.filter(lead => !byContext.has(Number(lead.id)));
    if (missing.length) {
      try {
        for (const lead of await contexts().enrich(missing, { transaction: null })) {
          byContext.set(Number(lead.id), lead.patient_context);
        }
      } catch (error) { warn(error?.code || 'lead_patient_context_unavailable'); }
    }
    const decisions = await attentionService().decisions(ids, { transaction: null });
    const eligibility = await campaigns().forLeads(leads);
    return new Map(leads.map(lead => [Number(lead.id), requestFrom(lead,
      byContext.get(Number(lead.id)), decisions.get(Number(lead.id)), eligibility.get(Number(lead.id)) === true)]));
  }

  function view(user, request, start = null, appointment = null) {
    const pending = request?.review && request.decision !== 'director';
    return { id: start?.id || null, status: pending ? 'pending_review' : 'active', mode: 'temporary_clinic_phone',
      director_user_id: user.id_usuario, director_name: user.nombre || 'Graci', director_avatar: user.avatar || null,
      lead_id: request?.lead.id || null, patient_context: request?.context || null,
      request_kind: request?.attention.request_kind || request?.context.request_kind || 'commercial',
      decision: request?.decision || null, first_appointment_id: pending ? null : appointment?.id_cita || null,
      started_at: pending ? null : start?.metadata.started_at || request?.attention.decided_at || null,
      start_reason: pending ? 'lead_patient_review' : start?.metadata.start_reason || 'lead_patient_decision' };
  }

  async function provenance(conversation, actorUserId, transaction) {
    // A human reply or a patient created by Graci is not a campaign request.
    // Only the already gated, exact lead can establish this temporary scope.
    if (conversation.lead_id && db.LeadIntake) {
      const lead = plain(await db.LeadIntake.findByPk(conversation.lead_id, { transaction }));
      if (Number(lead?.clinica_id) === Number(conversation.clinic_id)
          && !lead.archived_at && !['descartado', 'acudio_cita', 'convertido'].includes(lead.status_lead)
          && (!lead.asignado_a || Number(lead.asignado_a) === TEMPORARY_FOCUSED_ACCOUNT.userId)) {
        return { reason: 'lead_received', since: lead.created_at || now() };
      }
    }
    return null;
  }

  function firstAppointmentScope(conversation, since, request) {
    let identity = positive(conversation.patient_id) ? { paciente_id: conversation.patient_id }
      : positive(conversation.lead_id) ? { lead_intake_id: conversation.lead_id } : null;
    if (request?.review) {
      const patientId = conversation.patient_id || request.context.patient_id;
      if (!positive(patientId) || (positive(request.context.patient_id)
          && Number(patientId) !== Number(request.context.patient_id))) return null;
      identity = { paciente_id: patientId, lead_intake_id: request.lead.id };
      if (new Date(request.lead.created_at) > new Date(since)) since = request.lead.created_at;
    }
    if (!identity) return null;
    const leadId = positive(request?.lead?.id) ? Number(request.lead.id) : null;
    const where = { clinica_id: conversation.clinic_id, ...identity,
      source_system: null, [Op.and]: [{ [Op.or]: [{ es_provisional: false }, { es_provisional: null }] },
        ...(request?.review ? [{ [Op.or]: [{ care_legacy_attendance: false }, { care_legacy_attendance: null }] }] : []),
        ...(!request?.review && leadId ? [{ [Op.or]: [{ lead_intake_id: leadId }, { lead_intake_id: null }] }] : [])],
      estado: { [Op.notIn]: ['cancelada', 'no_asistio'] }, inicio: { [Op.gte]: new Date(since) } };
    return { where, clinicId: Number(conversation.clinic_id), patientId: positive(identity.paciente_id) ? Number(identity.paciente_id) : null,
      exactLeadId: positive(identity.lead_intake_id) ? Number(identity.lead_intake_id) : null,
      leadId, review: !!request?.review, since: +new Date(since) };
  }

  async function firstAppointment(conversation, since, transaction, request) {
    const scope = firstAppointmentScope(conversation, since, request);
    if (!scope) return null;
    return plain(await db.CitaPaciente.findOne({ where: scope.where,
      order: [['inicio', 'ASC'], ['id_cita', 'ASC']], transaction }));
  }

  function appointmentMatchesScope(row, scope) {
    return Number(row.clinica_id) === scope.clinicId
      && (!scope.patientId || Number(row.paciente_id) === scope.patientId)
      && (!scope.exactLeadId || Number(row.lead_intake_id) === scope.exactLeadId)
      && (scope.review || !scope.leadId || row.lead_intake_id == null || Number(row.lead_intake_id) === scope.leadId)
      && row.source_system == null && !row.es_provisional
      && (!scope.review || !row.care_legacy_attendance)
      && !['cancelada', 'no_asistio'].includes(row.estado) && +new Date(row.inicio) >= scope.since;
  }

  async function ensure(conversationId, actorUserId = null) {
    if (!db.Conversation || !db.Message || !db.Usuario || !db.CitaPaciente) return null;
    const user = await director();
    if (!user) return null;
    const changed = [];
    const result = await db.sequelize.transaction(async transaction => {
      // Match decide(): chat before lead, with no snapshot reads before both
      // locks. The subsequent audit read sees the decision that just committed.
      const conversation = plain(await db.Conversation.findByPk(conversationId, { transaction, lock: transaction.LOCK.UPDATE }));
      if (!scoped(conversation)
          || (conversation.assignee_id && Number(conversation.assignee_id) !== TEMPORARY_FOCUSED_ACCOUNT.userId)) return null;
      const lead = positive(conversation.lead_id) && db.LeadIntake
        ? plain(await db.LeadIntake.findByPk(conversation.lead_id, { transaction, lock: transaction.LOCK.UPDATE })) : null;
      const request = await requestContext(conversation, { transaction, lead });
      let { start, handoff } = stateFrom((await db.Message.findAll({ where: eventWhere([conversation.id], lead ? [lead.id] : []),
        order: [['id', 'ASC']], transaction })).map(plain), conversation, lead);
      if (!request || handoff || request.blocked || request.decision === 'clinic'
          || (request && (abandonedLead(request.lead) || !start && terminalLead(request.lead)))) return null;
      const pending = request.review && request.decision !== 'director';
      if (pending) {
        const appointment = await firstAppointment(conversation, request.lead.created_at, transaction, request);
        if (!appointment || !(require('../lib/status-catalog').hasAttendedAppointment(appointment) || careState(appointment).arrived_at)) {
          return view(user, request);
        }
      }
      if (!start && !pending) {
        const origin = request?.decision === 'director'
          ? { reason: 'lead_patient_decision', since: request.lead.created_at || now() }
          : await provenance(conversation, actorUserId, transaction);
        if (!origin) return null;
        if (request) {
          await db.LeadIntake.update({ asignado_a: TEMPORARY_FOCUSED_ACCOUNT.userId }, { where: {
            id: conversation.lead_id, clinica_id: conversation.clinic_id, asignado_a: null,
          }, transaction });
          const lead = plain(await db.LeadIntake.findByPk(conversation.lead_id, { transaction }));
          if (Number(lead?.asignado_a) !== TEMPORARY_FOCUSED_ACCOUNT.userId) return null;
        }
        start = plain(await db.Message.create({ conversation_id: conversation.id, sender_id: null,
          direction: 'outbound', message_type: 'event', status: 'sent', sent_at: now(),
          automation_delivery_key: request ? `${KEY_PREFIX}start:lead:${conversation.clinic_id}:${request.lead.id}` : `${KEY_PREFIX}start:${conversation.id}`,
          content: `Esta conversación está siendo atendida por nuestra directora de pacientes humana, ${user.nombre || 'Graci'}.`,
          metadata: { source: SOURCE, kind: 'temporary_patient_direction_started', clinic_id: conversation.clinic_id,
            director_user_id: user.id_usuario, director_name: user.nombre || 'Graci',
            lead_intake_id: request?.lead.id || null, patient_id: conversation.patient_id || request?.context.patient_id || null,
            start_reason: origin.reason, started_at: new Date(origin.since).toISOString() },
        }, { transaction }));
        changed.push(start);
      }
      const appointment = await firstAppointment(conversation, start?.metadata.started_at || request.lead.created_at, transaction, request);
      if (appointment && (require('../lib/status-catalog').hasAttendedAppointment(appointment) || careState(appointment).arrived_at)) {
        const event = await db.Message.create({ conversation_id: conversation.id, sender_id: null,
          direction: 'outbound', message_type: 'event', status: 'sent', sent_at: now(),
          automation_delivery_key: request ? `${KEY_PREFIX}handoff:lead:${conversation.clinic_id}:${request.lead.id}` : `${KEY_PREFIX}handoff:${conversation.id}`,
          content: 'Desde este momento, este paciente pasa a ser atendido por tu equipo.\nMotivo: el paciente ya ha acudido a su cita.',
          metadata: { source: SOURCE, kind: 'temporary_patient_direction_handoff', clinic_id: conversation.clinic_id,
            director_user_id: user.id_usuario, director_name: user.nombre || 'Graci', appointment_id: appointment.id_cita,
            lead_intake_id: request?.lead.id || null, patient_id: appointment.paciente_id || null },
        }, { transaction });
        changed.push(plain(event));
        return null;
      }
      return view(user, request, start, appointment);
    });
    for (const event of changed) await safe(() => notify(event));
    return result;
  }

  async function observeConversation(row, { transaction = null, actorUserId = null } = {}) {
    const conversation = plain(row);
    if (!scoped(conversation)) return row;
    const work = () => safe(() => ensure(conversation.id, actorUserId));
    // Attention is an after-commit projection: its failure must never roll back
    // intake, reception, a clinical mutation or an outbound message.
    if (transaction?.afterCommit) transaction.afterCommit(work);
    else await work();
    return row;
  }

  async function observePatient(patient, actorUserId) {
    const row = plain(patient);
    if (Number(actorUserId) !== TEMPORARY_FOCUSED_ACCOUNT.userId
        || !TEMPORARY_DIRECTOR_CLINICS.includes(Number(row?.clinica_id)) || !row.telefono_movil) return null;
    return safe(async () => {
      const conversation = await require('../lib/canonical-conversation').findCanonicalWhatsappConversation({
        clinicId: row.clinica_id, patientId: row.id_paciente, contactId: row.telefono_movil, createIfMissing: true,
        requireExactContact: true,
      });
      return conversation && ensure(conversation.id, actorUserId);
    });
  }

  async function observeAppointment(row, { transaction = null } = {}) {
    const appointment = plain(row);
    if (!TEMPORARY_DIRECTOR_CLINICS.includes(Number(appointment?.clinica_id))) return null;
    const work = () => safe(async () => {
      const identities = [];
      if (positive(appointment.paciente_id)) identities.push({ patient_id: appointment.paciente_id });
      if (positive(appointment.lead_intake_id)) identities.push({ lead_id: appointment.lead_intake_id });
      if (!identities.length) return null;
      const conversations = await db.Conversation.findAll({ where: {
        clinic_id: appointment.clinica_id, channel: 'whatsapp', [Op.or]: identities,
      } });
      for (const conversation of conversations) await ensure(conversation.id);
      if (!conversations.length && Number(appointment.created_by) === TEMPORARY_FOCUSED_ACCOUNT.userId) {
        const patient = await db.Paciente.findByPk(appointment.paciente_id);
        if (patient) await observePatient(patient, TEMPORARY_FOCUSED_ACCOUNT.userId);
      }
    });
    if (transaction?.afterCommit) transaction.afterCommit(work);
    else await work();
    return null;
  }

  async function enrich(conversations) {
    const rows = conversations.map(plain), scopedRows = rows.filter(scoped);
    if (!scopedRows.length || !db.Message || !db.Usuario) return rows;
    const result = await safe(async () => {
      const user = await director();
      if (!user) return rows;
      const events = (await db.Message.findAll({ where: eventWhere(scopedRows.map(row => row.id),
        scopedRows.map(row => Number(row.lead_id)).filter(positive)),
      attributes: ['id', 'conversation_id', 'metadata', 'sent_at'], order: [['id', 'ASC']], raw: true })).map(plain);
      const requests = await requestContexts(scopedRows);
      const enriched = [];
      for (const row of rows) {
        if (!scoped(row)) { enriched.push(row); continue; }
        let request = positive(row.lead_id) ? requests.get(Number(row.lead_id)) : null;
        if (positive(row.lead_id) && (!request || Number(request.lead.clinica_id) !== Number(row.clinic_id))) request = { blocked: true };
        const state = stateFrom(events, row, request?.lead);
        let direction = row.patient_direction || null;
        if (!request || state.handoff || request.blocked || request.decision === 'clinic'
            || (row.assignee_id && Number(row.assignee_id) !== TEMPORARY_FOCUSED_ACCOUNT.userId)
            || (request && (abandonedLead(request.lead) || !state.start && terminalLead(request.lead)))) direction = null;
        else if (request?.review || request?.decision === 'director') direction = view(user, request, state.start);
        else if (!direction && state.start) direction = view(user, request, state.start);
        enriched.push({ ...row, patient_direction: direction });
      }
      return enriched;
    });
    return result || rows;
  }

  // Read the already effective direction for a request whose patient-origin
  // mark may have been written before the conversation acquired lead_id.
  // Never infer ownership from a phone, name, patient existence or appointment
  // confirmation. This projection performs no ensure/create/handoff operation.
  async function effectiveForLeads(leads, { transaction = null, campaignEligibility = null } = {}) {
    if (!db.Conversation || !db.Message || !db.CitaPaciente) return new Map();
    const eligibility = campaignEligibility || await campaigns().forLeads(leads, { transaction });
    const candidates = leads.filter(lead => positive(lead.id) && eligibility.get(Number(lead.id)) === true
      && TEMPORARY_DIRECTOR_CLINICS.includes(Number(lead.clinica_id)) && !terminalLead(lead));
    if (!candidates.length) return new Map();
    const result = await safe(async () => {
      const conversations = (await db.Conversation.findAll({ where: { channel: 'whatsapp',
        [Op.or]: candidates.map(lead => ({ clinic_id: Number(lead.clinica_id), lead_id: Number(lead.id) })),
      }, attributes: ['id', 'clinic_id', 'channel', 'patient_id', 'lead_id'], raw: true, transaction })).map(plain);
      const ids = conversations.map(row => Number(row.id)).filter(positive);
      if (!ids.length) return new Map();
      const events = (await db.Message.findAll({ where: eventWhere(ids),
        attributes: ['id', 'conversation_id', 'metadata', 'sent_at'], order: [['id', 'ASC']], raw: true, transaction })).map(plain);
      const assignments = db.PatientDirectionAssignment ? (await db.PatientDirectionAssignment.findAll({
        where: { conversation_id: { [Op.in]: ids } }, attributes: ['conversation_id', 'clinic_id', 'patient_id',
          'lead_intake_id', 'status', 'end_reason', 'ended_at'], raw: true, transaction,
      })).map(plain) : [];
      const effective = new Map(), awaitingAppointments = [];
      for (const lead of candidates) {
        const matching = conversations.filter(row => scoped(row)
          && Number(row.lead_id) === Number(lead.id) && Number(row.clinic_id) === Number(lead.clinica_id));
        // An ambiguous conversation identity is not an ownership proof.
        if (matching.length !== 1 || !positive(matching[0].patient_id)) continue;
        const conversation = matching[0];
        const exactEvents = events.filter(row => Number(row.conversation_id) === Number(conversation.id)
          && positive(row.metadata?.patient_id) && Number(row.metadata.patient_id) === Number(conversation.patient_id));
        const state = stateFrom(exactEvents, conversation, lead);
        const started = +new Date(state.start?.metadata.started_at || state.start?.sent_at || lead.created_at);
        const entered = +new Date(lead.created_at);
        if (!Number.isFinite(started) || !Number.isFinite(entered) || started < entered) continue;
        if (state.handoff) {
          effective.set(Number(lead.id), { state: 'completed' });
          continue;
        }
        const threshold = Math.max(started, +new Date(lead.patient_attention?.decided_at) || started);
        const ended = assignments.find(row => Number(row.conversation_id) === Number(conversation.id)
          && Number(row.clinic_id) === Number(conversation.clinic_id)
          && Number(row.patient_id) === Number(conversation.patient_id)
          && (!positive(row.lead_intake_id) || Number(row.lead_intake_id) === Number(lead.id))
          && ['handoff_pending', 'handed_off', 'ended_attended', 'ended_discarded', 'ended_service_disabled'].includes(row.status)
          && (!row.ended_at || +new Date(row.ended_at) >= threshold));
        if (ended) {
          effective.set(Number(lead.id), { state: ended.end_reason === 'service_disabled'
            || ended.status === 'ended_service_disabled' ? 'clinic' : 'completed' });
          continue;
        }
        const scope = firstAppointmentScope(conversation, new Date(started),
          { lead, context: lead.patient_context, review: ['existing_patient', 'possible_patient'].includes(lead.patient_context?.relationship) });
        if (scope) awaitingAppointments.push({ leadId: Number(lead.id), scope });
      }
      // One bounded read per batch, rather than one findOne per lead. Retain
      // the same first-by-start/id selection and fail closed on an incomplete
      // history; never invent attendance to compensate for a read limit.
      for (let offset = 0; offset < awaitingAppointments.length; offset += 100) {
        const batch = awaitingAppointments.slice(offset, offset + 100);
        const appointments = (await db.CitaPaciente.findAll({ where: { [Op.or]: batch.map(item => item.scope.where) },
          attributes: ['id_cita', 'clinica_id', 'paciente_id', 'lead_intake_id', 'source_system', 'es_provisional',
            'care_legacy_attendance', 'estado', 'inicio', 'arrived_at', 'care_started_at', 'care_completed_at', 'care_schedule_start'],
          order: [['inicio', 'ASC'], ['id_cita', 'ASC']], limit: 5001, raw: true, transaction })).map(plain);
        if (appointments.length > 5000) throw Object.assign(Error('temporary_direction_history_limit'), { code: 'temporary_direction_history_limit' });
        for (const item of batch) {
          const appointment = appointments.find(row => appointmentMatchesScope(row, item.scope));
          if (appointment && (require('../lib/status-catalog').hasAttendedAppointment(appointment) || careState(appointment).arrived_at)) {
            effective.set(item.leadId, { state: 'completed' });
          } else effective.set(item.leadId, { state: 'director', director_user_id: TEMPORARY_FOCUSED_ACCOUNT.userId });
        }
      }
      return effective;
    });
    return result || new Map();
  }

  return { ensure: (...args) => safe(() => ensure(...args)), observeConversation, observePatient, observeAppointment, enrich, effectiveForLeads };
}

let runtime;
function service() {
  if (!runtime) runtime = createTemporaryPatientDirectionService(require('../../models'), {
    warn: code => console.warn('[temporary-patient-direction]', code),
    notify: event => require('./socket.service').getIO()?.to(`clinic:${event.metadata.clinic_id}`).emit('message:created',
      require('../lib/socket-view-invalidation').invalidation('message:created', { id: event.id, conversation_id: event.conversation_id })),
  });
  return runtime;
}

module.exports = { createTemporaryPatientDirectionService,
  observeConversation: (...args) => service().observeConversation(...args),
  observePatient: (...args) => service().observePatient(...args),
  observeAppointment: (...args) => service().observeAppointment(...args),
  enrich: (...args) => service().enrich(...args),
  effectiveForLeads: (...args) => service().effectiveForLeads(...args),
};

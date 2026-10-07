'use strict';

const { Op } = require('sequelize');
const { careState } = require('../lib/appointment-care');
const { TEMPORARY_FOCUSED_ACCOUNT, TEMPORARY_DIRECTOR_CLINICS } = require('../lib/temporary-quickchat-focus');

const SOURCE = 'temporary_patient_direction';
const KEY_PREFIX = 'temporary-patient-direction:';
const plain = row => row?.get ? row.get({ plain: true }) : row;
const scoped = row => row?.channel === 'whatsapp' && TEMPORARY_DIRECTOR_CLINICS.includes(Number(row.clinic_id));
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function createTemporaryPatientDirectionService(db, { notify = () => {}, warn = () => {}, now = () => new Date() } = {}) {
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

  function eventWhere(conversationIds) {
    return { conversation_id: { [Op.in]: conversationIds }, message_type: 'event',
      automation_delivery_key: { [Op.like]: `${KEY_PREFIX}%` } };
  }

  function stateFrom(events, conversation) {
    const valid = events.filter(row => row.metadata?.source === SOURCE
      && Number(row.metadata.clinic_id) === Number(conversation.clinic_id)
      && Number(row.metadata.director_user_id) === TEMPORARY_FOCUSED_ACCOUNT.userId);
    const start = valid.find(row => row.metadata.kind === 'temporary_patient_direction_started');
    const handoff = valid.find(row => row.metadata.kind === 'temporary_patient_direction_handoff');
    return { start, handoff };
  }

  async function provenance(conversation, actorUserId, transaction) {
    if (Number(actorUserId) === TEMPORARY_FOCUSED_ACCOUNT.userId) return { reason: 'human_contact', since: now() };
    if (conversation.lead_id && db.LeadIntake) {
      const lead = plain(await db.LeadIntake.findByPk(conversation.lead_id, { transaction }));
      if (Number(lead?.clinica_id) === Number(conversation.clinic_id)
          && !lead.archived_at && !['descartado', 'acudio_cita', 'convertido'].includes(lead.status_lead)
          && (!lead.asignado_a || Number(lead.asignado_a) === TEMPORARY_FOCUSED_ACCOUNT.userId)) {
        const otherHuman = db.LeadContactAttempt && await db.LeadContactAttempt.findOne({
          where: { lead_intake_id: lead.id, usuario_id: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: TEMPORARY_FOCUSED_ACCOUNT.userId }] } },
          attributes: ['id'], transaction,
        });
        if (!otherHuman) return { reason: 'lead_received', since: lead.created_at || now() };
      }
    }
    if (conversation.patient_id) {
      if (db.PatientOperationalEvent) {
        const creation = plain(await db.PatientOperationalEvent.findOne({ where: {
          clinic_id: conversation.clinic_id, patient_id: conversation.patient_id,
          actor_user_id: TEMPORARY_FOCUSED_ACCOUNT.userId, event_type: 'patient.created',
        }, order: [['occurred_at', 'ASC']], transaction }));
        if (creation) return { reason: 'patient_created', since: creation.occurred_at };
      }
      const appointment = plain(await db.CitaPaciente.findOne({ where: {
        clinica_id: conversation.clinic_id, paciente_id: conversation.patient_id,
        created_by: TEMPORARY_FOCUSED_ACCOUNT.userId, source_system: null,
      }, order: [['created_at', 'ASC'], ['id_cita', 'ASC']], transaction }));
      if (appointment) return { reason: 'appointment_created', since: appointment.created_at || now() };
    }
    const message = plain(await db.Message.findOne({ where: {
      conversation_id: conversation.id, sender_id: TEMPORARY_FOCUSED_ACCOUNT.userId,
      direction: 'outbound', message_type: { [Op.ne]: 'event' }, automation_delivery_key: null,
    }, order: [['id', 'ASC']], transaction }));
    return message ? { reason: 'human_contact', since: message.sent_at || message.createdAt || now() } : null;
  }

  async function firstAppointment(conversation, since, transaction) {
    const identity = positive(conversation.patient_id) ? { paciente_id: conversation.patient_id }
      : positive(conversation.lead_id) ? { lead_intake_id: conversation.lead_id } : null;
    if (!identity) return null;
    return plain(await db.CitaPaciente.findOne({ where: {
      clinica_id: conversation.clinic_id, ...identity,
      source_system: null, [Op.and]: [{ [Op.or]: [{ es_provisional: false }, { es_provisional: null }] }],
      estado: { [Op.notIn]: ['cancelada', 'no_asistio'] },
      inicio: { [Op.gte]: new Date(since) },
    }, order: [['inicio', 'ASC'], ['id_cita', 'ASC']], transaction }));
  }

  async function ensure(conversationId, actorUserId = null) {
    if (!db.Conversation || !db.Message || !db.Usuario || !db.CitaPaciente) return null;
    const user = await director();
    if (!user) return null;
    const changed = [];
    const result = await db.sequelize.transaction(async transaction => {
      const conversation = plain(await db.Conversation.findByPk(conversationId, { transaction, lock: transaction.LOCK.UPDATE }));
      if (!scoped(conversation)) return null;
      let { start, handoff } = stateFrom((await db.Message.findAll({ where: eventWhere([conversation.id]),
        order: [['id', 'ASC']], transaction })).map(plain), conversation);
      if (handoff) return null;
      if (!start) {
        const origin = await provenance(conversation, actorUserId, transaction);
        if (!origin) return null;
        if (origin.reason === 'lead_received') {
          await db.LeadIntake.update({ asignado_a: TEMPORARY_FOCUSED_ACCOUNT.userId }, { where: {
            id: conversation.lead_id, clinica_id: conversation.clinic_id, asignado_a: null,
          }, transaction });
          const lead = plain(await db.LeadIntake.findByPk(conversation.lead_id, { transaction }));
          if (Number(lead?.asignado_a) !== TEMPORARY_FOCUSED_ACCOUNT.userId) return null;
        }
        start = plain(await db.Message.create({ conversation_id: conversation.id, sender_id: null,
          direction: 'outbound', message_type: 'event', status: 'sent', sent_at: now(),
          automation_delivery_key: `${KEY_PREFIX}start:${conversation.id}`,
          content: `Esta conversación está siendo atendida por nuestra directora de pacientes humana, ${user.nombre || 'Graci'}.`,
          metadata: { source: SOURCE, kind: 'temporary_patient_direction_started', clinic_id: conversation.clinic_id,
            director_user_id: user.id_usuario, director_name: user.nombre || 'Graci',
            start_reason: origin.reason, started_at: new Date(origin.since).toISOString() },
        }, { transaction }));
        changed.push(start);
      }
      const appointment = await firstAppointment(conversation, start.metadata.started_at, transaction);
      if (appointment && (appointment.estado === 'completada' || careState(appointment).arrived_at)) {
        const event = await db.Message.create({ conversation_id: conversation.id, sender_id: null,
          direction: 'outbound', message_type: 'event', status: 'sent', sent_at: now(),
          automation_delivery_key: `${KEY_PREFIX}handoff:${conversation.id}`,
          content: 'Desde este momento, este paciente pasa a ser atendido por tu equipo.\nMotivo: el paciente ya ha acudido a su cita.',
          metadata: { source: SOURCE, kind: 'temporary_patient_direction_handoff', clinic_id: conversation.clinic_id,
            director_user_id: user.id_usuario, director_name: user.nombre || 'Graci', appointment_id: appointment.id_cita },
        }, { transaction });
        changed.push(plain(event));
        return null;
      }
      return { id: start.id, status: 'active', mode: 'temporary_clinic_phone', director_user_id: user.id_usuario,
        director_name: user.nombre || 'Graci', director_avatar: user.avatar || null, first_appointment_id: appointment?.id_cita || null,
        started_at: start.metadata.started_at, start_reason: start.metadata.start_reason };
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
      const events = (await db.Message.findAll({ where: eventWhere(scopedRows.map(row => row.id)),
        attributes: ['id', 'conversation_id', 'metadata'], order: [['id', 'ASC']], raw: true })).map(plain);
      return rows.map(row => {
        if (!scoped(row) || row.patient_direction) return row;
        const state = stateFrom(events.filter(event => Number(event.conversation_id) === Number(row.id)), row);
        return { ...row, patient_direction: state.start && !state.handoff ? {
          id: state.start.id, status: 'active', mode: 'temporary_clinic_phone', director_user_id: user.id_usuario,
          director_name: user.nombre || 'Graci', director_avatar: user.avatar || null,
          started_at: state.start.metadata.started_at, start_reason: state.start.metadata.start_reason,
        } : null };
      });
    });
    return result || rows;
  }

  return { ensure: (...args) => safe(() => ensure(...args)), observeConversation, observePatient, observeAppointment, enrich };
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
};

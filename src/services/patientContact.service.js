'use strict';

const crypto = require('crypto');
const db = require('../../models');
const { getPhoneLookupCandidates, normalizePhoneDigits } = require('../lib/phone');
const { normalizeHumanName } = require('../lib/name');
const { buildPatientNameSearch, escapeLike, normalizePatientSearchQuery: normalizeContactSearchQuery } = require('../lib/patient-name-search');
const { findCanonicalWhatsappConversation } = require('../lib/canonical-conversation');

const { Op, literal } = db.Sequelize;
const {
  Paciente,
  PacienteClinica,
  Conversation,
  PatientOperationalEvent,
} = db;

const PATIENT_EVENT_TYPES = Object.freeze({
  created: 'patient.created',
  clinicLinked: 'patient.clinic_linked',
  identityReconciled: 'patient.identity_reconciled',
  whatsappAuthorized: 'patient.whatsapp_contact_authorized',
  whatsappConversationStarted: 'patient.whatsapp_conversation_started',
  phoneChanged: 'patient.whatsapp_phone_changed',
  manualAppointmentNotice: 'appointment.manual_notice_requested',
});

const ALLOWED_SOURCES = new Set([
  'agenda',
  'header_search',
  'lead_conversion',
  'patient_list',
  'patient_modal',
  'quick_chat',
  'tutor_modal',
]);

function normalizeOperationalSource(value, fallback = 'patient_modal') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  return ALLOWED_SOURCES.has(normalized) ? normalized : fallback;
}

function classifyContactSearchQuery(value) {
  const query = normalizeContactSearchQuery(value);
  const digits = query.replace(/\D+/g, '');
  const phoneCharactersOnly = /^[+\d\s()./-]+$/.test(query);
  if (phoneCharactersOnly && digits.length >= 6) return 'phone';
  if (query.includes('@')) return 'email';
  return 'name';
}

function buildFastPatientSearchWhere(query) {
  const normalized = normalizeContactSearchQuery(query);
  if (/^\d{1,32}$/.test(normalized) && normalized.length < 6) {
    return { queryType: 'history_number', where: { numero_historia: normalized.replace(/^0+/, '') }, normalizedPhone: null };
  }
  const queryType = classifyContactSearchQuery(normalized);
  if (queryType === 'phone') {
    const candidates = getPhoneLookupCandidates(normalized);
    return {
      queryType,
      where: candidates.length ? (/^\d{1,32}$/.test(normalized)
        ? { [Op.or]: [{ numero_historia: normalized.replace(/^0+/, '') }, { telefono_movil: { [Op.in]: candidates } }] }
        : { telefono_movil: { [Op.in]: candidates } }) : null,
      normalizedPhone: normalizePhoneDigits(normalized),
    };
  }
  if (queryType === 'email') {
    return {
      queryType,
      where: literal(`\`Paciente\`.\`email\` LIKE ${Paciente.sequelize.escape(`${escapeLike(normalized.toLowerCase())}%`)} ESCAPE '!'`),
      normalizedPhone: null,
    };
  }
  const name = buildPatientNameSearch(normalized, Paciente.sequelize);
  return {
    queryType,
    where: name?.where || null,
    rank: name?.rank,
    normalizedPhone: null,
  };
}

function patientClinicScopeWhere(clinicIds) {
  const ids = Array.from(new Set((clinicIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  if (!ids.length) return literal('0=1');
  const primary = ids.length === 1 ? ids[0] : { [Op.in]: ids };
  return {
    [Op.or]: [
      { clinica_id: primary },
      literal(`EXISTS (
        SELECT 1
        FROM PacienteClinicas patient_scope
        WHERE patient_scope.paciente_id = Paciente.id_paciente
          AND patient_scope.clinica_id IN (${ids.join(',')})
      )`),
    ],
  };
}

function patientContactClinicIds(patient) {
  return [Number(patient.clinica_id), ...(patient.clinicasVinculadas || []).map(link => Number(link.clinica_id))];
}

function isPatientLinkedToClinic(patient, clinicId) {
  return patientContactClinicIds(patient).includes(Number(clinicId));
}

async function recordPatientOperationalEvent({
  patientId,
  clinicId,
  actorUserId = null,
  eventType,
  source,
  channel = null,
  metadata = {},
  transaction = null,
}) {
  if (!PatientOperationalEvent) return null;
  return PatientOperationalEvent.create({
    patient_id: Number(patientId) || null,
    clinic_id: Number(clinicId),
    actor_user_id: Number(actorUserId) || null,
    event_type: eventType,
    source: normalizeOperationalSource(source),
    channel,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    occurred_at: new Date(),
  }, { transaction });
}

async function findPatientContactTargets({
  query,
  clinicIds,
  selectedClinicId,
  limit = 8,
}) {
  const search = buildFastPatientSearchWhere(query);
  if (!search.where) {
    return {
      query: normalizeContactSearchQuery(query),
      query_type: search.queryType,
      normalized_phone: search.normalizedPhone,
      items: [],
    };
  }

  const patients = await Paciente.findAll({
    where: {
      [Op.and]: [
        search.where,
        patientClinicScopeWhere(clinicIds),
      ],
    },
    attributes: ['id_paciente', 'public_id', 'nombre', 'apellidos', 'numero_historia', 'telefono_movil', 'email', 'foto', 'clinica_id'],
    include: [{
      model: PacienteClinica,
      as: 'clinicasVinculadas',
      attributes: ['clinica_id', 'es_principal'],
      required: false,
    }],
    order: [...(search.rank ? [[search.rank, 'ASC']] : []), ['nombre', 'ASC'], ['apellidos', 'ASC'], ['id_paciente', 'ASC']],
    limit: Math.min(Math.max(Number(limit) || 8, 1), 12),
    distinct: true,
  });

  const selected = Number(selectedClinicId);
  const readable = new Set(clinicIds.map(Number));
  const patientClinics = new Map();
  const patientsByClinic = new Map();
  for (const patient of patients) {
    const memberships = patientContactClinicIds(patient);
    const clinicId = selected || memberships.find(id => readable.has(id));
    if (!clinicId) continue;
    patientClinics.set(Number(patient.id_paciente), clinicId);
    if (!patientsByClinic.has(clinicId)) patientsByClinic.set(clinicId, []);
    patientsByClinic.get(clinicId).push(patient);
  }
  const clinicPatients = [...patientsByClinic].map(([clinicId, rows]) => ({
    clinic_id: clinicId,
    patient_id: { [Op.in]: rows.map(patient => Number(patient.id_paciente)) },
  }));
  const [conversations, authorizationEvents] = clinicPatients.length
    ? await Promise.all([
        Conversation.findAll({
          where: {
            channel: 'whatsapp',
            [Op.or]: clinicPatients,
          },
          attributes: ['id', 'patient_id', 'last_message_at', 'createdAt'],
          order: [['last_message_at', 'DESC'], ['createdAt', 'DESC'], ['id', 'DESC']],
          raw: true,
        }),
        PatientOperationalEvent
          ? PatientOperationalEvent.findAll({
              where: {
                event_type: PATIENT_EVENT_TYPES.whatsappAuthorized,
                [Op.or]: clinicPatients,
              },
              attributes: ['patient_id', 'occurred_at'],
              order: [['occurred_at', 'DESC'], ['id', 'DESC']],
              raw: true,
            })
          : Promise.resolve([]),
      ])
    : [[], []];

  const conversationByPatient = new Map();
  conversations.forEach((conversation) => {
    const patientId = Number(conversation.patient_id);
    if (!conversationByPatient.has(patientId)) conversationByPatient.set(patientId, conversation);
  });
  const authorizedPatientIds = new Set(authorizationEvents.map((event) => Number(event.patient_id)));
  const { channelRestrictions } = require('./patientCommunicationPreferences.service');
  const restrictions = new Map(await Promise.all([...patientsByClinic].map(async ([clinicId, rows]) => [
    clinicId, await channelRestrictions({ db, clinicId,
      phones: rows.map(patient => patient.telefono_movil), patientIds: rows.map(patient => Number(patient.id_paciente)) }),
  ])));

  return {
    query: normalizeContactSearchQuery(query),
    query_type: search.queryType,
    normalized_phone: search.normalizedPhone,
    items: patients.map((patient) => {
      const plain = patient.toJSON();
      const patientId = Number(plain.id_paciente);
      const clinicId = patientClinics.get(patientId);
      const conversation = conversationByPatient.get(patientId);
      const blocked = restrictions.get(clinicId)?.get(normalizePhoneDigits(plain.telefono_movil)) === true;
      return {
        patient: plain,
        contact_clinic_id: clinicId,
        conversation_id: conversation?.id || null,
        linked_to_selected_clinic: patientContactClinicIds(plain).includes(clinicId),
        whatsapp_contact_authorized: authorizedPatientIds.has(patientId),
        whatsapp_contact_allowed_default: !blocked,
        whatsapp_contact_blocked: blocked,
      };
    }),
  };
}

async function generatePatientPublicId({ transaction = null } = {}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const publicId = `pac_${crypto.randomBytes(10).toString('hex')}`;
    const existing = await Paciente.findOne({
      where: { public_id: publicId },
      attributes: ['id_paciente'],
      transaction,
    });
    if (!existing) return publicId;
  }
  throw new Error('patient_public_id_generation_failed');
}

async function findExactPhonePatient({ phone, clinicIds, transaction = null }) {
  const candidates = getPhoneLookupCandidates(phone);
  if (!candidates.length) return null;
  return Paciente.findOne({
    where: {
      [Op.and]: [
        { telefono_movil: { [Op.in]: candidates } },
        patientClinicScopeWhere(clinicIds),
      ],
    },
    include: [{
      model: PacienteClinica,
      as: 'clinicasVinculadas',
      attributes: ['clinica_id', 'es_principal'],
      required: false,
    }],
    transaction,
  });
}

async function hasWhatsappContactAuthorization({ patientId, clinicId, transaction = null }) {
  if (!PatientOperationalEvent) return false;
  const event = await PatientOperationalEvent.findOne({
    where: {
      patient_id: Number(patientId),
      clinic_id: Number(clinicId),
      event_type: PATIENT_EVENT_TYPES.whatsappAuthorized,
    },
    attributes: ['id'],
    transaction,
  });
  return !!event;
}

async function startPatientWhatsappConversation({
  patientId = null,
  phone = null,
  firstName = null,
  lastName = null,
  clinicId,
  duplicateScopeClinicIds,
  actorUserId,
  authorizationConfirmed = false,
  source = 'quick_chat',
  transaction,
}) {
  const normalizedClinicId = Number(clinicId);
  const normalizedPhone = normalizePhoneDigits(phone);
  let patient = null;
  let patientCreated = false;

  if (patientId) {
    patient = await Paciente.findByPk(Number(patientId), {
      include: [{
        model: PacienteClinica,
        as: 'clinicasVinculadas',
        attributes: ['clinica_id', 'es_principal'],
        required: false,
      }],
      transaction,
    });
    if (!patient) {
      const error = new Error('patient_not_found');
      error.status = 404;
      throw error;
    }
    if (!isPatientLinkedToClinic(patient, normalizedClinicId)) {
      const error = new Error('patient_not_linked_to_clinic');
      error.status = 409;
      throw error;
    }
  } else {
    if (!normalizedPhone) {
      const error = new Error('valid_phone_required');
      error.status = 400;
      throw error;
    }
    const duplicate = await findExactPhonePatient({
      phone: normalizedPhone,
      clinicIds: duplicateScopeClinicIds,
      transaction,
    });
    if (duplicate && !isPatientLinkedToClinic(duplicate, normalizedClinicId)) {
      const error = new Error('patient_exists_in_group');
      error.status = 409;
      throw error;
    }
    patient = duplicate;
    if (!patient) {
      const normalizedFirstName = normalizeHumanName(firstName);
      const normalizedLastName = normalizeHumanName(lastName || '');
      if (!normalizedFirstName) {
        const error = new Error('patient_name_required');
        error.status = 400;
        throw error;
      }
      patient = await Paciente.create({
        public_id: await generatePatientPublicId({ transaction }),
        nombre: normalizedFirstName,
        apellidos: normalizedLastName,
        telefono_movil: normalizedPhone,
        idioma_preferido: 'es',
        paciente_conocido: true,
        clinica_id: normalizedClinicId,
      }, { transaction });
      await PacienteClinica.create({
        paciente_id: patient.id_paciente,
        clinica_id: normalizedClinicId,
        es_principal: true,
      }, { transaction });
      patientCreated = true;
      await recordPatientOperationalEvent({
        patientId: patient.id_paciente,
        clinicId: normalizedClinicId,
        actorUserId,
        eventType: PATIENT_EVENT_TYPES.created,
        source,
        channel: 'whatsapp',
        metadata: { minimal_record: true },
        transaction,
      });
    }
  }

  const contactPhone = normalizePhoneDigits(patient.telefono_movil || normalizedPhone);
  if (!contactPhone) {
    const error = new Error('patient_phone_required');
    error.status = 400;
    throw error;
  }

  const restrictions = await require('./patientCommunicationPreferences.service').channelRestrictions({ db,
    clinicId: normalizedClinicId, phones: [contactPhone], patientIds: [Number(patient.id_paciente)], transaction });
  if (restrictions.get(contactPhone)) throw Object.assign(new Error('Este paciente ha pedido no ser notificado por WhatsApp'), {
    code: 'WHATSAPP_CHANNEL_REFUSED', status: 409, statusCode: 409, retryable: false,
  });

  const alreadyAuthorized = await hasWhatsappContactAuthorization({
    patientId: patient.id_paciente,
    clinicId: normalizedClinicId,
    transaction,
  });
  // Starting a care chat is an operational action, not proof of legal consent.
  // Preserve a separate attestation only when it was explicitly provided.
  if (!alreadyAuthorized && authorizationConfirmed === true) {
    await recordPatientOperationalEvent({
      patientId: patient.id_paciente,
      clinicId: normalizedClinicId,
      actorUserId,
      eventType: PATIENT_EVENT_TYPES.whatsappAuthorized,
      source,
      channel: 'whatsapp',
      metadata: {
        attestation: true,
        purpose: 'care_coordination',
        recipient_phone: contactPhone,
        statement_version: 'whatsapp_contact_v1',
        marketing_consent: false,
      },
      transaction,
    });
  }

  const existingConversation = await findCanonicalWhatsappConversation({
    requireExactContact: true,
    isolatePatientContact: true,
    clinicId: normalizedClinicId,
    contactId: contactPhone,
    patientId: patient.id_paciente,
    createIfMissing: false,
    transaction,
  });
  const conversation = existingConversation || await findCanonicalWhatsappConversation({
    requireExactContact: true,
    isolatePatientContact: true,
    clinicId: normalizedClinicId,
    contactId: contactPhone,
    patientId: patient.id_paciente,
    createIfMissing: true,
    transaction,
  });

  if (!existingConversation) {
    await recordPatientOperationalEvent({
      patientId: patient.id_paciente,
      clinicId: normalizedClinicId,
      actorUserId,
      eventType: PATIENT_EVENT_TYPES.whatsappConversationStarted,
      source,
      channel: 'whatsapp',
      metadata: { conversation_id: conversation.id },
      transaction,
    });
  }

  return {
    patient,
    conversation,
    patientCreated,
    conversationCreated: !existingConversation,
    authorizationRecorded: !alreadyAuthorized && authorizationConfirmed === true,
  };
}

module.exports = {
  PATIENT_EVENT_TYPES,
  buildFastPatientSearchWhere,
  classifyContactSearchQuery,
  findPatientContactTargets,
  normalizeContactSearchQuery,
  normalizeOperationalSource,
  recordPatientOperationalEvent,
  startPatientWhatsappConversation,
};

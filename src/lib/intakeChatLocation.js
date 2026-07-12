'use strict';

const { locationId, parseIntakeId } = require('./intakeLocations');

function chatStateData(body = {}) {
  const state = body?.chat_state && typeof body.chat_state === 'object' && !Array.isArray(body.chat_state)
    ? body.chat_state
    : (body?.chatState && typeof body.chatState === 'object' && !Array.isArray(body.chatState)
      ? body.chatState
      : null);
  return state?.data && typeof state.data === 'object' && !Array.isArray(state.data)
    ? state.data
    : {};
}

function nestedLocationId(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return value.id
    ?? value.value
    ?? value.clinic_id
    ?? value.clinica_id
    ?? value.clinicId
    ?? value.clinicaId
    ?? null;
}

function extractChatLocationCandidate(body = {}) {
  const data = chatStateData(body);
  const raw = [
    data.location,
    data.location_id,
    data.locationId,
    data.sede,
    data.sede_id,
    data.sedeId,
    data.clinic_id,
    data.clinica_id,
    data.clinicId,
    data.clinicaId,
  ].find((value) => value !== undefined && value !== null && value !== '');
  if (raw === undefined) return { present: false, id: null };
  return { present: true, id: parseIntakeId(nestedLocationId(raw)) };
}

function extractChatLocationId(body = {}) {
  return extractChatLocationCandidate(body).id;
}

function isActiveClinic(clinic) {
  return [true, 1, '1'].includes(clinic?.estado_clinica);
}

function configuredLocationIds(configRecord) {
  const config = configRecord?.config && typeof configRecord.config === 'object' && !Array.isArray(configRecord.config)
    ? configRecord.config
    : null;
  if (!config || !Object.prototype.hasOwnProperty.call(config, 'locations')) return null;
  if (!Array.isArray(config.locations)) return [];
  return Array.from(new Set(
    config.locations
      .map((location) => parseIntakeId(locationId(location)))
      .filter((id) => id !== null)
  ));
}

async function resolveChatStateClinicSelection({
  body = {},
  requestedGroupId = null,
  submittedClinicId = null,
  configRecord = null,
  findClinicById,
} = {}) {
  const chatCandidate = extractChatLocationCandidate(body);
  const submittedClinicPresent = submittedClinicId !== undefined
    && submittedClinicId !== null
    && submittedClinicId !== '';
  const explicitClinicId = parseIntakeId(submittedClinicId);
  if (chatCandidate.present && chatCandidate.id === null) {
    return {
      matched: false,
      hasCandidate: true,
      reason: 'invalid_candidate',
      candidateClinicId: null,
      clinicId: null,
      groupId: null,
    };
  }
  if (submittedClinicPresent && explicitClinicId === null) {
    return {
      matched: false,
      hasCandidate: true,
      reason: 'invalid_submitted_clinic',
      candidateClinicId: null,
      clinicId: null,
      groupId: null,
    };
  }
  if (!chatCandidate.present && !submittedClinicPresent) {
    return {
      matched: false,
      hasCandidate: false,
      reason: 'no_candidate',
      candidateClinicId: null,
      clinicId: null,
      groupId: null,
    };
  }

  const candidateClinicId = chatCandidate.present ? chatCandidate.id : explicitClinicId;

  const explicitGroupId = parseIntakeId(requestedGroupId);
  if (chatCandidate.present && submittedClinicPresent && explicitClinicId !== candidateClinicId) {
    return {
      matched: false,
      hasCandidate: true,
      reason: 'clinic_chat_mismatch',
      candidateClinicId,
      clinicId: null,
      groupId: explicitGroupId,
    };
  }
  const configGroupId = configRecord?.assignment_scope === 'group'
    ? parseIntakeId(configRecord.group_id)
    : null;
  if (explicitGroupId !== null && configGroupId !== null && explicitGroupId !== configGroupId) {
    return {
      matched: false,
      hasCandidate: true,
      reason: 'group_scope_mismatch',
      candidateClinicId,
      clinicId: null,
      groupId: explicitGroupId,
    };
  }

  const effectiveGroupId = explicitGroupId ?? configGroupId;
  if (effectiveGroupId === null || typeof findClinicById !== 'function') {
    return {
      matched: false,
      hasCandidate: true,
      reason: 'untrusted_group_scope',
      candidateClinicId,
      clinicId: null,
      groupId: effectiveGroupId,
    };
  }

  const clinic = await findClinicById(candidateClinicId);
  if (!clinic) {
    return {
      matched: false,
      hasCandidate: true,
      reason: 'clinic_not_found',
      candidateClinicId,
      clinicId: null,
      groupId: effectiveGroupId,
    };
  }
  if (!isActiveClinic(clinic)) {
    return {
      matched: false,
      hasCandidate: true,
      reason: 'clinic_inactive',
      candidateClinicId,
      clinicId: null,
      groupId: effectiveGroupId,
    };
  }

  const clinicGroupId = parseIntakeId(clinic.grupoClinicaId ?? clinic.grupo_clinica_id);
  if (clinicGroupId !== effectiveGroupId) {
    return {
      matched: false,
      hasCandidate: true,
      reason: 'clinic_outside_group',
      candidateClinicId,
      clinicId: null,
      groupId: effectiveGroupId,
    };
  }

  const allowedClinicIds = configuredLocationIds(configRecord);
  if (allowedClinicIds !== null && !allowedClinicIds.includes(candidateClinicId)) {
    return {
      matched: false,
      hasCandidate: true,
      reason: 'clinic_not_configured',
      candidateClinicId,
      clinicId: null,
      groupId: effectiveGroupId,
    };
  }

  return {
    matched: true,
    hasCandidate: true,
    reason: null,
    candidateClinicId,
    clinicId: candidateClinicId,
    groupId: effectiveGroupId,
  };
}

module.exports = {
  configuredLocationIds,
  extractChatLocationCandidate,
  extractChatLocationId,
  isActiveClinic,
  resolveChatStateClinicSelection,
};

'use strict';

const { normalizeEquipmentRequirements, equipmentIds } = require('./booking-equipment');
const { normalizeAttentionPolicy, requiresVersion4Attention } = require('./booking-attention');

function invalid(field, message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'booking_profile_invalid';
  error.details = { field };
  throw error;
}

function ids(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 50) invalid(field, 'Selecciona como máximo 50 opciones válidas.');
  return [...new Set(value.map((item) => {
    const number = typeof item === 'number' || typeof item === 'string' ? Number(item) : NaN;
    if (!Number.isSafeInteger(number) || number <= 0) invalid(field, 'Identificador de cabina o profesional inválido.');
    return number;
  }))];
}

/** Normalizes only the booking_profile subtree; callers retain clinical_config. */
function normalizeBookingProfile(value, { allowIncomplete = false } = {}) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || ![1, 2, 3, 4].includes(value.version)) {
    invalid('version', 'La versión del perfil de agenda no es válida.');
  }
  if (!Array.isArray(value.phases) || !value.phases.length || value.phases.length > 12) {
    invalid('phases', 'Define entre 1 y 12 fases de la cita.');
  }
  const keys = new Set();
  const phases = value.phases.map((phase, index) => {
    const field = `phases.${index}`;
    if (!phase || typeof phase !== 'object' || Array.isArray(phase)) invalid(field, 'Fase inválida.');
    const key = phase.key == null ? `phase_${index + 1}` : String(phase.key).trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || keys.has(key)) invalid(`${field}.key`, 'Cada fase necesita una clave única.');
    keys.add(key);
    const duration = phase.duration_minutes == null || phase.duration_minutes === '' ? null : Number(phase.duration_minutes);
    if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 1440)) {
      invalid(`${field}.duration_minutes`, 'La duración debe estar entre 1 y 1440 minutos.');
    }
    if (duration === null && !allowIncomplete) invalid(`${field}.duration_minutes`, 'Indica la duración de cada fase.');
    if (value.version < 4 && (Object.hasOwn(phase, 'start_offset_minutes') || Object.hasOwn(phase, 'attention_requirements_pending')
      || Object.hasOwn(phase, 'preparation_sharing'))) {
      invalid('version', 'Los pasos con horario relativo o atención pendiente requieren la versión 4 del perfil de agenda.');
    }
    const offset = value.version === 4 ? phase.start_offset_minutes : null;
    if (value.version === 4 && (!Number.isInteger(offset) || offset < 0 || offset > 1439)) {
      invalid(`${field}.start_offset_minutes`, 'Indica desde qué minuto de la visita empieza este paso (0–1439).');
    }
    let pending;
    if (phase.attention_requirements_pending != null) {
      if (!Array.isArray(phase.attention_requirements_pending) || !phase.attention_requirements_pending.length
        || phase.attention_requirements_pending.length > 8) invalid(`${field}.attention_requirements_pending`, 'Identifica entre 1 y 8 intervenciones pendientes de definir.');
      const pendingKeys = new Set();
      pending = phase.attention_requirements_pending.map((requirement, pendingIndex) => {
        const pendingField = `${field}.attention_requirements_pending.${pendingIndex}`;
        if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)
          || Object.keys(requirement).some(key => !['key', 'label'].includes(key))
          || typeof requirement.key !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(requirement.key)
          || pendingKeys.has(requirement.key) || typeof requirement.label !== 'string'
          || !requirement.label.trim() || requirement.label.trim().length > 300) {
          invalid(pendingField, 'Conserva una clave única y una descripción de la intervención pendiente, sin inventar minutos.');
        }
        pendingKeys.add(requirement.key);
        return { key: requirement.key, label: requirement.label.trim() };
      });
    }
    const installationIds = ids(phase.installation_ids, `${field}.installation_ids`);
    // v2 is deliberate: old writers must reject, never silently strip a machine.
    const equipmentRequirements = normalizeEquipmentRequirements(phase.equipment_requirements);
    if (equipmentRequirements.length && value.version < 2) invalid('version', 'Los equipos requieren la versión 2 del perfil de agenda.');
    if (phase.staff_attention != null && (value.version < 3 || !Array.isArray(phase.staff_attention)
      || !phase.staff_attention.length || phase.staff_attention.length > 8)) invalid(`${field}.staff_attention`, 'La intervención del personal requiere un perfil compatible de versión 3 o posterior.');
    const attention = phase.staff_attention?.map(normalizeAttentionPolicy);
    if (value.version < 4 && attention?.some(requiresVersion4Attention)) invalid('version', 'La preparación inicial sin retirada implícita requiere la versión 4 del perfil de agenda.');
    if (value.version === 4 && attention && equipmentRequirements.length > 1) invalid(`${field}.staff_attention`,
      'Define un paso por técnica: una intervención global no puede sustituir la atención de varias máquinas.');
    const staff = phase.professionals || { mode: 'any', ids: [] };
    if (typeof staff !== 'object' || !['any', 'all'].includes(staff.mode)) invalid(`${field}.professionals.mode`, 'Elige si puede atender cualquiera o deben estar todos.');
    let preparationSharing;
    if (Object.hasOwn(phase, 'preparation_sharing')) {
      const sharing = phase.preparation_sharing;
      if (!sharing || typeof sharing !== 'object' || Array.isArray(sharing) || sharing.mode !== 'same_start'
        || Object.keys(sharing).some(key => key !== 'mode') || offset !== 0 || staff.mode !== 'any'
        || attention?.length !== 1 || !['start_only', 'start_continuous', 'start_end'].includes(attention[0].mode)) {
        invalid(`${field}.preparation_sharing`, 'La preparación compartida requiere un paso inicial con un profesional y una intervención inicial cuantificada. Sólo se permite con otras visitas verificadas que empiecen a la misma hora y tengan la misma ventana inicial.');
      }
      preparationSharing = { mode: 'same_start' };
    }
    if (attention && ((value.version < 4 && !equipmentRequirements.length) || staff.mode !== 'any')) invalid(`${field}.staff_attention`, 'Las intervenciones parciales requieren un profesional por fase; los equipos obligatorios conservan la reserva completa.');
    const professionalIds = ids(staff.ids, `${field}.professionals.ids`);
    let preferredId = staff.preferred_id == null || staff.preferred_id === '' ? null : Number(staff.preferred_id);
    if (preferredId !== null && (!Number.isSafeInteger(preferredId) || !professionalIds.includes(preferredId))) {
      invalid(`${field}.professionals.preferred_id`, 'El prioritario debe estar entre los profesionales elegibles.');
    }
    if (staff.mode === 'all' && preferredId !== null) invalid(`${field}.professionals.preferred_id`, 'Un equipo obligatorio no tiene profesional prioritario.');
    if (staff.mode === 'any' && professionalIds.length === 1) preferredId = professionalIds[0];
    let fallbackWhen;
    if (Object.hasOwn(staff, 'fallback_when')) {
      if (staff.mode !== 'any' || !['absence_only', 'unavailable'].includes(staff.fallback_when)) invalid(`${field}.professionals.fallback_when`,
        'Indica si el alternativo puede atender sólo en una ausencia o ante cualquier indisponibilidad del prioritario.');
      fallbackWhen = staff.fallback_when;
    }
    if (value.version === 4 && staff.mode === 'any' && professionalIds.length > 1) {
      if (preferredId === null) invalid(`${field}.professionals.preferred_id`, 'Elige el profesional prioritario antes de configurar su sustitución.');
      if (!fallbackWhen) invalid(`${field}.professionals.fallback_when`, 'Elige expresamente cuándo se puede ofrecer el profesional alternativo. No se presume una sustitución por una cita ocupada.');
    }
    if (!allowIncomplete) {
      if (!installationIds.length) invalid(`${field}.installation_ids`, 'Selecciona una cabina para la fase.');
      if (!professionalIds.length) invalid(`${field}.professionals.ids`, 'Selecciona quién puede atender la fase.');
      if (staff.mode === 'any' && professionalIds.length > 1 && preferredId === null) {
        invalid(`${field}.professionals.preferred_id`, 'Elige el profesional prioritario.');
      }
    }
    return {
      key, label: String(phase.label || '').trim().slice(0, 120), duration_minutes: duration,
      installation_ids: installationIds,
      professionals: { mode: staff.mode, ids: professionalIds, preferred_id: preferredId,
        ...(fallbackWhen ? { fallback_when: fallbackWhen } : {}) },
      ...(equipmentRequirements.length ? { equipment_requirements: equipmentRequirements } : {}),
      ...(attention ? { staff_attention: attention } : {}),
      ...(value.version === 4 ? { start_offset_minutes: offset } : {}),
      ...(pending ? { attention_requirements_pending: pending } : {}),
      ...(preparationSharing ? { preparation_sharing: preparationSharing } : {}),
    };
  });
  if (value.version === 4 && Math.min(...phases.map(phase => phase.start_offset_minutes)) !== 0) {
    invalid('phases', 'Al menos un paso debe empezar al inicio de la visita (minuto 0).');
  }
  const offsets = bookingPhaseOffsets({ version: value.version, phases });
  if (Math.max(...phases.map((phase, index) => offsets[index] + (phase.duration_minutes || 0))) > 1440) {
    invalid('phases', 'Una cita no puede superar 24 horas; divide las jornadas en citas.');
  }
  if (new Set(phases.flatMap((phase) => phase.installation_ids.map((id) => `i:${id}`)
    .concat(phase.professionals.ids.map((id) => `d:${id}`))).concat(equipmentIds({ phases }).map(id => `e:${id}`))).size > 100) {
    invalid('phases', 'El perfil admite como máximo 100 cabinas y profesionales distintos.');
  }
  return { version: value.version, phases };
}

/** v1–3 are sequential forever; v4 offsets are explicit, never guessed. */
function bookingPhaseOffsets(profile) {
  let offset = 0;
  return profile.phases.map(phase => {
    if (profile.version === 4) return phase.start_offset_minutes;
    const current = offset;
    offset += phase.duration_minutes || 0;
    return current;
  });
}

function bookingProfileDurationMinutes(profile) {
  if (profile.phases.some(phase => phase.duration_minutes == null)) return null;
  const offsets = bookingPhaseOffsets(profile);
  return Math.max(...profile.phases.map((phase, index) => offsets[index] + (phase.duration_minutes || 0)));
}

function pendingAttentionRequirements(profile) {
  return profile.phases.flatMap(phase => (phase.attention_requirements_pending || []).map(requirement => ({
    phase_key: phase.key, key: requirement.key, label: requirement.label,
  })));
}

function requiresMultiResourceBooking(profile) {
  return !!profile && (profile.phases.length > 1
    || equipmentIds(profile).length > 0
    || profile.phases.some((phase) => phase.professionals.mode === 'all' && phase.professionals.ids.length > 1));
}

// A manual appointment may legitimately reserve only one clinician, without a
// treatment or a room. This is NOT a relaxed catalogue profile: keep the normal
// normalizer strict and require this exact, server-derived legacy shape.
function normalizeDoctorOnlyBookingProfile(value) {
  const profile = normalizeBookingProfile(value, { allowIncomplete: true });
  const phase = profile?.phases?.[0];
  if (!profile || profile.version !== 1 || profile.phases.length !== 1
    || !phase.duration_minutes || phase.installation_ids.length
    || phase.professionals.mode !== 'any' || phase.professionals.ids.length !== 1
    || phase.equipment_requirements?.length || phase.staff_attention?.length) {
    invalid('phases', 'La reserva sin sala debe tener un único profesional y una duración, sin fases ni equipos de tratamiento.');
  }
  return profile;
}

module.exports = { normalizeBookingProfile, requiresMultiResourceBooking, bookingPhaseOffsets, bookingProfileDurationMinutes,
  pendingAttentionRequirements, normalizeDoctorOnlyBookingProfile };

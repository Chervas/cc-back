'use strict';

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
  if (typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
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
    const installationIds = ids(phase.installation_ids, `${field}.installation_ids`);
    const staff = phase.professionals || { mode: 'any', ids: [] };
    if (typeof staff !== 'object' || !['any', 'all'].includes(staff.mode)) invalid(`${field}.professionals.mode`, 'Elige si puede atender cualquiera o deben estar todos.');
    const professionalIds = ids(staff.ids, `${field}.professionals.ids`);
    let preferredId = staff.preferred_id == null || staff.preferred_id === '' ? null : Number(staff.preferred_id);
    if (preferredId !== null && (!Number.isSafeInteger(preferredId) || !professionalIds.includes(preferredId))) {
      invalid(`${field}.professionals.preferred_id`, 'El prioritario debe estar entre los profesionales elegibles.');
    }
    if (staff.mode === 'all' && preferredId !== null) invalid(`${field}.professionals.preferred_id`, 'Un equipo obligatorio no tiene profesional prioritario.');
    if (staff.mode === 'any' && professionalIds.length === 1) preferredId = professionalIds[0];
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
      professionals: { mode: staff.mode, ids: professionalIds, preferred_id: preferredId },
    };
  });
  if (phases.reduce((sum, phase) => sum + (phase.duration_minutes || 0), 0) > 1440) {
    invalid('phases', 'Una cita no puede superar 24 horas; divide las jornadas en citas.');
  }
  if (new Set(phases.flatMap((phase) => phase.installation_ids.map((id) => `i:${id}`)
    .concat(phase.professionals.ids.map((id) => `d:${id}`)))).size > 100) {
    invalid('phases', 'El perfil admite como máximo 100 cabinas y profesionales distintos.');
  }
  return { version: 1, phases };
}

function requiresMultiResourceBooking(profile) {
  return !!profile && (profile.phases.length > 1
    || profile.phases.some((phase) => phase.professionals.mode === 'all' && phase.professionals.ids.length > 1));
}

module.exports = { normalizeBookingProfile, requiresMultiResourceBooking };

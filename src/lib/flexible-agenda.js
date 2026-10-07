'use strict';

const { normalizeInstallationProfessionals } = require('./installation-professionals');

const enabled = value => value === true || value === 1;
const isFlexibleDoctor = dc => enabled(dc?.agenda_flexible)
  && enabled(dc?.activo) && enabled(dc?.recibe_citas);
const SOFT_CODES = new Set(['CLINIC_OUT_OF_HOURS', 'INSTALLATION_OUT_OF_HOURS',
  'STAFF_OUT_OF_HOURS', 'INSTALLATION_PROFESSIONAL_NOT_ALLOWED',
  'INSTALLATION_OVERLAP', 'STAFF_OVERLAP']);

function allowFlexibleConflicts(conflicts, enabled) {
  if (enabled) for (const conflict of conflicts) {
    if (SOFT_CODES.has(conflict.code) && conflict.resource_role !== 'additional_staff') conflict.can_force = true;
  }
  return conflicts;
}

// Legacy appointment occupancy becomes advisory. A newer server-verified
// source contract must not be erased by an older destination's exception.
// Explicit manual blocks, inactive resources and permissions remain authoritative.
// Never alter source maps or treat caller metadata as source-contract evidence.
function flexibleResource(resource, start, end) {
  if (!resource) return resource;
  return { ...resource, windows: [{ start, end }],
    busy: (resource.busy || []).filter(interval => interval.protected_attention_origin === true || !Number(interval.appointment_id)) };
}

// Program previews may already have a v4 virtual source whose preparation
// ended before the next legacy step. The marker is server-derived evidence
// that an older writer must retain the complete visit, not sharing authority.
function legacyProtectedAttentionResource(resource) {
  if (!resource) return resource;
  const origins = (resource.attention_visits || []).filter(row => row.protected_attention_origin === true);
  if (!origins.length) return resource;
  if (origins.some(row => !Number.isFinite(+new Date(row.start)) || !Number.isFinite(+new Date(row.end))
    || +new Date(row.start) >= +new Date(row.end))) return { ...resource, windows: [] };
  return { ...resource, busy: [...(resource.busy || []), ...origins.map(row => ({ start: row.start, end: row.end,
    appointment_id: row.appointment_id, protected_attention_origin: true, can_share: false, can_force_legacy: false }))] };
}

function flexibleProfileContext({ profile, start, doctors, installations, equipment, selections = {} }) {
  const selected = profile.phases.map(phase => {
    const id = Number(selections[phase.key]?.doctor_id);
    return phase.professionals.mode === 'any' && phase.professionals.ids.includes(id)
      && enabled(doctors.get(id)?.agenda_flexible) ? id : null;
  });
  if (!selected.some(Boolean)) return null;
  const end = new Date(+new Date(start) + profile.phases.reduce((n, p) => n + p.duration_minutes, 0) * 60000);
  const relaxedDoctors = new Map([...doctors].map(([id, resource]) => [id,
    selected.includes(id) ? flexibleResource(resource, new Date(start), end) : resource]));
  const relaxedRooms = new Map([...installations].map(([id, resource]) => [id, {
    ...flexibleResource(resource, new Date(start), end),
    // Keep restrictions for other members of a mandatory team / support pool.
    profesionales_permitidos: Array.isArray(resource.profesionales_permitidos) && resource.profesionales_permitidos.length
      ? [...new Set([...resource.profesionales_permitidos, ...selected.filter(Boolean)])] : resource.profesionales_permitidos,
  }]));
  const relaxedEquipment = equipment && new Map([...equipment].map(([id, resource]) => [id, {
    ...resource, busy: (resource.busy || []).filter(interval => interval.protected_attention_origin === true || !Number(interval.appointment_id)),
  }]));
  return { doctors: relaxedDoctors, installations: relaxedRooms, equipment: relaxedEquipment,
    // A mixed multi-phase/team reservation must retain its clinic timetable.
    ...(selected.every(Boolean) ? { clinicWindows: null } : {}) };
}

// V4 has an assignment-scoped exception, never a globally relaxed map. The
// clinician must be selected explicitly in this phase, remain eligible and
// belong to an active appointment-receiving flexible clinic membership.
function flexibleVersion4PhaseDoctor(phase, doctorIds, doctors, selections = {}) {
  if (phase.professionals.mode !== 'any' || doctorIds.length !== 1) return null;
  const id = Number(selections[phase.key]?.doctor_id);
  return id > 0 && doctorIds[0] === id && phase.professionals.ids.includes(id)
    && enabled(doctors.get(id)?.agenda_flexible) ? id : null;
}

function flexibleVersion4StaffResource(resource, start, end) {
  if (!resource) return resource;
  // Absence evidence and all existing appointments remain authoritative.
  // The original resource is also retained separately for substitution rules.
  return { ...resource, windows: [{ start, end }], busy: [...(resource.busy || []), ...(resource.absence_windows || [])] };
}

function flexibleVersion4RoomResource(resource, start, end, doctorId) {
  if (!resource) return resource;
  let allowed;
  try { allowed = normalizeInstallationProfessionals(resource.profesionales_permitidos); } catch { return null; }
  return { ...resource, windows: [{ start, end }],
    ...(allowed.length ? { profesionales_permitidos: [...new Set([...allowed, doctorId])] } : {}) };
}

module.exports = { isFlexibleDoctor, allowFlexibleConflicts, flexibleResource, legacyProtectedAttentionResource, flexibleProfileContext,
  flexibleVersion4PhaseDoctor, flexibleVersion4StaffResource, flexibleVersion4RoomResource };

'use strict';

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

// Appointment occupancy becomes advisory. Explicit manual blocks, inactive or
// foreign resources and permissions remain authoritative. Never alter source maps.
function flexibleResource(resource, start, end) {
  if (!resource) return resource;
  return { ...resource, windows: [{ start, end }],
    busy: (resource.busy || []).filter(interval => !Number(interval.appointment_id)) };
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
    ...resource, busy: (resource.busy || []).filter(interval => !Number(interval.appointment_id)),
  }]));
  return { doctors: relaxedDoctors, installations: relaxedRooms, equipment: relaxedEquipment,
    // A mixed multi-phase/team reservation must retain its clinic timetable.
    ...(selected.every(Boolean) ? { clinicWindows: null } : {}) };
}

module.exports = { isFlexibleDoctor, allowFlexibleConflicts, flexibleResource, flexibleProfileContext };

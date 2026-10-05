'use strict';

// Read-only explanations for START positions rejected by the canonical solver.
// Never use these messages to grant availability, force a booking, or expose
// patients, notes or foreign appointment details from the shared resource snapshot.
// Own-clinic catalog names may explain a reservation; a recorded full interval
// is NOT proof that the machine's current policy requires continuous attention.
const { isFree } = require('./booking-profile-solver');
const { installationAllowsStaff } = require('./installation-professionals');
const { resourceForConfirmedOverlap, normalizeAttentionPolicy, isDefaultAttention, planStaffAttention, ordinaryPhaseCanOverlap } = require('./booking-attention');

function startConflict(reason, message, resourceType = 'installation', resourceId = null, duration = null) {
  return { resource_type: resourceType, ...(resourceId ? { resource_id: resourceId } : {}),
    code: 'BOOKING_UNAVAILABLE', can_force: false,
    details: { availability_semantics: 'appointment_start', reason_key: reason,
      ...(duration ? { duration_minutes: duration } : {}), message } };
}

function busyExplanation(resource, start, end, type) {
  const busy = (resource?.busy || []).find(interval => +new Date(interval.start) < +end && +new Date(interval.end) > +start);
  const detail = busy?.diagnostic;
  if (!detail) return 'ocupado por otra cita o por un bloqueo horario';
  if (detail.kind === 'other_clinic') return `ocupado en otra clínica (${detail.time_range})`;
  const treatment = detail.treatment_name ? `una cita de ${detail.treatment_name}` : 'otra cita';
  const reservation = type === 'staff'
    ? detail.full_interval ? ' Esa cita reserva al profesional durante todo ese intervalo.' : ' Tiene una intervención de personal reservada en ese intervalo.'
    : '';
  return `ocupado con ${treatment} (${detail.time_range}).${reservation}`;
}

function attentionExplanation(policies) {
  return policies.map(policy => policy.mode === 'start_end'
    ? `${policy.start_minutes} min de puesta en marcha dentro de los primeros ${policy.start_window_minutes} min y ${policy.end_minutes} min de retirada dentro de los últimos ${policy.end_window_minutes} min`
    : policy.patient_preparation_minutes ? `atención continua después de los ${policy.patient_preparation_minutes} min de preparación del paciente` : 'atención continua durante toda la cita')
    .filter((value, index, values) => values.indexOf(value) === index).join('; ');
}

function resourceFailure(resource, start, end, type, id, duration) {
  const label = resource?.name || (type === 'staff' ? 'El profesional' : 'La sala');
  if (!resource) return startConflict('resource_not_enabled', `${label}: recurso no habilitado para este tratamiento.`, type, id, duration);
  const inside = (resource.windows || []).some(window => +new Date(window.start) <= +start && +end <= +new Date(window.end));
  if (!inside) {
    const startsInside = (resource.windows || []).some(window => +new Date(window.start) <= +start && +start < +new Date(window.end));
    return startConflict(startsInside ? 'duration_outside_schedule' : 'outside_schedule',
      startsInside ? `No caben ${duration} min completos en el horario de ${label}.` : `${label}: fuera de su horario disponible.`, type, id, duration);
  }
  if (!isFree(resource, start, end)) return startConflict('resource_busy',
    `${label}: ${busyExplanation(resource, start, end, type)}${type === 'staff'
      ? ` Para esta cita necesita ${duration} min seguidos de disponibilidad.` : ` La sala debe quedar libre durante los ${duration} min completos de esta cita.`}`, type, id, duration);
  return null;
}

function incompatibleStart(profile, doctor, installation) {
  const phase = profile.phases[0];
  if (installation && !phase.installation_ids.includes(installation)) return startConflict('incompatible_installation',
    'Esta sala no es compatible con el tratamiento seleccionado.', 'installation', installation, phase.duration_minutes);
  if (doctor && !phase.professionals.ids.includes(doctor)) return startConflict('incompatible_staff',
    'Este profesional no está configurado para realizar el tratamiento seleccionado.', 'staff', doctor, phase.duration_minutes);
  return null;
}

function explainUnavailableStart({ profile, context, start, selections = {}, additionalStaffIds = [], allowOverlap = false }) {
  const phase = profile.phases[0], duration = phase.duration_minutes;
  allowOverlap = allowOverlap && ordinaryPhaseCanOverlap(phase);
  const end = new Date(+start + duration * 60000), selection = selections[phase.key] || {};
  const incompatible = incompatibleStart(profile, Number(selection.doctor_id) || null, Number(selection.installation_id) || null);
  if (incompatible) return incompatible;
  if (context.clinicWindows && !isFree({ windows: context.clinicWindows }, start, end)) {
    return startConflict('clinic_schedule', `La clínica no permite completar una cita de ${duration} min desde esta hora.`, 'clinic', null, duration);
  }
  const roomIds = selection.installation_id ? [Number(selection.installation_id)] : phase.installation_ids;
  const staffIds = selection.doctor_id ? [Number(selection.doctor_id)] : phase.professionals.ids;
  const failures = [], readyRooms = [];
  for (const roomId of roomIds) {
    const room = context.installations.get(roomId);
    // Support eligibility can intentionally remove the room's windows. Explain
    // that restriction before interpreting the empty windows as a timetable.
    if (room && staffIds.every(id => !installationAllowsStaff(room, [id, ...additionalStaffIds]))) {
      failures.push(startConflict('room_staff_incompatible',
        'El profesional o el personal de apoyo no está incluido entre los profesionales permitidos de esta sala.',
        'installation', roomId, duration));
      continue;
    }
    const failure = resourceFailure(resourceForConfirmedOverlap(room, start, end, allowOverlap), start, end, 'installation', roomId, duration);
    if (failure) { failures.push(failure); continue; }
    const chosen = [];
    for (const requirement of phase.equipment_requirements || []) {
      const units = requirement.equipment_ids.map(id => context.equipment?.get(id));
      const usable = units.filter(unit => unit?.status === 'available' && unit.installation_ids.has(roomId));
      const unit = usable.find(item => !(item.busy || []).some(busy => +new Date(busy.start) < +end + item.turnaround_minutes * 60000 && +new Date(busy.end) > +start));
      if (!unit) {
        const name = usable.map(item => item.name).filter(Boolean).join(' / ') || 'La máquina requerida';
        failures.push(startConflict(usable.length ? 'equipment_busy' : 'equipment_not_available',
          usable.length ? `${name}: no está libre durante los ${duration} min completos de la cita${usable.some(item => item.turnaround_minutes > 0)
            ? ` y el tiempo posterior de preparación de la máquina (${Math.max(...usable.map(item => item.turnaround_minutes))} min)` : ''}.` : 'La sala no tiene disponible la máquina requerida para este tratamiento.',
          'installation', roomId, duration));
        break;
      }
      chosen.push(unit);
    }
    if (chosen.length === (phase.equipment_requirements || []).length) readyRooms.push({ roomId, room, chosen });
  }
  for (const { roomId, room, chosen } of readyRooms) {
    for (const staffId of staffIds) {
      const staff = context.doctors.get(staffId);
      if (!installationAllowsStaff(room, [staffId, ...additionalStaffIds])) {
        failures.push(startConflict('room_staff_incompatible', 'El profesional o el personal de apoyo no está autorizado en esta sala.', 'installation', roomId, duration));
        continue;
      }
      const policies = phase.staff_attention || chosen.map(unit => normalizeAttentionPolicy(unit.attention_policy));
      if (policies.some(policy => !isDefaultAttention(policy))) {
        if (!planStaffAttention({ resource: staff, start, end, policies })) failures.push(startConflict('staff_intervention',
          `${staff?.name || 'El profesional'}: no puede encajar ${attentionExplanation(policies)}${chosen.length ? ` para ${chosen.map(unit => unit.name).filter(Boolean).join(' / ')}` : ''}. Las intervenciones deben caber dentro de la cita, sin solaparse con sus otras reservas y dentro de su horario.`, 'staff', staffId, duration));
      } else {
        const failure = resourceFailure(resourceForConfirmedOverlap(staff, start, end, allowOverlap), start, end, 'staff', staffId, duration);
        if (failure) failures.push(failure);
      }
    }
  }
  for (const staffId of additionalStaffIds) {
    const failure = resourceFailure(context.doctors.get(staffId), start, end, 'staff', staffId, duration);
    if (failure) return failure;
  }
  // A single pair has an exact reason. With alternative pairs, do not present
  // one clinician's conflict as if it explained every possible combination.
  if (failures.length === 1 || (roomIds.length === 1 && staffIds.length === 1)) return failures[0] || startConflict('no_combination',
    `No hay una combinación disponible de sala, profesional y máquina para los ${duration} min de esta cita.`, 'installation', null, duration);
  return startConflict('no_combination',
    `Ninguna combinación de sala, profesional y máquina permite completar los ${duration} min desde esta hora.`, 'installation', null, duration);
}

function appendStartInterval(intervals, start, end, conflict, timeZone, formatLocal) {
  const previous = intervals.at(-1);
  if (previous && previous.end_utc === start.toISOString()
    && JSON.stringify(previous.resource_conflicts[0]) === JSON.stringify(conflict)) {
    previous.end_utc = end.toISOString(); previous.end_local = formatLocal(end, timeZone); return;
  }
  intervals.push({ start_local: formatLocal(start, timeZone), end_local: formatLocal(end, timeZone),
    start_utc: start.toISOString(), end_utc: end.toISOString(), interval_kind: 'appointment_start', resource_conflicts: [conflict] });
}

module.exports = { startConflict, incompatibleStart, explainUnavailableStart, appendStartInterval };

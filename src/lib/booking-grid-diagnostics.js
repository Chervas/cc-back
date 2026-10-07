'use strict';

// Read-only explanations for START positions rejected by the canonical solver.
// Never use these messages to grant availability, force a booking, or expose
// patients, notes or foreign appointment details from the shared resource snapshot.
// Own-clinic catalog names may explain a reservation; a recorded full interval
// is NOT proof that the machine's current policy requires continuous attention.
const { isFree } = require('./booking-profile-solver');
const { installationAllowsStaff } = require('./installation-professionals');
const { bookingProfileDurationMinutes, pendingAttentionRequirements } = require('./booking-profile');
const { attentionVisitConflict } = require('./booking-attention-origin');
const { professionalFallbackAllowed } = require('./booking-professional-fallback');
const { resourceForConfirmedOverlap, normalizeAttentionPolicy, isDefaultAttention, planStaffAttention, planStaffAttentionSteps, ordinaryPhaseCanOverlap } = require('./booking-attention');

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
    : policy.mode === 'start_only' ? `${policy.start_minutes} min de preparación dentro de los primeros ${policy.start_window_minutes} min`
    : policy.mode === 'start_continuous' ? `${policy.start_minutes} min de preparación dentro de los primeros ${policy.start_window_minutes} min y atención continua desde que termina la preparación hasta el final`
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
  if (profile.version === 4) return explainUnavailableVersion4Start({ profile, context, start: new Date(start), selections, additionalStaffIds, allowOverlap });
  if (profile.phases.length > 1) {
    const duration = bookingProfileDurationMinutes(profile), end = new Date(+new Date(start) + duration * 60000);
    if (context.clinicWindows && !isFree({ windows: context.clinicWindows }, new Date(start), end)) return startConflict('clinic_schedule',
      `La clínica no permite completar los ${duration} min de esta visita desde esta hora, incluidos todos sus pasos.`, 'clinic', null, duration);
    // Legacy sequential ALL staff occupy the entire visit. Do not invent a
    // first-step explanation for a rejection of the complete canonical plan.
    return startConflict('joint_resources', 'No hay una combinación de salas, profesionales y maquinaria que permita completar todos los pasos desde esta hora.', 'installation', null, duration);
  }
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

// Diagnostics explain a failed canonical solution; they never grant a slot.
// Check the complete envelope and each real offset before diagnosing joint
// attention. Do not apply the first phase's duration/room to the whole visit.
function explainUnavailableVersion4Start({ profile, context, start, selections, additionalStaffIds, allowOverlap }) {
  const duration = bookingProfileDurationMinutes(profile);
  const end = new Date(+start + duration * 60000);
  const pending = pendingAttentionRequirements(profile);
  if (pending.length) return startConflict('pending_attention_requirements',
    'Falta concretar una intervención de personal de esta visita. La preparación calculada no garantiza toda su atención clínica.', 'staff', null, duration);
  if (context.clinicWindows && !isFree({ windows: context.clinicWindows }, start, end)) return startConflict('clinic_schedule',
    `La clínica no permite completar los ${duration} min de esta visita desde esta hora, incluidos todos sus pasos.`, 'clinic', null, duration);
  const singleAssignments = [];
  const blockedSubstitutions = [];
  const withPhase = (conflict, phase) => ({ ...conflict, details: { ...conflict.details,
    phase_key: phase.key, phase_label: phase.label || '', start_offset_minutes: phase.start_offset_minutes,
    visit_duration_minutes: duration } });
  const roomFor = id => {
    const room = context.installations.get(id);
    if (!room) return room;
    const key = room.resource_key || `installation:${id}`;
    return { ...room, busy: [...context.installations].flatMap(([otherId, other]) =>
      (other.resource_key || `installation:${otherId}`) === key ? other.busy || [] : []) };
  };
  for (const phase of profile.phases) {
    const phaseStart = new Date(+start + phase.start_offset_minutes * 60000);
    const phaseEnd = new Date(+phaseStart + phase.duration_minutes * 60000);
    const selection = selections[phase.key] || {};
    const roomIds = selection.installation_id == null ? phase.installation_ids
      : phase.installation_ids.filter(id => id === Number(selection.installation_id));
    if (!roomIds.length) return withPhase(startConflict('incompatible_installation',
      'La sala elegida no es compatible con este paso del tratamiento.', 'installation', Number(selection.installation_id), phase.duration_minutes), phase);
    const staff = phase.professionals;
    const staffChoices = staff.mode === 'all'
      ? selection.doctor_id == null || staff.ids.length === 1 && Number(selection.doctor_id) === staff.ids[0] ? [staff.ids] : []
      : staff.ids.filter(id => selection.doctor_id == null || id === Number(selection.doctor_id)).map(id => [id]);
    if (!staffChoices.length) return withPhase(startConflict('incompatible_staff',
      'El profesional elegido no está configurado para realizar este paso del tratamiento.', 'staff', Number(selection.doctor_id), phase.duration_minutes), phase);
    const failures = [], ready = [];
    const ordinary = ordinaryPhaseCanOverlap(phase);
    for (const roomId of roomIds) {
      const room = roomFor(roomId);
      if (room && staffChoices.every(ids => !installationAllowsStaff(room, [...ids, ...additionalStaffIds]))) {
        failures.push(startConflict('room_staff_incompatible',
          'El profesional o el personal de apoyo no está incluido entre los profesionales permitidos de esta sala.', 'installation', roomId, phase.duration_minutes));
        continue;
      }
      const roomFailure = resourceFailure(resourceForConfirmedOverlap(room, phaseStart, phaseEnd, allowOverlap && ordinary),
        phaseStart, phaseEnd, 'installation', roomId, phase.duration_minutes);
      if (roomFailure) { failures.push(roomFailure); continue; }
      const units = [];
      for (const requirement of phase.equipment_requirements || []) {
        const usable = requirement.equipment_ids.map(id => context.equipment?.get(id))
          .filter(unit => unit?.status === 'available' && unit.installation_ids.has(roomId));
        const unit = usable.find(candidate => !(candidate.busy || []).some(interval =>
          +new Date(interval.start) < +phaseEnd + candidate.turnaround_minutes * 60000 && +new Date(interval.end) > +phaseStart));
        if (!unit) {
          const names = usable.map(candidate => candidate.name).filter(Boolean).join(' / ') || 'La máquina requerida';
          failures.push(startConflict(usable.length ? 'equipment_busy' : 'equipment_not_available', usable.length
            ? `${names}: no está libre durante los ${phase.duration_minutes} min de este paso y su preparación posterior, si corresponde.`
            : 'Esta sala no tiene disponible la máquina requerida para este paso.', 'installation', roomId, phase.duration_minutes));
          break;
        }
        units.push(unit);
      }
      if (units.length !== (phase.equipment_requirements || []).length) continue;
      const policies = staff.mode === 'all' ? [normalizeAttentionPolicy(null)]
        : phase.staff_attention || (units.length ? units.map(unit => normalizeAttentionPolicy(unit.attention_policy)) : [normalizeAttentionPolicy(null)]);
      for (const ids of staffChoices) {
        if (!installationAllowsStaff(room, [...ids, ...additionalStaffIds])) {
          failures.push(startConflict('room_staff_incompatible',
            'El equipo de personal elegido no está autorizado en esta sala.', 'installation', roomId, phase.duration_minutes));
          continue;
        }
        if (staff.mode === 'any' && ids[0] !== staff.preferred_id
          && !professionalFallbackAllowed({ profileVersion: 4, professionals: staff,
            primary: context.doctors.get(staff.preferred_id), start: phaseStart, end: phaseEnd, policies })) {
          const primary = context.doctors.get(staff.preferred_id);
          const label = primary?.name || 'El profesional prioritario';
          const occupied = (primary?.busy || []).some(interval => +new Date(interval.start) < +phaseEnd && +new Date(interval.end) > +phaseStart);
          const conflict = startConflict('professional_substitution_not_allowed',
            `${label}${occupied ? `: ${busyExplanation(primary, phaseStart, phaseEnd, 'staff').replace(/\.$/, '')}.` : ': no tiene una ausencia acreditada para este paso.'} `
            + 'Este tratamiento sólo permite sustituir al prioritario durante una ausencia o fuera de su horario de trabajo verificado. '
            + 'Una cita ocupada o un bloqueo ordinario no autoriza al profesional alternativo.', 'staff', staff.preferred_id, phase.duration_minutes);
          failures.push(conflict); blockedSubstitutions.push({ phase, conflict });
          continue;
        }
        const staffFailures = ids.flatMap(id => {
          const resource = context.doctors.get(id);
          const sharingConflict = attentionVisitConflict(resource, { phase, visitStart: start, start: phaseStart, end: phaseEnd, policies });
          if (sharingConflict) return [startConflict(sharingConflict.code,
            `${resource?.name || 'El profesional'}: ${busyExplanation(resource, phaseStart, phaseEnd, 'staff')} Para esta cita necesita ${attentionExplanation(policies)}. ${sharingConflict.code === 'preparation_origin_unverified' ? 'No tiene disponibilidad verificada para encajar esta preparación.' : sharingConflict.message}`, 'staff', id, phase.duration_minutes)];
          if (policies.some(policy => !isDefaultAttention(policy))) return planStaffAttention({ resource, start: phaseStart, end: phaseEnd, policies }) ? []
            : [startConflict('staff_intervention', `${resource?.name || 'El profesional'}: no puede encajar ${attentionExplanation(policies)} en este paso sin solaparse con sus otras intervenciones o salir de su horario.`, 'staff', id, phase.duration_minutes)];
          const failure = resourceFailure(resourceForConfirmedOverlap(resource, phaseStart, phaseEnd, allowOverlap && ordinary),
            phaseStart, phaseEnd, 'staff', id, phase.duration_minutes);
          return failure ? [failure] : [];
        });
        if (staffFailures.length) failures.push(...staffFailures);
        else ready.push({ phase, start: phaseStart, end: phaseEnd, doctorIds: ids, policies });
      }
    }
    if (!ready.length) {
      const blocked = blockedSubstitutions.find(row => row.phase === phase);
      const conflict = blocked?.conflict || (failures.length === 1 || roomIds.length === 1 && staffChoices.length === 1 ? failures[0]
        : startConflict('no_combination', `Ninguna combinación de sala, personal y máquina permite completar los ${phase.duration_minutes} min de este paso.`, 'installation', null, phase.duration_minutes));
      return withPhase(conflict || startConflict('no_combination', 'No hay una combinación compatible para este paso.'), phase);
    }
    singleAssignments.push(ready.length === 1 ? ready[0] : null);
  }
  for (const id of additionalStaffIds) {
    const failure = resourceFailure(context.doctors.get(id), start, end, 'staff', id, duration);
    if (failure) return failure;
  }
  // An exact, fixed assignment can explain a joint attention failure without
  // pretending that a single alternative's failure rules out all alternatives.
  if (singleAssignments.every(Boolean)) {
    const byDoctor = new Map();
    for (const assignment of singleAssignments) for (const id of assignment.doctorIds) {
      if (!byDoctor.has(id)) byDoctor.set(id, []);
      byDoctor.get(id).push({ key: assignment.phase.key, start: assignment.start, end: assignment.end, policies: assignment.policies });
    }
    for (const [id, steps] of byDoctor) {
      const resource = context.doctors.get(id);
      const ordinary = singleAssignments.filter(row => row.doctorIds.includes(id)).every(row => ordinaryPhaseCanOverlap(row.phase));
      if (!planStaffAttentionSteps({ resource: resourceForConfirmedOverlap(resource, start, end, allowOverlap && ordinary), steps })) {
        const blocked = blockedSubstitutions.find(row => row.phase.professionals.preferred_id === id);
        if (blocked) return withPhase({ ...blocked.conflict, details: { ...blocked.conflict.details,
          message: `${resource?.name || 'El profesional'}: sus intervenciones no caben juntas sin solaparse. ${blocked.conflict.details.message}` } }, blocked.phase);
        return startConflict('joint_staff_interventions', `${resource?.name || 'El profesional'}: los pasos encajan por separado, pero sus intervenciones no caben juntas sin solaparse. Revisa sus comienzos y ventanas de preparación; la atención continua también ocupa al profesional.`, 'staff', id, duration);
      }
    }
  }
  return startConflict('joint_resources',
    'No se pueden encajar conjuntamente todos los pasos con los recursos disponibles. Revisa sus tiempos, profesionales y unidades de maquinaria; disponer de un paso aislado no garantiza la visita completa.', 'installation', null, duration);
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

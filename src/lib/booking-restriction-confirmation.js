'use strict';

// A manual exception is a receipt for one exact, server-read reservation. It
// never grants access, activates resources, changes a catalog or calls a sender.
const { createHash, timingSafeEqual } = require('node:crypto');
const { normalizeBookingProfile, normalizeDoctorOnlyBookingProfile, bookingProfileDurationMinutes } = require('./booking-profile');
const { solveBookingProfile, isFree } = require('./booking-profile-solver');
const { installationAllowsStaff, normalizeInstallationProfessionals } = require('./installation-professionals');
const { formatLocal } = require('./availability-calendar');
const { attentionVisitConflict } = require('./booking-attention-origin');
const { professionalFallbackAllowed } = require('./booking-professional-fallback');
const { normalizeAttentionPolicy } = require('./booking-attention');
const { explainUnavailableStart } = require('./booking-grid-diagnostics');

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const id = value => value == null || value === '' ? null : Number(value);
const validId = value => Number.isSafeInteger(id(value)) && id(value) > 0;
const clean = value => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
const intersects = (row, start, end) => +new Date(row.start) < +end && +new Date(row.end) > +start;

function selectionError() {
  return Object.assign(new Error('Revisa los profesionales y las salas de cada paso antes de confirmar.'),
    { code: 'booking_restriction_selection_invalid', statusCode: 400 });
}
function normalizedSelections(profile, selections = {}) {
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)
    || Object.keys(selections).some(key => !profile.phases.some(phase => phase.key === key))) throw selectionError();
  const result = {};
  for (const [key, choice] of Object.entries(selections)) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)
      || Object.keys(choice).some(field => !['doctor_id', 'installation_id'].includes(field))
      || ['doctor_id', 'installation_id'].some(field => choice[field] != null && choice[field] !== '' && !validId(choice[field]))) throw selectionError();
    const phase = profile.phases.find(row => row.key === key);
    if (phase.professionals.mode === 'all' && choice.doctor_id != null
      && !(phase.professionals.ids.length === 1 && id(choice.doctor_id) === phase.professionals.ids[0])) throw selectionError();
    result[key] = Object.fromEntries(Object.entries(choice).filter(([, value]) => value != null && value !== '').map(([field, value]) => [field, id(value)]));
  }
  return result;
}

// Bulk-read footprint only. It does NOT make these alternatives bookable. A
// grid loads its visible columns once and uses the same assessment per cell.
function restrictionReadProfile(profile, { selections = {}, doctorIds = [], installationIds = [] } = {}) {
  const chosen = normalizedSelections(profile, selections);
  if ([...doctorIds, ...installationIds].some(value => !validId(value)) || doctorIds.length > 100 || installationIds.length > 100) throw selectionError();
  const first = profile.version === 4 ? profile.phases.reduce((a, b) => b.start_offset_minutes < a.start_offset_minutes ? b : a) : profile.phases[0];
  return { ...profile, phases: profile.phases.map(phase => ({ ...phase,
    installation_ids: [...new Set([...phase.installation_ids, ...(chosen[phase.key]?.installation_id ? [chosen[phase.key].installation_id] : []), ...(phase.key === first.key ? installationIds.map(Number) : [])])],
    professionals: { ...phase.professionals, ids: [...new Set([...phase.professionals.ids,
      ...(phase.professionals.mode === 'any' && chosen[phase.key]?.doctor_id ? [chosen[phase.key].doctor_id] : []),
      ...(phase.key === first.key && phase.professionals.mode === 'any' ? doctorIds.map(Number) : [])])] },
  })) };
}

function effectiveSelectedProfile(profile, selections, doctorOnly = false) {
  const normalize = doctorOnly ? normalizeDoctorOnlyBookingProfile : normalizeBookingProfile;
  return normalize({ ...profile, phases: profile.phases.map(phase => {
    const choice = selections[phase.key] || {};
    return { ...phase, ...(choice.installation_id ? { installation_ids: [choice.installation_id] } : {}),
      ...(phase.professionals.mode === 'any' && choice.doctor_id ? { professionals: {
        mode: 'any', ids: [choice.doctor_id], preferred_id: choice.doctor_id,
        ...(phase.professionals.fallback_when ? { fallback_when: phase.professionals.fallback_when } : {}),
      } } : {}) };
  }) });
}

function assessment({ profile: raw, context, start: rawStart, selections = {}, additionalStaffIds = [],
  clinicId = null, clinicName = '', treatmentId = null, treatmentName = '', patientId = null, appointmentId = null,
  actorId = null, previous = null, acknowledgement = null, eligible = true, canonicalSolution = null, doctorOnly = false }) {
  const profile = doctorOnly ? normalizeDoctorOnlyBookingProfile(raw) : normalizeBookingProfile(raw), chosen = normalizedSelections(profile, selections);
  const start = new Date(rawStart), end = new Date(+start + bookingProfileDurationMinutes(profile) * 60000);
  if (!Number.isFinite(+start)) throw selectionError();
  // The strict solver does not reserve optional full-visit support itself.
  // Do not hash a strict profile when the writer must take the relaxed path
  // because its extra staff is unavailable or incompatible with that room.
  if (canonicalSolution && additionalStaffIds.length && (!additionalStaffIds.every(key => isFree(context.doctors.get(key), start, end))
    || canonicalSolution.phases.some(step => !installationAllowsStaff(context.installations.get(step.installation_id), additionalStaffIds)))) canonicalSolution = null;
  const selectedProfile = effectiveSelectedProfile(profile, chosen, doctorOnly);
  const effectiveProfile = canonicalSolution ? profile : selectedProfile;
  const explicit = profile.phases.every(phase => (doctorOnly || chosen[phase.key]?.installation_id)
    && (phase.professionals.mode === 'all' || chosen[phase.key]?.doctor_id));
  const scopeValid = selectedProfile.phases.every(phase => phase.installation_ids.every(value => context.installations.has(value))
    && phase.professionals.ids.every(value => context.doctors.has(value)))
    && additionalStaffIds.every(value => context.doctors.has(value));
  // Invalid stored restrictions remain data errors, not something a dialog can
  // repair. Only existing, active, in-scope resources reach this context.
  const selectedRooms = [...new Set(selectedProfile.phases.flatMap(phase => phase.installation_ids))];
  const selectedDoctors = [...new Set(selectedProfile.phases.flatMap(phase => phase.professionals.ids))];
  for (const key of selectedRooms) if (context.installations.has(key)) normalizeInstallationProfessionals(context.installations.get(key).profesionales_permitidos);
  const relax = resource => ({ ...resource, windows: [{ start, end }], busy: [], absence_windows: [],
    attention_visits: [], agenda_flexible: false, profesionales_permitidos: [] });
  const relaxed = { ...context, clinicWindows: null,
    doctors: new Map(selectedDoctors.filter(key => context.doctors.has(key)).map(key => [key, relax(context.doctors.get(key))])),
    installations: new Map(selectedRooms.filter(key => context.installations.has(key)).map(key => [key, relax(context.installations.get(key))])),
    ...(context.equipment ? { equipment: new Map([...context.equipment].map(([key, resource]) => [key, { ...resource, busy: [] }])) } : {}),
  };
  // Keeps machine status/location/turnaround, ALL teams, offsets, durations and
  // one clinician's joint internal timeline. Only EXTERNAL availability moves
  // from a prohibition to an explicitly acknowledged warning.
  const solution = scopeValid ? canonicalSolution || (doctorOnly ? {
    start_at: start.toISOString(), end_at: end.toISOString(), warnings: [], requires_priority_acknowledgement: false,
    phases: [{ key: selectedProfile.phases[0].key, label: selectedProfile.phases[0].label,
      start_at: start.toISOString(), end_at: end.toISOString(), installation_id: null,
      doctor_ids: selectedProfile.phases[0].professionals.ids, staff_time_scope: 'phase' }],
  } : solveBookingProfile({ profile: selectedProfile, start, ...relaxed, selections: chosen })) : null;
  const restrictions = [];
  const timeZone = context.timeZone || 'Europe/Madrid';
  const clock = date => formatLocal(new Date(date), timeZone).slice(11, 16);
  const descriptor = (kind, value, resource) => ({ id: value, name: clean(resource?.name) || (kind === 'doctor' ? 'Profesional' : kind === 'equipment' ? 'Equipo' : 'Sala') });
  const add = (code, message, details = {}) => restrictions.push({ code, message, ...details });
  const schedule = (resource, first, last, kind, descriptorValue, phaseDetails) => {
    const configuredWindows = resource?.schedule_windows || resource?.windows || [];
    if (!resource || isFree({ windows: configuredWindows }, first, last)) return;
    const day = formatLocal(first, timeZone).slice(0, 10);
    const sameDay = configuredWindows.filter(row => formatLocal(new Date(row.start), timeZone).slice(0, 10) === day);
    const window = sameDay.filter(row => +new Date(row.start) <= +first && +new Date(row.end) >= +first)
      .sort((a, b) => +new Date(b.end) - +new Date(a.end))[0]
      || (sameDay.length && sameDay.every(row => +new Date(row.end) <= +first)
        ? sameDay.sort((a, b) => +new Date(b.end) - +new Date(a.end))[0] : null);
    const overrun = window ? Math.max(0, Math.ceil((+last - +new Date(window.end)) / 60000)) : null;
    const label = descriptorValue.name;
    add(`${kind}_OUT_OF_HOURS`, window && overrun
      ? `La cita termina a las ${clock(last)}, ${overrun} minutos después del horario de ${label}, que termina a las ${clock(window.end)}.`
      : `${label} no tiene horario de atención asignado de ${clock(first)} a ${clock(last)}.`,
    { ...phaseDetails, [kind === 'STAFF' ? 'doctor' : kind === 'EQUIPMENT' ? 'equipment' : 'installation']: descriptorValue,
      ...(window ? { schedule_end: new Date(window.end).toISOString(), overrun_minutes: overrun } : {}) });
  };
  const busy = (resource, first, last, kind, descriptorValue, phaseDetails) => {
    for (const row of resource?.busy || []) {
      if (!intersects(row, first, last)) continue;
      const diagnostic = row.diagnostic || {}, foreign = diagnostic.kind === 'other_clinic';
      const target = kind === 'STAFF' ? 'doctor' : kind === 'EQUIPMENT' ? 'equipment' : 'installation';
      const item = { ...phaseDetails, [target]: descriptorValue, conflict_start_at: new Date(row.start).toISOString(), conflict_end_at: new Date(row.end).toISOString(),
        ...(foreign ? { other_clinic: true } : {}),
        ...(diagnostic.installation_name ? { conflicting_installation: { name: clean(diagnostic.installation_name) } } : {}),
        ...(diagnostic.clinic_name ? { conflicting_clinic: { name: clean(diagnostic.clinic_name) } } : {}),
        ...(!foreign && diagnostic.treatment_name ? { conflicting_treatment: { name: clean(diagnostic.treatment_name) } } : {}) };
      const appointment = !!row.appointment_id || diagnostic.kind === 'appointment' || foreign;
      // Older snapshots and read-only contexts can omit the appointment ID.
      // Their source classification is still evidence of a reservation, not
      // a staff block. With no classification, describe both possibilities.
      const event = appointment ? `otra cita${!foreign && diagnostic.treatment_name ? ` de ${clean(diagnostic.treatment_name)}` : ''}`
        : diagnostic.kind === 'block' ? 'un bloqueo de agenda' : 'otra cita o un bloqueo horario';
      const heading = kind === 'INSTALLATION' ? `${descriptorValue.name} ya está ocupada por ${event}`
        : kind === 'EQUIPMENT' ? `${descriptorValue.name} ya está reservado para ${event}` : `${descriptorValue.name} ya tiene ${event}`;
      const exclusive = kind === 'STAFF' && diagnostic.continuous_attention === true
        ? ' Ese tratamiento requiere toda su atención: no puede atender ambas citas a la vez con esta configuración.' : '';
      const reserved = kind === 'STAFF' && !foreign && diagnostic.full_interval === true
        ? ' Esa cita reserva al profesional durante todo ese intervalo.' : '';
      add(`${kind}_${appointment ? 'OVERLAP' : 'BLOCKED'}`,
        `${heading} de ${clock(row.start)} a ${clock(row.end)}${foreign ? ' en otra clínica' : ''}${diagnostic.installation_name ? `, en ${clean(diagnostic.installation_name)}` : ''}. Esta reserva se solapa con ese horario.${reserved}${exclusive}`,
        { ...item, ...(diagnostic.continuous_attention === true && kind === 'STAFF' ? { continuous_attention: true } : {}) });
    }
  };
  if (context.clinicWindows && !isFree({ windows: context.clinicWindows }, start, end)) add('CLINIC_OUT_OF_HOURS',
    `La clínica${clinicName ? ` ${clean(clinicName)}` : ''} no tiene horario de apertura que cubra toda la cita, de ${clock(start)} a ${clock(end)}.`,
    { clinic: { id: clinicId, name: clean(clinicName) }, start_at: start.toISOString(), end_at: end.toISOString() });
  if (solution) for (const step of solution.phases) {
    const phase = profile.phases.find(row => row.key === step.key), first = new Date(step.start_at), last = new Date(step.end_at);
    const hasRoom = step.installation_id != null;
    const room = hasRoom ? context.installations.get(step.installation_id) : null, installation = hasRoom ? descriptor('installation', step.installation_id, room) : null;
    const details = { phase_key: step.key, phase_label: clean(phase.label),
      start_offset_minutes: (+first - +start) / 60000, duration_minutes: bookingProfileDurationMinutes(profile),
      start_at: step.start_at, end_at: step.end_at, ...(installation ? { installation } : {}),
      treatment: { id: id(treatmentId), name: clean(treatmentName) } };
    if (hasRoom && !phase.installation_ids.includes(step.installation_id)) add('TREATMENT_INSTALLATION_NOT_ALLOWED',
      `${installation.name} no está asignada a este tratamiento.${phase.installation_ids.length ? ` Las salas asignadas son ${phase.installation_ids.map(value => context.installations.get(value)?.name || 'una sala no disponible').join(', ')}.` : ''}`,
      { ...details, assigned_installations: phase.installation_ids.map(value => descriptor('installation', value, context.installations.get(value))) });
    if (hasRoom) { schedule(room, first, last, 'INSTALLATION', installation, details); busy(room, first, last, 'INSTALLATION', installation, details); }
    for (const doctorId of step.doctor_ids) {
      const resource = context.doctors.get(doctorId), doctor = descriptor('doctor', doctorId, resource), staffDetails = { ...details, doctor };
      if (!phase.professionals.ids.includes(doctorId)) add('TREATMENT_PROFESSIONAL_NOT_ALLOWED',
        `${doctor.name} no está asignado a este tratamiento. Está asignado a ${phase.professionals.ids.map(value => context.doctors.get(value)?.name || 'un profesional no disponible').join(', ')}.`,
        { ...staffDetails, assigned_doctors: phase.professionals.ids.map(value => descriptor('doctor', value, context.doctors.get(value))) });
      if (phase.professionals.mode === 'any' && phase.professionals.ids.includes(doctorId)
        && doctorId !== phase.professionals.preferred_id && !professionalFallbackAllowed({ profileVersion: profile.version,
          professionals: phase.professionals, primary: context.doctors.get(phase.professionals.preferred_id), start: first, end: last,
          policies: step.staff_attention || [normalizeAttentionPolicy(null)] })) add('PROFESSIONAL_SUBSTITUTION_NOT_ALLOWED',
        `${doctor.name} es el profesional alternativo. Este tratamiento sólo prevé la sustitución en una ausencia del profesional prioritario; esa condición no se cumple aquí.`,
        { ...staffDetails, assigned_doctors: [descriptor('doctor', phase.professionals.preferred_id, context.doctors.get(phase.professionals.preferred_id))] });
      if (hasRoom && !installationAllowsStaff(room, [doctorId])) add('INSTALLATION_PROFESSIONAL_NOT_ALLOWED',
        `${doctor.name} no figura entre los profesionales asignados a ${installation.name}.`, staffDetails);
      const ranges = step.staff_intervals || [{ start_at: step.staff_time_scope === 'appointment' ? solution.start_at : step.start_at,
        end_at: step.staff_time_scope === 'appointment' ? solution.end_at : step.end_at }];
      for (const range of ranges) {
        schedule(resource, new Date(range.start_at), new Date(range.end_at), 'STAFF', doctor, staffDetails);
        busy(resource, new Date(range.start_at), new Date(range.end_at), 'STAFF', doctor, staffDetails);
      }
      if (profile.version === 4 && attentionVisitConflict(resource, { phase, visitStart: start, start: first, end: last,
        policies: step.staff_attention || [normalizeAttentionPolicy(null)] }) && !restrictions.some(item => item.doctor?.id === doctorId && item.code === 'STAFF_OVERLAP')) {
        const conflict = attentionVisitConflict(resource, { phase, visitStart: start, start: first, end: last,
          policies: step.staff_attention || [normalizeAttentionPolicy(null)] });
        const visit = (resource.attention_visits || []).find(row => intersects(row, first, last));
        const diagnostic = visit?.diagnostic || {}, own = diagnostic.kind !== 'other_clinic';
        add('STAFF_ATTENTION_CONFLICT', `${doctor.name} tiene otra cita${own && diagnostic.treatment_name ? ` de ${clean(diagnostic.treatment_name)}` : ''}${visit ? ` de ${clock(visit.start)} a ${clock(visit.end)}` : ''}${!own ? ' en otra clínica' : own && diagnostic.installation_name ? ` en ${clean(diagnostic.installation_name)}` : ''}. ${conflict.message} Confirma únicamente si la clínica puede atender ambas reservas.`,
          { ...staffDetails, ...(visit ? { conflict_start_at: new Date(visit.start).toISOString(), conflict_end_at: new Date(visit.end).toISOString() } : {}),
            ...(!own ? { other_clinic: true } : {}),
            ...(own && diagnostic.treatment_name ? { conflicting_treatment: { name: clean(diagnostic.treatment_name) } } : {}),
            ...(own && diagnostic.installation_name ? { conflicting_installation: { name: clean(diagnostic.installation_name) } } : {}) });
      }
    }
    for (const machine of step.equipment || []) {
      const resource = context.equipment?.get(machine.id), descriptorValue = descriptor('equipment', machine.id, resource);
      busy(resource, first, new Date(+last + machine.turnaround_minutes * 60000), 'EQUIPMENT', descriptorValue, details);
    }
    for (const staffId of additionalStaffIds) if (hasRoom && !installationAllowsStaff(room, [staffId])) add('INSTALLATION_PROFESSIONAL_NOT_ALLOWED',
      `${context.doctors.get(staffId)?.name || 'El personal de apoyo'} no figura entre los profesionales asignados a ${installation.name}.`,
      { ...details, doctor: descriptor('doctor', staffId, context.doctors.get(staffId)), resource_role: 'additional_staff' });
  }
  for (const staffId of additionalStaffIds) {
    const resource = context.doctors.get(staffId), doctor = descriptor('doctor', staffId, resource);
    schedule(resource, start, end, 'STAFF', doctor, { resource_role: 'additional_staff' });
    busy(resource, start, end, 'STAFF', doctor, { resource_role: 'additional_staff' });
  }
  for (const row of context.patientBusy || []) if (intersects(row, start, end)) {
    const own = Number(row.clinic_id) === Number(clinicId), clinician = own ? context.doctors.get(Number(row.doctor_id)) : null;
    add('PATIENT_OVERLAP',
      `Este paciente ya tiene otra cita${clinician?.name ? ` con ${clean(clinician.name)}` : ''} de ${clock(row.start)} a ${clock(row.end)}${!own ? ' en otra clínica' : ''}. Las citas se solapan.`,
      { conflict_start_at: new Date(row.start).toISOString(), conflict_end_at: new Date(row.end).toISOString(),
        ...(clinician ? { conflicting_doctor: descriptor('doctor', Number(row.doctor_id), clinician) } : {}), ...(!own ? { other_clinic: true } : {}) });
  }
  // Keep the existing, precise machine-window explanation in the same JSON
  // used for hover and confirmation. This is pure snapshot work: no extra
  // query, and no inference that a historical whole-visit hold means the
  // current protocol requires continuous care.
  if (solution && !doctorOnly && profile.phases.length === 1 && restrictions.some(row => /^(STAFF|EQUIPMENT)_(OVERLAP|BLOCKED)$/.test(row.code))) {
    const diagnostic = explainUnavailableStart({ profile: selectedProfile, context, start,
      selections: chosen, additionalStaffIds });
    if (['staff_intervention', 'equipment_busy'].includes(diagnostic.details.reason_key)) {
      const target = restrictions.find(row => diagnostic.details.reason_key === 'staff_intervention'
        ? /^STAFF_(OVERLAP|BLOCKED)$/.test(row.code) && (!diagnostic.resource_id || row.doctor?.id === diagnostic.resource_id)
        : /^EQUIPMENT_(OVERLAP|BLOCKED)$/.test(row.code));
      if (target) {
        const prefix = target.doctor?.name || target.equipment?.name;
        const explanation = prefix && diagnostic.details.message.startsWith(`${prefix}: `)
          ? diagnostic.details.message.slice(prefix.length + 2) : diagnostic.details.message;
        target.message += ` Para esta cita, ${explanation.charAt(0).toLowerCase()}${explanation.slice(1)}`;
      }
    }
  }
  const unique = [...new Map(restrictions.map(row => [canonical(row), row])).values()];
  const stableRows = rows => rows == null ? rows : [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const resourceFacts = map => [...(map || new Map())].map(([key, value]) => [key, {
    windows: stableRows(value.windows), schedule_windows: stableRows(value.schedule_windows), busy: stableRows(value.busy), absence_windows: stableRows(value.absence_windows), attention_visits: stableRows(value.attention_visits),
    status: value.status, installation_ids: value.installation_ids ? [...value.installation_ids].sort((a, b) => a - b) : undefined,
    profesionales_permitidos: value.profesionales_permitidos,
  }]).sort((a, b) => Number(a[0]) - Number(b[0]));
  unique.sort((a, b) => {
    const priority = value => value.code === 'TREATMENT_PROFESSIONAL_NOT_ALLOWED' ? 0 : value.code.startsWith('TREATMENT_') ? 1 : value.code.includes('OUT_OF_HOURS') ? 2 : 3;
    return priority(a) - priority(b) || canonical(a).localeCompare(canonical(b));
  });
  const canConfirm = eligible && explicit && scopeValid && !!solution && !!unique.length;
  // Linked moves must seal evidence for unrestricted members too: a changed
  // earlier phase can invalidate the confirmation for the whole move.
  const expected = eligible && explicit && scopeValid && !!solution && Number.isSafeInteger(Number(actorId)) && Number(actorId) > 0 ? createHash('sha256').update(canonical({ schema: 'manual-booking-restrictions/1', actor: Number(actorId),
    clinic: Number(clinicId), treatment: id(treatmentId), patient: id(patientId), appointment: id(appointmentId),
    previous: previous ? [previous.inicio, previous.fin, previous.estado, previous.updated_at] : null,
    profile, selections: chosen, additional_staff: additionalStaffIds, range: [start.toISOString(), end.toISOString()],
    solution, clinicWindows: stableRows(context.clinicWindows), doctors: resourceFacts(context.doctors), installations: resourceFacts(context.installations),
    equipment: resourceFacts(context.equipment), patientBusy: stableRows(context.patientBusy || []), restrictions: unique,
  })).digest('hex') : null;
  const confirmed = canConfirm && !!expected && typeof acknowledgement === 'string' && /^[a-f0-9]{64}$/.test(acknowledgement)
    && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(acknowledgement, 'hex'));
  return { solution, effectiveProfile, restrictions: unique, canConfirm, acknowledgement: expected, confirmed, ...(doctorOnly ? { doctorOnly: true } : {}) };
}

function restrictionErrorDetails(result) {
  return { can_force: false, can_confirm_restrictions: result.canConfirm,
    booking_restriction_acknowledgement: result.acknowledgement, booking_restrictions: result.restrictions,
    ...(result.solution ? { booking: result.solution,
      booking_plan_sha256: require('./booking-plan-receipt').bookingPlanHash(result.effectiveProfile, result.solution, { doctorOnly: result.doctorOnly === true }) } : {}) };
}
function restrictionResourceConflicts(result) {
  return result.restrictions.map(row => ({ resource_type: row.doctor ? 'staff' : row.equipment ? 'equipment' : row.installation ? 'installation' : 'clinic',
    resource_id: row.doctor?.id || row.equipment?.id || row.installation?.id || null, code: row.code, can_force: false,
    can_confirm_restrictions: result.canConfirm, details: { ...row, availability_semantics: 'appointment_start',
      reason_key: row.code === 'PATIENT_OVERLAP' ? 'patient_busy' : row.code.toLowerCase(), booking_restrictions: result.restrictions } }));
}

module.exports = { restrictionReadProfile, normalizedSelections, assessment, restrictionErrorDetails, restrictionResourceConflicts };

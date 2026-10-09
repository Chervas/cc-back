'use strict';
const { CITA_ALLOWED_TRANSITIONS } = require('./status-catalog');
const terminal = new Set(['cancelada', 'completada', 'no_asistio']);
const fail = (code, message) => { throw Object.assign(new Error(message), { statusCode: 409, code }); };
function careState(cita, now = new Date()) {
  const sameSchedule = !!cita.care_schedule_start && new Date(cita.care_schedule_start).getTime() === new Date(cita.inicio).getTime();
  const active = !terminal.has(cita.estado);
  const legacy = cita.care_legacy_attendance === true || cita.care_legacy_attendance === 1;
  const arrived = sameSchedule ? cita.arrived_at || null : null;
  const started = sameSchedule ? cita.care_started_at || null : null;
  const scheduleStarted = !!cita.inicio && Number.isFinite(new Date(cita.inicio).getTime()) && new Date(cita.inicio) <= now;
  return {
    arrived_at: arrived,
    started_at: started,
    completed_at: sameSchedule ? cita.care_completed_at || null : null,
    legacy_attendance: legacy,
    can_arrive: active && !legacy && !cita.es_provisional && !!cita.paciente_id && scheduleStarted && !arrived,
    can_no_show: (CITA_ALLOWED_TRANSITIONS[cita.estado] || []).includes('no_asistio')
      && active && !legacy && !cita.es_provisional && !!cita.paciente_id && scheduleStarted && !arrived && !started,
    can_start: active && !legacy && !cita.es_provisional && !!cita.paciente_id && !!arrived && ['ha_acudido', 'en_atencion'].includes(cita.estado),
    can_complete: active && !legacy && !cita.es_provisional && !!cita.paciente_id && !!arrived && !!started && cita.estado === 'en_atencion',
  };
}
function assertCareAction(cita, action, now = new Date()) {
  if (!['arrive', 'start', 'finish'].includes(action)) fail('care_action_invalid', 'Acción de cita no válida.');
  const state = careState(cita, now);
  if (action === 'finish' && hasCompletedAppointmentCare(cita)) return state;
  if (state.legacy_attendance) fail('care_legacy_attendance', 'Esta cita conserva una asistencia histórica, no una atención finalizada. No se puede repetir su finalización.');
  if (terminal.has(cita.estado) || cita.es_provisional || !cita.paciente_id) fail('care_appointment_inactive', 'Esta cita no admite registrar llegada ni iniciar atención.');
  if (action === 'arrive' && !state.arrived_at && !state.can_arrive) fail('care_too_early', 'La llegada se puede registrar a partir de la hora de la cita.');
  if (action === 'start' && !state.arrived_at) fail('care_arrival_required', 'Registra primero que el paciente ha acudido.');
  if (action === 'start' && !state.can_start) fail('care_state_invalid', 'El estado de la cita no permite iniciar la atención.');
  if (action === 'finish' && !state.can_complete) fail('care_start_required', 'Inicia la atención de esta cita antes de finalizarla.');
  return state;
}

function careActionPatch(cita, action, { now = new Date(), actorId } = {}) {
  assertCareAction(cita, action, now);
  if (!Number.isSafeInteger(Number(actorId)) || Number(actorId) <= 0) fail('care_actor_required', 'La acción necesita un usuario autenticado.');
  if (action === 'arrive') return { estado: 'ha_acudido', arrived_at: now, arrived_by: Number(actorId),
    care_started_at: null, care_started_by: null, care_completed_at: null, care_completed_by: null, care_schedule_start: cita.inicio };
  if (action === 'start') return { estado: 'en_atencion', care_started_at: now, care_started_by: Number(actorId) };
  return { estado: 'completada', care_completed_at: now, care_completed_by: Number(actorId) };
}

function hasCompletedAppointmentCare(cita) {
  if (!cita || cita.estado !== 'completada') return false;
  const care = careState(cita);
  return !care.legacy_attendance && !!care.arrived_at && !!care.started_at && !!care.completed_at;
}

function allowsAppointmentAutomation(cita, triggerType) {
  if (!cita) return false;
  const care = careState(cita);
  if (['appointment_completed', 'appointment_after'].includes(triggerType)) return hasCompletedAppointmentCare(cita);
  if (['appointment_created', 'appointment_confirmed', 'appointment_rescheduled', 'appointment_reminder_window', 'consent_required'].includes(triggerType)) {
    return !require('./status-catalog').hasAttendedAppointment(cita) && !care.arrived_at;
  }
  return true;
}

function assertCareStatusChange(previous, next, now = new Date(), { additionalStaffIds } = {}) {
  if (!next) return;
  previous = previous || {};
  const care = careState(previous, now);
  // Clinical evidence belongs to this exact reservation, not a moved or relabelled appointment.
  if (care.started_at || previous.estado === 'en_atencion' || previous.estado === 'completada' || care.legacy_attendance) {
    const timeChanged = ['inicio', 'fin'].some(key => Object.hasOwn(next, key)
      && new Date(next[key]).getTime() !== new Date(previous[key]).getTime());
    const identityChanged = ['paciente_id', 'clinica_id', 'tratamiento_id', 'doctor_id', 'instalacion_id'].some(key => Object.hasOwn(next, key)
      && Number(next[key] || 0) !== Number(previous[key] || 0));
    const phaseResources = row => {
      let metadata = row.import_metadata;
      if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { return null; } }
      const phases = metadata?.booking?.phases;
      return Array.isArray(phases) ? JSON.stringify(phases.map(phase => [phase?.key,
        Number(phase?.installation_id || 0), (Array.isArray(phase?.doctor_ids) ? phase.doctor_ids : []).map(Number).sort((a, b) => a - b)])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))) : null;
    };
    const previousPhases = phaseResources(previous), nextPhases = phaseResources(next);
    const phaseResourcesChanged = previousPhases !== null && nextPhases !== null && previousPhases !== nextPhases;
    const supportChanged = additionalStaffIds !== undefined && JSON.stringify(additionalStaffIds)
      !== JSON.stringify(require('./appointment-additional-staff').additionalStaffSnapshot(previous)?.ids || []);
    if (timeChanged || identityChanged || phaseResourcesChanged || supportChanged) fail('care_reservation_locked', 'La cita conserva evidencia de atención o asistencia histórica. No cambies su paciente, tratamiento, horario, profesional, sala ni personal de apoyo.');
  }
  if (!next.estado || previous.estado === next.estado) return;
  if (care.legacy_attendance) fail('care_legacy_attendance', 'Conserva la asistencia histórica; su corrección requiere revisar el historial.');
  if (previous.estado === 'completada') fail('care_already_completed', 'La atención ya está finalizada. Conserva su historial clínico.');
  if (previous.estado === 'en_atencion' && next.estado !== 'completada') fail('care_already_started', 'La atención ya está iniciada. No se puede sustituir por una confirmación o cancelación.');
  if (next.estado === 'no_asistio') {
    // Compare actual instants, not server-local hours: stored appointments are
    // UTC dates and an offset-bearing request represents the same clinic time.
    const startValue = Object.hasOwn(next, 'inicio') ? next.inicio : previous.inicio;
    const startsAt = new Date(startValue).getTime();
    if (!startValue || !Number.isFinite(startsAt) || !Number.isFinite(new Date(now).getTime())) {
      fail('care_no_show_start_required', 'Revisa la fecha y la hora de la cita antes de marcar «No acude».');
    }
    if (startsAt > new Date(now).getTime()) fail('care_no_show_too_early', 'Todavía no ha llegado la hora de esta cita. Puedes marcar «No acude» a partir de su hora de inicio.');
    if (previous.estado === 'cancelada') fail('care_appointment_inactive', 'Esta cita está cancelada. No se puede marcar «No acude».');
    if (care.arrived_at || care.started_at || previous.estado === 'ha_acudido') {
      fail('care_already_arrived', 'Ya se ha registrado la llegada del paciente. No se puede marcar «No acude».');
    }
    if (previous.estado && !(CITA_ALLOWED_TRANSITIONS[previous.estado] || []).includes('no_asistio')) {
      fail('care_no_show_state_invalid', 'El estado actual de esta cita no permite marcar «No acude». Revisa primero su cambio pendiente.');
    }
  }
  if (['ha_acudido', 'en_atencion'].includes(next.estado)) fail('care_action_required', 'Registra la llegada o el inicio mediante la acción correspondiente de esta cita.');
}

module.exports = { careState, assertCareAction, careActionPatch, hasCompletedAppointmentCare, allowsAppointmentAutomation, assertCareStatusChange };

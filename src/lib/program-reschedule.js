'use strict';

const { domainError } = require('./treatmentPrograms.contract');
const { formatPartsInTimeZone } = require('./availability-calendar');
const { resolveLocalInstant } = require('./voucher-schedule-calendar');
const { hash } = require('./cliniccloud-import/adapter');
const fail = (code, message, status = 409) => { throw domainError(status, code, message); };
const object = value => { if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } } return value && typeof value === 'object' && !Array.isArray(value) ? value : null; };
const pad = value => String(value).padStart(2, '0');
function rescheduleInput(payload) {
  if (payload.mode !== 'reschedule') return null;
  if (!['single', 'following'].includes(payload.reschedule_scope) || !/^[a-zA-Z0-9_-]{1,64}$/.test(payload.replan_from_key || '')
    || !/^[a-f0-9]{64}$/.test(payload.expected_plan_revision || '')) {
    fail('program_reschedule_request_invalid', 'Actualiza el programa y elige qué citas quieres mover.', 400);
  }
  if (payload.reschedule_reason != null && !['patient_request', 'clinic_schedule', 'administrative_error'].includes(payload.reschedule_reason)) {
    fail('program_reschedule_reason_invalid', 'Elige un motivo válido para el cambio.', 400);
  }
  return { mode: 'reschedule', reschedule_scope: payload.reschedule_scope, replan_from_key: payload.replan_from_key,
    expected_plan_revision: payload.expected_plan_revision,
    ...(payload.reschedule_reason != null ? { reschedule_reason: payload.reschedule_reason } : {}) };
}
const movable = (row, now) => row.scheduling_status === 'reserved' && row.appointment && !row.record?.consumption_movement_id
  && !row.appointment.care_started_at && !row.appointment.care_completed_at
  && !['en_atencion', 'completada', 'no_asistio', 'cancelada'].includes(row.appointment.estado)
  && Number.isFinite(new Date(row.start_at).getTime()) && new Date(row.start_at) > now;
function rescheduleSessions(plan, request, now = new Date()) {
  const origin = plan.sessions.find(row => row.key === request.replan_from_key);
  if (!origin || !movable(origin, now)) fail('program_reschedule_source_changed', 'La cita de origen ya no es una reserva futura sin episodio iniciado. Actualiza la agenda.');
  const selected = request.reschedule_scope === 'single' ? [origin]
    : plan.sessions.filter(row => row.position >= origin.position && movable(row, now)).sort((a, b) => a.position - b.position);
  if (selected.length > 30) fail('program_reschedule_batch_too_large', 'Reprograma hasta treinta reservas futuras a la vez.');
  if (selected.some(row => object(row.appointment.import_metadata)?.automation_policy !== 'hold')) {
    fail('program_reschedule_communications_review', 'Revisa las comunicaciones activas antes de mover estas citas del programa.');
  }
  return selected;
}
function civilLocal(instant, timeZone) {
  const p = formatPartsInTimeZone(new Date(instant), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
function civilMinute(instant, timeZone) {
  const local = civilLocal(instant, timeZone), naive = new Date(local + ':00.000Z').getTime();
  if (!Number.isFinite(naive)) fail('program_reschedule_date_invalid', 'La fecha de reprogramación no es válida.', 400);
  return naive / 60000;
}
function localInstant(local, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local || '')) fail('program_reschedule_date_invalid', 'Elige la fecha y hora local de la cita.', 400);
  return resolveLocalInstant(local.slice(0, 10), local.slice(11) + ':00', timeZone);
}
function effectiveSelections(session) {
  const phases = object(session.appointment?.import_metadata)?.booking?.phases;
  if (!Array.isArray(phases) || phases.length !== session.booking_profile.phases.length) fail('program_reschedule_resources_invalid', 'La cita no acredita todos sus recursos. Revisa su reserva antes de moverla.');
  return Object.fromEntries(session.booking_profile.phases.map((profile, index) => {
    const phase = phases[index], ids = Array.isArray(phase?.doctor_ids) ? phase.doctor_ids.map(Number) : null;
    if (!Number.isSafeInteger(Number(phase?.installation_id)) || !profile.installation_ids.includes(Number(phase.installation_id))
      || !Array.isArray(ids) || !ids.length || ids.some(id => !profile.professionals.ids.includes(id))
      || profile.professionals.mode === 'any' && ids.length !== 1
      || profile.professionals.mode === 'all' && (ids.length !== profile.professionals.ids.length || new Set(ids).size !== ids.length)) {
      fail('program_reschedule_resources_invalid', 'La reserva no corresponde a los recursos de esta sesión.');
    }
    return [profile.key, { installation_id: Number(phase.installation_id), ...(profile.professionals.mode === 'any' ? { doctor_id: ids[0] } : {}) }];
  }));
}
function shiftedChoices(plan, selected, request, startLocal, overrides = []) {
  if (!Array.isArray(overrides) || overrides.length > 30 || new Set(overrides.map(row => row?.key)).size !== overrides.length
    || overrides.some(row => !row || !selected.some(session => session.key === row.key)
      || Object.keys(row).some(key => !['key', 'selections', 'priority_acknowledged'].includes(key)))) {
    fail('program_reschedule_selection_invalid', 'Revisa los recursos elegidos para las citas que vas a mover.', 400);
  }
  const origin = selected.find(row => row.key === request.replan_from_key), first = localInstant(startLocal, plan.timeZone);
  const delta = civilMinute(first, plan.timeZone) - civilMinute(origin.start_at, plan.timeZone);
  return selected.map(session => {
    const naive = new Date((civilMinute(session.start_at, plan.timeZone) + delta) * 60000);
    const local = naive.toISOString().slice(0, 16), start = localInstant(local, plan.timeZone);
    const original = effectiveSelections(session), override = overrides.find(row => row.key === session.key);
    if (override && Object.hasOwn(override, 'selections') && !object(override.selections)) {
      fail('program_reschedule_selection_invalid', 'Selecciona recursos válidos para la cita.', 400);
    }
    const selections = { ...original };
    for (const [key, choice] of Object.entries(override?.selections || {})) {
      if (!object(choice)) fail('program_reschedule_selection_invalid', 'Selecciona recursos válidos para cada fase.', 400);
      selections[key] = { ...(original[key] || {}), ...choice };
    }
    return { key: session.key, start_at: start.toISOString(), start_local: local, selections,
      priority_acknowledged: override?.priority_acknowledged ?? (hash(selections) === hash(original)
        && object(session.appointment.import_metadata)?.booking?.priority_acknowledged === true) };
  });
}
function assertCivilShift(plan, selected, request) {
  if (request.sessions.length !== selected.length || selected.some(row => !request.sessions.some(choice => choice.key === row.key))) {
    fail('program_reschedule_incomplete', 'Confirma exactamente las reservas futuras del tramo elegido; las sesiones sin fecha no se modifican.');
  }
  const origin = selected.find(row => row.key === request.replan_from_key), anchor = request.sessions.find(row => row.key === origin.key);
  const delta = civilMinute(anchor.start_at, plan.timeZone) - civilMinute(origin.start_at, plan.timeZone);
  for (const row of selected) {
    const choice = request.sessions.find(item => item.key === row.key);
    // Explicit UTC cannot choose either occurrence of an ambiguous local time.
    localInstant(civilLocal(choice.start_at, plan.timeZone), plan.timeZone);
    if (civilMinute(choice.start_at, plan.timeZone) - civilMinute(row.start_at, plan.timeZone) !== delta) {
      fail('program_reschedule_intervals_changed', 'Conserva las separaciones entre las reservas del programa. No se ha movido ninguna cita.');
    }
  }
}
function rescheduleDto(request, selected, startLocal) {
  return { scope: request.reschedule_scope, from_key: request.replan_from_key,
    source_appointment_id: Number(selected.find(row => row.key === request.replan_from_key).appointment.id_cita),
    affected_count: selected.length, affected_keys: selected.map(row => row.key), start_local: startLocal };
}
function assertCoordinatedScheduleChange(previous, values, coordinated) {
  if (!coordinated && ['inicio', 'fin'].some(key => new Date(previous[key]).getTime() !== new Date(values[key]).getTime())) {
    fail('program_reschedule_required', 'Mueve esta cita desde Agenda para revisar si quieres cambiar sólo esta o también las siguientes del programa.');
  }
}
module.exports = { rescheduleInput, rescheduleSessions, civilLocal, civilMinute, localInstant, effectiveSelections, shiftedChoices, assertCivilShift, rescheduleDto, assertCoordinatedScheduleChange };

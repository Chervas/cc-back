'use strict';
const terminal = new Set(['cancelada', 'reprogramada', 'completada', 'no_asistio']);
const fail = (code, message) => { throw Object.assign(new Error(message), { statusCode: 409, code }); };
function careState(cita, now = new Date()) {
  const sameSchedule = !!cita.care_schedule_start && new Date(cita.care_schedule_start).getTime() === new Date(cita.inicio).getTime();
  const active = !terminal.has(cita.estado);
  return {
    arrived_at: sameSchedule ? cita.arrived_at || null : null,
    started_at: sameSchedule ? cita.care_started_at || null : null,
    can_arrive: active && !cita.es_provisional && !!cita.paciente_id && new Date(cita.inicio) <= now && !(sameSchedule && cita.arrived_at),
    can_start: active && !!cita.paciente_id && sameSchedule && !!cita.arrived_at,
  };
}
function assertCareAction(cita, action, now = new Date()) {
  if (!['arrive', 'start'].includes(action)) fail('care_action_invalid', 'Acción de cita no válida.');
  if (terminal.has(cita.estado) || cita.es_provisional || !cita.paciente_id) fail('care_appointment_inactive', 'Esta cita no admite registrar llegada ni iniciar atención.');
  const state = careState(cita, now);
  if (action === 'arrive' && !state.arrived_at && !state.can_arrive) fail('care_too_early', 'La llegada se puede registrar a partir de la hora de la cita.');
  if (action === 'start' && !state.arrived_at) fail('care_arrival_required', 'Registra primero que el paciente ha acudido.');
  return state;
}
module.exports = { careState, assertCareAction };

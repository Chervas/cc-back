'use strict';

const { hash } = require('./cliniccloud-import/adapter');
const { domainError } = require('./treatmentPrograms.contract');
const fail = (code, message) => { throw domainError(409, code, message); };
const plain = value => value?.toJSON ? value.toJSON() : value;

function schedulingState(record, appointment) {
  if (record?.consumption_movement_id || appointment?.estado === 'completada') return 'completed';
  if (appointment?.estado === 'no_asistio') return 'missed';
  return appointment && appointment.estado !== 'cancelada' ? 'reserved' : 'pending';
}
function planRevision(plan) {
  // Normalize ORM Date instances before canonical hashing; otherwise a Date
  // has no enumerable keys and two different appointment times hash equally.
  return hash(JSON.parse(JSON.stringify({ snapshot:plan.snapshot.sha256, voucher:plain(plan.voucher), budget:plain(plan.budget),
    sessions:plan.sessions.map(row=>({key:row.key,record:plain(row.record)||null,appointment:plain(row.appointment)||null})) })));
}
function resumeInfo(plan, now = new Date()) {
  const interrupted = plan.sessions.some(row => row.scheduling_status === 'missed'
    || row.scheduling_status === 'pending' && row.appointment?.estado === 'cancelada');
  if (!interrupted) return null;
  const selected = plan.sessions.filter(row => row.scheduling_status !== 'completed');
  if (!selected.length) return null;
  const needsAttendance = selected.some(row => row.scheduling_status === 'reserved' && new Date(row.start_at) <= now);
  const outOfOrder = plan.sessions.some(row => row.scheduling_status === 'completed' && row.position > selected[0].position);
  const activeNotifications = selected.some(row => {
    if (row.scheduling_status !== 'reserved') return false;
    const metadata = typeof row.appointment.import_metadata === 'string' ? JSON.parse(row.appointment.import_metadata) : row.appointment.import_metadata;
    return metadata?.automation_policy !== 'hold';
  });
  const blocked = outOfOrder ? 'Hay sesiones realizadas después de una pendiente. Revisa el orden clínico antes de retomar el programa.'
    : needsAttendance ? 'Indica primero si el paciente asistió a las citas anteriores que siguen abiertas.'
    : activeNotifications ? 'Hay citas con comunicaciones activadas. Revisa su reprogramación desde la agenda.'
    : selected.length > 30 ? 'Este programa tiene más de treinta sesiones pendientes; revisa su planificación desde la agenda.' : null;
  return { from_key:selected[0].key, from_label:selected[0].label, affected_count:selected.length,
    existing_reservations_count:selected.filter(row=>row.scheduling_status==='reserved').length,
    missed_count:selected.filter(row=>row.scheduling_status==='missed').length, blocked_reason:blocked };
}
function resumeSessions(plan, fromKey, now) {
  const info = resumeInfo(plan, now);
  if (!info || info.from_key !== fromKey) fail('program_resume_changed','Actualiza el programa: ha cambiado la sesión desde la que se debe continuar.');
  if (info.blocked_reason) fail('program_resume_review_required',info.blocked_reason);
  return plan.sessions.filter(row=>row.scheduling_status!=='completed');
}
function resumeInput(payload) {
  if (payload.mode == null && payload.replan_from_key == null && payload.expected_plan_revision == null) return null;
  if (payload.mode !== 'resume' || !/^[a-zA-Z0-9_-]{1,64}$/.test(payload.replan_from_key || '')
    || !/^[a-f0-9]{64}$/.test(payload.expected_plan_revision || '')) {
    throw domainError(400,'program_resume_request_invalid','Actualiza el programa antes de retomar sus citas.');
  }
  return { mode:'resume', replan_from_key:payload.replan_from_key, expected_plan_revision:payload.expected_plan_revision };
}
function assertRevision(plan, expected) {
  if (planRevision(plan) !== expected) fail('program_resume_changed','Otra persona ha cambiado el programa o una cita. Actualiza las fechas antes de confirmar; no se ha movido ninguna cita.');
}

// An in-process capability, never a JSON-shaped flag accepted from HTTP. It
// binds the already checked series to its transaction and individual writes.
const contexts = new WeakMap();
function createSeriesContext({ transaction, plan, selected, series }) {
  if (!transaction || !Array.isArray(selected) || !selected.length) throw Error('program_series_context_invalid');
  const token=Object.freeze({});
  contexts.set(token,{transaction,voucherId:Number(plan.voucher.id),clinicId:Number(plan.voucher.clinic_id),
    patientId:Number(plan.voucher.patient_id),timeZone:plan.timeZone,
    series:structuredClone(series), targets:new Map(selected.map(row=>[row.key,{
      sessionId:row.record?.id == null ? null : String(row.record.id),
      appointmentId:row.scheduling_status==='reserved'?Number(row.appointment.id_cita):null,
      start:new Date(row.start_at).getTime(),end:new Date(row.end_at).getTime(),
    }]))});
  return token;
}
function assertSeriesContext(token, { transaction, session, existing, values }) {
  const context=token&&contexts.get(token), target=context?.targets.get(session?.session_key);
  if (!context || context.transaction!==transaction || !target
    || target.sessionId!==String(session.id) || Number(session.voucher_id)!==context.voucherId
    || Number(values.voucher_id)!==context.voucherId || Number(values.clinica_id)!==context.clinicId
    || Number(values.paciente_id)!==context.patientId || (existing?Number(existing.id_cita):null)!==target.appointmentId
    || new Date(values.inicio).getTime()!==target.start || new Date(values.fin).getTime()!==target.end) {
    throw Error('program_series_context_invalid');
  }
  return {series:structuredClone(context.series),timeZone:context.timeZone};
}
module.exports={schedulingState,planRevision,resumeInfo,resumeSessions,resumeInput,assertRevision,createSeriesContext,assertSeriesContext};

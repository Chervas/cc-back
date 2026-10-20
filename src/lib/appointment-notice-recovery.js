'use strict';
const { hash } = require('./appointment-single-notice-publication');
const { suppressRescheduleNotice } = require('./appointment-reschedule-notice');
const { isSyntheticData } = require('./appointment-synthetic-guard');
const { isHistorical } = require('./whatsappImportedAppointmentOperations');
const incident = Object.freeze({ from: '2026-10-20T04:00:00.000Z', until: '2026-10-20T09:43:46.000Z', clinics: [1, 66, 70, 72, 89, 91] });
const instant = value => new Date(typeof value === 'string' && /^\d{4}-\d\d-\d\d /.test(value) ? value.replace(' ', 'T') + 'Z' : value).getTime();
const during = value => instant(value) >= Date.parse(incident.from) && instant(value) <= Date.parse(incident.until);
const truth = value => value === true || value === 1 || value === '1' || value === 'true';
const fields = ['id_cita', 'clinica_id', 'paciente_id', 'doctor_id', 'instalacion_id', 'tratamiento_id', 'lead_intake_id', 'tipo_cita', 'titulo', 'motivo', 'inicio', 'fin',
  'estado', 'reschedule_reason', 'created_at', 'updated_at', 'source_system', 'source_reference', 'es_provisional',
  'hold_expires_at', 'import_metadata', 'arrived_at', 'care_started_at', 'care_schedule_start', 'care_completed_at'];
function evidenceHash(s) {
  return hash({ appointment: Object.fromEntries(fields.map(key => [key, s.appointment[key]])), patient: s.patient,
    events: s.events, executions: s.executions, messages: s.messages.map(m => ({ ...m, content: hash(m.content || '') })),
    treatment: s.treatment });
}
function assess(s, { now = Date.now() } = {}) {
  const a = s.appointment, reasons = [];
  const events = s.events.filter(e => e.event_type === 'appointment.status_changed' && e.metadata?.route === 'reagendarCita' && during(e.occurred_at))
    .sort((a, b) => instant(b.occurred_at) - instant(a.occurred_at) || b.id - a.id);
  let source = null;
  const receipt = a.import_metadata?.reschedule_notice;
  const explicitCurrentNotice = receipt?.version === 1 && receipt.send === true && during(receipt.checked_at)
    && Number(receipt.appointment_id) === Number(a.id_cita) && Number(receipt.patient_id) === Number(a.paciente_id)
    && Number(receipt.clinic_id) === Number(a.clinica_id) && instant(receipt.start_at) === instant(a.inicio)
    && instant(receipt.end_at) === instant(a.fin) && /^[a-f0-9]{64}$/.test(receipt.acknowledgement || '');
  if (explicitCurrentNotice) source = { type: 'appointment_rescheduled', id: receipt.acknowledgement, at: receipt.checked_at };
  else if (events.length) {
    const e = events[0];
    if (instant(e.metadata.appointment_start) !== instant(a.inicio)) reasons.push('schedule_changed_since_recorded_reschedule');
    source = { type: 'appointment_rescheduled', id: Number(e.id), at: e.occurred_at };
  } else if (during(a.created_at) && !a.reschedule_reason) source = { type: 'appointment_created', id: Number(a.id_cita), at: a.created_at };
  else reasons.push('no_current_incident_event');
  if (!incident.clinics.includes(Number(a.clinica_id)) || !source) reasons.push('outside_incident_scope');
  if (!['pendiente', 'reprogramada'].includes(a.estado)) reasons.push('appointment_already_progressed_or_cancelled');
  if (!(instant(a.inicio) > now + 15 * 60000)) reasons.push('appointment_not_safely_future');
  if (truth(a.es_provisional) || instant(a.hold_expires_at) > now || a.arrived_at || a.care_started_at || a.care_completed_at) reasons.push('appointment_hold_or_care');
  if (isSyntheticData(a) || isHistorical(a)) reasons.push('historical_or_synthetic');
  if (!truth(s.patient?.has_phone)) reasons.push('missing_phone');
  if (a.reschedule_reason === 'administrative_error' || source?.type === 'appointment_rescheduled' && suppressRescheduleNotice(a)) reasons.push('notice_suppressed_by_operator');
  const since = source ? instant(source.at) - 2000 : Infinity;
  const executions = s.executions.filter(e => !truth(e.simulation) && e.trigger_type === source?.type
    && (source?.type === 'appointment_created' || instant(e.created_at) >= since));
  if (executions.length) reasons.push('existing_native_execution');
  const recent = s.messages.filter(m => m.message_type !== 'event' && instant(m.createdAt) >= since);
  if (recent.some(m => m.direction === 'outbound' && (['pending', 'sending'].includes(m.status)
    || truth(m.outcome_unknown) || truth(m.delivery_unknown) || truth(m.dispatch_wait)))) reasons.push('pending_or_uncertain_delivery');
  const executionIds = new Set(s.executions.map(e => Number(e.id)));
  if (recent.some(m => m.direction === 'outbound' && executionIds.has(Number(m.execution_id)))) reasons.push('appointment_message_already_materialized');
  return { eligible: reasons.length === 0, reasons, source, reviewRequired: recent.length > 0,
    recentMessageIds: recent.map(m => Number(m.id)), evidenceHash: evidenceHash(s) };
}

async function recoverOne({ db, runtime, item, load, actorId, now = () => Date.now() }) {
  const recheck = async transaction => {
    if (transaction) await db.CitaPaciente.findByPk(item.appointmentId, { transaction, lock: transaction.LOCK.UPDATE });
    const current = await load(item.appointmentId, transaction), assessment = assess(current, { now: now() });
    if (!item.approved || !assessment.eligible || assessment.evidenceHash !== item.evidenceHash
      || !assessment.source || assessment.source.type !== item.eventName) throw Error('notice_recovery_evidence_changed');
    return current;
  };
  const current = await recheck();
  const template = await runtime.resolveTemplateForCitaEvent(current.appointment, item.eventName);
  if (!template || !template.is_active || !template.published_at || Number(template.clinic_id) !== Number(current.appointment.clinica_id)
    || !require('./appointment-single-notice-flow').scoped(template)
    || !require('./appointment-single-notice-flow').policyFor(template)
    || template.nodes.some(n => /consent|request_review|google_review|survey/i.test(n.type))) throw Error('notice_recovery_template_ineligible');
  // Same resolver, eligibility gates, execution, job dedupe and dispatcher as
  // an ordinary booking. No status mutation, controller consent hook or send.
  return runtime.enqueueExecutionForTemplate(current.appointment, template, {
    event_name: item.eventName, user_id: actorId, user_role: 'admin',
    ...(item.eventName === 'appointment_rescheduled' ? { window_identifier: runtime.buildRescheduledWindowIdentifier(current.appointment) } : {}),
    trigger_data: { reschedule_reason: current.appointment.reschedule_reason,
      explicit_notice_recovery: { version: 1, source_event_id: item.source.id, approved_evidence: item.evidenceHash } },
    jobClaim: { assert: ({ transaction }) => recheck(transaction) },
  });
}
module.exports = { incident, instant, evidenceHash, assess, recoverOne };

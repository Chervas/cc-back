'use strict';

// Offline projection only. No routes, SQL, identity verification, messaging or
// availability calls. An eventual connector must authorize every input first.
// Contract: front/src/Documentacion/41-comunicaciones-e-interoperabilidad.md.
const FHIR_VERSION = '4.0.1';
const MAPPING_VERSION = 'clinicaclick-appointment-r4-draft-2';
const STATES = Object.freeze(['pendiente', 'info_enviada', 'info_confirmada',
  'recordatorio_enviado', 'recordatorio_confirmado', 'cambio_solicitado',
  'ha_acudido', 'en_atencion', 'completada', 'no_asistio', 'cancelada', 'reprogramada']);
const ACTORS = Object.freeze({ doctor: 'Practitioner', installation: 'Location', equipment: 'Device' });

function fail(code) { throw Object.assign(new Error(code), { code }); }
function id(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail('invalid_internal_id');
  return String(value);
}
function namespace(value) {
  // Identifier URI, not a public FHIR endpoint or a claim that it exists.
  if (typeof value !== 'string' || !/^(https:\/\/[^\s?#]+|urn:[a-z0-9][a-z0-9-]*:[^\s?#]+)$/i.test(value)) fail('identifier_namespace_required');
  if (/^https:/i.test(value) && (new URL(value).username || new URL(value).password)) fail('identifier_namespace_invalid');
  return value.replace(/\/$/, '');
}
function instant(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) fail('invalid_instant');
    return value.toISOString();
  }
  if (typeof value !== 'string') fail('explicit_timezone_required');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) fail('explicit_timezone_required');
  const [y, month, day, h, min, sec] = m.slice(1, 7).map(Number);
  const days = new Date(Date.UTC(y, month, 0)).getUTCDate();
  const offset = m[8] === 'Z' ? [0, 0] : m[8].slice(1).split(':').map(Number);
  if (y < 1000 || month < 1 || month > 12 || day < 1 || day > days || h > 23 || min > 59 || sec > 59
    || offset[0] > 14 || offset[1] > 59 || (offset[0] === 14 && offset[1] !== 0) || m[8] === '-00:00') fail('invalid_instant');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('invalid_instant');
  return date.toISOString();
}
function period(start, end) {
  const result = { start: instant(start), end: instant(end) };
  if (result.start >= result.end) fail('invalid_period');
  return result;
}
function context(appointment, options) {
  const clinic = id(appointment.clinica_id);
  if (clinic !== id(options.clinicId)) fail('clinic_scope_mismatch');
  if (!STATES.includes(appointment.estado)) fail('unmapped_appointment_state');
  if (appointment.es_provisional) fail('provisional_hold_not_exportable');
  const base = namespace(options.identifierNamespace);
  return { clinic, base, appointmentId: id(appointment.id_cita), patient: id(appointment.paciente_id),
    period: period(appointment.inicio, appointment.fin),
    version: instant(appointment.updated_at),
    identifier: { system: base + '/appointments', value: clinic + ':' + id(appointment.id_cita) } };
}
function actor(base, type, key) {
  return { type, identifier: { system: base + '/actors', value: key } };
}
function sameIdentifier(a, b) { return !!a && a.system === b.system && a.value === b.value; }

/**
 * appointment: authorized canonical CitaPaciente plain object.
 * options.occupancies: backend-resolved AppointmentBookingOccupancies (not
 * treatment alternatives); resource_key retains shared physical room identity.
 * For older appointments without occupancies, known doctor/room IDs are included
 * but acceptance remains unknown. Never infer staff from a treatment label.
 */
function projectAppointment(appointment, options = {}) {
  const c = context(appointment, options);
  const occupancy = options.occupancies || [];
  if (!Array.isArray(occupancy) || occupancy.length > 500) fail('invalid_occupancies');
  const patientStatus = ['recordatorio_confirmado', 'ha_acudido', 'en_atencion', 'completada'].includes(appointment.estado) ? 'accepted' : 'needs-action';
  const participants = [{ actor: actor(c.base, 'Patient', 'patient:' + c.patient), status: patientStatus }];
  const seen = new Set();
  const warnings = new Set();
  for (const row of occupancy) {
    if (id(row.appointment_id) !== c.appointmentId) fail('occupancy_appointment_mismatch');
    // Patient occupancy is redundant with the canonical patient participant.
    const match = /^(patient|doctor|installation|equipment):([1-9]\d*)$/.exec(row.resource_key || '');
    if (!match || match[1] !== row.resource_kind) fail('invalid_resource_key');
    id(match[2]);
    if (match[1] === 'patient') {
      if (match[2] !== c.patient) fail('occupancy_patient_mismatch');
      continue;
    }
    const reserved = period(row.start_at, row.end_at);
    if (reserved.end <= c.period.start || reserved.start >= c.period.end) fail('occupancy_outside_appointment');
    if (reserved.start < c.period.start || reserved.end > c.period.end) warnings.add('resource_period_includes_preparation');
    const key = row.resource_key + '|' + reserved.start + '|' + reserved.end;
    if (seen.has(key)) continue;
    seen.add(key);
    participants.push({ actor: actor(c.base, ACTORS[match[1]], row.resource_key),
      // Allocation by the clinic is acceptance of the resource reservation,
      // not proof that a professional personally answered a reminder.
      status: 'accepted', period: reserved });
  }
  for (const [field, kind] of [['doctor_id', 'doctor'], ['instalacion_id', 'installation']]) {
    if (appointment[field] == null) continue;
    // The canonical occupancy may name a shared physical Location differently
    // from the clinic's installation row. It takes precedence over the UI ID.
    const covered = occupancy.some(r => r.resource_kind === kind &&
      (kind === 'installation' ? id(r.installation_id) === id(appointment[field]) : r.resource_key === 'doctor:' + id(appointment[field])));
    if (!covered) {
      participants.push({ actor: actor(c.base, ACTORS[kind], kind + ':' + id(appointment[field])), status: 'needs-action' });
      warnings.add('legacy_resource_allocation_unverified');
    }
  }
  const terminal = { ha_acudido: 'arrived', en_atencion: 'checked-in', completada: 'fulfilled', cancelada: 'cancelled', no_asistio: 'noshow' };
  const status = terminal[appointment.estado] || (participants.every(p => p.status === 'accepted') ? 'booked' : 'pending');
  const resource = { resourceType: 'Appointment', identifier: [c.identifier], status,
    start: c.period.start, end: c.period.end, participant: participants };
  if (appointment.created_at != null) resource.created = instant(appointment.created_at);
  if (appointment.source_system || appointment.source_reference) {
    const system = options.sourceIdentifierSystems?.[appointment.source_system];
    if (!system || typeof appointment.source_reference !== 'string' || !appointment.source_reference.trim()) {
      warnings.add('external_identifier_not_exported_without_issuer');
    } else {
      resource.identifier.push({ system: namespace(system), value: appointment.source_reference });
    }
  }
  return { fhir_version: FHIR_VERSION, mapping_version: MAPPING_VERSION, resource,
    // Internal envelope is NOT a FHIR extension/profile and is not exported
    // by default. It preserves information the standard status cannot express.
    provenance: { clinic_id: c.clinic, appointment_id: c.appointmentId, source_version: c.version,
      canonical_state: appointment.estado, reschedule_requested: appointment.estado === 'cambio_solicitado' },
    warnings: [...warnings].sort() };
}

/** Pure proposal; no import, authorization bypass, confirmation or slot move. */
function reviewPatientResponse(response, appointment, options = {}) {
  const c = context(appointment, options);
  if (instant(options.expectedVersion) !== c.version) fail('stale_appointment_response');
  if (response?.resourceType !== 'AppointmentResponse') fail('unsupported_response_resource');
  if (!sameIdentifier(response.appointment?.identifier, c.identifier)) fail('response_appointment_mismatch');
  const expectedActor = actor(c.base, 'Patient', 'patient:' + c.patient);
  if (response.actor?.type !== 'Patient' || !sameIdentifier(response.actor?.identifier, expectedActor.identifier)) fail('response_patient_mismatch');
  if (!['accepted', 'declined', 'tentative', 'needs-action'].includes(response.participantStatus)) fail('unmapped_participation_status');
  if (['ha_acudido', 'en_atencion', 'completada', 'no_asistio', 'cancelada'].includes(appointment.estado)) fail('terminal_appointment_response');
  // Require the schedule the participant actually saw: a bare accepted status
  // cannot confirm a new date after a reschedule, even with a fresh local read.
  const proposed = period(response.start, response.end);
  const changedTime = proposed.start !== c.period.start || proposed.end !== c.period.end;
  const action = changedTime ? 'review_reschedule'
    : response.comment?.trim() ? 'review_response'
    : response.participantStatus === 'accepted' ? 'confirm_attendance'
      : response.participantStatus === 'declined' ? 'review_decline' : 'review_response';
  return { mapping_version: MAPPING_VERSION, action, applies: false, requires_human_review: true,
    clinic_id: c.clinic, appointment_id: c.appointmentId, expected_version: c.version,
    ...(changedTime ? { proposed_period: proposed } : {}) };
}

module.exports = { FHIR_VERSION, MAPPING_VERSION, STATES, instant, projectAppointment, reviewPatientResponse };

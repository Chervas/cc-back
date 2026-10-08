'use strict';

const { createHash } = require('node:crypto');
const { isSyntheticData } = require('./appointment-synthetic-guard');
const { bookingSegments } = require('./appointment-booking-segments');
const { normalizeAttentionPolicy } = require('./booking-attention');
const plain = row => row?.toJSON ? row.toJSON() : row;
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (suffix, status = 409) => { throw Object.assign(Error('appointment_visit_' + suffix), {
  code: 'appointment_visit_' + suffix, status, statusCode: status, retryable: false,
}); };
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) fail('invalid_snapshot', 400);
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function instant(value) {
  if (!(value instanceof Date) && (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value))) fail('invalid_instant', 400);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('invalid_instant', 400);
  return date.toISOString();
}
function object(value) {
  if (value == null) return {};
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { fail('invalid_metadata'); } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_metadata');
  return value;
}
const truth = value => [true, 1, '1', 'true'].includes(value);
function held(value, depth = 0) {
  const m = object(value);
  if (depth > 8) return true;
  return String(m.automation_policy || m.automationPolicy || '').toLowerCase() === 'hold'
    || m.messages_enabled === false || m.messagesEnabled === false
    || ['import', 'cliniccloud_reconciliation', 'cliniccloud_source_booking'].some(key => m[key] != null && held(m[key], depth + 1));
}
const qa = value => isSyntheticData(value);
function lifecycle(appointment) {
  const state = String(appointment.estado || '');
  if (['cancelada', 'no_asistio', 'ha_acudido', 'en_atencion', 'completada'].includes(state)) return state;
  if (['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado', 'reprogramada'].includes(state)) return 'active';
  if (state === 'cambio_solicitado') return 'change_requested';
  fail('unsupported_appointment_state');
}
function optionalId(value) {
  if (value == null) return null;
  const id = Number(value);
  if (!positiveId(id)) fail('invalid_snapshot', 400);
  return id;
}
function groupingEvidence(kind, evidence = {}) {
  if (kind === 'singleton') {
    if (Object.keys(object(evidence)).length) fail('invalid_grouping_evidence');
    return {};
  }
  const e = object(evidence);
  if (kind !== 'validated_prp' || !positiveId(e.component_appointment_id) || !positiveId(e.parent_appointment_id)
    || e.component_appointment_id === e.parent_appointment_id || !/^[a-f0-9]{64}$/.test(e.receipt_sha256 || '')
    || !/^[1-9][0-9]{0,19}$/.test(e.audit_event_id || '')) fail('invalid_grouping_evidence');
  return { component_appointment_id: e.component_appointment_id, parent_appointment_id: e.parent_appointment_id,
    receipt_sha256: e.receipt_sha256, audit_event_id: e.audit_event_id };
}

// The canonical writer freezes import_metadata.booking, not a separate visit
// appointment or the current catalog. Reuse the real phase-contract validator;
// a present but invalid snapshot must never silently collapse to top-level IDs.
function bookingProjection(appointment) {
  const row = plain(appointment), metadata = object(row.import_metadata), booking = metadata.booking;
  let steps = [];
  if (booking != null) {
    const stored = object(booking), segments = bookingSegments({ ...row, import_metadata: { booking: stored } }, { includeClinicalLabels: false });
    if (!segments.length) fail('booking_snapshot_unproven');
    steps = segments.map((segment, index) => ({
      key: segment.phase_key, index: segment.phase_index, start_at: instant(segment.start_at), end_at: instant(segment.end_at),
      installation_id: optionalId(segment.installation_id), doctor_ids: segment.doctor_ids.map(optionalId).sort((a, b) => a - b),
      staff_time_scope: segment.staff_time_scope,
      staff_intervals: (segment.staff_intervals || []).map(interval => ({ kind: interval.kind,
        start_at: instant(interval.start_at), end_at: instant(interval.end_at) })).sort((a, b) => canonical(a).localeCompare(canonical(b))),
      staff_attention: (stored.phases[index].staff_attention || []).map(normalizeAttentionPolicy),
      equipment_ids: (segment.equipment || []).map(unit => optionalId(unit.id)).sort((a, b) => a - b),
      preparation_sharing: segment.preparation_sharing?.mode || null,
    }));
  }
  let support = null;
  if (metadata.additional_staff != null) {
    const saved = object(metadata.additional_staff);
    if (saved.version !== 1 || !Array.isArray(saved.ids) || !saved.ids.length || saved.ids.length > 50) fail('booking_snapshot_unproven');
    const ids = saved.ids.map(optionalId).sort((a, b) => a - b);
    if (ids.some(id => id == null) || new Set(ids).size !== ids.length
      || instant(saved.start_at) !== instant(row.inicio) || instant(saved.end_at) !== instant(row.fin)) fail('booking_snapshot_unproven');
    support = { doctor_ids: ids, start_at: instant(saved.start_at), end_at: instant(saved.end_at) };
  }
  return { steps, support };
}

// Deliberately excludes names, phone numbers, notes, prices, updated_at,
// template versions and provider state. This is reservation communication,
// not inferred treatment equivalence, attendance, administration or billing.
function buildVisitSnapshot({ visitId, ownerAppointmentId, appointments, members, groupingKind, evidence = {} }) {
  if (!uuid(visitId) || !positiveId(ownerAppointmentId) || !Array.isArray(appointments) || !Array.isArray(members)
    || ![1, 2].includes(appointments.length) || members.length !== appointments.length) fail('invalid_snapshot', 400);
  const rows = appointments.map(plain), links = members.map(plain).sort((a, b) => Number(a.appointment_id) - Number(b.appointment_id));
  const clinicId = Number(rows[0].clinica_id), patientId = Number(rows[0].paciente_id);
  if (!positiveId(clinicId) || !positiveId(patientId)) fail('invalid_scope');
  const ids = rows.map(row => Number(row.id_cita));
  if (ids.some(id => !positiveId(id)) || new Set(ids).size !== ids.length || !ids.includes(ownerAppointmentId)) fail('invalid_membership');
  const group = groupingEvidence(groupingKind, evidence);
  if (groupingKind === 'singleton' && rows.length !== 1 || groupingKind === 'validated_prp' && (rows.length !== 2 || ownerAppointmentId !== group.parent_appointment_id)) fail('invalid_membership');
  const projection = links.map(link => {
    const id = Number(link.appointment_id), row = rows.find(a => Number(a.id_cita) === id);
    if (!row || Number(row.clinica_id) !== clinicId || Number(row.paciente_id) !== patientId
      || link.visit_id !== visitId || Number(link.clinic_id) !== clinicId || Number(link.patient_id) !== patientId
      || link.role !== (id === ownerAppointmentId ? 'primary' : 'prp_extraction')) fail('invalid_membership');
    if (groupingKind === 'validated_prp' && ![group.parent_appointment_id, group.component_appointment_id].includes(id)) fail('invalid_membership');
    if (hash(groupingEvidence(groupingKind, link.evidence)) !== hash(group)) fail('invalid_membership');
    const start = instant(row.inicio), end = instant(row.fin);
    if (Date.parse(end) <= Date.parse(start)) fail('invalid_interval');
    return { appointment_id: id, role: link.role, start_at: start, end_at: end,
      doctor_id: optionalId(row.doctor_id), installation_id: optionalId(row.instalacion_id),
      treatment_id: optionalId(row.tratamiento_id), lifecycle: lifecycle(row), booking: bookingProjection(row) };
  });
  if (new Set(projection.map(row => row.appointment_id)).size !== rows.length) fail('invalid_membership');
  const membership = { visit_id: visitId, clinic_id: clinicId, patient_id: patientId, owner_appointment_id: ownerAppointmentId,
    grouping_kind: groupingKind, members: projection.map(({ appointment_id, role }) => ({ appointment_id, role })), evidence: group };
  const snapshot = { schema: 'appointment-visit-communication/1', ...membership,
    patient_start_at: projection.map(row => row.start_at).sort()[0],
    patient_end_at: projection.map(row => row.end_at).sort().at(-1), reservations: projection };
  return { snapshot, membership_sha256: hash(membership), snapshot_sha256: hash(snapshot) };
}

// Canonical purposes unify booking/rescheduling details across old member IDs.
// A caller cannot invent a QA/migration purpose or use template versions as purpose.
const PURPOSES = Object.freeze({
  appointment_details: { suppression: 'appointment_details', lifecycle: 'active', future: true },
  reminder_day_before: { suppression: 'day_before', lifecycle: 'active', future: true },
  reminder_same_day: { suppression: 'same_day', lifecycle: 'active', future: true },
  confirmation_acknowledgement: { suppression: 'appointment_details', lifecycle: 'active', future: true },
  confirmation_timeout: { suppression: 'day_before', lifecycle: 'active', future: true },
  cancellation: { suppression: 'appointment_details', lifecycle: 'cancelada', future: false },
  no_show: { suppression: 'appointment_details', lifecycle: 'no_asistio', future: false },
  completed: { suppression: 'appointment_details', lifecycle: 'completada', future: false },
  aftercare: { suppression: 'appointment_details', lifecycle: 'completada', future: false },
  clinical_consent: { suppression: 'appointment_details', lifecycle: 'active', future: true },
});
function purposePolicy(purpose) {
  if (!Object.hasOwn(PURPOSES, purpose)) fail('invalid_purpose', 400);
  return PURPOSES[purpose];
}
function normalizeWindow(window) {
  if (!window || typeof window.key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,119}$/.test(window.key)
    || Object.keys(window).some(key => !['key', 'starts_at', 'ends_at'].includes(key))) fail('invalid_window', 400);
  const starts_at = instant(window.starts_at), ends_at = instant(window.ends_at);
  if (Date.parse(ends_at) <= Date.parse(starts_at)) fail('invalid_window', 400);
  // Key identifies the operational window. Changed bounds cannot create a new
  // delivery right for the same key; claim rejects conflicting bounds instead.
  return { key: window.key, starts_at, ends_at, sha256: hash({ key: window.key }) };
}
function assertNotificationEligibility({ appointments, purpose, now, releaseForAppointment = null }) {
  const policy = purposePolicy(purpose), time = Date.parse(instant(now));
  for (const value of appointments) {
    const row = plain(value), m = object(row.import_metadata);
    // A resolver is created by the service from current protected server-side
    // policy + locked records, never from public API JSON or an override flag.
    const release = typeof releaseForAppointment === 'function' ? releaseForAppointment(value) : null;
    if (qa(row) || qa(m)) fail('qa_forbidden');
    if (truth(row.es_provisional) || row.hold_expires_at || truth(m.historical_registration) || truth(m.imported_as_past_activity)
      || ['lead_resolution_historical', 'historical_treatment'].includes(m.kind)) fail('held');
    if ((held(m) || row.source_system || row.source_reference) && !release?.allowed) fail('held');
    if (purpose === 'reminder_same_day' && release?.sameDayOff) fail('notification_suppressed');
    const suppression = object(m.notification_suppression || m.notificationSuppression);
    const aliases = { appointment_details: ['appointment_details', 'appointmentDetails', 'appointment_created'],
      day_before: ['day_before', 'dayBefore'], same_day: ['same_day', 'sameDay'] };
    if (!release?.suppressionOverride && (aliases[policy.suppression] || []).some(key => truth(suppression[key]))) fail('notification_suppressed');
    if (lifecycle(row) !== policy.lifecycle) fail('purpose_ineligible');
    if (policy.future && Date.parse(instant(row.inicio)) <= time) fail('historical_window');
    if (purpose === 'confirmation_timeout' && row.estado === 'recordatorio_confirmado') fail('already_confirmed');
  }
}
function assertCurrentProjection({ visit, projection, expectedRevision }) {
  const v = plain(visit);
  if (!positiveId(expectedRevision) || Number(v.communication_revision) !== expectedRevision) fail('revision_changed');
  if (v.status !== 'active' || v.merged_into_visit_id) fail('visit_not_active');
  if (v.membership_sha256 !== projection.membership_sha256) fail('membership_changed');
  if (v.snapshot_sha256 !== projection.snapshot_sha256 || hash(v.snapshot) !== v.snapshot_sha256) fail('snapshot_changed');
}
function assertWindow(window, now, dispatch = false) {
  const time = Date.parse(instant(now));
  if (time >= Date.parse(window.ends_at)) fail('window_expired');
  if (dispatch && time < Date.parse(window.starts_at)) fail('window_not_open');
}
function messageOutcome(message) {
  if (!message) return 'none';
  const m = plain(message), metadata = object(m.metadata);
  if (m.direction !== 'outbound') fail('message_scope_changed');
  if (metadata.wamid || metadata.provider_acceptance_at || m.sent_at || ['sent', 'delivered', 'read'].includes(m.status)) return 'accepted';
  if (metadata.delivery_unknown || metadata.outcome_unknown || metadata.wa_response || m.status === 'sending') return 'unknown';
  if (m.status === 'failed') return 'failed';
  return 'pending';
}
const deliveryKey = communication => {
  const id = plain(communication)?.id;
  if (!uuid(id)) fail('invalid_communication');
  return 'visit-communication:' + id;
};

module.exports = { plain, clone, fail, positiveId, uuid, canonical, hash, instant, object, held, qa, lifecycle, bookingProjection,
  buildVisitSnapshot, groupingEvidence, PURPOSES, purposePolicy, normalizeWindow, assertNotificationEligibility,
  assertCurrentProjection, assertWindow, messageOutcome, deliveryKey };

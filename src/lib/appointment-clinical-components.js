'use strict';

// A relation between existing reservations, not an administered act, product,
// follow-up, episode or purchased program. Metadata alone is never sufficient:
// both appointment records and the append-only audit must agree.
const { hash, utcToLocal } = require('./cliniccloud-import/adapter');
const { normalizeBookingProfile } = require('./booking-profile');
const PARENT_KEY = 'clinical_component_parent';
const CHILDREN_KEY = 'clinical_component_children';
const ROLE = 'prp_extraction';
const EVENT_TYPE = 'appointment.clinical_component_linked';
const SCHEMA_VERSION = 1;
const METADATA_KEYS = Object.freeze([PARENT_KEY, CHILDREN_KEY]);
// Only a context produced from reciprocal records + audit in this process may
// suppress import review. A client JSON object or a cloned DTO is not proof.
const validatedContexts = new WeakMap();
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const digest = value => /^[a-f0-9]{64}$/.test(value || '');
const plain = value => value?.toJSON ? value.toJSON() : value;
const jsonPlain = value => JSON.parse(JSON.stringify(value));
function object(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
const metadata = row => object(plain(row)?.import_metadata) || {};
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const instant = value => { const date = new Date(value); return value != null && Number.isFinite(date.getTime()) ? date.toISOString() : null; };
function componentError(suffix, message, status = 409) {
  return Object.assign(new Error(message), { code: 'appointment_clinical_component_' + suffix, status, statusCode: status });
}
const fail = (suffix, message, status) => { throw componentError(suffix, message, status); };
function reviewVersion(row) {
  const value = plain(row);
  return require('./appointment-import-review').importReviewVersion({ ...value, es_provisional: value.es_provisional == null ? null : Boolean(value.es_provisional) });
}
function sourceAcknowledgement(row) {
  row = plain(row);
  const m = metadata(row), receipt = object(m.cliniccloud_source_booking);
  const sourceId = String(m.source_appointment_id || '');
  const contactId = String(m.source_contact_id || '');
  if (row.source_system !== 'cliniccloud' || m.source_account !== 'cliniccloud-5880'
    || !String(row.source_reference || '').trim() || !/^[1-9][0-9]{0,19}$/.test(sourceId)
    || !/^[1-9][0-9]{0,19}$/.test(contactId) || !receipt || receipt.version !== 'cliniccloud-source-booking/1'
    || receipt.source_account !== m.source_account || String(receipt.source_appointment_id) !== sourceId
    || String(receipt.source_contact_id) !== contactId || !digest(receipt.receipt_sha256)
    || hash(omit(receipt, ['receipt_sha256'])) !== receipt.receipt_sha256
    || receipt.preserved_start_at !== instant(row.inicio) || receipt.preserved_end_at !== instant(row.fin)
    || receipt.automation_policy !== 'hold' || m.cliniccloud_reconciliation?.automation_policy !== 'hold') {
    fail('source_unproven', 'Falta una reserva fuente acreditada con su recibo íntegro.');
  }
  return { source_reference: row.source_reference, source_appointment_id: sourceId,
    source_booking_receipt_sha256: receipt.receipt_sha256 };
}
function normalizeAcknowledgement(value) {
  const keys = ['source_reference', 'source_appointment_id', 'source_booking_receipt_sha256'];
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))
    || typeof value.source_reference !== 'string' || value.source_reference.length < 1 || value.source_reference.length > 120
    || typeof value.source_appointment_id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.source_appointment_id)
    || !digest(value.source_booking_receipt_sha256)) {
    fail('invalid', 'Confirma las dos referencias fuente exactas.', 400);
  }
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
function normalizeLink(input) {
  const keys = ['parent_appointment_id', 'expected_version', 'expected_parent_version', 'reason', 'confirm_source_roles', 'source_acknowledgements'];
  if (!object(input) || Object.keys(input).some(key => !keys.includes(key))
    || !Number.isSafeInteger(input.parent_appointment_id) || input.parent_appointment_id < 1
    || !digest(input.expected_version) || !digest(input.expected_parent_version)
    || input.confirm_source_roles !== true || typeof input.reason !== 'string'
    || input.reason.trim().length < 20 || input.reason.trim().length > 500
    || !object(input.source_acknowledgements)
    || Object.keys(input.source_acknowledgements).sort().join(',') !== 'component,parent') {
    fail('invalid', 'Confirma la extracción fuente y la infiltración reservadas, sus versiones y el motivo de revisión.', 400);
  }
  return { parent_appointment_id: input.parent_appointment_id, expected_version: input.expected_version,
    expected_parent_version: input.expected_parent_version, reason: input.reason.trim(), confirm_source_roles: true,
    source_acknowledgements: { component: normalizeAcknowledgement(input.source_acknowledgements.component),
      parent: normalizeAcknowledgement(input.source_acknowledgements.parent) } };
}
function reservationFingerprint(row) {
  row = plain(row);
  const fields = ['id_cita', 'paciente_id', 'clinica_id', 'doctor_id', 'instalacion_id', 'tratamiento_id',
    'voucher_id', 'lead_intake_id', 'tipo_cita', 'titulo', 'nota', 'motivo', 'source_system', 'source_reference',
    'es_provisional', 'hold_expires_at'];
  const result = Object.fromEntries(fields.map(key => [key, row[key] ?? null]));
  result.es_provisional = result.es_provisional == null ? null : Boolean(result.es_provisional);
  for (const key of ['inicio', 'fin']) { result[key] = instant(row[key]); if (!result[key]) return null; }
  if (result.hold_expires_at) result.hold_expires_at = instant(result.hold_expires_at);
  result.import_metadata = omit(metadata(row), METADATA_KEYS);
  return hash(jsonPlain(result));
}
function simpleReservedRole(row, doctorId, roomId) {
  try {
    row = plain(row);
    const m = metadata(row), profile = normalizeBookingProfile(m.booking?.profile), phases = m.booking?.phases;
    if (!profile || profile.phases.length !== 1 || !Array.isArray(phases) || phases.length !== 1) return false;
    const required = profile.phases[0], actual = phases[0];
    return Number(row.doctor_id) === doctorId && Number(row.instalacion_id) === roomId
      && actual.key === required.key && Number(actual.installation_id) === roomId
      && actual.doctor_ids?.length === 1 && Number(actual.doctor_ids[0]) === doctorId
      && !actual.equipment?.length && !required.equipment_requirements?.length
      && !required.staff_attention && !actual.staff_attention && !actual.staff_intervals
      && (actual.staff_time_scope || 'phase') === 'phase'
      && required.installation_ids.includes(roomId) && required.professionals.ids.includes(doctorId)
      && instant(actual.start_at) === instant(row.inicio) && instant(actual.end_at) === instant(row.fin)
      && (Date.parse(actual.end_at) - Date.parse(actual.start_at)) / 60000 === required.duration_minutes;
  } catch { return false; }
}
function primaryTreatmentEvidence(treatment) {
  const row = plain(treatment), config = object(row?.clinical_config) || {};
  if (!row || Number(row.id_tratamiento) !== 688 || Number(row.clinica_id) !== 66 || ![1, true].includes(row.activo)
    || ['draft', 'obsolete'].includes(config.catalog_status) || config.demo
    || config.source_reference !== 'service:2798745') fail('parent_role_unproven', 'La reserva principal necesita una equivalencia PRP activa y específica.');
  return { treatment_id: 688, clinic_id: 66, source_reference: config.source_reference,
    name: row.nombre || row.nombre_tratamiento, active: true };
}
function assertPairRoles(component, parent, treatment, { forLink = true } = {}) {
  component = plain(component); parent = plain(parent);
  const cm = metadata(component), pm = metadata(parent);
  if (!positive(component.id_cita) || !positive(parent.id_cita) || component.id_cita === parent.id_cita
    || Number(component.clinica_id) !== 66 || Number(parent.clinica_id) !== 66
    || !positive(component.paciente_id) || Number(component.paciente_id) !== Number(parent.paciente_id)
    || component.tratamiento_id != null || Number(parent.tratamiento_id) !== 688
    || cm.import_treatment_resolution || pm[PARENT_KEY]
    || [component, parent].some(row => row.voucher_id || row.lead_intake_id || row.es_provisional || row.hold_expires_at
      || ['cancelada', 'no_asistio', 'reprogramada'].includes(row.estado)
      || forLink && (row.arrived_at || row.care_started_at || row.care_schedule_start || require('./status-catalog').hasAttendedAppointment(row)))
    || cm.program_session || pm.program_session || cm.additional_staff || pm.additional_staff
    || !simpleReservedRole(component, 53, 79) || !simpleReservedRole(parent, 50, 75)) {
    fail('roles_unproven', 'Esta relación solo identifica una extracción y una infiltración PRP simples, abiertas y ya reservadas. No crea ni corrige sus fases.');
  }
  const cs = sourceAcknowledgement(component), ps = sourceAcknowledgement(parent);
  if (cs.source_appointment_id === ps.source_appointment_id || cs.source_reference === ps.source_reference
    || String(cm.source_contact_id) !== String(pm.source_contact_id)
    || utcToLocal(component.inicio)?.slice(0, 10) !== utcToLocal(parent.inicio)?.slice(0, 10)
    || Date.parse(parent.inicio) < Date.parse(component.inicio)
    || Date.parse(parent.inicio) - Date.parse(component.fin) > 45 * 60000) {
    fail('source_pair_mismatch', 'Las dos reservas deben pertenecer al mismo paciente y jornada fuente, con extracción anterior a la infiltración.');
  }
  return { component: cs, parent: ps, treatment: primaryTreatmentEvidence(treatment) };
}
function baseReceipt(receipt) { return omit(receipt, ['receipt_sha256', 'audit_event_id']); }
function validReceipt(receipt) {
  return !!(object(receipt) && receipt.version === SCHEMA_VERSION && receipt.role === ROLE && receipt.planned_only === true
    && receipt.administration_inferred === false && receipt.individual_price_assigned === false
    && receipt.purchase_or_program_inferred === false && positive(receipt.component_appointment_id)
    && positive(receipt.parent_appointment_id) && receipt.component_appointment_id !== receipt.parent_appointment_id
    && positive(receipt.patient_id) && Number(receipt.clinic_id) === 66 && positive(receipt.actor_id)
    && /^[1-9][0-9]{0,19}$/.test(receipt.audit_event_id || '') && digest(receipt.request_hash)
    && digest(receipt.component_fingerprint) && digest(receipt.parent_fingerprint)
    && typeof receipt.reason === 'string' && receipt.reason.trim().length >= 20 && receipt.reason.length <= 500
    && !!instant(receipt.reviewed_at) && digest(receipt.receipt_sha256)
    && hash(omit(receipt, ['receipt_sha256'])) === receipt.receipt_sha256);
}
function componentContext({ component, parent, treatment, auditEvent }) {
  component = plain(component); parent = plain(parent); auditEvent = plain(auditEvent);
  const receipt = metadata(component)[PARENT_KEY];
  if (!receipt) return null;
  const needsReview = code => ({ status: 'needs_review', role: ROLE, reason_code: code,
    planned_only: true, administration_inferred: false, ready_for_care: false });
  try {
    if (!validReceipt(receipt) || !parent || !auditEvent) return needsReview('reciprocal_relation_unproven');
    const children = metadata(parent)[CHILDREN_KEY];
    if (!Array.isArray(children) || children.length !== 1 || hash(children[0]) !== hash(receipt)
      || Number(component.id_cita) !== Number(receipt.component_appointment_id)
      || Number(parent.id_cita) !== Number(receipt.parent_appointment_id)
      || Number(component.paciente_id) !== Number(receipt.patient_id) || Number(component.clinica_id) !== Number(receipt.clinic_id)) {
      return needsReview('reciprocal_relation_unproven');
    }
    const roles = assertPairRoles(component, parent, treatment, { forLink: false });
    if (reservationFingerprint(component) !== receipt.component_fingerprint
      || reservationFingerprint(parent) !== receipt.parent_fingerprint
      || hash(roles.component) !== hash(receipt.source_acknowledgements.component)
      || hash(roles.parent) !== hash(receipt.source_acknowledgements.parent)
      || hash(roles.treatment) !== hash(receipt.primary_treatment_evidence)) return needsReview('reservation_or_source_changed');
    const eventMetadata = object(auditEvent.metadata);
    if (String(auditEvent.id) !== receipt.audit_event_id || auditEvent.event_type !== EVENT_TYPE
      || Number(auditEvent.patient_id) !== Number(receipt.patient_id) || Number(auditEvent.clinic_id) !== Number(receipt.clinic_id)
      || Number(auditEvent.actor_user_id) !== Number(receipt.actor_id) || !eventMetadata
      || auditEvent.source !== 'agenda' || eventMetadata.role !== ROLE
      || Number(eventMetadata.component_appointment_id) !== Number(receipt.component_appointment_id)
      || Number(eventMetadata.parent_appointment_id) !== Number(receipt.parent_appointment_id)
      || eventMetadata.request_hash !== receipt.request_hash || eventMetadata.base_receipt_sha256 !== hash(baseReceipt(receipt))) {
      return needsReview('audit_relation_unproven');
    }
    const context = { status: 'linked', role: ROLE, parent_appointment_id: Number(parent.id_cita),
      component_appointment_id: Number(component.id_cita), consent_scope_appointment_id: Number(parent.id_cita),
      planned_only: true, administration_inferred: false, individual_price_assigned: false,
      purchase_or_program_inferred: false, ready_for_care: false, requires_primary_clinical_consent: true,
      receipt_sha256: receipt.receipt_sha256 };
    validatedContexts.set(context, { component_id: Number(component.id_cita), patient_id: Number(component.paciente_id),
      clinic_id: Number(component.clinica_id), component_fingerprint: reservationFingerprint(component) });
    return Object.freeze(context);
  } catch { return needsReview('reciprocal_relation_unproven'); }
}
function isValidatedClinicalComponentContext(context, appointment = null) {
  const binding = context && validatedContexts.get(context);
  if (!binding || context.status !== 'linked') return false;
  if (!appointment) return true;
  const row = plain(appointment);
  const receipt = metadata(row)[PARENT_KEY];
  return Number(row?.id_cita) === binding.component_id && Number(row.paciente_id) === binding.patient_id
    && Number(row.clinica_id) === binding.clinic_id && reservationFingerprint(row) === binding.component_fingerprint
    && validReceipt(receipt) && receipt.receipt_sha256 === context.receipt_sha256
    && !['cancelada', 'no_asistio', 'reprogramada'].includes(row.estado);
}

module.exports = { PARENT_KEY, CHILDREN_KEY, METADATA_KEYS, ROLE, EVENT_TYPE, SCHEMA_VERSION, metadata, object,
  plain, jsonPlain, omit, instant, positive, digest, componentError, normalizeLink, reviewVersion,
  sourceAcknowledgement, reservationFingerprint, simpleReservedRole, primaryTreatmentEvidence,
  assertPairRoles, baseReceipt, validReceipt, componentContext, isValidatedClinicalComponentContext };

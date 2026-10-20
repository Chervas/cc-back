'use strict';

const { domainError } = require('./treatmentPrograms.contract');
const { snapshot, operationalSnapshot } = require('./economicProgramSnapshot');
const { normalizeProfile } = require('./economicPriceProfile');
const { hash } = require('./cliniccloud-import/adapter');
const PREFIX = 'program-enrollment:';
const object = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
};
const invalid = (code, message, status = 409) => { throw domainError(status, code, message); };
function enrollmentRequest(payload, { clinicId, patientId, actorId }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !['clinic_id', 'program_id', 'program_version', 'request_key', 'start_from_position'].includes(key))
    || Number(payload.clinic_id) !== Number(clinicId)
    || !/^[a-f0-9-]{36}$/.test(payload.program_id || '')
    || !Number.isSafeInteger(payload.program_version) || payload.program_version < 1
    || typeof payload.request_key !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(payload.request_key)
    || payload.start_from_position != null && (!Number.isSafeInteger(payload.start_from_position) || payload.start_from_position < 1 || payload.start_from_position > 120)
    || [clinicId, patientId, actorId].some(id => !Number.isSafeInteger(Number(id)) || Number(id) < 1)) {
    invalid('program_enrollment_request_invalid', 'Selecciona el programa vigente y vuelve a solicitar su asignación.', 400);
  }
  const intent = { clinic_id: Number(clinicId), patient_id: Number(patientId), actor_id: Number(actorId),
    program_id: payload.program_id, program_version: payload.program_version,
    ...(payload.start_from_position > 1 ? { start_from_position: payload.start_from_position } : {}) };
  return { ...intent, request_key: payload.request_key, request_sha256: hash(intent), source_reference: PREFIX + payload.request_key };
}
function freezeProgramEnrollment(program, request, now = new Date()) {
  if ((request.start_from_position || 1) > program.appointments.length) invalid('program_enrollment_start_invalid', 'La sesión de inicio no pertenece al programa.', 400);
  if (program.status !== 'active' || !program.commercial_ready || program.summary?.issues?.length
    || !normalizeProfile(program.price_profile || require('./economicPriceProfile').commonProfile(program.appointments.flatMap(row => row.treatments.map(treatment => treatment.price_profile))))) {
    invalid('program_enrollment_not_ready', 'Completa la composición, los recursos y la configuración del programa antes de asignarlo.', 422);
  }
  const { sha256, ...definition } = snapshot(program);
  const unsigned = { ...definition, enrollment: { schema_version: 1, source: 'program_enrollment',
    clinic_id: request.clinic_id, patient_id: request.patient_id, actor_id: request.actor_id,
    assigned_at: now.toISOString(), request_key: request.request_key, request_sha256: request.request_sha256,
    ...(request.start_from_position > 1 ? { start_from_position: request.start_from_position, prior_sessions: 'unrecorded' } : {}) } };
  const sealed = { ...unsigned, sha256: hash(unsigned) };
  operationalSnapshot(sealed);
  return sealed;
}
function readProgramEnrollment(voucher, { required = false } = {}) {
  const raw = object(voucher.program_snapshot);
  if (!raw) {
    if (required || voucher.program_snapshot != null) invalid('program_enrollment_snapshot_invalid', 'No se encuentra una asignación clínica válida de este programa.');
    return null;
  }
  const metadata = object(raw.enrollment);
  if (voucher.budget_id != null || voucher.budget_line_key != null || voucher.source_system !== 'treatment_program'
    || !metadata || metadata.schema_version !== 1 || metadata.source !== 'program_enrollment'
    || Number(metadata.clinic_id) !== Number(voucher.clinic_id) || Number(metadata.patient_id) !== Number(voucher.patient_id)
    || !Number.isSafeInteger(metadata.actor_id) || metadata.actor_id < 1 || Number(voucher.created_by) !== metadata.actor_id
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(metadata.assigned_at || '') || !Number.isFinite(Date.parse(metadata.assigned_at))
    || voucher.source_reference !== PREFIX + metadata.request_key || voucher.activation_rule !== 'manual' || Number(voucher.sold_amount) !== 0) {
    invalid('program_enrollment_snapshot_invalid', 'La asignación clínica no corresponde a este paciente o clínica.');
  }
  const request = enrollmentRequest({ clinic_id: metadata.clinic_id, program_id: raw.program_id,
    program_version: raw.program_version, request_key: metadata.request_key,
    ...(metadata.start_from_position != null ? { start_from_position: metadata.start_from_position } : {}) }, {
    clinicId: voucher.clinic_id, patientId: voucher.patient_id, actorId: metadata.actor_id });
  if (request.request_sha256 !== metadata.request_sha256) invalid('program_enrollment_snapshot_invalid', 'La asignación clínica ha cambiado. Revisa su origen.');
  const resolved = operationalSnapshot(raw);
  if (Number(voucher.total_units) !== resolved.appointments.length || !normalizeProfile(resolved.price_profile)
    || metadata.start_from_position != null && (metadata.start_from_position <= 1 || metadata.start_from_position > resolved.appointments.length || metadata.prior_sessions !== 'unrecorded')
    || metadata.start_from_position == null && metadata.prior_sessions != null
    || metadata.start_from_position != null && (!Number.isFinite(Number(voucher.available_units)) || Number(voucher.available_units) < 0
      || Number(voucher.available_units) > resolved.appointments.length - metadata.start_from_position + 1)) {
    invalid('program_enrollment_snapshot_invalid', 'La composición del programa no coincide con sus sesiones.');
  }
  return resolved;
}
function enrollmentProgress(voucher, sealed = object(voucher.program_snapshot)) {
  const total = Number(voucher.total_units), start = sealed?.enrollment?.start_from_position || 1;
  const unrecorded = start - 1, managed = total - unrecorded;
  return { start_from_position: start, unrecorded_units: unrecorded, managed_units: managed,
    consumed_units: Math.max(0, managed - Number(voucher.available_units)) };
}
function enrollmentDto(voucher, sealed, replayed = false) {
  return { voucher_id: voucher.public_id, program_id: sealed.program_id, program_version: sealed.program_version,
    name: sealed.name, source_system: 'treatment_program', origin: 'program_enrollment', replayed,
    commercial_status: 'not_contracted', sold_amount: null, catalog_reference_amount: sealed.catalog_total_price,
    ...(sealed.enrollment?.start_from_position > 1 ? enrollmentProgress(voucher, sealed) : {}),
    can_schedule: voucher.status === 'active' && Number(voucher.available_units) > 0 };
}
module.exports = { PREFIX, enrollmentRequest, freezeProgramEnrollment, readProgramEnrollment, enrollmentProgress, enrollmentDto };

'use strict';

const { createHash } = require('node:crypto');
const object = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

function importReviewVersion(appointment) {
  // Only full appointment records can issue a write precondition. A calendar
  // projection without its timestamp/identity is not sufficient.
  if (!appointment.id_cita || !appointment.paciente_id || !appointment.clinica_id || !appointment.updated_at) return null;
  const fields = ['id_cita', 'paciente_id', 'clinica_id', 'doctor_id', 'instalacion_id', 'tratamiento_id',
    'voucher_id', 'lead_intake_id', 'tipo_cita', 'estado', 'titulo', 'nota', 'motivo', 'source_system',
    'source_reference', 'es_provisional', 'hold_expires_at'];
  const value = Object.fromEntries(fields.map(key => [key, appointment[key] ?? null]));
  for (const field of ['inicio', 'fin', 'updated_at']) {
    const date = new Date(appointment[field]);
    if (!Number.isFinite(date.getTime())) return null;
    value[field] = date.toISOString();
  }
  value.import_metadata = object(appointment.import_metadata);
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function hasReviewedNoTreatment(appointment) {
  const resolution = object(appointment.import_metadata).import_treatment_resolution;
  return appointment.source_system === 'cliniccloud' && !appointment.tratamiento_id
    && resolution?.version === 1 && resolution.mode === 'no_treatment'
    && ['revision', 'primera_sin_trat'].includes(appointment.tipo_cita)
    && resolution.visit_type === appointment.tipo_cita
    && Number(resolution.appointment_id) === Number(appointment.id_cita)
    && Number(resolution.patient_id) === Number(appointment.paciente_id)
    && Number(resolution.clinic_id) === Number(appointment.clinica_id)
    && Number.isSafeInteger(resolution.actor_id) && resolution.actor_id > 0
    && /^[a-f0-9]{64}$/.test(resolution.request_hash || '');
}

function hasReviewedClinicalComponent(appointment, context) {
  return !!context && require('./appointment-clinical-components').isValidatedClinicalComponentContext(context, appointment);
}

function importTreatmentPending(appointment, { clinicalComponentContext = null } = {}) {
  const pending = object(appointment.import_metadata).cliniccloud_delta?.pending_assignment;
  const refresh = reviewedSourceRefresh(appointment);
  return appointment.source_system === 'cliniccloud' && !appointment.tratamiento_id
    && (Array.isArray(pending) && pending.includes('treatment_id') || refresh?.treatment_pending === true)
    && !hasReviewedNoTreatment(appointment) && !hasReviewedClinicalComponent(appointment, clinicalComponentContext);
}

// A source refresh supplements the immutable original import evidence. Only
// its validated latest receipt may identify an unresolved replacement act.
// Lazy loading avoids the importer/review module initialization cycle.
function reviewedSourceRefresh(appointment) {
  const metadata = object(appointment.import_metadata);
  if (!metadata.cliniccloud_source_refreshes) return null;
  try {
    const { storedSourceRefresh, sourceRefreshChanged } = require('./cliniccloud-import/source-refresh');
    const refresh = storedSourceRefresh(appointment, metadata);
    return refresh && !sourceRefreshChanged(appointment, refresh) ? { ...refresh,
      treatment_pending:metadata.cliniccloud_source_refreshes.receipts.some(r=>r.operator_review?.clear_treatment===true) } : null;
  } catch { return null; }
}

function importResourcesInScope(appointment) {
  const metadata = object(appointment.import_metadata);
  return appointment.source_system === 'cliniccloud'
    && (Array.isArray(metadata.cliniccloud_delta?.pending_assignment)
      || reviewedSourceRefresh(appointment)?.treatment_pending === true)
    && !appointment.voucher_id && !metadata.program_session && !appointment.es_provisional && !appointment.hold_expires_at;
}

// Approval belongs to this reservation, not merely the latest editor. Notes do
// not invalidate it; moving, changing treatment, participants or phases does.
function importResourceFingerprint(appointment) {
  const metadata = object(appointment.import_metadata);
  const values = Object.fromEntries(['id_cita', 'paciente_id', 'clinica_id', 'doctor_id', 'instalacion_id', 'tratamiento_id']
    .map(key => [key, appointment[key] == null ? null : Number(appointment[key])]));
  for (const field of ['inicio', 'fin']) {
    const date = new Date(appointment[field]);
    if (!Number.isFinite(date.getTime())) return null;
    values[field] = date.toISOString();
  }
  values.booking = metadata.booking || null;
  values.additional_staff = metadata.additional_staff || null;
  return createHash('sha256').update(JSON.stringify(canonical(values))).digest('hex');
}

function hasReviewedImportResources(appointment) {
  const resolution = object(appointment.import_metadata).import_resource_resolution;
  return importResourcesInScope(appointment) && !!appointment.doctor_id && !!appointment.instalacion_id
    && resolution?.version === 1 && Number.isSafeInteger(resolution.actor_id) && resolution.actor_id > 0
    && /^[a-f0-9]{64}$/.test(resolution.request_hash || '')
    && !!resolution.reservation_fingerprint && resolution.reservation_fingerprint === importResourceFingerprint(appointment);
}

// Small server-owned operational summary. Never expose import evidence, patient
// identity snapshots or raw source notes through the calendar's lightweight DTO.
function appointmentImportReview(appointment, { clinicalComponentContext = null } = {}) {
  if (appointment.source_system !== 'cliniccloud') return null;
  let metadata = appointment.import_metadata;
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { metadata = {}; } }
  const pending = metadata?.cliniccloud_delta?.pending_assignment;
  const fields = { doctor_id: 'professional', installation_id: 'installation', treatment_id: 'treatment' };
  const columns = { doctor_id: 'doctor_id', installation_id: 'instalacion_id', treatment_id: 'tratamiento_id' };
  // A documentary room can already be assigned while still inactive. Keep the
  // appointment in the operational review list until the room is enabled; the
  // presence of an ID alone must not make it disappear from the only visible
  // list when inactive rooms have no calendar column. Use the joined room, not
  // import metadata that would remain stale after activation.
  const installationInactive = !!appointment.instalacion_id
    && [false, 0].includes(appointment.instalacion?.activo);
  const pendingAssignment = Object.keys(fields).filter(key => Array.isArray(pending) && pending.includes(key)
    && !appointment[columns[key]] && !(key === 'treatment_id' && (hasReviewedNoTreatment(appointment)
      || hasReviewedClinicalComponent(appointment, clinicalComponentContext)))).map(key => fields[key]);
  if (importTreatmentPending(appointment, { clinicalComponentContext }) && !pendingAssignment.includes('treatment')) pendingAssignment.push('treatment');
  if (installationInactive && !pendingAssignment.includes('installation')) pendingAssignment.push('installation');
  const resourcesNeedReview = importResourcesInScope(appointment)
    && !['cancelada', 'completada', 'no_asistio'].includes(appointment.estado) && !hasReviewedImportResources(appointment);
  if (resourcesNeedReview) {
    for (const field of ['professional', 'installation']) if (!pendingAssignment.includes(field)) pendingAssignment.push(field);
  }
  // A display label only, never a catalog link or a reason to infer a price,
  // protocol or consent. Do not copy notes, patient identity or the raw import
  // payload. The controller removes the whole summary without clinical access.
  const currentService = reviewedSourceRefresh(appointment)?.current.service_key ?? metadata?.cliniccloud_delta?.source?.service_key;
  const sourceService = typeof currentService === 'string' ? currentService.trim().slice(0, 255) : '';
  return { source: 'cliniccloud', reminders_held: true,
    pending_assignment: pendingAssignment,
    ...(importTreatmentPending(appointment, { clinicalComponentContext }) && importReviewVersion(appointment)
      ? { review_version: importReviewVersion(appointment) } : {}),
    ...(hasReviewedNoTreatment(appointment) ? { treatment_resolution: 'no_treatment' } : {}),
    ...(hasReviewedClinicalComponent(appointment, clinicalComponentContext)
      ? { treatment_resolution: 'planned_clinical_component', clinical_component_role: 'prp_extraction' } : {}),
    ...(appointment.tratamiento && require('./historical-treatment-reference').isHistoricalTreatment(appointment.tratamiento)
      ? { treatment_resolution: 'historical_reference', clinical_document_review_required: true,
        commercial_use_allowed: false, clinical_approval_inferred: false } : {}),
    ...(resourcesNeedReview ? { resources_need_review: true } : {}),
    ...(resourcesNeedReview && appointment.doctor_id && appointment.instalacion_id && !installationInactive
      && !['cancelada', 'completada', 'no_asistio'].includes(appointment.estado) && importReviewVersion(appointment)
      ? { resource_review_version: importReviewVersion(appointment) } : {}),
    ...(sourceService ? { source_service: sourceService } : {}),
    ...(installationInactive ? { installation_inactive: true } : {}) };
}
module.exports = { appointmentImportReview, importReviewVersion, hasReviewedNoTreatment, importTreatmentPending,
  importResourcesInScope, importResourceFingerprint, hasReviewedImportResources, hasReviewedClinicalComponent };

'use strict';
// Operator-only, documentary resource correction of an unchanged legacy slot.
// No guessed reschedule, cancellation, clinical equivalence or patient match.
const { hash, norm, localToUtc } = require('./adapter');
const { normalizedRow } = require('./appointments-apply');
const VERSION = 'cliniccloud-stationary-resource-correction/1';
function prepareCorrection({ before: raw, source, catalog, doctorId, roomId, equipmentId, planSha256, reason }) {
  const before = normalizedRow(raw), m = before.import_metadata;
  const fail = () => { throw Error('STATIONARY_RESOURCE_REVIEW_REQUIRED'); };
  if (before.clinica_id !== 72 || before.doctor_id !== 142 || before.estado !== 'pendiente'
    || before.source_system !== 'cliniccloud' || before.source_reference !== `appointment:${m?.source_appointment_id}`
    || !m?.raw || String(m.raw.idCita) !== String(m.source_appointment_id)
    || String(m.raw.idContacto) !== String(m.source_contact_id)
    || before.updated_by || before.voucher_id || before.lead_intake_id || before.es_provisional || before.hold_expires_at
    || ['booking','program_session','additional_staff','import_resource_resolution','import_treatment_resolution','stationary_resource_correction'].some(k => m[k])
    || source?.kind !== 'appointment' || source.status !== 'pendiente' || source.validation_errors?.length
    || source.source_contact_id !== String(m.source_contact_id)
    || localToUtc(source.start_local) !== before.inicio || localToUtc(source.end_local) !== before.fin
    || norm(source.details || '') !== norm(m.raw.detalles || '')
    || !/^[a-f0-9]{64}$/.test(planSha256 || '') || !/^[a-f0-9]{64}$/.test(source.provenance?.row_sha256 || '')
    || !/^[a-f0-9]{64}$/.test(source.provenance?.file_sha256 || '')
    || !String(reason || '').trim() || ![doctorId,roomId,equipmentId].every(Number.isSafeInteger)) fail();
  // Deliberately tiny allowlist. An ONDAS/EMS/EXION note under CYCLONE cannot
  // enter this path; neither can a changed or ambiguous source slot.
  const cyclone = before.tratamiento_id === 611 && source.service_key === 'CYCLONE CORPORAL 1 SESION' && norm(source.details) === 'CYCLONE';
  const presso = before.tratamiento_id === 623 && source.service_key === 'PRESOTERAPIA CORPORAL 1 SESION' && norm(source.details) === 'PRESO';
  if (!(cyclone || presso) || doctorId !== 221 || roomId !== (cyclone ? 85 : 82)
    || equipmentId !== (cyclone ? 10 : 11)) fail();
  const cfg = catalog?.clinical_config, phase = cfg?.booking_profile?.phases?.[0];
  if (catalog.clinica_id !== before.clinica_id || cfg?.source_professional !== 'Aux. Piedad'
    || cfg.source_catalog?.sheet !== 'Tratamientos individuales'
    || cfg.source_catalog?.source_row !== (cyclone ? 24 : 8)
    || cfg.booking_profile.phases.length !== 1 || !phase.installation_ids.includes(roomId)
    || !phase.professionals.ids.includes(doctorId)) fail();
  const body = {version:VERSION,before_sha256:hash(before),appointment_id:before.id_cita,
    source,plan_sha256:planSha256,catalog_sha256:hash(catalog),doctor_id:doctorId,
    installation_id:roomId,equipment_id:equipmentId,reason,automation_policy:'hold'};
  return {...body,receipt_sha256:hash(body)};
}
function correctionValues(raw, receipt) {
  const before = normalizedRow(raw), {receipt_sha256,...body}=receipt;
  if (hash(before)!==receipt.before_sha256 || hash(body)!==receipt_sha256 || receipt.version!==VERSION)
    throw Error('STATIONARY_RESOURCE_CONCURRENT_CHANGE');
  return {doctor_id:receipt.doctor_id,instalacion_id:receipt.installation_id,
    import_metadata:{...before.import_metadata,stationary_resource_correction:receipt,
      notification_suppression:{...before.import_metadata.notification_suppression,appointment_details:true,day_before:true,same_day:true},
      cliniccloud_reconciliation:{...before.import_metadata.cliniccloud_reconciliation,automation_policy:'hold'}}};
}
module.exports={prepareCorrection,correctionValues};

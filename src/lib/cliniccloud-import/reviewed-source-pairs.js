'use strict';

// Read-only recognition of an already applied, explicitly reviewed pair from
// one export. This is NOT a rule preferring active rows to cancelled rows.
const { hash, norm, localToUtc } = require('./adapter');
const { sourceReference, ACCOUNT } = require('./week-appointments');
const positive = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const sha = value => /^[a-f0-9]{64}$/.test(value || '');
const keys = ['source_contact_id', 'start_local', 'end_local', 'agenda_key', 'service_key'];
const fail = () => { throw Error('REVIEWED_SOURCE_PAIR_INVALID'); };

function validProvenance(p) {
  return p && sha(p.file_sha256) && sha(p.row_sha256) && positive(p.source_row)
    && p.row_key === `appointment:${p.file_sha256}:${p.source_row}:${p.row_sha256}`;
}

function storedReviewedSourcePair(row, metadata) {
  const review = metadata?.cliniccloud_reviewed_additional_visit;
  if (!review) return null;
  const delta = metadata.cliniccloud_delta, source = delta?.source;
  const applied = Object.values(metadata.cliniccloud_reconciliation?.applied || {})
    .filter(entry => entry.package_sha256 === review.package_sha256);
  if (review.version !== 1 || row.source_system !== 'cliniccloud' || metadata.source_account !== ACCOUNT
    || ![66, 72].includes(Number(row.clinica_id)) || !positive(row.id_cita) || !positive(row.paciente_id)
    || !positive(metadata.source_appointment_id) || !positive(review.preserved_appointment_id)
    || !positive(review.preserved_source_appointment_id) || Number(review.preserved_appointment_id) === Number(row.id_cita)
    || String(review.preserved_source_appointment_id) === String(metadata.source_appointment_id)
    || !sha(review.package_sha256) || !sha(review.live_evidence_sha256) || !String(review.reason || '').trim()
    || !Number.isFinite(Date.parse(review.live_captured_at)) || !Number.isFinite(Date.parse(delta?.imported_at))
    || Date.parse(delta.imported_at) < Date.parse(review.live_captured_at)
    || Date.parse(delta.imported_at) - Date.parse(review.live_captured_at) > 3600000
    || delta?.version !== 1 || delta.source_reference_kind !== 'import_fingerprint_not_source_appointment_id'
    || !source || keys.some(key => typeof source[key] !== 'string' || !source[key])
    || !positive(source.source_contact_id) || source.source_contact_id !== metadata.source_contact_id
    || source.status !== 'pendiente' || !localToUtc(source.start_local) || !localToUtc(source.end_local)
    || source.end_local <= source.start_local || sourceReference(source) !== row.source_reference
    || !validProvenance(delta.provenance) || applied.length !== 1
    || !sha(applied[0].operation_sha256) || applied[0].automation_policy !== 'hold'
    || applied[0].events_dispatched !== false || applied[0].imported_at !== delta.imported_at
    || !String(applied[0].reviewed_by || '').trim()
    || metadata.cliniccloud_parallel_sources || metadata.cliniccloud_source_revision
    || metadata.cliniccloud_legacy_source_reconciliation || metadata.cliniccloud_delta_source_reconciliation) fail();
  const cancelled = review.superseded_cancelled_provenance;
  // A reviewed additional visit without an obsolete cancelled copy needs no
  // special planner handling. Its original creation remains auditable.
  if (cancelled === null) return null;
  if (!validProvenance(cancelled) || cancelled.file_sha256 !== delta.provenance.file_sha256
    || cancelled.source_row === delta.provenance.source_row || cancelled.row_sha256 === delta.provenance.row_sha256) fail();
  return { source_reference: row.source_reference, source_appointment_id: String(metadata.source_appointment_id),
    source, retained_provenance: delta.provenance, superseded_provenance: cancelled,
    local_note: String(row.nota || ''), package_sha256: review.package_sha256 };
}

function dispositionForReviewedPair(row, pair) {
  if (!row || row.kind !== 'appointment' || row.validation_errors?.length
    || keys.some(key => row[key] !== pair.source[key])
    || norm(row.details || '') !== norm(pair.local_note)
    || (row.source_external_id && String(row.source_external_id) !== pair.source_appointment_id)) return null;
  if (row.status === 'pendiente' && hash(row.provenance) === hash(pair.retained_provenance)) return 'retained';
  if (row.status === 'cancelada' && !row.source_external_id
    && hash(row.provenance) === hash(pair.superseded_provenance)) return 'superseded_cancelled';
  return null;
}

module.exports = { storedReviewedSourcePair, dispositionForReviewedPair };

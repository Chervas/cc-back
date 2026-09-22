'use strict';

// Persist a user's already applied choice, without changing any appointment.
// Exact original rows only: this never infers that two visits are duplicates.
const { hash, norm, localToUtc } = require('./adapter');
const { normalizedRow, instant } = require('./appointments-apply');
const { sourceReference, ACCOUNT } = require('./week-appointments');
const VERSION = 'cliniccloud-confirmed-source-selection/1';
const keys = ['source_contact_id', 'start_local', 'end_local', 'agenda_key', 'service_key', 'status'];
const pick = source => ({ ...Object.fromEntries(keys.map(k => [k, source[k]])), details: source.details || '' });
const fail = () => { throw Error('CONFIRMED_SOURCE_SELECTION_INVALID'); };
const positive = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const sha = value => /^[a-f0-9]{64}$/.test(value || '');
function validEntry(entry) {
  const s = entry?.source, p = entry?.provenance;
  return s && keys.every(k => typeof s[k] === 'string' && s[k]) && typeof s.details === 'string'
    && positive(s.source_contact_id) && s.status === 'pendiente'
    && localToUtc(s.start_local) && localToUtc(s.end_local) && s.end_local > s.start_local
    && sourceReference(s) === entry.source_reference && sha(entry.action_key)
    && p && sha(p.file_sha256) && sha(p.row_sha256) && positive(p.source_row)
    && p.row_key === `appointment:${p.file_sha256}:${p.source_row}:${p.row_sha256}`;
}
function validateReceipt(r) {
  if (!r) fail();
  const { receipt_sha256, ...body } = r, c = r.confirmation;
  if (r.version !== VERSION || r.source_account !== ACCOUNT || hash(body) !== receipt_sha256
    || !positive(r.appointment_id) || !positive(r.patient_id) || ![66, 72].includes(r.clinic_id)
    || !sha(r.before_sha256) || !sha(r.delta_sha256) || !validEntry(r.retained) || !validEntry(r.superseded)
    || r.retained.source_reference === r.superseded.source_reference
    || r.retained.provenance.file_sha256 !== r.superseded.provenance.file_sha256
    || r.retained.provenance.row_key === r.superseded.provenance.row_key
    || ['source_contact_id', 'service_key'].some(k => r.retained.source[k] !== r.superseded.source[k])
    || (r.retained.source.agenda_key !== r.superseded.source.agenda_key
      && ![r.retained.source.agenda_key, r.superseded.source.agenda_key].every(a => /^CABINA [1-9]\d*\b/.test(a)))
    || r.retained.source.start_local.slice(0, 10) !== r.superseded.source.start_local.slice(0, 10)
    || !c || c.version !== 1 || c.source !== 'user_conversation' || c.source_account !== ACCOUNT
    || c.patient_id !== r.patient_id || norm(c.answer) !== 'SI' || !String(c.reference || '').trim()
    || String(c.interpretation || '').trim().length < 20 || !Number.isFinite(Date.parse(c.recorded_at))
    || !Number.isFinite(Date.parse(r.reviewed_at)) || Date.parse(c.recorded_at) > Date.parse(r.reviewed_at)
    || !String(r.reviewed_by || '').trim() || r.automation_policy !== 'hold') fail();
  for (const key of ['retained', 'superseded']) if (c[key]?.source_reference !== r[key].source_reference
    || c[key]?.source_row !== r[key].provenance.source_row || c[key]?.action_key !== r[key].action_key) fail();
  return r;
}
function prepareConfirmedSelection({ before: raw, retained, superseded, confirmation, reviewedBy, now = Date.now() }) {
  const before = normalizedRow(raw), m = before.import_metadata, delta = m.cliniccloud_delta;
  if (before.source_system !== 'cliniccloud' || m.source_account !== ACCOUNT
    || before.estado !== 'pendiente' || before.voucher_id || before.es_provisional || before.hold_expires_at || before.updated_by
    || m.booking || m.program_session || m.cliniccloud_confirmed_source_selection
    || m.cliniccloud_parallel_sources || m.cliniccloud_source_revision || m.cliniccloud_reviewed_additional_visit
    || m.cliniccloud_legacy_source_reconciliation || m.cliniccloud_delta_source_reconciliation
    || ![retained, superseded].every(a => a?.entity === 'appointment' && a.patient_id === before.paciente_id
      && a.source?.kind === 'appointment' && !a.source.validation_errors?.length && !a.source.source_external_id)
    || delta?.version !== 1 || delta.source_reference_kind !== 'import_fingerprint_not_source_appointment_id'
    || keys.some(k => delta.source?.[k] !== retained.source[k]) || hash(delta.provenance) !== hash(retained.provenance)
    || before.source_reference !== sourceReference(retained.source) || m.source_contact_id !== retained.source.source_contact_id
    || before.inicio !== localToUtc(retained.source.start_local) || before.fin !== localToUtc(retained.source.end_local)
    || (before.nota || '') !== (retained.source.details || '')
    || !delta.evidence?.includes(confirmation.reference + ' respuesta: si')
    || m.cliniccloud_reconciliation?.applied?.[retained.action_key]?.automation_policy !== 'hold'
    || m.cliniccloud_reconciliation?.automation_policy !== 'hold'
    || !['appointment_details', 'day_before', 'same_day'].every(k => m.notification_suppression?.[k] === true)) fail();
  const entry = a => ({ source_reference: sourceReference(a.source), action_key: a.action_key,
    source: pick(a.source), provenance: a.provenance });
  const body = { version: VERSION, source_account: ACCOUNT, appointment_id: before.id_cita,
    patient_id: before.paciente_id, clinic_id: before.clinica_id, before_sha256: hash(before), delta_sha256: hash(delta),
    retained: entry(retained), superseded: entry(superseded), confirmation: structuredClone(confirmation),
    reviewed_by: reviewedBy, reviewed_at: new Date(now).toISOString(), automation_policy: 'hold' };
  return validateReceipt({ ...body, receipt_sha256: hash(body) });
}
function storedConfirmedSelection(row, m) {
  const r = m?.cliniccloud_confirmed_source_selection;
  if (!r) return null;
  validateReceipt(r);
  if (row.source_system !== 'cliniccloud' || row.source_reference !== r.retained.source_reference
    || Number(row.id_cita) !== r.appointment_id || Number(row.paciente_id) !== r.patient_id || Number(row.clinica_id) !== r.clinic_id
    || m.source_account !== ACCOUNT || m.source_contact_id !== r.retained.source.source_contact_id
    || hash(m.cliniccloud_delta) !== r.delta_sha256 || m.cliniccloud_parallel_sources || m.cliniccloud_source_revision
    || m.cliniccloud_reviewed_additional_visit || m.cliniccloud_legacy_source_reconciliation || m.cliniccloud_delta_source_reconciliation) fail();
  return r;
}
function selectionLocalChanged(row, r) {
  return instant(row.inicio) !== localToUtc(r.retained.source.start_local) || instant(row.fin) !== localToUtc(r.retained.source.end_local)
    || row.estado !== r.retained.source.status || (row.nota || '') !== r.retained.source.details;
}
function matchesSelectionEntry(row, entry) {
  return row?.kind === 'appointment' && !row.validation_errors?.length && !row.source_external_id
    && hash(pick(row)) === hash(entry.source) && hash(row.provenance) === hash(entry.provenance);
}
module.exports = { prepareConfirmedSelection, storedConfirmedSelection, selectionLocalChanged, matchesSelectionEntry };

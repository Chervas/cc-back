'use strict';

// Read-only evidence/receipt contract for existing legacy appointments. The
// caller must lock resources and dependencies; this module is not a DB writer.
const { hash, norm, localToUtc, localDateTime } = require('./adapter');
const { normalizedRow, instant } = require('./appointments-apply');
const { sourceReference } = require('./week-appointments');
const VERSION = 'cliniccloud-legacy-source-reconciliation/1';
const ACCOUNT = 'cliniccloud-5880';
const fail = () => { throw Error('LEGACY_SOURCE_RECONCILIATION_INVALID'); };
const fields = ['source_contact_id', 'start_local', 'end_local', 'agenda_key', 'service_key', 'status', 'details'];
const pick = s => Object.fromEntries(fields.map(k => [k, s[k] || '']));
const clinical = r => ({ patient: r.paciente_id, clinic: r.clinica_id, doctor: r.doctor_id,
  room: r.instalacion_id, treatment: r.tratamiento_id, note: r.nota, type: r.tipo_cita });
const positive = n => /^[1-9]\d*$/.test(String(n)) && Number.isSafeInteger(Number(n));
const sha = s => /^[a-f0-9]{64}$/.test(s || '');
const inReviewedWeek = local => local >= '2026-09-21' && local < '2026-09-28';
function observed(row) {
  if (!positive(row?.idCita) || !positive(row.idContacto) || Number(row.idEmpresa) !== 5880
    || ![0, -2].includes(Number(row.estado)) || row.conceptos?.length !== 1
    || !positive(row.conceptos[0].idServicio) || !row.conceptos[0].asunto || !row.agenda?.nombre) fail();
  return { source_contact_id: String(row.idContacto),
    start_local: localDateTime(row.fechaIni, row.horaIni), end_local: localDateTime(row.fechaFin, row.horaFin),
    agenda_key: norm(row.agenda.nombre), service_key: norm(row.conceptos[0].asunto),
    status: Number(row.estado) === -2 ? 'cancelada' : 'pendiente', details: String(row.detalles || '') };
}
function minutes(start, end) { return (Date.parse(localToUtc(end)) - Date.parse(localToUtc(start))) / 60000; }
// A duration-only correction needs both the old calendar observation (binding
// the unchanged CSV to a real ID) and the recent history of that same ID. It
// does not permit a date, state, agenda or procedure change through this path.
function durationRevision({ before, current, currentRow, source, originalLive, history, reviewedMinutes }) {
  if (!originalLive || originalLive.source_account !== ACCOUNT || !Array.isArray(originalLive.rows)
    || !Number.isFinite(Date.parse(originalLive.captured_at))
    || Date.parse(originalLive.captured_at) >= Date.parse(history.captured_at)
    || !reviewedMinutes || String(reviewedMinutes.reason || '').trim().length < 20
    || current.status !== 'pendiente' || source.status !== 'pendiente'
    || localToUtc(source.start_local) !== before.inicio || localToUtc(source.end_local) !== before.fin
    || fields.filter(k => k !== 'end_local').some(k => source[k] !== current[k])) fail();
  const previous = minutes(source.start_local, source.end_local), next = minutes(current.start_local, current.end_local);
  if (![previous, next].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1440)
    || previous === next || reviewedMinutes.previous !== previous || reviewedMinutes.current !== next) fail();
  const found = originalLive.rows.filter(r => String(r.contact_id) === source.source_contact_id
    && r.state === 0 && String(r.start).replace(' ', 'T') === source.start_local
    && String(r.end).replace(' ', 'T') === source.end_local && norm(r.agenda) === source.agenda_key
    && norm(r.service) === source.service_key && norm(r.details) === norm(source.details));
  if (found.length !== 1 || String(found[0].appointment_id) !== String(currentRow.idCita)) fail();
  return { previous_minutes: previous, current_minutes: next, reason: reviewedMinutes.reason.trim(),
    original_observed_at: originalLive.captured_at, original_observation_sha256: hash(originalLive),
    original_row_sha256: hash(found[0]), current_row_sha256: hash(currentRow) };
}
function prepareLegacyReconciliation({ before: raw, history, sources, reviewedBy, reason, originalLive, reviewedMinutes, now = Date.now() }) {
  const before = normalizedRow(raw), m = before.import_metadata, old = m.raw;
  if (before.source_system !== 'cliniccloud' || ![66, 72].includes(before.clinica_id)
    || before.estado !== 'pendiente' || before.source_reference !== `appointment:${m.source_appointment_id}`
    || !positive(m.source_contact_id) || !old || String(old.idCita) !== String(m.source_appointment_id)
    || String(old.idContacto) !== String(m.source_contact_id) || Number(old.estado) !== 0
    || before.inicio !== localToUtc(localDateTime(old.fechaIni, old.horaIni))
    || before.fin !== localToUtc(localDateTime(old.fechaFin, old.horaFin))
    || before.updated_by || before.es_provisional || before.hold_expires_at || before.voucher_id || before.lead_intake_id
    || m.booking || m.program_session || m.additional_staff || m.cliniccloud_legacy_source_reconciliation
    || !String(reviewedBy || '').trim() || !String(reason || '').trim()) fail();
  if (history?.source_account !== ACCOUNT || !Number.isFinite(Date.parse(history.captured_at))
    || now < Date.parse(history.captured_at) || now - Date.parse(history.captured_at) > 3600000) fail();
  const patients = history.patients?.filter(p => String(p.contact_id) === String(m.source_contact_id)) || [];
  if (patients.length !== 1 || !Array.isArray(patients[0].rows)) fail();
  const exact = patients[0].rows.filter(r => String(r.idCita) === String(m.source_appointment_id));
  if (exact.length !== 1) fail();
  const current = observed(exact[0]);
  if (current.source_contact_id !== String(m.source_contact_id)
    || String(exact[0].conceptos[0].idServicio) !== String(m.source_service_id)
    || norm(current.details) !== norm(old.detalles || '')
    || current.start_local < '2026-09-01' || current.start_local >= '2027-01-01'
    || current.end_local > '2027-01-01T00:00:00'
    // An existing appointment moved OUT of the priority week must leave its old
    // slot too. This does not permit unrelated future-to-future reconciliation.
    || (current.status === 'pendiente' && !inReviewedWeek(current.start_local)
      && !inReviewedWeek(localDateTime(old.fechaIni, old.horaIni)))
    || Date.parse(before.inicio) < now || Date.parse(localToUtc(current.start_local)) < now) fail();
  if (!Array.isArray(sources) || !sources.length || sources.length > 2) fail();
  let duration = null;
  if (originalLive !== undefined || reviewedMinutes !== undefined) {
    if (sources.length !== 1) fail();
    duration = durationRevision({ before, current, currentRow: exact[0], source: sources[0], originalLive, history, reviewedMinutes });
  } else if (Date.parse(localToUtc(current.end_local)) - Date.parse(localToUtc(current.start_local)) !== Date.parse(before.fin) - Date.parse(before.inicio)) fail();
  const entries = sources.map(source => {
    if (source.kind !== 'appointment' || source.validation_errors?.length || !sha(source.provenance?.row_sha256)
      || !sha(source.provenance?.file_sha256) || !positive(source.provenance?.source_row)) fail();
    if (duration) {
      if (source.source_external_id && String(source.source_external_id) !== String(exact[0].idCita)) fail();
      return { source_reference: sourceReference(source), source_appointment_id: String(exact[0].idCita),
        source: pick(source), provenance: source.provenance };
    }
    const found = patients[0].rows.filter(r => {
      try { return hash(pick(source)) === hash(observed(r)); } catch { return false; }
    });
    if (found.length !== 1 || (source.source_external_id && String(source.source_external_id) !== String(found[0].idCita))) fail();
    const s = observed(found[0]);
    if (fields.filter(k => k !== 'agenda_key').some(k => s[k] !== current[k])) fail();
    return { source_reference: sourceReference(source), source_appointment_id: String(found[0].idCita),
      source: s, provenance: source.provenance };
  }).sort((a, b) => a.source_reference.localeCompare(b.source_reference));
  if (!entries.some(e => e.source_appointment_id === String(m.source_appointment_id))
    || new Set(entries.map(e => e.source_appointment_id)).size !== entries.length
    || new Set(entries.map(e => e.source.agenda_key)).size !== entries.length) fail();
  const body = { version: VERSION, source_account: ACCOUNT, appointment_id: before.id_cita,
    patient_id: before.paciente_id, clinic_id: before.clinica_id, source_reference: before.source_reference,
    source_contact_id: String(m.source_contact_id), source_appointment_id: String(m.source_appointment_id),
    reviewed_by: reviewedBy, reason, reviewed_at: new Date(now).toISOString(),
    live_captured_at: history.captured_at, live_evidence_sha256: hash(history),
    before_sha256: hash(before), original_raw_sha256: hash(old), clinical_sha256: hash(clinical(before)),
    previous: { start_utc: before.inicio, end_utc: before.fin, status: before.estado }, current, entries,
    automation_policy: 'hold', ...(duration ? { duration_revision: duration } : {}) };
  return { ...body, receipt_sha256: hash(body) };
}
function storedLegacyReconciliation(row, metadata) {
  const r = metadata.cliniccloud_legacy_source_reconciliation;
  if (!r) return null;
  const { receipt_sha256, ...body } = r;
  if (r.version !== VERSION || r.source_account !== ACCOUNT || hash(body) !== receipt_sha256
    || row.source_system !== 'cliniccloud' || row.source_reference !== r.source_reference
    || r.source_reference !== `appointment:${r.source_appointment_id}`
    || Number(row.id_cita) !== r.appointment_id || Number(row.paciente_id) !== r.patient_id || Number(row.clinica_id) !== r.clinic_id
    || String(metadata.source_appointment_id) !== r.source_appointment_id || String(metadata.source_contact_id) !== r.source_contact_id
    || hash(metadata.raw) !== r.original_raw_sha256 || !r.entries?.length || r.entries.length > 2
    || !['pendiente', 'cancelada'].includes(r.current?.status) || r.current.source_contact_id !== r.source_contact_id
    || !localToUtc(r.current.start_local) || !localToUtc(r.current.end_local)
    || r.current.end_local <= r.current.start_local || !sha(r.clinical_sha256)
    || !sha(r.before_sha256) || !sha(r.live_evidence_sha256)
    || !r.entries.some(e => e.source_appointment_id === r.source_appointment_id)
    || new Set(r.entries.map(e => e.source_appointment_id)).size !== r.entries.length
    || new Set(r.entries.map(e => e.source_reference)).size !== r.entries.length
    || r.automation_policy !== 'hold') fail();
  const duration = r.duration_revision;
  if (duration) {
    const source = r.entries[0].source;
    if (r.entries.length !== 1 || r.current.status !== 'pendiente'
      || source.status !== 'pendiente' || String(duration.reason || '').trim().length < 20
      || !['original_observation_sha256', 'original_row_sha256', 'current_row_sha256'].every(k => sha(duration[k]))
      || !Number.isFinite(Date.parse(duration.original_observed_at))
      || !Number.isFinite(Date.parse(r.live_captured_at)) || Date.parse(duration.original_observed_at) >= Date.parse(r.live_captured_at)
      || ![duration.previous_minutes, duration.current_minutes].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1440)
      || duration.previous_minutes === duration.current_minutes
      || duration.previous_minutes !== minutes(source.start_local, source.end_local)
      || duration.current_minutes !== minutes(r.current.start_local, r.current.end_local)
      || localToUtc(source.start_local) !== r.previous?.start_utc || localToUtc(source.end_local) !== r.previous?.end_utc
      || r.previous.start_utc !== localToUtc(localDateTime(metadata.raw.fechaIni, metadata.raw.horaIni))
      || r.previous.end_utc !== localToUtc(localDateTime(metadata.raw.fechaFin, metadata.raw.horaFin))
      || fields.filter(k => k !== 'end_local').some(k => source[k] !== r.current[k])) fail();
  }
  for (const e of r.entries) if (sourceReference(e.source) !== e.source_reference
    || !positive(e.source_appointment_id) || !sha(e.provenance?.file_sha256) || !sha(e.provenance?.row_sha256)
    || !positive(e.provenance?.source_row)
    || fields.filter(k => duration ? k !== 'end_local' : k !== 'agenda_key').some(k => e.source[k] !== r.current[k])) fail();
  return r;
}
function reconciliationChanged(row, receipt) {
  return hash(clinical(row)) !== receipt.clinical_sha256 || instant(row.inicio) !== localToUtc(receipt.current.start_local)
    || instant(row.fin) !== localToUtc(receipt.current.end_local) || row.estado !== receipt.current.status;
}
function patchForLegacyReconciliation(before, receipt, now = Date.now()) {
  if (hash(before) !== receipt.before_sha256 || now < Date.parse(receipt.live_captured_at)
    || now - Date.parse(receipt.live_captured_at) > 3600000) fail();
  const metadata = { ...before.import_metadata, cliniccloud_legacy_source_reconciliation: receipt,
    notification_suppression: { ...before.import_metadata.notification_suppression,
      appointment_details: true, day_before: true, same_day: true },
    cliniccloud_reconciliation: { ...before.import_metadata.cliniccloud_reconciliation, automation_policy: 'hold' } };
  const result = { ...before, inicio: localToUtc(receipt.current.start_local), fin: localToUtc(receipt.current.end_local),
    estado: receipt.current.status, import_metadata: metadata, updated_at: new Date(Math.floor(now / 1000) * 1000).toISOString() };
  storedLegacyReconciliation(result, metadata);
  return result;
}
module.exports = { prepareLegacyReconciliation, storedLegacyReconciliation, reconciliationChanged, patchForLegacyReconciliation };

'use strict';

// Operator-only provenance for two legacy rows representing the same visit.
// Preparation is pure. The caller must atomically preserve both rows, cancel
// only the local duplicate and reserve the survivor through canonical booking.
// This is NOT a source cancellation or a general patient/time deduplication rule.
const { hash, norm, localDateTime, localToUtc } = require('./adapter');
const { normalizedSourceRefreshRow: normalize, prepareSourceRefresh } = require('./source-refresh');
const { sourceReference, ACCOUNT } = require('./week-appointments');
const KEY = 'cliniccloud_duplicate_visit';
const VERSION = 'cliniccloud-duplicate-visit/1';
const positive = n => Number.isSafeInteger(Number(n)) && /^[1-9]\d*$/.test(String(n));
const sha = s => /^[a-f0-9]{64}$/.test(s || '');
const fail = () => { throw Error('DUPLICATE_VISIT_REVIEW_REQUIRED'); };
const sourceKeys = ['source_contact_id', 'start_local', 'end_local', 'agenda_key', 'service_key', 'status', 'details'];
const stableKeys = ['id_cita', 'paciente_id', 'clinica_id', 'source_system', 'source_reference', 'tratamiento_id', 'nota', 'tipo_cita'];
const stableRow = row => Object.fromEntries(stableKeys.map(k => [k, row[k] ?? null]));
const original = m => Object.fromEntries(Object.entries(m).filter(([k]) => k === 'raw' || k === 'raw_extra' || k.startsWith('source_')));
const decode = r => typeof r.import_metadata === 'string' ? JSON.parse(r.import_metadata) : r.import_metadata || {};
const seal = body => ({ ...body, receipt_sha256: hash(body) });

function validateReceipt(receipt) {
  if (!receipt) fail();
  const { receipt_sha256, ...body } = receipt;
  if (receipt.version !== VERSION || receipt.source_account !== ACCOUNT || !sha(receipt_sha256) || hash(body) !== receipt_sha256
    || !positive(receipt.patient_id) || ![66, 72].includes(receipt.clinic_id)
    || !positive(receipt.canonical_id) || !positive(receipt.retired_id) || receipt.canonical_id === receipt.retired_id
    || !sha(receipt.source_plan_sha256) || !sha(receipt.live_evidence_sha256)
    || !String(receipt.reviewed_by || '').trim() || String(receipt.reason || '').trim().length < 20
    || receipt.decision !== 'same_visit_in_two_source_agendas' || receipt.automation_policy !== 'hold'
    || !Number.isFinite(Date.parse(receipt.reviewed_at)) || !Number.isFinite(Date.parse(receipt.live_captured_at))
    || Date.parse(receipt.reviewed_at) < Date.parse(receipt.live_captured_at)
    || Date.parse(receipt.reviewed_at) - Date.parse(receipt.live_captured_at) > 3600000
    || !Array.isArray(receipt.entries) || receipt.entries.length !== 2) fail();
  const ids = new Set(), externalIds = new Set(), agendas = new Set();
  const first = receipt.entries[0].source;
  for (const e of receipt.entries) {
    const s = e.source, p = e.provenance;
    if (!positive(e.local_id) || ![receipt.canonical_id, receipt.retired_id].includes(e.local_id)
      || !positive(e.source_appointment_id) || e.local_reference !== 'appointment:' + e.source_appointment_id
      || !sha(e.before_sha256) || !sha(e.original_sha256) || !sha(e.stable_sha256) || !sha(e.source_detail_sha256)
      || ids.has(e.local_id) || externalIds.has(e.source_appointment_id)
      || !s || sourceKeys.some(k => typeof s[k] !== 'string') || !positive(s.source_contact_id)
      || !s.agenda_key || !s.service_key || s.status !== 'pendiente'
      || !localToUtc(s.start_local) || !localToUtc(s.end_local) || s.end_local <= s.start_local
      || s.start_local !== first.start_local || s.end_local !== first.end_local
      || s.source_contact_id !== first.source_contact_id || s.service_key !== first.service_key
      || norm(s.details) !== norm(first.details) || agendas.has(s.agenda_key)
      || e.source_reference !== sourceReference(s) || !sha(p?.file_sha256) || !sha(p?.row_sha256)
      || !positive(p?.source_row) || p.row_key !== `appointment:${p.file_sha256}:${p.source_row}:${p.row_sha256}`) fail();
    ids.add(e.local_id); externalIds.add(e.source_appointment_id); agendas.add(s.agenda_key);
  }
  if (ids.size !== 2 || receipt.entries[0].provenance.file_sha256 !== receipt.entries[1].provenance.file_sha256) fail();
  return receipt;
}

function prepareDuplicateVisit({ rows, actions, detailEvidence, canonicalAppointmentId, sourcePlanSha256, reviewedBy, reason, now = Date.now() }) {
  if (!Array.isArray(rows) || rows.length !== 2 || !Array.isArray(actions) || actions.length !== 2
    || detailEvidence?.origin !== 'https://app.clinic-cloud.com/agenda_new.php'
    || !Array.isArray(detailEvidence.data?.rows) || !String(reviewedBy || '').trim()) fail();
  const before = rows.map(normalize), first = before[0];
  const entries = before.map(row => {
    const m = row.import_metadata;
    const matching = actions.filter(a => a.local_id === row.id_cita);
    const details = detailEvidence.data.rows.filter(d => d.source_appointment_id === String(m.source_appointment_id));
    if (matching.length !== 1 || details.length !== 1) fail();
    const action = matching[0], source = action.source, detail = details[0].data;
    if (action.action !== 'update_imported_candidate' || action.requires_review === false || action.reasons?.length
      || action.patient_id !== row.paciente_id || row.paciente_id !== first.paciente_id || row.clinica_id !== first.clinica_id
      || row.tratamiento_id !== first.tratamiento_id || row.tipo_cita !== first.tipo_cita || row.nota !== first.nota
      || row.source_reference !== 'appointment:' + m.source_appointment_id || m.source_account && m.source_account !== ACCOUNT
      || Object.keys(m).some(k => k.startsWith('cliniccloud_') && k !== 'cliniccloud_reconciliation')
      || Number(m.raw?.idEmpresa) !== 5880 || m.raw?.idBono && Number(m.raw.idBono) !== 0
      || Number(m.raw?.pagado) !== 0 || Number(detail.pagado) !== 0
      || detail.idBono && Number(detail.idBono) !== 0 || Number(m.raw?.archivada) !== 0
      || Number(detail.archivada) !== 0 || String(m.raw?.createdOn) !== String(detail.createdOn)
      || m.source_service_id !== first.import_metadata.source_service_id) fail();
    // Reuse the guarded legacy identity/baseline/detail contract. Resources are
    // unchanged here: this helper does not approve the eventual room or machine.
    const checked = prepareSourceRefresh({ before: row, source, detail,
      liveCapturedAt: detailEvidence.captured_at, sourcePlanSha256,
      coverage: { start: source.start_local.slice(0, 10), end: source.end_local.slice(0, 10) },
      resources: { doctor_id: row.doctor_id, installation_id: row.instalacion_id, equipment_ids: [], evidence_sha256: hash(detail) },
      reviewedBy, reason, now });
    if (hash(checked.baseline) !== hash(checked.current) || source.start_utc !== row.inicio || source.end_utc !== row.fin) fail();
    return { local_id: row.id_cita, local_reference: row.source_reference, source_appointment_id: String(m.source_appointment_id),
      before_sha256: hash(row), original_sha256: hash(original(m)), stable_sha256: hash(stableRow(row)),
      source_detail_sha256: hash(detail), source_created_at: String(detail.createdOn), source_reference: sourceReference(source),
      source: Object.fromEntries(sourceKeys.map(k => [k, source[k] || ''])), provenance: source.provenance };
  }).sort((a, b) => a.local_id - b.local_id);
  const canonical = entries.find(e => e.local_id === canonicalAppointmentId), retired = entries.find(e => e.local_id !== canonicalAppointmentId);
  if (!canonical || !retired || !localDateTime(canonical.source_created_at.slice(0, 10), canonical.source_created_at.slice(11))
    || !localDateTime(retired.source_created_at.slice(0, 10), retired.source_created_at.slice(11))
    || canonical.source_created_at <= retired.source_created_at) fail();
  return validateReceipt(seal({ version: VERSION, source_account: ACCOUNT, patient_id: first.paciente_id,
    clinic_id: first.clinica_id, canonical_id: canonicalAppointmentId, retired_id: retired.local_id,
    source_plan_sha256: sourcePlanSha256, live_evidence_sha256: hash(detailEvidence),
    live_captured_at: detailEvidence.captured_at, reviewed_at: new Date(now).toISOString(),
    reviewed_by: reviewedBy, reason, decision: 'same_visit_in_two_source_agendas', automation_policy: 'hold', entries }));
}

function patchDuplicateVisit(raw, receipt, now = Date.now()) {
  validateReceipt(receipt);
  const row = normalize(raw), entry = receipt.entries.find(e => e.local_id === row.id_cita);
  if (!entry || hash(row) !== entry.before_sha256 || now < Date.parse(receipt.reviewed_at)
    || now - Date.parse(receipt.live_captured_at) > 3600000) fail();
  return { ...row, estado: row.id_cita === receipt.canonical_id ? 'pendiente' : 'cancelada',
    updated_at: new Date(Math.floor(now / 1000) * 1000).toISOString(), import_metadata: { ...row.import_metadata,
      notification_suppression: { ...row.import_metadata.notification_suppression, appointment_details: true, day_before: true, same_day: true },
      cliniccloud_reconciliation: { ...row.import_metadata.cliniccloud_reconciliation, automation_policy: 'hold' },
      [KEY]: receipt } };
}

// Validate both sides together. A missing, revived or differently linked retired
// row must stop planning, never silently suppress a potentially real visit.
function duplicateVisitLinks(rows) {
  const byId = new Map(rows.map(r => [Number(r.id_cita), r])), result = new Map();
  for (const row of rows) {
    const m = decode(row), receipt = m[KEY];
    if (!receipt) continue;
    validateReceipt(receipt);
    for (const entry of receipt.entries) {
      const linked = byId.get(entry.local_id), meta = linked && decode(linked);
      if (!linked || hash(meta[KEY]) !== hash(receipt) || linked.source_system !== 'cliniccloud'
        || Number(linked.paciente_id) !== receipt.patient_id || Number(linked.clinica_id) !== receipt.clinic_id
        || linked.source_reference !== entry.local_reference || String(meta.source_appointment_id) !== entry.source_appointment_id
        || String(meta.source_contact_id) !== entry.source.source_contact_id || hash(original(meta)) !== entry.original_sha256
        || (entry.local_id === receipt.retired_id && (linked.estado !== 'cancelada' || hash(stableRow(linked)) !== entry.stable_sha256))) fail();
    }
    if (Number(row.id_cita) !== receipt.canonical_id) continue;
    const entry = receipt.entries.find(e => e.local_id === receipt.canonical_id);
    result.set(receipt.canonical_id, { receipt_sha256: receipt.receipt_sha256, retired_id: receipt.retired_id, entries: receipt.entries,
      local_changed: hash(stableRow(row)) !== entry.stable_sha256 });
  }
  return result;
}

module.exports = { prepareDuplicateVisit, patchDuplicateVisit, duplicateVisitLinks, validateReceipt };

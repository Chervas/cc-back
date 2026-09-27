'use strict';

// Pure operator contract for successive, explicitly reviewed exports. It does
// not write SQL or infer a source ID, resource, clinical act or cancellation.
const { hash, norm, localDateTime, localToUtc, dateOnly } = require('./adapter');
const { normalizedRow, instant } = require('./appointments-apply');
const { sourceReference } = require('./week-appointments');
const { storedDeltaReconciliation } = require('./delta-source-reconciliation');
const { storedLegacyReconciliation } = require('./legacy-source-reconciliation');
const { validatedStoredRevision } = require('./source-revisions');
const VERSION = 'cliniccloud-source-refresh/1';
const ACCOUNT = 'cliniccloud-5880';
const KEY = 'cliniccloud_source_refreshes';
const positive = n => /^[1-9]\d*$/.test(String(n)) && Number.isSafeInteger(Number(n));
const sha = s => /^[a-f0-9]{64}$/.test(s || '');
const fail = () => { throw Error('SOURCE_REFRESH_REVIEW_REQUIRED'); };
// mysql2 raw rows use TINYINT 0/1; Sequelize projects BOOLEAN false/true.
// Both representations must describe the same guarded full-row snapshot.
function normalizedSourceRefreshRow(raw) {
  const row = normalizedRow(raw);
  if ([false, true, 0, 1].includes(row.es_provisional)) row.es_provisional = Number(row.es_provisional);
  return row;
}
const clinical = r => ({ patient:r.paciente_id, clinic:r.clinica_id, doctor:r.doctor_id,
  room:r.instalacion_id, treatment:r.tratamiento_id, note:r.nota, type:r.tipo_cita });
const origin = m => Object.fromEntries(Object.entries(m).filter(([k]) =>
  k === 'raw' || k === 'raw_extra' || k.startsWith('source_') ||
  k.startsWith('cliniccloud_') && ![KEY,'cliniccloud_reconciliation'].includes(k)));
const sourceFields = ['source_contact_id','start_local','end_local','agenda_key','service_key','status','details'];
const pick = source => Object.fromEntries(sourceFields.map(k => [k, source[k] || '']));
function validResources(resources) {
  return resources && !Object.keys(resources).some(k => !['doctor_id','installation_id','equipment_ids','evidence_sha256'].includes(k))
    && positive(resources.doctor_id) && positive(resources.installation_id) && sha(resources.evidence_sha256)
    && Array.isArray(resources.equipment_ids) && resources.equipment_ids.length <= 8
    && resources.equipment_ids.every(positive) && new Set(resources.equipment_ids.map(Number)).size === resources.equipment_ids.length;
}
function validSource(s) {
  return s && sourceFields.every(k => typeof s[k] === 'string') && positive(s.source_contact_id)
    && s.status === 'pendiente' && !!s.agenda_key && !!s.service_key
    && localToUtc(s.start_local) && localToUtc(s.end_local) && s.end_local > s.start_local
    && (Date.parse(localToUtc(s.end_local))-Date.parse(localToUtc(s.start_local))) <= 86400000;
}
// Older CSV exports had no appointment IDs. An archived authenticated calendar
// observation may bind that exact imported slot to the ID returned today. This
// is not patient/name similarity and cannot bind an edited or unrelated slot.
function reviewedIdentityBinding(before, originalLive, liveCapturedAt) {
  const m = before.import_metadata, delta = m?.cliniccloud_delta;
  if (m?.source_appointment_id) { if (originalLive !== undefined) fail(); return null; }
  if (!originalLive || originalLive.source_account !== ACCOUNT || !Array.isArray(originalLive.rows)
    || !Number.isFinite(Date.parse(originalLive.captured_at))
    || Date.parse(originalLive.captured_at) >= Date.parse(liveCapturedAt)
    || m?.source_account !== ACCOUNT || delta?.version !== 1
    || delta.source_reference_kind !== 'import_fingerprint_not_source_appointment_id'
    || !sha(delta.provenance?.file_sha256) || !sha(delta.provenance?.row_sha256)
    || !positive(delta.provenance?.source_row) || before.source_reference !== sourceReference(delta.source)
    || m.cliniccloud_reconciliation?.automation_policy !== 'hold'
    || !['appointment_details','day_before','same_day'].every(k => m.notification_suppression?.[k] === true)) fail();
  const baseline = pick({ ...delta.source, details:before.nota || '' });
  if (!validSource(baseline) || before.inicio !== localToUtc(baseline.start_local)
    || before.fin !== localToUtc(baseline.end_local) || before.estado !== baseline.status
    || baseline.source_contact_id !== String(m.source_contact_id)) fail();
  const matches = originalLive.rows.filter(r => String(r.contact_id) === baseline.source_contact_id
    && Number(r.state) === 0 && String(r.start).replace(' ','T') === baseline.start_local
    && String(r.end).replace(' ','T') === baseline.end_local && norm(r.agenda) === baseline.agenda_key
    && norm(r.service) === baseline.service_key && norm(r.details || '') === norm(baseline.details));
  if (matches.length !== 1 || !positive(matches[0].appointment_id)) fail();
  return { version:1, source_appointment_id:String(matches[0].appointment_id),
    source_contact_id:baseline.source_contact_id, baseline_sha256:hash(baseline),
    observation_sha256:hash(originalLive), row_sha256:hash(matches[0]), observed_at:originalLive.captured_at };
}
function storedSourceRefresh(row, metadata) {
  const ledger = metadata[KEY];
  if (ledger === undefined) return null;
  if (ledger?.version !== VERSION || !Array.isArray(ledger.receipts)
    || !ledger.receipts.length || ledger.receipts.length > 100) fail();
  const entries = new Map();
  let previous = null;
  for (const receipt of ledger.receipts) {
    const { receipt_sha256, ...body } = receipt;
    if (!sha(receipt_sha256) || hash(body) !== receipt_sha256 || receipt.version !== VERSION
      || receipt.source_account !== ACCOUNT || row.source_system !== 'cliniccloud'
      || receipt.source_reference !== row.source_reference
      || Number(row.id_cita) !== receipt.appointment_id || Number(row.paciente_id) !== receipt.patient_id
      || Number(row.clinica_id) !== receipt.clinic_id || ![66,72].includes(receipt.clinic_id)
      || String(metadata.source_appointment_id) !== receipt.source_appointment_id
      || String(metadata.source_contact_id) !== receipt.source_contact_id
      || hash(origin(metadata)) !== receipt.original_evidence_sha256
      || receipt.previous_receipt_sha256 !== (previous?.receipt_sha256 || null)
      || previous && hash(receipt.baseline) !== hash(previous.current)
      || ![receipt.baseline,receipt.current].every(validSource)
      || receipt.baseline.source_contact_id !== receipt.source_contact_id
      || receipt.current.source_contact_id !== receipt.source_contact_id
      || receipt.current.service_key !== receipt.baseline.service_key
      || norm(receipt.current.details) !== norm(receipt.baseline.details)
      || !['before_sha256','source_plan_sha256','source_detail_sha256','clinical_sha256'].every(k => sha(receipt[k]))
      || !sha(receipt.provenance?.file_sha256) || !sha(receipt.provenance?.row_sha256)
      || !positive(receipt.provenance?.source_row) || receipt.automation_policy !== 'hold'
      || !positive(receipt.source_appointment_id) || !validResources(receipt.resources)
      || !String(receipt.reviewed_by || '').trim() || String(receipt.reason || '').trim().length < 20
      || dateOnly(receipt.coverage?.start) !== receipt.coverage?.start
      || dateOnly(receipt.coverage?.end) !== receipt.coverage?.end
      || receipt.coverage.start > receipt.coverage.end
      || receipt.current.start_local.slice(0,10) < receipt.coverage.start
      || receipt.current.end_local.slice(0,10) > receipt.coverage.end
      || !Number.isFinite(Date.parse(receipt.live_captured_at)) || !Number.isFinite(Date.parse(receipt.reviewed_at))
      || Date.parse(receipt.live_captured_at) > Date.parse(receipt.reviewed_at)
      || Date.parse(receipt.reviewed_at) - Date.parse(receipt.live_captured_at) > 3600000
      || previous && Date.parse(receipt.live_captured_at) < Date.parse(previous.live_captured_at)) fail();
    const binding = receipt.source_identity_binding;
    if (binding && (previous || binding.version !== 1 || binding.source_appointment_id !== receipt.source_appointment_id
      || binding.source_contact_id !== receipt.source_contact_id || binding.baseline_sha256 !== hash(receipt.baseline)
      || !sha(binding.observation_sha256) || !sha(binding.row_sha256)
      || !Number.isFinite(Date.parse(binding.observed_at))
      || Date.parse(binding.observed_at) >= Date.parse(receipt.live_captured_at)
      || metadata.cliniccloud_delta?.version !== 1
      || metadata.cliniccloud_delta.source_reference_kind !== 'import_fingerprint_not_source_appointment_id'
      || row.source_reference !== sourceReference(metadata.cliniccloud_delta.source))) fail();
    for (const source of [receipt.baseline,receipt.current]) entries.set(sourceReference(source), {
      source_reference:sourceReference(source), source_appointment_id:receipt.source_appointment_id, source,
    });
    previous = receipt;
  }
  return { ...previous, entries:[...entries.values()] };
}
function sourceBaseline(before, metadata, detail, previous) {
  if (previous) return previous.current;
  const existing = storedDeltaReconciliation(before,metadata)?.current
    || storedLegacyReconciliation(before,metadata)?.current
    || validatedStoredRevision(before,metadata)?.current || metadata.cliniccloud_delta?.source;
  if (existing) return pick({ ...existing, details:existing.details ?? before.nota ?? '' });
  const raw = metadata.raw;
  if (!raw || String(raw.idCita) !== String(metadata.source_appointment_id)
    || String(raw.idContacto) !== String(metadata.source_contact_id) || Number(raw.estado) !== 0
    || String(raw.idAgenda) !== String(detail.idAgenda)
    || detail.cita_conceptos.length !== 1
    || String(detail.cita_conceptos[0].idServicio) !== String(metadata.source_service_id)) fail();
  // An exact original service ID, not a name similarity, binds legacy imports.
  return pick({ source_contact_id:String(metadata.source_contact_id),
    start_local:localDateTime(raw.fechaIni,raw.horaIni), end_local:localDateTime(raw.fechaFin,raw.horaFin),
    agenda_key:norm(detail.agenda.nombre), service_key:norm(detail.cita_conceptos[0].asunto),
    status:'pendiente', details:String(raw.detalles || '') });
}
function prepareSourceRefresh({ before:raw, source, detail, liveCapturedAt, sourcePlanSha256, originalLive,
  coverage, resources, reviewedBy, reason, now=Date.now() }) {
  const before=normalizedSourceRefreshRow(raw), m=before.import_metadata;
  const binding = reviewedIdentityBinding(before, originalLive, liveCapturedAt);
  const linked = binding ? {...m, source_appointment_id:binding.source_appointment_id} : m;
  if (before.source_system !== 'cliniccloud' || ![66,72].includes(before.clinica_id)
    || !['id_cita','paciente_id','clinica_id'].every(k=>positive(before[k]))
    || before.estado !== 'pendiente' || before.updated_by || before.voucher_id || before.lead_intake_id
    || before.es_provisional || before.hold_expires_at || !before.source_reference || !m || !positive(linked.source_appointment_id)
    || !positive(m.source_contact_id) || m.source_account && m.source_account !== ACCOUNT
    || ['booking','program_session','additional_staff','import_resource_resolution','import_treatment_resolution',
      'cliniccloud_parallel_sources','cliniccloud_reviewed_source_pair','cliniccloud_confirmed_source_selection']
      .some(k=>m[k]!=null) || !String(reviewedBy||'').trim() || String(reason||'').trim().length < 20
    || !sha(sourcePlanSha256) || !Number.isFinite(Date.parse(liveCapturedAt))
    || now < Date.parse(liveCapturedAt) || now-Date.parse(liveCapturedAt)>3600000
    || dateOnly(coverage?.start)!==coverage?.start || dateOnly(coverage?.end)!==coverage?.end
    || coverage.start>coverage.end || !source || source.kind!=='appointment' || source.validation_errors?.length
    || !validSource(pick(source)) || source.start_utc!==localToUtc(source.start_local)
    || source.end_utc!==localToUtc(source.end_local) || source.start_local.slice(0,10)<coverage.start
    || source.end_local.slice(0,10)>coverage.end || Date.parse(source.start_utc)<now
    || !sha(source.provenance?.file_sha256) || !sha(source.provenance?.row_sha256)
    || !positive(source.provenance?.source_row)) fail();
  if (!detail || Number(detail.idEmpresa)!==5880 || String(detail.idCita)!==String(linked.source_appointment_id)
    || String(detail.idContacto)!==String(m.source_contact_id) || source.source_contact_id!==String(m.source_contact_id)
    || Number(detail.estado)!==0 || !Array.isArray(detail.cita_conceptos) || !detail.cita_conceptos.length
    || !detail.agenda?.nombre || norm(detail.agenda.nombre)!==source.agenda_key
    || norm(detail.cita_conceptos.map(c=>c.asunto).join('-'))!==source.service_key
    || localDateTime(detail.fechaIni,detail.horaIni)!==source.start_local
    || localDateTime(detail.fechaFin,detail.horaFin)!==source.end_local
    || norm(detail.detalles||'')!==norm(source.details||'')) fail();
  const previous=storedSourceRefresh(before,m), baseline=sourceBaseline(before,linked,detail,previous);
  if (!validSource(baseline) || before.inicio!==localToUtc(baseline.start_local)
    || before.fin!==localToUtc(baseline.end_local) || baseline.service_key!==source.service_key
    || norm(baseline.details)!==norm(source.details||'')
    || previous && (hash(clinical(before))!==previous.clinical_sha256
      || Date.parse(liveCapturedAt)<Date.parse(previous.live_captured_at))) fail();
  if (!validResources(resources)) fail();
  const effective={...before,doctor_id:Number(resources.doctor_id),instalacion_id:Number(resources.installation_id)};
  const body={version:VERSION,source_account:ACCOUNT,appointment_id:before.id_cita,patient_id:before.paciente_id,
    clinic_id:before.clinica_id,source_reference:before.source_reference,source_contact_id:String(m.source_contact_id),
    source_appointment_id:String(linked.source_appointment_id),before_sha256:hash(before),original_evidence_sha256:hash(origin(linked)),
    previous_receipt_sha256:previous?.receipt_sha256||null,baseline,current:pick(source),provenance:source.provenance,
    source_plan_sha256:sourcePlanSha256,source_detail_sha256:hash(detail),live_captured_at:liveCapturedAt,
    reviewed_at:new Date(now).toISOString(),reviewed_by:reviewedBy,reason,coverage:{...coverage},
    resources:{...resources},clinical_sha256:hash(clinical(effective)),automation_policy:'hold',
    ...(binding ? {source_identity_binding:binding} : {})};
  return {...body,receipt_sha256:hash(body)};
}
function patchSourceRefresh(raw, receipt, now=Date.now()) {
  const before=normalizedSourceRefreshRow(raw);
  if (hash(before)!==receipt.before_sha256 || now<Date.parse(receipt.live_captured_at)
    || now-Date.parse(receipt.live_captured_at)>3600000) fail();
  const m=before.import_metadata;
  const after={...before,inicio:localToUtc(receipt.current.start_local),fin:localToUtc(receipt.current.end_local),
    doctor_id:Number(receipt.resources.doctor_id),instalacion_id:Number(receipt.resources.installation_id),
    updated_at:new Date(Math.floor(now/1000)*1000).toISOString(),import_metadata:{...m,
      ...(receipt.source_identity_binding ? {source_appointment_id:receipt.source_appointment_id} : {}),
      notification_suppression:{...m.notification_suppression,appointment_details:true,day_before:true,same_day:true},
      cliniccloud_reconciliation:{...m.cliniccloud_reconciliation,automation_policy:'hold'},
      [KEY]:{version:VERSION,receipts:[...(m[KEY]?.receipts||[]),receipt]}}};
  storedSourceRefresh(after,after.import_metadata);
  if (hash(clinical(after)) !== receipt.clinical_sha256) fail();
  return after;
}
function sourceRefreshChanged(row, receipt) {
  return hash(clinical(row))!==receipt.clinical_sha256 || instant(row.inicio)!==localToUtc(receipt.current.start_local)
    || instant(row.fin)!==localToUtc(receipt.current.end_local) || row.estado!==receipt.current.status;
}
module.exports={prepareSourceRefresh,patchSourceRefresh,storedSourceRefresh,sourceRefreshChanged,normalizedSourceRefreshRow};

'use strict';

// Explicit operator review, never an automatic patient/date matching rule.
// A later visit may coexist with a preserved native first visit. Source history
// corroborates the decision; its clinical/payment states are NOT imported.
const { hash, norm, localToUtc } = require('./adapter');
const { normalizedRow } = require('./appointments-apply');
const VERSION = 'cliniccloud-distinct-visit/1';
const ACCOUNT = 'cliniccloud-5880';
const fail = () => { throw Error('DISTINCT_VISIT_REVIEW_INVALID'); };
const sha = v => /^[a-f0-9]{64}$/.test(v || '');
const positive = v => Number.isSafeInteger(Number(v)) && /^[1-9]\d*$/.test(String(v));
const sourceKeys = ['source_contact_id', 'start_local', 'end_local', 'agenda_key', 'service_key', 'status', 'details'];
const pick = source => Object.fromEntries(sourceKeys.map(k => [k, source[k] || '']));

function validateDistinctVisit(review, action) {
  if (!review) fail();
  const { review_sha256, ...body } = review;
  const source = review.source, native = review.preserved_native, current = review.current;
  if (review.version !== VERSION || review.source_account !== ACCOUNT || hash(body) !== review_sha256
    || !sha(review.action_sha256) || !sha(review.history_evidence_sha256)
    || !String(review.reviewed_by || '').trim() || String(review.reason || '').trim().length < 30
    || !Number.isFinite(Date.parse(review.reviewed_at)) || !Number.isFinite(Date.parse(review.history_captured_at))
    || Date.parse(review.reviewed_at) < Date.parse(review.history_captured_at)
    || Date.parse(review.reviewed_at) - Date.parse(review.history_captured_at) > 3600000
    || !source || source.status !== 'pendiente' || !positive(source.source_contact_id)
    || !localToUtc(source.start_local) || !localToUtc(source.end_local) || source.end_local <= source.start_local
    || !positive(review.patient_id) || !native || !positive(native.id_cita)
    || Number(native.paciente_id) !== review.patient_id || ![66, 72].includes(Number(native.clinica_id))
    || native.source_system || native.source_reference
    || !['primera_sin_trat', 'primera_con_trat'].includes(native.tipo_cita)
    || !['completada', 'info_enviada', 'pendiente', 'confirmada'].includes(native.estado)
    || normalizedRow(native).fin >= localToUtc(source.start_local)
    || !current || !positive(current.appointment_id) || current.contact_id !== source.source_contact_id
    || current.state !== 0 || hash(current.source) !== hash(source)
    || !Array.isArray(review.prior_encounters) || !review.prior_encounters.length) fail();
  const seen = new Set([current.appointment_id]);
  for (const prior of review.prior_encounters) {
    if (!positive(prior.appointment_id) || seen.has(prior.appointment_id)
      || prior.contact_id !== source.source_contact_id || ![1, 3].includes(prior.state)
      || !localToUtc(prior.start_local) || !localToUtc(prior.end_local)
      || !localToUtc(prior.performed_local) || prior.end_local <= prior.start_local
      || prior.start_local.slice(0, 10) <= review.native_day
      || prior.end_local >= source.start_local || prior.performed_local < prior.start_local
      || prior.performed_local >= source.start_local) fail();
    seen.add(prior.appointment_id);
  }
  const { utcToLocal } = require('./adapter');
  if (review.native_day !== utcToLocal(native.inicio).slice(0, 10)) fail();
  if (action && (action.entity !== 'appointment' || action.action !== 'review'
    || hash(action) !== review.action_sha256 || hash(pick(action.source)) !== hash(source)
    || action.patient_id !== review.patient_id || action.source.validation_errors?.length
    || hash(action.candidate_local_ids) !== hash([Number(native.id_cita)])
    || !action.reasons.includes('POSSIBLE_RESCHEDULE_OR_NATIVE_DUPLICATE')
    || action.reasons.some(r => !['POSSIBLE_RESCHEDULE_OR_NATIVE_DUPLICATE', 'RESOURCE_AND_SERVICE_MAP_REQUIRED'].includes(r)))) fail();
  return review;
}

function prepareDistinctVisit({ action, nativeRow, history, historyEvidenceSha256, reviewedBy, reason, now = Date.now() }) {
  if (history?.source_account !== ACCOUNT || !Array.isArray(history.patients)
    || !Number.isFinite(Date.parse(history.captured_at)) || Date.parse(history.captured_at) > now
    || now - Date.parse(history.captured_at) > 3600000) fail();
  const source = pick(action.source), native = normalizedRow(nativeRow);
  const patients = history.patients.filter(p => String(p.contact_id) === source.source_contact_id);
  if (patients.length !== 1 || !Array.isArray(patients[0].rows)) fail();
  const observations = patients[0].rows.map(r => {
    if (String(r.idEmpresa) !== '5880' || String(r.idContacto) !== source.source_contact_id) fail();
    return { appointment_id: String(r.idCita), contact_id: String(r.idContacto), state: Number(r.estado),
      start_local: `${r.fechaIni}T${r.horaIni}`, end_local: `${r.fechaFin}T${r.horaFin}`,
      performed_local: String(r.marcaRealizada || '').replace(' ', 'T'),
      agenda_key: norm(r.agenda?.nombre), service_key: r.conceptos?.length === 1 ? norm(r.conceptos[0].asunto) : '',
      details: String(r.detalles || '') };
  });
  const matches = observations.filter(o => o.start_local === source.start_local && o.end_local === source.end_local
    && o.agenda_key === source.agenda_key && o.service_key === source.service_key && norm(o.details) === norm(source.details));
  if (matches.length !== 1 || matches[0].state !== 0) fail();
  const { utcToLocal } = require('./adapter');
  const nativeDay = utcToLocal(native.inicio).slice(0, 10);
  const prior = observations.filter(o => [1, 3].includes(o.state) && o.start_local.slice(0, 10) > nativeDay
    && o.end_local < source.start_local && localToUtc(o.performed_local));
  const body = { version: VERSION, source_account: ACCOUNT, action_sha256: hash(action), source,
    patient_id: action.patient_id, preserved_native: native, native_day: nativeDay,
    current: { appointment_id: matches[0].appointment_id, contact_id: source.source_contact_id, state: 0, source },
    prior_encounters: prior.map(({ appointment_id, contact_id, state, start_local, end_local, performed_local }) =>
      ({ appointment_id, contact_id, state, start_local, end_local, performed_local })),
    reviewed_by: reviewedBy, reason, reviewed_at: new Date(now).toISOString(),
    history_captured_at: history.captured_at, history_evidence_sha256: historyEvidenceSha256 };
  return validateDistinctVisit({ ...body, review_sha256: hash(body) }, action);
}

function assertFreshDistinctVisit(review, now = Date.now()) {
  validateDistinctVisit(review);
  if (now < Date.parse(review.history_captured_at) || now - Date.parse(review.history_captured_at) > 3600000)
    throw Error('DISTINCT_VISIT_EVIDENCE_EXPIRED');
}

module.exports = { VERSION, prepareDistinctVisit, validateDistinctVisit, assertFreshDistinctVisit };

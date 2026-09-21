'use strict';

// One clinical visit copied into several old calendars. These are provenance
// links, not additional appointments, simultaneous patients or booking phases.
const { hash, norm, localToUtc } = require('./adapter');
const { sourceReference, ACCOUNT } = require('./week-appointments');
const { normalizedRow } = require('./appointments-apply');
const VERSION = 'cliniccloud-parallel-agendas/1';
const keys = ['source_contact_id', 'start_local', 'end_local', 'agenda_key', 'service_key', 'status'];
const sameKeys = keys.filter(key => key !== 'agenda_key');
const digest = value => { const { binding_sha256, ...body } = value; return hash(body); };
const fail = () => { throw Error('PARALLEL_SOURCE_BINDING_INVALID'); };
const positive = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const sha = value => /^[a-f0-9]{64}$/.test(value || '');

function validatedParallelSources(row, metadata) {
  const binding = metadata?.cliniccloud_parallel_sources;
  if (!binding) return [];
  if (binding.version !== VERSION || binding.source_account !== ACCOUNT || binding.binding_sha256 !== digest(binding)
    || row.source_system !== 'cliniccloud' || metadata.source_account !== ACCOUNT
    || Number(row.paciente_id) !== binding.patient_id || binding.canonical_reference !== row.source_reference
    || binding.source_contact_id !== metadata.source_contact_id || !positive(binding.patient_id)
    || !String(binding.reviewed_by || '').trim() || !Number.isFinite(Date.parse(binding.reviewed_at))
    || !Number.isFinite(Date.parse(binding.live_captured_at)) || !sha(binding.live_evidence_sha256)
    || !Array.isArray(binding.entries) || binding.entries.length < 2 || binding.entries.length > 8) fail();
  const refs = new Set(), ids = new Set(), agendas = new Set();
  const first = binding.entries[0]?.source;
  for (const entry of binding.entries) {
    const source = entry.source, provenance = entry.provenance;
    if (!source || keys.some(key => typeof source[key] !== 'string' || !source[key])
      || typeof source.details !== 'string' || source.source_contact_id !== binding.source_contact_id
      || !positive(source.source_contact_id) || source.status !== 'pendiente'
      || !localToUtc(source.start_local) || !localToUtc(source.end_local) || source.end_local <= source.start_local
      || sameKeys.some(key => source[key] !== first[key]) || norm(source.details) !== norm(first.details)
      || sourceReference(source) !== entry.source_reference || refs.has(entry.source_reference)
      || typeof entry.source_appointment_id !== 'string' || !positive(entry.source_appointment_id)
      || ids.has(entry.source_appointment_id) || agendas.has(source.agenda_key)
      || !sha(provenance?.file_sha256) || !sha(provenance?.row_sha256) || !positive(provenance?.source_row)
      || !String(provenance?.row_key || '').trim()) fail();
    refs.add(entry.source_reference); ids.add(entry.source_appointment_id); agendas.add(source.agenda_key);
  }
  const canonical = binding.entries.find(entry => entry.source_reference === binding.canonical_reference)?.source;
  const original = metadata.cliniccloud_delta?.source;
  if (!canonical || !original || metadata.cliniccloud_delta.version !== 1
    || metadata.cliniccloud_delta.source_reference_kind !== 'import_fingerprint_not_source_appointment_id'
    || keys.some(key => canonical[key] !== original[key])) fail();
  return binding.entries;
}

function prepareParallelBinding({ row: raw, actions, live, liveEvidenceSha256, reviewedBy, now = Date.now() }) {
  const row = normalizedRow(raw), metadata = row.import_metadata;
  if (metadata.cliniccloud_parallel_sources) throw Error('PARALLEL_SOURCE_ALREADY_BOUND');
  if (!Array.isArray(actions) || actions.length < 2 || actions.length > 8 || !sha(liveEvidenceSha256)
    || !Number.isFinite(Date.parse(live?.captured_at)) || Date.parse(live.captured_at) > now
    || now - Date.parse(live.captured_at) > 3600000 || !Array.isArray(live.rows)
    || ![66, 72].includes(Number(row.clinica_id))) fail();
  const entries = actions.map(action => {
    const source = action.source;
    if (action.entity !== 'appointment' || !source || source.validation_errors?.length
      || Number(action.patient_id) !== Number(row.paciente_id)
      || localToUtc(source.start_local) !== row.inicio || localToUtc(source.end_local) !== row.fin
      || row.estado !== source.status || norm(row.nota || '') !== norm(source.details || '')) fail();
    const matches = live.rows.filter(observed => String(observed.contact_id) === source.source_contact_id
      && String(observed.start).replace(' ', 'T') === source.start_local && String(observed.end).replace(' ', 'T') === source.end_local
      && norm(observed.agenda) === source.agenda_key && norm(observed.service) === source.service_key
      && norm(observed.details || '') === norm(source.details || ''));
    if (matches.length !== 1 || Number(matches[0].state) !== 0 || !positive(matches[0].appointment_id)) fail();
    return { source_reference: sourceReference(source), source_appointment_id: String(matches[0].appointment_id),
      source: { ...Object.fromEntries(keys.map(key => [key, source[key]])), details: source.details || '' },
      provenance: action.provenance };
  }).sort((a, b) => a.source_reference.localeCompare(b.source_reference));
  const body = { version: VERSION, source_account: ACCOUNT, canonical_reference: row.source_reference,
    patient_id: Number(row.paciente_id), source_contact_id: metadata.source_contact_id,
    reviewed_by: reviewedBy, reviewed_at: new Date(now).toISOString(),
    live_captured_at: live.captured_at, live_evidence_sha256: liveEvidenceSha256, entries };
  const binding = { ...body, binding_sha256: hash(body) };
  const after = { ...metadata, cliniccloud_parallel_sources: binding };
  validatedParallelSources(row, after);
  return { local_id: Number(row.id_cita), expected_row_sha256: hash(row), before: row,
    after_metadata: after, binding_sha256: binding.binding_sha256 };
}

module.exports = { VERSION, prepareParallelBinding, validatedParallelSources };

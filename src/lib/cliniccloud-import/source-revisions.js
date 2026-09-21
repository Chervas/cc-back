'use strict';

// Reviewed changes observed after a CSV export. This module never writes to the
// source system or DB and never guesses a move from patient/day alone.
const { hash, norm, localToUtc } = require('./adapter');
const VERSION = 'cliniccloud-source-revision/1';
const ACCOUNT = 'cliniccloud-5880';
const baselineKeys = ['source_contact_id', 'start_local', 'end_local', 'agenda_key', 'service_key', 'status'];
const pick = source => Object.fromEntries([...baselineKeys, 'details'].map(key => [key, source[key] || '']));
const note = value => norm(String(value || '').replace(/,/g, ' '));
const positive = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const sha = value => /^[a-f0-9]{64}$/.test(value || '');
const fail = () => { throw Error('SOURCE_REVISION_INVALID'); };
const duration = source => Date.parse(localToUtc(source.end_local)) - Date.parse(localToUtc(source.start_local));
function validSource(source) {
  return source && baselineKeys.every(key => typeof source[key] === 'string' && source[key])
    && positive(source.source_contact_id) && source.status === 'pendiente' && typeof source.details === 'string'
    && localToUtc(source.start_local) && localToUtc(source.end_local) && duration(source) > 0 && duration(source) <= 86400000;
}
function validateSourceRevision(revision, original) {
  if (!revision) fail();
  const { revision_sha256, ...body } = revision;
  const before = revision.original, after = revision.current;
  if (revision.version !== VERSION || revision.source_account !== ACCOUNT || hash(body) !== revision_sha256
    || !validSource(before) || !validSource(after) || !positive(revision.source_appointment_id)
    || !sha(revision.live_evidence_sha256) || !String(revision.reviewed_by || '').trim()
    || !String(revision.reason || '').trim() || !Number.isFinite(Date.parse(revision.reviewed_at))
    || !Number.isFinite(Date.parse(revision.live_captured_at))
    || Date.parse(revision.reviewed_at) < Date.parse(revision.live_captured_at)
    || Date.parse(revision.reviewed_at) - Date.parse(revision.live_captured_at) > 3600000
    || ['source_contact_id', 'agenda_key', 'service_key', 'status'].some(key => before[key] !== after[key])
    || duration(before) !== duration(after) || note(before.details) !== note(after.details)
    || (before.start_local === after.start_local && before.end_local === after.end_local)
    || !sha(revision.provenance?.file_sha256) || !sha(revision.provenance?.row_sha256)
    || !positive(revision.provenance?.source_row) || !String(revision.provenance?.row_key || '').trim()) fail();
  if (original && (hash(pick(original)) !== hash(before) || hash(original.provenance) !== hash(revision.provenance)
    || (original.source_external_id && String(original.source_external_id) !== revision.source_appointment_id)
    || original.validation_errors?.length)) fail();
  return revision;
}
function prepareSourceRevision({ source, live, liveEvidenceSha256, sourceAppointmentId, reviewedBy, reason, now = Date.now() }) {
  if (source?.kind !== 'appointment' || live?.source_account !== ACCOUNT || !Array.isArray(live.rows)
    || !Number.isFinite(Date.parse(live.captured_at)) || Date.parse(live.captured_at) > now
    || now - Date.parse(live.captured_at) > 3600000 || !positive(sourceAppointmentId)) fail();
  const observed = live.rows.filter(row => String(row.appointment_id) === String(sourceAppointmentId));
  if (observed.length !== 1) fail();
  const convert = row => ({ source_contact_id: String(row.contact_id), start_local: String(row.start).replace(' ', 'T'),
    end_local: String(row.end).replace(' ', 'T'), agenda_key: norm(row.agenda), service_key: norm(row.service),
    status: Number(row.state) === 0 ? 'pendiente' : 'unsupported', details: String(row.details || '') });
  const current = convert(observed[0]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(live.coverage?.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(live.coverage?.end_exclusive || '')
    || [source.start_local, current.start_local].some(value => value < live.coverage.start || value >= live.coverage.end_exclusive)) fail();
  // Other visits with the same clinical signature (including a retained old
  // slot) prevent this narrow operator from asserting a unique reschedule.
  const candidates = live.rows.map(convert).filter(row => row.source_contact_id === source.source_contact_id
    && row.agenda_key === source.agenda_key && row.service_key === source.service_key
    && note(row.details) === note(source.details) && duration(row) === duration(source));
  if (candidates.length !== 1) fail();
  const body = { version: VERSION, source_account: ACCOUNT, source_appointment_id: String(sourceAppointmentId),
    original: pick(source), current, provenance: source.provenance, reviewed_by: reviewedBy, reason,
    reviewed_at: new Date(now).toISOString(), live_captured_at: live.captured_at, live_evidence_sha256: liveEvidenceSha256 };
  return validateSourceRevision({ ...body, revision_sha256: hash(body) }, source);
}
function revisedSource(source, revision) {
  validateSourceRevision(revision, source);
  return { ...source, ...revision.current, source_external_id: revision.source_appointment_id,
    start_utc: localToUtc(revision.current.start_local), end_utc: localToUtc(revision.current.end_local) };
}
function assertFreshRevision(revision, now) {
  validateSourceRevision(revision);
  if (now < Date.parse(revision.live_captured_at) || now - Date.parse(revision.live_captured_at) > 3600000) throw Error('SOURCE_REVISION_EVIDENCE_EXPIRED');
}
function validatedStoredRevision(row, metadata) {
  const revision = metadata.cliniccloud_source_revision;
  if (!revision) return null;
  validateSourceRevision(revision);
  if (row.source_system !== 'cliniccloud' || metadata.source_account !== ACCOUNT
    || metadata.source_contact_id !== revision.current.source_contact_id
    || metadata.source_appointment_id !== revision.source_appointment_id
    || hash(metadata.cliniccloud_delta?.provenance) !== hash(revision.provenance)
    || baselineKeys.some(key => metadata.cliniccloud_delta?.source?.[key] !== revision.current[key])) fail();
  return revision;
}
module.exports = { VERSION, prepareSourceRevision, validateSourceRevision, revisedSource, assertFreshRevision, validatedStoredRevision };

'use strict';

// Offline planner. No models, application bootstrap, SQL, transport or writes.
const { hash } = require('./adapter');
const { normalizeValues } = require('../treatmentPrograms.contract');
const VERSION = 'bs-client-program-replies/1';
const copy = value => JSON.parse(JSON.stringify(value));
const decode = (value, fallback = null) => value == null ? fallback : typeof value === 'string' ? JSON.parse(value) : copy(value);
const fail = code => { throw Error(code); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const SPECS = Object.freeze([
  { id: 22, public_id: 'fe4573b6-f929-4f43-a2a3-d829c2797c01', clinic_id: 72, reference: 'OBE-22', treatment_id: 2123, appointments: 3 },
  { id: 23, public_id: '7625aa65-b168-40a6-80a4-64db05e26325', clinic_id: 72, reference: 'OBE-23', treatment_id: 2103, appointments: 3 },
  { id: 24, public_id: '2a1ea357-f984-4e3f-bafa-17c439a24c28', clinic_id: 72, reference: 'OBE-24', treatment_id: 2105, appointments: 5 },
]);
// Stable identities of the earlier documentary imports. These are not a name
// matcher and do not permit changing their composition or clinical resources.
const ACTIVATION_SPECS = Object.freeze([
  { id: 1, public_id: '42ec9120-381e-4829-bd4d-ffa72fb556e9', clinic_id: 72, reference: 'COR-08' },
  { id: 2, public_id: '2fe11527-41df-4d72-bc06-892606a9cb60', clinic_id: 72, reference: 'COR-12' },
  { id: 11, public_id: 'e69d21d5-02bd-40c6-a90e-c1739cf9b48f', clinic_id: 72, reference: 'COR-05' },
  { id: 12, public_id: 'f742389e-7abc-477b-9c10-9ffd69dc27e1', clinic_id: 72, reference: 'COR-06' },
  { id: 13, public_id: 'ac2bf535-14db-48a0-9ff5-1bca964c9c10', clinic_id: 72, reference: 'COR-07' },
  { id: 25, public_id: '5efce208-defc-472e-ac23-85a5633b190b', clinic_id: 72, reference: 'OBE-27' },
  { id: 26, public_id: '14edb5eb-81c1-4c70-8ebc-543d1425e405', clinic_id: 72, reference: 'OBE-28' },
]);
const DEFERRALS = Object.freeze({
  6: 'CAP25_CALENDAR_MONTHS_AND_REVIEWS_IN_VISITS_3_6_REQUIRE_COMPOSITION_REVIEW_NOT_30_DAY_OFFSETS',
  7: 'CAPILLARY_INJECTABLE_INTERVAL_AND_INCLUDED_REVIEWS_REQUIRE_EXPLICIT_SCOPE_REVIEW',
  8: 'CAPILLARY_INJECTABLE_INTERVAL_AND_INCLUDED_REVIEWS_REQUIRE_EXPLICIT_SCOPE_REVIEW',
  9: 'CAPILLARY_INJECTABLE_INTERVAL_AND_INCLUDED_REVIEWS_REQUIRE_EXPLICIT_SCOPE_REVIEW',
  10: 'PRESERVE_CYJ_14_DAY_OFFSETS_REMAINING_INJECTABLES_AND_REVIEWS_REQUIRE_EXPLICIT_SCOPE_REVIEW',
  14: 'DOCUMENTED_VARIABLE_POSTOPERATIVE_FREQUENCY_NOT_AN_UNSPECIFIED_15_DAY_INTERVAL',
  15: 'DOCUMENTED_VARIABLE_POSTOPERATIVE_FREQUENCY_NOT_AN_UNSPECIFIED_15_DAY_INTERVAL',
  16: 'DOCUMENTED_LIPEDEMA_FREQUENCY_REQUIRES_INDIVIDUAL_CALENDAR',
  17: 'DOCUMENTED_LYMPHEDEMA_FREQUENCY_REQUIRES_INDIVIDUAL_CALENDAR',
  18: 'DOCUMENTED_LYMPHEDEMA_FREQUENCY_REQUIRES_INDIVIDUAL_CALENDAR',
  19: 'CONTORNO_DRAINAGE_TECHNIQUE_PHASE_TIMES_AND_MESOTHERAPY_DURATION_UNANSWERED',
  20: 'CONTORNO_DRAINAGE_TECHNIQUE_PHASE_TIMES_AND_MEDICAL_CONTROLS_UNANSWERED',
  21: 'CONTORNO_DRAINAGE_TECHNIQUE_PHASE_TIMES_AND_MEDICAL_CONTROLS_UNANSWERED',
  27: 'TWO_EXPLICIT_FREQUENCIES_INTERLEAVING_IS_NOT_A_15_DAY_SEQUENTIAL_PROGRAM',
  28: 'TWO_EXPLICIT_FREQUENCIES_INTERLEAVING_IS_NOT_A_15_DAY_SEQUENTIAL_PROGRAM',
});
function values(row) {
  return normalizeValues({ ...row, appointments: decode(row.appointments, []), cadence: decode(row.cadence), price_profile: decode(row.price_profile) });
}
function fillUnknownOffsets(appointments, interval = 15) {
  if (interval !== 15) fail('BS_REPLIES_ONLY_AUTHORIZED_15_DAY_DEFAULT');
  const result = copy(appointments);
  let previous = -1;
  for (let index = 0; index < result.length; index++) {
    const row = result[index];
    if (row.offset_days == null) row.offset_days = index === 0 ? 0 : previous + interval;
    if (!Number.isSafeInteger(row.offset_days) || row.offset_days < 0 || row.offset_days > 3650
        || (index === 0 && row.offset_days !== 0) || row.offset_days < previous) fail('BS_REPLIES_EXISTING_OFFSETS_CANNOT_BE_RECONCILED');
    previous = row.offset_days;
  }
  return result;
}
function assertSnapshot(snapshot) {
  if (snapshot?.target !== 'crm' || snapshot.group_id !== 29 || !Number.isFinite(Date.parse(snapshot.captured_at))
      || !Array.isArray(snapshot.programs) || snapshot.programs.length > 100
      || !Array.isArray(snapshot.clinics) || snapshot.clinics.length !== 2
      || ![66, 72].every(id => snapshot.clinics.some(row => Number(row.id_clinica) === id && Number(row.grupoClinicaId) === 29))
      || snapshot.programs.some(row => ![66, 72].includes(Number(row.clinic_id)))
      || new Set(snapshot.programs.map(row => Number(row.id))).size !== snapshot.programs.length
      || new Set(snapshot.programs.map(row => row.public_id)).size !== snapshot.programs.length) fail('BS_REPLIES_SNAPSHOT_SCOPE_INVALID');
}
function assertDecision(decision) {
  if (decision?.version !== 1 || decision.default_interval_days !== 15 || !sha(decision.workbook_sha256)
      || typeof decision.authority_reference !== 'string' || decision.authority_reference.trim().length < 10
      || !Number.isFinite(Date.parse(decision.authorized_at))
      || !Array.isArray(decision.activation_ids || [])
      || (decision.activation_ids || []).some(id => ![...SPECS, ...ACTIVATION_SPECS].some(spec => spec.id === id))
      || new Set(decision.activation_ids || []).size !== (decision.activation_ids || []).length) fail('BS_REPLIES_DECISION_INVALID');
}
function canonicalApiValues(item) {
  return normalizeValues({ ...item, appointments: item.appointments.map(({ key, label, treatment_ids, offset_days }) => ({ key, label, treatment_ids, offset_days })) });
}
function previewMatches(preview, after, clinicId) {
  return preview && Number(preview.clinic_id) === clinicId && preview.version === 0
    && hash(canonicalApiValues(preview)) === hash(after);
}
function buildPlan({ snapshot, decision, previews = [], createdAt = new Date().toISOString() }) {
  assertSnapshot(snapshot); assertDecision(decision);
  if (!Number.isFinite(Date.parse(createdAt))) fail('BS_REPLIES_PLAN_DATE_INVALID');
  const operations = [], assessments = [];
  for (const row of snapshot.programs) {
    const before = copy(row), normalized = values(row), datesSpec = SPECS.find(candidate => candidate.id === Number(row.id));
    const spec = datesSpec || ACTIVATION_SPECS.find(candidate => candidate.id === Number(row.id));
    const assessment = { program_id: Number(row.id), public_id: row.public_id, clinic_id: Number(row.clinic_id),
      name: row.name, version: Number(row.version_number), status: row.status, action: 'preserve', reason: null };
    assessments.push(assessment);
    if (!spec) {
      assessment.reason = DEFERRALS[row.id] || (normalized.cadence ? 'EXPLICIT_CADENCE_PRESERVED' : normalized.appointments.every(a => a.offset_days != null)
        ? 'EXPLICIT_OFFSETS_PRESERVED' : 'OUTSIDE_EXACT_REVIEWED_MAPPING');
      continue;
    }
    if (row.public_id !== spec.public_id || Number(row.clinic_id) !== spec.clinic_id || row.kind !== 'program'
        || !Number.isSafeInteger(Number(row.version_number)) || Number(row.version_number) < 1
        || (datesSpec && (normalized.appointments.length !== spec.appointments
          || normalized.appointments.some(a => a.treatment_ids.length !== 1 || a.treatment_ids[0] !== spec.treatment_id)))) fail('BS_REPLIES_REVIEWED_IDENTITY_OR_COMPOSITION_CHANGED');
    if (row.status === 'archived') { assessment.reason = 'ARCHIVED_PROGRAM_PRESERVED'; continue; }
    if (normalized.cadence && datesSpec) { assessment.reason = 'EXPLICIT_CADENCE_PRESERVED'; continue; }
    const after = copy(normalized);
    try { if (datesSpec) after.appointments = fillUnknownOffsets(after.appointments); }
    catch (error) { assessment.reason = error.message; continue; }
    if (!datesSpec && (!normalized.appointments.length || normalized.appointments.some(a => !a.treatment_ids.length)
        || (!normalized.cadence && normalized.appointments.some(a => a.offset_days == null)))) {
      assessment.reason = 'COMPOSITION_OR_EXPLICIT_FREQUENCY_NOT_COMPLETE'; continue;
    }
    const datesChanged = hash(after.appointments) !== hash(normalized.appointments);
    if (datesChanged) {
      after.notes = `${normalized.notes || ''}\n\nActualización operativa autorizada: separación propuesta de 15 días entre citas sin pauta explícita (${spec.reference}). Se conservan los intervalos escritos, el contenido y el precio del programa; no se modifica ninguna compra ni cita existente. Decisión ${decision.authorized_at.slice(0, 10)}; fuente SHA-256 ${decision.workbook_sha256}.`.trim();
    }
    let activation = false;
    const preview = previews.find(value => Number(value.program_id) === spec.id);
    if ((decision.activation_ids || []).includes(spec.id) && row.status === 'draft') {
      const proposed = { ...after, status: 'active' };
      // Must be a fresh canonical preview of this exact proposed definition.
      if (!previewMatches(preview?.item, proposed, spec.clinic_id)
          || preview.item.summary?.ready_for_activation !== true || preview.item.summary?.issues?.length !== 0
          || preview.item.commercial_ready !== true || preview.item.commercial_issues?.length !== 0) {
        assessment.activation_blocked = 'EXACT_CANONICAL_ACTIVE_PREVIEW_NOT_READY_OR_MISSING';
      } else { after.status = 'active'; activation = true; }
    }
    if (!datesChanged && !activation) { assessment.reason = normalized.cadence ? 'EXPLICIT_CADENCE_PRESERVED'
      : datesSpec ? 'NO_AUTHORIZED_CHANGE_REQUIRED' : 'EXPLICIT_OFFSETS_PRESERVED'; continue; }
    // Canonical normalization is mandatory; no accidental price/profile rewrite.
    const checked = normalizeValues(after);
    if (hash(checked) !== hash(after)) fail('BS_REPLIES_NONCANONICAL_PROPOSAL');
    for (const field of ['name', 'kind', 'total_price', 'price_profile', 'cadence']) {
      if (hash(normalized[field]) !== hash(after[field])) fail('BS_REPLIES_PROTECTED_PROGRAM_FIELD_CHANGED');
    }
    if (after.appointments.some((a, index) => hash({ ...a, offset_days: null }) !== hash({ ...normalized.appointments[index], offset_days: null })
        || (normalized.appointments[index].offset_days != null && a.offset_days !== normalized.appointments[index].offset_days))) fail('BS_REPLIES_COMPOSITION_OR_EXPLICIT_OFFSET_CHANGED');
    const payload = { ...after, expected_version: Number(row.version_number) };
    const operation = { program_id: spec.id, public_id: spec.public_id, clinic_id: spec.clinic_id, reference: spec.reference,
      before, before_sha256: hash(before), expected_version: Number(row.version_number), after, payload,
      payload_sha256: hash(payload), dates_changed: datesChanged, activation_requested: (decision.activation_ids || []).includes(spec.id),
      activation, canonical_preview: preview || null };
    operation.operation_sha256 = hash(operation); operations.push(operation);
    assessment.action = 'propose_update'; assessment.reason = datesChanged ? 'AUTHORIZED_DEFAULT_15_DAYS' : 'SEPARATE_EXPLICIT_ACTIVATION_WITH_EXISTING_PACE'; assessment.activation = activation;
  }
  const body = { version: VERSION, target: 'crm', group_id: 29, created_at: createdAt, snapshot_captured_at: snapshot.captured_at,
    snapshot_sha256: hash(snapshot), decision: copy(decision), operations, assessments,
    policy: { new_programs_created: false, treatments_changed: false, purchases_changed: false, appointments_changed: false,
      consent_documents_changed: false, messages_sent: false, application_bootstrapped: false,
      monthly_means_calendar_month_not_30_days: true, explicit_intervals_preserved: true,
      activation_requires_exact_canonical_preview: true, apply_requires_fresh_full_row_cas_and_canonical_api: true } };
  return { ...body, package_sha256: hash(body) };
}
function assertPlan(plan) {
  const { package_sha256, ...body } = plan || {};
  if (body.version !== VERSION || !sha(package_sha256) || hash(body) !== package_sha256) fail('BS_REPLIES_PACKAGE_CHANGED');
  assertDecision(body.decision);
  for (const operation of body.operations) {
    const { operation_sha256, ...record } = operation;
    if (hash(record) !== operation_sha256 || hash(record.before) !== record.before_sha256
        || hash(record.payload) !== record.payload_sha256 || record.payload.expected_version !== record.expected_version
        || ![...SPECS, ...ACTIVATION_SPECS].some(spec => spec.id === record.program_id && spec.public_id === record.public_id && spec.clinic_id === record.clinic_id)) fail('BS_REPLIES_OPERATION_CHANGED');
  }
}
function assessCurrent(operation, current) {
  if (!current || Number(current.id) !== operation.program_id || current.public_id !== operation.public_id
      || Number(current.clinic_id) !== operation.clinic_id) return 'conflict';
  if (hash(current) === operation.before_sha256) return 'pending';
  const immutable = row => Object.fromEntries(['id', 'public_id', 'clinic_id', 'request_key', 'request_payload_hash', 'created_by', 'created_at']
    .map(field => [field, row[field] ?? null]));
  if (Number(current.version_number) === operation.expected_version + 1 && hash(values(current)) === hash(operation.after)
      && hash(immutable(current)) === hash(immutable(operation.before))) return 'applied_requires_revision_verification';
  return 'conflict';
}
function verifyAppliedRevision(operation, current, revisions) {
  if (assessCurrent(operation, current) !== 'applied_requires_revision_verification') return false;
  const matches = revisions.filter(row => Number(row.program_id) === operation.program_id && Number(row.version_number) === operation.expected_version + 1);
  if (matches.length !== 1) return false;
  const revision = matches[0], recorded = decode(revision.snapshot);
  return Number.isSafeInteger(Number(revision.actor_id)) && Number(revision.actor_id) > 0
    && Number(current.updated_by) === Number(revision.actor_id)
    && recorded && recorded.public_id === operation.public_id && Number(recorded.id) === operation.program_id
    && Number(recorded.clinic_id) === operation.clinic_id && Number(recorded.version_number) === operation.expected_version + 1
    && Number(recorded.updated_by) === Number(revision.actor_id) && hash(values(recorded)) === hash(operation.after);
}
module.exports = { VERSION, SPECS, ACTIVATION_SPECS, DEFERRALS, values, fillUnknownOffsets, buildPlan, assertPlan, assessCurrent, verifyAppliedRevision, canonicalApiValues };

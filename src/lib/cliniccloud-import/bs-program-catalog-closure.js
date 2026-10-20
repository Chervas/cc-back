'use strict';

// Bounded, offline proposal for the explicit 20 October decision. This module
// does not bootstrap models, issue HTTP requests or apply catalogue changes.
// In particular, a tax answer must never silently invent clinical composition.
const { hash } = require('./adapter');
const { normalizeValues } = require('../treatmentPrograms.contract');
const previousReplies = require('./bs-client-program-replies');

const VERSION = 'bs-program-catalog-closure/20261020-1';
const MAX_SNAPSHOT_AGE_MS = 15 * 60 * 1000;
const PROFILE_21 = Object.freeze({ schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null });
const PROFILE_GLP1 = Object.freeze({ schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 0,
  exemption_reason: 'Revisiones médicas de seguimiento del tratamiento de la obesidad; exención confirmada expresamente por la clínica.' });
const SOURCE_CADENCE = Object.freeze({ provenance: 'literal_clinic_protocol', interval_days: 7,
  file: 'BS-Medical-Protocolos-V4-Obesidad.pdf',
  file_sha256: 'ec28b4ea7bdfcb204afd6af0b2e638f8db1f570e3dc743fc82cec25e0c768672' });
const SPECS = Object.freeze([
  Object.freeze({ id: 25, public_id: '5efce208-defc-472e-ac23-85a5633b190b', clinic_id: 72, reference: 'OBE-27',
    price_profile: PROFILE_21,
    source_cadence: Object.freeze({ ...SOURCE_CADENCE, pdf_pages: Object.freeze([29, 30]), literal: '6 citas, una por semana.' }),
    treatments: Object.freeze([2124, 2124, 2124, 2124, 2124, 2124]) }),
  Object.freeze({ id: 26, public_id: '14edb5eb-81c1-4c70-8ebc-543d1425e405', clinic_id: 72, reference: 'OBE-28',
    price_profile: PROFILE_21,
    source_cadence: Object.freeze({ ...SOURCE_CADENCE, pdf_pages: Object.freeze([31, 32]), literal: '8 citas alternando los dos tipos de sesión, una por semana.' }),
    treatments: Object.freeze([2124, 1967, 2124, 1967, 2124, 1967, 2124, 1967]) }),
  Object.freeze({ id: 22, public_id: 'fe4573b6-f929-4f43-a2a3-d829c2797c01', clinic_id: 72, reference: 'OBE-22',
    price_profile: PROFILE_GLP1, authority_flag: 'glp1_three_medical_reviews_no_vat',
    source_cadence: Object.freeze({ provenance: 'client_authorized_default_15_days', interval_days: 15,
      file: SOURCE_CADENCE.file, file_sha256: SOURCE_CADENCE.file_sha256, pdf_pages: Object.freeze([24]),
      literal: '3 sesiones de 30 min; seguimiento médico, incluida la receta de cada entrega.',
      cadence_authority: '15 October default interval retained; 20 October explicitly preserves the three-review offer without a pen.' }),
    treatments: Object.freeze([2123, 2123, 2123]) }),
]);
const BLOCKED = Object.freeze([
  ...[19, 20, 21].map(program_id => Object.freeze({ program_id, reason: 'CONTORNO_CARBOXYTHERAPY_HIFU_TIMING_UNRESOLVED',
    detail: '30 minutes of presotherapy, 10 of mesotherapy and 5 of preparation do not allocate the separately documented carboxytherapy, or HIFU in Continuidad. Do not omit or overlap techniques by inference.' })),
]);
const copy = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw Error(code); };
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;

function assertDecision(decision) {
  if (decision?.version !== 1 || decision.scope !== VERSION || decision.corporate_program_tax_percent !== 21
      || decision.default_interval_days !== 15 || !Number.isFinite(instant(decision.authorized_at))
      || typeof decision.authority_reference !== 'string' || decision.authority_reference.trim().length < 15
      || typeof decision.authority_text !== 'string' || decision.authority_text.trim().length < 30
      || (decision.glp1_three_medical_reviews_no_vat != null && decision.glp1_three_medical_reviews_no_vat !== true)
      || !Array.isArray(decision.activation_ids) || new Set(decision.activation_ids).size !== decision.activation_ids.length
      || decision.activation_ids.some(id => !SPECS.some(spec => spec.id === id))) fail('BS_CLOSURE_DECISION_INVALID');
  if (decision.activation_ids.includes(22) && decision.glp1_three_medical_reviews_no_vat !== true) fail('BS_CLOSURE_GLP1_EXPLICIT_AUTHORITY_REQUIRED');
  // The authority is this dated decision, not an older generic import approval.
  if (instant(decision.authorized_at) < Date.parse('2026-10-19T22:00:00Z')) fail('BS_CLOSURE_AUTHORITY_PREDATES_DECISION');
}

function assertSnapshot(snapshot, createdAt, authorizedAt) {
  const captured = instant(snapshot?.captured_at), created = instant(createdAt), authorized = instant(authorizedAt);
  if (snapshot?.target !== 'crm' || snapshot.group_id !== 29 || !Number.isFinite(captured) || !Number.isFinite(created)
      || captured > created || created - captured > MAX_SNAPSHOT_AGE_MS || authorized > captured
      || !Array.isArray(snapshot.clinics) || snapshot.clinics.length !== 2
      || ![66, 72].every(id => snapshot.clinics.some(clinic => Number(clinic.id_clinica) === id && Number(clinic.grupoClinicaId) === 29))
      || !Array.isArray(snapshot.programs) || snapshot.programs.length > 100
      || snapshot.programs.some(row => ![66, 72].includes(Number(row.clinic_id)))
      || new Set(snapshot.programs.map(row => Number(row.id))).size !== snapshot.programs.length
      || new Set(snapshot.programs.map(row => row.public_id)).size !== snapshot.programs.length) fail('BS_CLOSURE_SNAPSHOT_INVALID_OR_STALE');
}

function assertReviewedRow(row, spec, normalized) {
  if (row.public_id !== spec.public_id || Number(row.clinic_id) !== spec.clinic_id || row.kind !== 'program'
      || !Number.isSafeInteger(Number(row.version_number)) || Number(row.version_number) < 1
      || normalized.total_price == null || normalized.appointments.length !== spec.treatments.length
      || normalized.appointments.some((appointment, index) => appointment.treatment_ids.length !== 1
        || appointment.treatment_ids[0] !== spec.treatments[index])) fail('BS_CLOSURE_REVIEWED_IDENTITY_OR_COMPOSITION_CHANGED');
  if (normalized.price_profile && hash(normalized.price_profile) !== hash(spec.price_profile)) fail('BS_CLOSURE_EXISTING_FISCAL_PROFILE_REQUIRES_REVIEW');
  // Existing offset values or a generated note saying "weekly proposal" are not
  // proof of a clinical cadence. Here the exact PDF itself proves one per week;
  // an existing conflicting schedule needs review rather than being preserved
  // merely because the previous importer happened to populate it.
  if (normalized.appointments.some((appointment, index) => appointment.offset_days != null
        && appointment.offset_days !== index * spec.source_cadence.interval_days)
      || (normalized.cadence && (spec.id === 22 || normalized.cadence.sessions_per_week !== 1 || normalized.cadence.min_days_between !== 7))) {
    fail('BS_CLOSURE_EXISTING_CADENCE_CONFLICTS_WITH_LITERAL_SOURCE');
  }
}

function activePreviewMatches(preview, row, after, createdAt, capturedAt) {
  const checked = instant(preview?.checked_at), created = instant(createdAt);
  if (!preview || preview.program_id !== Number(row.id) || preview.expected_version !== Number(row.version_number)
      || preview.before_sha256 !== hash(row) || !Number.isFinite(checked) || checked < instant(capturedAt) || checked > created
      || created - checked > MAX_SNAPSHOT_AGE_MS || preview.item?.clinic_id !== Number(row.clinic_id)
      || preview.item.version !== 0 || preview.item.summary?.ready_for_activation !== true
      || !Array.isArray(preview.item.summary.issues) || preview.item.summary.issues.length !== 0
      || preview.item.commercial_ready !== true || !Array.isArray(preview.item.commercial_issues)
      || preview.item.commercial_issues.length !== 0) return false;
  try { return hash(previousReplies.canonicalApiValues(preview.item)) === hash({ ...after, status: 'active' }); }
  catch { return false; }
}

function assertProtectedFields(before, after, spec) {
  for (const field of ['name', 'kind', 'total_price', 'notes', 'cadence', 'appointments']) {
    if (hash(before[field]) !== hash(after[field])) fail('BS_CLOSURE_PROTECTED_FIELD_CHANGED');
  }
  if (hash(after.price_profile) !== hash(spec.price_profile) || ![before.status, 'active'].includes(after.status)) fail('BS_CLOSURE_UNAUTHORIZED_CHANGE');
}

function buildPlan({ snapshot, decision, previews = [], createdAt = new Date().toISOString() }) {
  assertDecision(decision); assertSnapshot(snapshot, createdAt, decision.authorized_at);
  if (!Array.isArray(previews) || previews.length > SPECS.length
      || previews.some(preview => !SPECS.some(spec => spec.id === preview.program_id && (!spec.authority_flag || decision[spec.authority_flag] === true)))
      || new Set(previews.map(preview => preview.program_id)).size !== previews.length) fail('BS_CLOSURE_PREVIEWS_INVALID');
  const operations = [], assessments = [];
  for (const row of snapshot.programs) {
    const blocked = BLOCKED.find(item => item.program_id === Number(row.id));
    const spec = SPECS.find(item => item.id === Number(row.id));
    const assessment = { program_id: Number(row.id), public_id: row.public_id, clinic_id: Number(row.clinic_id),
      name: row.name, version: Number(row.version_number), status: row.status, action: 'preserve',
      reason: blocked?.reason || 'OUTSIDE_EXACT_REVIEWED_CLOSURE' };
    assessments.push(assessment);
    if (!spec) continue;
    if (spec.authority_flag && decision[spec.authority_flag] !== true) { assessment.reason = 'GLP1_EXPLICIT_AUTHORITY_NOT_RECORDED'; continue; }
    const before = copy(row), normalized = previousReplies.values(row);
    assertReviewedRow(row, spec, normalized);
    if (row.status === 'archived') { assessment.reason = 'ARCHIVED_PROGRAM_PRESERVED'; continue; }
    const after = { ...copy(normalized), price_profile: copy(spec.price_profile) };
    const preview = previews.find(item => item.program_id === spec.id);
    const activationRequested = decision.activation_ids.includes(spec.id) && row.status === 'draft';
    let activation = false;
    if (activationRequested) {
      if (activePreviewMatches(preview, row, after, createdAt, snapshot.captured_at)) { after.status = 'active'; activation = true; }
      else assessment.activation_blocked = 'FRESH_EXACT_CANONICAL_ACTIVE_PREVIEW_NOT_READY_OR_MISSING';
    }
    assertProtectedFields(normalized, after, spec);
    if (hash(normalizeValues(after)) !== hash(after)) fail('BS_CLOSURE_NONCANONICAL_PROPOSAL');
    const fiscalChanged = hash(normalized.price_profile) !== hash(after.price_profile);
    if (!fiscalChanged && !activation) { assessment.reason = 'NO_AUTHORIZED_CHANGE_REQUIRED'; continue; }
    const payload = { ...copy(after), expected_version: Number(row.version_number) };
    const operation = { program_id: spec.id, public_id: spec.public_id, clinic_id: spec.clinic_id, reference: spec.reference,
      before, before_sha256: hash(before), expected_version: Number(row.version_number), after, payload, payload_sha256: hash(payload),
      fiscal_changed: fiscalChanged, dates_changed: false, activation_requested: activationRequested, activation,
      source_cadence: copy(spec.source_cadence), authority_sha256: hash(decision.authority_text), canonical_preview: activation ? copy(preview) : null };
    operation.operation_sha256 = hash(operation); operations.push(operation);
    assessment.action = 'propose_update'; assessment.reason = fiscalChanged ? spec.id === 22 ? 'EXPLICIT_GLP1_MEDICAL_REVIEWS_NO_VAT' : 'EXPLICIT_PROGRAM_TOTAL_21_PERCENT' : 'EXPLICIT_REVIEWED_ACTIVATION';
    assessment.activation = activation;
  }
  const body = { version: VERSION, target: 'crm', group_id: 29, created_at: createdAt, snapshot_captured_at: snapshot.captured_at,
    snapshot_sha256: hash(snapshot), decision: copy(decision), authority_sha256: hash(decision.authority_text), operations, assessments,
    decisions: { resolved: [
      { key: 'PROGRAM_TOTAL_TAX_PERCENT', program_ids: [25, 26], value: 21 },
      ...(decision.glp1_three_medical_reviews_no_vat === true ? [{ key: 'GLP1_EXISTING_THREE_MEDICAL_REVIEWS_NO_VAT', program_ids: [22],
        value: copy(PROFILE_GLP1), pen_included: false, composition_changed: false }] : []),
      { key: 'DEFAULT_INTERVAL_DAYS', value: 15, applied: false,
        reason: 'The exact clinic protocol literally specifies one visit per week for both reviewed programmes, independently of importer proposals or stored offsets.',
        source_cadences: SPECS.filter(spec => spec.id !== 22).map(spec => ({ program_id: spec.id, ...copy(spec.source_cadence) })) },
    ], blocked: copy(BLOCKED) },
    policy: { offline_plan_only: true, application_bootstrapped: false, default_interval_applied: false,
      new_programs_created: false, treatments_changed: false, purchases_changed: false, appointments_changed: false,
      clinical_composition_changed: false, notes_changed: false, explicit_intervals_preserved: true,
      marketing_or_consent_permissions_changed: false, hold_changed: false, messages_sent: false,
      apply_requires_fresh_full_row_cas_and_canonical_api: true, activation_requires_fresh_exact_canonical_preview: true } };
  return { ...body, package_sha256: hash(body) };
}

function assertPlan(plan) {
  const { package_sha256, ...body } = plan || {};
  if (body.version !== VERSION || hash(body) !== package_sha256) fail('BS_CLOSURE_PACKAGE_CHANGED');
  assertDecision(body.decision);
  if (body.authority_sha256 !== hash(body.decision.authority_text) || !Array.isArray(body.operations)) fail('BS_CLOSURE_AUTHORITY_CHANGED');
  for (const operation of body.operations) {
    const { operation_sha256, ...record } = operation;
    const spec = SPECS.find(item => item.id === record.program_id);
    if (!spec || hash(record) !== operation_sha256 || hash(record.before) !== record.before_sha256
        || record.public_id !== spec.public_id || record.clinic_id !== spec.clinic_id
        || hash(record.source_cadence) !== hash(spec.source_cadence)
        || record.authority_sha256 !== body.authority_sha256 || record.expected_version !== Number(record.before.version_number)
        || hash(record.payload) !== record.payload_sha256 || record.payload.expected_version !== record.expected_version
        || hash(normalizeValues(record.payload)) !== hash(record.after)) fail('BS_CLOSURE_OPERATION_CHANGED');
    const before = previousReplies.values(record.before);
    if (spec.authority_flag && body.decision[spec.authority_flag] !== true) fail('BS_CLOSURE_GLP1_EXPLICIT_AUTHORITY_REQUIRED');
    assertReviewedRow(record.before, spec, before); assertProtectedFields(before, record.after, spec);
    if (record.activation && (!body.decision.activation_ids.includes(record.program_id) || record.before.status !== 'draft'
        || record.after.status !== 'active' || !activePreviewMatches(record.canonical_preview, record.before,
          record.after, body.created_at, body.snapshot_captured_at))) fail('BS_CLOSURE_ACTIVATION_NOT_VERIFIED');
    if (!record.activation && record.after.status !== before.status) fail('BS_CLOSURE_ACTIVATION_NOT_VERIFIED');
  }
}

module.exports = { VERSION, MAX_SNAPSHOT_AGE_MS, PROFILE_21, PROFILE_GLP1, SPECS, BLOCKED, buildPlan, assertPlan,
  // Reuse the established full-row CAS and immutable-revision checks. Callers
  // must assertPlan before any future applying workflow; this module has none.
  assessCurrent: previousReplies.assessCurrent, verifyAppliedRevision: previousReplies.verifyAppliedRevision };

'use strict';

// Offline, one-row proposal. This module neither connects to a database nor
// installs/executes an operator. The ordinary treatment PATCH has no atomic
// compare-and-swap: its URL below describes the payload, not a concurrency proof.
const { hash } = require('./adapter');
const { mergeClinicalConfig, applyImportedPriceReview } = require('../treatment-catalog-contract');
const { normalizeBookingProfile } = require('../booking-profile');

const VERSION = 'bs-contorno-cor43-closure/20261020-1';
const TREATMENT_ID = 2122;
const CLINIC_ID = 72;
const GROUP_ID = 29;
const CODE = 'BS26-COR43-PROGRAM';
const NAME = 'Cyclone + EXION · sesión de programa (COR-43)';
const GROSS_AMOUNT = 145;
const MAX_AGE_MS = 15 * 60 * 1000;
const PROFILE = Object.freeze({ schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null });
const SOURCES = Object.freeze({
  'BS-Medical-Protocolos-V1-Corporal (2) - copia.pdf': '5361917f6de9b68d52c18befcde09789fbeb674b7bbb2ec78c2aed27aa7000fc',
  'Tarifa-2026-Corporal.pdf': '57137efdbc73c6aacc03e817165e0a984dbf72b8bffd8c6120b2c0914d7a6068',
});
const SOURCE_PLAN_SHA256 = 'd64747fe37a06934b4a5aa2f55b5063b7c4506ff666cfc7b8a012f1af3ffe3c4';
const SOURCE = Object.freeze({ protocol: 'COR-43', programme_code: 'COR-05', pdf_pages: Object.freeze([10, 11, 32]),
  price_pdf_page: 32, standalone_gross_amount: GROSS_AMOUNT, currency: 'EUR', minutes: 45,
  literal: 'La misma cita comprada suelta es COR-43, 145 €.',
  not_cor42: 'COR-42 is the separate complete 75-minute / 180 EUR session.',
  programme_days: Object.freeze([0, 7, 14, 21, 28, 35, 42, 49]),
  programme_minutes: Object.freeze([45, 55, 45, 45, 55, 45, 45, 55]) });
const fail = code => { throw Object.assign(new Error(code), { code }); };
const copy = value => JSON.parse(JSON.stringify(value));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (left, right) => hash(left ?? null) === hash(right ?? null);
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z') ? Date.parse(value) : NaN;
function row(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('COR43_ROW_INVALID');
  const result = copy(value?.toJSON ? value.toJSON() : value);
  if (typeof result?.clinical_config === 'string') {
    try { result.clinical_config = JSON.parse(result.clinical_config); } catch { fail('COR43_CONFIG_INVALID'); }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !result.clinical_config || typeof result.clinical_config !== 'object' || Array.isArray(result.clinical_config)) fail('COR43_ROW_INVALID');
  return result;
}

function expectedProfile() {
  return normalizeBookingProfile({ version: 2, phases: [
    { key: 'phase_1', label: 'Preparación y Cyclone', duration_minutes: 35, installation_ids: [85],
      professionals: { mode: 'any', ids: [221], preferred_id: 221 }, equipment_requirements: [{ equipment_ids: [10] }] },
    { key: 'phase_2', label: 'EXION y registro, sin cambio de cabina', duration_minutes: 10, installation_ids: [85],
      professionals: { mode: 'any', ids: [221], preferred_id: 221 }, equipment_requirements: [{ equipment_ids: [4] }] },
  ] });
}

function assertReviewedIdentity(before) {
  const config = before.clinical_config, variant = config.source_program_variant;
  if (Number(before.id_tratamiento) !== TREATMENT_ID || Number(before.clinica_id) !== CLINIC_ID
    || before.origen !== 'clinica' || before.grupo_clinica_id != null || before.codigo !== CODE || before.nombre !== NAME
    || Number(before.duracion_min) !== 45 || Number(before.sesiones_defecto) !== 1
    || config.import_batch !== 'cliniccloud-contorno-program-variant/1'
    || variant?.version !== 1 || variant.protocol !== SOURCE.protocol || variant.documentary_gross_price !== GROSS_AMOUNT
    || !same(variant.program_codes, ['COR-05']) || !same(variant.pdf_pages, SOURCE.pdf_pages)
    || !same(variant.source_hashes, SOURCES) || variant.plan_sha256 !== SOURCE_PLAN_SHA256
    || variant.effective_date !== '2026-10-01'
    || config.source_price?.mode !== 'unresolved' || config.source_price.currency !== 'EUR' || config.source_price.includes_tax !== true
    || hash(normalizeBookingProfile(config.booking_profile)) !== hash(expectedProfile())) fail('COR43_EXACT_DOCUMENTARY_IDENTITY_CHANGED');
  if (Number(before.activo) !== 0 || config.catalog_status !== 'draft' || before.precio_base !== null
    || config.fiscal_mapping_pending !== true || config.imported_price_review != null || config.price_profile != null
    || config.commercial?.sale_mode && config.commercial.sale_mode !== 'standalone') fail('COR43_EXISTING_COMMERCIAL_REVIEW_REQUIRES_REPLAN');
}

function assertInput(snapshot, decision, evidence, createdAt) {
  const created = instant(createdAt), captured = instant(snapshot?.captured_at), authorized = instant(decision?.authorized_at);
  if (!Number.isFinite(created) || !Number.isFinite(captured) || created < captured || created - captured > MAX_AGE_MS
    || snapshot.target !== 'crm' || snapshot.group_id !== GROUP_ID || snapshot.clinic_id !== CLINIC_ID
    || !sha(snapshot.configuration_sha256)) fail('COR43_SNAPSHOT_INVALID_OR_STALE');
  if (decision?.version !== 1 || decision.scope !== VERSION || decision.gross_amount !== GROSS_AMOUNT || decision.tax_percent !== 21
    || !Number.isSafeInteger(decision.actor_id) || decision.actor_id < 1 || typeof decision.activate !== 'boolean'
    || !Number.isFinite(authorized) || authorized > captured || authorized < Date.parse('2026-10-19T22:00:00Z')
    || typeof decision.authority_reference !== 'string' || decision.authority_reference.trim().length < 15
    || typeof decision.authority_text !== 'string' || decision.authority_text.trim().length < 30) fail('COR43_EXPLICIT_AUTHORITY_REQUIRED');
  if (evidence?.version !== 1 || evidence.protocol !== 'COR-43' || evidence.price_pdf_page !== SOURCE.price_pdf_page
    || evidence.standalone_gross_amount !== GROSS_AMOUNT || evidence.currency !== 'EUR'
    || !same(evidence.source_hashes, SOURCES) || evidence.extracted_source_verified !== true
    || !Number.isFinite(instant(evidence.checked_at)) || instant(evidence.checked_at) > created
    || created - instant(evidence.checked_at) > MAX_AGE_MS) fail('COR43_EXACT_PRICE_SOURCE_REQUIRED');
}

function canonicalCandidate(before, decision, at, activate) {
  const patch = { catalog_status: activate ? 'active' : 'draft', price_profile: copy(PROFILE) };
  const config = applyImportedPriceReview(before.clinical_config,
    mergeClinicalConfig(before.clinical_config, patch), {
      confirm: true, amount: GROSS_AMOUNT, actorId: decision.actor_id, now: new Date(at),
    });
  return { ...copy(before), precio_base: GROSS_AMOUNT, activo: activate, clinical_config: config };
}

function activationValidated(proof, { snapshot, before, candidate, createdAt }) {
  return proof?.validator === 'validateCatalogResources' && proof.ok === true && Array.isArray(proof.issues) && proof.issues.length === 0
    && proof.treatment_id === TREATMENT_ID && proof.clinic_id === CLINIC_ID && proof.before_sha256 === hash(before)
    && proof.candidate_sha256 === hash(candidate) && proof.configuration_sha256 === snapshot.configuration_sha256
    && Number.isFinite(instant(proof.checked_at)) && instant(proof.checked_at) >= instant(snapshot.captured_at)
    && instant(proof.checked_at) <= instant(createdAt) && instant(createdAt) - instant(proof.checked_at) <= MAX_AGE_MS;
}

function buildPlan({ snapshot, decision, sourceEvidence, canonicalValidation = null, createdAt = new Date().toISOString(), reviewedAt = createdAt }) {
  assertInput(snapshot, decision, sourceEvidence, createdAt);
  if (!Number.isFinite(instant(reviewedAt)) || instant(reviewedAt) < instant(snapshot.captured_at)
    || instant(reviewedAt) > instant(createdAt)) fail('COR43_REVIEW_CLOCK_INVALID');
  const before = row(snapshot.treatment); assertReviewedIdentity(before);
  const activationCandidate = canonicalCandidate(before, decision, reviewedAt, true);
  const activation = decision.activate && activationValidated(canonicalValidation, { snapshot, before, candidate: activationCandidate, createdAt });
  const after = activation ? activationCandidate : canonicalCandidate(before, decision, reviewedAt, false);
  const payload = { precio_base: GROSS_AMOUNT, confirm_imported_price: true, activo: activation,
    clinical_config: { catalog_status: activation ? 'active' : 'draft', price_profile: copy(PROFILE) } };
  const body = {
    version: VERSION, target: 'crm', clinic_id: CLINIC_ID, group_id: GROUP_ID, treatment_id: TREATMENT_ID,
    created_at: createdAt, reviewed_at: reviewedAt, snapshot: { ...copy(snapshot), treatment: before }, decision: copy(decision), source_evidence: copy(sourceEvidence),
    source: { ...copy(SOURCE), source_hashes: copy(SOURCES) },
    before, before_sha256: hash(before), configuration_sha256: snapshot.configuration_sha256,
    activation_candidate: activationCandidate, activation_candidate_sha256: hash(activationCandidate),
    after, after_sha256: hash(after), payload, payload_sha256: hash(payload),
    canonical_validation: canonicalValidation == null ? null : copy(canonicalValidation), activation,
    activation_blocked: decision.activate && !activation ? 'FRESH_EXACT_CANONICAL_VALIDATION_REQUIRED' : null,
    write_contract: { method: 'PATCH', path: `/api/tratamientos/${TREATMENT_ID}`, endpoint_has_atomic_cas: false,
      application_mode: 'scoped_operator_transaction_required', require_transaction: true, require_row_lock: true,
      require_full_row_before_sha256: true, require_fresh_configuration_sha256: true, require_exactly_one_updated_row: true,
      canonical_helpers: ['mergeClinicalConfig', 'applyImportedPriceReview', 'validateCatalogResources'],
      audit_timestamp: reviewedAt, actor_id: decision.actor_id },
    policy: { one_treatment_only: true, no_new_treatment: true, preserve_source: true, preserve_profile: true,
      preserve_room_permissions: true, preserve_codes_badges_notes: true, programmes_changed: false,
      purchases_changed: false, appointments_changed: false, documents_changed: false, reminders_activated: false,
      source_clinical_approval_unchanged: true, source_qualification_unchanged: true },
  };
  return { ...body, plan_sha256: hash(body) };
}

function assertPlan(plan) {
  const expected = buildPlan({ snapshot: plan?.snapshot, decision: plan?.decision, sourceEvidence: plan?.source_evidence,
    canonicalValidation: plan?.canonical_validation, createdAt: plan?.created_at, reviewedAt: plan?.reviewed_at });
  if (hash(plan) !== hash(expected)) fail('COR43_PLAN_CHANGED');
  return true;
}

function assertPrecondition(plan, current, { configurationSha256, now = new Date().toISOString() } = {}) {
  assertPlan(plan);
  if (!Number.isFinite(instant(now)) || instant(now) < instant(plan.created_at) || instant(now) - instant(plan.created_at) > MAX_AGE_MS
    || configurationSha256 !== plan.configuration_sha256 || hash(row(current)) !== plan.before_sha256) fail('COR43_FULL_ROW_OR_CONFIGURATION_CHANGED');
  return true;
}

function verifyAfter(plan, value, { now = new Date().toISOString() } = {}) {
  assertPlan(plan);
  const current = row(value), expected = copy(plan.after);
  if (Number(current.precio_base) !== GROSS_AMOUNT || Number(current.activo) !== Number(plan.activation)
    || hash(current.clinical_config) !== hash(expected.clinical_config)
    || !Number.isFinite(instant(now))) fail('COR43_POSTCONDITION_MISMATCH');
  // DECIMAL/boolean wire encodings may differ; every other full-row field is
  // exact except the SQL-managed update clock. No source note/profile is erased.
  expected.precio_base = current.precio_base; expected.activo = current.activo;
  if (Object.hasOwn(current, 'updatedAt')) {
    const updated = current.updatedAt instanceof Date ? +current.updatedAt : Date.parse(current.updatedAt);
    // Existing MySQL updatedAt columns may store whole seconds. Accept that
    // exact precision loss, never a clock from an earlier whole second.
    const earliestStoredClock = Math.floor(instant(plan.created_at) / 1000) * 1000;
    if (!Number.isFinite(updated) || updated < earliestStoredClock || updated > instant(now)) fail('COR43_POSTCONDITION_CLOCK_INVALID');
    expected.updatedAt = current.updatedAt;
  }
  if (hash(current) !== hash(expected)) fail('COR43_UNRELATED_FIELD_CHANGED');
  return true;
}

module.exports = { VERSION, TREATMENT_ID, CLINIC_ID, GROUP_ID, CODE, NAME, GROSS_AMOUNT, MAX_AGE_MS,
  PROFILE, SOURCES, SOURCE_PLAN_SHA256, SOURCE, expectedProfile, buildPlan, assertPlan, assertPrecondition, verifyAfter };

'use strict';

// Explicit documentary associations only. No fuzzy matching, publication,
// clinical approval, patient consent or change to the imported treatment.
const { hash } = require('./adapter');
const { verifyPlan } = require('./catalog-drafts');
const VERSION = 'cliniccloud-catalog-consent-links/1';
const fail = code => { throw Error(code); };
const plain = value => typeof value === 'string' ? JSON.parse(value) : value;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const textOf = html => String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const fields = ['tratamiento_id', 'clinica_id', 'clinic_template_id', 'catalog_template_id',
  'requirement_scope', 'condition_key', 'required', 'blocking_policy', 'sort_order'];
const requirementValue = row => Object.fromEntries(fields.map(key => [key,
  key === 'required' ? Number(row[key]) : row[key]]));
const keyOf = row => `${row.tratamiento_id}:${row.clinic_template_id}`;

function prepareConsentLinks({ plan, review, before, createdAt = new Date().toISOString() }) {
  verifyPlan(plan);
  if (review?.version !== 1 || review.plan_sha256 !== plan.plan_sha256
    || review.scope !== 'inactive_draft_documentary_associations'
    || !Array.isArray(review.bindings) || !review.bindings.length || review.bindings.length > 150) {
    fail('CONSENT_LINK_REVIEW_INVALID');
  }
  if (before.clinics.length !== 2 || ![66,72].every(id => before.clinics.some(c =>
    Number(c.id_clinica) === id && Number(c.grupo_clinica_id) === 29))) fail('CONSENT_LINK_GROUP_CHANGED');
  if (!Array.isArray(before.appointments) || before.appointments.length) fail('CONSENT_LINK_DRAFT_ALREADY_USED');
  const desired = [], seen = new Set();
  for (const binding of review.bindings) {
    const sources = plan.rows.filter(row => row.kind === 'treatment' && row.source_catalog_key === binding.source_catalog_key);
    if (sources.length !== 1) fail('CONSENT_LINK_SOURCE_NOT_UNIQUE');
    const source = sources[0];
    const matches = before.treatments.filter(t => t.codigo === source.proposed_code);
    if (matches.length !== 1) fail('CONSENT_LINK_TREATMENT_NOT_UNIQUE');
    const treatment = matches[0], config = plain(treatment.clinical_config);
    if (Number(treatment.activo) !== 0 || config?.catalog_status !== 'draft'
      || Number(treatment.clinica_id) !== source.clinic_id || treatment.nombre !== source.display_name
      || config.source_catalog_key !== source.source_catalog_key
      || hash(config.source_catalog) !== hash(source.provenance)) fail('CONSENT_LINK_DRAFT_CHANGED');
    if (!sha(binding.treatment_sha256) || hash(treatment) !== binding.treatment_sha256) fail('CONSENT_LINK_TREATMENT_REVIEW_STALE');
    const template = before.templates.find(t => t.id === binding.clinic_template_id);
    if (!template || template.clinic_id !== source.clinic_id || template.purpose !== 'clinical'
      || template.status !== 'active' || /^DEMO\b/i.test(template.name)
      || !['hard','soft','optional'].includes(template.blocking_policy)) fail('CONSENT_LINK_TEMPLATE_SCOPE_INVALID');
    if (!sha(binding.template_sha256) || hash(template) !== binding.template_sha256) fail('CONSENT_LINK_TEMPLATE_REVIEW_STALE');
    const versions = before.versions.filter(v => v.clinic_template_id === template.id)
      .sort((a,b) => b.version - a.version || b.id - a.id);
    const version = versions[0];
    // Match the existing consumer's latest-version rule, not an older published
    // version hidden behind a newer draft or another language.
    if (!version || version.status !== 'published' || version.locale !== 'es'
      || !textOf(version.body_html) || version.id !== binding.version_id
      || hash(version) !== binding.version_sha256) fail('CONSENT_LINK_VERSION_REVIEW_STALE');
    if (typeof binding.reason !== 'string' || binding.reason.trim().length < 30
      || typeof binding.source_quote !== 'string' || binding.source_quote.length < 4
      || ![source.category, source.name, source.detail].join(' ').includes(binding.source_quote)
      || typeof binding.document_quote !== 'string' || binding.document_quote.length < 20
      || !textOf(version.body_html).includes(binding.document_quote)) fail('CONSENT_LINK_PROCEDURE_EVIDENCE_REQUIRED');
    const row = { tratamiento_id: treatment.id_tratamiento, clinica_id: source.clinic_id,
      clinic_template_id: template.id, catalog_template_id: null, requirement_scope: 'treatment',
      condition_key: null, required: 1, blocking_policy: template.blocking_policy,
      sort_order: desired.filter(r => r.tratamiento_id === treatment.id_tratamiento).length };
    if (seen.has(keyOf(row))) fail('CONSENT_LINK_DUPLICATE_BINDING');
    seen.add(keyOf(row)); desired.push(row);
  }
  const ids = [...new Set(desired.map(r => r.tratamiento_id))];
  if (ids.length > 75 || before.treatments.length !== ids.length) fail('CONSENT_LINK_TREATMENT_SCOPE_MISMATCH');
  const preserved = [], operations = [];
  for (const old of before.requirements) {
    const expected = desired.find(r => keyOf(r) === keyOf(old));
    if (!expected || hash(requirementValue(old)) !== hash(expected)) fail('CONSENT_LINK_EXISTING_REQUIREMENTS_REQUIRE_REVIEW');
    if (preserved.includes(keyOf(old))) fail('CONSENT_LINK_EXISTING_DUPLICATE');
    preserved.push(keyOf(old));
  }
  for (const row of desired) if (!preserved.includes(keyOf(row))) operations.push(row);
  const body = { version: VERSION, target: 'crm', group_id: 29, created_at: createdAt,
    plan_sha256: plan.plan_sha256, review, review_sha256: hash(review), before,
    before_sha256: hash(before), desired, operations, preserved,
    policy: { inactive_drafts_only: true, append_only: true, templates_and_versions_unchanged: true,
      treatments_unchanged: true, patient_consents_created: false, clinical_approval: false,
      prices_changed: false, appointments_changed: false, reminders_activated: false } };
  return { ...body, package_sha256: hash(body) };
}
function verifyConsentLinks(pkg, plan) {
  const expected = prepareConsentLinks({ plan, review: pkg.review, before: pkg.before, createdAt: pkg.created_at });
  if (hash(expected) !== hash(pkg)) fail('CONSENT_LINK_PACKAGE_CHANGED');
}
function verifyLinkedState(after, pkg) {
  if (hash({ ...after, requirements: pkg.before.requirements }) !== pkg.before_sha256) fail('CONSENT_LINK_UNRELATED_CHANGE');
  if (after.requirements.length !== pkg.desired.length) fail('CONSENT_LINK_AFTER_COUNT');
  for (const expected of pkg.desired) {
    const rows = after.requirements.filter(row => keyOf(row) === keyOf(expected));
    if (rows.length !== 1 || hash(requirementValue(rows[0])) !== hash(expected)) fail('CONSENT_LINK_AFTER_MISMATCH');
  }
  for (const old of pkg.before.requirements) {
    const current = after.requirements.find(row => row.id === old.id);
    if (!current || hash(current) !== hash(old)) fail('CONSENT_LINK_EXISTING_CHANGED');
  }
  return true;
}
module.exports = { VERSION, prepareConsentLinks, verifyConsentLinks, verifyLinkedState, requirementValue, textOf };

'use strict';
// Fill missing, documentary booking profiles in unchanged imported drafts.
// Never activates catalogue/rooms, sets prices, changes programs or appointments.
const { hash } = require('./adapter');
const { verifyPlan, treatmentDraft, BATCH } = require('./catalog-drafts');
const VERSION = 'cliniccloud-catalog-resource-refresh/1';
const fail = code => { throw Error(code); };
const configOf = row => typeof row.clinical_config === 'string' ? JSON.parse(row.clinical_config) : row.clinical_config;
const canonicalRow = row => ({ ...row, clinical_config: configOf(row) });

function unchangedImport(row, initial) {
  const original = initial.operations.find(op => op.values.codigo === row.codigo);
  if (original) {
    const expected = { ...original.values, clinical_config: { ...original.values.clinical_config,
      catalog_import_package: initial.package_sha256 } };
    const current = canonicalRow(row);
    return hash(expected) === hash(Object.fromEntries(Object.keys(expected).map(key => [key, current[key]])));
  }
  const originalRow = initial.before.treatments.find(t => t.id_tratamiento === row.id_tratamiento && t.codigo === row.codigo);
  return !!originalRow && hash(canonicalRow(originalRow)) === hash(canonicalRow(row));
}

function prepareResourceRefresh({ plan, initial, before, createdAt = new Date().toISOString() }) {
  verifyPlan(plan);
  const { package_sha256, ...initialBody } = initial;
  if (hash(initialBody) !== package_sha256 || initial.version !== 'cliniccloud-catalog-drafts/1'
    || initial.target !== 'crm' || initial.group_id !== 29 || initial.workbook_sha256 !== plan.workbook_sha256
    || initial.replies_sha256 !== plan.replies_sha256) fail('CATALOG_REFRESH_BASELINE_INVALID');
  const operations = [], preserved = [], deferred = [];
  for (const source of plan.rows.filter(row => row.kind === 'treatment')) {
    const found = before.treatments.filter(row => row.codigo === source.proposed_code);
    if (found.length !== 1) fail('CATALOG_REFRESH_SOURCE_NOT_UNIQUE');
    const row = canonicalRow(found[0]), current = row.clinical_config, next = treatmentDraft(source).clinical_config;
    if (row.clinica_id !== source.clinic_id || !current?.source_catalog
      || hash(current.source_catalog) !== hash(source.provenance)) fail('CATALOG_REFRESH_SOURCE_CHANGED');
    if (!next.booking_profile || current.booking_profile) { preserved.push(row.id_tratamiento); continue; }
    if (Number(row.activo) !== 0 || current.catalog_status !== 'draft' || current.fiscal_mapping_pending !== true
      || ![BATCH, 'cliniccloud-program-examples-20260914'].includes(current.import_batch)
      || !unchangedImport(row, initial)) { deferred.push({ id: row.id_tratamiento, reason: 'DRAFT_CHANGED_REVIEW_REQUIRED' }); continue; }
    // Missing duration, ambiguous rooms and unvalidated clinical roles have no
    // generated profile. Retain all unrelated config/source/economic fields.
    const afterConfig = { ...current, booking_profile: next.booking_profile, import_issues: next.import_issues };
    operations.push({ id: row.id_tratamiento, before: row, before_sha256: hash(row), after_config: afterConfig,
      source_catalog_key: source.source_catalog_key });
  }
  if (operations.length > 30) fail('CATALOG_REFRESH_BATCH_LIMIT');
  const body = { version: VERSION, target: 'crm', group_id: 29, created_at: createdAt,
    plan_sha256: plan.plan_sha256, initial_package_sha256: initial.package_sha256,
    before_sha256: hash(before), before, operations, preserved, deferred,
    policy: { inactive_drafts_only: true, columns: ['clinical_config', 'updatedAt'],
      prices_changed: false, rooms_activated: false, appointments_changed: false, reminders_activated: false } };
  return { ...body, package_sha256: hash(body) };
}
function verifyResourceRefresh(pkg, inputs) {
  const expected = prepareResourceRefresh({ ...inputs, before: pkg.before, createdAt: pkg.created_at });
  if (hash(pkg) !== hash(expected)) fail('CATALOG_REFRESH_PACKAGE_CHANGED');
}
function refreshedConfig(op, pkg) {
  return { ...op.after_config, source_resource_assignment: { version: 1, package_sha256: pkg.package_sha256,
    plan_sha256: pkg.plan_sha256, previous_profile: null, prepared_at: pkg.created_at } };
}
function isResourceRefreshReplay(row, op, pkg) {
  const current = canonicalRow(row);
  if (hash(current.clinical_config) !== hash(refreshedConfig(op, pkg))) return false;
  return hash({ ...current, clinical_config: op.before.clinical_config, updatedAt: op.before.updatedAt }) === op.before_sha256;
}
module.exports = { VERSION, canonicalRow, prepareResourceRefresh, verifyResourceRefresh, refreshedConfig, isResourceRefreshReplay };

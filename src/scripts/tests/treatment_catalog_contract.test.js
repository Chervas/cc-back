'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeClinicalConfig, assertCatalogEditable, catalogState } = require('../../lib/treatment-catalog-contract');
const profile = { version: 1, phases: [{ key: 'main', label: 'Tratamiento', duration_minutes: 30, installation_ids: [7], professionals: { mode: 'any', ids: [12], preferred_id: null } }] };

test('import price review is explicit, preserves source and records only the authenticated actor', () => {
  const { applyImportedPriceReview } = require('../../lib/treatment-catalog-contract');
  const price = { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null };
  const previous = { catalog_status: 'draft', fiscal_mapping_pending: true, source_price: { mode: 'fixed', gross_amount: 145 }, source_catalog: { row: 3 } };
  const next = mergeClinicalConfig(previous, { fiscal_mapping_pending: false, source_price: null, source_catalog: { row: 999 }, imported_price_review: { reviewed_by: 999 }, price_profile: price });
  assert.equal(next.fiscal_mapping_pending, true); assert.equal(next.imported_price_review, undefined);
  assert.deepEqual(next.source_price, previous.source_price); assert.deepEqual(next.source_catalog, previous.source_catalog);
  assert.equal(applyImportedPriceReview(previous, next, { confirm: false }), next);
  const reviewed = applyImportedPriceReview(previous, next, { confirm: true, amount: 150, actorId: 7, now: new Date('2026-09-21T00:00:00Z') });
  assert.equal(reviewed.fiscal_mapping_pending, false); assert.equal(reviewed.catalog_status, 'draft');
  assert.equal(reviewed.imported_price_review.reviewed_by, 7); assert.equal(reviewed.imported_price_review.gross_amount, 150);
  assert.deepEqual(reviewed.source_price, previous.source_price); assert.equal(previous.fiscal_mapping_pending, true);
  assert.deepEqual(mergeClinicalConfig(reviewed, { imported_price_review: null, fiscal_mapping_pending: true }).imported_price_review, reviewed.imported_price_review);
  assert.throws(() => applyImportedPriceReview(reviewed, reviewed, { confirm: true }), { code: 'imported_price_not_pending' });
  assert.throws(() => applyImportedPriceReview(reviewed, { ...reviewed, price_profile: null }, { confirm: false }), { code: 'imported_price_profile_required' });
  assert.throws(() => applyImportedPriceReview(reviewed, reviewed, { amount: null }), { code: 'imported_price_amount_invalid' });
  assert.equal(applyImportedPriceReview(reviewed, reviewed), reviewed);
});

test('review rejects implicit, unclassified, missing, rounded or unauthenticated prices; explicit free/exempt is valid', () => {
  const { applyImportedPriceReview } = require('../../lib/treatment-catalog-contract');
  const previous = { fiscal_mapping_pending: true };
  const next = { ...previous, price_profile: { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 0, exemption_reason: 'Motivo ficticio validado' } };
  for (const amount of [null, undefined, '', '145', NaN, Infinity, -1, 1.001, 100000000]) {
    assert.throws(() => applyImportedPriceReview(previous, next, { confirm: true, amount, actorId: 1 }), { code: 'imported_price_amount_invalid' });
  }
  assert.throws(() => applyImportedPriceReview(previous, next, { confirm: 'true' }), { code: 'imported_price_confirmation_invalid' });
  assert.throws(() => applyImportedPriceReview(previous, previous, { confirm: true, amount: 145, actorId: 1 }), { code: 'imported_price_profile_required' });
  assert.throws(() => applyImportedPriceReview(previous, next, { confirm: true, amount: 145 }), { code: 'imported_price_actor_required' });
  assert.equal(applyImportedPriceReview(previous, next, { confirm: true, amount: 0, actorId: 1 }).imported_price_review.gross_amount, 0);
});

test('precio bruto importado no aparece gratis ni se convierte en base fiscal', async () => {
  const { catalogDto } = require('../../lib/treatment-catalog-contract');
  const input = { precio_base: null, clinical_config: { catalog_status: 'draft', fiscal_mapping_pending: true, source_price: { mode: 'fixed', gross_amount: 120 } } };
  const dto = catalogDto(input); assert.equal(dto.precio_base, null); assert.equal(dto.catalog_price.amount, 120); assert.equal(dto.catalog_price.review_required, true);
  assert.equal(catalogDto({ precio_base: 95 }).catalog_price.amount, 95);
  const { validateCatalogResources } = require('../../lib/treatment-catalog-resources');
  await validateCatalogResources(input, {});
  await assert.rejects(validateCatalogResources({ ...input, clinical_config: { ...input.clinical_config, catalog_status: 'active' } }, {}), { code: 'imported_treatment_fiscal_review_pending' });
});

test('editar un campo conserva perfil, procedencia y claves desconocidas', () => {
  const before = { booking_profile: profile, import_source: { batch: 'test' }, unknown: { stable: true } };
  const next = mergeClinicalConfig(before, { financing: { enabled: true } });
  assert.equal(next.booking_profile.phases[0].professionals.preferred_id, 12);
  assert.deepEqual(next.import_source, before.import_source);
  assert.deepEqual(next.unknown, before.unknown);
  assert.equal(before.booking_profile.phases[0].professionals.preferred_id, null);
  assert.deepEqual(mergeClinicalConfig(before, null).import_source, before.import_source);
});
test('null explícito elimina solo la clave indicada', () => {
  assert.deepEqual(mergeClinicalConfig({ financing: { enabled: true }, unknown: 1 }, { financing: null }), { unknown: 1 });
});
test('un borrador guarda configuración incompleta sin declararse reservable', () => {
  const config = mergeClinicalConfig(null, { catalog_status: 'draft', booking_profile: { version: 1, phases: [{ key: 'main', duration_minutes: null, installation_ids: [], professionals: { mode: 'any', ids: [], preferred_id: null } }] } });
  assert.equal(catalogState({ activo: false, clinical_config: config }).booking_ready, false);
  assert.throws(() => mergeClinicalConfig(config, { catalog_status: 'active' }));
});
test('obsoleto se conserva pero es ineditable; estado desconocido se rechaza', () => {
  const obsolete = { activo: false, clinical_config: { catalog_status: 'obsolete' } };
  assert.throws(() => assertCatalogEditable(obsolete), { code: 'treatment_obsolete', status: 409 });
  assert.deepEqual(catalogState(obsolete), { status: 'obsolete', editable: false, booking_ready: false, booking_issues: ['obsolete'] });
  assert.throws(() => mergeClinicalConfig(null, { catalog_status: 'invented' }));
});
test('varios alternativos exigen prioritario; ALL no equivale a ANY', () => {
  const multiple = JSON.parse(JSON.stringify(profile));
  multiple.phases[0].professionals.ids = [12, 13];
  assert.throws(() => mergeClinicalConfig(null, { booking_profile: multiple }));
  multiple.phases[0].professionals.mode = 'all';
  const config = mergeClinicalConfig(null, { booking_profile: multiple });
  assert.equal(catalogState({ activo: true, clinical_config: config }).booking_ready, false);
});

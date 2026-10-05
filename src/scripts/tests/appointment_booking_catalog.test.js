'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { mergeClinicalConfig, catalogDto } = require('../../lib/treatment-catalog-contract');
const { individualBookingEligible } = require('../../lib/appointment-booking-catalog');
const base = { activo: true, nombre: 'Nombre original', clinical_config: { catalog_status: 'active' } };
const options = { capabilities: { simple: true, multi: true } };
test('editable neutral label round-trips without renaming, activating or overwriting other config', () => {
  const previous = { catalog_status: 'draft', unknown: { keep: true } };
  const config = mergeClinicalConfig(previous, { catalog_badge: ' Antiguo ' });
  assert.equal(config.catalog_badge, 'Antiguo'); assert.equal(config.catalog_status, 'draft'); assert.deepEqual(config.unknown, previous.unknown);
  const dto = catalogDto({ ...base, clinical_config: config }); assert.equal(dto.nombre, base.nombre); assert.equal(dto.clinical_config.catalog_badge, 'Antiguo');
  assert.equal(mergeClinicalConfig(config, {}).catalog_badge, 'Antiguo');
  assert.equal(mergeClinicalConfig(config, { catalog_badge: null }).catalog_badge, undefined);
  assert.equal(mergeClinicalConfig(config, { catalog_badge: ' ' }).catalog_badge, undefined);
  for (const value of [false, {}, [], 'a'.repeat(33), 'a\nb']) assert.throws(() => mergeClinicalConfig(null, { catalog_badge: value }), { code: 'invalid_catalog_badge' });
});
test('bookable old labelled individuals retain their full original name and are not guessed from badge', () => {
  assert.equal(individualBookingEligible({ ...base, clinical_config: { catalog_badge: 'Antiguo' } }, 72, options), true);
  assert.equal(individualBookingEligible(base, 72, options), true);
  for (const status of ['draft', 'obsolete', 'historical_reference']) assert.equal(individualBookingEligible({ ...base, clinical_config: { catalog_status: status } }, 72, options), false);
  for (const sale_mode of ['program_component_only', 'historical_reference']) assert.equal(individualBookingEligible({ ...base, clinical_config: { commercial: { sale_mode } } }, 72, options), false);
  assert.equal(individualBookingEligible({ ...base, activo: false }, 72, options), false);
  assert.equal(individualBookingEligible({ ...base, eliminado_por_clinica: '[72]' }, 72, options), false);
  assert.equal(individualBookingEligible({ ...base, eliminado_por_clinica: [71] }, 72, options), true);
  for (const product_type of ['voucher', 'pack', 'program']) assert.equal(individualBookingEligible({ ...base, clinical_config: { product_type } }, 72, options), false);
  assert.equal(individualBookingEligible({ ...base, nombre: 'Bono presoterapia' }, 72, options), false);
});
test('incomplete or runtime-disabled booking profiles cannot become bookable by adding a label', () => {
  const profile = { version: 1, phases: [{ key: 'main', duration_minutes: 30, installation_ids: [3], professionals: { mode: 'any', ids: [7], preferred_id: 7 } }] };
  const row = { ...base, clinical_config: { catalog_badge: 'Antiguo', booking_profile: profile } };
  assert.equal(individualBookingEligible(row, 72, options), true);
  assert.equal(individualBookingEligible(row, 72, { capabilities: { simple: false, multi: false } }), false);
  assert.equal(individualBookingEligible({ ...base, clinical_config: { booking_profile: { version: 1, phases: [] } } }, 72, options), false);
});

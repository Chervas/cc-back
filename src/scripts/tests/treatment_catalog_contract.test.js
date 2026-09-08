'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeClinicalConfig, assertCatalogEditable, catalogState } = require('../../lib/treatment-catalog-contract');
const profile = { version: 1, phases: [{ key: 'main', label: 'Tratamiento', duration_minutes: 30, installation_ids: [7], professionals: { mode: 'any', ids: [12], preferred_id: null } }] };

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

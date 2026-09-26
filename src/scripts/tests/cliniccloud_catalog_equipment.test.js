'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { prepareCatalogEquipment, verifyCatalogEquipment, equipmentConfig, equipmentReplay } = require('../../lib/cliniccloud-import/catalog-equipment');
function fixture() {
  const source = { file_sha256: 'a'.repeat(64), row_sha256: 'b'.repeat(64), source_row: 5, sheet: 'Synthetic' };
  const profile = { version: 1, phases: [{ key: 'one', label: 'Synthetic', duration_minutes: 30,
    installation_ids: [81], professionals: { ids: [221], mode: 'any', preferred_id: 221 } }] };
  return { createdAt: '2026-09-22T23:00:00.000Z', before: {
    treatments: [{ id_tratamiento: 100, clinica_id: 72, grupo_clinica_id: null, nombre: 'Synthetic EXION', activo: 0,
      duracion_min: 30, precio_base: null, updatedAt: '2026-09-21 10:00:00', clinical_config: {
        import_batch: 'cliniccloud-bs-catalog-individuals-20260921', catalog_status: 'draft', product_type: 'treatment',
        source_catalog: source, booking_profile: profile, fiscal_mapping_pending: true,
        source_price: { gross_amount: 90 }, import_issues: ['INSTALLATION_INACTIVE', 'OTHER_PENDING_REVIEW'] } }],
    clinics: [{ id_clinica: 72, grupoClinicaId: 29, equipment_booking_enabled: 1 }],
    units: [{ id: 4, family_key: 'exion', group_id: 29, owner_clinic_id: 72, mobility: 'mobile', status: 'available', revision: 1 }],
    shares: [{ equipment_id: 4, clinic_id: 72 }],
    rooms: [{ id: 81, clinica_id: 72, activo: 1, capacidad: 1 }], aliases: [],
    policies: [{ installation_id: 81, mode: 'selected', equipment_ids: '[4]' }],
  }, review: { confirmation_reference: 'Synthetic explicit confirmation', confirmed_on: '2026-09-22', reviewed_by: 'Synthetic operator',
    targets: [{ treatment_id: 100, equipment_id: 4, family_key: 'exion', source_catalog_sha256: hash(source) }] } };
}
test('only adds a required machine to the unchanged draft profile and removes the disproved inactive-room issue', () => {
  const f = fixture(), original = structuredClone(f), pkg = prepareCatalogEquipment(f), op = pkg.operations[0];
  const c = equipmentConfig(op, pkg);
  assert.deepEqual(f, original); assert.equal(pkg.operations.length, 1);
  assert.equal(c.booking_profile.version, 2);
  assert.deepEqual(c.booking_profile.phases[0].equipment_requirements, [{ equipment_ids: [4] }]);
  const { equipment_requirements, ...phase } = c.booking_profile.phases[0];
  assert.deepEqual(phase, f.before.treatments[0].clinical_config.booking_profile.phases[0]);
  assert.deepEqual(c.import_issues, ['OTHER_PENDING_REVIEW']);
  assert.equal(c.fiscal_mapping_pending, true); assert.deepEqual(c.source_price, { gross_amount: 90 });
  assert.equal(c.catalog_status, 'draft'); assert.equal(c.source_equipment_assignment.activation, false);
  assert.equal(c.source_equipment_assignment.existing_reservations_reconciled, false);
  verifyCatalogEquipment(pkg, f.review);
});
test('cannot activate treatments, change price or discard later edits on replay', () => {
  const f = fixture(), pkg = prepareCatalogEquipment(f), op = pkg.operations[0];
  const row = { ...op.before, updatedAt: '2026-09-22 23:00:00', clinical_config: equipmentConfig(op, pkg) };
  assert(equipmentReplay(row, op, pkg));
  assert(equipmentReplay({ ...row, clinical_config: JSON.stringify(row.clinical_config) }, op, pkg));
  for (const patch of [{ activo: 1 }, { precio_base: '0.00' }, { nombre: 'Edited' }, { clinical_config: { ...row.clinical_config, clinician_note: 'New note' } }]) {
    assert.equal(equipmentReplay({ ...row, ...patch }, op, pkg), false);
  }
});
test('rejects unreviewed scope, unsupported technique and incomplete or changed drafts', () => {
  const changes = [f => { f.review.confirmation_reference = ''; }, f => { f.review.targets.push(f.review.targets[0]); },
    f => { f.review.targets[0].source_catalog_sha256 = 'c'.repeat(64); },
    f => { f.before.treatments[0].clinica_id = 99; }, f => { f.before.treatments[0].grupo_clinica_id = 29; },
    f => { f.before.treatments[0].activo = 1; }, f => { f.before.treatments[0].clinical_config.catalog_status = 'active'; },
    f => { f.before.treatments[0].clinical_config.import_batch = 'other'; },
    f => { f.before.treatments[0].clinical_config.product_type = 'program'; },
    f => { f.before.treatments[0].clinical_config.source_equipment_assignment = {}; },
    f => { f.before.treatments[0].clinical_config.booking_profile.phases[0].duration_minutes = 45; },
    f => { f.before.treatments[0].clinical_config.booking_profile.phases[0].professionals.ids = []; },
    f => { f.before.treatments[0].clinical_config.booking_profile.version = 2; },
    f => { f.before.treatments[0].clinical_config.booking_profile.phases.push({ ...f.before.treatments[0].clinical_config.booking_profile.phases[0], key: 'two' }); },
    f => { f.before.treatments[0].clinical_config.booking_profile.phases[0].installation_ids.push(82); }];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => prepareCatalogEquipment(f)); }
});
test('checks opt-in, equipment identity and scope, mobility, state and actual room policy', () => {
  const changes = [f => { f.before.clinics[0].equipment_booking_enabled = 0; },
    f => { f.before.clinics[0].grupoClinicaId = 5; }, f => { f.before.units[0].family_key = 'emshape'; },
    f => { f.before.units[0].family_key = f.review.targets[0].family_key = 'btl_shockwave'; },
    f => { f.before.units[0].group_id = 5; }, f => { f.before.units[0].status = 'maintenance'; },
    f => { f.before.units[0].mobility = 'fixed'; }, f => { f.before.shares = []; },
    f => { f.before.units.push(f.before.units[0]); }, f => { f.before.rooms[0].activo = 0; },
    f => { f.before.rooms[0].capacidad = 2; }, f => { f.before.rooms[0].clinica_id = 66; },
    f => { f.before.policies = []; }, f => { f.before.policies[0].mode = 'none'; },
    f => { f.before.policies[0].equipment_ids = '[5]'; }];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => prepareCatalogEquipment(f)); }
});
test('uses canonical room policy when a logical installation is a physical alias', () => {
  const f = fixture(); f.before.aliases = [{ installation_id: 81, canonical_installation_id: 80 }];
  assert.throws(() => prepareCatalogEquipment(f));
  f.before.policies[0].installation_id = 80;
  assert.equal(prepareCatalogEquipment(f).operations.length, 1);
});
test('modified packages and reviews cannot be applied', () => {
  const f = fixture(), pkg = prepareCatalogEquipment(f);
  pkg.operations[0].after_config.booking_profile.phases[0].equipment_requirements[0].equipment_ids = [5];
  assert.throws(() => verifyCatalogEquipment(pkg, f.review));
  const fresh = prepareCatalogEquipment(f); f.review.reviewed_by = 'other';
  assert.throws(() => verifyCatalogEquipment(fresh, f.review));
});

function fixedFixture() {
  const f = fixture();
  Object.assign(f.before.units[0], { family_key: 'cyclone', mobility: 'fixed', home_installation_id: 81 });
  f.review.targets[0].family_key = 'cyclone';
  f.before.policies[0] = { installation_id: 81, mode: 'none', equipment_ids: [] };
  return f;
}
test('reviewed Cyclone draft uses its fixed unit even when the room disallows mobile equipment', () => {
  const f = fixedFixture(), pkg = prepareCatalogEquipment(f);
  assert.deepEqual(pkg.operations[0].after_config.booking_profile.phases[0].equipment_requirements, [{ equipment_ids: [4] }]);
  assert.equal(pkg.operations[0].after_config.source_equipment_assignment.family_key, 'cyclone');
  assert.equal(pkg.operations[0].after_config.catalog_status, 'draft');
  verifyCatalogEquipment(pkg, f.review);
});
test('a fixed unit cannot follow a treatment into another room, even when mobile policy allows all', () => {
  const f = fixedFixture();
  f.before.rooms.push({ id: 82, clinica_id: 72, activo: 1, capacidad: 1 });
  f.before.units[0].home_installation_id = 82;
  f.before.policies[0] = { installation_id: 81, mode: 'all', equipment_ids: [] };
  assert.throws(() => prepareCatalogEquipment(f));
});
test('logical treatment room may alias a fixed unit home without duplicating that unit', () => {
  const f = fixedFixture();
  f.before.rooms.push({ id: 80, clinica_id: 72, activo: 1, capacidad: 1 });
  f.before.units[0].home_installation_id = 80;
  f.before.aliases.push({ installation_id: 81, canonical_installation_id: 80, group_id: 29 });
  f.before.policies[0].installation_id = 80;
  assert.equal(prepareCatalogEquipment(f).operations.length, 1);
});
test('fixed preparation rejects missing, inactive, noncanonical or foreign homes and unreviewed families', () => {
  const changes = [f => { f.before.units[0].home_installation_id = null; },
    f => { f.before.units[0].home_installation_id = 999; }, f => { f.before.rooms[0].activo = 0; },
    f => { f.before.rooms[0].clinica_id = 66; }, f => { f.before.rooms[0].capacidad = 2; },
    f => { f.before.aliases = [{ installation_id: 81, canonical_installation_id: 80 }]; },
    f => { f.before.units[0].mobility = 'mobile'; },
    f => { f.before.units[0].family_key = f.review.targets[0].family_key = 'carboxytherapy'; }];
  for (const change of changes) { const f = fixedFixture(); change(f); assert.throws(() => prepareCatalogEquipment(f)); }
});

function ledFixture() {
  const f = fixedFixture();
  const row = f.before.treatments[0], cfg = row.clinical_config;
  row.clinica_id = 66; row.duracion_min = 10;
  cfg.source_cabin = '2'; cfg.source_catalog.sheet = 'Capilar · sesiones y bonos'; cfg.source_catalog.source_row = 43;
  cfg.booking_profile.phases[0].installation_ids = [75]; cfg.booking_profile.phases[0].duration_minutes = 10;
  Object.assign(f.before.units[0], { family_key: 'capillary_led', home_installation_id: 75, owner_clinic_id: 66 });
  f.before.clinics[0].id_clinica = 66; f.before.shares[0].clinic_id = 66;
  Object.assign(f.before.rooms[0], { id: 75, clinica_id: 66 }); f.before.policies[0].installation_id = 75;
  f.review.confirmed_on = '2026-09-25'; f.review.targets[0].family_key = 'capillary_led';
  f.review.targets[0].source_catalog_sha256 = hash(cfg.source_catalog);
  return f;
}
test('confirmed capillary LED belongs to Capilar and augments only its existing draft C2 phase', () => {
  const f = ledFixture(), before = structuredClone(f), pkg = prepareCatalogEquipment(f), cfg = pkg.operations[0].after_config;
  assert.deepEqual(f, before);
  assert.equal(cfg.booking_profile.phases.length, 1);
  assert.deepEqual(cfg.booking_profile.phases[0].equipment_requirements, [{ equipment_ids: [4] }]);
  assert.equal(cfg.booking_profile.phases[0].duration_minutes, 10);
  assert.equal(cfg.catalog_status, 'draft'); assert.equal(cfg.fiscal_mapping_pending, true);
  assert.deepEqual(cfg.import_issues, ['OTHER_PENDING_REVIEW']);
  assert.deepEqual(cfg.source_price, before.before.treatments[0].clinical_config.source_price);
  assert.deepEqual(cfg.booking_profile.phases[0].professionals, before.before.treatments[0].clinical_config.booking_profile.phases[0].professionals);
  verifyCatalogEquipment(pkg, f.review);
});
test('LED binding rejects other acts, another owner/home or the older machine confirmation', () => {
  for (const change of [f => { f.before.treatments[0].clinica_id = 72; },
    f => { f.before.treatments[0].clinical_config.source_catalog.source_row = 24; },
    f => { f.before.treatments[0].clinical_config.source_catalog.sheet = 'Facial · tratamientos'; },
    f => { f.before.treatments[0].clinical_config.source_cabin = '7'; },
    f => { f.before.treatments[0].duracion_min = f.before.treatments[0].clinical_config.booking_profile.phases[0].duration_minutes = 30; },
    f => { f.before.units[0].owner_clinic_id = 72; }, f => { f.before.units[0].home_installation_id = 80; },
    f => { f.before.units[0].mobility = 'mobile'; }, f => { f.review.confirmed_on = '2026-09-22'; }]) {
    const f = ledFixture(); change(f);
    f.review.targets[0].source_catalog_sha256 = hash(f.before.treatments[0].clinical_config.source_catalog);
    assert.throws(() => prepareCatalogEquipment(f));
  }
});
test('C2 LED confirmation cannot approve EXION, EMShape or Cyclone instead', () => {
  for (const family of ['exion', 'emshape', 'cyclone']) {
    const f = family === 'cyclone' ? fixedFixture() : fixture();
    f.before.units[0].family_key = f.review.targets[0].family_key = family;
    f.review.confirmed_on = '2026-09-25';
    assert.throws(() => prepareCatalogEquipment(f));
  }
});

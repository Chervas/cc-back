'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bsEquipmentBlueprint: plan } = require('../../lib/cliniccloud-import/bs-equipment-blueprint');
const { normalizeEquipmentUnit, equipmentFitsRoom } = require('../../lib/booking-equipment');

test('BS inventory preserves one unit per family and the three confirmed mobile aliases', () => {
  const units = [...plan.mobile_equipment, ...plan.fixed_equipment];
  assert.equal(plan.units_per_equipment, 1);
  assert.equal(new Set(units.map(u => u.family_key)).size, units.length);
  assert.deepEqual(plan.mobile_equipment.map(u => u.family_key), ['exion', 'emshape', 'btl_shockwave']);
  assert(plan.mobile_equipment.find(u => u.family_key === 'emshape').aliases.includes('EMS'));
  assert(plan.mobile_equipment.find(u => u.family_key === 'btl_shockwave').aliases.includes('Ondas acústicas BTL'));
});

test('only the three documented fixed locations are prepared, without guessing INDIBA models', () => {
  assert.deepEqual(plan.fixed_equipment.map(u => [u.family_key, u.home_room]), [
    ['cyclone', 'C11'], ['btl_lymphastim', 'C9'], ['carboxytherapy', 'C10'],
  ]);
  assert(!plan.fixed_equipment.some(u => /indiba|hifu_facial/i.test(u.family_key)));
  assert(plan.pending.some(s => s.includes('INDIBA')));
});

for (const unit of plan.fixed_equipment) {
  test(`${unit.family_key}: fixed room works even when mobile equipment is forbidden`, () => {
    const value = normalizeEquipmentUnit({ ...unit, status: 'available', home_installation_id: 90 });
    assert.equal(value.mobility, 'fixed');
    const resource = { ...value, fixed_resource_key: 'installation:90' };
    assert.equal(equipmentFitsRoom(resource, { resource_key: 'installation:90', equipment_policy: { mode: 'none', equipment_ids: [] } }), true);
    assert.equal(equipmentFitsRoom(resource, { resource_key: 'installation:91', equipment_policy: { mode: 'all', equipment_ids: [] } }), false);
  });
}

test('preparing fixed units does not lift mobile exclusions, include hospital or enable reminders', () => {
  assert.deepEqual(plan.mobile_prohibited_rooms, ['C9', 'C10']);
  assert.equal(plan.external_hospital_included, false);
  assert.equal(plan.reminders_enabled, false);
});

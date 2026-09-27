'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareAreaContracts } = require('../../lib/medical-area-adoption-review');
const { getBaseContractForArea } = require('../../lib/medical-area-contracts');

test('unchanged revisions are not clinical changes and additions do not rewrite existing values', () => {
  const before = getBaseContractForArea('nutricion');
  const after = structuredClone(before);
  after.revision = { id: 5 }; before.revision = { id: 1 };
  assert.deepEqual(compareAreaContracts(before, after).changes, []);
  after.profile.defaultDuration = 70;
  const review = compareAreaContracts(before, after);
  assert.equal(review.compatible, true); assert.equal(review.changes[0].key, 'profile');
  assert.equal(before.profile.defaultDuration, 45);
});

test('measurement removal and unit changes are blocked even when a future publisher accepts them', () => {
  const before = getBaseContractForArea('nutricion');
  for (const change of [a => delete a.nutrition_measurement_fields.weight_kg,
    a => a.nutrition_measurement_fields.weight_kg.unit = 'lb',
    a => a.nutrition_measurement_profile_schemas = [],
    a => a.nutrition_measurement_profile_options = [],
    a => a.nutrition_service_kind_options = []]) {
    const after = structuredClone(before); change(after);
    assert.equal(compareAreaContracts(before, after).compatible, false);
  }
});

test('removing dental capabilities or applications cannot strand existing treatments', () => {
  const before = getBaseContractForArea('dental');
  for (const change of [a => a.profile.supportsPiece = false,
    a => a.profile.supportsLaboratory = false, a => a.profile.applicationOptions = []]) {
    const after = structuredClone(before); change(after);
    assert.equal(compareAreaContracts(before, after).compatible, false);
  }
});

test('existing clinical entrypoints cannot disappear or move on a generic adoption', () => {
  const before = getBaseContractForArea('nutricion');
  for (const key of ['patient_workspace', 'appointment_action']) {
    assert(before[key].enabled);
    for (const change of [a => a[key].enabled = false, a => a[key].route = 'different-route']) {
      const after = structuredClone(before); change(after);
      assert.equal(compareAreaContracts(before, after).compatible, false);
    }
  }
});

test('unknown changed fields require an explicit compatibility policy, not blind acceptance', () => {
  const before = getBaseContractForArea('general');
  const after = { ...before, futureClinicalCalculator: { formula: 'unknown' } };
  assert.equal(compareAreaContracts(before, after).compatible, false);
  assert.equal(compareAreaContracts(null, before).compatible, true);
});

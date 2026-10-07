'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { prpLedRecipe, indibaPrpRecipe, sharedPreparationRecipe, bookingProfileDurationMinutes } = require('../../lib/bs-operational-recipes');
const resources = { doctorId: 1, applicationDoctorId: 2, extractionRoomId: 101, applicationRoomId: 102, ledId: 15, indibaRoomId: 103, indibaId: 14 };
test('PRP includes LED within the documented thirty minutes and preserves both professionals and rooms', () => {
  const profile = prpLedRecipe(resources);
  assert.equal(bookingProfileDurationMinutes(profile), 30);
  assert.deepEqual(profile.phases.map(p => [p.duration_minutes, p.start_offset_minutes, p.installation_ids[0], p.professionals.ids[0]]), [[13, 0, 101, 1], [17, 13, 102, 2]]);
  assert.deepEqual(profile.phases[1].equipment_requirements, [{ equipment_ids: [15] }]);
});
test('INDIBA capilar plus PRP is one fifty-minute visit with three physical projections, not a programme', () => {
  const profile = indibaPrpRecipe(resources);
  assert.equal(bookingProfileDurationMinutes(profile), 50);
  assert.deepEqual(profile.phases.map(p => p.start_offset_minutes), [0, 20, 33]);
  assert.deepEqual(profile.phases.map(p => p.professionals.ids[0]), [2, 1, 2]);
  assert.deepEqual(profile.phases.map(p => p.installation_ids[0]), [103, 101, 102]);
});
test('invalid or missing resources never turn into a machine-free, single-doctor visit', () => {
  for (const key of Object.keys(resources)) {
    const changed = { ...resources, [key]: null };
    assert.throws(() => indibaPrpRecipe(changed));
  }
});
test('confirmed shared preparation preserves machine and patient duration; INDIBA stays continuously attended', () => {
  const base = { version: 2, phases: [{ key: 'one', label: 'INDIBA', duration_minutes: 45,
    installation_ids: [103], professionals: { mode: 'any', ids: [2], preferred_id: 2 }, equipment_requirements: [{ equipment_ids: [14] }] }] };
  const before = JSON.stringify(base), profile = sharedPreparationRecipe(base, { continuousAfterPreparation: true });
  assert.equal(JSON.stringify(base), before); assert.equal(bookingProfileDurationMinutes(profile), 45);
  assert.equal(profile.phases[0].staff_attention[0].mode, 'start_continuous');
  assert.deepEqual(profile.phases[0].preparation_sharing, { mode: 'same_start' });
  assert.deepEqual(profile.phases[0].equipment_requirements, base.phases[0].equipment_requirements);
  assert.equal(sharedPreparationRecipe(base).phases[0].staff_attention[0].mode, 'start_only');
});
test('sharing cannot accidentally convert a multi-step treatment or mandatory team into one preparation', () => {
  assert.throws(() => sharedPreparationRecipe(prpLedRecipe(resources)));
  assert.throws(() => sharedPreparationRecipe({ phases: [{ duration_minutes: 30, professionals: { mode: 'all', ids: [1, 2] } }] }));
});

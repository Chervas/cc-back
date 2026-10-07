'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { guidedTreatmentOptions } = require('../../services/appointmentBookingAvailability.service');
const { bookingPlanHash } = require('../../lib/booking-plan-receipt');
const p = normalizeBookingProfile({ version: 4, phases: [
  { key: 'indiba', duration_minutes: 20, start_offset_minutes: 0, installation_ids: [9], professionals: { mode: 'any', ids: [5], preferred_id: 5 } },
  { key: 'extract', duration_minutes: 13, start_offset_minutes: 20, installation_ids: [10, 11], professionals: { mode: 'any', ids: [6, 8], preferred_id: 6, fallback_when: 'unavailable' } },
  { key: 'apply', duration_minutes: 17, start_offset_minutes: 33, installation_ids: [12], professionals: { mode: 'all', ids: [5, 7], preferred_id: null } },
] });
const windows = [{ start: '2030-01-07T08:00:00Z', end: '2030-01-07T19:00:00Z' }];
function fixture() { return { profile: p, context: { timeZone: 'Europe/Madrid', clinicWindows: windows, patientBusy: [],
  doctors: new Map([5, 6, 7, 8].map(id => [id, { windows, busy: [] }])),
  installations: new Map([9, 10, 11, 12].map(id => [id, { windows, busy: [], resource_key: `installation:${id}` }])),
}, date: '2030-01-07', startLocal: '2030-01-07T16:00', now: new Date('2029-01-01'),
  selections: { indiba: { doctor_id: 5, installation_id: 9 } } }; }
test('next-step options preserve prefix and include feasible alternate cabins, with one full-plan receipt per option', () => {
  const f = fixture(), result = guidedTreatmentOptions(f);
  assert.equal(result.phase_key, 'extract'); assert(result.slots.length >= 2);
  assert(result.slots.some(slot => slot.phases[1].installation_id === 10));
  assert(result.slots.some(slot => slot.phases[1].installation_id === 11));
  for (const slot of result.slots) {
    assert.equal(slot.start_local, f.startLocal); assert.equal(slot.phases[0].installation_id, 9);
    assert.deepEqual(slot.phases[2].doctor_ids, [5, 7]);
    assert.equal(slot.phases[2].start_at, '2030-01-07T15:33:00.000Z');
    assert.equal(slot.booking_plan_sha256, bookingPlanHash(p, slot));
  }
});
test('a blocked remaining step eliminates ALL intermediate options; no alternate start is silently chosen', () => {
  const f = fixture(); f.context.doctors.get(7).busy.push({ start: '2030-01-07T15:33:00Z', end: '2030-01-07T15:50:00Z', can_share: false });
  assert.deepEqual(guidedTreatmentOptions(f).slots, []);
});
test('patient and supporting-staff occupancy protect the entire visit', () => {
  for (const support of [false, true]) {
    const f = fixture(); const busy = { start: '2030-01-07T15:35:00Z', end: '2030-01-07T15:40:00Z', can_share: false };
    if (support) { f.additionalStaffIds = [8]; f.context.doctors.get(8).busy.push(busy); } else f.context.patientBusy.push(busy);
    assert.deepEqual(guidedTreatmentOptions(f).slots, []);
  }
});
test('completed prefix revalidates exact resources once and never drops an ALL member', () => {
  const f = fixture(); f.selections.extract = { doctor_id: 6, installation_id: 11 }; f.selections.apply = { installation_id: 12 };
  const result = guidedTreatmentOptions(f); assert.equal(result.phase_key, null); assert.equal(result.slots.length, 1);
  assert.equal(result.slots[0].phases[1].installation_id, 11); assert.deepEqual(result.slots[0].phases[2].doctor_ids, [5, 7]);
});
test('invalid prefix, unknown resources, ALL reduction, malformed times and non-grid starts are rejected', () => {
  for (const patch of [ { selections: {} }, { selections: [] }, { selections: { extract: { doctor_id: 6, installation_id: 10 } } },
    { selections: { indiba: { doctor_id: 5, installation_id: 10 } } }, { selections: { indiba: { doctor_id: '5', installation_id: 9 } } },
    { selections: { indiba: { doctor_id: 5, installation_id: 9, force: true } } },
    { selections: { indiba: { doctor_id: 5, installation_id: 9 }, extract: { doctor_id: 6, installation_id: 10 }, apply: { doctor_id: 5, installation_id: 12 } } },
    { startLocal: '2030-01-08T16:00' }, { startLocal: '2030-01-07T16:01' }, { startLocal: [] } ])
    assert.throws(() => guidedTreatmentOptions({ ...fixture(), ...patch }), { code: 'booking_search_invalid' });
});
test('past starts have no options even if resources are free', () => {
  const f = fixture(); f.now = new Date('2030-01-07T15:01:00Z'); assert.deepEqual(guidedTreatmentOptions(f).slots, []);
});

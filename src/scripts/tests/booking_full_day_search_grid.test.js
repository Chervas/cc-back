'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { solutionsForCalendar, startingResourceSelection } = require('../../services/appointmentBookingAvailability.service');
const { bookingPlanHash } = require('../../lib/booking-plan-receipt');

// Synthetic resource windows, actual production calendar search and solver.
// No database, network, providers or real clinical scheduling approval.
const profile = normalizeBookingProfile({ version: 4, phases: [
  { key: 'prepare', duration_minutes: 15, start_offset_minutes: 0, installation_ids: [9],
    professionals: { mode: 'any', ids: [5], preferred_id: 5 } },
  { key: 'apply', duration_minutes: 30, start_offset_minutes: 15, installation_ids: [10],
    professionals: { mode: 'all', ids: [6, 7], preferred_id: null } },
] });
const contextFor = windows => ({ timeZone: 'Europe/Madrid', clinicWindows: windows, patientBusy: [],
  doctors: new Map([5, 6, 7].map(id => [id, { windows, busy: [] }])),
  installations: new Map([9, 10].map(id => [id, { windows, busy: [], resource_key: `installation:${id}` }])),
});
const search = context => ({ profile, context, date: '2030-01-07', days: 1, now: new Date('2029-01-01T00:00:00Z') });

test('a complete visit available only at 11:05 is found on the actual five-minute agenda grid', () => {
  const context = contextFor([{ start: '2030-01-07T10:05:00Z', end: '2030-01-07T10:50:00Z' }]);
  assert.deepEqual(solutionsForCalendar({ ...search(context), stepMinutes: 15, limit: 120 }), []);
  const slots = solutionsForCalendar({ ...search(context), stepMinutes: 5, limit: 288 });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].start_local, '2030-01-07T11:05');
  assert.equal(slots[0].end_local, '2030-01-07T11:50');
  assert.equal(slots[0].phases.length, 2);
  assert.deepEqual(slots[0].phases[1].doctor_ids, [6, 7]);
  assert.equal(slots[0].booking_plan_sha256, bookingPlanHash(profile, slots[0]));
});

test('whole-day limit includes the evening; receipt and full resources survive every candidate', t => {
  const context = contextFor([{ start: '2030-01-06T23:00:00Z', end: '2030-01-07T22:59:00Z' }]);
  const started = performance.now();
  const slots = solutionsForCalendar({ ...search(context), stepMinutes: 5, limit: 288 });
  t.diagnostic(`Synthetic in-memory complete-day search: ${Math.round(performance.now() - started)} ms; ${slots.length} full plans, no SQL/HTTP.`);
  assert.equal(slots.length, 279);
  assert.equal(slots[0].start_local, '2030-01-07T00:00');
  assert.equal(slots.at(-1).start_local, '2030-01-07T23:10');
  assert(slots.some(slot => slot.start_local === '2030-01-07T19:55'));
  assert.equal(new Set(slots.map(slot => slot.start_at)).size, slots.length);
  for (const slot of slots) {
    assert.equal(slot.booking_plan_sha256, bookingPlanHash(profile, slot));
    assert.deepEqual(slot.phases[1].doctor_ids, [6, 7]);
    assert.equal((Date.parse(slot.end_at) - Date.parse(slot.start_at)) / 60000, 45);
  }
});

test('clicked starting resources constrain only the temporal first phase and retain the subsequent mandatory team', () => {
  const p = normalizeBookingProfile({ version: 4, phases: [
    { ...profile.phases[1] }, { ...profile.phases[0], installation_ids: [9, 11], professionals: { mode: 'any', ids: [5, 8], preferred_id: 5, fallback_when: 'unavailable' } },
  ] });
  const selections = startingResourceSelection(p, { startingDoctorId: '5', startingInstallationId: '9' });
  assert.deepEqual(selections, { prepare: { doctor_id: 5, installation_id: 9 } });
  const context = contextFor([{ start: '2030-01-07T10:05:00Z', end: '2030-01-07T10:50:00Z' }]);
  const slots = solutionsForCalendar({ ...search(context), profile: p, selections, stepMinutes: 5, limit: 288 });
  assert.equal(slots.length, 1); assert.deepEqual(slots[0].phases.find(phase => phase.key === 'apply').doctor_ids, [6, 7]);
  assert.equal(slots[0].phases.find(phase => phase.key === 'prepare').installation_id, 9);
});
test('the displayed ALL member is an anchor, never a single-doctor override', () => {
  const p = normalizeBookingProfile({ version: 4, phases: [{ ...profile.phases[0], professionals: { mode: 'all', ids: [5, 6], preferred_id: null } }] });
  for (const startingDoctorId of [5, 6]) {
    const selections = startingResourceSelection(p, { startingDoctorId, startingInstallationId: 9 });
    assert.deepEqual(selections, { prepare: { installation_id: 9 } });
    const context = contextFor([{ start: '2030-01-07T10:05:00Z', end: '2030-01-07T10:50:00Z' }]);
    const slots = solutionsForCalendar({ ...search(context), profile: p, selections, stepMinutes: 5, limit: 288 });
    assert.deepEqual(slots[0].phases[0].doctor_ids, [5, 6]);
  }
});
test('starting anchors reject invalid ids, later-step resources and ambiguous legacy global overrides', () => {
  for (const args of [{ startingDoctorId: 6 }, { startingInstallationId: 10 }, { startingDoctorId: [] },
    { startingDoctorId: '5x' }, { startingDoctorId: 0 }, { startingInstallationId: -1 },
    { startingDoctorId: 5, doctorId: 5 }, { startingInstallationId: 9, installationId: 9 }])
    assert.throws(() => startingResourceSelection(profile, args), { code: 'booking_search_invalid' });
  assert.deepEqual(startingResourceSelection(profile), {});
});

'use strict';

// Pure production solver and fictional resources. No SQL, environment changes,
// patients or providers. The optional unpruned reference disables only the new
// early branch test; it preserves the same4096 bound, order and final planner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const attention = require('../../lib/booking-attention');
const { solveBookingProfile, occupancyForSolution } = require('../../lib/booking-profile-solver');
const { bookingPlanHash } = require('../../lib/booking-plan-receipt');
const filename = require.resolve('../../lib/booking-profile-solver');
const source = fs.readFileSync(filename, 'utf8');
const branch = 'partialStaffFits(selected) && visit(index + 1)';
const BASE = Date.parse('2030-01-07T08:00:00Z');
const iso = minute => new Date(BASE + minute * 60000).toISOString();
const continuous = { mode: 'continuous', patient_preparation_minutes: 0 };
const setup = { mode: 'start_only', start_minutes: 5, start_window_minutes: 15 };
const attended = { mode: 'start_continuous', start_minutes: 5, start_window_minutes: 15 };
const removal = { mode: 'start_end', start_minutes: 5, start_window_minutes: 15, end_minutes: 5, end_window_minutes: 15 };

function loadedSolver({ prune = true, assess = attention.assessStaffAttentionSteps } = {}) {
  assert.equal(source.split(branch).length, 2, 'Reference disables exactly one new pruning boundary');
  const isolated = new Module(filename, module);
  isolated.filename = filename; isolated.paths = Module._nodeModulePaths(path.dirname(filename));
  const actualRequire = Module.createRequire(filename);
  isolated.require = request => request === './booking-attention' ? { ...attention, assessStaffAttentionSteps: assess } : actualRequire(request);
  isolated._compile(prune ? source : source.replace(branch, 'visit(index + 1)'), filename);
  return isolated.exports.solveBookingProfile;
}

function resource(overrides = {}) {
  return { windows: [{ start: iso(0), end: iso(660) }], busy: [], clinic_id: 100,
    absence_windows: [], attention_visits: [], schedule_verified: true, ...overrides };
}
function phase(key, patch = {}) {
  return { key, duration_minutes: 30, start_offset_minutes: 0, installation_ids: [101],
    professionals: { mode: 'any', ids: [1], preferred_id: 1 }, ...patch };
}
function smallContext() {
  return { clinicWindows: [{ start: iso(0), end: iso(660) }],
    doctors: new Map([1, 2].map(id => [id, resource({ name: `QA doctor ${id}` })])),
    installations: new Map([101, 102].map(id => [id, resource({ name: `QA room ${id}`, resource_key: `installation:${id}` })])),
    equipment: new Map([401, 402].map(id => [id, { id, name: `QA unit ${id}`, status: 'available', turnaround_minutes: 0,
      installation_ids: new Set([101, 102]), busy: [], attention_policy: continuous }])) };
}

function denseFixture(counter = { reads: 0 }) {
  const roomIds = Array.from({ length: 12 }, (_, index) => 101 + index);
  const doctorIds = Array.from({ length: 8 }, (_, index) => 1 + index);
  const unitIds = [401, 402, 403, 404];
  const context = { clinicWindows: [{ start: iso(0), end: iso(660) }],
    doctors: new Map(doctorIds.map(id => [id, resource({ name: `QA doctor ${id}` })])),
    installations: new Map(roomIds.map(id => {
      const value = resource({ name: `QA room ${id}`, resource_key: `installation:${id}` });
      const windows = value.windows;
      Object.defineProperty(value, 'windows', { enumerable: true, get() { counter.reads++; return windows; } });
      return [id, value];
    })),
    equipment: new Map(unitIds.map(id => [id, { id, name: `QA unit ${id}`, status: 'available', turnaround_minutes: 0,
      installation_ids: new Set(roomIds), busy: [], attention_policy: continuous }])) };
  for (let roomIndex = 0; roomIndex < 10; roomIndex++) for (let index = 0; index < 18; index++) {
    const interval = { start: iso(index * 30 + (roomIndex % 3) * 5), end: iso(index * 30 + (roomIndex % 3) * 5 + 15), can_share: false };
    context.doctors.get(1 + (roomIndex + index) % 6).busy.push({ ...interval });
    context.installations.get(101 + roomIndex).busy.push({ ...interval });
  }
  const step = (key, patch = {}) => phase(key, { installation_ids: roomIds,
    professionals: { mode: 'any', ids: doctorIds, preferred_id: 1, fallback_when: 'unavailable' },
    equipment_requirements: [{ equipment_ids: unitIds }], ...patch });
  return { profile: { version: 4, phases: [step('first'), step('second', { start_offset_minutes: 15 }),
    step('third', { start_offset_minutes: 45, duration_minutes: 15 })] }, context, counter };
}

test('dense three-step alternatives preserve a proven09:00Z start within the unchanged4096 search bound', () => {
  const { profile, context, counter } = denseFixture();
  const start = iso(60);
  const before = JSON.stringify({ doctors: [...context.doctors], rooms: [...context.installations], units: [...context.equipment] });
  const explicit = solveBookingProfile({ profile, start, ...context, selections: {
    first: { doctor_id: 7, installation_id: 111 }, second: { doctor_id: 8, installation_id: 112 }, third: { doctor_id: 7, installation_id: 111 } } });
  assert(explicit, 'A concrete eligible schedule exists without changing capacity');
  counter.reads = 0;
  const unpruned = loadedSolver({ prune: false });
  const oldStart = performance.now();
  assert.equal(unpruned({ profile, start, ...context }), null, 'The late validation exhausts4096 alternatives and misses this known feasible start');
  const oldCost = { ms: performance.now() - oldStart, room_resource_reads: counter.reads };
  counter.reads = 0;
  const newStart = performance.now();
  const automatic = solveBookingProfile({ profile, start, ...context });
  const newCost = { ms: performance.now() - newStart, room_resource_reads: counter.reads };
  assert(automatic);
  assert.deepEqual(automatic.phases.map(step => step.doctor_ids), [[7], [8], [1]],
    'Keep canonical priority: doctor1 is free for the final15-minute step; do not force the explicit witness choices');
  assert.equal(automatic.start_at, '2030-01-07T09:00:00.000Z');
  assert.equal(automatic.end_at, '2030-01-07T10:00:00.000Z');
  assert(newCost.room_resource_reads < oldCost.room_resource_reads / 2, JSON.stringify({ oldCost, newCost }));
  assert.equal(JSON.stringify({ doctors: [...context.doctors], rooms: [...context.installations], units: [...context.equipment] }), before,
    'The optimisation is read-only; it never moves saved tasks, relaxes occupancy or alters the profile');
  console.log('OWNED_SOLVER_PRUNING_WITNESS ' + JSON.stringify({ before: oldCost, after: newCost,
    canonical_receipt_sha256: bookingPlanHash(profile, automatic), explicit_assignment_receipt_sha256: bookingPlanHash(profile, explicit) }));
});

test('new early pruning has exact canonical parity with the same final joint search on bounded small contexts', () => {
  const unpruned = loadedSolver({ prune: false });
  const policies = [continuous, setup, attended, removal];
  for (let specimen = 0; specimen < 72; specimen++) {
    const context = smallContext();
    const first = phase('first', { installation_ids: [101, 102], staff_attention: [policies[specimen % 4]],
      professionals: { mode: 'any', ids: [1, 2], preferred_id: 1, fallback_when: specimen % 3 ? 'unavailable' : 'absence_only' } });
    const second = phase('second', { duration_minutes: 30, start_offset_minutes: specimen % 2 ? 15 : 0,
      installation_ids: [102, 101], professionals: { mode: 'any', ids: [1, 2], preferred_id: 2, fallback_when: 'unavailable' },
      staff_attention: [policies[Math.floor(specimen / 4) % 4]], equipment_requirements: [{ equipment_ids: [401, 402] }] });
    if (specimen % 5 === 0) context.doctors.get(1).busy.push({ start: iso(10), end: iso(20) });
    if (specimen % 7 === 0) context.doctors.get(2).absence_windows.push({ start: iso(0), end: iso(45) });
    if (specimen % 11 === 0) context.installations.get(102).busy.push({ start: iso(5), end: iso(30) });
    if (specimen % 13 === 0) context.equipment.get(401).busy.push({ start: iso(0), end: iso(45) });
    const options = { profile: { version: 4, phases: specimen % 2 ? [second, first] : [first, second] }, start: iso(0), ...context };
    assert.deepEqual(solveBookingProfile(options), unpruned(options), `Canonical phase/interval/warning parity for specimen${specimen}`);
  }
});

test('a partial search_limit is unknown, not a monotonic impossibility', () => {
  const context = smallContext();
  let partialLimits = 0, completePlans = 0;
  const instrumented = loadedSolver({ assess: input => {
    if (input.steps.length === 1) { partialLimits++; return { status: 'search_limit' }; }
    const result = attention.assessStaffAttentionSteps(input);
    if (result.status === 'planned') completePlans++;
    return result;
  } });
  const profile = { version: 4, phases: [phase('first'), phase('later', { start_offset_minutes: 30 })] };
  const result = instrumented({ profile, start: iso(0), ...context });
  assert(result, 'An unknown prefix must reach the authoritative complete planner');
  assert(partialLimits > 0); assert(completePlans > 0);
  assert.deepEqual(result, solveBookingProfile({ profile, start: iso(0), ...context }));
});

test('prefix plans do not freeze greedy preparation or reuse staff decisions across different starts', () => {
  const context = smallContext();
  const profile = { version: 4, phases: [phase('autonomous', { installation_ids: [101], staff_attention: [setup],
    equipment_requirements: [{ equipment_ids: [401] }] }),
  phase('attended', { installation_ids: [102], staff_attention: [attended], equipment_requirements: [{ equipment_ids: [402] }] })] };
  const result = solveBookingProfile({ profile, start: iso(0), ...context });
  assert(result);
  const first = result.phases[0].staff_intervals[0];
  const second = result.phases[1].staff_intervals;
  assert.deepEqual([first.start_at, first.end_at], [iso(0), iso(5)]);
  assert.deepEqual(second, [{ start_at: iso(10), end_at: iso(15), kind: 'start' }, { start_at: iso(15), end_at: iso(30), kind: 'continuous' }]);
  assert(occupancyForSolution(result).filter(row => row.resource_kind !== 'doctor').every(row => row.start_at === iso(0) && row.end_at === iso(30)));
  context.doctors.get(1).busy.push({ start: iso(30), end: iso(60) });
  assert.equal(solveBookingProfile({ profile, start: iso(30), ...context }), null, 'A previous solve must not seed a new calendar-context cache');
  assert(solveBookingProfile({ profile, start: iso(60), ...context }));
});

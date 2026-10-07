'use strict';

// All schedules, professionals and visits below are fictional and offline.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { solveBookingProfile } = require('../../lib/booking-profile-solver');
const { assessStaffAttention, planStaffAttention } = require('../../lib/booking-attention');
const { primaryAbsentForStep, professionalFallbackAllowed } = require('../../lib/booking-professional-fallback');

const BASE = Date.parse('2030-01-07T09:00:00Z');
const at = minutes => new Date(BASE + minutes * 60000).toISOString();
const continuous = { mode: 'continuous', patient_preparation_minutes: 0 };
const setup = { mode: 'start_only', start_minutes: 5, start_window_minutes: 15 };
const attended = { mode: 'start_continuous', start_minutes: 5, start_window_minutes: 15 };
const resource = patch => ({ windows: [{ start: at(-60), end: at(600) }], busy: [], absence_windows: [],
  schedule_verified: true, clinic_id: 72, attention_visits: [], ...patch });
const step = (when = 'absence_only') => ({ key: 'care', duration_minutes: 30, start_offset_minutes: 0,
  installation_ids: [9], professionals: { mode: 'any', ids: [5, 6], preferred_id: 5, fallback_when: when } });
const profile = (when = 'absence_only') => ({ version: 4, phases: [step(when)] });
const context = primary => ({ doctors: new Map([[5, primary || resource()], [6, resource()]]),
  installations: new Map([[9, resource()], [10, resource()]]) });
const solve = (p, primary, options = {}) => solveBookingProfile({ profile: p, start: at(0), ...context(primary), ...options });

test('v4 alternatives require an explicit primary and substitution decision in strict and draft contracts', () => {
  for (const allowIncomplete of [false, true]) {
    for (const field of ['preferred_id', 'fallback_when']) {
      const p = profile(); delete p.phases[0].professionals[field];
      assert.throws(() => normalizeBookingProfile(p, { allowIncomplete }), { code: 'booking_profile_invalid' });
    }
    for (const value of [undefined, null, '', 'busy', true]) {
      const p = profile(); p.phases[0].professionals.fallback_when = value;
      assert.throws(() => normalizeBookingProfile(p, { allowIncomplete }), { code: 'booking_profile_invalid' });
    }
    for (const value of ['absence_only', 'unavailable']) {
      assert.equal(normalizeBookingProfile(profile(value), { allowIncomplete }).phases[0].professionals.fallback_when, value);
    }
  }
});

test('single-professional optional decisions are preserved; teams cannot carry a fallback in any version', () => {
  const single = profile(); single.phases[0].professionals.ids = [5];
  assert.equal(normalizeBookingProfile(single).phases[0].professionals.fallback_when, 'absence_only');
  delete single.phases[0].professionals.fallback_when;
  assert.equal(Object.hasOwn(normalizeBookingProfile(single).phases[0].professionals, 'fallback_when'), false);
  for (const version of [1, 2, 3, 4]) {
    const team = profile(); team.version = version;
    if (version < 4) delete team.phases[0].start_offset_minutes;
    team.phases[0].professionals.mode = 'all'; team.phases[0].professionals.preferred_id = null;
    assert.throws(() => normalizeBookingProfile(team), { code: 'booking_profile_invalid' });
  }
});

test('an appointment does not authorize absence-only replacement; unavailable explicitly does', () => {
  const primary = resource({ busy: [{ start: at(0), end: at(30) }] });
  assert.equal(solve(profile(), primary), null);
  const result = solve(profile('unavailable'), primary);
  assert(result); assert.deepEqual(result.phases[0].doctor_ids, [6]);
  assert.equal(result.warnings[0].fallback_reason, 'unavailable');
  assert.equal(result.warnings[0].fallback_when, 'unavailable');
  assert.equal(result.requires_priority_acknowledgement, true);
});

test('a verified typed absence allows replacement and reports that reason, not general unavailability', () => {
  const absence = { start: at(0), end: at(30) };
  const result = solve(profile(), resource({ busy: [absence], absence_windows: [absence] }));
  assert(result); assert.deepEqual(result.phases[0].doctor_ids, [6]);
  assert.equal(result.warnings[0].fallback_reason, 'absence');
  assert.equal(result.warnings[0].fallback_when, 'absence_only');
  assert.equal(result.requires_priority_acknowledgement, true);
});

test('configured non-working time proves absence; unknown or malformed schedules do not', () => {
  assert(solve(profile(), resource({ windows: [{ start: at(60), end: at(600) }] })));
  assert(solve(profile(), resource({ windows: [] })), 'Verified weekly schedule has no work on this day');
  for (const primary of [undefined, resource({ windows: [], schedule_verified: false }),
    resource({ windows: [{ start: 'bad', end: at(600) }] }), resource({ windows: null })]) {
    assert.equal(primaryAbsentForStep(primary, { start: at(0), end: at(30), policies: [continuous] }), false);
  }
  const unknown = resource({ schedule_verified: false, windows: [] });
  assert.equal(solve(profile(), unknown), null);
  const explicit = { start: at(-5), end: at(35) };
  assert(solve(profile(), { ...unknown, busy: [explicit], absence_windows: [explicit] }), 'Typed absence still proves the complete required interval');
});

test('free-text vacation reasons, ordinary blocks, room restrictions and missing assignments are not absences', () => {
  for (const busy of [{ start: at(0), end: at(30), reason: 'Vacaciones' },
    { start: at(0), end: at(30), tipo: 'formacion' }, { start: at(0), end: at(30), kind: 'other_clinic' }]) {
    assert.equal(solve(profile(), resource({ busy: [busy] })), null);
  }
  const c = context(); c.installations.get(9).profesionales_permitidos = [6];
  assert.equal(solveBookingProfile({ profile: profile(), start: at(0), ...c }), null);
  c.doctors.delete(5);
  assert.equal(solveBookingProfile({ profile: profile(), start: at(0), ...c }), null, 'No primary context is not a vacation');
});

test('initial-only work uses its actual window, not the full autonomous machine visit, to determine absence', () => {
  const p = profile(); p.phases[0].staff_attention = [setup];
  const primary = resource({ windows: [{ start: at(0), end: at(5) }], busy: [{ start: at(0), end: at(5) }] });
  assert.equal(primaryAbsentForStep(primary, { start: at(0), end: at(30), policies: [setup] }), false);
  assert.equal(solve(p, primary), null, 'Busy preparation is not absence even though the rest of the visit is outside hours');
  const shortAbsence = resource({ busy: [{ start: at(0), end: at(5) }], absence_windows: [{ start: at(0), end: at(5) }] });
  const stillPrimary = solve(p, shortAbsence);
  assert(stillPrimary); assert.deepEqual(stillPrimary.phases[0].doctor_ids, [5]);
  const wholeWindow = { start: at(0), end: at(15) };
  assert.deepEqual(solve(p, resource({ busy: [wholeWindow], absence_windows: [wholeWindow] })).phases[0].doctor_ids, [6]);
});

test('continuous work after setup and explicit finals remain part of the absence decision', () => {
  const primary = resource({ windows: [{ start: at(0), end: at(15) }] });
  const p = profile(); p.phases[0].staff_attention = [attended];
  assert.deepEqual(solve(p, primary).phases[0].doctor_ids, [6]);
  p.phases[0].staff_attention = [{ mode: 'start_end', start_minutes: 5, start_window_minutes: 15, end_minutes: 5, end_window_minutes: 10 }];
  assert.deepEqual(solve(p, primary).phases[0].doctor_ids, [6], 'Final work cannot be silently discarded to keep the primary');
});

test('force and an explicit alternate selection cannot bypass the permitted substitution condition', () => {
  const primary = resource();
  assert.equal(solve(profile(), primary, { selections: { care: { doctor_id: 6 } }, allowOverlap: true }), null);
  assert(solve(profile('unavailable'), primary, { selections: { care: { doctor_id: 6 } } }));
  assert.deepEqual(solve(profile(), primary).phases[0].doctor_ids, [5]);
});

test('internal concurrent work is not a clinical absence; explicit unavailable can solve it with the alternative', () => {
  const p = profile(); p.phases.push({ ...step(), key: 'second', installation_ids: [10],
    professionals: { mode: 'any', ids: [5], preferred_id: 5 } });
  assert.equal(solve(p), null);
  p.phases[0].professionals.fallback_when = 'unavailable';
  assert.deepEqual(solve(p).phases.map(row => row.doctor_ids), [[6], [5]]);
});

test('legacy ANY keeps its historical available-alternative behavior even with an optional conditional field', () => {
  for (const version of [1, 2, 3]) {
    const p = profile(); p.version = version; delete p.phases[0].start_offset_minutes;
    const primary = resource({ busy: [{ start: at(0), end: at(30) }] });
    assert.equal(normalizeBookingProfile(p).phases[0].professionals.fallback_when, 'absence_only');
    assert.deepEqual(solve(p, primary).phases[0].doctor_ids, [6]);
    const before = structuredClone(p); delete p.phases[0].professionals.fallback_when;
    assert.deepEqual(solve(p, primary), solve(before, primary));
  }
  assert.equal(professionalFallbackAllowed({ profileVersion: 4, professionals: { mode: 'any', ids: [5, 6], preferred_id: 5 },
    primary: resource({ windows: [] }), start: at(0), end: at(30), policies: [continuous] }), false);
});

test('limited attention search reports exhaustion separately from a proved schedule impossibility', () => {
  const final = { mode: 'start_end', start_minutes: 5, start_window_minutes: 15, end_minutes: 5, end_window_minutes: 15 };
  const options = { resource: resource(), start: at(0), end: at(30), policies: [final] };
  assert.deepEqual(assessStaffAttention({ ...options, maxAttempts: 1 }), { status: 'search_limit' });
  const completed = assessStaffAttention(options);
  assert.equal(completed.status, 'planned');
  assert.deepEqual(completed.staff_intervals, planStaffAttention(options), 'Existing snapshot intervals stay byte-for-byte equivalent');
  assert.deepEqual(assessStaffAttention({ ...options, resource: resource({ windows: [] }) }), { status: 'infeasible' });
  assert.equal(primaryAbsentForStep(options.resource, { ...options, maxAttempts: 1 }), false);
  assert.equal(professionalFallbackAllowed({ profileVersion: 4, professionals: alternativeStaff(), primary: options.resource,
    start: options.start, end: options.end, policies: options.policies, maxAttempts: 1 }), false);
});

const alternativeStaff = () => ({ mode: 'any', ids: [5, 6], preferred_id: 5, fallback_when: 'absence_only' });
test('the real default 512 limit cannot authorize absence-only replacement, even with a feasible alternative', () => {
  // Deliberately demanding synthetic definition: eight initial interventions.
  // Exhausting permutations is not mathematical proof of clinical absence.
  const policies = Array.from({ length: 8 }, () => ({ mode: 'start_only', start_minutes: 5, start_window_minutes: 60 }));
  const primary = resource({ windows: [{ start: at(0), end: at(35) }] });
  const options = { start: at(0), end: at(60), policies };
  assert.deepEqual(assessStaffAttention({ resource: primary, ...options }), { status: 'search_limit' });
  assert.equal(assessStaffAttention({ resource: resource(), ...options }).status, 'planned');
  assert.equal(primaryAbsentForStep(primary, options), false);
  assert.equal(professionalFallbackAllowed({ profileVersion: 4, professionals: alternativeStaff(), primary, ...options }), false);
  const p = profile(); p.phases[0].duration_minutes = 60; p.phases[0].staff_attention = policies;
  assert.equal(solve(p, primary, { selections: { care: { doctor_id: 6 } } }), null);
  p.phases[0].professionals.fallback_when = 'unavailable';
  assert.deepEqual(solve(p, primary, { selections: { care: { doctor_id: 6 } } }).phases[0].doctor_ids, [6]);
});

test('invalid attention timing or search bounds do not become clinical absence evidence', () => {
  for (const options of [{ start: at(0), end: at(30), policies: [{ ...setup, start_window_minutes: 60 }] },
    { start: at(0), end: at(5), policies: [{ mode: 'continuous', patient_preparation_minutes: 5 }] },
    { start: at(0), end: at(30), policies: [setup], maxAttempts: 0 }]) {
    assert.deepEqual(assessStaffAttention({ resource: resource(), ...options }), { status: 'invalid' });
    assert.equal(primaryAbsentForStep(resource(), options), false);
  }
});

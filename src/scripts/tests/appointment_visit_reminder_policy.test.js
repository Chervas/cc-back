'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../../lib/appointment-visit-reminder-policy');
const v = require('../../lib/appointment-visit-communication');
const config = patch => ({ schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '09:00',
  exclude_if_booked_day_before: false, exclude_if_booked_same_day: false, exclude_if_not_confirmed: false, only_if_not_confirmed: false, ...patch });
const binding = patch => p.binding({ templateVersionId: 45, stageKey: 'attendance_day_before', schedulePolicy: config(), fireGraceMs: 900000, ...patch });
const enrollment = patch => ({ time_zone: 'Europe/Madrid', enrolled_at: '2030-01-01T12:00:00Z', reminder_booked_at: '2030-01-01T12:00:00Z', ...patch });
test('actual configured hour, timezone and existing grace freeze narrow not-before and expiry boundaries', () => {
  const window = p.window({ enrollment: enrollment(), startAt: '2030-01-07T09:00:00Z', binding: binding(), anchorAt: '2030-01-01T12:00:00Z' });
  assert.equal(window.key, 'day_before:2030-01-07'); assert.equal(window.starts_at, '2030-01-06T08:00:00.000Z');
  assert.equal(window.ends_at, '2030-01-06T08:15:00.000Z');
  assert.throws(() => v.assertWindow(window, '2030-01-06T07:59:59.999Z', true), /window_not_open/);
  assert.doesNotThrow(() => v.assertWindow(window, window.starts_at, true));
  assert.throws(() => v.assertWindow(window, window.ends_at, true), /window_expired/);
});
test('same-day hour-before and custom time preserve native timing without extending past appointment', () => {
  const selected = binding({ stageKey: 'attendance_same_day', schedulePolicy: config({ schedule_moment: 'same_day', schedule_time_mode: 'one_hour_before', custom_time: null }) });
  const result = p.window({ enrollment: enrollment(), startAt: '2030-01-07T09:00:00Z', binding: selected, anchorAt: '2030-01-01T12:00:00Z' });
  assert.equal(result.starts_at, '2030-01-07T08:00:00.000Z'); assert.equal(result.ends_at, '2030-01-07T08:15:00.000Z');
  assert.throws(() => p.window({ enrollment: enrollment(), startAt: '2030-01-06T23:30:00Z', binding: selected, anchorAt: '2030-01-01T12:00:00Z' }), /window_policy_unsupported/);
});
test('native creation date controls booked-day exclusion, never preallocation timestamp or mutable updated_at', () => {
  const selected = binding({ schedulePolicy: config({ exclude_if_booked_day_before: true }) });
  assert.throws(() => p.window({ enrollment: enrollment({ enrolled_at: '2030-01-05T22:59:59Z', reminder_booked_at: '2030-01-05T23:00:01Z' }),
    startAt: '2030-01-07T09:00:00Z', binding: selected, anchorAt: '2030-01-05T22:59:59Z' }), /booking_window_excluded/);
});
test('new birth or movement after due cannot create retroactive right; restart of prior intent retains original window', () => {
  const args = { enrollment: enrollment(), startAt: '2030-01-07T09:00:00Z', binding: binding() };
  assert.throws(() => p.window({ ...args, anchorAt: '2030-01-06T08:00:00Z' }), /window_not_future/);
  assert.throws(() => p.window({ ...args, anchorAt: '2030-01-06T08:01:00Z' }), /window_not_future/);
  assert.deepEqual(p.window({ ...args, anchorAt: enrollment().enrolled_at }), p.window({ ...args, anchorAt: enrollment().enrolled_at }));
});
test('unsupported or ambiguous native slots are not silently dropped, remapped or globally inferred', () => {
  for (const schedulePolicy of [config({ schedule_moment: 'week_before' }), config({ only_if_not_confirmed: true }),
    config({ schedule_time_mode: 'one_hour_before', custom_time: null }), config({ custom_time: '25:99' })]) {
    assert.throws(() => binding({ schedulePolicy }));
  }
  for (const fireGraceMs of [0, -1, 1.5, 86400001]) assert.throws(() => binding({ fireGraceMs }));
  assert.throws(() => p.normalizeBindings([binding(), binding({ templateVersionId: 46 })]), /bindings_ambiguous/);
  assert.throws(() => p.selectedBinding({}, 45, 'attendance_day_before'), /bindings_invalid/);
  assert.deepEqual(p.normalizeBindings([]), []);
});

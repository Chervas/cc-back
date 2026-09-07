'use strict';

const assert = require('node:assert/strict');
const {
  appointmentReminderConfigsOverlap,
} = require('../../lib/automation-trigger-conflict');

assert.equal(appointmentReminderConfigsOverlap(
  { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '09:00' },
  { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '09:00' }
), true);
assert.equal(appointmentReminderConfigsOverlap(
  { schedule_moment: 'same_day', schedule_time_mode: 'custom', custom_time: '09:00' },
  { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '09:00' }
), false);
assert.equal(appointmentReminderConfigsOverlap(
  { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '08:00' },
  { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '09:00' }
), false);
assert.equal(appointmentReminderConfigsOverlap(
  { schedule_moment: 'day_before', schedule_time_mode: 'one_hour_before' },
  { schedule_moment: 'day_before', schedule_time_mode: 'one_hour_before' }
), true);

console.log('automation_trigger_conflict.test.js OK');


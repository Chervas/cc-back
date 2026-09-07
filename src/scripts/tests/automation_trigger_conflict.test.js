'use strict';

const assert = require('node:assert/strict');
const {
  appointmentReminderConfigsMatchExactly,
} = require('../../lib/automation-trigger-conflict');

assert.equal(appointmentReminderConfigsMatchExactly(
  { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '09:00' },
  { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '09:00' }
), true);
assert.equal(appointmentReminderConfigsMatchExactly(
  { schedule_moment: 'same_day', schedule_time_mode: 'custom', custom_time: '09:00' },
  { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '09:00' }
), false);
assert.equal(appointmentReminderConfigsMatchExactly(
  { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '08:00' },
  { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '09:00' }
), false);
assert.equal(appointmentReminderConfigsMatchExactly(
  { schedule_moment: 'day_before', schedule_time_mode: 'one_hour_before' },
  { schedule_moment: 'day_before', schedule_time_mode: 'one_hour_before' }
), true);
assert.equal(appointmentReminderConfigsMatchExactly(
  {
    schedule_moment: 'day_before',
    schedule_time_mode: 'custom',
    custom_time: '09:00',
    only_if_not_confirmed: true,
  },
  {
    schedule_moment: 'day_before',
    schedule_time_mode: 'custom',
    custom_time: '09:00',
    only_if_not_confirmed: false,
  }
), false);
assert.equal(appointmentReminderConfigsMatchExactly(
  { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '09:00' },
  {
    schedule_moment: 'day_before',
    schedule_time_mode: 'custom',
    custom_time: '09:00',
    exclude_if_booked_day_before: false,
    exclude_if_booked_same_day: false,
    exclude_if_not_confirmed: false,
    only_if_not_confirmed: false,
  }
), true);

console.log('automation_trigger_conflict.test.js OK');

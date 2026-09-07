'use strict';

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeAppointmentReminderConfig(value) {
  const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    schedule_moment: clean(config.schedule_moment || 'day_before').toLowerCase(),
    schedule_time_mode: clean(config.schedule_time_mode || 'custom').toLowerCase(),
    custom_time: clean(config.custom_time || '09:00'),
    exclude_if_booked_day_before: config.exclude_if_booked_day_before === true,
    exclude_if_booked_same_day: config.exclude_if_booked_same_day === true,
    exclude_if_not_confirmed: config.exclude_if_not_confirmed === true,
    only_if_not_confirmed: config.only_if_not_confirmed === true,
  };
}

function appointmentReminderConfigsMatchExactly(left, right) {
  return JSON.stringify(normalizeAppointmentReminderConfig(left))
    === JSON.stringify(normalizeAppointmentReminderConfig(right));
}

module.exports = {
  appointmentReminderConfigsMatchExactly,
  normalizeAppointmentReminderConfig,
};

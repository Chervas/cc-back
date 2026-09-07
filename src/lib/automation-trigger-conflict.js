'use strict';

function clean(value) {
  return String(value ?? '').trim();
}

function appointmentReminderConfigsOverlap(left, right) {
  const leftConfig = left && typeof left === 'object' && !Array.isArray(left) ? left : {};
  const rightConfig = right && typeof right === 'object' && !Array.isArray(right) ? right : {};
  const leftMoment = clean(leftConfig.schedule_moment || 'day_before').toLowerCase();
  const rightMoment = clean(rightConfig.schedule_moment || 'day_before').toLowerCase();
  if (leftMoment !== rightMoment) return false;

  const leftMode = clean(leftConfig.schedule_time_mode || 'custom').toLowerCase();
  const rightMode = clean(rightConfig.schedule_time_mode || 'custom').toLowerCase();
  if (leftMode !== rightMode) return false;
  if (leftMode === 'custom') {
    const leftTime = clean(leftConfig.custom_time);
    const rightTime = clean(rightConfig.custom_time);
    if (leftTime && rightTime && leftTime !== rightTime) return false;
  }
  return true;
}

module.exports = {
  appointmentReminderConfigsOverlap,
};


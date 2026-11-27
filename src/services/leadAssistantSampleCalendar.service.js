'use strict';

const { localDateTimeToUtc, resolveClinicTimezone } = require('../lib/availability-calendar');
const { addDays } = require('../lib/personal-schedule-recurring');

// Supply only free times. Both calendars use the same authorised services and professional selection.
// Rechecking the same date/time produces the same receipt during confirmation.
function sampleSlots({ clinic, treatment, calendar, now, professionalId }) {
  const timezone = resolveClinicTimezone(clinic);
  const slots = [];
  for (let day = 0; day < calendar.days && slots.length < 2; day++) {
    const date = addDays(calendar.date, day);
    const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (const [time, minutes] of [['09:30',570],['11:30',690],['16:00',960],['17:30',1050]]) {
      if (calendar.period === 'manana' && minutes >= 840 || calendar.period === 'tarde' && minutes < 840) continue;
      const constraint = calendar.hourMinute;
      if (constraint && (constraint.kind === 'at' && minutes !== constraint.value ||
          constraint.kind === 'after' && minutes < constraint.value || constraint.kind === 'before' && minutes >= constraint.value)) continue;
      const start = localDateTimeToUtc(date,time+':00',timezone);
      if (!start || +start <= +now) continue;
      const local = date+'T'+time+':00';
      slots.push({start:start.toISOString(), local, receipt:['sample',treatment.id,professionalId,local].join(':'), doctorId:professionalId ?? null});
      if (slots.length === 2) break;
    }
  }
  return slots;
}
module.exports = { sampleSlots };

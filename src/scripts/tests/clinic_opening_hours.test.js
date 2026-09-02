'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const db = require('../../../models');
const {
  computeClinicOpenState,
  computeNextClinicOpening,
  normalizeScheduleRows,
  weekdayIndex,
} = require('../../services/clinicOpeningHours.service');

const WEEKLY_SCHEDULE = [
  { dia_semana: 1, hora_inicio: '09:00', hora_fin: '14:00', activo: true },
  { dia_semana: 1, hora_inicio: '16:00', hora_fin: '20:00', activo: true },
  { dia_semana: 2, hora_inicio: '09:00', hora_fin: '14:00', activo: true },
  { dia_semana: 0, hora_inicio: '10:00', hora_fin: '12:00', activo: false },
];

function testClinicWeekdaysUseApiZeroToSixContract() {
  assert.equal(weekdayIndex('2026-09-06'), 0);
  assert.equal(weekdayIndex('2026-09-07'), 1);
  assert.deepEqual(
    normalizeScheduleRows(WEEKLY_SCHEDULE).map((row) => row.weekday),
    [1, 1, 2],
  );
}

function testOpenAndMiddayClosureInMadrid() {
  const open = computeClinicOpenState({
    now: new Date('2026-09-07T08:30:00.000Z'),
    timeZone: 'Europe/Madrid',
    rows: WEEKLY_SCHEDULE,
  });
  assert.equal(open.local_time, '10:30');
  assert.equal(open.open_now, true);

  const midday = computeClinicOpenState({
    now: new Date('2026-09-07T12:30:00.000Z'),
    timeZone: 'Europe/Madrid',
    rows: WEEKLY_SCHEDULE,
  });
  assert.equal(midday.local_time, '14:30');
  assert.equal(midday.open_now, false);
  assert.equal(midday.has_schedule, true);
}

function testWeekendAndMissingSchedule() {
  const weekend = computeClinicOpenState({
    now: new Date('2026-09-06T09:00:00.000Z'),
    timeZone: 'Europe/Madrid',
    rows: WEEKLY_SCHEDULE,
  });
  assert.equal(weekend.local_date, '2026-09-06');
  assert.equal(weekend.open_now, false);

  const missing = computeClinicOpenState({
    now: new Date('2026-09-06T09:00:00.000Z'),
    timeZone: 'Europe/Madrid',
    rows: [],
  });
  assert.equal(missing.open_now, null);
  assert.equal(missing.has_schedule, false);
}

function testNextOpeningHonorsMadridTimezoneAndMiddayGap() {
  const midday = computeNextClinicOpening({
    now: new Date('2026-09-07T12:30:00.000Z'),
    timeZone: 'Europe/Madrid',
    rows: WEEKLY_SCHEDULE,
  });
  assert.equal(midday.reason, 'next_clinic_opening');
  assert.equal(midday.waitUntil.toISOString(), '2026-09-07T14:00:00.000Z');

  const sunday = computeNextClinicOpening({
    now: new Date('2026-09-06T12:00:00.000Z'),
    timeZone: 'Europe/Madrid',
    rows: WEEKLY_SCHEDULE,
  });
  assert.equal(sunday.waitUntil.toISOString(), '2026-09-07T07:00:00.000Z');
}

async function run() {
  testClinicWeekdaysUseApiZeroToSixContract();
  testOpenAndMiddayClosureInMadrid();
  testWeekendAndMissingSchedule();
  testNextOpeningHonorsMadridTimezoneAndMiddayGap();
  console.log('clinic_opening_hours.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close());

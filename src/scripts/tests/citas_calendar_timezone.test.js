#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

const db = require('../../../models');
const { __testing } = require('../../controllers/citas.controller');

async function run() {
  const summer = __testing.buildCalendarRangeForTimeZone(
    '2026-07-25T00:00:00',
    '2026-07-25T23:59:59',
    'Europe/Madrid',
  );
  assert.equal(summer.start.toISOString(), '2026-07-24T22:00:00.000Z');
  assert.equal(summer.end.toISOString(), '2026-07-25T21:59:59.999Z');

  const winter = __testing.buildCalendarRangeForTimeZone(
    '2026-01-25',
    '2026-01-25',
    'Europe/Madrid',
  );
  assert.equal(winter.start.toISOString(), '2026-01-24T23:00:00.000Z');
  assert.equal(winter.end.toISOString(), '2026-01-25T22:59:59.999Z');

  const dstStart = __testing.buildCalendarRangeForTimeZone(
    '2026-03-29',
    '2026-03-29',
    'Europe/Madrid',
  );
  assert.equal(dstStart.start.toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(dstStart.end.toISOString(), '2026-03-29T21:59:59.999Z');
  assert.equal(
    dstStart.end.getTime() - dstStart.start.getTime() + 1,
    23 * 60 * 60 * 1000,
  );

  const explicitUtc = __testing.buildCalendarRangeForTimeZone(
    '2026-07-25T00:00:00.000Z',
    '2026-07-25T23:59:59.000Z',
    'Europe/Madrid',
  );
  assert.equal(explicitUtc.start.toISOString(), '2026-07-25T00:00:00.000Z');
  assert.equal(explicitUtc.end.toISOString(), '2026-07-25T23:59:59.000Z');

  assert.equal(
    __testing.formatDateTimeLocal('2026-07-25T16:00:00.000Z', 'Europe/Madrid'),
    '2026-07-25T18:00:00',
  );
  assert.equal(
    __testing.formatDateTimeLocal('2026-01-25T16:00:00.000Z', 'Europe/Madrid'),
    '2026-01-25T17:00:00',
  );

  process.stdout.write('citas calendar timezone tests passed\n');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
    process.exit(process.exitCode || 0);
  });

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createAvailabilityLocalInstantResolver } = require('../../lib/availability-local-instants');
const { resolveLocalInstant } = require('../../lib/voucher-schedule-calendar');
const availability = require('../../services/appointmentBookingAvailability.service');
const { referenceCalendarService, calendarFixture, calendarProjection } = require('./helpers/availability-calendar-instants-fixture');
const previous = referenceCalendarService();

test('clock memo is keyed by date/time/zone, clones Dates and belongs to one request only', () => {
  let calls = 0;
  const native = (...args) => { calls++; return resolveLocalInstant(...args); };
  const firstRequest = createAvailabilityLocalInstantResolver(native);
  const original = firstRequest('2030-01-07', '09:00:00', 'Europe/Madrid');
  const untouched = +original;
  original.setUTCFullYear(1999);
  assert.equal(+firstRequest('2030-01-07', '09:00:00', 'Europe/Madrid'), untouched);
  assert.equal(calls, 1);
  assert.notEqual(+firstRequest('2030-01-07', '09:00:00', 'UTC'), untouched);
  firstRequest('2030-01-08', '09:00:00', 'Europe/Madrid');
  firstRequest('2030-01-07', '09:05:00', 'Europe/Madrid');
  assert.equal(calls, 4);
  const secondRequest = createAvailabilityLocalInstantResolver(native);
  assert.equal(+secondRequest('2030-01-07', '09:00:00', 'Europe/Madrid'), untouched);
  assert.equal(calls, 5, 'a new request computes its own clock conversion');
});

test('ambiguous/nonexistent DST and other resolver errors are native and never hidden or cached', () => {
  let calls = 0;
  const memo = createAvailabilityLocalInstantResolver((...args) => { calls++; return resolveLocalInstant(...args); });
  for (const date of ['2026-03-29', '2026-10-25']) for (let repeat = 0; repeat < 2; repeat++) {
    assert.throws(() => memo(date, '02:30:00', 'Europe/Madrid'), { code: 'voucher_schedule_dst_conflict', statusCode: 400 });
  }
  assert.equal(calls, 4);
  for (let repeat = 0; repeat < 2; repeat++) assert.throws(() => memo('not-a-date', '09:00:00', 'Europe/Madrid'),
    { code: 'voucher_schedule_start_invalid', statusCode: 400 });
  assert.equal(calls, 6);
  for (let repeat = 0; repeat < 2; repeat++) assert.throws(() => memo('2030-01-07', '09:00:00', 'Owned/Invalid_Zone'),
    { name: 'RangeError' });
  assert.equal(calls, 8);
  const sentinel = Object.assign(new Error('owned error'), { code: 'OWNED_ERROR' });
  const errors = createAvailabilityLocalInstantResolver(() => { throw sentinel; });
  assert.throws(() => errors('2030-01-07', '09:00:00', 'UTC'), error => error === sentinel);
});

test('memo is bounded and bypasses non-string inputs instead of changing native validation', () => {
  let calls = 0;
  const memo = createAvailabilityLocalInstantResolver(() => new Date(++calls));
  for (let index = 0; index < 16385; index++) memo(String(index), '00:00:00', 'UTC');
  memo('0', '00:00:00', 'UTC');
  assert.equal(calls, 16386, 'oldest pure clock value can be recomputed after bounded eviction');
  memo(undefined, '00:00:00', 'UTC'); memo(undefined, '00:00:00', 'UTC');
  assert.equal(calls, 16388);
});

test('exact slot, receipt/hash and diagnostic parity for range/full-day/empty/limit and profile variants', () => {
  const specimens = [
    [{ version: 1, dense: true }, { fromLocal: '09:00', toLocal: '20:00' }],
    [{ version: 2, equipment: true }, { fromLocal: '09:00', toLocal: '20:00' }],
    [{ version: 4, phases: 2, dense: true }, { fromLocal: '09:00', toLocal: '20:00' }],
    [{ version: 4, allStaff: true }, { fromLocal: '09:00', toLocal: '20:00' }],
    [{ dense: true }, {}],
    [{}, { fromLocal: '', toLocal: '' }],
    [{}, { fromLocal: '09:02', toLocal: '09:14' }],
    [{}, { fromLocal: '20:00', toLocal: '09:00' }],
    [{}, { fromLocal: '00:00', toLocal: '00:00' }],
    [{}, { fromLocal: '09:00', toLocal: '20:00', limit: 1 }],
    [{ dense: true }, { fromLocal: '09:00', toLocal: '20:00', allowRestrictionProposals: true }],
    [{}, { fromLocal: '09:00', toLocal: '20:00', now: new Date('2030-01-07T11:03:00Z') }],
    [{ dates: ['2030-01-07', '2030-01-08'], dense: true }, { fromLocal: '09:00', toLocal: '11:00' }],
    [{ dates: ['2030-01-07', '2030-01-08'], roomCount: 1, doctorCount: 1 }, { fromLocal: '09:00', toLocal: '11:00', days: 2 }],
    [{ dates: ['2030-01-07', '2032-01-07'], roomCount: 1, doctorCount: 1 }, { fromLocal: '09:00', toLocal: '11:00' }],
  ];
  for (const [fixtureOptions, options] of specimens) {
    const f = calendarFixture(fixtureOptions), before = JSON.stringify({ profile: f.profile,
      doctors: [...f.context.doctors], installations: [...f.context.installations] });
    const baseline = calendarProjection(previous.solutionsForCalendar, f, options);
    const current = calendarProjection(availability.solutionsForCalendar, f, { ...options,
      resolveInstant: createAvailabilityLocalInstantResolver() });
    assert.deepEqual(current, baseline, JSON.stringify({ fixtureOptions, options }));
    assert.equal(JSON.stringify({ profile: f.profile, doctors: [...f.context.doctors], installations: [...f.context.installations] }), before);
    for (const row of current) for (const slot of row.slots) assert.match(slot.booking_plan_sha256, /^[a-f0-9]{64}$/);
  }
});

test('full-day and exact-start parity across DST transitions and non-hour-offset zones', () => {
  const memo = createAvailabilityLocalInstantResolver();
  for (const [date, timeZone] of [ ['2026-03-29', 'Europe/Madrid'], ['2026-10-25', 'Europe/Madrid'],
    ['2026-10-04', 'Australia/Lord_Howe'], ['2026-04-05', 'Australia/Lord_Howe'],
    ['2030-01-07', 'Asia/Kathmandu'], ['2030-01-07', 'UTC'] ]) {
    const f = calendarFixture({ dates: [date], timeZone, roomCount: 1, doctorCount: 1 });
    assert.deepEqual(calendarProjection(availability.solutionsForCalendar, f, { resolveInstant: memo }),
      calendarProjection(previous.solutionsForCalendar, f));
    const options = { exactStartLocal: `${date}T02:30`, fromLocal: '02:00', toLocal: '04:00' };
    assert.deepEqual(calendarProjection(availability.solutionsForCalendar, f, { ...options, resolveInstant: memo }),
      calendarProjection(previous.solutionsForCalendar, f, options));
  }
});

test('excluded starts are filtered before clock work; memo reuses only clock across independent pair searches', () => {
  const f = calendarFixture({ roomCount: 2, doctorCount: 2 });
  let calls = 0;
  const memo = createAvailabilityLocalInstantResolver((...args) => { calls++; return resolveLocalInstant(...args); });
  const result = calendarProjection(availability.solutionsForCalendar, f, { fromLocal: '09:00', toLocal: '10:00', resolveInstant: memo });
  assert.equal(calls, 13, '12 five-minute starts and one day-end, reused by four resource pairs');
  assert(result.some(row => row.slots.length));
  const again = calendarProjection(availability.solutionsForCalendar, f, { fromLocal: '20:00', toLocal: '09:00', resolveInstant: memo });
  assert(again.every(row => !row.slots.length && !row.unavailable.length));
  assert.equal(calls, 13, 'an empty range performs no excluded start conversion');
  f.context.doctors.get(1).busy.push({ start: '2030-01-07T08:00:00Z', end: '2030-01-07T09:00:00Z', can_share: false });
  const changed = calendarProjection(availability.solutionsForCalendar, f, { fromLocal: '09:00', toLocal: '10:00', resolveInstant: memo });
  assert.notDeepEqual(changed, result, 'even reusing clock values does not cache occupancy or solutions');
});

test('a mutated unavailable callback Date does not poison later pairs using the same clock memo', () => {
  const f = calendarFixture({ roomCount: 1, doctorCount: 1 });
  const memo = createAvailabilityLocalInstantResolver();
  const args = { profile: f.profile, context: f.context, date: f.dates[0], stepMinutes: 5,
    fromLocal: '08:00', toLocal: '09:00', now: new Date('2020-01-01'), resolveInstant: memo };
  availability.solutionsForCalendar({ ...args, onUnavailable: date => date.setUTCFullYear(1999) });
  const captured = [];
  availability.solutionsForCalendar({ ...args, onUnavailable: date => captured.push(date.toISOString()) });
  assert.equal(captured.length, 12); assert(captured.every(value => value.startsWith('2030-01-07')));
});

test('actual grid/summary/slots controller shares clock only within each request and reloads resource context', async () => {
  const file = require.resolve('../../controllers/disponibilidad.controller'), localRequire = createRequire(file);
  const f = calendarFixture(), stats = { resolvers: 0, context: 0, acl: 0, clock: [] };
  const clinic = { id_clinica: 72, configuracion: { timezone: 'Europe/Madrid' } }, handlers = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { exports: handlers, console, Date, Map, Set, Promise,
    require: name => {
      if (name === '../../models') return { Sequelize: { Op: {} }, Clinica: { findByPk: async () => clinic } };
      if (name === 'express-async-handler') return fn => fn;
      if (name === '../lib/access-policy') return { assertUserCanAccessFeature: async () => { stats.acl++; } };
      if (name === '../lib/availability-local-instants') return { createAvailabilityLocalInstantResolver: () => {
        const bucket = []; stats.clock.push(bucket); stats.resolvers++;
        return createAvailabilityLocalInstantResolver((...args) => { bucket.push(args); return resolveLocalInstant(...args); });
      } };
      if (name === '../services/treatmentBookingProfile.service') return { ...localRequire(name),
        loadScopedTreatment: async () => ({}), requireOperationalProfile: () => f.profile,
        bookingCapabilities: () => ({ simple: true, multi: true, relativeSteps: true }) };
      if (name === '../services/appointmentBookingAvailability.service') return { ...availability,
        loadBookingContext: async () => { stats.context++; return f.context; } };
      return localRequire(name);
    } });
  const base = { clinica_id: '72', tratamiento_id: '99', dates: f.dates, duracion_min: '30', granularity_min: '5',
    from_local: '09:00', to_local: '12:00', mode: 'installation', column_ids: f.roomIds, peer_doctor_ids: f.doctorIds };
  const call = async (route, overrides = {}) => {
    const res = { json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; }, status(value) { this.statusCode = value; return this; } };
    await handlers[route]({ userData: { userId: 1 }, query: { ...base, ...overrides } }, res);
    return res.body;
  };
  const before = await call('grid');
  assert.equal(stats.resolvers, 1); assert.equal(stats.context, 1); assert.equal(stats.acl, 1);
  assert.equal(stats.clock[0].length, 38, '36 visible starts, explicit range-end and day-end, not four times that');
  f.context.doctors.get(1).busy.push({ start: '2030-01-07T08:00:00Z', end: '2030-01-07T11:00:00Z', can_share: false });
  assert.notDeepEqual(await call('grid'), before);
  assert.equal(stats.resolvers, 2); assert.equal(stats.context, 2); assert.equal(stats.clock[1].length, 38);
  assert.equal((await call('summary')).by_day[f.dates[0]], true);
  assert.equal(stats.resolvers, 3); assert.equal(stats.context, 3);
  const slots = await call('slots', { fecha_local: f.dates[0], doctor_id: '2', instalacion_ids: f.roomIds,
    include_unavailable: 'true' });
  assert(Object.values(slots.slots_by_instalacion).some(rows => rows.length));
  assert.equal(stats.resolvers, 4); assert.equal(stats.context, 4); assert.equal(stats.clock[3].length, 38);
});

'use strict';

// Reproducible pure CPU benchmark, not a production latency/SLA claim.
// node src/scripts/tests/availability_calendar_instants.benchmark.js
// Uses fictional resources and actual solver/diagnostics; no SQL, HTTP, auth,
// providers or patient data. The reference reverses only filter placement and
// uses the native uncached clock resolver, preserving all booking rules.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const availability = require('../../services/appointmentBookingAvailability.service');
const { resolveLocalInstant } = require('../../lib/voucher-schedule-calendar');
const { createAvailabilityLocalInstantResolver } = require('../../lib/availability-local-instants');
const { referenceCalendarService, calendarFixture, calendarProjection } = require('./helpers/availability-calendar-instants-fixture');
const previous = referenceCalendarService();
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = value => Math.round(value * 100) / 100;
const sourceHashes = Object.fromEntries(['../../lib/availability-local-instants', '../../controllers/disponibilidad.controller',
  '../../services/appointmentBookingAvailability.service', './helpers/availability-calendar-instants-fixture']
  .map(name => [name, createHash('sha256').update(fs.readFileSync(require.resolve(name))).digest('hex')]));

function measured(fixture, options, optimized) {
  let nativeClockCalls = 0;
  const native = (...args) => { nativeClockCalls++; return resolveLocalInstant(...args); };
  const resolver = optimized ? createAvailabilityLocalInstantResolver(native) : native;
  const cpu = process.cpuUsage(), started = performance.now();
  const output = calendarProjection(optimized ? availability.solutionsForCalendar : previous.solutionsForCalendar,
    fixture, { ...options, resolveInstant: resolver });
  const spent = process.cpuUsage(cpu);
  return { output, sample: { wall_ms: round(performance.now() - started),
    cpu_ms: round((spent.user + spent.system) / 1000), native_clock_calls: nativeClockCalls } };
}

const day = ['2030-01-07'], week = Array.from({ length: 7 }, (_, i) => `2030-01-${String(7 + i).padStart(2, '0')}`);
const specimens = [
  ['day24pairs-visible-range', calendarFixture({ dates: day, roomCount: 6, doctorCount: 4, dense: true }), { fromLocal: '09:00', toLocal: '20:00' }],
  ['day24pairs-full-day', calendarFixture({ dates: day, roomCount: 6, doctorCount: 4, dense: true }), {}],
  ['week6pairs-visible-range', calendarFixture({ dates: week, roomCount: 3, doctorCount: 2, dense: true }), { fromLocal: '09:00', toLocal: '20:00' }],
  ['week6pairs-full-day', calendarFixture({ dates: week, roomCount: 3, doctorCount: 2, dense: true }), {}],
];
const warm = calendarFixture({ roomCount: 1, doctorCount: 1, dense: true });
measured(warm, {}, false); measured(warm, {}, true);
console.log(JSON.stringify({ benchmark: 'availability-calendar-pure-clock', node: process.version,
  scope: 'synthetic CPU/service only; no database/network/provider; no production latency claim', source_sha256: sourceHashes }));
for (const [label, fixture, options] of specimens) {
  const before = [], after = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    // Alternate order to reduce cold-start/order bias; compare whole output,
    // including every receipt hash, restriction and unavailable diagnostic.
    const first = measured(fixture, options, repeat % 2 === 1);
    const second = measured(fixture, options, repeat % 2 === 0);
    const old = repeat % 2 ? second : first, current = repeat % 2 ? first : second;
    assert.deepEqual(current.output, old.output, label);
    before.push(old.sample); after.push(current.sample);
  }
  console.log(JSON.stringify({ label, dates: fixture.dates.length, pairs: fixture.pairs.length, repeats: 3,
    exact_output_parity: true, before: { samples: before, median_wall_ms: median(before.map(row => row.wall_ms)),
      median_cpu_ms: median(before.map(row => row.cpu_ms)) },
    after: { samples: after, median_wall_ms: median(after.map(row => row.wall_ms)),
      median_cpu_ms: median(after.map(row => row.cpu_ms)) } }));
}

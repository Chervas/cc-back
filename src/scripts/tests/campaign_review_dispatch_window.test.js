'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const fs = require('node:fs');
const vm = require('node:vm');
const { usesExplicitDispatchWindow, normalizeWhatsappDispatchWindow } = require('../../lib/marketing-dispatch-window');

test('specific review dispatch time preserves its explicit window', () => {
  assert.equal(usesExplicitDispatchWindow({ time_mode: 'specific_time' }), true);
  assert.equal(usesExplicitDispatchWindow({ timeMode: 'specific_time' }), true);
});

test('clinic-hours dispatch remains eligible for calendar hydration', () => {
  assert.equal(usesExplicitDispatchWindow({ time_mode: 'clinic_hours' }), false);
  assert.equal(usesExplicitDispatchWindow({}), false);
});

test('mass WhatsApp window accepts the clinic schedule or a validated local time range', () => {
  assert.deepEqual(normalizeWhatsappDispatchWindow({ mode: 'clinic_hours', start_time: '08:00' }), { mode: 'clinic_hours' });
  const window = { mode: 'custom', start_time: '09:30', end_time: '19:15', include_weekends: false };
  assert.deepEqual(normalizeWhatsappDispatchWindow(window), window);
  for (const change of [{ end_time: '09:30' }, { start_time: '21:30' }, { include_weekends: 'false' }, { start_time: ['09:30'] }]) {
    assert.throws(() => normalizeWhatsappDispatchWindow({ ...window, ...change }), { code: 'whatsapp_dispatch_window_invalid' });
  }
});

test('dispatch uses the campaign window across batches and still reads the clinic calendar and legacy review window', async () => {
  const source = fs.readFileSync(require.resolve('../../services/marketingBulkSends.service'), 'utf8');
  const start = source.indexOf('async function resolveDispatchBusinessHoursForList(');
  const end = source.indexOf('async function deferredDispatchAllowedAt(', start);
  assert.ok(start > 0 && end > start);
  const calendar = { source: 'clinic_hours' };
  const resolve = vm.runInNewContext(source.slice(start, end) + '\nresolveDispatchBusinessHoursForList;', {
    normalizeBusinessHours: value => value,
    normalizeDispatchContext: value => value,
    isReviewRequestList: list => list.criteria?.review_request === true,
    usesExplicitDispatchWindow,
    hydrateDispatchBusinessHoursForList: async () => calendar,
    channelSchedules: { TIMEZONE: 'Europe/Madrid' },
  });
  const window = { mode: 'custom', start_time: '09:30', end_time: '19:15', include_weekends: false };
  const massSend = { criteria: { whatsapp_dispatch_window: window } };
  let hours = await resolve(massSend, {}, {});
  assert.equal(hours.start_time, '09:30');
  assert.equal(hours.end_time, '19:15');
  assert.equal(hours.timezone, 'Europe/Madrid');
  assert.deepEqual([...hours.allowed_weekdays], [1, 2, 3, 4, 5]);
  window.include_weekends = true;
  hours = await resolve(massSend, {}, {});
  assert.deepEqual([...hours.allowed_weekdays], [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(await resolve({ criteria: { whatsapp_dispatch_window: { mode: 'clinic_hours' } } }, {}, {}), calendar);
  const previous = { start_time: '10:00', end_time: '12:30' };
  assert.equal(await resolve({ criteria: { review_request: true } }, {}, { time_mode: 'specific_time', business_hours: previous }), previous);
});

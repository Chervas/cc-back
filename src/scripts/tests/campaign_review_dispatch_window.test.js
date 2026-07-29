'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { usesExplicitDispatchWindow } = require('../../lib/marketing-dispatch-window');

test('specific review dispatch time preserves its explicit window', () => {
  assert.equal(usesExplicitDispatchWindow({ time_mode: 'specific_time' }), true);
  assert.equal(usesExplicitDispatchWindow({ timeMode: 'specific_time' }), true);
});

test('clinic-hours dispatch remains eligible for calendar hydration', () => {
  assert.equal(usesExplicitDispatchWindow({ time_mode: 'clinic_hours' }), false);
  assert.equal(usesExplicitDispatchWindow({}), false);
});

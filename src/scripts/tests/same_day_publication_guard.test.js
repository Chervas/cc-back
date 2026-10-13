'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPreservedVersion: check } = require('../promote-same-day-no-action');
const old = { id: 9, public_id: 'family', is_active: 1, published_at: '2026-10-01', updated_at: '2026-10-01',
  nodes: [{ id: 'N3', config: { a: 1, b: 2 } }], trigger_config: { hour: '08:00' }, clinic_id: 35 };
const families = new Set(['family']);

test('historical guards allow only native sibling deactivation and timestamps within the selected families', () => {
  check(old, { ...old, is_active: 0, updated_at: '2026-10-13' }, families);
  check(old, { ...old, nodes: [{ id: 'N3', config: { b: 2, a: 1 } }] }, families);
  check(old, old, families);
  assert.throws(() => check(old, { ...old, updated_at: '2026-10-13' }, new Set()), /version_changed/);
  assert.throws(() => check({ ...old, published_at: null }, { ...old, published_at: null, updated_at: '2026-10-13' }, families), /version_changed/);
});

test('node, scope, trigger and activation changes outside native deactivation remain forbidden', () => {
  for (const patch of [{ nodes: [] }, { trigger_config: { hour: '10:00' } }, { clinic_id: 72 }, { public_id: 'another' }]) {
    assert.throws(() => check(old, { ...old, ...patch }, families), /version_changed/);
  }
  assert.throws(() => check({ ...old, is_active: 0 }, old, families), /version_changed/);
  assert.throws(() => check(old, null, families), /version_deleted/);
});

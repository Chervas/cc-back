'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { appointmentProgramPage } = require('../../lib/appointment-program-catalog');
test('clinic programme catalogue excludes unavailable entries before calculating pages, without patient context', () => {
  const ready = id => ({ id, status: 'active', purchase_enabled: true, commercial_ready: true });
  const items = [ready('a'), { ...ready('draft'), status: 'draft' }, { ...ready('unavailable'), purchase_enabled: false }, ready('b'), { ...ready('unpriced'), commercial_ready: false }, ready('c')];
  assert.deepEqual(appointmentProgramPage(items, { page: 1, pageSize: 2 }), { items: [items[0], items[3]], total: 3, page: 1, page_size: 2 });
  assert.deepEqual(appointmentProgramPage(items, { page: 2, pageSize: 2 }).items, [items[5]]);
  assert.equal(items.length, 6);
});

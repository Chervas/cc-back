'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../lib/clinic-supplies-contract');

test('quantities, dates, structured supplier/product fields reject ambiguous input', () => {
  assert.equal(C.units(0.123), 123);
  for (const value of [-1, NaN, Infinity, 1.0001, '1', null, 1000000001]) assert.throws(() => C.units(value), { code: 'quantity_invalid' });
  assert.throws(() => C.units(0, false), { code: 'quantity_invalid' });
  assert.equal(C.amount(C.units(0.1) + C.units(0.2)), 0.3);
  assert.equal(C.date('2026-10-24'), '2026-10-24');
  for (const value of ['2026-02-30', '2026-13-01', '2026-10-24T12:30', 'bad', 1]) assert.throws(() => C.date(value), { code: 'date_invalid' });
  assert.equal(C.today(new Date('2026-10-24T23:30:00Z'), 'Europe/Madrid'), '2026-10-25');
  assert.throws(() => C.product({ name: 'Material', unit: 'cajas', quantity: 10 }, true), { code: 'fields_invalid' });
  assert.throws(() => C.supplier({ name: 'Proveedor', type: 'laboratory', email: 'bad' }, true), { code: 'email_invalid' });
  assert.throws(() => C.product({ name: 'Material', unit: 'cajas', active: 'false' }, true), { code: 'active_invalid' });
  assert.equal(C.hash({ b: [1, { c: 3, a: 2 }], a: 1 }), C.hash({ a: 1, b: [1, { a: 2, c: 3 }] }));
});

test('controller trusts session actor, rejects scope mismatch and does not expose SQL/storage errors', async () => {
  const { createController } = require('../../controllers/clinicSupplies.controller');
  let seen;
  const controller = createController({ getService: () => ({ createSupplier: async input => { seen = input; return { item: { id: 'created' } }; }, overview: async () => { throw Error('SQL credentials private'); } }) });
  const response = () => ({ statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(v) { this.statusCode = v; return this; }, json(value) { this.body = value; return this; } });
  const request = { params: {}, query: { clinic_id: '72' }, body: { clinic_id: 72, actorId: 999 }, userData: { userId: 7 } };
  let res = response(); await controller.createSupplier(request, res);
  assert.equal(seen.actorId, 7); assert.equal(seen.clinicId, '72'); assert.equal(res.statusCode, 201); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  res = response(); await controller.createSupplier({ ...request, body: { clinic_id: 73 } }, res); assert.equal(res.statusCode, 400); assert.equal(res.body.error.code, 'scope_mismatch');
  res = response(); await controller.overview(request, res); assert.equal(res.statusCode, 500); assert(!JSON.stringify(res.body).includes('credentials'));
});

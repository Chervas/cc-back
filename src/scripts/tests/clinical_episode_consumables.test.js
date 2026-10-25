'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const U = require('../../lib/clinical-episode-consumables');
const product = crypto.randomUUID();
const payload = patch => ({ expected_version: 1, idempotency_key: 'owned-consumption-command', kind: 'consume', lines: [{ product_id: product, expected_product_version: 2, quantity: 0.125 }], ...patch });
test('consumable commands use exact thousandths, positive bounded quantities and stable product CAS without patient data', () => {
  const result = U.command(payload()); assert.equal(result.lines[0].units, 125); assert.equal(result.expected, 1);
  for (const patch of [{ kind: 'other' }, { expected_version: 0 }, { lines: [] }, { lines: [{ product_id: product, expected_product_version: 2, quantity: -1 }] },
    { lines: [{ product_id: product, expected_product_version: 2, quantity: 0.0001 }] }, { lines: [{ product_id: product, expected_product_version: 2, quantity: 0 }] },
    { lines: [...payload().lines, ...payload().lines] }, { patient_id: 11 }, { episode_id: crypto.randomUUID() }]) assert.throws(() => U.command(payload(patch)));
  assert.equal(U.command(payload({ kind: 'return' })).kind, 'return');
});
test('clinical consumption totals keep exact balances and historical product labels without leaking stock costs', () => {
  const rows = [{ product_id: product, product_name: 'Material ficticio', unit: 'unidades', quantity: '1.125' },
    { product_id: product, product_name: 'Material renombrado', unit: 'unidades', quantity: '-0.125' }];
  assert.deepEqual(U.totals(rows), [{ product_id: product, name: 'Material ficticio', unit: 'unidades', quantity: 1 }]);
  assert.deepEqual(U.totals([...rows, { ...rows[0], quantity: '-1.000' }]), []);
});

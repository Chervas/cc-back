'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { globalManagedQuote, globalManagedRequest, publicRequestedQuote } = require('../../services/managedCampaignQuote.service');

test('the approved 650 EUR investment example totals 1254 EUR', () => {
  assert.deepEqual(globalManagedQuote(650), { version: 'global-managed-v1', currency: 'EUR', period: 'monthly',
    investment: 650, software: 149, management: 130, reception: 325, minimum_adjustment: 0, total: 1254, binding: false });
});
test('the monthly floor is explicit, not disguised as media investment', () => {
  const quote = globalManagedQuote(100);
  assert.equal(quote.investment, 100); assert.equal(quote.total, 999);
  assert.equal(quote.minimum_adjustment, 680);
  assert.equal(quote.investment + quote.software + quote.management + quote.reception + quote.minimum_adjustment, quote.total);
});
test('invalid amounts and unknown quote versions cannot create a request', () => {
  for (const amount of [0, 99, 50001, 650.5, NaN, Infinity, '650']) assert.throws(() => globalManagedQuote(amount));
  assert.throws(() => globalManagedRequest({ quote_version: 'old', investment: 650, goal: 'New patients' }));
  assert.throws(() => globalManagedRequest({ quote_version: 'global-managed-v1', investment: 650, goal: '   ' }));
});
test('request accepts only goal and investment, never client totals, funding or approvals', () => {
  const input = { quote_version: 'global-managed-v1', investment: 651, goal: '  Nuevos pacientes  ' };
  const result = globalManagedRequest(input);
  assert.equal(result.goal, 'Nuevos pacientes'); assert.equal(result.quote.total, 1255.7);
  for (const extra of ['total', 'paid', 'approved', 'stripe_account', 'commission']) assert.throws(() => globalManagedRequest({ ...input, [extra]: 1 }));
});
test('client projection recomputes allowlisted quote fields and exposes no operational data', () => {
  const quote = publicRequestedQuote({ version: 'global-managed-v1', investment: 650, internal_token: 'secret', total: 1 });
  assert.equal(quote.total, 1254); assert.equal(quote.internal_token, undefined);
  assert.equal(publicRequestedQuote({ version: 'unrecognized', investment: 650 }), null);
});

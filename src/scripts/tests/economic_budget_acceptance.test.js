'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { acceptedAmount, acceptanceQuote, discountedAmount, payableAmount } = require('../../lib/economicBudgetAcceptance');
const prices = require('../../lib/economicPriceProfile');
const version = (patch = {}) => ({
  lines: [{ key: 'one', total: 123.45 }, { key: 'two', total: 500 }],
  totals: { total: 561.10 }, payment_proposal: { option_discounts: { single: 5, clinic_installments: 0 } }, ...patch,
});

test('full and partial acceptance preserve the rounded global offer and selected payment discount', () => {
  assert.equal(acceptedAmount(version(), ['one', 'two']), 561.1);
  assert.equal(acceptedAmount(version(), ['one']), 111.1);
  assert.equal(acceptedAmount(version(), ['two']), 450);
  assert.equal(acceptedAmount(version(), ['one', 'two'], 'single'), 533.05);
  assert.equal(acceptedAmount(version(), ['one'], 'single'), 105.55);
  assert.equal(acceptedAmount(version(), ['one'], 'clinic_installments'), 111.1);
  assert.equal(acceptedAmount(version(), ['one'], 'patient_choice'), 111.1);
});

test('payment discount rounds cents deterministically, including half-cent boundaries', () => {
  assert.equal(discountedAmount(561.10, 5), 533.05);
  assert.equal(discountedAmount(0.01, 50), 0.01);
  assert.equal(discountedAmount(0.03, 50), 0.02);
  assert.equal(discountedAmount(100, 12.34), 87.66);
  assert.equal(discountedAmount(1e10, 0.01), 9999000000);
  assert.equal(discountedAmount(100, 100), 0);
});

test('display quote exposes the same allocated cents as acceptance, including partial and zero offers', () => {
  assert.deepEqual(acceptanceQuote(version(), ['one'], 'single'), {
    accepted_amount: 105.55, original_amount: 123.45, discount_amount: 17.9, lines: [{ key: 'one', total: 105.55 }],
  });
  const quote = acceptanceQuote(version(), ['one', 'two'], 'single');
  assert.equal(quote.accepted_amount, acceptedAmount(version(), ['one', 'two'], 'single'));
  assert.equal(quote.lines.reduce((sum, line) => sum + Math.round(line.total * 100), 0), 53305);
  const zero = acceptanceQuote(version({ payment_proposal: { option_discounts: { single: 100 } } }), ['one'], 'single');
  assert.equal(zero.accepted_amount, 0); assert.equal(zero.lines[0].total, 0); assert.equal(zero.discount_amount, 123.45);
});

test('accepted zero is final, not replaced by the undiscounted offer in balances or collection limits', () => {
  assert.equal(acceptedAmount(version(), ['one'], 'single'), 105.55);
  for (const status of ['accepted', 'partially_accepted']) {
    assert.equal(payableAmount({ status, accepted_amount: '0.00' }, version()), 0);
    assert.equal(payableAmount({ status, accepted_amount: '105.55' }, version()), 105.55);
  }
  assert.equal(payableAmount({ status: 'presented', accepted_amount: 0 }, version()), 561.1);
  assert.equal(payableAmount({ status: 'superseded', accepted_amount: '123.45' }, version()), 123.45);
});

test('old snapshots without fiscal profiles or option discounts still use their stored total', () => {
  const legacy = version({ payment_proposal: { mode: 'single' } });
  assert.equal(acceptedAmount(legacy, ['one', 'two'], 'single'), 561.1);
  assert.equal(acceptedAmount({ ...legacy, lines: JSON.stringify(legacy.lines), totals: JSON.stringify(legacy.totals),
    payment_proposal: JSON.stringify(legacy.payment_proposal) }, ['one', 'one']), 111.1);
});

test('already offered payment amounts retain their exact cents instead of silently repricing old proposals', () => {
  const saved = version({ payment_proposal: { single_payment: { amount: 533.04 }, option_discounts: { single: 5 } } });
  assert.equal(acceptedAmount(saved, ['one', 'two'], 'single'), 533.04);
  assert.equal(Math.round(acceptedAmount(saved, ['one'], 'single') * 100)
    + Math.round(acceptedAmount(saved, ['two'], 'single') * 100), 53304);
  for (const [mode, proposal] of [
    ['clinic_installments', { clinic_installments: { amount: 500 } }],
    ['patient_balance', { balance_application: { amount: 20, option_amount: 500 } }],
    ['external_financing', { financing_options: [{ option_amount: 500, total_financed: 600 }] }],
  ]) assert.equal(acceptedAmount(version({ payment_proposal: proposal }), ['one', 'two'], mode), 500);
  assert.throws(() => acceptedAmount(version({ payment_proposal: { single_payment: { amount: 999 } } }), ['one'], 'single'));
});

test('acceptance does not mutate snapshots, re-read catalog prices or apply fiscal tax a second time', () => {
  const profile = { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null };
  const saved = version({ lines: [{ key: 'one', treatment_id: 1, total: 145,
    price_snapshot: { schema_version: 1, source: { kind: 'treatment', id: 1 }, profile } }], totals: { total: 130.5 } });
  const original = JSON.stringify(saved);
  assert.equal(acceptedAmount(saved, ['one'], 'single'), 123.98);
  assert.equal(JSON.stringify(saved), original);
});

test('invalid or foreign line keys and inconsistent totals fail before accepting money', () => {
  for (const keys of [[], ['missing'], ['one', 'missing'], null, 'one']) {
    assert.throws(() => acceptedAmount(version(), keys), { code: 'budget_acceptance_amount_invalid' });
  }
  assert.throws(() => acceptedAmount(version({ lines: [{ key: 'one', total: 1 }, { key: 'one', total: 1 }] }), ['one']));
  assert.throws(() => acceptedAmount(version({ totals: { total: 1000 } }), ['one']));
  for (const total of [null, '', ' ', true, [], -1, NaN, Infinity, 1e20]) {
    assert.throws(() => acceptedAmount(version({ totals: { total } }), ['one']));
  }
  for (const discount of [true, null, '', -1, 101, NaN, 1.234]) {
    assert.throws(() => discountedAmount(100, discount), { code: 'budget_acceptance_amount_invalid' });
  }
});

test('partial line allocation reconciles the full global total including residual cents', () => {
  for (let i = 1; i <= 100; i++) {
    const lines = [{ key: 'a', total: i * 0.03 }, { key: 'b', total: i * 0.07 }, { key: 'c', total: i * 0.11 }];
    const total = discountedAmount(lines.reduce((sum, line) => sum + line.total, 0), 13);
    const offer = version({ lines, totals: { total } });
    const amounts = lines.map(line => acceptedAmount(offer, [line.key]));
    assert.equal(amounts.reduce((sum, amount) => sum + Math.round(amount * 100), 0), Math.round(total * 100));
    assert.deepEqual(amounts, prices.budgetBreakdown(lines, total).lines.map(line => line.gross_after_global_discount));
  }
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const L = require('../../lib/economic-concept-ledger');
const funding = require('../../services/economicFunding.service').createService({ db: {} });
const fiscal = require('../../services/economicFiscalCoverage.service').createService({ db: {}, helpers: {} });
const profile = { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null };
const part = (patch = {}) => ({ funding_key: 'payment:qa:0', source_kind: 'payment', payment_id: 1, budget_id: 1, line_key: 'main', amount: 1.21, taxable_base: 1, tax_amount: 0.21, snapshot: { profile, attribution: 'explicit', description: 'Concepto' }, ...patch });
const data = (patch = {}) => ({ parts: [part()], budgets: [{ id: 1, public_id: 'budget', current_version: 1 }], payments: [{ id: 1, public_id: 'cash', status: 'confirmed' }], adjustments: [], coverages: [], documents: [], ...patch });
const line = { key: 'main', name: 'Concepto', treatment_id: 1, quantity: 3, entitlement_units: 3, total: 363, contracted_amount: 363, price_snapshot: { schema_version: 1, source: { kind: 'treatment', id: 1 }, profile } };
test('money quote preserves exact cents only across explicitly selected new concepts; stable hashes distinguish dates', () => {
  assert.deepEqual(L.allocate(100, [100, 100, 100]), [34, 33, 33]); assert.equal(L.allocate(161, [20, 200, 500]).reduce((n, x) => n + x, 0), 161);
  assert.notEqual(L.hash({ d: new Date('2025-01-01') }), L.hash({ d: new Date('2025-01-02') }));
  assert.equal(L.hash({ b: 1, a: 2 }), L.hash({ a: 2, b: 1 }));
  assert.throws(() => L.allocate(201, [100, 100]), { code: 'economic_funding_exceeds_concept' });
});
test('accepted historical version retains its original tax and discount after head status changes', () => {
  const b = { status: 'superseded', accepted_amount: 363 }, v = { version_number: 1, lines: [line] };
  assert.deepEqual(L.acceptedLines(b, v, [{ version_number: 1, event_type: 'accepted', metadata: { accepted_amount: 363, accepted_line_keys: ['main'] } }]).map(row => row.contracted_amount), [363]);
  assert.equal(L.acceptedLines({ status: 'draft' }, v, []).length, 0);
});
test('receipt and invoice coverage are independent and signed rectifications restore only the same type', () => {
  const d = data({ coverages: [{ funding_key: 'payment:qa:0', document_id: 10, document_type: 'receipt', status: 'issued', amount: 1.21 }, { funding_key: 'payment:qa:0', document_id: 11, document_type: 'invoice', status: 'issued', amount: 1.21 }, { funding_key: 'payment:qa:0', document_id: 12, document_type: 'credit_note', status: 'issued', amount: -0.21 }], adjustments: [{ funding_allocations: [{ funding_key: 'payment:qa:0', amount: 0.21 }] }] });
  assert.equal(funding.available(d.parts[0], d, 'invoice'), 0); assert.equal(funding.available(d.parts[0], d, 'receipt'), 0);
  const s = funding.fiscalSummary(d.parts, d); assert.equal(s.invoice.documented, 1); assert.equal(s.receipt.documented, 1.21); assert.equal(s.invoice.amount, 1);
});
test('unapplied wallet advance is receiptable but not an invoice source', () => {
  const d = data({ parts: [part({ budget_id: null, line_key: null })] }); const s = funding.fiscalSummary(d.parts, d);
  assert.equal(s.invoice.amount, 0); assert.equal(s.invoice.remaining, 0); assert.equal(s.receipt.remaining, 1.21);
  assert.throws(() => fiscal.projection(d, { type: 'payment', id: 'cash' }, 'invoice', {}), { code: 'fiscal_source_amount_exceeded' });
  assert.equal(fiscal.projection(d, { type: 'payment', id: 'cash' }, 'receipt', {}).totals.total, 1.21);
});
test('locked fiscal projection rejects oversubscription, foreign funding selection and non-invoice manual credit', () => {
  const d = data();
  assert.throws(() => fiscal.projection(d, { type: 'payment', id: 'cash' }, 'invoice', { source_amount: 1.22 }), { code: 'fiscal_source_amount_exceeded' });
  assert.throws(() => fiscal.projection(d, { type: 'payment', id: 'cash' }, 'invoice', { funding_keys: ['foreign'] }), { code: 'fiscal_funding_selection_invalid' });
  assert.throws(() => fiscal.projection(d, { type: 'payment', id: 'cash' }, 'credit_note', {}), { code: 'fiscal_rectification_origin_required' });
  const result = fiscal.projection(d, { type: 'budget', id: 'budget' }, 'invoice', { lines: [{ total: 999 }] }); assert.equal(result.totals.total, 1.21); assert.equal(result.lines[0].total, 1.21);
});
test('last partially documented cent conserves original VAT base exactly', () => {
  const d = data({ coverages: [{ document_id: 1, funding_key: 'payment:qa:0', document_type: 'invoice', amount: 1.2, taxable_base: 0.99, tax_amount: 0.21, status: 'issued' }] });
  const r = fiscal.projection(d, { type: 'payment', id: 'cash' }, 'invoice', {}); assert.deepEqual(r.totals, { currency: 'EUR', total: 0.01, taxable_base: 0.01, taxes: 0 });
});
test('legacy invoice without coverage exposes unknown totals and historical reference, never a false new allowance', () => {
  const d = data({ documents: [{ id: 9, public_id: 'old', budget_id: 1, document_type: 'invoice', status: 'issued', number: 'OLD', totals: { total: 1.21 } }] });
  const s = funding.fiscalSummary(d.parts, d); assert.equal(s.invoice.review_required, true); assert.equal(s.invoice.documented, null); assert.equal(s.invoice.remaining, 0); assert.equal(s.invoice.documents[0].number, 'OLD');
  assert.throws(() => fiscal.projection(d, { type: 'payment', id: 'cash' }, 'invoice', {}), { code: 'fiscal_legacy_coverage_review_required' });
});
test('voucher session progress does not mix identical line keys from different budgets', () => {
  const concepts = require('../../services/economicConcepts.service').createService({ db: {} }), d = { ...data({ parts: [] }), budget: { id: 2 }, version: { version_number: 1 }, vouchers: [{ id: 99, budget_id: 1, budget_line_key: 'main', available_units: 0 }, { id: 88, budget_id: 2, budget_line_key: 'main', available_units: 3, public_id: 'right' }], movements: [{ voucher_id: 99, movement_type: 'consumption', units: -3 }], appointments: [], links: [] };
  const p = concepts.progress(line, d); assert.equal(p.used, 0); assert.equal(p.pending, 3); assert.equal(p.fulfillment_voucher_id, 'right'); assert.equal(p.can_cancel, true); assert.equal(p.can_refund, false);
});
test('legacy generic cash keeps all concept paid facts unknown rather than dividing by price or order', () => {
  const concepts = require('../../services/economicConcepts.service').createService({ db: {} }), d = { ...data({ parts: [part({ line_key: null, amount: 100 })] }), budget: { id: 1 }, version: { version_number: 1 }, vouchers: [], movements: [], appointments: [], links: [] };
  const p = concepts.progress(line, d); assert.equal(p.financial.paid, null); assert.equal(p.financial.invoiced, null); assert.equal(p.financial.attribution, 'unassigned'); assert.equal(p.can_cancel, false);
});
test('cancel command requires literal confirmation, integer units, explicit refund method and bounded reason', () => {
  const base = { expected_version: 1, units: 1, settlement: 'refund', refund_method: 'cash', reason: 'Revisado' };
  assert.equal(L.cancellationCommand(base, true).refund_method, 'cash');
  for (const change of [{ units: 1.5 }, { reason: 'x'.repeat(1001) }, { settlement: 'automatic' }]) assert.throws(() => L.cancellationCommand({ ...base, ...change }, true), { code: 'concept_cancel_invalid' });
  assert.throws(() => L.cancellationCommand(base), { code: 'concept_cancel_confirmation_required' }); assert.throws(() => L.cancellationCommand({ ...base, refund_method: null }, true), { code: 'concept_refund_method_required' });
});
test('appointment pending subtracts cancelled obligation and retains returned funds separately', () => {
  const source = fs.readFileSync(require.resolve('../../services/appointmentPaymentSummary.service'), 'utf8'), code = source.slice(source.indexOf('function pendingAmount'), source.indexOf('async function attach'));
  const fn = vm.runInNewContext(code + ';pendingAmount', { parse: x => x, round: n => Math.round(n * 100) / 100 });
  const payment = { status: 'confirmed', application: { allocations: [{ target_type: 'budget_line', amount: 100 }] } };
  assert.equal(fn({ accepted_amount: 300 }, [payment], [], [{ cancelled_amount: 100, refund_amount: 0, credited_amount: 0 }]), 100);
  assert.equal(fn({ accepted_amount: 300 }, [{ ...payment, application: { allocations: [{ target_type: 'budget_line', amount: 300 }] } }], [], [{ cancelled_amount: 100, refund_amount: 100 }]), 0);
});
test('cash reconciliation counts manual refunds as outflows and reduces tender, without another cash movement', async () => {
  const source = fs.readFileSync(require.resolve('../../services/accounting.service'), 'utf8'), code = source.slice(source.indexOf('async function cashForDate'), source.indexOf('async function getWorkspace'));
  const refunds = [{ id: 'refund', refund_method: 'cash', refund_amount: 30 }, { id: 'refund-card', refund_method: 'card', refund_amount: 10 }];
  const fn = vm.runInNewContext(code + ';cashForDate', { DEFAULT_CLINIC_TIME_ZONE: 'UTC', localDateTimeToUtc: date => date, nextDate: date => date, Op: { gte: Symbol(), lt: Symbol(), gt: Symbol() }, money: n => Math.round(Number(n) * 100) / 100,
    EconomicPayment: { findAll: async () => [{ public_id: 'cash', method: 'cash', amount: 100 }, { public_id: 'card', method: 'card', amount: 50 }] }, AccountingExpenseDocument: { findAll: async () => [] }, AccountingCashMovement: { findAll: async () => [] }, db: { EconomicConceptAdjustment: { findAll: async () => refunds } } });
  const r = await fn(100, '2026-10-25', 20); assert.equal(r.patient_refunds, 30); assert.equal(r.cash_outflows, 30); assert.equal(r.expected_cash, 90); assert.equal(r.tender_reconciliation.cash, 70); assert.equal(r.tender_reconciliation.card, 40); assert.deepEqual([...r.source_ids.concept_refunds], ['refund','refund-card']);
});

test('accounting CSV identifies receipts and linked rectifications separately from sales invoices', async () => {
  const source = fs.readFileSync(require.resolve('../../services/accounting.service'), 'utf8'), code = source.slice(source.indexOf('function csvCell'), source.indexOf('module.exports'));
  const fn = vm.runInNewContext(code + ';exportCsv', { getWorkspace: async () => ({ issued_documents: ['receipt','invoice','credit_note'].map((type, i) => ({ document_type: type, issue_date: '2026-10-25', number: 'QA' + i, recipient: {}, totals: {}, status: 'issued' })), received_documents: [] }) });
  const csv = await fn({ clinicId: 1 }); assert.match(csv, /"recibo"/); assert.match(csv, /"emitida"/); assert.match(csv, /"rectificativa"/);
});

test('budget numbering remains independent from the new fiscal counter', async () => {
  const source = fs.readFileSync(require.resolve('../../services/patientEconomics.service'), 'utf8'), start = source.indexOf('async function nextBudgetNumber'), end = source.indexOf('\nasync function', start + 5), code = source.slice(start, end);
  const transaction = { LOCK: { UPDATE: 'UPDATE' } }, fn = vm.runInNewContext(code + ';nextBudgetNumber', { Date, Op: { like: Symbol() }, Clinica: { findByPk: async () => ({}) }, EconomicBudget: { findAll: async () => [] } });
  assert.match(await fn(100, transaction), /0001$/);
});

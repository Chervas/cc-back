'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('../../lib/economicFinancing');
const { createService } = require('../../services/economicFinancing.service');
const budget = () => ({ id: 8, public_id: 'budget', current_version: 2, status: 'accepted', accepted_amount: 500, clinic_id: 72, patient_id: 11 });
const version = () => ({ payment_proposal: { financing_options: [{ months: 12, provider: 'Prueba', entry: 100, option_amount: 500 }] } });
const accepted = () => ({ id: 1, version_number: 2, event_type: 'accepted', metadata: { selected_payment_mode: 'external_financing', selected_financing_months: 12, financing_provider: 'Prueba', financing_status: 'pending_approval' } });
const command = () => ({ expected_version: 2, expected_financing_revision: 0, idempotency_key: 'fictitious-command-one', approval_status: 'approved', financed_amount: 400, reference: 'DEMO', notes: 'Seguimiento manual ficticio' });
const payment = (amount, patch = {}) => ({ status: 'confirmed', method: 'financing', application: { allocations: [{ target_type: 'budget', amount }] }, ...patch });
function fixture() {
 const b = budget(), events = [accepted()], payments = [], transaction = { LOCK: { UPDATE: 'UPDATE' } }; let writes = 0;
 const db = { sequelize: { transaction: fn => fn(transaction) }, EconomicBudget: { findOne: async opts => { assert.equal(opts.lock, 'UPDATE'); return b; } },
  EconomicBudgetVersion: { findOne: async () => version() }, EconomicPayment: { findAll: async () => payments },
  EconomicBudgetEvent: { findAll: async () => events, create: async row => { writes++; const event = { ...row, id: events.length + 1 }; events.push(event); return event; } } };
 return { service: createService({ db }), events, payments, budget: b, writes: () => writes };
}
test('approval is persisted and replayed with CAS without creating money or changing acceptance', async () => {
 const f = fixture(), before = JSON.stringify(f.budget), args = { publicId: 'budget', actorId: 4, payload: command() };
 const first = await f.service.update(args); assert.equal(first.financing_summary.approval_status, 'approved'); assert.equal(first.financing_summary.received_amount, 0); assert.equal(first.financing_summary.payout_status, 'pending');
 const again = await f.service.update(args); assert.equal(again.replayed, true); assert.equal(f.writes(), 1); assert.equal(f.payments.length, 0); assert.equal(JSON.stringify(f.budget), before); assert.equal(f.events[1].metadata.no_payment_created, true);
});
test('reusing a receipt with another actor or payload and stale updates cannot overwrite tracking', async () => {
 const f = fixture(), args = { publicId: 'budget', actorId: 4, payload: command() }; await f.service.update(args);
 await assert.rejects(f.service.update({ ...args, actorId: 5 }), { code: 'financing_idempotency_conflict' });
 await assert.rejects(f.service.update({ ...args, payload: { ...command(), financed_amount: 399 } }), { code: 'financing_idempotency_conflict' });
 await assert.rejects(f.service.update({ ...args, payload: { ...command(), idempotency_key: 'fictitious-command-two' } }), { code: 'financing_version_conflict' }); assert.equal(f.writes(), 1);
});
test('payout comes only from confirmed financing allocations, excluding wallet deposits, other methods and voided receipts', () => {
 const events = [accepted(), { event_type: 'financing_updated', version_number: 2, metadata: { revision: 1, approval_status: 'approved', financed_amount: 400 } }];
 const rows = [payment(100), payment(300, { status: 'voided' }), payment(40, { method: 'cash' }), payment(500, { application: { allocations: [{ target_type: 'wallet', amount: 500 }] } })];
 const partial = F.summary(budget(), version(), events, rows); assert.equal(partial.received_amount, 100); assert.equal(partial.pending_amount, 300); assert.equal(partial.payout_status, 'partial');
 assert.equal(F.summary(budget(), version(), events, [payment(400)]).payout_status, 'received'); assert.equal(F.summary(budget(), version(), events, [payment(400, { status: 'voided' })]).payout_status, 'pending');
});
test('legacy paid-by-finance is a declaration, never a confirmed receipt, and partial acceptance does not invent the lender principal', () => {
 const event = accepted(); event.metadata.financing_status = 'paid_by_finance'; const legacy = F.summary(budget(), version(), [event], []);
 assert.equal(legacy.approval_status, 'approved'); assert.equal(legacy.received_amount, 0); assert.equal(legacy.payout_status, 'not_configured'); assert.equal(legacy.legacy_status, 'paid_by_finance'); assert.equal(legacy.proposed_amount, 400);
 assert.equal(F.summary({ ...budget(), accepted_amount: 250, status: 'partially_accepted' }, version(), [event], []).proposed_amount, null);
});
test('only a current accepted financing offer can be tracked and the approved principal cannot exceed acceptance', async () => {
 for (const patch of [{ status: 'draft' }, { status: 'superseded' }]) { const f = fixture(); Object.assign(f.budget, patch); await assert.rejects(f.service.update({ publicId: 'budget', actorId: 4, payload: command() }), { code: 'financing_not_selected' }); assert.equal(f.writes(), 0); }
 const f = fixture(); f.events[0].metadata.selected_payment_mode = 'single'; await assert.rejects(f.service.update({ publicId: 'budget', actorId: 4, payload: command() }), { code: 'financing_not_selected' });
 const over = fixture(); await assert.rejects(over.service.update({ publicId: 'budget', actorId: 4, payload: { ...command(), financed_amount: 500.01 } }), { code: 'financing_amount_exceeds_accepted' });
});
test('bad precision, missing CAS, invented paid statuses and unknown command fields are rejected', () => {
 for (const patch of [{ financed_amount: 1.001 }, { financed_amount: NaN }, { financed_amount: -1 }, { financed_amount: null }, { approval_status: 'paid_by_finance' }, { expected_financing_revision: undefined }, { expected_version: 0 }, { payout_status: 'received' }]) assert.throws(() => F.command({ ...command(), ...patch }));
});

test('legacy object-shaped options or allocations do not break the entire economics workspace', () => {
 const result = F.summary(budget(), { payment_proposal: { financing_options: {} } }, [accepted()], [payment(1, { application: { allocations: {} } })]);
 assert.equal(result.proposed_amount, null); assert.equal(result.received_amount, 0);
 const nullDocument = F.summary(budget(), { payment_proposal: 'null' }, [accepted()], [payment(1, { application: 'null' })]);
 assert.equal(nullDocument.proposed_amount, null); assert.equal(nullDocument.received_amount, 0);
});

test('tracking uses the latest persisted revision even when timeline timestamps have equal resolution', () => {
 const latest = { event_type: 'financing_updated', version_number: 2, metadata: { revision: 2, approval_status: 'rejected', financed_amount: 400 } };
 const previous = { event_type: 'financing_updated', version_number: 2, metadata: { revision: 1, approval_status: 'approved', financed_amount: 400 } };
 const result = F.summary(budget(), version(), [accepted(), latest, previous], [payment(10)]);
 assert.equal(result.revision, 2); assert.equal(result.approval_status, 'rejected'); assert.equal(result.review_required, true); assert.equal(result.received_amount, 10);
});

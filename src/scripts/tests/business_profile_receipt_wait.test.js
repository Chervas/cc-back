'use strict';
const assert = require('node:assert/strict'), test = require('node:test');
const fs = require('node:fs'), vm = require('node:vm');
const policy = require('../../lib/businessProfileReceiptWait');

test('receipt budget follows original admission across restarts and never renews after 24 hours', () => {
  const now = Date.now(), operationId = 'qa-operation';
  const next = (age, previous) => policy.nextReceiptWait({ operationId, previous, now, createdAt: new Date(now - age) });
  assert.equal(next(0).checks, 1); assert.equal(+next(0).waitUntil, now + 60000);
  assert.equal(next(24 * 3600000).review, true);
  assert.equal(next(24 * 3600000).waitUntil, null);
  assert.equal(next(0, { operation_id: operationId, receipt_checks: 7 }).review, true);
  assert.equal(next(0, { operation_id: operationId, receipt_checks: 99 }).checks, 8);
  assert.equal(next(0, { operation_id: 'other', receipt_checks: 7 }).checks, 1);
  assert.equal(policy.nextReceiptWait({ now, operationId, createdAt: 'bad' }).review, true);
  assert.equal(policy.isReceiptWait({ status: 'waiting', waiting_meta: { type: 'delay/fixed' } }), false);
});

test('actual HTTP resume handler rejects GBP waits before enqueuing, preserves scope and ordinary waits', async () => {
  const source = fs.readFileSync(require.resolve('../../controllers/automationsV2.controller'), 'utf8');
  const start = source.indexOf('exports.resumeExecution = async');
  const end = source.indexOf('\nexports.listExecutions', start);
  let scoped = true, queued = 0, triggered = 0;
  const execution = { id: 42, status: 'waiting', waiting_meta: { reason: policy.PENDING_REASON } };
  const context = { exports: {}, require: name => {
    assert.equal(name, '../lib/businessProfileReceiptWait'); return policy;
  }, resolveAccess: async () => ({ user_id: 91002 }), parseIntOrNull: Number, cleanString: value => value || null,
  FlowExecutionV2: { findByPk: async () => execution }, hasScopeAccess: () => scoped,
  jobRequestsService: { enqueueJobRequest: async () => { queued++; return { id: 7, status: 'pending' }; } },
  jobScheduler: { triggerImmediate: async () => { triggered++; } }, mapExecution: value => value, console };
  vm.runInNewContext(source.slice(start, end), context);
  async function call(mode) {
    let status, body;
    const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
    await context.exports.resumeExecution({ params: { id: 42 }, body: { mode }, userData: {} }, res);
    return { status, body };
  }
  for (const review of [false, true]) {
    execution.waiting_meta.manual_review_required = review;
    for (const mode of ['timeout', 'response', undefined]) {
      const result = await call(mode); assert.equal(result.status, 409);
      assert.equal(result.body.error, 'business_profile_receipt_required');
    }
  }
  assert.equal(queued, 0); assert.equal(triggered, 0);
  scoped = false; assert.equal((await call('timeout')).status, 404); assert.equal(queued, 0);
  scoped = true; execution.waiting_meta = { type: 'delay/fixed' };
  assert.equal((await call('timeout')).status, 202); assert.equal(queued, 1); assert.equal(triggered, 1);
});

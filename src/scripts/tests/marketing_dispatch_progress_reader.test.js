'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../services/marketingBulkSends.service.js'), 'utf8');
const start = source.indexOf('async function getDispatchStatus('), end = source.indexOf('\nasync function reconcileBulkSendTemplateCategory(', start);
assert(start > 0 && end > start);
function fixture(status = 'sending') {
  const calls = { loads: 0, reconciles: 0, jobChecks: 0, counterWrites: 0, itemReads: 0, qualityReads: 0, followUps: 0 };
  const filter = { type: 'import_batch', import_batch_id: 'FICTITIOUS_BATCH' };
  const list = { id: 830, criteria: { dispatch: { status, context: 'review_request' } } };
  const sandbox = { module: { exports: {} },
    MarketingPatientList: { findByPk: async () => { calls.loads++; return list; } },
    ensureScopeAccess: (_list, scope) => { if (!scope.clinicIds.includes(59)) throw Object.assign(Error('foreign_scope'), { status: 403 }); },
    reconcileListMessageState: async () => { calls.reconciles++; },
    reconcileDispatchJobState: async row => { calls.jobChecks++;
      if (status === 'FICTITIOUS_JOB_FAILED') { row.criteria.dispatch.status = 'failed'; return { reconciled: true }; }
      return { reconciled: false };
    },
    getDispatchConfig: row => row.criteria.dispatch, getDispatchItemFilter: () => filter,
    getDispatchScopedCounters: async () => { calls.counterWrites++; return { sent: 27, ready: 100 }; },
    getDispatchScopedItems: async (id, selectedFilter) => {
      assert.equal(id, 830); assert.equal(selectedFilter, filter); calls.itemReads++;
      return [{ sent: 27, ready: 100 }];
    },
    computeCounters: items => items[0],
    getWhatsappAccountQualityForList: async () => { calls.qualityReads++; return { can_send_api: true }; },
    normalizeDispatchContext: value => value,
    getReviewDispatchFollowUpCounters: async () => { calls.followUps++; return { pending_replies: 3, pending_reminders: 2 }; },
    getDispatchProgress: (row, counters, account) => ({ status: row.criteria.dispatch.status, ...counters, account }),
    serializeCampaign: row => ({ id: row.id }),
  };
  vm.runInNewContext(source.slice(start, end) + '\nmodule.exports=getDispatchStatus;', sandbox);
  return { read: sandbox.module.exports, calls };
}
test('periodic progress reads current scoped counters without message replay or counter writes', async () => {
  const f = fixture();
  const result = await f.read({ clinicIds: [59] }, 830, { progress_only: true });
  assert.equal(result.dispatch.sent, 27); assert.equal(result.dispatch.account.can_send_api, true);
  assert.deepEqual(f.calls, { loads: 1, reconciles: 0, jobChecks: 1, counterWrites: 0, itemReads: 1, qualityReads: 1, followUps: 0 });
});
test('default/manual reads retain existing reconciliation and account checks', async () => {
  const f = fixture(); await f.read({ clinicIds: [59] }, 830);
  assert.equal(f.calls.reconciles, 1); assert.equal(f.calls.counterWrites, 1);
  assert.equal(f.calls.itemReads, 0); assert.equal(f.calls.loads, 2); assert.equal(f.calls.qualityReads, 1);
});
test('a completed progress read still reports outstanding replies and reminders', async () => {
  const f = fixture('completed'); const result = await f.read({ clinicIds: [59] }, 830, { progress_only: true });
  assert.equal(result.dispatch.review_pending_replies, 3); assert.equal(result.dispatch.review_pending_reminders, 2);
  assert.equal(f.calls.reconciles, 0); assert.equal(f.calls.counterWrites, 0);
});
test('progress still reflects a failed native job without replaying its messages', async () => {
  const f = fixture('FICTITIOUS_JOB_FAILED'); const result = await f.read({ clinicIds: [59] }, 830, { progress_only: true });
  assert.equal(result.dispatch.status, 'failed'); assert.equal(f.calls.jobChecks, 1); assert.equal(f.calls.reconciles, 0);
});
test('both modes reject a foreign scope before items, reconciliation or account checks', async () => {
  for (const progress_only of [true, false]) {
    const f = fixture(); await assert.rejects(f.read({ clinicIds: [66] }, 830, { progress_only }), { status: 403 });
    assert.deepEqual(f.calls, { loads: 1, reconciles: 0, jobChecks: 0, counterWrites: 0, itemReads: 0, qualityReads: 0, followUps: 0 });
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../services/patientEconomics.service'), 'utf8');
const start = source.indexOf('async function recordBudgetSignatureEvent(');
const end = source.indexOf('\nasync function ', start + 20);
function recorder(status, captured) {
  return vm.runInNewContext(`(${source.slice(start, end)})`, {
    EconomicBudget: { findByPk: async (id, options) => { captured.read = { id, options }; return status ? { id, status } : null; } },
    EconomicBudgetEvent: { create: async (values, options) => { captured.event = { values, options }; return values; } },
    budgetSignatureEventMetadata: () => ({ activity: true }),
    domainError: (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code }),
  });
}
for (const status of ['draft', 'presented', 'accepted', 'partially_accepted', 'cancelled']) {
  test(`signature activity retains actual ${status} budget status and transaction`, async () => {
    const captured = {}, transaction = { marker: 'same transaction' };
    const event = await recorder(status, captured)({ budget_id: 7, budget_version: 2, created_by: 4, snapshot_json: { budget: { status: 'presented' } } }, 'signature_request_sent', { transaction });
    assert.equal(event.from_status, status); assert.equal(event.to_status, status);
    assert.equal(event.version_number, 2); assert.equal(event.actor_id, 4);
    assert.equal(captured.read.options.transaction, transaction);
    assert.equal(captured.event.options.transaction, transaction);
  });
}
test('missing parent cannot produce an event with a fictional or null status', async () => {
  const captured = {};
  await assert.rejects(recorder(null, captured)({ budget_id: 7, budget_version: 1 }, 'signature_request_created'), { code: 'budget_not_found' });
  assert.equal(captured.event, undefined);
});

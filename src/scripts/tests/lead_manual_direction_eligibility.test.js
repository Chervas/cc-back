'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { manualDirectionEligibilitySql, createLeadManualDirectionEligibilityService,
  createLeadDirectionEligibilityService } = require('../../services/leadManualDirectionEligibility.service');

test('manual portfolio metadata is one batched read and retains exact caller scope and transaction', async () => {
  const transaction = { id: 'owned-transaction' }, calls = [];
  const service = createLeadManualDirectionEligibilityService({ sequelize: { query: async (query, options) => {
    calls.push({ query, options });
    return [[{ id: 12, clinica_id: 77, eligible: 1 }, { id: 13, clinica_id: 66, eligible: 1 }, { id: 14, clinica_id: 77, eligible: 0 }]];
  } } });
  const values = await service.forLeads([{ id: 12, clinica_id: 77 }, { id: 12, clinica_id: 77 },
    { id: 13, clinica_id: 77 }, { id: 14, clinica_id: 77 }], { transaction });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.replacements.ids, [12, 13, 14]);
  assert.equal(calls[0].options.transaction, transaction);
  assert.deepEqual([...values], [[12, true], [13, false], [14, false]]);
  await service.forLeads([]);
  assert.equal(calls.length, 1);
  assert.throws(() => manualDirectionEligibilitySql('LeadIntake;DELETE'), /alias_invalid/);
});

test('manual responsibility is additive and does not rewrite or substitute campaign eligibility', async () => {
  const leads = [{ id: 1 }, { id: 2 }, { id: 3 }], options = { transaction: {} }, calls = [];
  const campaigns = { forLeads: async (...args) => { calls.push(args); return new Map([[1, true], [2, false], [3, false]]); } };
  const manual = { forLeads: async (...args) => { calls.push(args); return new Map([[1, false], [2, true]]); } };
  const service = createLeadDirectionEligibilityService({}, { campaignResponsibility: campaigns, manualDirectionEligibility: manual });
  assert.deepEqual([...(await service.forLeads(leads, options))], [[1, true], [2, true], [3, false]]);
  for (const args of calls) { assert.equal(args[0], leads); assert.equal(args[1], options); }
});

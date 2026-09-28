'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evidenceBrokerFixture } = require('./fixtures/campaign_workspace_optimization_evidence_broker.fixture');
const { optimizationChange } = require('../../services/campaignWorkspaceOptimizationCommand.service');
const { collectBudgetAccounting, reserveBudgetAccounting } = require('../../services/campaignWorkspaceBudgetAccounting.service');

async function harness(t) {
  const f = await evidenceBrokerFixture(t); const reference = f.input.reference;
  const campaigns = [f.state.workspaceCampaign, { ...f.state.workspaceCampaign, id: `google_ads:${reference.account_id}:31`, campaign_id: '31' }];
  f.setting.accounts[0].campaign_ids = ['30', '31'];
  const target = { action: 'adjust_budget', entity: 'campaign_budget', id: '40', resource: `customers/${reference.account_id}/campaignBudgets/40`,
    field: 'amount_micros', unit: 'micros' };
  const change = optimizationChange({ reference, target, before: '20000000', after: '19000000' });
  const run = { id: 'run', setting_id: f.setting.id, mandate_id: f.setting.activation.optimization.id, change };
  const authorization = { setting: structuredClone(f.setting), scope: { groupId: null, clinicIds: [1] }, limits: { currency: 'EUR', monthly_limit_cents: 100000 } };
  const models = f.deps.models;
  models.CampaignWorkspaceOptimizationRun = { findAll: async () => [] };
  const state = { campaigns, revalidations: 0, contexts: [], afterContext: null, finalDenied: false };
  const deps = { now: f.deps.now, clock: f.deps.clock,
    loadInventory: async () => ({ campaigns: structuredClone(state.campaigns) }),
    revalidate: async () => {
      state.revalidations++; if (!f.state.permitted) throw Object.assign(Error('revoked'), { code: 'workspace_optimization_permissions_required' });
    },
    resolveContext: async input => {
      state.contexts.push({ campaign: input.reference.campaign_id, grant: input.expectedBrokerGrant, transaction: input.transaction });
      await state.afterContext?.(input);
      return { setting: structuredClone(f.setting), campaign: structuredClone(state.campaigns.find(row => row.campaign_id === input.reference.campaign_id)),
        grant: f.state.grant };
    }, ensureToken: async () => assert.fail('legacy refresh'),
  };
  f.brokerState.responseFor = command => {
    assert.equal(command.operation, 'google.ads.optimization_budget.read.v1');
    const rows = structuredClone(f.brokerState.rows.optimization_budget[command.payload.section]);
    for (const row of rows) {
      row.campaign.id = command.payload.campaignId;
      if (row.campaignBudget) row.campaignBudget.resourceName = `customers/${reference.account_id}/campaignBudgets/${command.payload.campaignId === '30' ? '40' : '41'}`;
    }
    return { results: rows };
  };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  return { ...f, run, budgetState: state, budgetDeps: deps, authorization, transaction,
    collect: () => collectBudgetAccounting({ models, run, authorization }, deps),
    reserve: accounting => reserveBudgetAccounting({ models, run, authorization, accounting, transaction }, deps) };
}

test('the monthly envelope counts all selected campaigns through signed reads and reserves only against the original opaque grants', async t => {
  const f = await harness(t); const proof = await f.collect();
  assert.equal(proof.snapshots.length, 2); assert.equal(proof.snapshots[0].spent_cents, 10000);
  assert.equal(proof.snapshots[0].resources[0].daily_cents, 2000); assert.equal(f.brokerState.commands.length, 4);
  assert.ok(f.brokerState.commands.every(command => command.operation === 'google.ads.optimization_budget.read.v1'));
  assert.ok(f.budgetState.contexts.filter(row => row.grant).every(row => row.grant === f.grant));
  const ledger = await f.reserve(proof); assert.equal(ledger.reported_spend_cents, 20000);
  assert.equal(ledger.daily_commitment_cents, 3900); assert.equal(ledger.today_reserve_cents, 100); assert.equal(ledger.projected_cents, 98100);
  assert.ok(f.budgetState.contexts.some(row => row.transaction === f.transaction && row.grant === f.grant));
  assert.doesNotMatch(JSON.stringify([proof, ledger]), /accessToken|refreshToken|connection:test|brokerGrant|FICTITIOUS/);
  assert.equal(f.brokerState.commands.length, 4, 'reservation is database-only');
  f.authorization.limits.monthly_limit_cents = 98100; await f.reserve(proof);
  f.authorization.limits.monthly_limit_cents = 98099; await assert.rejects(f.reserve(proof), /budget_limit_exceeded/);
});
test('serialization does not turn evidence into authority, and rebinding after collection is rejected inside reservation', async t => {
  for (const mode of ['serialized', 'replacement', 'revoked']) await t.test(mode, async t => {
    const f = await harness(t); const proof = await f.collect();
    if (mode === 'replacement') f.scope.mapping.broker_read_connection_ref = f.scope.binding.connection_ref = 'connection:replacement';
    if (mode === 'revoked') f.scope.binding.state = 'revoked';
    await assert.rejects(f.reserve(mode === 'serialized' ? structuredClone(proof) : proof));
    assert.equal(f.brokerState.commands.length, 4);
  });
});
test('ACL, selection, clinic, grant, time and scope changes during collection stop further reads and do not return a partial envelope', async t => {
  for (const [name, mutate] of [
    ['ACL', f => { f.state.permitted = false; }], ['selection', f => { f.setting.accounts = []; }],
    ['clinic', f => { f.budgetState.campaigns[0].clinicId = 71; }], ['version', f => { f.setting.version++; }],
    ['grant', f => { f.state.grant.fingerprint = 'b'.repeat(64); }],
    ['replacement', f => { f.scope.mapping.broker_read_connection_ref = f.scope.binding.connection_ref = 'connection:replacement'; }],
    ['TTL', f => { f.state.now = new Date(+f.state.now + 60000); }], ['clock', f => { f.state.now = new Date(+f.state.now - 1); }],
    ['day', f => { f.state.now = new Date('2026-09-11T22:00:00Z'); }],
  ]) await t.test(name, async t => {
    const f = await harness(t); f.brokerState.beforeResponse = () => mutate(f);
    await assert.rejects(f.collect()); assert.equal(f.brokerState.commands.length, 1);
  });
});
test('all earlier campaign grants are rechecked before releasing the complete monthly proof', async t => {
  const f = await harness(t); let final = false;
  f.brokerState.beforeResponse = command => { if (command.payload.campaignId === '31' && command.payload.section === 'month_cost') final = true; };
  f.budgetState.afterContext = input => { if (final && input.reference.campaign_id === '30') f.scope.binding.state = 'revoked'; };
  await assert.rejects(f.collect()); assert.equal(f.brokerState.commands.length, 4);
});
test('a missing operation is service pending, a revoked credential is permissions, and no fallback account is tried', async t => {
  for (const [code, expected] of [['operation_denied', 'workspace_optimization_service_pending'],
    ['credential_revoked', 'workspace_optimization_permissions_required'], ['provider_timeout', 'workspace_optimization_budget_timeout'],
    ['rate_limited', 'workspace_optimization_rate_limited']]) await t.test(code, async t => {
    const f = await harness(t);
    if (code === 'operation_denied') delete f.engine.operations['google.ads.optimization_budget.read.v1'];
    else f.brokerState.beforeResponse = () => { throw Object.assign(Error('private-provider-error'), { code }); };
    await assert.rejects(f.collect(), { code: expected }); assert.equal(f.brokerState.commands.length, 1);
  });
});
test('broker accounting requires the execution caller to supply live mandate revalidation', async t => {
  const f = await harness(t); delete f.budgetDeps.revalidate;
  await assert.rejects(f.collect(), { code: 'workspace_optimization_permissions_required' }); assert.equal(f.brokerState.commands.length, 0);
});
test('complete empty monthly cost is zero, but missing cost or shared ownership cannot be treated as available money', async t => {
  const f = await harness(t); f.brokerState.rows.optimization_budget.month_cost = [];
  assert.equal((await f.collect()).snapshots[0].spent_cents, 0);
  f.brokerState.rows.optimization_budget.month_cost = [{ customer: { id: f.input.reference.account_id }, campaign: { id: '30' }, metrics: {} }];
  await assert.rejects(f.collect());
  f.brokerState.rows.optimization_budget.month_cost = []; f.brokerState.rows.optimization_budget.campaign[0].campaignBudget.explicitlyShared = true;
  await assert.rejects(f.collect(), /budget_unsupported/);
});

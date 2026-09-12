'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const { buildBudgetProposals, validateBudgetEvidence, adjustedBudget, POLICY } = require('../../services/campaignWorkspaceBudgetPolicy.service');
const { enqueueOptimizationEvaluations } = require('../../services/campaignWorkspaceOptimizationEvaluation.service');
const { budgetPolicyFixture } = require('./fixtures/campaign_workspace_budget_policy.fixture');

const options = f => ({ now: f.state.now, evaluationKey: 'e'.repeat(64) });
const seal = body => { const { fingerprint, ...value } = body; body.fingerprint = digest(value); return body; };

for (const [provider, owner] of [['google_ads', 'campaign_budget'], ['meta_ads', 'ad_set'], ['meta_ads', 'campaign']]) {
  test(`${provider}/${owner}: collector uses the actual budget owner and exact five-percent policy`, async () => {
    const f = budgetPolicyFixture(provider, owner); const collected = await f.run(); assert.equal(collected.collected, true, JSON.stringify(collected));
    const [proposal] = buildBudgetProposals(collected.evidence, options(f)); assert.ok(proposal);
    assert.deepEqual(proposal.change.target, f.target); assert.equal(proposal.change.before, f.before);
    assert.equal(proposal.change.after, provider === 'google_ads' ? '47500000' : '4750'); assert.equal(proposal.evidence.direction, 'decrease');
    assert.deepEqual(validateBudgetEvidence(proposal.evidence, f.state.now, proposal.change), proposal.evidence);
    assert.ok(f.state.checks > f.state.calls.length);
    assert.doesNotMatch(JSON.stringify(proposal), /accessToken|native_lead_id|external_id|lead_intake_id|email|fixture-only/);
  });

  test(`${provider}/${owner}: improved CPL only increases a budget with observed utilization`, async () => {
    const f = budgetPolicyFixture(provider, owner); f.setDailyCosts(100, 50);
    let [proposal] = buildBudgetProposals((await f.run()).evidence, options(f));
    assert.equal(proposal.change.after, provider === 'google_ads' ? '52500000' : '5250'); assert.equal(proposal.evidence.direction, 'increase');
    f.setDailyCosts(60, 30); assert.equal(buildBudgetProposals((await f.run()).evidence, options(f)).length, 0);
    f.setDailyCosts(50, 50); assert.equal(buildBudgetProposals((await f.run()).evidence, options(f)).length, 0);
  });

  test(`${provider}/${owner}: durable evaluation executes with real scope accounting and preserves its receipt`, async () => {
    const f = budgetPolicyFixture(provider, owner); const result = await f.evaluate(); assert.equal(result.result?.queued, 1, JSON.stringify(result));
    f.state.now = new Date(+f.state.now + 1000); assert.equal((await f.evaluate()).result.duplicates, 1);
    assert.equal(f.execution.state.calls.mutate, 0); assert.equal(f.execution.row().evidence.schema_version, 4);
    const mutate = f.execution.deps.mutate;
    f.execution.deps.mutate = async (...args) => {
      assert.ok(f.execution.row().submitted_at); assert.ok(f.execution.row().outcome.budget_accounting.fingerprint); return mutate(...args);
    };
    const applied = await f.execution.run(); assert.equal(applied.result?.state, 'verified', JSON.stringify(applied));
    assert.equal(f.execution.row().outcome.budget_accounting.reported_spend_cents, 10000);
    assert.ok(f.state.budgetReads.length >= 2); assert.equal(f.execution.state.calls.mutate, 1);
    assert.equal((await f.execution.run()).result.idempotent, true); assert.equal(f.execution.state.calls.mutate, 1);
  });

  test(`${provider}/${owner}: both directions obey the whole-scope monthly forecast`, async () => {
    for (const increase of [false, true]) {
      const f = budgetPolicyFixture(provider, owner); if (increase) f.setDailyCosts(100, 50);
      f.state.setting.activation.optimization.authorization.limits.monthly_limit_cents = 10000;
      assert.equal((await f.evaluate()).result.queued, 1);
      const applied = await f.execution.run(); assert.equal(applied.result?.reason, 'workspace_optimization_budget_limit_exceeded', JSON.stringify(applied));
      assert.equal(f.execution.row().submitted_at, null); assert.equal(f.execution.state.calls.mutate, 0);
    }
  });

  test(`${provider}/${owner}: changed mandate, budget, reception and expired proof never submit`, async () => {
    for (const mutate of [f => { f.state.setting.version++; }, f => { f.execution.state.remote = '999'; },
      f => { f.state.reception = false; }, f => { f.state.now = new Date(+f.state.now + POLICY.evidence_ttl_ms); }]) {
      const f = budgetPolicyFixture(provider, owner); await f.evaluate(); mutate(f); const applied = await f.execution.run();
      assert.equal(f.execution.row().status, 'skipped', JSON.stringify(applied)); assert.equal(f.execution.row().submitted_at, null);
      assert.equal(f.execution.state.calls.mutate, 0);
    }
  });

  test(`${provider}/${owner}: recent changes to another resource or mandate still require observation`, async () => {
    const f = budgetPolicyFixture(provider, owner); await f.evaluate(); const previous = structuredClone(f.execution.row());
    previous.id = '33333333-3333-4333-8333-333333333333'; previous.status = 'verified'; previous.resource_key = digest('another-resource');
    previous.mandate_id = '44444444-4444-4444-8444-444444444444'; previous.submitted_at = new Date(+f.state.now - 13 * 86400000);
    f.execution.state.runs.set(previous.id, previous);
    const result = await f.execution.run(); assert.equal(result.error_message, 'workspace_optimization_budget_observation_required');
    assert.equal(f.execution.state.calls.mutate, 0); assert.equal(f.execution.row().submitted_at, null);
  });
}

test('budget evidence rejects partial attribution, unknown days and unverified reception', async () => {
  for (const mutate of [body => { body.attribution.complete = false; }, body => { body.reception.ready = false; },
    body => { body.budget_controls = []; }, body => { body.attribution.ad_daily = []; }]) {
    const f = budgetPolicyFixture(); const { evidence } = await f.run(); mutate(evidence);
    assert.equal(buildBudgetProposals(seal(evidence), options(f)).length, 0);
  }
  const f = budgetPolicyFixture('meta_ads'); f.state.adRows = f.state.adRows.filter(row => row.date_start !== f.performance.dates[0]);
  f.state.campaignRows.shift(); const result = await f.run(); assert.equal(result.collected, true);
  assert.equal(buildBudgetProposals(result.evidence, options(f)).length, 0);
});

test('budget proof binds the exact resource, direction, daily coverage and threshold', async () => {
  const f = budgetPolicyFixture(); const { evidence } = await f.run();
  for (const mutate of [p => { p.direction = 'increase'; }, p => { p.after = '45000000'; }, p => { p.daily[0].leads = -1; },
    p => { p.daily[0].cost_micros = 10; }, p => { p.daily[0].date = p.daily[1].date; }, p => { p.extra = 'private-data'; },
    p => { p.target_fingerprint = 'f'.repeat(64); }, p => { p.daily.forEach(row => { row.leads = 1; }); }]) {
    const [proposal] = buildBudgetProposals(evidence, options(f)); mutate(proposal.evidence);
    assert.throws(() => validateBudgetEvidence(proposal.evidence, f.state.now, proposal.change));
  }
  const [{ evidence: proof, change }] = buildBudgetProposals(evidence, options(f));
  proof.daily.slice(14).forEach(row => { row.cost_micros = '30000000'; });
  assert.doesNotThrow(() => validateBudgetEvidence(proof, f.state.now, change));
  proof.daily[27].cost_micros = '29999999'; assert.throws(() => validateBudgetEvidence(proof, f.state.now, change));
});

test('budget rounding remains within five percent in either direction', () => {
  assert.equal(adjustedBudget('1001', 'increase'), '1051'); assert.equal(adjustedBudget('1001', 'decrease'), '951');
  assert.equal(adjustedBudget('19', 'decrease'), null);
  for (const value of ['0', '01', '-1', '1.5', 1000, null]) assert.throws(() => adjustedBudget(value, 'decrease'));
});

test('budget growth requires both the exact CPL and utilization boundaries without rounding', async () => {
  const f = budgetPolicyFixture(); f.setDailyCosts(60, 45);
  const [proposal] = buildBudgetProposals((await f.run()).evidence, options(f)); assert.ok(proposal);
  assert.equal(proposal.evidence.direction, 'increase');
  const belowUse = structuredClone(proposal.evidence); belowUse.daily[27].cost_micros = '44999999';
  assert.throws(() => validateBudgetEvidence(belowUse, f.state.now, proposal.change));
  const belowImprovement = structuredClone(proposal.evidence); belowImprovement.daily[27].cost_micros = '45000001';
  assert.throws(() => validateBudgetEvidence(belowImprovement, f.state.now, proposal.change));
});

test('campaign budgets aggregate all ad sets, ad-set budgets cannot borrow another set\'s sample', async () => {
  for (const owner of ['campaign', 'ad_set']) {
    const f = budgetPolicyFixture('meta_ads', owner);
    f.state.inventory[1].adset_id = '51'; f.state.bidGroups.push({ ...f.state.bidGroups[0], id: '51' });
    f.state.adRows.forEach(row => { if (row.ad_id === '61') row.adset_id = '51'; });
    f.state.auditRows.forEach(row => { if (row.identity.ad_id === '61') row.identity.adgroup_id = '51'; });
    const result = await f.run(); assert.equal(result.collected, true, JSON.stringify(result));
    const proposals = buildBudgetProposals(result.evidence, options(f));
    assert.equal(proposals.length, owner === 'campaign' ? 1 : 0);
  }
});

test('permissions revoked while reading monthly spend prevent a prepared budget adjustment', async () => {
  for (const provider of ['google_ads', 'meta_ads']) {
    const f = budgetPolicyFixture(provider); await f.evaluate(); f.state.onBudgetRead = () => { f.state.permitted = false; };
    await f.execution.run(); assert.equal(f.execution.state.calls.mutate, 0); assert.equal(f.execution.row().submitted_at, null);
  }
});

test('budget-only mandates are dispatched, but missing permission never reaches credentials', async () => {
  const f = budgetPolicyFixture(); const jobs = [];
  f.evaluationDeps.models.CampaignWorkspaceSetting.findAll = async () => [f.state.setting];
  f.evaluationDeps.enqueue = async job => { jobs.push(job); return { created: true }; };
  assert.equal((await enqueueOptimizationEvaluations({}, f.evaluationDeps)).queued, 1); assert.equal(jobs[0].payload.action, 'adjust_budget');
  f.state.setting.activation.optimization.authorization.limits.actions = ['adjust_bids'];
  assert.equal((await f.run()).collected, false); assert.equal(f.state.calls.length, 0); assert.equal(f.state.tokenChecks, 0);
});

test('Meta budget read permission errors are terminal, without alternate credentials', async () => {
  const f = budgetPolicyFixture('meta_ads'); f.state.beforeRead = () => { throw { response: { status: 401, data: { error: { code: 190 } } } }; };
  assert.deepEqual(await f.evaluate(), { status: 'failed', retryable: false, error_message: 'workspace_optimization_permissions_required' });
  assert.equal(f.state.calls.length, 1); assert.equal(f.execution.state.runs.size, 0);
});

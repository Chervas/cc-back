'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const { POLICY, buildBidProposals, validateBidEvidence, reducedBid } = require('../../services/campaignWorkspaceBidPolicy.service');
const { bidFixture } = require('./fixtures/campaign_workspace_bid.fixture');
const { enqueueOptimizationEvaluations, JOB_TYPE } = require('../../services/campaignWorkspaceOptimizationEvaluation.service');

const options = f => ({ now: f.state.now, evaluationKey: 'e'.repeat(64) });
function seal(body) { const { fingerprint, ...value } = body; body.fingerprint = digest(value); return body; }

for (const provider of ['google_ads', 'meta_ads']) {
  test(`${provider}: actual collection and bid policy lower only the current authorized cap by five percent`, async () => {
    const f = bidFixture(provider); const result = await f.run(); assert.equal(result.collected, true, JSON.stringify(result));
    const [proposal] = buildBidProposals(result.evidence, options(f)); assert.ok(proposal);
    assert.equal(proposal.change.before, f.before); assert.equal(proposal.change.after, provider === 'google_ads' ? '950000' : '950');
    assert.equal(proposal.change.target.strategy, f.target.strategy); assert.equal(proposal.evidence.daily.length, 28);
    assert.deepEqual(validateBidEvidence(proposal.evidence, f.state.now, proposal.change), proposal.evidence);
    assert.ok(f.state.checks > f.state.calls.length);
    assert.doesNotMatch(JSON.stringify(proposal), /accessToken|native_lead_id|external_id|lead_intake_id|email|synthetic|fixture-only/);
  });

  test(`${provider}: actual dispatcher child, collector, policy, producer and executor retain the immutable receipt`, async () => {
    const f = bidFixture(provider); const result = await f.evaluate(); assert.equal(result.result?.queued, 1, JSON.stringify(result));
    assert.equal(f.execution.row().evidence.schema_version, 3); assert.equal(f.execution.state.calls.mutate, 0);
    f.state.now = new Date(+f.state.now + 1000);
    assert.equal((await f.evaluate()).result.duplicates, 1); assert.equal(f.execution.state.runs.size, 1);
    const applied = await f.execution.run(); assert.equal(applied.result?.state, 'verified', JSON.stringify(applied));
    assert.equal(f.execution.state.calls.mutate, 1); assert.ok(f.execution.row().submitted_at);
    assert.equal((await f.execution.run()).result.idempotent, true); assert.equal(f.execution.state.calls.mutate, 1);
  });

  test(`${provider}: expired evidence, changed source, changed cap or missing reception stop before submission`, async () => {
    for (const change of [f => { f.state.now = new Date(+f.state.now + POLICY.evidence_ttl_ms); },
      f => { f.state.setting.version++; }, f => { f.execution.state.remote = '999'; }, f => { f.state.reception = false; }]) {
      const f = bidFixture(provider); assert.equal((await f.evaluate()).result.queued, 1); change(f);
      const result = await f.execution.run(); assert.equal(f.execution.row().status, 'skipped', JSON.stringify(result));
      assert.equal(f.execution.row().submitted_at, null); assert.equal(f.execution.state.calls.mutate, 0);
    }
  });

  test(`${provider}: any recent adjustment in the campaign requires fourteen days of observation`, async () => {
    const f = bidFixture(provider); await f.evaluate();
    const previous = structuredClone(f.execution.row()); previous.id = '33333333-3333-4333-8333-333333333333';
    previous.status = 'verified'; previous.resource_key = digest('another-resource'); previous.submitted_at = new Date(+f.state.now - 13 * 86400000);
    previous.mandate_id = '44444444-4444-4444-8444-444444444444';
    f.execution.state.runs.set(previous.id, previous);
    const result = await f.execution.run(); assert.equal(result.error_message, 'workspace_optimization_bid_observation_required');
    assert.equal(f.execution.state.calls.mutate, 0);
  });

  test(`${provider}: missing samples, incomplete attribution and unverified reception produce no bid proposal`, async () => {
    for (const mutate of [body => { body.attribution.complete = false; }, body => { body.reception.ready = false; },
      body => { body.attribution.ad_daily = body.attribution.ad_daily.filter(row => row.date >= body.performance.period.start && row.ad_id === '60'); },
      body => { body.authorization_targets = []; }, body => { body.bid_controls = []; }]) {
      const f = bidFixture(provider); const result = await f.run(); mutate(result.evidence);
      assert.equal(buildBidProposals(seal(result.evidence), options(f)).length, 0);
    }
  });
}

test('CPA/cost cap/ROAS targets are never adjusted using lead counts alone', async () => {
  for (const provider of ['google_ads', 'meta_ads']) {
    const f = bidFixture(provider); const { evidence } = await f.run();
    for (const strategy of ['COST_CAP', 'TARGET_CPA', 'MAXIMIZE_CONVERSIONS', 'TARGET_ROAS', 'LOWEST_COST_WITH_MIN_ROAS']) {
      evidence.authorization_targets[0].strategy = strategy; evidence.bid_controls[0].strategy = strategy;
      assert.equal(buildBidProposals(seal(evidence), options(f)).length, 0);
    }
  }
});

test('bid policy checks the fifty-percent threshold without rounding and rejects forged daily evidence', async () => {
  const f = bidFixture(); const { evidence } = await f.run();
  const [{ evidence: proof, change }] = buildBidProposals(evidence, options(f));
  for (const row of proof.daily.slice(14)) row.cost_micros = '30000000';
  assert.doesNotThrow(() => validateBidEvidence(proof, f.state.now, change));
  proof.daily[27].cost_micros = '29999999'; assert.throws(() => validateBidEvidence(proof, f.state.now, change));
  for (const mutate of [p => { p.extra = 'private-data'; }, p => { p.daily[0].leads = -1; }, p => { p.daily[0].date = '2026-08-11'; },
    p => { p.daily[0].cost_micros = 10; }, p => { p.after = '900000'; }, p => { p.target_fingerprint = 'f'.repeat(64); },
    p => { p.group_id = '51'; }, p => { p.daily[0].leads = Number.MAX_SAFE_INTEGER; }]) {
    const [proposal] = buildBidProposals(evidence, options(f)); mutate(proposal.evidence);
    assert.throws(() => validateBidEvidence(proposal.evidence, f.state.now, proposal.change));
  }
});

test('bid rounding never exceeds five percent and does not fabricate a zero bid', () => {
  assert.equal(reducedBid('1001'), '951'); assert.equal(reducedBid('19'), null); assert.equal(reducedBid('20'), '19');
  for (const value of ['0', '01', '-1', '1.5', 1000, null]) assert.throws(() => reducedBid(value));
});

test('permission failure during bid metadata collection is terminal and never tries another token', async () => {
  const f = bidFixture('meta_ads'); f.state.beforeRead = () => { throw { response: { status: 401, data: { error: { code: 190 } } } }; };
  assert.deepEqual(await f.evaluate(), { status: 'failed', retryable: false, error_message: 'workspace_optimization_permissions_required' });
  assert.equal(f.state.calls.length, 1); assert.equal(f.execution.state.runs.size, 0);
});

test('dispatcher includes bid-only mandates and keeps actions in separate durable children', async () => {
  const f = bidFixture(); const requests = [];
  f.evaluationDeps.models.CampaignWorkspaceSetting.findAll = async () => [f.state.setting];
  f.evaluationDeps.enqueue = async request => { requests.push(request); return { created: true }; };
  assert.equal((await enqueueOptimizationEvaluations({}, f.evaluationDeps)).queued, 1);
  assert.equal(requests[0].type, JOB_TYPE); assert.equal(requests[0].payload.action, 'adjust_bids');
  assert.equal(requests[0].payload.schema_version, 2);
  const authorization = f.state.setting.activation.optimization.authorization;
  authorization.limits.actions.push('pause_underperforming_ads');
  authorization.campaigns[0].targets.push({ action: 'pause_underperforming_ads', id: '60' });
  requests.length = 0;
  assert.equal((await enqueueOptimizationEvaluations({}, f.evaluationDeps)).queued, 2);
  assert.deepEqual(requests.map(row => row.payload.action), ['pause_underperforming_ads', 'adjust_bids']);
  assert.notEqual(requests[0].dedupeScope, requests[1].dedupeScope);
});

test('new evaluation jobs require a known action, old pause jobs cannot be repurposed as bids', async () => {
  for (const mutate of [f => { delete f.payload.action; }, f => { f.payload.action = 'toString'; },
    f => { f.payload.action = 'negative_keywords'; }, f => { f.payload.schema_version = 1; }]) {
    const f = bidFixture(); mutate(f);
    const result = await f.evaluate(); assert.equal(result.error_message, 'workspace_optimization_evaluation_invalid');
    assert.equal(result.retryable, false); assert.equal(f.state.calls.length, 0);
  }
});

test('cost-cap campaigns report missing goal evidence instead of claiming insufficient lead volume', async () => {
  const f = bidFixture('meta_ads'); f.target.strategy = 'COST_CAP'; f.state.bidGroups[0].bid_strategy = 'COST_CAP';
  const result = await f.evaluate(); assert.equal(result.result?.reason, 'workspace_optimization_bid_goal_evidence_required', JSON.stringify(result));
  assert.equal(result.result.queued, 0); assert.equal(f.execution.state.runs.size, 0);
});

test('Meta daily gaps remain unknown for bids, even when both halves still have enough leads', async () => {
  const f = bidFixture('meta_ads'); f.state.adRows = f.state.adRows.filter(row => row.date_start !== f.performance.dates[0]);
  f.state.campaignRows.shift(); const result = await f.run(); assert.equal(result.collected, true);
  assert.equal(buildBidProposals(result.evidence, options(f)).length, 0);
});

test('foreign campaign history and an elapsed observation boundary do not block the current bid', async () => {
  for (const foreign of [false, true]) {
    const f = bidFixture(); await f.evaluate(); const previous = structuredClone(f.execution.row());
    previous.id = '55555555-5555-4555-8555-555555555555'; previous.status = 'verified'; previous.resource_key = digest('another-resource');
    previous.submitted_at = new Date(+f.state.now - (foreign ? 3600000 : POLICY.cooldown_hours * 3600000));
    if (foreign) previous.campaign_id = '31'; f.execution.state.runs.set(previous.id, previous);
    assert.equal((await f.execution.run()).result.state, 'verified'); assert.equal(f.execution.state.calls.mutate, 1);
  }
});

test('collector refuses bid collection without the matching mandate action before touching credentials', async () => {
  const f = bidFixture(); f.state.setting.activation.optimization.authorization.limits.actions = ['pause_underperforming_ads'];
  const result = await f.run(); assert.equal(result.collected, false); assert.equal(f.state.calls.length, 0); assert.equal(f.state.tokenChecks, 0);
});

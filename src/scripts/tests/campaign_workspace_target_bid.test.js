'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { targetSnapshotFixture, targetBidFixture } = require('./fixtures/campaign_workspace_target_bid.fixture');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const { verifyTargetSnapshot } = require('../../services/campaignWorkspaceGoogleTargetSnapshot.service');
const { recommendedChange, validateTargetBidEvidence } = require('../../services/campaignWorkspaceTargetBidPolicy.service');
const { recoverOptimizationRuns } = require('../../services/campaignWorkspaceOptimizationExecution.service');
const { publicRun } = require('../../services/campaignWorkspaceOptimizationHistory.service');
const { providerMutation } = require('../../services/campaignWorkspaceOptimizationCommand.service');

for (const strategy of ['TARGET_CPA', 'MAXIMIZE_CONVERSIONS', 'TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE']) {
  test(`${strategy}: provider recommendation reaches the durable executor without equating it to CRM leads`, async () => {
    const f = targetBidFixture(strategy, strategy.startsWith('MAXIMIZE') ? 'PERFORMANCE_MAX' : 'SEARCH');
    const result = await f.evaluate(); assert.equal(result.result?.queued, 1, JSON.stringify(result));
    assert.equal(f.execution.row().evidence.schema_version, 5);
    const mutation = providerMutation(f.execution.row().change);
    assert.equal(mutation.path, 'customers/20/campaigns:mutate'); assert.equal(mutation.body.operations.length, 1);
    assert.deepEqual(Object.keys(mutation.body.operations[0]).sort(), ['update', 'updateMask']);
    assert.doesNotMatch(JSON.stringify(mutation), /biddingStrategy|conversionGoal|campaignBudget|recommendations:apply/);
    assert.equal(f.state.leadQueries.length, 0); assert.equal(f.state.identityQueries.length, 0);
    assert.equal(f.snapshot.state.calls.some(row => /metrics\.|lead_form_submission_data|\.name\b/.test(row.query)), false);
    const original = structuredClone(f.execution.row().evidence);
    const applied = await f.execution.run(); assert.equal(applied.result?.state, 'verified', JSON.stringify(applied));
    assert.equal(f.execution.state.calls.mutate, 1); assert.equal(f.execution.state.remote, strategy.includes('VALUE') || strategy === 'TARGET_ROAS' ? '3.8' : '21000000');
    assert.deepEqual(f.execution.row().evidence, original);
    assert.equal((await f.execution.run()).result.idempotent, true); assert.equal(f.execution.state.calls.mutate, 1);
    const visible = publicRun(f.execution.row(), { ...f.state.workspaceCampaign, name: 'Campana de prueba', currency: 'EUR' });
    assert.match(visible.actionLabel, /Objetivo de/); assert.doesNotMatch(JSON.stringify(visible), /conversionActions|rec-1|fixture-only/);
  });
}

test('custom goals can use secondary actions while standard goals still include their primary actions', async () => {
  const f = targetSnapshotFixture(); const config = f.state.config[0].conversionGoalCampaignConfig;
  config.goalConfigLevel = 'CAMPAIGN'; config.customConversionGoal = 'customers/20/customConversionGoals/80';
  f.state.goals[0].campaignConversionGoal.biddable = false; f.state.actions[0].conversionAction.primaryForGoal = false;
  const snapshot = await f.run(); assert.equal(snapshot.goals.actions[0].primary, false); assert.equal(verifyTargetSnapshot(snapshot), snapshot);
  f.state.goals[0].campaignConversionGoal.biddable = true;
  assert.equal((await f.run()).goals.actions.length, 1);
  const other = structuredClone(f.state.actions[0]); other.conversionAction.primaryForGoal = true;
  other.conversionAction.resourceName = 'customers/20/conversionActions/91'; f.state.actions.push(other);
  assert.equal((await f.run()).goals.actions.length, 2);
});

test('irrelevant or unidentifiable conversion goals are not treated as marketing results', async () => {
  for (const mutate of [f => { f.state.actions[0].conversionAction.primaryForGoal = false; },
    f => { f.state.actions[0].conversionAction.status = 'REMOVED'; }, f => { f.state.actions[0].conversionAction.ownerCustomer = 'customers/21'; },
    f => { f.state.config[0].conversionGoalCampaignConfig.goalConfigLevel = 'UNKNOWN'; },
    f => { f.state.metadata[0].customer.conversionTrackingSetting = {}; },
    f => { f.state.goals[0].campaignConversionGoal.category = 'PAGE_VIEW'; f.state.actions[0].conversionAction.category = 'PAGE_VIEW'; }]) {
    const f = targetSnapshotFixture(); mutate(f); await assert.rejects(f.run(), /target_(incomplete|goals_required)/);
  }
});

test('campaign goal identity uses the provider relationship and category/origin, not encoded resource suffixes', async () => {
  const f = targetSnapshotFixture(); assert.equal((await f.run()).goals.standard.length, 1);
  assert.ok(f.state.calls.filter(call => call.name === 'goals').every(call => !call.query.includes('resource_name')));
  f.state.goals[0].campaignConversionGoal.campaign = 'customers/20/campaigns/31';
  await assert.rejects(f.run(), /target_incomplete/);
});

test('phone and imported leads are eligible but unrelated observation actions do not enter bid evidence', async () => {
  for (const category of ['PHONE_CALL_LEAD', 'IMPORTED_LEAD']) {
    const f = targetSnapshotFixture(); f.state.goals[0].campaignConversionGoal.category = category;
    f.state.actions[0].conversionAction.category = category;
    const observation = structuredClone(f.state.actions[0]); observation.conversionAction.resourceName = 'customers/20/conversionActions/91';
    observation.conversionAction.category = 'PAGE_VIEW'; observation.conversionAction.primaryForGoal = false;
    f.state.actions.push(observation);
    const snapshot = await f.run(); assert.equal(snapshot.goals.actions.length, 1); assert.ok(recommendedChange(snapshot));
  }
});

test('cross-account conversion ownership is explicit without switching the advertising account request', async () => {
  const f = targetSnapshotFixture(); f.state.metadata[0].customer.conversionTrackingSetting.googleAdsConversionCustomer = 'customers/21';
  const action = f.state.actions[0].conversionAction;
  action.resourceName = 'customers/21/conversionActions/90'; action.ownerCustomer = 'customers/21';
  const snapshot = await f.run(); assert.equal(snapshot.goals.conversion_customer, 'customers/21');
  assert.equal(verifyTargetSnapshot(snapshot), snapshot);
  assert.ok(f.state.calls.filter(call => call.name === 'actions').every(call => call.query.includes("owner_customer = 'customers/21'")));
  action.ownerCustomer = 'customers/20'; await assert.rejects(f.run(), /target_incomplete/);
});

test('changed goal settings and group overrides during collection are rejected before creating evidence', async () => {
  for (const change of [f => { f.state.actions[0].conversionAction.clickThroughLookbackWindowDays = '60'; },
    f => { f.state.goals[0].campaignConversionGoal.biddable = false; },
    f => { f.state.groups[0].adGroup.targetRoas = 5; }]) {
    const f = targetSnapshotFixture('TARGET_ROAS', 'SEARCH');
    f.state.onRead = name => { if (name === 'recommendations') change(f); };
    await assert.rejects(f.run(), /target_(changed|goals_required)/);
  }
});

test('a denied provider read stops collection and preflight without trying another credential', async () => {
  for (const preflight of [false, true]) {
    const f = targetBidFixture(); if (preflight) assert.equal((await f.evaluate()).result?.queued, 1);
    const reads = f.snapshot.state.calls.length;
    f.snapshot.state.error = { response: { status: 403, data: { error: { message: 'private provider diagnostic' } } } };
    const result = preflight ? await f.execution.run() : await f.evaluate();
    assert.match(JSON.stringify(result), /workspace_optimization_permissions_required/);
    assert.doesNotMatch(JSON.stringify(result), /private provider diagnostic/);
    assert.equal(f.snapshot.state.calls.length, reads + 1); assert.equal(f.execution.state.calls.mutate, 0);
    if (preflight) assert.equal(f.execution.row().submitted_at, null);
    else assert.equal(f.execution.state.jobs.size, 0);
  }
});

test('no current recommendation is an explicit skip, not a CRM attribution error', async () => {
  const f = targetBidFixture(); f.snapshot.state.recommendations = [];
  const result = await f.evaluate(); assert.match(JSON.stringify(result), /workspace_optimization_target_recommendation_required/);
  assert.equal(f.state.leadQueries.length, 0); assert.equal(f.execution.state.jobs.size, 0);
});

test('target recommendations keep exact ten-percent boundaries and round towards the original target', async () => {
  const cpa = targetSnapshotFixture('TARGET_CPA'); cpa.adjustment().recommendedTargetMultiplier = 1.1;
  assert.equal(recommendedChange(await cpa.run()).after, '22000000');
  const roas = targetSnapshotFixture('TARGET_ROAS'); roas.adjustment().recommendedTargetMultiplier = 0.9;
  assert.equal(recommendedChange(await roas.run()).after, '3.6');
  roas.adjustment().recommendedTargetMultiplier = '0.950000000001';
  assert.equal(recommendedChange(await roas.run()).after, '3.800001');
});

test('provider defaults remain distinct from missing goal identity or guessed currency', async () => {
  const f = targetSnapshotFixture(); delete f.state.actions[0].conversionAction.valueSettings;
  delete f.state.metadata[0].campaignBudget.explicitlyShared; delete f.state.recommendations[0].recommendation.dismissed;
  const snapshot = await f.run(); assert.equal(snapshot.goals.actions[0].default_value, 0);
  assert.equal(snapshot.goals.actions[0].default_currency, ''); assert.ok(recommendedChange(snapshot));
});

test('another account, duplicate, incomplete pagination and timeouts never produce a usable snapshot', async () => {
  for (const mutate of [f => { f.state.actions.push(f.state.actions[0]); }, f => { f.state.goals.push(f.state.goals[0]); },
    f => { f.state.metadata[0].customer.id = '21'; }, f => { f.state.config = []; },
    f => { f.state.pageResponse = name => ({ results: f.state[name], nextPageToken: 'repeated' }); },
    f => { f.state.clock = NaN; },
    f => { f.state.onRead = () => { f.state.clock += 45000; }; }]) {
    const f = targetSnapshotFixture(); mutate(f); await assert.rejects(f.run(), /incomplete|completed|timeout|goals_required/);
  }
});

test('paging keeps the exact campaign and selected fields without persisting names or contact data', async () => {
  const f = targetSnapshotFixture();
  f.state.pageResponse = (name, options) => name === 'actions' && !options.data.pageToken
    ? { results: [], nextPageToken: 'page2' } : { results: structuredClone(f.state[name]) };
  const result = await f.run(); assert.equal(result.goals.actions.length, 1);
  assert.equal(f.state.calls.filter(row => row.name === 'actions').length, 4);
  assert.doesNotMatch(JSON.stringify(result), /fixture-only|accessToken|patient|email|name"/);
});

test('only bounded, current single-campaign recommendations are eligible; no clamping of large requests', async () => {
  for (const [strategy, multipliers] of [['TARGET_CPA', [1, 0.9, 1.100000001, 2]], ['TARGET_ROAS', [1, 1.1, 0.899999999, 0.5]]]) {
    for (const value of multipliers) {
      const f = targetSnapshotFixture(strategy); f.adjustment().recommendedTargetMultiplier = value;
      assert.equal(recommendedChange(await f.run()), null);
    }
    const f = targetSnapshotFixture(strategy); f.adjustment().currentAverageTargetMicros = '12345678';
    assert.equal(recommendedChange(await f.run()), null);
  }
  for (const mutate of [f => { f.adjustment().sharedSet = 'customers/20/sharedSets/1'; },
    f => { f.state.recommendations = []; }, f => { f.state.recommendations.push(structuredClone(f.state.recommendations[0]));
      f.state.recommendations[1].recommendation.resourceName = 'customers/20/recommendations/rec-2'; }]) {
    const f = targetSnapshotFixture(); mutate(f); assert.equal(recommendedChange(await f.run()), null);
  }
  const f = targetSnapshotFixture(); f.adjustment().recommendedTargetMultiplier = 1.049999999999;
  assert.equal(recommendedChange(await f.run()).after, '20999999');
});

test('shared strategies, group overrides, non-EUR calendars and shared budgets are not modified', async () => {
  for (const mutate of [f => { f.state.metadata[0].campaign.biddingStrategy = 'customers/20/biddingStrategies/4'; },
    f => { f.state.metadata[0].campaignBudget.explicitlyShared = true; }, f => { f.state.metadata[0].campaignBudget.period = 'CUSTOM_PERIOD'; },
    f => { f.state.metadata[0].customer.timeZone = 'America/New_York'; }, f => { f.state.metadata[0].customer.currencyCode = 'USD'; },
    f => { f.state.groups[0].adGroup.targetCpaMicros = '10000000'; }]) {
    const f = targetSnapshotFixture('TARGET_CPA', 'SEARCH'); mutate(f); await assert.rejects(f.run(), /unsupported|group_override/);
  }
});

test('modified goals, recommendations or budgets between collection and execution prevent submission', async () => {
  for (const mutate of [f => { f.snapshot.state.actions[0].conversionAction.countingType = 'MANY_PER_CLICK'; },
    f => { f.snapshot.state.actions[0].conversionAction.valueSettings.defaultValue = 50; },
    f => { f.snapshot.state.recommendations = []; }, f => { f.snapshot.adjustment().recommendedTargetMultiplier = 1.06; },
    f => { f.snapshot.state.metadata[0].campaignBudget.amountMicros = '60000000'; }]) {
    const f = targetBidFixture(); assert.equal((await f.evaluate()).result?.queued, 1); mutate(f);
    const result = await f.execution.run(); assert.equal(result.result?.reason, 'workspace_optimization_target_changed', JSON.stringify(result));
    assert.equal(f.execution.row().submitted_at, null); assert.equal(f.execution.state.calls.mutate, 0);
  }
});

test('revocation during any read, elapsed evidence and reception loss cannot be bypassed by an existing recommendation', async () => {
  for (const phase of ['collection', 'preflight', 'reception', 'expiry']) {
    const f = targetBidFixture();
    if (phase === 'collection') {
      f.snapshot.state.onRead = () => { f.state.permitted = false; };
      const result = await f.evaluate(); assert.equal(result.error_message, 'workspace_optimization_permissions_required');
      assert.equal(f.snapshot.state.calls.length, 1); assert.equal(f.execution.state.jobs.size, 0); continue;
    }
    assert.equal((await f.evaluate()).result?.queued, 1); const reads = f.snapshot.state.calls.length;
    if (phase === 'preflight') f.snapshot.state.onRead = () => { f.state.permitted = false; };
    if (phase === 'reception') f.state.reception = false;
    if (phase === 'expiry') f.state.now = new Date(+f.state.now + 900000);
    const result = await f.execution.run(); assert.equal(f.execution.row().submitted_at, null, JSON.stringify(result));
    assert.equal(f.execution.state.calls.mutate, 0);
    if (phase === 'preflight') assert.equal(f.snapshot.state.calls.length, reads + 1);
    if (phase === 'expiry') assert.equal(f.snapshot.state.calls.length, reads);
  }
});

test('fresh proposal recovery preserves evidence and a subsequent cycle respects campaign observation', async () => {
  const f = targetBidFixture(); assert.equal((await f.evaluate()).result.queued, 1);
  const evidence = structuredClone(f.execution.row().evidence); f.execution.state.jobs.get(1).status = 'failed';
  f.state.now = new Date(+f.state.now + 60000); f.execution.row().next_check_at = new Date(+f.state.now - 1);
  assert.equal((await recoverOptimizationRuns(f.execution.deps)).report.apply_queued, 1);
  assert.deepEqual(f.execution.row(2).evidence, evidence);
  assert.equal((await f.execution.run(2)).result?.state, 'verified');
  f.payload.cycle_at = f.state.now.toISOString(); assert.equal((await f.evaluate()).result?.queued, 1);
  assert.equal((await f.execution.run(3)).error_message, 'workspace_optimization_bid_observation_required');
  assert.equal(f.execution.state.calls.mutate, 1);
});

test('immutable proof rejects tampering, unrelated actions, stale dates and arbitrary snapshot fields', async () => {
  const f = targetBidFixture(); assert.equal((await f.evaluate()).result.queued, 1);
  const { evidence, change } = f.execution.row(); assert.deepEqual(validateTargetBidEvidence(evidence, f.state.now, change), evidence);
  for (const mutate of [p => { p.snapshot.goals.actions[0].category = 'PAGE_VIEW'; }, p => { p.snapshot.target.field = 'status'; },
    p => { p.snapshot.secret = 'private'; }, p => { p.snapshot.goals.custom = { resource: 'other', actions: [] }; }]) {
    const modified = structuredClone(evidence); mutate(modified); const { fingerprint, ...body } = modified.snapshot;
    modified.snapshot.fingerprint = digest(body); assert.throws(() => validateTargetBidEvidence(modified, f.state.now, change));
  }
  assert.throws(() => validateTargetBidEvidence(evidence, new Date(+f.state.now + 900000), change));
  assert.throws(() => validateTargetBidEvidence(evidence, new Date(NaN), change));
});

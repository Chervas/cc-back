'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { evidenceBrokerFixture } = require('./fixtures/campaign_workspace_optimization_evidence_broker.fixture');
const { targetRows, targetResponse } = require('../../../services/integrations-broker/test/google-optimization-targets-fixture.cjs');
const { collectOptimizationEvidence } = require('../../services/campaignWorkspaceOptimizationEvidence.service');
const { createOptimizationBrokerRead } = require('../../services/campaignWorkspaceOptimizationBrokerRead.service');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const { verifyTargetSnapshot } = require('../../services/campaignWorkspaceGoogleTargetSnapshot.service');
const { buildTargetBidProposals, assertTargetBidBaseline } = require('../../services/campaignWorkspaceTargetBidPolicy.service');

async function fixture(t, strategy = 'MAXIMIZE_CONVERSIONS', channel = 'PERFORMANCE_MAX', owner) {
  const f = await evidenceBrokerFixture(t); const rows = targetRows(strategy, channel, owner);
  const scheme = { TARGET_CPA: ['target_cpa.target_cpa_micros', 'micros'], MAXIMIZE_CONVERSIONS: ['maximize_conversions.target_cpa_micros', 'micros'],
    TARGET_ROAS: ['target_roas.target_roas', 'ratio'], MAXIMIZE_CONVERSION_VALUE: ['maximize_conversion_value.target_roas', 'ratio'] }[strategy];
  const target = { action: 'adjust_bids', entity: 'campaign', id: '30', resource: `customers/${f.input.reference.account_id}/campaigns/30`,
    field: scheme[0], unit: scheme[1], strategy };
  f.entry.targets = [target]; f.setting.activation.optimization.authorization.limits.actions = ['adjust_bids'];
  f.brokerState.responseFor = (command, request) => { assert.equal(command.operation, 'google.ads.optimization_targets.read.v1'); return targetResponse(rows, request); };
  const collect = () => collectOptimizationEvidence({ ...f.input, action: 'adjust_bids' }, f.deps);
  const proposals = evidence => buildTargetBidProposals(evidence, { evaluationKey: digest('synthetic-target-bid-evaluation'), now: f.state.now });
  return { ...f, rows, target, collect, proposals };
}
for (const strategy of ['TARGET_CPA', 'MAXIMIZE_CONVERSIONS', 'TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE']) {
  test(`${strategy}: signed broker evidence reaches the existing target policy without CRM counts or local tokens`, async t => {
    const f = await fixture(t, strategy, strategy.startsWith('MAXIMIZE') ? 'PERFORMANCE_MAX' : 'SEARCH');
    const result = await f.collect(); assert.equal(result.collected, true, JSON.stringify(result));
    assert.equal(result.evidence.schema_version, 3); verifyTargetSnapshot(result.evidence.target_snapshot);
    const proposals = f.proposals(result.evidence); assert.equal(proposals.length, 1);
    assert.equal(proposals[0].change.after, f.target.unit === 'micros' ? '21000000' : '3.8');
    assert.equal(f.state.leadQueries.length, 0); assert.equal(f.state.identityQueries.length, 0); assert.equal(f.state.tokenChecks, 0);
    assert.ok(f.brokerState.expected.filter(Boolean).every(grant => grant === f.grant));
    assert.ok(f.brokerState.commands.every(command => command.tenantRef === 'clinic:1'
      && Object.keys(command.payload).sort().join(',') === 'campaignId,pageToken,section'));
    assert.doesNotMatch(JSON.stringify(result), /accessToken|refreshToken|fixture-only|connection:test|native_lead|patient/);
    assert.equal(f.provider.state.calls.some(call => /mutate|metrics\.|lead_form_submission|\.name\b/.test(call.json.query)), false);
  });
}
test('MCC custom goals keep secondary actions and standard primary goals, without trusting caller-supplied owners', async t => {
  const f = await fixture(t, 'TARGET_CPA', 'SEARCH', '9999999999');
  f.rows.actions[0].conversionAction.primaryForGoal = false;
  const second = structuredClone(f.rows.actions[0]); second.conversionAction.primaryForGoal = true;
  second.conversionAction.resourceName = 'customers/9999999999/conversionActions/91'; f.rows.actions.push(second);
  const result = await f.collect(); assert.equal(result.collected, true, JSON.stringify(result));
  assert.equal(result.evidence.target_snapshot.goals.conversion_customer, 'customers/9999999999');
  assert.equal(result.evidence.target_snapshot.goals.actions.length, 2); assert.equal(f.proposals(result.evidence).length, 1);
  assert.ok(f.provider.state.calls.every(call => call.path.includes(`/customers/${f.input.reference.account_id}/`)));
});
test('all pages of actions and multiple goal identities participate in evidence and final reread', async t => {
  const f = await fixture(t); const seed = f.rows.actions[0];
  f.rows.actions = Array.from({ length: 300 }, (_, i) => ({ ...structuredClone(seed), conversionAction: {
    ...seed.conversionAction, resourceName: `customers/${f.input.reference.account_id}/conversionActions/${90 + i}` } }));
  f.rows.goals.push({ customer: f.rows.goals[0].customer, campaignConversionGoal: { ...f.rows.goals[0].campaignConversionGoal, origin: 'CALL_FROM_ADS', biddable: false } });
  const result = await f.collect(); assert.equal(result.collected, true, JSON.stringify(result));
  assert.equal(result.evidence.target_snapshot.goals.actions.length, 300); assert.equal(result.evidence.target_snapshot.goals.standard.length, 2);
  assert.equal(f.brokerState.commands.filter(command => command.payload.section === 'actions').length, 4);
  f.rows.actions[299].conversionAction.resourceName = f.rows.actions[0].conversionAction.resourceName;
  assert.equal((await f.collect()).collected, false);
});
test('changing goals, configuration, budget, target or group overrides mid-read never yields a usable proof', async t => {
  const changes = [f => { f.rows.actions[0].conversionAction.valueSettings.defaultValue = 50; },
    f => { f.rows.goals[0].campaignConversionGoal.biddable = false; },
    f => { delete f.rows.config[0].conversionGoalCampaignConfig.customConversionGoal; },
    f => { f.rows.campaign[0].campaignBudget.amountMicros = '60000000'; },
    f => { f.rows.campaign[0].campaign.targetCpa.targetCpaMicros = '21000000'; },
    f => { f.rows.ad_groups[0].adGroup.targetCpaMicros = '20000000'; }];
  for (const [index, change] of changes.entries()) await t.test(String(index), async t => {
    const f = await fixture(t, 'TARGET_CPA', 'SEARCH');
    f.brokerState.beforeResponse = command => { if (command.payload.section === 'recommendations') change(f); };
    const result = await f.collect(); assert.equal(result.collected, false, JSON.stringify(result)); assert.equal(result.evidence, undefined);
  });
});
test('authority loss, expired evidence, missing exact operation and provider failures stop without legacy fallback', async t => {
  const changes = [f => { f.state.permitted = false; }, f => { f.scope.binding.state = 'revoked'; },
    f => { f.scope.mapping.broker_read_connection_ref = f.scope.binding.connection_ref = 'connection:other'; },
    f => { f.setting.accounts = []; }, f => { f.state.workspaceCampaign.clinicId = 71; },
    f => { f.state.reception = false; }, f => { f.state.now = new Date(+f.state.now + 60000); }];
  for (const [index, change] of changes.entries()) await t.test(String(index), async t => {
    const f = await fixture(t); f.brokerState.beforeResponse = () => change(f);
    const result = await f.collect(); assert.equal(result.collected, false, JSON.stringify(result)); assert.equal(result.evidence, undefined);
  });
  for (const [code, expected] of [['operation_denied', 'workspace_optimization_service_pending'], ['provider_timeout', 'workspace_optimization_evidence_timeout'],
    ['credential_revoked', 'workspace_optimization_permissions_required'], ['rate_limited', 'workspace_optimization_rate_limited']]) await t.test(code, async t => {
    const f = await fixture(t); f.brokerState.beforeResponse = () => { throw Object.assign(Error('private-provider-error'), { code }); };
    assert.deepEqual(await f.collect(), { collected: false, reason: expected }); assert.equal(f.brokerState.commands.length, 1);
  });
});
test('no recommendation, multiple recommendations, a different average target or over-ten-percent request yields no proposal', async t => {
  const changes = [f => { f.rows.recommendations = []; }, f => { const rec = structuredClone(f.rows.recommendations[0]);
    rec.recommendation.resourceName = rec.recommendation.resourceName.replace('rec-1', 'rec-2'); f.rows.recommendations.push(rec); },
    f => { f.rows.recommendations[0].recommendation.raiseTargetCpaRecommendation.targetAdjustment.currentAverageTargetMicros = '21000000'; },
    f => { f.rows.recommendations[0].recommendation.raiseTargetCpaRecommendation.targetAdjustment.recommendedTargetMultiplier = 1.100000001; }];
  for (const [index, change] of changes.entries()) await t.test(String(index), async t => {
    const f = await fixture(t); change(f); const result = await f.collect(); assert.equal(result.collected, true, JSON.stringify(result));
    assert.equal(f.proposals(result.evidence).length, 0);
  });
});
test('same typed reader verifies the pre-execution baseline and rejects changed goals before a write', async t => {
  const f = await fixture(t); const result = await f.collect(); const proposal = f.proposals(result.evidence)[0];
  const read = createOptimizationBrokerRead({ brokerGrant: f.grant, reference: f.input.reference, clinicId: 1,
    revalidate: async () => { assert.equal(f.state.permitted, true); }, clock: () => f.state.clock });
  const input = { ...proposal, credentials: { readSection: (section, timeout) => read('optimization_targets', section, {}, timeout) },
    now: () => f.state.now, clock: () => f.state.clock, read: () => assert.fail('legacy baseline reader') };
  await assertTargetBidBaseline(input);
  f.rows.actions[0].conversionAction.countingType = 'MANY_PER_CLICK';
  await assert.rejects(assertTargetBidBaseline(input), { code: 'workspace_optimization_target_changed' });
  assert.ok(f.brokerState.commands.every(command => command.operation.endsWith('.read.v1')));
});

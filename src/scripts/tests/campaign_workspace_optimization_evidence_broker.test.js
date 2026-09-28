'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evidenceBrokerFixture } = require('./fixtures/campaign_workspace_optimization_evidence_broker.fixture');
const { collectOptimizationEvidence } = require('../../services/campaignWorkspaceOptimizationEvidence.service');
const { verifyPerformanceSnapshot } = require('../../services/campaignWorkspacePerformanceSnapshot.service');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const { buildAdPauseProposals, validateAdPauseEvidence } = require('../../services/campaignWorkspaceAdPausePolicy.service');
const { createOptimizationBrokerRead } = require('../../services/campaignWorkspaceOptimizationBrokerRead.service');

test('the internal reader cannot override its authorized campaign or inject arbitrary payload fields through a window', async () => {
  const read = createOptimizationBrokerRead({ brokerGrant: Object.freeze({}), reference: { provider: 'google_ads', account_id: '1234567890', campaign_id: '30' },
    clinicId: 1, revalidate: async () => assert.fail('invalid command reached authorization') });
  for (const window of [null, [], {}, { startDate: '2026-08-12', endDate: '2026-09-08', campaignId: '31' },
    { startDate: '2026-08-12', endDate: '2026-09-08', section: 'other' }, { query: 'SELECT *' }]) {
    await assert.rejects(read('optimization_performance', 'inventory', window, 15000), { code: 'workspace_optimization_evidence_invalid' });
  }
});

test('real authorization, opaque grant and signed broker collect mature performance with local CRM counts, never tokens', async t => {
  const f = await evidenceBrokerFixture(t); const before = structuredClone(f.setting);
  const result = await f.run(); assert.equal(result.collected, true, JSON.stringify(result));
  const value = result.evidence;
  assert.equal(value.attribution.complete, true); assert.equal(value.attribution.ad_daily.reduce((sum, row) => sum + row.leads, 0), 56);
  assert.equal(value.performance.campaign_daily.length, 28); assert.equal(value.performance.ad_daily.length, 56);
  assert.equal(verifyPerformanceSnapshot(value.performance, f.input.reference, f.state.now).fingerprint, value.performance.fingerprint);
  const { fingerprint, ...body } = value; assert.equal(fingerprint, digest(body));
  assert.deepEqual(f.setting, before); assert.equal(f.state.tokenChecks, 0); assert.equal(f.brokerState.commands.length, 4);
  assert.ok(f.brokerState.commands.every(row => row.operation === 'google.ads.optimization_performance.read.v1' && row.tenantRef === 'clinic:1'));
  assert.ok(f.brokerState.expected.filter(Boolean).every(value => value === f.grant));
  assert.ok(f.state.leadQueries.every(query => query.attributes.every(name => !/email|phone|name|payload/i.test(name))));
  assert.doesNotMatch(JSON.stringify(value), /accessToken|refreshToken|fixture-only|connection:test|lead_intake_id|native_lead_id/);
  assert.ok(f.brokerState.commands.every(row => !/crm_created_at|lead_intake|external_id/.test(JSON.stringify(row))));
  const proposals = buildAdPauseProposals(value, { evaluationKey: digest('broker-synthetic-evaluation'), now: f.state.now });
  assert.equal(proposals.length, 1); assert.equal(proposals[0].change.target.id, '60');
  assert.equal(proposals[0].evidence.baseline_ad_id, '61');
  assert.deepEqual(validateAdPauseEvidence(proposals[0].evidence, f.state.now, proposals[0].change), proposals[0].evidence);
  assert.equal(f.brokerState.commands.length, 4, 'building the proposal does not send it');
});
test('manual bids and budget decisions use typed compatibility controls plus the same complete performance evidence', async t => {
  for (const action of ['adjust_bids', 'adjust_budget']) await t.test(action, async t => {
    const f = await evidenceBrokerFixture(t);
    const target = action === 'adjust_bids' ? { action, entity: 'ad_group', id: '50', resource: `customers/${f.input.reference.account_id}/adGroups/50`,
      field: 'cpc_bid_micros', unit: 'micros', strategy: 'MANUAL_CPC' } : { action, entity: 'campaign_budget', id: '40',
      resource: `customers/${f.input.reference.account_id}/campaignBudgets/40`, field: 'amount_micros', unit: 'micros' };
    f.entry.targets = [target]; f.setting.activation.optimization.authorization.limits.actions = [action];
    if (action === 'adjust_budget') f.setting.activation.optimization.authorization.limits.monthly_limit_cents = 100000;
    const result = await collectOptimizationEvidence({ ...f.input, action }, f.deps);
    assert.equal(result.collected, true, JSON.stringify(result));
    assert.equal(result.evidence[action === 'adjust_bids' ? 'bid_controls' : 'budget_controls'].length, 1);
    assert.equal(result.evidence.performance.ad_daily.length, 56); assert.equal(f.brokerState.commands.length, 7);
    assert.ok(f.brokerState.commands.every(row => ['google.ads.optimization.read.v1', 'google.ads.optimization_performance.read.v1'].includes(row.operation)));
  });
});
test('CPA/ROAS and query exclusions remain explicitly pending until their own evidence is migrated, without a legacy read', async t => {
  for (const action of ['adjust_bids', 'negative_keywords']) await t.test(action, async t => {
    const f = await evidenceBrokerFixture(t);
    const target = action === 'adjust_bids' ? { action, entity: 'campaign', id: '30', resource: `customers/${f.input.reference.account_id}/campaigns/30`,
      field: 'target_cpa.target_cpa_micros', unit: 'micros', strategy: 'TARGET_CPA' } : { action, entity: 'campaign', id: '30',
      resource: `customers/${f.input.reference.account_id}/campaigns/30`, field: 'keyword', match_type: 'EXACT' };
    f.entry.targets = [target]; f.setting.activation.optimization.authorization.limits.actions = [action];
    const result = await collectOptimizationEvidence({ ...f.input, action }, f.deps);
    assert.deepEqual(result, { collected: false, reason: 'workspace_optimization_service_pending' });
    assert.equal(f.brokerState.commands.length, 0); assert.equal(f.state.leadQueries.length, 0);
  });
});
test('read failures, missing permissions and missing service never return partial or fabricated evidence', async t => {
  for (const [failure, expected] of [['operation_denied', 'workspace_optimization_service_pending'],
    ['credential_revoked', 'workspace_optimization_permissions_required'], ['provider_timeout', 'workspace_optimization_evidence_timeout'],
    ['rate_limited', 'workspace_optimization_rate_limited']]) await t.test(failure, async t => {
    const f = await evidenceBrokerFixture(t);
    if (failure === 'operation_denied') delete f.engine.operations['google.ads.optimization_performance.read.v1'];
    else f.brokerState.beforeResponse = () => { throw Object.assign(Error('private-provider-error'), { code: failure }); };
    assert.deepEqual(await f.run(), { collected: false, reason: expected }); assert.equal(f.brokerState.commands.length, 1);
    assert.equal(f.state.leadQueries.length, 0);
  });
});
test('loss of original authority, selection, ownership, reception or TTL invalidates the collection', async t => {
  const changes = [
    ['ACL', f => { f.state.permitted = false; }], ['binding', f => { f.scope.binding.state = 'revoked'; }],
    ['replacement', f => { f.scope.mapping.broker_read_connection_ref = f.scope.binding.connection_ref = 'connection:other'; }],
    ['selection', f => { f.setting.accounts = []; }], ['clinic', f => { f.state.workspaceCampaign.clinicId = 71; }],
    ['ownership', f => { f.state.ownership = false; }], ['reception', f => { f.state.reception = false; }],
    ['TTL', f => { f.state.now = new Date(+f.state.now + 60000); }], ['gate', f => { f.deps.env.CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED = 'false'; }],
  ];
  for (const [name, mutate] of changes) await t.test(name, async t => {
    const f = await evidenceBrokerFixture(t); f.brokerState.beforeResponse = () => mutate(f);
    const result = await f.run(); assert.equal(result.collected, false, JSON.stringify(result)); assert.equal(result.evidence, undefined);
    if (name !== 'reception') assert.equal(f.brokerState.commands.length, 1);
  });
});
test('missing rows are inferred as zero only after all sections complete and reconcile; ambiguous CRM attribution stays incomplete', async t => {
  const f = await evidenceBrokerFixture(t); const data = f.brokerState.rows.optimization_performance;
  data.campaign_daily.shift(); data.ad_daily.splice(0, 2);
  let result = await f.run(); assert.equal(result.collected, true);
  assert.equal(result.evidence.performance.campaign_daily.filter(row => row.inferred_zero).length, 1);
  assert.equal(result.evidence.performance.ad_daily.filter(row => row.inferred_zero).length, 2);
  f.state.auditRows = []; result = await f.run(); assert.equal(result.collected, true);
  assert.equal(result.evidence.attribution.complete, false); assert.equal(result.evidence.attribution.unattributed_leads, 56);
  data.ad_daily.shift(); result = await f.run(); assert.equal(result.collected, false); assert.match(result.reason, /performance_unreconciled/);
});
test('removed/restricted ads contribute to reconciliation but cannot be marked eligible for a pause', async t => {
  const f = await evidenceBrokerFixture(t); const inventory = f.brokerState.rows.optimization_performance.inventory;
  inventory[0].adGroupAd.status = 'REMOVED'; delete inventory[1].adGroupAd.policySummary;
  const result = await f.run(); assert.equal(result.collected, true);
  assert.ok(result.evidence.performance.inventory.every(row => row.active === false));
  assert.equal(result.evidence.performance.ad_daily.length, 56);
});
test('paginated inventory preserves the grant, and losing it between pages stops before metrics', async t => {
  for (const revoked of [false, true]) await t.test(String(revoked), async t => {
    const f = await evidenceBrokerFixture(t); const data = f.brokerState.rows.optimization_performance;
    data.inventory = Array.from({ length: 300 }, (_, index) => ({ ...structuredClone(data.inventory[0]),
      adGroupAd: { ...data.inventory[0].adGroupAd, ad: { id: String(60 + index) } } }));
    if (revoked) f.brokerState.beforeResponse = command => { if (command.payload.section === 'inventory') f.state.permitted = false; };
    const result = await f.run(); assert.equal(result.collected, !revoked);
    assert.equal(f.brokerState.commands.length, revoked ? 2 : 5);
    if (!revoked) assert.equal(result.evidence.performance.inventory.length, 300);
  });
});
test('authority is checked again after local CRM attribution and before returning the proof', async t => {
  const f = await evidenceBrokerFixture(t); const read = f.deps.models.LeadIntake.findAll;
  f.deps.models.LeadIntake.findAll = async query => { const rows = await read(query); f.scope.binding.state = 'revoked'; return rows; };
  const result = await f.run(); assert.equal(result.collected, false); assert.equal(result.evidence, undefined);
  assert.equal(f.brokerState.commands.length, 4);
});
test('a repeated provider cursor or duplicated daily rows prevents zero inference and CRM collection', async t => {
  const f = await evidenceBrokerFixture(t);
  f.brokerState.responseFor = command => ({
    results: structuredClone(f.brokerState.rows.optimization_performance[command.payload.section]),
    ...(command.payload.section === 'ad_daily' ? { nextPageToken: 'repeated-provider-cursor' } : {}),
  });
  const result = await f.run(); assert.equal(result.collected, false); assert.equal(result.evidence, undefined);
  assert.equal(f.state.leadQueries.length, 0); assert.equal(f.brokerState.commands.length, 5);
});

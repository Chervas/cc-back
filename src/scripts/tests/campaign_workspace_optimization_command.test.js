'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { optimizationChange, verifyChange, providerMutation, inspectOptimizationChange, readOptimizationValue,
  desiredState, mutateOptimizationChange } = require('../../services/campaignWorkspaceOptimizationCommand.service');
const env = { CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true', CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED: 'true' };
const reference = { provider: 'google_ads', account_id: '20', campaign_id: '30' };
const bid = { action: 'adjust_bids', entity: 'ad_group', id: '50', resource: 'customers/20/adGroups/50',
  field: 'cpc_bid_micros', unit: 'micros', strategy: 'MANUAL_CPC' };
const make = (patch = {}) => optimizationChange({ reference, target: bid, before: '1000000', after: '900000', ...patch });
const meta = (patch = {}) => make({ reference: { ...reference, provider: 'meta_ads' }, target: {
  ...bid, entity: 'ad_set', resource: '50', field: 'bid_amount', unit: 'minor', strategy: 'COST_CAP' }, before: '1000', after: '900', ...patch });
const negative = () => make({ target: { action: 'negative_keywords', entity: 'campaign', id: '30', resource: 'customers/20/campaigns/30',
  field: 'keyword', match_type: 'EXACT' }, before: false, after: 'empleo auxiliar' });

test('commands are exact, tamper-evident and never accept unrelated advertising fields', () => {
  const change = make(); assert.deepEqual(verifyChange(change), change);
  for (const patch of [{ after: '800000' }, { fingerprint: 'bad' }, { url: 'https://example.test' }]) {
    assert.throws(() => verifyChange({ ...change, ...patch }));
  }
  for (const patch of [{ resource: 'customers/99/adGroups/50' }, { field: 'status' }, { strategy: 'TARGET_CPA' }, { name: 'new name' }]) {
    assert.throws(() => make({ target: { ...bid, ...patch } }));
  }
  assert.throws(() => make({ reference: { ...reference, campaign_id: '30 OR 1=1' } }));
});
test('integer and ratio limits use exact decimal arithmetic including the 10 percent boundary', () => {
  assert.equal(make({ before: '9007199254740991', after: '8106479329266892' }).after, '8106479329266892');
  for (const value of ['899999', '1100001', '1000000', '0', '-1', '01', '1e6', '900000.1', '9007199254740992']) assert.throws(() => make({ after: value }));
  const target = { ...bid, entity: 'campaign', id: '30', resource: 'customers/20/campaigns/30', field: 'target_roas.target_roas', unit: 'ratio', strategy: 'TARGET_ROAS' };
  const change = make({ target, before: '2', after: '2.2' }); assert.equal(desiredState(change, '2.200000'), true);
  assert.throws(() => make({ target, before: '2', after: '2.200001' }));
  assert.equal(providerMutation(change).body.operations[0].update.targetRoas.targetRoas, 2.2);
});
test('Google mutations patch one reviewed field with its corresponding mask', () => {
  assert.deepEqual(providerMutation(make()), { path: 'customers/20/adGroups:mutate', body: { partialFailure: false,
    operations: [{ update: { resourceName: bid.resource, cpcBidMicros: '900000' }, updateMask: 'cpcBidMicros' }] } });
  const cases = [
    [{ action: 'pause_underperforming_ads', entity: 'ad', id: '60', group_id: '50', resource: 'customers/20/adGroupAds/50~60', field: 'status' }, 'ENABLED', 'PAUSED', 'adGroupAds', 'status'],
    [{ action: 'adjust_budget', entity: 'campaign_budget', id: '40', resource: 'customers/20/campaignBudgets/40', field: 'amount_micros', unit: 'micros' }, '10000000', '9000000', 'campaignBudgets', 'amountMicros'],
    [{ action: 'adjust_bids', entity: 'campaign', id: '30', resource: 'customers/20/campaigns/30', field: 'maximize_conversions.target_cpa_micros', unit: 'micros', strategy: 'MAXIMIZE_CONVERSIONS' }, '10000000', '9000000', 'campaigns', 'maximizeConversions.targetCpaMicros'],
  ];
  for (const [target, before, after, endpoint, mask] of cases) {
    const result = providerMutation(make({ target, before, after }));
    assert.equal(result.path, `customers/20/${endpoint}:mutate`); assert.equal(result.body.operations[0].updateMask, mask);
  }
});
test('negative keywords create only an exact campaign exclusion, never interpolate text into GAQL', async () => {
  const change = negative(); const operation = providerMutation(change).body.operations[0];
  assert.deepEqual(operation, { create: { campaign: 'customers/20/campaigns/30', negative: true, keyword: { text: 'empleo auxiliar', matchType: 'EXACT' } } });
  assert.equal(await readOptimizationValue(change, {}, { googleRead: async input => {
    assert.doesNotMatch(input.query, /empleo auxiliar/); assert.match(input.query, /type = 'KEYWORD'/); return [];
  } }), false);
  for (const after of ['', ' extra', 'two  spaces', 'new\nline', 'a'.repeat(81)]) assert.throws(() => make({ target: change.target, before: false, after }));
});
test('Meta mutations preserve the current owner and never include creatives, strategy or targeting', () => {
  assert.deepEqual(providerMutation(meta()), { path: '50', body: { bid_amount: '900' } });
  const target = { ...meta().target, field: 'bid_constraints.roas_average_floor', unit: 'roas_10000', strategy: 'LOWEST_COST_WITH_MIN_ROAS' };
  assert.deepEqual(providerMutation(meta({ target, before: '20000', after: '22000' })), { path: '50', body: { bid_constraints: { roas_average_floor: '22000' } } });
  const budget = { action: 'adjust_budget', entity: 'campaign', id: '30', resource: '30', field: 'daily_budget', unit: 'minor' };
  assert.deepEqual(providerMutation(meta({ target: budget })), { path: '30', body: { daily_budget: '900' } });
  const pause = { action: 'pause_underperforming_ads', entity: 'ad', id: '60', group_id: '50', resource: '60', field: 'status' };
  assert.deepEqual(providerMutation(meta({ target: pause, before: 'ACTIVE', after: 'PAUSED' })), { path: '60', body: { status: 'PAUSED' } });
});
test('preflight rejects removed targets, duplicates, strategy drift and current-value drift', async () => {
  for (const change of [make(), meta()]) {
    let targets = [{ ...change.target, value: change.before }];
    const dependencies = { inspectGoogle: async () => ({ targets }), inspectMeta: async () => ({ targets }) };
    await inspectOptimizationChange(change, {}, dependencies);
    for (const next of [[], [...targets, ...targets], [{ ...targets[0], strategy: 'other' }], [{ ...targets[0], value: change.after }]]) {
      targets = next; await assert.rejects(inspectOptimizationChange(change, {}, dependencies));
    }
  }
});
test('Google readback verifies account, campaign, resource and complete negative-keyword rows', async () => {
  const row = { customer: { id: '20' }, campaign: { id: '30' }, adGroup: { resourceName: bid.resource, cpcBidMicros: '900000' } };
  const read = (change, rows) => readOptimizationValue(change, {}, { googleRead: async () => rows });
  assert.equal(await read(make(), [row]), '900000');
  for (const rows of [[], [row, row], [{ ...row, customer: { id: '99' } }], [{ ...row, adGroup: {} }], Array(2001).fill(row)]) await assert.rejects(read(make(), rows));
  const keywordRow = { customer: row.customer, campaign: row.campaign, campaignCriterion: { negative: true, keyword: { matchType: 'EXACT', text: 'EMPLEO AUXILIAR' } } };
  assert.equal(await read(negative(), [keywordRow]), true);
  await assert.rejects(read(negative(), [{ ...keywordRow, campaignCriterion: {} }]));
  await assert.rejects(read(negative(), [{ ...keywordRow, campaignCriterion: { negative: true, keyword: { matchType: 'UNKNOWN', text: 'value' } } }]));
});
test('Meta readback rejects other campaigns and nested constraints that would be overwritten', async () => {
  const change = meta(); let row = { id: '50', account_id: '20', campaign_id: '30', bid_amount: 900 };
  const dependencies = { metaGet: async () => ({ data: row }) };
  assert.equal(await readOptimizationValue(change, {}, dependencies), '900');
  row.campaign_id = '99'; await assert.rejects(readOptimizationValue(change, {}, dependencies));
  row = { id: '50', account_id: '20', campaign_id: '30', bid_constraints: { roas_average_floor: '20000', future_constraint: 'value' } };
  const roas = meta({ target: { ...change.target, field: 'bid_constraints.roas_average_floor', unit: 'roas_10000', strategy: 'LOWEST_COST_WITH_MIN_ROAS' }, before: '20000', after: '22000' });
  await assert.rejects(readOptimizationValue(roas, {}, dependencies));
});
test('provider writes require both gates and validate acknowledgements without retrying', async () => {
  let calls = 0;
  const dependencies = { googleWrite: async () => { calls++; return { results: [{ resourceName: bid.resource }] }; } };
  for (const flags of [{}, { CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true' }, { CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED: 'true' }]) {
    await assert.rejects(mutateOptimizationChange(make(), {}, { ...dependencies, env: flags }), /workspace_optimization_disabled/);
  }
  assert.equal(calls, 0); assert.equal((await mutateOptimizationChange(make(), {}, { ...dependencies, env })).acknowledged, true);
  for (const result of [{}, { results: [] }, { results: [{ resourceName: 'foreign' }] }, { partialFailureError: {}, results: [{ resourceName: bid.resource }] }]) {
    await assert.rejects(mutateOptimizationChange(make(), {}, { env, googleWrite: async () => { calls++; return result; } }), /response_unconfirmed/);
  }
  assert.equal(calls, 5);
  await assert.rejects(mutateOptimizationChange(meta(), {}, { env, metaWrite: async () => ({ data: { success: false } }) }), /response_unconfirmed/);
  assert.equal((await mutateOptimizationChange(meta(), {}, { env, metaWrite: async () => ({ data: { success: true } }) })).acknowledged, true);
});

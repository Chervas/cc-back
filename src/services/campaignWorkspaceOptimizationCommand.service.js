'use strict';

const crypto = require('node:crypto');
const { optimizationReference, digest, inspectGoogleOptimization, inspectMetaOptimization } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { scopedTarget, LIMITS } = require('./campaignWorkspaceOptimizationAuthorization.service');
const { googleAdsSearchRows } = require('../lib/googleAdsSearchRows');

const fail = code => { throw Object.assign(new Error(code), { code, status: 409 }); };
const keys = ['action', 'entity', 'id', 'group_id', 'resource', 'field', 'unit', 'strategy', 'match_type'];
const camel = value => value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const keywordKey = value => value.normalize('NFKC').toLowerCase();
const enabled = env => env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED === 'true' && env.CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED === 'true';

function decimal(value, ratio = false) {
  if (typeof value !== 'string' || !(ratio ? /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/ : /^[1-9][0-9]*$/).test(value)
    || value.length > 22) fail('workspace_optimization_value_invalid');
  const [whole, fraction = ''] = value.split('.');
  const scaled = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (scaled <= 0n || scaled > 9007199254740991n * 1000000n) fail('workspace_optimization_value_invalid');
  return scaled;
}

function optimizationChange({ reference: input, target: source, before, after }) {
  const reference = optimizationReference(input);
  if (!source || Object.keys(source).some(key => !keys.includes(key)) || !scopedTarget(source, reference)) fail('workspace_optimization_target_invalid');
  const target = Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  if (target.action === 'negative_keywords') {
    if (before !== false || typeof after !== 'string' || !after.trim() || after !== after.trim().replace(/\s+/g, ' ')
      || after.length > 80 || after.split(' ').length > 10 || /[\u0000-\u001f\u007f]/.test(after)) fail('workspace_optimization_value_invalid');
  } else if (target.action === 'pause_underperforming_ads') {
    if (before !== (reference.provider === 'google_ads' ? 'ENABLED' : 'ACTIVE') || after !== 'PAUSED') fail('workspace_optimization_value_invalid');
  } else {
    const old = decimal(before, target.unit === 'ratio'); const next = decimal(after, target.unit === 'ratio');
    const delta = old > next ? old - next : next - old;
    if (!delta || delta * 100n > old * BigInt(target.action === 'adjust_budget' ? LIMITS.max_budget_change_pct : LIMITS.max_bid_change_pct)) fail('workspace_optimization_change_limit');
  }
  const value = { schema_version: 1, reference, target, before, after };
  return { ...value, fingerprint: digest(value) };
}

function verifyChange(change) {
  if (!change || Object.keys(change).some(key => !['schema_version', 'reference', 'target', 'before', 'after', 'fingerprint'].includes(key))) fail('workspace_optimization_change_invalid');
  const canonical = optimizationChange(change);
  const { fingerprint, ...body } = canonical;
  const legacy = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  if (change.schema_version !== 1 || fingerprint !== change.fingerprint && legacy !== change.fingerprint) fail('workspace_optimization_change_invalid');
  // Historical receipts remain inspectable. This does not re-sign or revive their old execution plan keys.
  return { ...canonical, fingerprint: change.fingerprint };
}

function providerMutation(change) {
  const { reference, target, after } = verifyChange(change);
  if (reference.provider === 'meta_ads') return { path: target.id, body: target.field === 'bid_constraints.roas_average_floor'
    ? { bid_constraints: { roas_average_floor: after } } : { [target.field]: after } };
  if (target.action === 'negative_keywords') return { path: `customers/${reference.account_id}/campaignCriteria:mutate`, body: {
    partialFailure: false, operations: [{ create: { campaign: target.resource, negative: true, keyword: { text: after, matchType: 'EXACT' } } }],
  } };
  const entity = { campaign: 'campaigns', campaign_budget: 'campaignBudgets', ad_group: 'adGroups', ad: 'adGroupAds' }[target.entity];
  const update = { resourceName: target.resource }; const fields = target.field.split('.').map(camel);
  let cursor = update;
  for (const field of fields.slice(0, -1)) cursor = cursor[field] = {};
  cursor[fields.at(-1)] = target.unit === 'ratio' ? Number(after) : after;
  return { path: `customers/${reference.account_id}/${entity}:mutate`, body: {
    partialFailure: false, operations: [{ update, updateMask: fields.join('.') }],
  } };
}

async function inspectOptimizationChange(change, credentials, dependencies = {}) {
  verifyChange(change);
  const inspect = change.reference.provider === 'google_ads'
    ? dependencies.inspectGoogle || inspectGoogleOptimization : dependencies.inspectMeta || inspectMetaOptimization;
  const inspection = await inspect({ ...credentials, reference: change.reference });
  const matches = inspection.targets.filter(row => keys.every(key => row[key] === change.target[key]));
  if (matches.length !== 1) fail('workspace_optimization_resource_changed');
  if (change.target.action !== 'negative_keywords') {
    const observed = String(matches[0].value);
    const same = change.target.action === 'pause_underperforming_ads' ? observed === change.before
      : decimal(observed, change.target.unit === 'ratio') === decimal(change.before, change.target.unit === 'ratio');
    if (!same) fail('workspace_optimization_resource_changed');
  }
  return inspection;
}

async function readOptimizationValue(change, credentials, dependencies = {}) {
  const { reference, target, after } = verifyChange(change);
  if (reference.provider === 'meta_ads') {
    const read = dependencies.metaGet || require('../lib/metaClient').metaGet;
    const fields = ['id', 'account_id', ...(target.entity === 'campaign' ? [] : ['campaign_id']),
      ...(target.entity === 'ad' ? ['adset_id'] : []), target.field.split('.')[0]];
    const row = (await read(target.id, { ...credentials, params: { fields: fields.join(',') }, maxRetries: 0,
      timeout: 8000, sensitivePayload: true, source: 'campaign_workspace', operation: 'optimization_readback' })).data;
    if (row?.id !== target.id || row.account_id !== reference.account_id
      || (target.entity === 'campaign' ? row.id : row.campaign_id) !== reference.campaign_id
      || target.entity === 'ad' && row.adset_id !== target.group_id) fail('workspace_optimization_readback_invalid');
    if (target.field === 'bid_constraints.roas_average_floor' && (!row.bid_constraints
      || Object.keys(row.bid_constraints).some(key => key !== 'roas_average_floor'))) fail('workspace_optimization_resource_changed');
    const value = target.field.split('.').reduce((current, field) => current?.[field], row);
    if (value == null) fail('workspace_optimization_readback_invalid');
    return String(value);
  }
  const read = dependencies.googleRead || googleAdsSearchRows;
  const resource = { campaign: 'campaign', campaign_budget: 'campaign_budget', ad_group: 'ad_group', ad: 'ad_group_ad' }[target.entity];
  const keyword = target.action === 'negative_keywords';
  const projection = keyword ? 'campaign_criterion.negative, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type'
    : `${resource}.resource_name, ${resource}.${target.field}`;
  const from = keyword ? 'campaign_criterion' : target.entity === 'campaign_budget' ? 'campaign' : resource;
  const filter = keyword ? "campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.status != 'REMOVED'"
    : `${resource}.resource_name = '${target.resource}'`;
  const rows = await read({ ...credentials, customerId: reference.account_id,
    query: `SELECT customer.id, campaign.id, ${projection} FROM ${from} WHERE campaign.id = ${reference.campaign_id} AND ${filter} LIMIT 2001`,
    maxPages: 5, timeoutMs: 15000 });
  if (!Array.isArray(rows) || rows.length > 2000 || rows.some(row => String(row.customer?.id) !== reference.account_id
    || String(row.campaign?.id) !== reference.campaign_id)) fail('workspace_optimization_readback_invalid');
  if (keyword) {
    if (rows.some(row => row.campaignCriterion?.negative !== true
      || !['EXACT', 'PHRASE', 'BROAD'].includes(row.campaignCriterion.keyword?.matchType)
      || typeof row.campaignCriterion.keyword.text !== 'string' || !row.campaignCriterion.keyword.text.trim())) fail('workspace_optimization_readback_invalid');
    return rows.some(row => row.campaignCriterion.keyword.matchType === 'EXACT' && keywordKey(row.campaignCriterion.keyword.text) === keywordKey(after));
  }
  if (rows.length !== 1 || rows[0][camel(resource)]?.resourceName !== target.resource) fail('workspace_optimization_readback_invalid');
  const value = target.field.split('.').map(camel).reduce((current, field) => current?.[field], rows[0][camel(resource)]);
  if (value == null) fail('workspace_optimization_readback_invalid');
  return String(value);
}

function desiredState(change, value) {
  verifyChange(change);
  if (change.target.action === 'negative_keywords') return value === true;
  if (change.target.action === 'pause_underperforming_ads') return value === change.after;
  try { return decimal(String(value), change.target.unit === 'ratio') === decimal(change.after, change.target.unit === 'ratio'); }
  catch { return false; }
}

async function mutateOptimizationChange(change, credentials, dependencies = {}) {
  if (!enabled(dependencies.env || process.env)) fail('workspace_optimization_disabled');
  const mutation = providerMutation(change);
  if (change.reference.provider === 'meta_ads') {
    const write = dependencies.metaWrite || require('../lib/metaClient').metaUpdateAdvertisingResource;
    const result = (await write(mutation.path, mutation.body, { ...credentials, timeout: 10000,
      source: 'campaign_workspace', operation: 'optimization_adjustment', sensitivePayload: true })).data;
    if (result?.success !== true) fail('workspace_optimization_response_unconfirmed');
    return { acknowledged: true };
  }
  const write = dependencies.googleWrite || require('../lib/googleAdsClient').googleAdsRequest;
  const result = await write('POST', mutation.path, { ...credentials, data: mutation.body, timeoutMs: 10000, waitNextHour: false });
  const expected = change.target.action === 'negative_keywords'
    ? new RegExp(`^customers/${change.reference.account_id}/campaignCriteria/${change.reference.campaign_id}~[1-9][0-9]*$`) : null;
  if (result?.partialFailureError || !Array.isArray(result?.results) || result.results.length !== 1
    || (expected ? !expected.test(result.results[0].resourceName) : result.results[0].resourceName !== change.target.resource)) fail('workspace_optimization_response_unconfirmed');
  return { acknowledged: true, resource_name: result.results[0].resourceName };
}

module.exports = { enabled, optimizationChange, verifyChange, providerMutation, inspectOptimizationChange,
  readOptimizationValue, desiredState, mutateOptimizationChange };

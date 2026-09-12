'use strict';

const { optimizationReference, digest } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { googleAdsSearchRows } = require('../lib/googleAdsSearchRows');
const { graphList } = require('./campaignWorkspaceMetaDestination.service');
const { formatDateLocal } = require('../lib/availability-calendar');
const { googleAdHasUnrestrictedDelivery } = require('./googleAdDelivery.service');

const DAYS = 28;
const EXCLUDED_DAYS = 2;
const MAX_ADS = 2000;
const MAX_ROWS = DAYS * MAX_ADS;
const TIMEOUT_MS = 45000;
const fail = suffix => { throw Object.assign(new Error(`workspace_optimization_performance_${suffix}`),
  { code: `workspace_optimization_performance_${suffix}` }); };
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value);
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

function performancePeriod(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(+now)) fail('invalid');
  const today = formatDateLocal(now, 'Europe/Madrid');
  const end = shift(today, -EXCLUDED_DAYS - 1);
  return { start: shift(end, 1 - DAYS), end, days: DAYS, time_zone: 'Europe/Madrid', excluded_days: EXCLUDED_DAYS };
}

function integer(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,21})$/.test(value)) fail('incomplete');
  return BigInt(value);
}

function clicks(value) {
  const result = integer(value);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) fail('incomplete');
  return Number(result);
}

function amount(value, provider) {
  let micros;
  if (provider === 'google_ads') micros = integer(value);
  else {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/.test(value)) fail('incomplete');
    const [whole, decimal = ''] = value.split('.');
    micros = (BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'))) * 10000n;
  }
  if (micros > BigInt(Number.MAX_SAFE_INTEGER) * 10000n) fail('incomplete');
  return micros.toString();
}

function owner(currency, timezone) {
  if (currency !== 'EUR') fail('currency');
  if (timezone !== 'Europe/Madrid') fail('timezone');
}

function inventoryIndex(inventory, provider) {
  const ads = new Map(); const metaIds = new Set();
  if (inventory.length > MAX_ADS) fail('incomplete');
  for (const ad of inventory) {
    const key = `${ad.group_id}~${ad.id}`;
    if (!id(ad.id) || !id(ad.group_id) || typeof ad.active !== 'boolean' || ads.has(key)
      || provider === 'meta_ads' && metaIds.has(ad.id)) fail('incomplete');
    ads.set(key, ad); metaIds.add(ad.id);
  }
  return ads;
}

function session({ reference, provider, now, clock }) {
  optimizationReference(reference);
  if (reference.provider !== provider) fail('invalid');
  const period = performancePeriod(now()); const started = +now(); const deadline = clock() + TIMEOUT_MS;
  const remaining = () => {
    const left = deadline - clock(); const current = now();
    if (left <= 0 || +current < started || +current - started >= TIMEOUT_MS) fail('timeout');
    if (digest(performancePeriod(current)) !== digest(period)) fail('period_changed');
    return left;
  };
  return { period, remaining, observedAt: () => { remaining(); return now().toISOString(); } };
}

// Collection completeness is not billing finality or proof of complete CRM attribution.
function snapshot(reference, period, inventory, campaignRows, adRows, observedAt) {
  const dates = new Set(Array.from({ length: DAYS }, (_, index) => shift(period.start, index)));
  const ads = inventoryIndex(inventory, reference.provider); const campaign = new Map(); const daily = new Map();
  if (inventory.length > MAX_ADS || campaignRows.length > DAYS || adRows.length > MAX_ROWS) fail('incomplete');
  for (const row of campaignRows) {
    if (!dates.has(row.date) || campaign.has(row.date)) fail('incomplete');
    if (!Number.isSafeInteger(row.clicks) || row.clicks < 0 || amount(row.cost_micros, 'google_ads') !== row.cost_micros) fail('incomplete');
    campaign.set(row.date, row);
  }
  for (const row of adRows) {
    const key = `${row.group_id}~${row.ad_id}`; const rowKey = `${key}:${row.date}`;
    if (!dates.has(row.date) || !ads.has(key) || daily.has(rowKey)) fail('incomplete');
    if (!Number.isSafeInteger(row.clicks) || row.clicks < 0 || amount(row.cost_micros, 'google_ads') !== row.cost_micros) fail('incomplete');
    daily.set(rowKey, row);
  }
  // Only Google's completed segmented query has documented all-zero omission semantics.
  // Meta omissions remain unknown: no invented zero and no executable comparison for that day.
  if (reference.provider === 'google_ads') for (const date of dates) {
    if (!campaign.has(date)) campaign.set(date, { date, clicks: 0, cost_micros: '0', inferred_zero: true });
    for (const [key, ad] of ads) if (!daily.has(`${key}:${date}`)) daily.set(`${key}:${date}`,
      { date, ad_id: ad.id, group_id: ad.group_id, clicks: 0, cost_micros: '0', inferred_zero: true });
  }
  const totals = new Map();
  for (const row of daily.values()) {
    const total = totals.get(row.date) || { clicks: 0n, micros: 0n };
    total.clicks += BigInt(row.clicks); total.micros += BigInt(row.cost_micros); totals.set(row.date, total);
  }
  for (const date of dates) {
    const actual = totals.get(date); const expected = campaign.get(date);
    if (!expected && actual) fail('unreconciled');
    if (!expected) continue;
    const difference = BigInt(expected.cost_micros) - (actual?.micros || 0n);
    if (BigInt(expected.clicks) !== (actual?.clicks || 0n) || difference > 10000n || difference < -10000n) fail('unreconciled');
  }
  const sortRows = values => [...values].sort((a, b) => `${a.date}:${a.group_id || ''}:${a.ad_id || ''}`
    .localeCompare(`${b.date}:${b.group_id || ''}:${b.ad_id || ''}`));
  const result = { schema_version: 1, reference, period, currency: 'EUR', observed_at: observedAt,
    source: reference.provider === 'google_ads' ? 'google_ads_complete_search' : 'meta_graph_complete_insights',
    inventory: [...ads.values()].sort((a, b) => `${a.group_id}~${a.id}`.localeCompare(`${b.group_id}~${b.id}`)),
    campaign_daily: sortRows(campaign.values()), ad_daily: sortRows(daily.values()) };
  return { ...result, fingerprint: digest(result) };
}

async function inspectGooglePerformance({ reference, accessToken, loginCustomerId,
  now = () => new Date(), clock = Date.now, read = googleAdsSearchRows }) {
  const collect = session({ reference, provider: 'google_ads', now, clock });
  const account = reference.account_id; const campaignId = reference.campaign_id;
  const search = async (query, limit) => {
    const rows = await read({ customerId: account, accessToken, loginCustomerId, query: `${query} LIMIT ${limit + 1}`,
      maxPages: 12, timeoutMs: collect.remaining() });
    collect.remaining();
    if (!Array.isArray(rows) || rows.length > limit || rows.some(row => row.customer?.id !== account
      || row.campaign?.id !== campaignId)) fail('incomplete');
    return rows;
  };
  const metadata = await search(`SELECT customer.id, customer.currency_code, customer.time_zone, campaign.id,
    campaign.status, campaign.experiment_type, campaign.advertising_channel_type
    FROM campaign WHERE campaign.id = ${campaignId}`, 1);
  if (metadata.length !== 1) fail('incomplete');
  owner(metadata[0].customer.currencyCode, metadata[0].customer.timeZone);
  if (metadata[0].campaign.status !== 'ENABLED' || metadata[0].campaign.experimentType !== 'BASE'
    || metadata[0].campaign.advertisingChannelType !== 'SEARCH') fail('unsupported');
  const inventoryRows = await search(`SELECT customer.id, campaign.id, ad_group.id, ad_group.status,
    ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.primary_status,
    ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE campaign.id = ${campaignId}
    AND ad_group_ad.status IN ('ENABLED', 'PAUSED', 'REMOVED') AND ad_group.status IN ('ENABLED', 'PAUSED', 'REMOVED')`, MAX_ADS);
  const inventory = inventoryRows.map(row => {
    if (!id(row.adGroup?.id) || !id(row.adGroupAd?.ad?.id) || !['ENABLED', 'PAUSED', 'REMOVED'].includes(row.adGroup?.status)
      || !['ENABLED', 'PAUSED', 'REMOVED'].includes(row.adGroupAd?.status)) fail('incomplete');
    return { id: row.adGroupAd.ad.id, group_id: row.adGroup.id,
      active: googleAdHasUnrestrictedDelivery({ campaignStatus: metadata[0].campaign.status,
        adGroupStatus: row.adGroup.status, groupAd: row.adGroupAd }) };
  });
  inventoryIndex(inventory, 'google_ads');
  const condition = `WHERE campaign.id = ${campaignId} AND segments.date BETWEEN '${collect.period.start}' AND '${collect.period.end}'`;
  const campaignRows = await search(`SELECT customer.id, campaign.id, segments.date, metrics.clicks,
    metrics.cost_micros FROM campaign ${condition}`, DAYS);
  const adRows = await search(`SELECT customer.id, campaign.id, ad_group.id, ad_group_ad.ad.id,
    segments.date, metrics.clicks, metrics.cost_micros FROM ad_group_ad ${condition}
    AND ad_group_ad.status IN ('ENABLED', 'PAUSED', 'REMOVED') AND ad_group.status IN ('ENABLED', 'PAUSED', 'REMOVED')`, MAX_ROWS);
  const metric = row => ({ date: row.segments?.date, clicks: clicks(row.metrics?.clicks),
    cost_micros: amount(row.metrics?.costMicros, 'google_ads') });
  return snapshot(reference, collect.period, inventory, campaignRows.map(metric), adRows.map(row => {
    if (!id(row.adGroupAd?.ad?.id) || !id(row.adGroup?.id)) fail('incomplete');
    return { ...metric(row), ad_id: row.adGroupAd.ad.id, group_id: row.adGroup.id };
  }), collect.observedAt());
}

async function inspectMetaPerformance({ reference, accessToken, now = () => new Date(), clock = Date.now,
  read = require('../lib/metaClient').metaGet }) {
  const collect = session({ reference, provider: 'meta_ads', now, clock });
  const account = reference.account_id; const campaignId = reference.campaign_id;
  const get = async (path, options = {}) => {
    const response = await read(path, { ...options, accessToken, maxRetries: 0, timeout: Math.min(8000, collect.remaining()),
      sensitivePayload: true, source: 'campaign_workspace', operation: 'optimization_performance_snapshot' });
    collect.remaining();
    if (!response?.data || response.data.error) fail('incomplete');
    return response;
  };
  const accountRow = (await get(`act_${account}`, { params: { fields: 'id,account_id,currency,timezone_name' } })).data;
  if (accountRow.id !== `act_${account}` || accountRow.account_id !== account) fail('incomplete');
  owner(accountRow.currency, accountRow.timezone_name);
  const campaignRow = (await get(campaignId, { params: { fields: 'id,account_id,status,effective_status,buying_type' } })).data;
  if (campaignRow.id !== campaignId || campaignRow.account_id !== account) fail('incomplete');
  if (campaignRow.status !== 'ACTIVE' || campaignRow.effective_status !== 'ACTIVE' || campaignRow.buying_type !== 'AUCTION') fail('unsupported');
  const list = async (path, fields, params, limit, pages) => {
    const result = await graphList(path, fields, accessToken, async (endpoint, options) => {
      const response = await get(endpoint, { ...options, params: { ...options.params, ...params, limit: 1000 } });
      if (!Array.isArray(response.data.data) || response.data.data.length > 1000) fail('incomplete');
      return response;
    }, pages);
    if (!result.complete || result.rows.length > limit) fail('incomplete');
    return result.rows;
  };
  const inventoryRows = await list(`${campaignId}/ads`, 'id,account_id,campaign_id,adset_id,status,effective_status', {}, MAX_ADS, 3);
  const inventory = inventoryRows.map(row => {
    if (row.account_id !== account || row.campaign_id !== campaignId
      || !['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED'].includes(row.status)
      || typeof row.effective_status !== 'string' || !row.effective_status) fail('incomplete');
    return { id: row.id, group_id: row.adset_id, active: row.status === 'ACTIVE' && row.effective_status === 'ACTIVE' };
  });
  inventoryIndex(inventory, 'meta_ads');
  const fields = 'account_id,campaign_id,date_start,date_stop,clicks,spend';
  const params = { time_range: JSON.stringify({ since: collect.period.start, until: collect.period.end }), time_increment: 1 };
  const campaignRows = await list(`${campaignId}/insights`, fields, { ...params, level: 'campaign' }, DAYS, 2);
  const adRows = await list(`${campaignId}/insights`, `${fields},adset_id,ad_id`, { ...params, level: 'ad' }, MAX_ROWS, 57);
  const metric = row => {
    if (row.account_id !== account || row.campaign_id !== campaignId || row.date_start !== row.date_stop) fail('incomplete');
    return { date: row.date_start, clicks: clicks(row.clicks), cost_micros: amount(row.spend, 'meta_ads') };
  };
  return snapshot(reference, collect.period, inventory, campaignRows.map(metric), adRows.map(row => ({ ...metric(row),
    ad_id: row.ad_id, group_id: row.adset_id })), collect.observedAt());
}

function verifyPerformanceSnapshot(value, reference, now) {
  const { fingerprint, ...body } = value || {};
  if (!value || value.schema_version !== 1 || fingerprint !== digest(body) || digest(value.reference) !== digest(reference)
    || digest(value.period) !== digest(performancePeriod(now)) || value.currency !== 'EUR'
    || !Array.isArray(value.inventory) || !Array.isArray(value.campaign_daily) || !Array.isArray(value.ad_daily)) fail('incomplete');
  const rebuilt = snapshot(reference, value.period, value.inventory, value.campaign_daily, value.ad_daily, value.observed_at);
  if (rebuilt.fingerprint !== fingerprint) fail('incomplete');
  return value;
}

module.exports = { DAYS, EXCLUDED_DAYS, performancePeriod, inspectGooglePerformance, inspectMetaPerformance, verifyPerformanceSnapshot };

'use strict';
const { schema } = require('./contracts');
const { fail } = require('./errors');
const PROVIDER = 'google_ads';
const PREFIX = 'google.ads.';
const API_VERSION = 'v24';
const SCOPES = Object.freeze(['https://www.googleapis.com/auth/adwords']);
const FAMILIES = Object.freeze(['account', 'campaigns', 'campaign_metrics', 'adgroup_metrics']);
const OPERATIONS = Object.freeze(FAMILIES.map(name => PREFIX + name + '.read.v1'));
const REVOKE_OPERATION = PREFIX + 'asset.revoke.v1';
const PROVIDER_PAGE_SIZE = 10000;
const PAGE_SIZE = 250;
const MAX_ROWS = 100000;
const RESOURCE_FIELDS = ['customer.id', 'campaign.id', 'campaign.name', 'campaign.status',
  'campaign.serving_status', 'campaign.primary_status', 'campaign.primary_status_reasons'];
const METRICS = ['impressions', 'clicks', 'cost_micros', 'conversions', 'conversions_value',
  'all_conversions', 'all_conversions_value', 'interactions'];
const date = value => typeof value === 'string' && /^20\d\d-\d\d-\d\d$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const customer = value => typeof value === 'string' && /^[0-9]{10}$/.test(value) && value !== '0000000000';
const integerId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
function resource(binding, assetRef) {
  const row = binding?.googleAdsAccounts?.find(item => item.assetRef === assetRef);
  if (!row || !customer(row.customerId) || assetRef !== 'ads:' + row.customerId
    || row.loginCustomerId !== null && !customer(row.loginCustomerId)) fail('scope_denied');
  return { customerId: row.customerId, loginCustomerId: row.loginCustomerId };
}
const cursor = { pageToken: { type: ['string', 'null'], maxLength: 4096 } };
const validators = { account: schema({}), campaigns: schema(cursor),
  campaign_metrics: schema({ ...cursor, startDate: { type: 'string' }, endDate: { type: 'string' } }),
  adgroup_metrics: schema({ ...cursor, startDate: { type: 'string' }, endDate: { type: 'string' } }) };
function family(operation) {
  const index = OPERATIONS.indexOf(operation); if (index < 0) fail('operation_denied'); return FAMILIES[index];
}
function validate(operation, payload) {
  const name = family(operation); validators[name](payload);
  if (name.endsWith('_metrics') && (!date(payload.startDate) || !date(payload.endDate)
    || payload.endDate < payload.startDate || Date.parse(payload.endDate) - Date.parse(payload.startDate) > 14 * 86400000)) fail('invalid_request');
  return payload;
}
function query(name, payload) {
  if (!FAMILIES.includes(name)) fail('operation_denied');
  validate(PREFIX + name + '.read.v1', payload);
  if (name === 'account') return 'SELECT customer.id, customer.manager, customer.currency_code, customer.time_zone FROM customer LIMIT 2';
  if (name === 'campaigns') return `SELECT ${RESOURCE_FIELDS.join(', ')} FROM campaign WHERE campaign.status IN ('ENABLED', 'PAUSED', 'REMOVED') LIMIT 5001`;
  const fields = [...RESOURCE_FIELDS, 'segments.date', 'segments.ad_network_type', 'segments.device', ...METRICS.map(key => `metrics.${key}`)];
  const groups = name === 'adgroup_metrics';
  if (groups) fields.push('ad_group.id', 'ad_group.name');
  return `SELECT ${fields.join(', ')} FROM ${groups ? 'ad_group' : 'campaign'} WHERE segments.date BETWEEN '${payload.startDate}' AND '${payload.endDate}' AND campaign.status IN ('ENABLED', 'PAUSED', 'REMOVED')${groups ? " AND ad_group.status IN ('ENABLED', 'PAUSED', 'REMOVED')" : ''} LIMIT 100001`;
}
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, max, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || /[\x00-\x1f]/.test(value)) fail('provider_failed');
  return value;
}
function enumText(value) {
  const result = text(value, 64);
  if (result && !/^[A-Z][A-Z0-9_]*$/.test(result)) fail('provider_failed'); return result;
}
const camel = value => value.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function numeric(value, integer) {
  if (value === undefined) return 0;
  if (!['string', 'number'].includes(typeof value) || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(String(value))
    || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > Number.MAX_SAFE_INTEGER
    || integer && !Number.isSafeInteger(Number(value))) fail('provider_failed');
  return value;
}
function projectPage(name, raw, payload, account) {
  if (!plain(raw) || raw.error || raw.results !== undefined && !Array.isArray(raw.results)) fail('provider_failed');
  const rows = raw.results || [];
  if (rows.length > PROVIDER_PAGE_SIZE || name === 'account' && rows.length !== 1) fail('provider_failed');
  const results = rows.map(row => {
    if (!plain(row) || !plain(row.customer) || row.customer.id !== account.customerId) fail('provider_failed');
    if (name === 'account') {
      if (row.customer.manager !== undefined && row.customer.manager !== false
        || !/^[A-Z]{3}$/.test(row.customer.currencyCode || '')) fail('provider_failed');
      const timeZone = text(row.customer.timeZone, 128);
      try { new Intl.DateTimeFormat('en-US', { timeZone }).format(); } catch { fail('provider_failed'); }
      if (!timeZone) fail('provider_failed');
      return { customer: { id: account.customerId, manager: false, currencyCode: row.customer.currencyCode, timeZone } };
    }
    const c = row.campaign;
    if (!plain(c) || !integerId(c.id) || !['ENABLED', 'PAUSED', 'REMOVED'].includes(c.status)) fail('provider_failed');
    const reasons = c.primaryStatusReasons ?? [];
    if (!Array.isArray(reasons) || reasons.length > 50) fail('provider_failed');
    const result = { customer: { id: account.customerId }, campaign: { id: c.id, name: text(c.name, 1024), status: c.status,
      servingStatus: enumText(c.servingStatus), primaryStatus: enumText(c.primaryStatus), primaryStatusReasons: reasons.map(enumText) } };
    if (name === 'campaigns') return result;
    if (!plain(row.segments) || !date(row.segments.date) || row.segments.date < payload.startDate || row.segments.date > payload.endDate
      || row.metrics !== undefined && !plain(row.metrics)) fail('provider_failed');
    const device = enumText(row.segments.device); const adNetworkType = enumText(row.segments.adNetworkType);
    if (!device || !adNetworkType) fail('provider_failed');
    result.segments = { date: row.segments.date, device, adNetworkType };
    result.metrics = Object.fromEntries(METRICS.map(key => [camel(key), numeric(row.metrics?.[camel(key)], ['impressions', 'clicks', 'cost_micros', 'interactions'].includes(key))]));
    if (name === 'adgroup_metrics') {
      if (!plain(row.adGroup) || !integerId(row.adGroup.id)) fail('provider_failed');
      result.adGroup = { id: row.adGroup.id, name: text(row.adGroup.name, 1024) };
    }
    return result;
  });
  const seen = new Set();
  for (const result of results) {
    const key = JSON.stringify([result.customer.id, result.campaign?.id, result.adGroup?.id,
      result.segments?.date, result.segments?.adNetworkType, result.segments?.device]);
    if (seen.has(key)) fail('provider_failed'); seen.add(key);
  }
  const nextPageToken = raw.nextPageToken === undefined || raw.nextPageToken === '' ? null : raw.nextPageToken;
  if (nextPageToken !== null && (typeof nextPageToken !== 'string' || !/^[\x21-\x7e]{1,1536}$/.test(nextPageToken)
    || !results.length || name === 'account')) fail('provider_failed');
  if (Buffer.byteLength(JSON.stringify(results)) > 16 * 1024 * 1024) fail('provider_failed');
  return { results, nextPageToken };
}
module.exports = { PROVIDER, PREFIX, API_VERSION, SCOPES, FAMILIES, OPERATIONS, REVOKE_OPERATION,
  PROVIDER_PAGE_SIZE, PAGE_SIZE, MAX_ROWS, resource, customer, family, validate, query, projectPage };

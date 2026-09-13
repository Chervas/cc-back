'use strict';
const { schema } = require('./contracts'); const { fail } = require('./errors');
const { date } = require('./google-search-console-contract');
const discovery = require('./google-property-discovery-contract');
const PROVIDER = 'google_analytics'; const PREFIX = 'google.analytics.';
const SCOPES = Object.freeze(['https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/analytics']);
const FAMILIES = Object.freeze({ daily: null, channel: 'sessionDefaultChannelGroup', source_medium: 'sessionSourceMedium',
  device: 'deviceCategory', country: 'country', city: 'city', language: 'language', gender: 'userGender', age: 'userAgeBracket' });
const METRICS = Object.freeze(['sessions', 'activeUsers', 'newUsers', 'keyEvents', 'totalRevenue']);
const OPERATIONS = Object.freeze([...Object.keys(FAMILIES).map(f => PREFIX + f + '.read.v1'), discovery.GA_OPERATION]);
const PAGE_SIZE = 500; const MAX_ROWS = 100000;
function property(value) {
  if (typeof value !== 'string' || !/^properties\/[1-9]\d{0,19}$/.test(value)) fail('scope_denied');
  return { propertyName: value, assetRef: 'ga4:' + value.slice(11) };
}
function resource(binding, assetRef) {
  const row = binding?.analyticsProperties?.find(value => value.assetRef === assetRef);
  if (!row) fail('scope_denied'); const parsed = property(row.propertyName);
  if (parsed.assetRef !== assetRef) fail('scope_denied'); return parsed;
}
const check = schema({ startDate: { type: 'string' }, endDate: { type: 'string' }, pageToken: { type: ['string', 'null'], maxLength: 4096 } });
function validate(operation, payload) {
  if (operation === discovery.GA_OPERATION) return discovery.validate(payload);
  if (!OPERATIONS.includes(operation)) fail('operation_denied'); check(payload);
  if (!date(payload.startDate) || !date(payload.endDate) || payload.endDate < payload.startDate
    || Date.parse(payload.endDate) - Date.parse(payload.startDate) > 549 * 86400000) fail('invalid_request');
  return payload;
}
const dimensions = family => {
  if (!Object.hasOwn(FAMILIES, family)) fail('operation_denied');
  return FAMILIES[family] ? ['date', FAMILIES[family]] : ['date'];
};
function projectMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(raw.currencyCode)
    || typeof raw.timeZone !== 'string' || raw.timeZone.length > 64 || !/^[A-Za-z0-9_+/-]+$/.test(raw.timeZone)) fail('provider_failed');
  try { new Intl.DateTimeFormat('en-US', { timeZone: raw.timeZone }); } catch { fail('provider_failed'); }
  const result = { currencyCode: raw.currencyCode, timeZone: raw.timeZone };
  for (const key of ['dataLossFromOtherRow', 'subjectToThresholding']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') fail('provider_failed'); result[key] = raw[key] || false;
  }
  if (raw.emptyReason !== undefined && (typeof raw.emptyReason !== 'string' || Buffer.byteLength(raw.emptyReason) > 1024)) fail('provider_failed');
  result.emptyReason = raw.emptyReason ? 'provider_report_empty' : '';
  if (raw.schemaRestrictionResponse !== undefined) {
    const restriction = raw.schemaRestrictionResponse;
    if (!restriction || typeof restriction !== 'object' || Array.isArray(restriction)
      || restriction.activeMetricRestrictions !== undefined && (!Array.isArray(restriction.activeMetricRestrictions) || restriction.activeMetricRestrictions.length)) fail('provider_failed');
  }
  const sampling = raw.samplingMetadatas === undefined ? [] : raw.samplingMetadatas;
  if (!Array.isArray(sampling) || sampling.length > 1) fail('provider_failed');
  result.samplingMetadatas = sampling.map(row => {
    if (!row || !['samplesReadCount', 'samplingSpaceSize'].every(k => typeof row[k] === 'string' && /^(0|[1-9]\d{0,19})$/.test(row[k]))
      || BigInt(row.samplingSpaceSize) < 1n || BigInt(row.samplesReadCount) > BigInt(row.samplingSpaceSize)) fail('provider_failed');
    return { samplesReadCount: row.samplesReadCount, samplingSpaceSize: row.samplingSpaceSize };
  });
  return result;
}
function project(family, raw, payload) {
  const dims = dimensions(family);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.error) fail('provider_failed');
  if (!Array.isArray(raw.dimensionHeaders) || raw.dimensionHeaders.length !== dims.length
    || raw.dimensionHeaders.some((h, i) => h?.name !== dims[i]) || !Array.isArray(raw.metricHeaders) || raw.metricHeaders.length !== METRICS.length
    || raw.metricHeaders.some((h, i) => h?.name !== METRICS[i] || !(i < 3 ? ['TYPE_INTEGER'] : i === 3 ? ['TYPE_INTEGER', 'TYPE_FLOAT'] : ['TYPE_CURRENCY', 'TYPE_FLOAT']).includes(h?.type))) fail('provider_failed');
  const rows = raw.rows === undefined ? [] : raw.rows; const count = raw.rowCount === undefined && !rows?.length ? 0 : raw.rowCount;
  if (!Number.isSafeInteger(count) || count < 0 || count > 2147483647 || family === 'daily' && count > 550
    || !Array.isArray(rows) || rows.length > PAGE_SIZE || rows.length > count) fail('provider_failed');
  const seen = new Set();
  const projected = rows.map(row => {
    if (!Array.isArray(row?.dimensionValues) || row.dimensionValues.length !== dims.length
      || row.dimensionValues.some(v => typeof v?.value !== 'string' || [...v.value].length > 256 || Buffer.byteLength(v.value) > 1024 || /[\x00-\x1f]/.test(v.value))) fail('provider_failed');
    const key = row.dimensionValues[0].value; const normalized = key.slice(0, 4) + '-' + key.slice(4, 6) + '-' + key.slice(6);
    if (!/^20\d{6}$/.test(key) || !date(normalized) || normalized < payload.startDate || normalized > payload.endDate) fail('provider_failed');
    const signature = JSON.stringify(row.dimensionValues.map(v => v.value)); if (seen.has(signature)) fail('provider_failed'); seen.add(signature);
    if (!Array.isArray(row.metricValues) || row.metricValues.length !== METRICS.length) fail('provider_failed');
    const values = row.metricValues.map((v, i) => {
      if (typeof v?.value !== 'string' || v.value.length > 64 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(v.value)) fail('provider_failed');
      const n = Number(v.value);
      if (!Number.isFinite(n) || (i < 4 ? n < 0 || Math.round(n) > 2147483647 || i < 3 && !Number.isInteger(n) : Math.abs(n) > 9999999999.99)) fail('provider_failed');
      return { value: v.value };
    });
    return { dimensionValues: row.dimensionValues.map(v => ({ value: v.value })), metricValues: values };
  });
  const metadata = projectMetadata(raw.metadata); if (metadata.emptyReason && rows.length) fail('provider_failed');
  const result = { dimensionHeaders: dims.map(name => ({ name })), metricHeaders: raw.metricHeaders.map(h => ({ name: h.name, type: h.type })),
    rows: projected, rowCount: count, metadata };
  if (Buffer.byteLength(JSON.stringify(result)) > 786432) fail('provider_failed'); return result;
}
module.exports = { PROVIDER, PREFIX, SCOPES, FAMILIES, METRICS, OPERATIONS, PAGE_SIZE, MAX_ROWS, property, resource, validate, dimensions, project };

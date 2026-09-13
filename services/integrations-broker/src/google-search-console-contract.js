'use strict';
const { createHash } = require('node:crypto');
const { schema } = require('./contracts'); const { fail } = require('./errors');
const PROVIDER = 'google_search_console'; const PREFIX = 'google.search_console.';
const SCOPES = Object.freeze(['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/webmasters']);
const OPERATIONS = Object.freeze(['timeseries', 'queries', 'pages', 'inspection'].map(v => PREFIX + v + '.read.v1'));
const PAGE_SIZE = 500; const MAX_ROWS = 25000;
const date = v => typeof v === 'string' && /^20\d\d-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
function site(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\s\\%?#]/.test(value)) fail('scope_denied');
  const domain = value.startsWith('sc-domain:') ? value.slice(10) : null;
  if (domain !== null) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) fail('scope_denied');
  } else {
    let url; try { url = new URL(value); } catch { fail('scope_denied'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.href !== value
      || !value.endsWith('/') || !/^\/[A-Za-z0-9/_~.-]*$/.test(url.pathname)
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)) fail('scope_denied');
  }
  const siteHash = createHash('sha256').update(value).digest('hex');
  return { siteUrl: value, siteHash, assetRef: 'sc:' + siteHash, inspectionUrl: domain ? `https://${domain}/` : value };
}
function resource(binding, assetRef) {
  const value = binding?.searchConsoleSites?.find(row => row.assetRef === assetRef);
  if (!value) fail('scope_denied'); const parsed = site(value.siteUrl);
  if (parsed.assetRef !== assetRef) fail('scope_denied'); return parsed;
}
const range = { startDate: { type: 'string' }, endDate: { type: 'string' } };
const validators = {
  timeseries: schema(range), inspection: schema({}),
  queries: schema({ ...range, pageToken: { type: ['string', 'null'], maxLength: 4096 } }),
  pages: schema({ ...range, startRow: { type: 'integer', minimum: 0, maximum: MAX_ROWS - 1 }, rowLimit: { type: 'integer', minimum: 1, maximum: PAGE_SIZE } }),
};
function validate(operation, payload) {
  if (!OPERATIONS.includes(operation)) fail('operation_denied');
  const family = operation.slice(PREFIX.length).split('.')[0]; validators[family](payload);
  if (family !== 'inspection' && (!date(payload.startDate) || !date(payload.endDate) || payload.endDate < payload.startDate
    || Date.parse(payload.endDate) - Date.parse(payload.startDate) > (family === 'queries' ? 61 : 549) * 86400000)) fail('invalid_request');
  if (family === 'pages' && payload.startRow + payload.rowLimit > MAX_ROWS) fail('invalid_request');
  return payload;
}
function project(family, raw, payload) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.error) fail('provider_failed');
  if (family === 'inspection') {
    const status = raw.inspectionResult?.indexStatusResult;
    if (!status || typeof status !== 'object' || Array.isArray(status)) fail('provider_failed');
    if (status.verdict !== undefined && !['VERDICT_UNSPECIFIED', 'PASS', 'PARTIAL', 'FAIL', 'NEUTRAL'].includes(status.verdict)
      || status.coverageState !== undefined && (typeof status.coverageState !== 'string' || Buffer.byteLength(status.coverageState) > 1024)) fail('provider_failed');
    return { inspectionResult: { indexStatusResult: { verdict: status.verdict || 'VERDICT_UNSPECIFIED', coverageState: status.coverageState || '' } } };
  }
  if (raw.rows !== undefined && !Array.isArray(raw.rows)) fail('provider_failed');
  const rows = raw.rows || []; const maximum = family === 'timeseries' ? 550 : family === 'pages' ? payload.rowLimit : PAGE_SIZE;
  if (rows.length > maximum) fail('provider_failed');
  const seen = new Set(); const projected = rows.map(row => {
    if (!row || !Array.isArray(row.keys) || row.keys.length !== (family === 'queries' ? 3 : 1)
      || row.keys.some(v => typeof v !== 'string' || Buffer.byteLength(v) > 8192 || /[\x00-\x1f]/.test(v))) fail('provider_failed');
    if (family !== 'pages' && (!date(row.keys[0]) || row.keys[0] < payload.startDate || row.keys[0] > payload.endDate)) fail('provider_failed');
    const key = JSON.stringify(row.keys); if (seen.has(key)) fail('provider_failed'); seen.add(key);
    const values = Object.fromEntries(['clicks', 'impressions', 'ctr', 'position'].map(k => [k, row[k] ?? 0]));
    if (Object.values(values).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) || values.ctr > 1) fail('provider_failed');
    return { keys: row.keys.slice(), ...values };
  });
  const result = { rows: projected };
  if (raw.responseAggregationType !== undefined) {
    if (!['auto', 'byPage', 'byProperty'].includes(raw.responseAggregationType)) fail('provider_failed');
    result.responseAggregationType = raw.responseAggregationType;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 786432) fail('provider_failed');
  return result;
}
module.exports = { PROVIDER, PREFIX, SCOPES, OPERATIONS, PAGE_SIZE, MAX_ROWS, date, site, resource, validate, project };

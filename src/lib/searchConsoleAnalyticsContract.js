'use strict';

const { createHash } = require('node:crypto');
const { site } = require('../../services/integrations-broker/src/google-search-console-contract');
const SCALE = 1000000000n;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const date = value => {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('sc_analytics_invalid_date');
  return value;
};
function range(startDate, endDate) {
  date(startDate); date(endDate);
  if (startDate > endDate || (Date.parse(endDate) - Date.parse(startDate)) / 86400000 > 3660) fail('sc_analytics_invalid_range');
  return { startDate, endDate };
}
function cutoff(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(+now)) fail('sc_analytics_invalid_date');
  return `${now.getUTCFullYear() - 2}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
function monthRange(month) {
  if (typeof month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) fail('sc_analytics_invalid_month');
  const [year, number] = month.split('-').map(Number);
  return { startDate: month + '-01', endDate: new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10) };
}
function monthlyRange(startDate, endDate, now) {
  range(startDate, endDate);
  const boundary = cutoff(now);
  if (startDate < boundary && !startDate.endsWith('-01')
    || endDate < boundary && monthRange(endDate.slice(0, 7)).endDate !== endDate) fail('sc_analytics_monthly_partial_range');
  return boundary;
}
function integer(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) fail('sc_analytics_invalid_metric');
  if (!/^(0|[1-9]\d{0,18})$/.test(String(value))) fail('sc_analytics_invalid_metric');
  const result = BigInt(value);
  if (result > 18446744073709551615n) fail('sc_analytics_invalid_metric');
  return result;
}
function decimal(value) {
  // Google returns floating point positions. Round once to nine decimals before
  // integer arithmetic; never repeatedly average already aggregated positions.
  const string = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value.toFixed(9) : String(value);
  if (!/^(0|[1-9]\d{0,28})(\.\d{1,18})?$/.test(string)) fail('sc_analytics_invalid_metric');
  const [whole, part = ''] = string.split('.');
  return BigInt(whole) * SCALE + BigInt(part.slice(0, 9).padEnd(9, '0')) + (Number(part[9] || 0) >= 5 ? 1n : 0n);
}
function formatted(value) {
  if (typeof value !== 'bigint' || value < 0n) fail('sc_analytics_invalid_metric');
  return `${value / SCALE}.${String(value % SCALE).padStart(9, '0')}`;
}
function text(value, { page = false } = {}) {
  if (value == null && page) return '';
  if (typeof value !== 'string' || !value && !page || Buffer.byteLength(value) > 8192 || /[\x00-\x1f]/.test(value)) fail('sc_analytics_invalid_dimension');
  return value;
}
function normalize(row, bounds, totals = false) {
  const when = date(row?.date ?? row?.keys?.[0]);
  if (when < bounds.startDate || when > bounds.endDate) fail('sc_analytics_row_outside_range');
  const clicks = integer(row.clicks ?? 0), impressions = integer(row.impressions ?? 0);
  const position = row.position == null ? null : decimal(row.position);
  const weighted = (position ?? 0n) * impressions;
  if ((weighted / SCALE).toString().length > 29) fail('sc_analytics_metric_overflow');
  const result = { date: when, clicks: clicks.toString(), impressions: impressions.toString(),
    position_weighted: formatted(weighted), position_sum: formatted(position ?? 0n), position_count: position == null ? '0' : '1' };
  if (!totals) {
    result.query = text(row.query ?? row.keys?.[1]);
    result.page_url = text(row.page_url ?? row.keys?.[2], { page: true });
    result.query_hash = hash(result.query); result.page_hash = hash(result.page_url);
  }
  result.row_digest = hash(JSON.stringify([result.date, result.query_hash ?? '', result.page_hash ?? '',
    result.clicks, result.impressions, result.position_weighted, result.position_sum, result.position_count]));
  return result;
}
function publicMetric(row) {
  const impressions = Number(row.impressions);
  return { ...row, clicks: Number(row.clicks), impressions,
    ctr: impressions ? Number(row.clicks) / impressions : 0,
    position: impressions ? Number(row.position_weighted) / impressions
      : Number(row.position_count) ? Number(row.position_sum) / Number(row.position_count) : null };
}
module.exports = { SCALE, fail, hash, date, range, cutoff, monthRange, monthlyRange, integer, decimal, formatted,
  normalize, publicMetric, property: value => { const result = site(value); return { siteUrl: result.siteUrl, siteHash: result.siteHash }; } };

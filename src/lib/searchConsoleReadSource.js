'use strict';

// The caller has already resolved the user's clinic/group scope and effective
// property assignments. A property list never grants access to its owner clinic.
async function authorizedSiteUrls(scope, marketingState, loadGlobalMappings) {
  const mappings = scope?.isAll
    ? await loadGlobalMappings()
    : marketingState?.google?.available_assets?.search_console || [];
  return [...new Set(mappings.map(row => String(row.site_url || row.siteUrl || '').trim()).filter(Boolean))];
}

const EMPTY_SOURCE = '(SELECT NULL AS property_id, NULL AS site_url, NULL AS date, NULL AS query, '
  + 'NULL AS page_url, 0 AS clicks, 0 AS impressions, NULL AS position, 0 AS ctr, '
  + '0 AS position_weighted, 0 AS position_sum, 0 AS position_count, '
  + '0 AS queries_top3, 0 AS queries_top10 WHERE FALSE) AS sc_source';

function positionAggregateSql() {
  return 'CASE WHEN SUM(impressions)>0 THEN SUM(position_weighted)/SUM(impressions) '
    + 'WHEN SUM(position_count)>0 THEN SUM(position_sum)/SUM(position_count) ELSE NULL END';
}

function storageError(error) {
  const status = ({ sc_analytics_incomplete_coverage: 409, sc_analytics_monthly_partial_range: 422,
    sc_analytics_configuration_changed: 409 })[error?.code];
  return status ? { status, code: error.code } : null;
}

function canonicalSiteUrls(values) {
  const { property } = require('./searchConsoleAnalyticsContract');
  return [...new Set(values.map(value => property(value).siteHash))].sort();
}

async function readWithCurrentScope({ allowed, capture, generate, validate,
  readEnabled = () => process.env.SC_ANALYTICS_READ_ENABLED === 'true' }) {
  const capturedGate = readEnabled();
  const forbidden = () => { throw Object.assign(Error('search_console_scope_forbidden'), { code: 'search_console_scope_forbidden', status: 403 }); };
  if (!await allowed()) forbidden();
  const before = canonicalSiteUrls(await capture());
  const result = await generate();
  await validate?.();
  if (readEnabled() !== capturedGate) throw Object.assign(Error('sc_analytics_configuration_changed'), { code: 'sc_analytics_configuration_changed' });
  if (!await allowed()) forbidden();
  const after = canonicalSiteUrls(await capture());
  if (JSON.stringify(before) !== JSON.stringify(after)) forbidden();
  if (readEnabled() !== capturedGate) throw Object.assign(Error('sc_analytics_configuration_changed'), { code: 'sc_analytics_configuration_changed' });
  return result;
}

async function propertySource({ storage, siteUrls, range, replacements, prefix, totals = false, ranking = false }) {
  if (!siteUrls.length) return { sqlFrom: EMPTY_SOURCE, scopeSql: '', resolution: 'empty_authorized_scope' };
  return storage.rawSource({ siteUrls, startDate: range.startLabel ?? range.start,
    endDate: range.endLabel ?? range.end, replacements, prefix: prefix + 'Src', totals, ranking });
}

function comparablePeriods(range, availability) {
  const current = { start: range.startLabel ?? range.start, end: range.endLabel ?? range.end };
  const previous = { start: range.previous?.startLabel ?? range.previous?.start,
    end: range.previous?.endLabel ?? range.previous?.end };
  const properties = availability.properties || [];
  const coverage = { source: 'property', requested: { current, previous }, properties,
    effective: { current: null, previous: null }, pendingDays: 0, pendingLeadingDays: 0, comparable: false,
    summary: { status: 'pending' }, detail: { status: 'pending' }, comparison: { status: 'pending' } };
  if (!properties.length) { coverage.summary.status = 'unmapped'; return coverage; }
  if (properties.some(p => !p.totalsThrough || !p.totalsFrom)) return coverage;
  const end = [current.end, ...properties.map(p => p.totalsThrough)].sort()[0];
  const start = [current.start, ...properties.map(p => p.totalsFrom)].sort().at(-1);
  if (end < start) return coverage;
  const lag = Math.round((Date.parse(current.end) - Date.parse(end)) / 86400000);
  const leading = Math.round((Date.parse(start) - Date.parse(current.start)) / 86400000);
  coverage.pendingDays = lag;
  coverage.pendingLeadingDays = leading;
  coverage.effective.current = { start, end };
  if (previous.start && previous.end) {
    const previousEnd = new Date(Date.parse(previous.end) - lag * 86400000).toISOString().slice(0, 10);
    const previousStart = new Date(Date.parse(previous.start) + leading * 86400000).toISOString().slice(0, 10);
    if (previousEnd >= previousStart && previousStart >= '2000-01-01') coverage.effective.previous = { start: previousStart, end: previousEnd };
  }
  return coverage;
}

module.exports = { authorizedSiteUrls, propertySource, positionAggregateSql, storageError, canonicalSiteUrls, readWithCurrentScope, comparablePeriods };

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

module.exports = { authorizedSiteUrls, propertySource, positionAggregateSql, storageError, canonicalSiteUrls, readWithCurrentScope };

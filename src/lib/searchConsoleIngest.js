'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');

const QUERY_METRICS = { clicks: 0, impressions: 0, ctr: 6, position: 3 };

function metric(value, scale, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  const number = Number(value || 0);
  if (!Number.isFinite(number)) throw Error('search_console_metric_invalid');
  return Number(number.toFixed(scale));
}

function metricsEqual(current, incoming, fields = QUERY_METRICS) {
  return Object.entries(fields).every(([field, scale]) =>
    metric(current[field], scale, field === 'position') === metric(incoming[field], scale, field === 'position'));
}

function normalizeMetrics(row, fields) {
  return { ...row, ...Object.fromEntries(Object.entries(fields)
    .map(([field, scale]) => [field, metric(row[field], scale, field === 'position')])) };
}

// Every lookup is bounded by the incoming unique keys, never the historical
// clinic/date range. Decimal comparisons use the precision actually stored by
// MySQL, so rounding cannot turn every retry into another UPDATE.
async function persistChangedRows({ model, rows, transaction, keyFields, fields = QUERY_METRICS, chunkSize = 400 }) {
  const size = Math.max(1, Math.min(Number(chunkSize) || 400, 500));
  const stats = { received: rows.length, inserted: 0, updated: 0, unchanged: 0, written: 0 };
  const key = row => JSON.stringify(keyFields.map(field => String(row[field] ?? '')));
  for (let offset = 0; offset < rows.length; offset += size) {
    const incoming = rows.slice(offset, offset + size).map(row => normalizeMetrics(row, fields));
    const existing = await model.findAll({
      attributes: [...keyFields, ...Object.keys(fields)],
      where: { [Op.or]: incoming.map(row => Object.fromEntries(keyFields.map(field => [field, row[field]]))) },
      raw: true, transaction, logging: false,
    });
    const indexed = new Map(existing.map(row => [key(row), row]));
    const changed = [];
    for (const row of incoming) {
      const previous = indexed.get(key(row));
      if (previous && metricsEqual(previous, row, fields)) { stats.unchanged++; continue; }
      if (previous) stats.updated++; else stats.inserted++;
      changed.push(row);
    }
    if (changed.length) {
      await model.bulkCreate(changed, { transaction, updateOnDuplicate: [...Object.keys(fields), 'updated_at'], logging: false });
      stats.written += changed.length;
    }
  }
  return stats;
}

function* monthRanges(start, end) {
  let current = new Date(String(start).slice(0, 10) + 'T00:00:00.000Z');
  const last = new Date(String(end).slice(0, 10) + 'T00:00:00.000Z');
  if (!Number.isFinite(current.getTime()) || !Number.isFinite(last.getTime()) || current > last) throw Error('search_console_range_invalid');
  while (current <= last) {
    const monthEnd = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0));
    yield { s: current.toISOString().slice(0, 10), e: new Date(Math.min(monthEnd, last)).toISOString().slice(0, 10) };
    current = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
  }
}

function mergeQueryRows({ rows, clinicId, siteUrl, queryDailyMap, topByDate, range }) {
  for (const row of rows) {
    const [date, query, page = null] = row.keys || [];
    if (!date || !query) continue;
    if (date < range.s || date > range.e) throw Error('search_console_response_range_invalid');
    const clicks = Number(row.clicks || 0), impressions = Number(row.impressions || 0), position = Number(row.position || 0);
    if (![clicks, impressions, position].every(Number.isFinite)) throw Error('search_console_metric_invalid');
    let top = topByDate.get(date);
    if (!top) { top = { set10: new Set(), set3: new Set() }; topByDate.set(date, top); }
    if (position <= 10) top.set10.add(query);
    if (position <= 3) top.set3.add(query);
    const queryHash = crypto.createHash('sha256').update(query).digest('hex');
    const pageHash = crypto.createHash('sha256').update(page || '').digest('hex');
    // Legacy unique key lacks site_url. Preserve its existing multi-property
    // aggregation until the explicitly enabled property store replaces it.
    const key = JSON.stringify([clinicId, date, queryHash, pageHash]);
    let entry = queryDailyMap.get(key);
    if (!entry) {
      entry = { clinica_id: clinicId, site_url: siteUrl, date, query, query_hash: queryHash,
        page_url: page, page_url_hash: pageHash, clicks: 0, impressions: 0, positionWeighted: 0, lastPosition: position };
      queryDailyMap.set(key, entry);
    }
    entry.clicks += clicks; entry.impressions += impressions;
    entry.positionWeighted += position * (impressions || 1); entry.lastPosition = position;
  }
}

function queryPayload(map) {
  return Array.from(map.values(), row => ({
    clinica_id: row.clinica_id, site_url: row.site_url, date: row.date, query: row.query, query_hash: row.query_hash,
    page_url: row.page_url, page_url_hash: row.page_url_hash, clicks: row.clicks, impressions: row.impressions,
    ctr: row.impressions ? row.clicks / row.impressions : 0,
    position: row.impressions ? row.positionWeighted / row.impressions : row.lastPosition || null,
  }));
}

// A single bounded response per family. No errors, tokens or row values enter
// cache keys or operational reports; credential references stay in this job.
// Broker tenants remain independent even when the property is shared.
function createDownloadReader({ read, validate, onDownload = () => {}, onReuse = () => {} }) {
  const cached = new Map();
  return async (asset, credentials, family, payload) => {
    await validate(asset, credentials);
    const authority = credentials.brokerContext ? ['broker', asset.clinicaId, asset.googleConnectionId,
      asset.broker_read_connection_ref, asset.broker_read_asset_ref] : ['legacy', asset.googleConnectionId];
    const key = JSON.stringify([asset.siteUrl, authority, payload]);
    const previous = cached.get(family);
    if (previous?.key === key) {
      await validate(previous.asset, previous.credentials);
      await validate(asset, credentials);
      onReuse(); return previous.result;
    }
    cached.delete(family);
    const result = await read(asset, credentials, family, payload);
    await validate(asset, credentials);
    onDownload();
    // Inspection is not shared. Query responses remain bounded by the existing
    // broker/legacy row limit; months from prior requests are released.
    if (family !== 'inspection' && Array.isArray(result?.data?.rows) && result.data.rows.length <= 25000) {
      cached.set(family, { key, result, asset, credentials });
    }
    return result;
  };
}

function backfillDays(config, env) {
  const full = Number(config.backfillDays);
  const revisit = Number(env.WEB_BACKFILL_REVISIT_DAYS);
  if (env.WEB_BACKFILL_INITIAL_COVERAGE_VERIFIED !== 'true' || !Number.isInteger(revisit) || revisit < 1) return full;
  return Math.min(full, revisit);
}

module.exports = { QUERY_METRICS, metricsEqual, persistChangedRows, monthRanges, mergeQueryRows, queryPayload,
  createDownloadReader, backfillDays };

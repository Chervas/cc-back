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

// Publication boundaries are disjoint PT date labels, at most three days,
// and never cross a calendar month. Each range retains all-property atomicity.
const QUERY_PUBLICATION_DAYS = 3;
function* queryRanges(start, end) {
  for (const month of monthRanges(start, end)) {
    const last = Date.parse(month.e + 'T00:00:00.000Z');
    for (let current = Date.parse(month.s + 'T00:00:00.000Z'); current <= last; current += QUERY_PUBLICATION_DAYS * 86400000) {
      yield { s: new Date(current).toISOString().slice(0, 10),
        e: new Date(Math.min(current + (QUERY_PUBLICATION_DAYS - 1) * 86400000, last)).toISOString().slice(0, 10) };
    }
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

// Date labels remain Search Console PT calendar dates; UTC arithmetic only
// divides those labels and never converts them to the server's local timezone.
const QUERY_INTERVAL_LIMITS = Object.freeze({ rowLimit: 25000, maxDays: 31, maxDownloads: 32, maxCachedIntervals: 2,
  maxBytes: 40000000, timeoutMs: 450000 });
const intervalError = (code, range) => Object.assign(Error(code), { code, ...(range ? { range: { ...range } } : {}) });
function downloadKey(asset, credentials, payload) {
  const authority = credentials.brokerContext ? ['broker', asset.clinicaId, asset.googleConnectionId,
    asset.broker_read_connection_ref, asset.broker_read_asset_ref] : ['legacy', asset.googleConnectionId];
  return JSON.stringify([asset.siteUrl, authority, payload]);
}

// Small properties retain one range request. Once that authority/property
// saturates, daily PT labels are used for this and later ranges in this job.
// No partial range can be returned/published. A saturated day remains terminal.
function createQueryIntervalReader({ read, validate, onSplit = () => {}, onReuse = () => {},
  onIncompleteReuse = () => {}, now = () => Date.now() }) {
  const cached = new Map(), dense = new Set(), incomplete = new Map(); let cachedBytes = 0;
  const dropOldest = () => { const key = cached.keys().next().value; cachedBytes -= cached.get(key).bytes; cached.delete(key); };
  return async (asset, credentials, range) => {
    const parse = value => {
      if (typeof value !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(value)) throw intervalError('search_console_range_invalid');
      const ms = Date.parse(value + 'T00:00:00.000Z');
      if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw intervalError('search_console_range_invalid');
      return ms;
    };
    const start = parse(range.s), end = parse(range.e);
    if (end < start || end - start >= QUERY_INTERVAL_LIMITS.maxDays * 86400000) throw intervalError('search_console_range_invalid');
    const deadline = now() + QUERY_INTERVAL_LIMITS.timeoutMs;
    const beforeExecute = () => {
      const remaining = deadline - now();
      if (remaining < 1) throw intervalError('search_console_interval_budget_exceeded');
      return { timeoutMs: Math.min(30000, remaining) };
    };
    beforeExecute(); await validate(asset, credentials); beforeExecute();
    const key = downloadKey(asset, credentials, range), authority = downloadKey(asset, credentials, {});
    const previous = cached.get(key) || incomplete.get(key);
    if (previous) {
      await validate(previous.asset, previous.credentials); await validate(asset, credentials); beforeExecute();
      if (incomplete.has(key)) {
        onIncompleteReuse(); throw intervalError('search_console_interval_truncated', previous.range);
      }
      cached.delete(key); cached.set(key, previous); onReuse(); return previous.intervals;
    }
    const intervals = []; let downloads = 0, bytes = 0, retainedBytes = 0;
    const request = async (s, e) => {
      beforeExecute();
      if (++downloads > QUERY_INTERVAL_LIMITS.maxDownloads) throw intervalError('search_console_interval_budget_exceeded');
      const response = await read(asset, credentials, 'queries', { startDate: s, endDate: e }, { beforeExecute });
      beforeExecute();
      const rows = response?.data?.rows;
      if (!Array.isArray(rows) || rows.length > QUERY_INTERVAL_LIMITS.rowLimit) throw intervalError('search_console_response_invalid');
      const responseBytes = Buffer.byteLength(JSON.stringify(rows)); bytes += responseBytes;
      if (bytes > QUERY_INTERVAL_LIMITS.maxBytes) throw intervalError('search_console_interval_budget_exceeded');
      for (const row of rows) {
        const date = row?.keys?.[0];
        if (typeof date !== 'string' || date < s || date > e) throw intervalError('search_console_response_range_invalid');
      }
      // The cache and in-progress response share one 40MB logical-row budget.
      // Discarded saturated parents never enter the cache or published rows.
      while (cached.size && cachedBytes + retainedBytes + responseBytes > QUERY_INTERVAL_LIMITS.maxBytes) dropOldest();
      if (response.data.rowLimitReached === true || rows.length === QUERY_INTERVAL_LIMITS.rowLimit) {
        dense.add(authority);
        if (s === e) throw intervalError('search_console_interval_truncated', { s, e });
        return false;
      }
      retainedBytes += responseBytes; intervals.push({ s, e, rows }); return true;
    };
    try {
      if (!dense.has(authority) && await request(range.s, range.e)) {
        // A small property's existing single-read path remains unchanged.
      } else {
        onSplit();
        for (let date = start; date <= end; date += 86400000) {
          const label = new Date(date).toISOString().slice(0, 10);
          await request(label, label);
        }
      }
      await validate(asset, credentials); beforeExecute();
      while (cached.size >= QUERY_INTERVAL_LIMITS.maxCachedIntervals) dropOldest();
      cached.set(key, { intervals, bytes: retainedBytes, asset, credentials }); cachedBytes += retainedBytes;
      return intervals;
    } catch (error) {
      // Only a proven capped day is memoized, never a timeout/provider error or
      // partial rows. Other mappings revalidate both authorities and still fail.
      if (error?.code === 'search_console_interval_truncated') {
        if (incomplete.size >= QUERY_INTERVAL_LIMITS.maxCachedIntervals) incomplete.delete(incomplete.keys().next().value);
        incomplete.set(key, { range: error.range, asset, credentials });
      }
      throw error;
    }
  };
}

// A single bounded response per family. No errors, tokens or row values enter
// cache keys or operational reports; credential references stay in this job.
// Broker tenants remain independent even when the property is shared.
function createDownloadReader({ read, validate, onDownload = () => {}, onReuse = () => {} }) {
  const cached = new Map();
  return async (asset, credentials, family, payload, options = {}) => {
    await validate(asset, credentials);
    const key = downloadKey(asset, credentials, payload);
    const previous = cached.get(family);
    if (previous?.key === key) {
      await validate(previous.asset, previous.credentials);
      await validate(asset, credentials);
      onReuse(); return previous.result;
    }
    cached.delete(family);
    const result = await read(asset, credentials, family, payload, options);
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

module.exports = { QUERY_METRICS, metricsEqual, persistChangedRows, monthRanges, queryRanges, QUERY_PUBLICATION_DAYS, mergeQueryRows, queryPayload,
  createDownloadReader, createQueryIntervalReader, QUERY_INTERVAL_LIMITS, backfillDays };

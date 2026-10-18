'use strict';

// No model index, configuration or provider is loaded until an explicitly gated
// runtime call. The factory can only use the SQL connection supplied by its caller.
const { randomUUID, createHash } = require('node:crypto');
const C = require('../lib/searchConsoleAnalyticsContract');
const metrics = ['clicks', 'impressions', 'position_weighted', 'position_sum', 'position_count'];
const chunks = function* (rows, size = 250) { for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size); };
const flag = (env, key) => env?.[key] === 'true';
const isWriteEnabled = (env = process.env) => flag(env, 'SC_ANALYTICS_WRITE_ENABLED');
const isReadEnabled = (env = process.env) => flag(env, 'SC_ANALYTICS_READ_ENABLED');
const digestHex = value => Buffer.isBuffer(value) ? value.toString('hex') : String(value).toLowerCase();

function createSearchConsoleAnalytics({ sequelize, env = {}, now = () => new Date() } = {}) {
  if (!sequelize?.query || !sequelize?.transaction) C.fail('sc_analytics_sql_required');
  const query = async (sql, replacements = {}, transaction) => {
    const [rows] = await sequelize.query(sql, { replacements, transaction, logging: false }); return rows;
  };
  const tx = work => sequelize.transaction(work);
  const writable = () => { if (!isWriteEnabled(env)) C.fail('sc_analytics_write_disabled'); };
  const validated = async validate => { if (typeof validate !== 'function') C.fail('sc_analytics_authority_validator_required'); if (await validate() === false) C.fail('sc_analytics_authority_changed'); };
  async function property(siteUrl, transaction, create = false) {
    const parsed = C.property(siteUrl);
    if (create) await query('INSERT IGNORE INTO ScAnalyticsProperties(site_hash,site_url) VALUES(UNHEX(:hash),:url)', { hash: parsed.siteHash, url: parsed.siteUrl }, transaction);
    const rows = await query(`SELECT id,site_url,revision FROM ScAnalyticsProperties WHERE site_hash=UNHEX(:hash)${transaction ? ' FOR UPDATE' : ''}`, { hash: parsed.siteHash }, transaction);
    const row = rows[0];
    if (row && row.site_url !== parsed.siteUrl) C.fail('sc_analytics_hash_collision');
    return row ? { ...row, siteUrl: parsed.siteUrl, siteHash: parsed.siteHash } : null;
  }
  async function dictionaries(table, rows, valueKey, hashKey, transaction) {
    const values = new Map();
    for (const row of rows) {
      if (values.has(row[hashKey]) && values.get(row[hashKey]) !== row[valueKey]) C.fail('sc_analytics_hash_collision');
      values.set(row[hashKey], row[valueKey]);
    }
    const ids = new Map();
    for (const part of chunks([...values])) {
      const replacements = {};
      const tuples = part.map(([hash, value], i) => { replacements['h' + i] = hash; replacements['v' + i] = value; return `(UNHEX(:h${i}),:v${i})`; });
      await query(`INSERT IGNORE INTO ${table}(value_hash,value_text) VALUES ${tuples.join(',')}`, replacements, transaction);
      const found = await query(`SELECT id,HEX(value_hash) AS hash,value_text FROM ${table} WHERE value_hash IN (${part.map((_, i) => `UNHEX(:h${i})`).join(',')})`, replacements, transaction);
      for (const row of found) {
        const hash = row.hash.toLowerCase();
        if (row.value_text !== values.get(hash)) C.fail('sc_analytics_hash_collision');
        ids.set(hash, String(row.id));
      }
      if (found.length !== part.length) C.fail('sc_analytics_dictionary_incomplete');
    }
    return ids;
  }
  async function batch(handle, transaction) {
    if (!handle || !/^[a-f0-9-]{36}$/i.test(handle.batchId || '')) C.fail('sc_analytics_invalid_batch');
    const rows = await query('SELECT * FROM ScAnalyticsIngestBatches WHERE batch_id=:id FOR UPDATE', { id: handle.batchId }, transaction);
    if (!rows[0]) C.fail('sc_analytics_unknown_batch');
    return rows[0];
  }
  async function beginInterval({ siteUrl, mapping, startDate, endDate, kind = 'detail', validate } = {}) {
    writable(); C.range(startDate, endDate); await validated(validate);
    if (Date.parse(endDate) - Date.parse(startDate) > 549 * 86400000) C.fail('sc_analytics_ingest_interval_too_large');
    if (!['detail', 'totals'].includes(kind)) C.fail('sc_analytics_invalid_kind');
    return tx(async transaction => {
      const p = await property(siteUrl ?? mapping?.siteUrl ?? mapping?.site_url, transaction, true);
      const archived = await query('SELECT month FROM ScAnalyticsArchiveBatches WHERE property_id=:id AND month<=:end AND LAST_DAY(month)>=:start LIMIT 1', { id: p.id, start: startDate, end: endDate }, transaction);
      if (kind === 'detail' && archived.length) C.fail('sc_analytics_month_already_archived');
      const id = randomUUID();
      await query('INSERT INTO ScAnalyticsIngestBatches(batch_id,property_id,start_date,end_date,base_revision,kind,state,created_at) VALUES(:id,:property,:start,:end,:revision,:kind,\'staging\',:now)',
        { id, property: p.id, start: startDate, end: endDate, revision: p.revision, kind, now: now() }, transaction);
      return { batchId: id, propertyId: String(p.id), siteUrl: p.siteUrl, startDate, endDate, kind };
    });
  }
  async function stageRows(handle, input, { totals = false } = {}) {
    writable(); if (!Array.isArray(input) || input.length > 25000) C.fail('sc_analytics_invalid_rows');
    return tx(async transaction => {
      const b = await batch(handle, transaction);
      if (b.state !== 'staging') C.fail('sc_analytics_batch_not_staging');
      if (b.kind === 'totals' && !totals) C.fail('sc_analytics_invalid_kind');
      if (totals) await query('UPDATE ScAnalyticsIngestBatches SET totals_included=1 WHERE batch_id=:id', { id: b.batch_id }, transaction);
      const rows = input.map(row => C.normalize(row, { startDate: b.start_date, endDate: b.end_date }, totals));
      const queries = totals ? null : await dictionaries('ScAnalyticsQueries', rows, 'query', 'query_hash', transaction);
      const pages = totals ? null : await dictionaries('ScAnalyticsPages', rows, 'page_url', 'page_hash', transaction);
      const table = totals ? 'ScAnalyticsStagedTotals' : 'ScAnalyticsStagedRows';
      const keyCols = totals ? ['batch_id', 'date'] : ['batch_id', 'date', 'query_id', 'page_id'];
      const columns = [...keyCols, ...metrics, 'row_digest'];
      for (const part of chunks(rows)) {
        const replacements = { batch: b.batch_id };
        const values = part.map((row, i) => {
          const values = { ...row, batch_id: b.batch_id, query_id: queries?.get(row.query_hash), page_id: pages?.get(row.page_hash) };
          return '(' + columns.map(col => { replacements[col + i] = values[col]; return col === 'row_digest' ? `UNHEX(:${col}${i})` : `:${col}${i}`; }).join(',') + ')';
        });
        if (!part.length) continue;
        // Repeated identical pages/retries are harmless; conflicting duplicates
        // are rejected, including historical clinic clones that disagree.
        await query(`INSERT IGNORE INTO ${table}(${columns.join(',')}) VALUES ${values.join(',')}`, replacements, transaction);
        const expected = new Map(part.map(row => [JSON.stringify(totals ? [row.date] : [row.date, queries.get(row.query_hash), pages.get(row.page_hash)]), row.row_digest]));
        const predicates = part.map((row, i) => `(${keyCols.map(col => `${col}=:${col}${i}`).join(' AND ')})`);
        const found = await query(`SELECT ${keyCols.join(',')},HEX(row_digest) AS digest FROM ${table} WHERE ${predicates.join(' OR ')}`, replacements, transaction);
        for (const row of found) {
          const key = JSON.stringify(totals ? [row.date] : [row.date, String(row.query_id), String(row.page_id)]);
          if (row.digest.toLowerCase() !== expected.get(key)) C.fail('sc_analytics_conflicting_duplicate');
        }
        // Also catch a conflicting duplicate within this same input page.
        const seen = new Map();
        for (const row of part) { const key = JSON.stringify(totals ? [row.date] : [row.date, row.query_hash, row.page_hash]); if (seen.has(key) && seen.get(key) !== row.row_digest) C.fail('sc_analytics_conflicting_duplicate'); seen.set(key, row.row_digest); }
      }
      return { staged: rows.length };
    });
  }
  async function commitInterval(handle, { complete, rowLimitReached, validate } = {}) {
    writable(); if (complete !== true || rowLimitReached !== false) C.fail('sc_analytics_incomplete_interval');
    return tx(async transaction => {
      const b = await batch(handle, transaction);
      if (b.state === 'committed') { await validated(validate); return { batchId: b.batch_id, committed: true, replay: true }; }
      if (b.state !== 'staging') C.fail('sc_analytics_batch_not_staging');
      const p = (await query('SELECT id,revision FROM ScAnalyticsProperties WHERE id=:id FOR UPDATE', { id: b.property_id }, transaction))[0];
      await validated(validate);
      if (String(p.revision) !== String(b.base_revision)) C.fail('sc_analytics_superseded_interval');
      const params = { id: p.id, batch: b.batch_id, start: b.start_date, end: b.end_date, now: now() };
      if (b.kind === 'detail' && (await query('SELECT month FROM ScAnalyticsArchiveBatches WHERE property_id=:id AND month<=:end AND LAST_DAY(month)>=:start LIMIT 1', params, transaction)).length) C.fail('sc_analytics_month_already_archived');
      let changed = 0;
      const publish = async (target, staged, detail) => {
        const keys = detail ? ['date', 'query_id', 'page_id'] : ['date'];
        const joins = keys.map(key => `d.${key}=s.${key}`).join(' AND ');
        const [{ count }] = await query(`SELECT COUNT(*) AS count FROM ${staged} s LEFT JOIN ${target} d ON d.property_id=:id AND ${joins} WHERE s.batch_id=:batch AND (d.property_id IS NULL OR d.row_digest<>s.row_digest)`, params, transaction);
        const [{ count: removed }] = await query(`SELECT COUNT(*) AS count FROM ${target} d WHERE d.property_id=:id AND d.date BETWEEN :start AND :end AND NOT EXISTS(SELECT 1 FROM ${staged} s WHERE s.batch_id=:batch AND ${joins})`, params, transaction);
        changed += Number(count) + Number(removed);
        await query(`DELETE d FROM ${target} d WHERE d.property_id=:id AND d.date BETWEEN :start AND :end AND NOT EXISTS(SELECT 1 FROM ${staged} s WHERE s.batch_id=:batch AND ${joins})`, params, transaction);
        const cols = ['property_id', ...keys, ...metrics, 'row_digest', 'updated_at'];
        await query(`INSERT INTO ${target}(${cols.join(',')}) SELECT :id,${keys.map(k => 's.' + k).join(',')},${metrics.map(k => 's.' + k).join(',')},s.row_digest,:now FROM ${staged} s LEFT JOIN ${target} d ON d.property_id=:id AND ${joins} WHERE s.batch_id=:batch AND (d.property_id IS NULL OR d.row_digest<>s.row_digest) ON DUPLICATE KEY UPDATE ${[...metrics, 'row_digest', 'updated_at'].map(k => `${k}=VALUES(${k})`).join(',')}`, params, transaction);
      };
      if (b.kind === 'detail') {
        await publish('ScAnalyticsDaily', 'ScAnalyticsStagedRows', true);
        // Ranking is distinct query, independent of page duplication. Google
        // detail is incomplete; these counts retain the existing UI semantics.
        await query('DELETE FROM ScAnalyticsRankingDaily WHERE property_id=:id AND date BETWEEN :start AND :end AND date NOT IN(SELECT date FROM ScAnalyticsStagedRows WHERE batch_id=:batch)', params, transaction);
        await query(`INSERT INTO ScAnalyticsRankingDaily(property_id,date,queries_top3,queries_top10,updated_at)
          SELECT :id,date,COUNT(DISTINCT CASE WHEN position_count>0 AND (CASE WHEN impressions>0 THEN position_weighted/impressions ELSE position_sum/position_count END)<=3 THEN query_id END),
          COUNT(DISTINCT CASE WHEN position_count>0 AND (CASE WHEN impressions>0 THEN position_weighted/impressions ELSE position_sum/position_count END)<=10 THEN query_id END),:now
          FROM ScAnalyticsStagedRows WHERE batch_id=:batch GROUP BY date
          ON DUPLICATE KEY UPDATE updated_at=IF(queries_top3<>VALUES(queries_top3) OR queries_top10<>VALUES(queries_top10),VALUES(updated_at),updated_at),queries_top3=VALUES(queries_top3),queries_top10=VALUES(queries_top10)`, params, transaction);
      }
      const totalsIncluded = b.kind === 'totals' || Number(b.totals_included) === 1;
      if (totalsIncluded) await publish('ScAnalyticsPropertyDaily', 'ScAnalyticsStagedTotals', false);
      const dates = [];
      for (let time = Date.parse(b.start_date); time <= Date.parse(b.end_date); time += 86400000) dates.push(new Date(time).toISOString().slice(0, 10));
      const detail = b.kind === 'detail' ? 1 : 0, totals = totalsIncluded ? 1 : 0;
      const [{ covered }] = await query(`SELECT COUNT(*) AS covered FROM ScAnalyticsCoverageDaily WHERE property_id=:id AND date BETWEEN :start AND :end AND ${detail ? 'detail_complete=1' : '1=1'} AND ${totals ? 'totals_complete=1' : '1=1'}`, params, transaction);
      if (Number(covered) !== dates.length) changed++;
      const coverage = { ...params, detail, totals };
      const coverageRows = dates.map((day, i) => { coverage['d' + i] = day; return `(:id,:d${i},:detail,:totals)`; });
      await query(`INSERT INTO ScAnalyticsCoverageDaily(property_id,date,detail_complete,totals_complete) VALUES ${coverageRows.join(',')} ON DUPLICATE KEY UPDATE detail_complete=GREATEST(detail_complete,VALUES(detail_complete)),totals_complete=GREATEST(totals_complete,VALUES(totals_complete))`, coverage, transaction);
      if (changed) await query('UPDATE ScAnalyticsProperties SET revision=revision+1 WHERE id=:id', params, transaction);
      await query("UPDATE ScAnalyticsIngestBatches SET state='committed',committed_at=:now,row_count=(SELECT COUNT(*) FROM ScAnalyticsStagedRows WHERE batch_id=:batch) WHERE batch_id=:batch", params, transaction);
      await query('DELETE FROM ScAnalyticsStagedRows WHERE batch_id=:batch', params, transaction);
      await query('DELETE FROM ScAnalyticsStagedTotals WHERE batch_id=:batch', params, transaction);
      return { batchId: b.batch_id, committed: true, changed };
    });
  }
  async function abortInterval(handle) {
    writable(); return tx(async transaction => {
      const b = await batch(handle, transaction); if (b.state === 'committed') C.fail('sc_analytics_batch_already_committed');
      await query("UPDATE ScAnalyticsIngestBatches SET state='aborted' WHERE batch_id=:id", { id: b.batch_id }, transaction);
      await query('DELETE FROM ScAnalyticsStagedRows WHERE batch_id=:id', { id: b.batch_id }, transaction);
      await query('DELETE FROM ScAnalyticsStagedTotals WHERE batch_id=:id', { id: b.batch_id }, transaction);
      return { aborted: true };
    });
  }
  async function writeInterval(options = {}) {
    if (!isWriteEnabled(env)) return { skipped: true, reason: 'sc_analytics_write_disabled' };
    if (options.complete !== true || options.rowLimitReached !== false) C.fail('sc_analytics_incomplete_interval');
    const handle = await beginInterval(options);
    try {
      await stageRows(handle, options.rows || [], { totals: options.kind === 'totals' });
      if (options.totalsRows) await stageRows(handle, options.totalsRows, { totals: true });
      return await commitInterval(handle, options);
    } catch (error) { await abortInterval(handle).catch(() => {}); throw error; }
  }
  const writeTotalsInterval = options => writeInterval({ ...options, kind: 'totals' });

  async function rawSource({ siteUrls, startDate, endDate, replacements, prefix = 'sca', totals = false, ranking = false } = {}) {
    if (!isReadEnabled(env)) C.fail('sc_analytics_read_disabled');
    C.range(startDate, endDate);
    if (!Array.isArray(siteUrls) || !siteUrls.length || siteUrls.length > 200 || !replacements || !/^[a-zA-Z][a-zA-Z0-9_]{0,24}$/.test(prefix) || totals && ranking) C.fail('sc_analytics_invalid_scope');
    const sites = [...new Map(siteUrls.map(C.property).map(p => [p.siteHash, p])).values()];
    const params = { [`${prefix}Start`]: startDate, [`${prefix}End`]: endDate };
    const placeholders = sites.map((p, i) => { params[prefix + i] = p.siteHash; return `UNHEX(:${prefix}${i})`; }).join(',');
    const scope = `p.site_hash IN (${placeholders})`;
    const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000 + 1;
    const [{ covered }] = await query(`SELECT COUNT(*) AS covered FROM ScAnalyticsCoverageDaily d JOIN ScAnalyticsProperties p ON p.id=d.property_id WHERE ${scope} AND d.date BETWEEN :${prefix}Start AND :${prefix}End AND d.${totals ? 'totals_complete' : 'detail_complete'}=1`, params);
    if (Number(covered) !== days * sites.length) C.fail('sc_analytics_incomplete_coverage');
    if (!totals && !ranking) {
      // Reject only published monthly periods actually intersecting the request.
      const archived = await query(`SELECT a.month FROM ScAnalyticsArchiveBatches a JOIN ScAnalyticsProperties p ON p.id=a.property_id WHERE ${scope} AND a.month<=:${prefix}End AND LAST_DAY(a.month)>=:${prefix}Start`, params);
      for (const row of archived) {
        const bounds = C.monthRange(row.month.slice(0, 7));
        if (startDate > bounds.startDate || endDate < bounds.endDate) C.fail('sc_analytics_monthly_partial_range');
      }
    }
    for (const key of Object.keys(params)) if (Object.hasOwn(replacements, key)) C.fail('sc_analytics_replacement_collision');
    Object.assign(replacements, params);
    const where = `WHERE ${scope} AND d.date BETWEEN :${prefix}Start AND :${prefix}End`;
    const position = alias => `CASE WHEN ${alias}.impressions>0 THEN ${alias}.position_weighted/${alias}.impressions WHEN ${alias}.position_count>0 THEN ${alias}.position_sum/${alias}.position_count ELSE NULL END`;
    const common = 'd.property_id,p.site_url,d.date,d.clicks,d.impressions';
    let source;
    if (totals) source = `SELECT ${common},${position('d')} AS position,CASE WHEN d.impressions>0 THEN d.clicks/d.impressions ELSE 0 END AS ctr FROM ScAnalyticsPropertyDaily d JOIN ScAnalyticsProperties p ON p.id=d.property_id ${where}`;
    else if (ranking) source = `SELECT d.property_id,p.site_url,d.date,d.queries_top3,d.queries_top10 FROM ScAnalyticsRankingDaily d JOIN ScAnalyticsProperties p ON p.id=d.property_id ${where}`;
    else {
      const dims = 'q.value_text AS query,u.value_text AS page_url';
      const joins = 'JOIN ScAnalyticsProperties p ON p.id=d.property_id JOIN ScAnalyticsQueries q ON q.id=d.query_id JOIN ScAnalyticsPages u ON u.id=d.page_id';
      source = `SELECT ${common},${dims},${position('d')} AS position,d.position_weighted,d.position_sum,d.position_count FROM ScAnalyticsDaily d ${joins} ${where} AND NOT EXISTS(SELECT 1 FROM ScAnalyticsArchiveBatches a WHERE a.property_id=d.property_id AND a.month=DATE_FORMAT(d.date,'%Y-%m-01'))
        UNION ALL SELECT d.property_id,p.site_url,d.month AS date,d.clicks,d.impressions,${dims},${position('d')} AS position,d.position_weighted,d.position_sum,d.position_count FROM ScAnalyticsMonthly d ${joins} WHERE ${scope} AND d.month BETWEEN :${prefix}Start AND :${prefix}End AND EXISTS(SELECT 1 FROM ScAnalyticsArchiveBatches a WHERE a.property_id=d.property_id AND a.month=d.month)`;
    }
    return { sqlFrom: `(${source}) AS sc_source`, scopeSql: '', resolution: totals || ranking ? 'daily' : 'daily_or_complete_month', authoritativeTotals: !!totals };
  }

  // An external, independent archive adapter is deliberately injected. This
  // module never provisions storage or assumes a bucket/backup is available.
  async function* snapshot(p, bounds, transaction) {
    yield JSON.stringify({ version: 1, siteUrl: p.siteUrl, startDate: bounds.startDate, endDate: bounds.endDate, revision: String(p.revision) }) + '\n';
    let last = null;
    for (;;) {
      const params = { id: p.id, start: bounds.startDate, end: bounds.endDate, ...(last || {}) };
      const cursor = last ? 'AND (d.date>:date OR d.date=:date AND d.query_id>:query OR d.date=:date AND d.query_id=:query AND d.page_id>:page)' : '';
      const rows = await query(`SELECT d.date,d.query_id,d.page_id,q.value_text AS query,u.value_text AS page_url,${metrics.map(k => 'd.' + k).join(',')},HEX(d.row_digest) AS row_digest FROM ScAnalyticsDaily d JOIN ScAnalyticsQueries q ON q.id=d.query_id JOIN ScAnalyticsPages u ON u.id=d.page_id WHERE d.property_id=:id AND d.date BETWEEN :start AND :end ${cursor} ORDER BY d.date,d.query_id,d.page_id LIMIT 500`, params, transaction);
      for (const row of rows) yield JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k === 'row_digest' ? v.toLowerCase() : String(v)]))) + '\n';
      if (rows.length < 500) break;
      const tail = rows.at(-1); last = { date: tail.date, query: tail.query_id, page: tail.page_id };
    }
  }
  async function hashStream(stream) {
    const hash = createHash('sha256'); let bytes = 0, lines = 0;
    for await (const input of typeof stream === 'string' || Buffer.isBuffer(stream) ? [stream] : stream) {
      const buffer = Buffer.from(input); bytes += buffer.length; if (bytes > 100 * 1024 ** 3) C.fail('sc_analytics_archive_too_large');
      hash.update(buffer); for (const char of buffer) if (char === 10) lines++;
    }
    return { digest: hash.digest('hex'), bytes, rows: Math.max(0, lines - 1) };
  }
  async function archiveMonth({ siteUrl, month, archiveStore, validate } = {}) {
    writable(); if (!flag(env, 'SC_ANALYTICS_ARCHIVE_ENABLED')) C.fail('sc_analytics_archive_disabled');
    const bounds = C.monthRange(month); if (bounds.endDate >= C.cutoff(now())) C.fail('sc_analytics_retention_window');
    if (archiveStore?.independent !== true || typeof archiveStore.put !== 'function' || typeof archiveStore.read !== 'function') C.fail('sc_analytics_independent_archive_required');
    await validated(validate);
    const p = await property(siteUrl); if (!p) C.fail('sc_analytics_unknown_property');
    const [{ covered }] = await query('SELECT COUNT(*) AS covered FROM ScAnalyticsCoverageDaily WHERE property_id=:id AND date BETWEEN :start AND :end AND detail_complete=1', { id: p.id, start: bounds.startDate, end: bounds.endDate });
    if (Number(covered) !== Number(bounds.endDate.slice(-2))) C.fail('sc_analytics_incomplete_coverage');
    const existing = await query('SELECT * FROM ScAnalyticsArchiveBatches WHERE property_id=:id AND month=:month', { id: p.id, month: bounds.startDate });
    if (existing.length) return { published: true, replay: true, batchId: existing[0].batch_id };
    const batchId = randomUUID(), digest = createHash('sha256'); let rows = -1, bytes = 0;
    const body = (async function* () { for await (const chunk of snapshot(p, bounds)) { digest.update(chunk); bytes += Buffer.byteLength(chunk); rows++; yield chunk; } })();
    const receipt = await archiveStore.put({ key: `search-console/v1/${p.siteHash}/${month}/${batchId}.ndjson`, body, contentType: 'application/x-ndjson' });
    const expected = { digest: digest.digest('hex'), rows, bytes };
    const actual = await hashStream(await archiveStore.read(receipt));
    if (actual.digest !== expected.digest || actual.rows !== expected.rows || actual.bytes !== expected.bytes) C.fail('sc_analytics_archive_verification_failed');
    return tx(async transaction => {
      const current = await property(siteUrl, transaction);
      await validated(validate);
      if (String(current.revision) !== String(p.revision)) C.fail('sc_analytics_archive_source_changed');
      const second = await hashStream(snapshot(p, bounds, transaction));
      if (second.digest !== expected.digest || second.rows !== expected.rows || second.bytes !== expected.bytes) C.fail('sc_analytics_archive_source_changed');
      const params = { id: p.id, start: bounds.startDate, end: bounds.endDate, month: bounds.startDate };
      if ((await query('SELECT month FROM ScAnalyticsArchiveBatches WHERE property_id=:id AND month=:month', params, transaction)).length) return { published: true, replay: true };
      await query('DELETE FROM ScAnalyticsMonthly WHERE property_id=:id AND month=:month', params, transaction);
      await query(`INSERT INTO ScAnalyticsMonthly(property_id,month,query_id,page_id,${metrics.join(',')},source_rows,source_days) SELECT property_id,:month,query_id,page_id,${metrics.map(k => `SUM(${k})`).join(',')},COUNT(*),COUNT(DISTINCT date) FROM ScAnalyticsDaily WHERE property_id=:id AND date BETWEEN :start AND :end GROUP BY property_id,query_id,page_id`, params, transaction);
      const daily = (await query(`SELECT COUNT(*) AS rows_count,${metrics.map(k => `COALESCE(SUM(${k}),0) AS ${k}`).join(',')} FROM ScAnalyticsDaily WHERE property_id=:id AND date BETWEEN :start AND :end`, params, transaction))[0];
      const monthly = (await query(`SELECT COALESCE(SUM(source_rows),0) AS rows_count,${metrics.map(k => `COALESCE(SUM(${k}),0) AS ${k}`).join(',')} FROM ScAnalyticsMonthly WHERE property_id=:id AND month=:month`, params, transaction))[0];
      for (const key of ['rows_count', ...metrics]) if (C.decimal(String(daily[key])) !== C.decimal(String(monthly[key]))) C.fail('sc_analytics_rollup_mismatch');
      const json = JSON.stringify(receipt); if (!json || Buffer.byteLength(json) > 16384) C.fail('sc_analytics_invalid_archive_receipt');
      await query("INSERT INTO ScAnalyticsArchiveBatches(property_id,month,batch_id,source_revision,source_digest,source_rows,state,archive_receipt,verified_at) VALUES(:id,:month,:batch,:revision,UNHEX(:digest),:rows,'published',:receipt,:now)",
        { ...params, batch: batchId, revision: p.revision, digest: expected.digest, rows: expected.rows, receipt: json, now: now() }, transaction);
      await query('UPDATE ScAnalyticsProperties SET revision=revision+1 WHERE id=:id', params, transaction);
      return { batchId, published: true, ...expected };
    });
  }
  async function purgeArchivedMonth({ siteUrl, month, archiveStore, validate, chunkSize = 1000, maxChunks = 1 } = {}) {
    writable(); if (!flag(env, 'SC_ANALYTICS_PURGE_ENABLED')) C.fail('sc_analytics_purge_disabled');
    const bounds = C.monthRange(month); if (bounds.endDate >= C.cutoff(now())) C.fail('sc_analytics_retention_window');
    if (archiveStore?.independent !== true || typeof archiveStore.read !== 'function') C.fail('sc_analytics_independent_archive_required');
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 5000 || !Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > 100) C.fail('sc_analytics_invalid_chunk');
    await validated(validate); const p = await property(siteUrl); if (!p) C.fail('sc_analytics_unknown_property');
    const a = (await query('SELECT * FROM ScAnalyticsArchiveBatches WHERE property_id=:id AND month=:month', { id: p.id, month: bounds.startDate }))[0];
    if (!a || !['published', 'purged'].includes(a.state)) C.fail('sc_analytics_archive_not_verified');
    const receipt = typeof a.archive_receipt === 'string' ? JSON.parse(a.archive_receipt) : a.archive_receipt;
    const verification = await hashStream(await archiveStore.read(receipt));
    if (verification.digest !== digestHex(a.source_digest) || String(verification.rows) !== String(a.source_rows)) C.fail('sc_analytics_archive_verification_failed');
    let removed = 0, done = false;
    for (let part = 0; part < maxChunks; part++) await tx(async transaction => {
      await property(siteUrl, transaction); await validated(validate);
      const params = { id: p.id, month: bounds.startDate, start: bounds.startDate, end: bounds.endDate };
      const [result, metadata] = await sequelize.query(`DELETE FROM ScAnalyticsDaily WHERE property_id=:id AND date BETWEEN :start AND :end LIMIT ${chunkSize}`, { replacements: params, transaction, logging: false });
      const affected = Number(metadata?.affectedRows ?? result?.affectedRows ?? metadata ?? 0); removed += affected;
      const [{ count }] = await query('SELECT COUNT(*) AS count FROM ScAnalyticsDaily WHERE property_id=:id AND date BETWEEN :start AND :end', params, transaction); done = Number(count) === 0;
      await query(`UPDATE ScAnalyticsArchiveBatches SET purged_rows=purged_rows + :removed,state=:state WHERE property_id=:id AND month=:month`, { ...params, removed: affected, state: done ? 'purged' : 'published' }, transaction);
    });
    return { removed, done };
  }
  return { beginInterval, stageRows, commitInterval, abortInterval, writeInterval, writeTotalsInterval, rawSource, archiveMonth, purgeArchivedMonth,
    isWriteEnabled: () => isWriteEnabled(env), isReadEnabled: () => isReadEnabled(env), retentionCutoff: () => C.cutoff(now()) };
}

let runtime;
const runtimeRepo = () => {
  if (!runtime) runtime = createSearchConsoleAnalytics({ sequelize: require('../../models').sequelize, env: process.env });
  return runtime;
};
const exported = { createSearchConsoleAnalytics, storageEnabled: isWriteEnabled, isWriteEnabled, isReadEnabled };
for (const method of ['beginInterval', 'stageRows', 'commitInterval', 'abortInterval', 'writeInterval', 'writeTotalsInterval', 'rawSource', 'archiveMonth', 'purgeArchivedMonth']) {
  exported[method] = (...args) => {
    const enabled = method === 'rawSource' ? isReadEnabled() : isWriteEnabled();
    if (!enabled) return method.startsWith('write') ? Promise.resolve({ skipped: true, reason: 'sc_analytics_write_disabled' }) : Promise.reject(Object.assign(Error('sc_analytics_disabled'), { code: 'sc_analytics_disabled' }));
    return runtimeRepo()[method](...args);
  };
}
module.exports = exported;

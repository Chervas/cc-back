'use strict';

// Restore into a separately provisioned scratch database only. This does not
// replace production facts, delete archives, or publish report coverage.
const { createHash } = require('node:crypto');
const { verifySearchConsoleArchive, stageSearchConsoleArchive } = require('./searchConsoleArchiveVerifier');
const FIELDS = ['date', 'query_id', 'page_id', 'query', 'page_url', 'clicks', 'impressions',
  'position_weighted', 'position_sum', 'position_count', 'row_digest'];
const ROWS = 'ScArchiveRestoredRows', LEDGER = 'ScArchiveRestoreLedger';
const fail = code => { throw Object.assign(Error(code), { code }); };
const need = (value, code) => { if (!value) fail(code); };
const digest = records => {
  const hash = createHash('sha256');
  for (const row of records) hash.update(JSON.stringify(FIELDS.map(k => row[k])) + '\n');
  return hash.digest('hex');
};

function createSearchConsoleArchiveRestorer({ connection, databaseName, serverUuid } = {}) {
  need(connection && ['query', 'beginTransaction', 'commit', 'rollback'].every(k => typeof connection[k] === 'function'), 'sc_archive_restore_connection_required');
  need(typeof databaseName === 'string' && /^sc_restore_[a-f0-9]{16}$/.test(databaseName)
    && typeof serverUuid === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(serverUuid), 'sc_archive_restore_target_invalid');
  const query = async (sql, values = []) => (await connection.query(sql, values))[0];
  const identity = async () => {
    const rows = await query('SELECT DATABASE() AS db, @@server_uuid AS uuid');
    need(rows.length === 1 && rows[0].db === databaseName && rows[0].uuid === serverUuid, 'sc_archive_restore_target_mismatch');
  };
  const authorized = async validate => {
    need(typeof validate === 'function' && await validate() === true, 'sc_archive_restore_authority_required');
    await identity();
  };
  async function isolation() {
    const tables = await query('SELECT TABLE_NAME AS name,TABLE_TYPE AS kind,ENGINE AS engine FROM information_schema.tables WHERE table_schema=DATABASE()');
    need(tables.every(row => [ROWS, LEDGER].includes(row.name)), 'sc_archive_restore_target_not_empty');
    need(tables.every(row => row.kind === 'BASE TABLE' && row.engine === 'InnoDB'), 'sc_archive_restore_isolation_required');
    const triggers = await query('SELECT TRIGGER_NAME FROM information_schema.triggers WHERE trigger_schema=DATABASE() LIMIT 1');
    const foreignKeys = await query('SELECT CONSTRAINT_NAME FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND referenced_table_name IS NOT NULL LIMIT 1');
    need(triggers.length === 0 && foreignKeys.length === 0, 'sc_archive_restore_isolation_required');
  }
  async function schema() {
    await isolation();
    await query(`CREATE TABLE IF NOT EXISTS ${ROWS} (
      \`date\` DATE NOT NULL,query_id BIGINT UNSIGNED NOT NULL,page_id BIGINT UNSIGNED NOT NULL,
      \`query\` MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      page_url MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      clicks BIGINT UNSIGNED NOT NULL,impressions BIGINT UNSIGNED NOT NULL,
      position_weighted DECIMAL(38,9) NOT NULL,position_sum DECIMAL(38,9) NOT NULL,
      position_count BIGINT UNSIGNED NOT NULL,row_digest BINARY(32) NOT NULL,
      PRIMARY KEY(\`date\`,query_id,page_id)) ENGINE=InnoDB`);
    await query(`CREATE TABLE IF NOT EXISTS ${LEDGER} (id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      archive_sha CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      site_url VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      month CHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      source_rows BIGINT UNSIGNED NOT NULL,
      logical_sha CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL) ENGINE=InnoDB`);
    const specs = {
      [ROWS]: { date: ['date'], query_id: ['bigint', 'unsigned'], page_id: ['bigint', 'unsigned'],
        query: ['mediumtext'], page_url: ['mediumtext'], clicks: ['bigint', 'unsigned'], impressions: ['bigint', 'unsigned'],
        position_weighted: ['decimal', '38,9'], position_sum: ['decimal', '38,9'], position_count: ['bigint', 'unsigned'], row_digest: ['binary', '32'] },
      [LEDGER]: { id: ['tinyint', 'unsigned'], archive_sha: ['char', '64'], site_url: ['varchar', '512'], month: ['char', '7'],
        source_rows: ['bigint', 'unsigned'], logical_sha: ['char', '64'], state: ['varchar', '16'] },
    };
    for (const [table, spec] of Object.entries(specs)) {
      const columns = await query(`SELECT COLUMN_NAME AS name,DATA_TYPE AS type,COLUMN_TYPE AS declaration,
        IS_NULLABLE AS nullable,CHARACTER_MAXIMUM_LENGTH AS length,NUMERIC_PRECISION AS precision_value,
        NUMERIC_SCALE AS scale_value,COLLATION_NAME AS collation_name FROM information_schema.columns
        WHERE table_schema=DATABASE() AND table_name=?`, [table]);
      need(columns.length === Object.keys(spec).length, 'sc_archive_restore_schema_mismatch');
      for (const column of columns) {
        const expected = spec[column.name];
        need(expected && column.type === expected[0] && column.nullable === 'NO', 'sc_archive_restore_schema_mismatch');
        if (expected[1] === 'unsigned') need(column.declaration.includes('unsigned'), 'sc_archive_restore_schema_mismatch');
        else if (expected[1] === '38,9') need(Number(column.precision_value) === 38 && Number(column.scale_value) === 9, 'sc_archive_restore_schema_mismatch');
        else if (expected[1]) need(Number(column.length) === Number(expected[1]), 'sc_archive_restore_schema_mismatch');
        if (['query', 'page_url', 'site_url'].includes(column.name)) need(column.collation_name === 'utf8mb4_bin', 'sc_archive_restore_schema_mismatch');
      }
      const indexes = await query('SELECT COLUMN_NAME AS name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=\'PRIMARY\' ORDER BY seq_in_index', [table]);
      need(JSON.stringify(indexes.map(r => r.name)) === JSON.stringify(table === ROWS ? ['date', 'query_id', 'page_id'] : ['id']), 'sc_archive_restore_schema_mismatch');
    }
  }
  async function readBack() {
    const hash = createHash('sha256'); let count = 0, last = null;
    for (;;) {
      const condition = last ? 'WHERE `date`>? OR (`date`=? AND query_id>?) OR (`date`=? AND query_id=? AND page_id>?)' : '';
      const values = last ? [last.date, last.date, last.query_id, last.date, last.query_id, last.page_id] : [];
      const select = FIELDS.map(k => k === 'date' ? "DATE_FORMAT(`date`,'%Y-%m-%d') AS `date`"
        : k === 'row_digest' ? 'LOWER(HEX(row_digest)) AS row_digest'
          : ['query', 'page_url'].includes(k) ? '`' + k + '`' : 'CAST(`' + k + '` AS CHAR) AS `' + k + '`').join(',');
      // Qualify ordering by physical numeric columns. The returned IDs are
      // CAST to CHAR for lossless JS values; sorting those SELECT aliases would
      // be lexical and would break keyset reconciliation beyond the first page.
      const rows = await query(`SELECT ${select} FROM ${ROWS} ${condition} ORDER BY ${ROWS}.\`date\`,${ROWS}.query_id,${ROWS}.page_id LIMIT 250`, values);
      for (const row of rows) { hash.update(JSON.stringify(FIELDS.map(k => row[k])) + '\n'); count++; }
      if (rows.length < 250) break;
      last = rows.at(-1);
    }
    return { logicalSha: hash.digest('hex'), rows: count };
  }
  async function restore({ source, openSource, expected, validate, limits } = {}) {
    expected = Object.freeze({ ...expected });
    limits = limits == null ? undefined : Object.freeze({ ...limits });
    await authorized(validate);
    const streaming = typeof openSource === 'function';
    need(streaming ? source == null : openSource == null, 'sc_archive_restore_source_invalid');
    // Pass one finishes before any schema/row mutations. A reopenable immutable
    // versioned archive can be verified without collecting a whole month in RAM.
    const verified = await verifySearchConsoleArchive(streaming ? await openSource() : source, expected,
      { collectRecords: !streaming, ...(limits ? { limits } : {}) });
    const logicalSha = verified.recordsSha256, lockName = 'sc-archive:' + databaseName;
    if (!streaming) need(digest(verified.records) === logicalSha, 'sc_archive_restore_reconciliation_failed');
    const locks = await query('SELECT GET_LOCK(?,0) AS acquired', [lockName]);
    need(Number(locks[0]?.acquired) === 1, 'sc_archive_restore_busy');
    let transactionStarted = false, committing = false;
    try {
      await authorized(validate); await schema();
      await connection.beginTransaction(); transactionStarted = true;
      const entries = await query(`SELECT archive_sha,site_url,month,CAST(source_rows AS CHAR) AS source_rows,logical_sha,state FROM ${LEDGER} FOR UPDATE`);
      const [{ count }] = await query(`SELECT COUNT(*) AS count FROM ${ROWS}`);
      // Touch both tables inside the transaction first, retaining their metadata
      // locks while checking engine/trigger/FK drift and staging restored rows.
      await isolation();
      if (entries.length) {
        const entry = entries[0];
        need(entries.length === 1 && entry.archive_sha === verified.sha256 && entry.site_url === verified.siteUrl
          && entry.month === verified.month && entry.source_rows === String(verified.rowCount)
          && entry.logical_sha === logicalSha && entry.state === 'complete', 'sc_archive_restore_other_archive');
        const actual = await readBack();
        need(actual.rows === verified.rowCount && actual.logicalSha === logicalSha, 'sc_archive_restore_reconciliation_failed');
        await authorized(validate); committing = true; await connection.commit(); transactionStarted = false;
        return { status: 'scratch_restored_verified', replay: true, rows: actual.rows, logicalSha, sourceSha256: verified.sha256, coveragePublished: false };
      }
      need(Number(count) === 0, 'sc_archive_restore_target_not_empty');
      const insertRows = async rows => {
        need(Array.isArray(rows) && rows.length > 0 && rows.length <= 250, 'sc_archive_restore_batch_invalid');
        await authorized(validate);
        const values = [];
        const tuples = rows.map(row => { values.push(...FIELDS.map(k => row[k])); return '(' + FIELDS.map(k => k === 'row_digest' ? 'UNHEX(?)' : '?').join(',') + ')'; });
        await query(`INSERT INTO ${ROWS}(${FIELDS.map(k => '`' + k + '`').join(',')}) VALUES ${tuples.join(',')}`, values);
      };
      if (streaming) {
        const second = await stageSearchConsoleArchive(await openSource(), {
          siteUrl: verified.siteUrl, month: verified.month, sha256: verified.sha256, bytes: verified.bytes, rows: verified.rowCount,
        }, { onStagedRows: insertRows, ...(limits ? { limits } : {}) });
        need(second.sha256 === verified.sha256 && second.recordsSha256 === logicalSha && second.rowCount === verified.rowCount,
          'sc_archive_restore_source_changed');
      } else {
        for (let at = 0; at < verified.records.length; at += 250) await insertRows(verified.records.slice(at, at + 250));
      }
      const actual = await readBack();
      need(actual.rows === verified.rowCount && actual.logicalSha === logicalSha, 'sc_archive_restore_reconciliation_failed');
      await query(`INSERT INTO ${LEDGER}(id,archive_sha,site_url,month,source_rows,logical_sha,state) VALUES(1,?,?,?,?,?,'complete')`,
        [verified.sha256, verified.siteUrl, verified.month, String(verified.rowCount), logicalSha]);
      await authorized(validate); committing = true; await connection.commit(); transactionStarted = false;
      return { status: 'scratch_restored_verified', replay: false, rows: actual.rows, logicalSha, sourceSha256: verified.sha256, coveragePublished: false };
    } catch (error) {
      if (transactionStarted && !committing) await connection.rollback().catch(() => {});
      // A missing COMMIT acknowledgement is an unknown outcome. A new owned
      // connection may reconcile the same immutable archive/ledger; no replay
      // of INSERTs and no destructive reset is issued from this catch branch.
      if (committing) fail('sc_archive_restore_commit_unconfirmed');
      if (error?.code?.startsWith('sc_archive_')) throw error;
      fail('sc_archive_restore_sql_failed');
    } finally { await query('SELECT RELEASE_LOCK(?) AS released', [lockName]).catch(() => {}); }
  }
  function restoreArchived({ archiveStore, receipt, expected, validate, limits } = {}) {
    need(archiveStore?.independent === true && typeof archiveStore.read === 'function', 'sc_archive_restore_store_required');
    // Pin every object-version selector before either await. Store.read also
    // validates its own receipt; no latest-version lookup or provider fallback.
    let pinned;
    try { pinned = JSON.parse(JSON.stringify(receipt)); }
    catch { fail('sc_archive_restore_receipt_invalid'); }
    const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
    freeze(pinned);
    return restore({ openSource: () => archiveStore.read(pinned), expected, validate, limits });
  }
  return Object.freeze({ restore, restoreArchived });
}
module.exports = { createSearchConsoleArchiveRestorer };

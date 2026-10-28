'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const migration = require('../../../migrations/20261018150000-create-search-console-analytics');
const { createSearchConsoleAnalytics } = require('../../services/searchConsoleAnalytics.service');
const { createSearchConsoleArchiveStore } = require('../../lib/searchConsoleArchiveStore');
const { createSearchConsoleArchiveRestorer } = require('../../lib/searchConsoleArchiveRestore');

function filesystemTransport(root) {
  fs.mkdirSync(root, { mode: 0o700, recursive: true });
  const filename = (key, version) => path.join(root, createHash('sha256').update(key + ':' + version).digest('hex'));
  return {
    async putObject(input) {
      assert.equal(input.IfNoneMatch, '*');
      const VersionId = 'fictitious-' + randomBytes(12).toString('hex');
      const file = filename(input.Key, VersionId);
      fs.writeFileSync(file, input.Body, { mode: 0o600, flag: 'wx' });
      const metadata = { ContentLength: input.Body.length, VersionId, ServerSideEncryption: input.ServerSideEncryption,
        SSEKMSKeyId: input.SSEKMSKeyId, ChecksumSHA256: input.ChecksumSHA256 };
      fs.writeFileSync(file + '.json', JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
      return metadata;
    },
    async getObject(input) {
      const file = filename(input.Key, input.VersionId);
      return { ...JSON.parse(fs.readFileSync(file + '.json', 'utf8')), Body: fs.createReadStream(file, { highWaterMark: 37 }) };
    },
  };
}

withIsolatedCampaignMysql(async ({ sql, report }) => {
  const mysql = require('mysql2/promise');
  const opened = [];
  const socketPath = path.join(report.root, 'mysql.sock');
  const connect = async database => {
    const c = await mysql.createConnection({ socketPath, user: 'root', password: '', database,
      supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, charset: 'utf8mb4' });
    opened.push(c); return c;
  };
  const scratch = async () => {
    const databaseName = 'sc_restore_' + randomBytes(8).toString('hex');
    await sql.query('CREATE DATABASE `' + databaseName + '`');
    const connection = await connect(databaseName);
    const [[row]] = await connection.query('SELECT @@server_uuid AS uuid');
    return { connection, databaseName, serverUuid: row.uuid };
  };
  const transportRoot = path.join(report.root, 'fictitious-external-objects');
  const storeConfig = { bucket: 'fictitious-sc-archive', prefix: 'private/sc/', expectedBucketOwner: '111122223333',
    kmsKeyId: 'arn:aws:kms:eu-west-3:111122223333:key/00000000-0000-4000-8000-000000000002', partBytes: 1024 };
  const store = () => createSearchConsoleArchiveStore({ ...storeConfig, transport: filesystemTransport(transportRoot) });
  try {
    await migration.up(sql.getQueryInterface());
    const repo = createSearchConsoleAnalytics({ sequelize: sql,
      env: { SC_ANALYTICS_WRITE_ENABLED: 'true', SC_ANALYTICS_ARCHIVE_ENABLED: 'true', SC_ANALYTICS_PURGE_ENABLED: 'true' },
      now: () => new Date('2026-10-28T00:00:00Z') });
    const siteUrl = 'sc-domain:archive-fixture.example', month = '2024-02';
    const rows = [
      { date: '2024-02-01', query: 'weighted 🦷', page_url: 'https://archive-fixture.example/á', clicks: 1, impressions: 10, position: 2 },
      { date: '2024-02-29', query: 'weighted 🦷', page_url: 'https://archive-fixture.example/á', clicks: 3, impressions: 30, position: 4 },
      { date: '2024-02-01', query: 'zero', page_url: '', clicks: '9007199254740993', impressions: 0, position: 2 },
      { date: '2024-02-29', query: 'zero', page_url: '', clicks: 0, impressions: 0, position: 4 },
    ];
    await repo.writeInterval({ siteUrl, startDate: '2024-02-01', endDate: '2024-02-29',
      complete: true, rowLimitReached: false, validate: async () => true, rows });
    const archive = await repo.archiveMonth({ siteUrl, month, archiveStore: store(), validate: async () => true });
    const [archiveRows] = await sql.query('SELECT archive_receipt FROM ScAnalyticsArchiveBatches');
    const receipt = typeof archiveRows[0].archive_receipt === 'string' ? JSON.parse(archiveRows[0].archive_receipt) : archiveRows[0].archive_receipt;
    const expected = { siteUrl, month, sha256: archive.digest, bytes: archive.bytes, rows: archive.rows };
    // A fresh adapter reopens persisted fixture objects; no RAM body/Map is reused.
    const reopen = () => store().read(receipt);
    assert.deepEqual(await repo.purgeArchivedMonth({ siteUrl, month, archiveStore: store(), validate: async () => true }), { removed: 4, done: true });
    const [[source]] = await sql.query('SELECT COUNT(*) AS count FROM ScAnalyticsDaily'); assert.equal(Number(source.count), 0);
    const target = await scratch(), restorer = createSearchConsoleArchiveRestorer(target);
    const restored = await restorer.restore({ source: await reopen(), expected, validate: async () => true });
    assert.equal(restored.status, 'scratch_restored_verified'); assert.equal(restored.rows, 4); assert.equal(restored.coveragePublished, false);
    const [[precision]] = await target.connection.query("SELECT CAST(clicks AS CHAR) AS clicks FROM ScArchiveRestoredRows WHERE `query`='zero' AND `date`='2024-02-01'");
    assert.equal(precision.clicks, '9007199254740993');
    const [[weighted]] = await target.connection.query("SELECT SUM(position_weighted)/SUM(impressions) AS position FROM ScArchiveRestoredRows WHERE `query`='weighted 🦷'");
    assert.equal(Number(weighted.position), 3.5);
    const [[zero]] = await target.connection.query("SELECT SUM(position_sum)/SUM(position_count) AS position FROM ScArchiveRestoredRows WHERE `query`='zero'");
    assert.equal(Number(zero.position), 3);
    report.checks.push('actual compact SQL → segmented versioned file fixture → verified monthly publication → bounded purge → fresh archive adapter → separate scratch SQL restores exact Unicode, weighted and zero-impression metrics and >2^53 integer');

    const originalQuery = target.connection.query.bind(target.connection); let writes = 0;
    target.connection.query = async (...args) => { if (/^INSERT /i.test(args[0])) writes++; return originalQuery(...args); };
    const replay = await restorer.restore({ source: await reopen(), expected, validate: async () => true });
    assert.equal(replay.replay, true); assert.equal(writes, 0); target.connection.query = originalQuery;
    await target.connection.query("UPDATE ScArchiveRestoredRows SET clicks=clicks+1 WHERE `query`='weighted 🦷' AND `date`='2024-02-01'");
    await assert.rejects(restorer.restore({ source: await reopen(), expected, validate: async () => true }), { code: 'sc_archive_restore_reconciliation_failed' });
    report.checks.push('same immutable archive retry reconciles completed SQL without INSERT replay; later target tampering is rejected');

    await target.connection.query('ALTER TABLE ScArchiveRestoredRows ENGINE=MyISAM');
    await assert.rejects(restorer.restore({ source: await reopen(), expected, validate: async () => true }), { code: 'sc_archive_restore_isolation_required' });
    await target.connection.query('ALTER TABLE ScArchiveRestoredRows ENGINE=InnoDB');
    await target.connection.query('CREATE TRIGGER scratch_restore_guard BEFORE INSERT ON ScArchiveRestoredRows FOR EACH ROW SET NEW.clicks=NEW.clicks');
    await assert.rejects(restorer.restore({ source: await reopen(), expected, validate: async () => true }), { code: 'sc_archive_restore_isolation_required' });
    await target.connection.query('DROP TRIGGER scratch_restore_guard');
    await target.connection.query('ALTER TABLE ScArchiveRestoreLedger ADD UNIQUE KEY scratch_parent(source_rows)');
    await target.connection.query('UPDATE ScArchiveRestoreLedger SET source_rows=1');
    await target.connection.query('ALTER TABLE ScArchiveRestoredRows ADD CONSTRAINT fk_restore_fixture FOREIGN KEY (position_count) REFERENCES `' + target.databaseName + '`.ScArchiveRestoreLedger(source_rows)');
    await assert.rejects(restorer.restore({ source: await reopen(), expected, validate: async () => true }), { code: 'sc_archive_restore_isolation_required' });
    report.checks.push('preexisting scratch engine drift, trigger and FK are rejected, preserving transactional isolation and preventing undeclared side effects');

    const bad = await scratch();
    await assert.rejects(createSearchConsoleArchiveRestorer(bad).restore({ source: await reopen(), expected: { ...expected, sha256: '0'.repeat(64) }, validate: async () => true }), { code: 'sc_archive_external_digest_mismatch' });
    const [[noTables]] = await bad.connection.query('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE()');
    assert.equal(Number(noTables.count), 0);
    assert.throws(() => createSearchConsoleArchiveRestorer({ ...bad, databaseName: 'clinicaclick' }), { code: 'sc_archive_restore_target_invalid' });
    await assert.rejects(createSearchConsoleArchiveRestorer({ ...bad, serverUuid: '00000000-0000-4000-8000-000000000001' }).restore({ source: await reopen(), expected, validate: async () => true }), { code: 'sc_archive_restore_target_mismatch' });
    report.checks.push('archive corruption and production-like/wrong-server targets reject before scratch DDL or data mutations');

    const revoked = await scratch(); let validations = 0;
    await assert.rejects(createSearchConsoleArchiveRestorer(revoked).restore({ source: await reopen(), expected,
      validate: async () => ++validations < 4 }), { code: 'sc_archive_restore_authority_required' });
    const [[rolledBack]] = await revoked.connection.query('SELECT COUNT(*) AS count FROM ScArchiveRestoredRows');
    assert.equal(Number(rolledBack.count), 0);
    report.checks.push('authority revoked after row staging rolls back all restored rows and never publishes a complete ledger');

    const hash = text => createHash('sha256').update(text).digest('hex');
    const streamSite = 'sc-domain:stream-fixture.example';
    const streamLines = [JSON.stringify({ version: 1, siteUrl: streamSite, startDate: '2024-01-01', endDate: '2024-01-31', revision: '1' })];
    for (let id = 1; id <= 600; id++) {
      const row = { date: '2024-01-01', query_id: String(id), page_id: '1', query: 'stream-' + id, page_url: '',
        clicks: '1', impressions: '1', position_weighted: '1.000000000', position_sum: '1.000000000', position_count: '1' };
      row.row_digest = hash(JSON.stringify([row.date, hash(row.query), hash(''), row.clicks, row.impressions, row.position_weighted, row.position_sum, row.position_count]));
      streamLines.push(JSON.stringify(row));
    }
    const streamBody = Buffer.from(streamLines.join('\n') + '\n');
    async function* parts() { for (let at = 0; at < streamBody.length; at += 60000) yield streamBody.subarray(at, at + 60000); }
    const streamReceipt = await store().put({ key: 'search-console/v1/' + hash(streamSite) + '/2024-01/' + randomUUID() + '.ndjson',
      body: parts(), contentType: 'application/x-ndjson' });
    const streamExpected = { siteUrl: streamSite, month: '2024-01', sha256: hash(streamBody), bytes: streamBody.length, rows: 600 };
    const streamTarget = await scratch(), mutableReceipt = JSON.parse(JSON.stringify(streamReceipt)); let sourceReads = 0;
    const pinnedStore = { independent: true, read: async pinned => {
      assert(Object.isFrozen(pinned)); assert(Object.isFrozen(pinned.manifest));
      sourceReads++;
      const source = await store().read(pinned);
      if (sourceReads === 1) mutableReceipt.manifest.key = '../caller-retarget';
      return source;
    } };
    const streamed = await createSearchConsoleArchiveRestorer(streamTarget).restoreArchived({ archiveStore: pinnedStore,
      receipt: mutableReceipt, expected: streamExpected, validate: async () => true });
    assert.equal(sourceReads, 2); assert.equal(streamed.rows, 600); assert.equal(streamed.coveragePublished, false);
    report.checks.push('two complete verification passes restore 600 rows in awaited SQL batches using one deeply pinned immutable receipt despite caller retargeting');

    const late = await scratch(); let lateReads = 0, stagedInserts = 0;
    const lateQuery = late.connection.query.bind(late.connection);
    late.connection.query = async (...args) => { if (/^INSERT INTO ScArchiveRestoredRows/.test(args[0])) stagedInserts++; return lateQuery(...args); };
    const corruptOnSecond = { independent: true, read: async pinned => {
      lateReads++; const source = await store().read(pinned);
      if (lateReads === 1) return source;
      return (async function* () { let last = null;
        for await (const chunk of source) { if (last) yield last; last = Buffer.from(chunk); }
        if (last) { last[last.length - 1] = 120; yield last; }
      })();
    } };
    await assert.rejects(createSearchConsoleArchiveRestorer(late).restoreArchived({ archiveStore: corruptOnSecond,
      receipt: streamReceipt, expected: streamExpected, validate: async () => true }), error => /^sc_archive_/.test(error.code));
    assert.equal(lateReads, 2); assert(stagedInserts >= 2);
    const [[lateRows]] = await late.connection.query('SELECT COUNT(*) AS count FROM ScArchiveRestoredRows');
    const [[lateLedger]] = await late.connection.query('SELECT COUNT(*) AS count FROM ScArchiveRestoreLedger');
    assert.equal(Number(lateRows.count), 0); assert.equal(Number(lateLedger.count), 0);
    report.checks.push('late corruption on second immutable read after actual provisional SQL INSERTs rolls back every row and leaves zero complete ledgers');

    const lost = await scratch(), commit = lost.connection.commit.bind(lost.connection);
    lost.connection.commit = async () => { await commit(); throw Error('FICTITIOUS_LOST_COMMIT_ACK'); };
    await assert.rejects(createSearchConsoleArchiveRestorer(lost).restoreArchived({ archiveStore: store(), receipt, expected, validate: async () => true }), { code: 'sc_archive_restore_commit_unconfirmed' });
    await lost.connection.end(); opened.splice(opened.indexOf(lost.connection), 1);
    const recoveredConnection = await connect(lost.databaseName);
    const recovered = await createSearchConsoleArchiveRestorer({ ...lost, connection: recoveredConnection }).restoreArchived({ archiveStore: store(), receipt, expected, validate: async () => true });
    assert.equal(recovered.replay, true); assert.equal(recovered.rows, 4);
    report.checks.push('lost COMMIT acknowledgement remains UNKNOWN; a new connection observes complete durable ledger and verifies rows without duplicate restore');
    report.archive = { rows: archive.rows, bytes: archive.bytes, sha256: archive.digest, objectsOnDisk: fs.readdirSync(transportRoot).length,
      storageQualification: 'fictitious local file transport only; not production independent S3 acceptance', restoredToProduction: false };
  } finally { await Promise.all(opened.map(c => c.end().catch(() => {}))); }
}).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });

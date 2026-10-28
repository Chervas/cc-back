'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const migration = require('../../../migrations/20261018150000-create-search-console-analytics');
const { createSearchConsoleAnalytics } = require('../../services/searchConsoleAnalytics.service');
const C = require('../../lib/searchConsoleAnalyticsContract');
const L = require('../../lib/searchConsoleLegacyBackfill');
const O = require('../search_console_legacy_retirement.operator');

async function main() {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    const { Sequelize } = require('sequelize');
    const env = { SC_ANALYTICS_WRITE_ENABLED: 'true', SC_ANALYTICS_READ_ENABLED: 'true', SC_ANALYTICS_LEGACY_DETAIL_CUT_ENABLED: 'true' };
    const q = async (s, p = {}) => (await sql.query(s, { replacements: p, logging: false }))[0];
    await migration.up(sql.getQueryInterface());
    await q(`CREATE TABLE WebScQueryDaily(id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,clinica_id INT NOT NULL,site_url VARCHAR(512),date DATE NOT NULL,
      query VARCHAR(1024) NOT NULL,query_hash CHAR(64) NOT NULL,page_url VARCHAR(2048),page_url_hash CHAR(64) NOT NULL,
      clicks INT NOT NULL,impressions INT NOT NULL,ctr DECIMAL(8,6) NOT NULL,position DECIMAL(8,3),KEY clinic_date(clinica_id,date)) ENGINE=InnoDB`);
    await q('CREATE TABLE WebScDaily(id INT PRIMARY KEY,value INT) ENGINE=InnoDB');
    await q('CREATE TABLE WebScDailyAgg(id INT PRIMARY KEY,value INT) ENGINE=InnoDB');
    await q('INSERT INTO WebScDaily VALUES(1,100)'); await q('INSERT INTO WebScDailyAgg VALUES(1,7)');
    const mappings = [1, 2].map(id => ({ id, clinicaId: 701, googleConnectionId: 17, siteUrl: `sc-domain:fixture${id}.example` }));
    const startDate = '2026-10-01', endDate = startDate;
    const rows = [];
    for (let i = 1; i <= 7; i++) {
      const value = { date: startDate, query: 'fictitious-' + i, page_url: '', clicks: 1, impressions: 3, position: 2 };
      rows.push(value);
      await q(`INSERT INTO WebScQueryDaily(clinica_id,site_url,date,query,query_hash,page_url,page_url_hash,clicks,impressions,ctr,position)
        VALUES(701,:site,:date,:query,:qh,'',:ph,1,3,0.333333,2)`, { site: mappings[0].siteUrl, ...value, qh: C.hash(value.query), ph: C.hash('') });
    }
    for (const extra of [{ clinic: 999, date: startDate }, { clinic: 701, date: '2026-10-02' }]) await q(`INSERT INTO WebScQueryDaily
      (clinica_id,site_url,date,query,query_hash,page_url,page_url_hash,clicks,impressions,ctr,position)
      VALUES(:clinic,:site,:date,'outside',:qh,'',:ph,1,3,0.333333,2)`, { ...extra, site: mappings[0].siteUrl, qh: C.hash('outside'), ph: C.hash('') });
    const repo = createSearchConsoleAnalytics({ sequelize: sql, env });
    const validate = async () => true;
    const options = { siteUrl: mappings[0].siteUrl, startDate, endDate, complete: true, rowLimitReached: false, validate,
      rows, totalsRows: [{ date: startDate, clicks: 100, impressions: 1000, position: 4 }] };
    let ack = await repo.writeInterval(options);
    await repo.writeInterval({ ...options, siteUrl: mappings[1].siteUrl, rows: [], totalsRows: [{ date: startDate, clicks: 40, impressions: 400, position: 5 }] });
    const request = { batchId: ack.batchId, siteUrl: options.siteUrl, startDate, endDate, kind: 'detail' };
    assert.equal((await repo.confirmPublication(request, { validate })).detailComplete, true);
    await q('DELETE FROM ScAnalyticsCoverageDaily WHERE property_id=(SELECT id FROM ScAnalyticsProperties WHERE site_url=:site)', { site: options.siteUrl });
    await assert.rejects(repo.confirmPublication(request, { validate }), { code: 'sc_analytics_incomplete_coverage' });
    ack = await repo.writeInterval(options);
    assert.equal((await repo.confirmPublication({ ...request, batchId: ack.batchId }, { validate })).committed, true);
    report.checks.push('actual confirmPublication resolves committed batch scope plus coverage ledger, rejects missing coverage and accepts its repair');

    const [id] = await q('SELECT @@server_uuid AS serverUuid');
    const input = { clinicId: 701, startDate, endDate, mappings, sourceIdentity: { serverUuid: id.serverUuid, metadataSha256: C.hash('fictitious fixture schema') } };
    const sample = await O.prepareLegacyRetirement({ ...input, sql, env, validate });
    assert.equal(sample.status, 'UNPROVEN'); assert.equal(sample.sourceRows, 7);
    const refs = ['mappingManifestRef', 'compactReconciliationRef', 'recoveryRef', 'restorationAcceptanceRef', 'readersAcceptanceRef', 'writerCutAcceptanceRef'];
    const evidence = { schema: 'sc-analytics-legacy-retirement-evidence/1', scopeSha256: sample.scopeSha256,
      sourceDigest: sample.sourceDigest, sourceRows: sample.sourceRows,
      ...Object.fromEntries(refs.map(key => [key, { path: '/offline/fictitious-' + key + '.json', sha256: C.hash('offline:' + key) }])) };
    // ONLY fixture authority. External acceptance references are deliberately
    // fictitious; SQL reconciliation itself executes on the real owned engine.
    const verifyEvidence = async (proof, expected) => {
      const replacement = {}; const source = await repo.rawSource({ siteUrls: mappings.map(m => m.siteUrl), startDate, endDate, replacements: replacement, prefix: 'retireFixture' });
      const compact = (await sql.query(`SELECT COUNT(*) AS n,SUM(clicks) AS clicks FROM ${source.sqlFrom}`, { replacements: replacement, logging: false }))[0][0];
      await source.validate();
      const [{ impressions }] = await q('SELECT SUM(impressions) AS impressions FROM ScAnalyticsPropertyDaily');
      if (proof.sourceDigest !== sample.sourceDigest || expected.sourceRows !== 7 || Number(compact.n) !== 7 || Number(compact.clicks) !== 7 || Number(impressions) !== 1400) return { verified: false };
      return { verified: true, evidenceSha256: C.hash(JSON.stringify(proof)) };
    };
    const plan = await O.prepareLegacyRetirement({ ...input, sql, env, validate, evidence, verifyEvidence });
    assert.equal(plan.status, 'PROVEN');
    const persisted = JSON.parse(JSON.stringify(plan));
    const reloaded = await O.admitPersistedRetirementPlan(persisted, { expectedSha256: plan.planSha256, verifyEvidence });
    report.checks.push('bounded SHA-only legacy capture leaves missing proof UNPROVEN; explicit fictitious references bind actual compact facts and independent totals without production acceptance claims');
    const dir = path.join(report.root, 'retire-journal'); fs.mkdirSync(dir, { mode: 0o700 }); const journal = L.createBackfillJournal(dir);
    let opens = [], deleteCalls = 0;
    const connect = () => {
      const db = new Sequelize({ username: 'root', password: '', database: report.database, host: 'localhost', dialect: 'mysql',
        dialectOptions: { socketPath: path.join(report.root, 'mysql.sock') }, logging: false, pool: { max: 1, min: 0 } });
      opens.push(db); return db;
    };
    const close = async db => { await db.close(); opens = opens.filter(x => x !== db); };
    const args = { plan: reloaded, journal, env, validate, verifyEvidence, resolveMappings: async () => mappings, chunkSize: 2, maxChunks: 1 };
    try {
      const changed = connect(); await q('UPDATE WebScQueryDaily SET clicks=99 WHERE id=1');
      await assert.rejects(O.retireLegacyRange({ ...args, sql: changed, operationId: randomUUID() }), { code: 'sc_analytics_legacy_retire_source_changed' });
      await close(changed); await q('UPDATE WebScQueryDaily SET clicks=1 WHERE id=1');
      const missing = connect();
      await assert.rejects(O.retireLegacyRange({ ...args, sql: missing, operationId: randomUUID(), resolveMappings: async () => mappings.slice(0, 1) }), { code: 'sc_analytics_legacy_retire_mapping_universe_changed' });
      await close(missing);
      assert.equal(Number((await q('SELECT COUNT(*) AS n FROM WebScQueryDaily WHERE clinica_id=701 AND date=:date', { date: startDate }))[0].n), 7);
      report.checks.push('source metric drift and incomplete mapping universe reject before any deletion');

      const operationId = randomUUID(), lost = connect(); let actualDelete = false;
      const lostSql = { async query(text, opts) { if (text.startsWith('DELETE FROM WebScQueryDaily')) { deleteCalls++; actualDelete = true; } return lost.query(text, opts); },
        async transaction(...params) { const result = await lost.transaction(...params); if (actualDelete) throw Error('FICTITIOUS_ACK_LOST_AFTER_REAL_COMMIT'); return result; } };
      await assert.rejects(O.retireLegacyRange({ ...args, sql: lostSql, operationId }), /FICTITIOUS_ACK_LOST/);
      await close(lost); // Prior owned SQL pool is genuinely closed before recovery.
      assert.equal(Number((await q('SELECT COUNT(*) AS n FROM WebScQueryDaily WHERE clinica_id=701 AND date=:date', { date: startDate }))[0].n), 5);
      const guarded = connect();
      await assert.rejects(O.retireLegacyRange({ ...args, sql: guarded, operationId }), { code: 'sc_analytics_legacy_retire_previous_attempt_closure_required' });
      await close(guarded);
      const resumed = connect();
      const counted = { query: async (text, opts) => { if (text.startsWith('DELETE FROM WebScQueryDaily')) deleteCalls++; return resumed.query(text, opts); }, transaction: (...params) => resumed.transaction(...params) };
      const partial = await O.retireLegacyRange({ ...args, sql: counted, operationId, confirmPreviousAttemptClosed: async () => true });
      await close(resumed); assert.equal(partial.remaining, 3); assert.equal(partial.observed, 2); assert.equal(deleteCalls, 2);
      const finish = connect(); const result = await O.retireLegacyRange({ ...args, sql: finish, operationId, maxChunks: 100, confirmPreviousAttemptClosed: async () => true });
      await close(finish); assert.equal(result.done, true); assert.equal(result.remaining, 0); assert.equal(result.filesystemBytesReclaimed, null);
      const repeat = connect(); const noReplay = await O.retireLegacyRange({ ...args, sql: repeat, operationId, confirmPreviousAttemptClosed: async () => true });
      await close(repeat); assert.equal(noReplay.removed, 0); assert.equal(noReplay.observed, 7);
      assert.equal(Number((await q('SELECT COUNT(*) AS n FROM WebScQueryDaily'))[0].n), 2);
      assert.equal(Number((await q('SELECT value FROM WebScDaily'))[0].value), 100); assert.equal(Number((await q('SELECT value FROM WebScDailyAgg'))[0].value), 7);
      assert.equal(Number((await q('SELECT COUNT(*) AS n FROM ScAnalyticsDaily'))[0].n), 7);
      report.checks.push('actual delete COMMIT then ACK loss halts; closed-pool recovery observes exact absent IDs without replay, continues chunks and preserves other clinic/date plus small daily/aggregate/compact facts');
      report.externalReferences = 'fictitious offline-only; no live restore/read-cut/deployment acceptance';
    } finally { journal.close(); await Promise.all(opens.map(db => db.close())); }
  });
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { main };

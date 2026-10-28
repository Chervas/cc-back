'use strict';
// EXPLICIT isolated fixture only. Never imports models/index or app bootstrap.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const migration = require('../../../migrations/20261018150000-create-search-console-analytics');
const C = require('../../lib/searchConsoleAnalyticsContract');
const L = require('../../lib/searchConsoleLegacyBackfill');
const O = require('../search_console_analytics.operator');
const { createSearchConsoleAnalytics } = require('../../services/searchConsoleAnalytics.service');

async function main() {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    const query = async (text, replacements = {}) => (await sql.query(text, { replacements, logging: false }))[0];
    await migration.up(sql.getQueryInterface());
    await query(`CREATE TABLE WebScQueryDaily(id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,clinica_id INT NOT NULL,site_url VARCHAR(512),date DATE NOT NULL,
      query VARCHAR(1024) NOT NULL,query_hash CHAR(64) NOT NULL,page_url VARCHAR(2048),page_url_hash CHAR(64) NOT NULL,
      clicks INT NOT NULL,impressions INT NOT NULL,position DECIMAL(8,3),KEY idx_webscquerydaily_clinic_date(clinica_id,date),
      UNIQUE KEY legacy_identity(clinica_id,date,query_hash,page_url_hash)) ENGINE=InnoDB`);
    await query(`CREATE TABLE WebScDaily(id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,clinica_id INT NOT NULL,site_url VARCHAR(512),date DATE NOT NULL,
      clicks INT NOT NULL,impressions INT NOT NULL,position DECIMAL(8,3),KEY clinic_date(clinica_id,date),UNIQUE KEY legacy_totals(clinica_id,site_url,date)) ENGINE=InnoDB`);
    const scope = { siteUrl: 'sc-domain:backfill-mysql-fixture.example', startDate: '2026-09-01', endDate: '2026-09-03', clinicIds: [701, 702] };
    const d = { date: scope.startDate, query: 'clínica 🦷', page_url: 'https://backfill-mysql-fixture.example/a', clicks: 2, impressions: 10, position: '2.000' };
    const t = { date: scope.startDate, clicks: 100, impressions: 1000, position: '4.000' };
    for (const clinic of scope.clinicIds) {
      await query(`INSERT INTO WebScQueryDaily(clinica_id,site_url,date,query,query_hash,page_url,page_url_hash,clicks,impressions,position)
        VALUES(:clinic,:site,:date,:query,:qh,:page,:ph,:clicks,:impressions,:position)`, { clinic, site: scope.siteUrl, ...d,
        qh: C.hash(d.query), page: d.page_url, ph: C.hash(d.page_url) });
      await query('INSERT INTO WebScDaily(clinica_id,site_url,date,clicks,impressions,position) VALUES(:clinic,:site,:date,:clicks,:impressions,:position)',
        { clinic, site: scope.siteUrl, ...t });
    }
    const [identity] = await query('SELECT @@server_uuid AS serverUuid');
    const sourceIdentity = { serverUuid: identity.serverUuid, metadataSha256: C.hash('offline fixture reviewed two-table schema') };
    const validate = async () => true;
    const snapshot = await L.readLegacyInterval({ ...scope, sequelize: sql, validate, sourceIdentity, limits: { pageRows: 1 } });
    assert.equal(snapshot.exhausted, true); assert.equal(snapshot.detail.length, 2); assert.equal(snapshot.totals.length, 2);
    const unproven = await L.prepareLegacyBackfill({ snapshot }); assert.equal(unproven.status, 'UNPROVEN');
    const n = C.normalize(d, scope), nt = C.normalize(t, scope, true), evidence = [];
    for (const date of ['2026-09-01', '2026-09-02', '2026-09-03']) for (const family of ['detail', 'totals']) evidence.push({
      siteUrl: scope.siteUrl, date, family, completeness: 'EXHAUSTED_REVIEWED_COHORT', rows: date === d.date ? 1 : 0,
      sha256: L.digest(date === d.date ? [family === 'detail' ? n.row_digest : nt.row_digest] : []),
      sourceRef: { path: '/offline/known-fictitious-inserts.json', sha256: C.hash(JSON.stringify([d, t])) },
      authorityRef: { path: '/offline/fixture-review.json', sha256: C.hash('ONLY fictitious owned SQL fixture') } });
    const plan = await L.prepareLegacyBackfill({ snapshot, evidence, validateEvidence: async proof => evidence.includes(proof) });
    assert.equal(plan.status, 'PROVEN'); assert.equal(plan.identicalClones, 2);
    report.checks.push('genuine RR bounded source reads both indexed legacy families, WARN0, clone audit, missing provenance remains UNPROVEN');
    const repo = createSearchConsoleAnalytics({ sequelize: sql, env: { SC_ANALYTICS_WRITE_ENABLED: 'true', SC_ANALYTICS_READ_ENABLED: 'true' } });
    const directory = path.join(report.root, 'backfill-journal'); fs.mkdirSync(directory, { mode: 0o700 });
    const journal = O.createBackfillJournal(directory);
    try {
      const batchId = randomUUID(); let commitCalls = 0;
      const ackLost = { ...repo, async commitInterval(...args) {
        commitCalls++; await repo.commitInterval(...args); throw Error('offline actual COMMIT then local acknowledgement loss');
      } };
      const args = { repository: ackLost, plan, batchId, journal, validate };
      await assert.rejects(O.backfillInterval(args), /acknowledgement loss/);
      assert.equal((await repo.inspectInterval({ ...scope, batchId }, { sourceDigest: plan.planSha256, validate })).state, 'committed');
      await assert.rejects(O.backfillInterval(args), { code: 'sc_analytics_previous_attempt_closure_required' });
      let before = await query('SELECT revision FROM ScAnalyticsProperties');
      assert.equal((await O.backfillInterval({ ...args, confirmPreviousAttemptClosed: validate })).replay, true);
      assert.equal(commitCalls, 1); assert.deepEqual(await query('SELECT revision FROM ScAnalyticsProperties'), before);
      assert.equal(Number((await query('SELECT COUNT(*) AS n FROM ScAnalyticsDaily'))[0].n), 1);
      assert.equal(Number((await query('SELECT clicks FROM ScAnalyticsPropertyDaily'))[0].clicks), 100);
      assert.equal(Number((await query('SELECT queries_top3 FROM ScAnalyticsRankingDaily'))[0].queries_top3), 1);
      assert.equal(Number((await query('SELECT COUNT(*) AS n FROM ScAnalyticsCoverageDaily WHERE detail_complete=1 AND totals_complete=1'))[0].n), 3);
      assert.equal(Number((await query('SELECT COUNT(*) AS n FROM ScAnalyticsPropertyDaily WHERE date>\'2026-09-01\''))[0].n), 0);
      report.checks.push('actual joint detail+independent totals/rank/coverage transaction; explicit proven empty dates create no metric zeros; lost COMMIT ACK reconciles without replay');

      const fresh = { ...scope, rows: [{ ...d, clicks: 99 }], totalsRows: [t], complete: true, rowLimitReached: false, validate };
      await repo.writeInterval(fresh); // A genuinely newer compact publication.
      await assert.rejects(O.backfillInterval({ repository: repo, plan, batchId: randomUUID(), journal, validate }), { code: 'sc_analytics_backfill_target_conflict' });
      assert.equal(Number((await query('SELECT clicks FROM ScAnalyticsDaily'))[0].clicks), 99);
      await repo.writeInterval({ ...fresh, rows: [], totalsRows: [] }); // Complete newer empty interval.
      await assert.rejects(O.backfillInterval({ repository: repo, plan, batchId: randomUUID(), journal, validate }), { code: 'sc_analytics_backfill_target_conflict' });
      assert.equal(Number((await query('SELECT COUNT(*) AS n FROM ScAnalyticsDaily'))[0].n), 0);
      assert.equal(Number((await query('SELECT COUNT(*) AS n FROM ScAnalyticsPropertyDaily'))[0].n), 0);
      await repo.writeInterval({ ...fresh, rows: [d] });
      await query('UPDATE ScAnalyticsRankingDaily SET queries_top3=99');
      await assert.rejects(O.backfillInterval({ repository: repo, plan, batchId: randomUUID(), journal, validate }), { code: 'sc_analytics_backfill_target_conflict' });
      assert.equal(Number((await query('SELECT queries_top3 FROM ScAnalyticsRankingDaily'))[0].queries_top3), 99);
      await repo.writeInterval({ ...fresh, rows: [d] });
      before = await query('SELECT revision FROM ScAnalyticsProperties');
      report.checks.push('old historical plan cannot overwrite newer compact facts, complete empty coverage or conflicting rankings; all remain unchanged after rejection');

      // Failed stage is durable but cannot alter a public interval. A resumed
      // attempt reuses the same source-bound batch and idempotent stage keys.
      const nextId = randomUUID(); let fail = true;
      const stageFailure = { ...repo, async stageRows(handle, input, options) {
        const result = await repo.stageRows(handle, input, options);
        if (options.totals && fail) { fail = false; throw Error('offline late totals failure'); } return result;
      } };
      await assert.rejects(O.backfillInterval({ repository: stageFailure, plan, batchId: nextId, journal, validate }), /late totals failure/);
      assert.deepEqual(await query('SELECT revision FROM ScAnalyticsProperties'), before);
      assert.equal((await O.backfillInterval({ repository: stageFailure, plan, batchId: nextId, journal, validate, confirmPreviousAttemptClosed: validate })).committed, true);
      assert.deepEqual(await query('SELECT revision FROM ScAnalyticsProperties'), before);
      report.checks.push('late totals staging failure publishes nothing; resumed same batch stages both families and metric no-op retains revision');

      const third = randomUUID(); let staged = false;
      const revoke = { ...repo, async stageRows(...args) { staged = true; return repo.stageRows(...args); } };
      await assert.rejects(O.backfillInterval({ repository: revoke, plan, batchId: third, journal,
        validate: async () => !staged }), { code: 'sc_analytics_authority_changed' });
      assert.deepEqual(await query('SELECT revision FROM ScAnalyticsProperties'), before);
      report.checks.push('authority revoked after stage prevents publication/coverage changes');
      await query('UPDATE WebScDaily SET clicks=999 WHERE clinica_id=702');
      const drift = await L.readLegacyInterval({ ...scope, sequelize: sql, validate, sourceIdentity });
      assert.deepEqual((await L.prepareLegacyBackfill({ snapshot: drift, evidence, validateEvidence: validate })).reasons, ['sc_analytics_conflicting_duplicate']);
      report.checks.push('actual conflicting totals clones cannot produce a proven plan');
    } finally { journal.close(); }
  });
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { main };

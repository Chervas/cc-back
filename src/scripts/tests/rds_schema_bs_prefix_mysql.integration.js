'use strict';
// Explicitly owned Unix-socket MySQL only. This exercises real Sequelize SQL
// through the native migration interface, not RDS, AWS or runtime credentials.
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const C = require('../../lib/rdsSchemaMigration'), P = require('../../lib/rdsSchemaMigrationPolicy');
const R = require('../../lib/rdsSchemaFirstCreateReconciliation'), T = require('../../lib/rdsSchemaMigrationTransport');
const { digest } = require('../../lib/securitySchemaContract');
const SOURCE = path.resolve(__dirname, '../../..'), names = R.BS_ACKED.selected.map(row => row.name);

test('owned MySQL: native three-migration bridge accepts quoted semicolon, preserves rows and excludes already completed month', async () => {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    for (const name of ['PatientFollowUps', 'SocialPosts', 'SocialAdsEntities']) {
      await sql.query('CREATE TABLE `' + name + '` (`id` INT NOT NULL PRIMARY KEY, `marker` VARCHAR(30) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
      await sql.query('INSERT INTO `' + name + '` (`id`,`marker`) VALUES (1,\'TEST_ONLY_OWNED\')');
    }
    await sql.query('CREATE TABLE SequelizeMeta (`name` VARCHAR(255) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    const raw = await sql.connectionManager.getConnection();
    const connection = raw.promise(), nativeQuery = raw.query, sent = [], events = [];
    raw.query = function (options, values, callback) {
      const statement = typeof options === 'string' ? options : options.sql;
      if (/^(?:ALTER TABLE|INSERT INTO SequelizeMeta)/i.test(statement)) sent.push(statement);
      return nativeQuery.call(this, options, values, callback);
    };
    raw.execute = raw.query;
    const admin = { raw, identity: { database: report.database, engineVersion: report.mysql }, query: async (statement, values = []) => {
      const [rows] = await connection.query(statement, values), [warnings] = await connection.query('SHOW WARNINGS');
      assert.deepEqual(warnings, []); return rows;
    } };
    try {
      await admin.query('SET SESSION sql_mode=?', [T.SQL_MODES.join(',')]);
      const before = await C.schemaSnapshot(admin), pins = P.migrationFiles(SOURCE, names);
      async function applyOne(name) {
        const loaded = P.loadMigration(SOURCE, name, pins, S);
        const bridge = C.migrationInterface({ admin, aws: { assertFresh() {} }, migrationName: name,
          journal: event => events.push(event), beforeDispatch() {} });
        try { await loaded.migration.up(bridge.queryInterface, loaded.facade); } finally { await bridge.restore(); }
        const inserted = await admin.query('INSERT INTO SequelizeMeta (name) VALUES (?)', [name]);
        assert.equal(inserted.affectedRows, 1);
      }
      await applyOne(names[0]);
      const observed = await C.schemaSnapshot(admin);
      assert.equal(observed.columns.length, before.columns.length + 1);
      const column = observed.columns.find(row => row.TABLE_NAME === 'PatientFollowUps' && row.COLUMN_NAME === 'clinical_target_month');
      assert.deepEqual(column, await R.acknowledgedMonthDefinition(SOURCE, {
        before, selected: R.BS_ACKED.selected.map(row => ({ ...row, alreadyApplied: false })), toApply: names, moduleFiles: pins,
      }));
      const plan = P.buildPlan({ info: { revision: 'b'.repeat(40), contractDigest: 'c'.repeat(64), contract: { tables: {}, migrations: [] },
        migrations: Object.fromEntries(R.BS_ACKED.selected.map(row => [row.name, row.sha256])) }, before: observed, identity: admin.identity,
        selected: names, moduleFiles: pins, profile: 'TEST_ONLY', at: Date.now() });
      assert.deepEqual(plan.toApply, names.slice(1));
      for (const name of plan.toApply) await applyOne(name);
      const after = await C.schemaSnapshot(admin);
      assert.deepEqual(after.migrations, names);
      assert.equal(after.columns.length, before.columns.length + 3);
      for (const name of ['PatientFollowUps', 'SocialPosts', 'SocialAdsEntities']) {
        const [[row]] = await sql.query('SELECT id,marker FROM `' + name + '`');
        assert.deepEqual(row, { id: 1, marker: 'TEST_ONLY_OWNED' });
      }
      const [[comment]] = await sql.query("SELECT COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='SocialPosts' AND COLUMN_NAME='original_media_url'");
      assert.equal(comment.COLUMN_COMMENT, 'Original media returned by normal synchronization; never a video thumbnail');
      assert.equal(sent.filter(statement => /^ALTER TABLE/i.test(statement)).length, 3);
      assert.equal(sent.filter(statement => P.sha(statement) === R.BS_ACKED.sqlSha256).length, 1);
      assert.equal(events.filter(event => event.event === 'statement_request').length, 3);
      assert.equal(events.filter(event => event.event === 'statement_ack').length, 3);
      assert(!events.some(event => event.event === 'statement_diagnostics' || event.event === 'statement_reconciled'));
      assert(events.filter(event => event.event === 'statement_ack').every(event => event.warnings === 0));
      report.checks.push('Actual native migrationInterface for all three frozen migrations; zero warnings',
        'Quoted semicolon in SocialPosts comment reaches MySQL unchanged', 'Month ADD dispatched exactly once; remaining selected migrations are two',
        'Only owned fictitious rows and SequelizeMeta; original rows preserved', 'No RDS, AWS, runtime credentials or TCP');
      report.statementHashes = events.filter(event => event.event === 'statement_request').map(event => event.sqlSha256);
      report.finalSchemaDigest = digest(after);
    } finally {
      raw.query = nativeQuery;
      await sql.connectionManager.releaseConnection(raw);
    }
  });
});

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const release = require('../../lib/googleBusinessProfileWritesSchemaRelease');
const { snapshot, compare } = require('../../lib/securitySchemaContract');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

withIsolatedCampaignMysql(async ({ sql, report }) => {
  await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  await sql.getQueryInterface().createTable('SequelizeMeta', {
    name: { type: require('sequelize').STRING(255), allowNull: false, primaryKey: true },
  }, { charset: 'utf8', collate: 'utf8_unicode_ci' });

  const raw = await sql.connectionManager.getConnection();
  const connection = raw.promise();
  try {
    const query = async (statement, values = []) => (await connection.query(statement, values))[0];
    const before = await snapshot(query);
    const sourceContract = require('../../../ops/security/schema-contract.json');
    const hashes = Object.fromEntries(release.MIGRATIONS.map(name => [name, sha256(
      require('node:fs').readFileSync(require('node:path').join(__dirname, '../../../migrations', name)),
    )]));
    const info = {
      revision: 'a'.repeat(40),
      contractDigest: sha256('isolated-gbp-write-contract'),
      migrations: hashes,
      baseContract: { defaults: sourceContract.defaults, tables: {}, migrations: [] },
      targetContract: {
        defaults: sourceContract.defaults,
        tables: Object.fromEntries(release.TABLES.map(name => [name, sourceContract.tables[name]])),
        migrations: release.MIGRATIONS.map(name => ({ name, sha256: hashes[name] })),
      },
    };
    const plan = await release.prepare({ query, info, database: 'campaign_optimization_qa' });
    const events = [];
    const result = await release.apply({
      connection,
      plan,
      info,
      database: 'campaign_optimization_qa',
      verifyWritersStopped: async () => {},
      verifyBackup: async value => assert.deepEqual(value, plan),
      loadMigration: migration => require('../../../migrations/' + migration.name),
      journal: event => events.push(event),
    });

    assert.equal(result.compatible, true);
    assert.deepEqual(result.completed, release.MIGRATIONS);
    assert.deepEqual(events.filter(event => event.status === 'migration_completed').map(event => event.migration), release.MIGRATIONS);
    assert.equal(events.at(-1).status, 'google_business_profile_writes_schema_compatible');
    const after = await snapshot(query);
    assert.equal(compare(after, info.targetContract).compatible, true);
    for (const table of release.TABLES) {
      assert(after.tables.some(row => row.TABLE_NAME === table));
      assert.equal(Number((await query(`SELECT COUNT(*) AS total FROM \`${table}\``))[0].total), 0);
    }
    await assert.rejects(release.apply({
      connection,
      plan,
      info,
      database: 'campaign_optimization_qa',
      verifyWritersStopped: async () => {},
      verifyBackup: async () => {},
      loadMigration: migration => require('../../../migrations/' + migration.name),
      journal: () => {},
    }), /google_business_profile_writes_plan_stale_or_invalid|google_business_profile_writes_base_schema_incompatible/);
    report.checks.push('exact GBP write DDL applies once, produces three empty contract-compatible tables and refuses the consumed plan');
  } finally {
    await sql.connectionManager.releaseConnection(raw);
  }
}).catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});

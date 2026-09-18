'use strict';
// Full forward sequence on an owned MySQL socket; fictitious rows only. No app
// boot, environment files, production database, Redis or provider is reachable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { snapshot, compare, digest } = require('../../lib/securitySchemaContract');
const { applyPlan } = require('../security-schema-release');
const source = path.resolve(__dirname, '../../..');
const contract = require('../../../ops/security/schema-contract.json');
const migrationNames = [
  '20260913000000-add-business-profile-broker-read-binding.js',
  '20260913010000-create-business-profile-broker-revocations.js',
  '20260913020000-create-google-oauth-broker-flows.js',
  '20260913030000-add-search-console-broker-read-binding.js',
  '20260913040000-add-analytics-broker-read-binding.js',
  '20260913050000-scope-search-console-bindings-by-mapping.js',
  '20260913060000-create-google-property-broker-revocations.js',
  '20260913070000-scope-google-oauth-by-service.js',
  '20260913080000-add-google-ads-broker-bindings.js',
  '20260913090000-create-google-ads-broker-revocations.js',
  '20260913100000-add-ads-google-oauth-cohort.js',
  '20260913110000-stage-google-ads-broker-mappings.js',
  '20260913120000-create-google-ads-enrollment.js',
];
const legacyModels = [
  ['GoogleConnection', 'googleconnection'], ['ClinicBusinessLocation', 'clinicbusinesslocation'],
  ['ClinicWebAsset', 'clinicwebasset'], ['ClinicAnalyticsProperty', 'clinicanalyticsproperty'],
  ['ClinicGoogleAdsAccount', 'clinicgoogleadsaccount'], ['GoogleConnectionAssignment', 'googleconnectionassignment'],
];
const registryModels = [
  ['BusinessProfileBrokerBinding', 'businessprofilebrokerbinding'], ['BusinessProfileBrokerRevocation', 'businessprofilebrokerrevocation'],
  ['GoogleOAuthBrokerBinding', 'googleoauthbrokerbinding'], ['GoogleOAuthBrokerRequest', 'googleoauthbrokerrequest'],
  ['SearchConsoleBrokerBinding', 'searchconsolebrokerbinding'], ['AnalyticsBrokerBinding', 'analyticsbrokerbinding'],
  ['GooglePropertyBrokerRevocation', 'googlepropertybrokerrevocation'], ['GoogleAdsBrokerBinding', 'googleadsbrokerbinding'],
  ['GoogleAdsBrokerRevocation', 'googleadsbrokerrevocation'], ['GoogleAdsEnrollmentScope', 'googleadsenrollmentscope'],
  ['GoogleAdsEnrollmentRequest', 'googleadsenrollmentrequest'],
];
const mappingTables = ['ClinicBusinessLocations', 'ClinicWebAssets', 'ClinicAnalyticsProperties', 'ClinicGoogleAdsAccounts'];
const requiredNames = ['GoogleConnections', ...mappingTables];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const qi = sql.getQueryInterface();
  await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  await qi.createTable('Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true } });
  await qi.createTable('SequelizeMeta', { name: { type: D.STRING(255), primaryKey: true } });
  for (const [name, filename] of legacyModels) {
    const model = require('../../../models/' + filename)(sql, D);
    for (const field of ['broker_read_connection_ref', 'broker_read_asset_ref']) model.removeAttribute(field);
    // Both observed runtimes still have the original NOT NULL token column.
    if (name === 'GoogleConnection') { model.rawAttributes.accessToken.allowNull = false; model.refreshAttributes(); }
    models[name] = model; await model.sync();
  }
  for (const [name, filename] of registryModels) {
    // Load model definitions only. The actual migrations must create their tables.
    models[name] = require('../../../models/' + filename)(sql, D);
    requiredNames.push(models[name].getTableName());
  }
  await models.GoogleConnection.bulkCreate([101, 102].map(id => ({ id, googleUserId: 'synthetic-shared-subject',
    accessToken: 'FICTITIOUS_ACCESS_' + id, refreshToken: 'FICTITIOUS_REFRESH_' + id, scopes: 'synthetic-scope', expiresAt: new Date('2030-01-01Z') })));
  await models.GoogleConnectionAssignment.bulkCreate([
    { id: 1, googleConnectionId: 101, assignmentScope: 'clinic', scopeKey: 'clinic:11', clinicaId: 11, status: 'active' },
    { id: 2, googleConnectionId: 101, assignmentScope: 'group', scopeKey: 'group:7', grupoClinicaId: 7, status: 'active' },
    { id: 3, googleConnectionId: 101, assignmentScope: 'clinic', scopeKey: 'clinic:12', clinicaId: 12, status: 'disconnected' },
  ]);
  for (const id of [1, 2]) {
    await models.ClinicBusinessLocation.create({ id, clinica_id: 10 + id, google_connection_id: 101, location_id: String(123450 + id), is_active: id === 1 });
    await models.ClinicWebAsset.create({ id, clinicaId: 10 + id, googleConnectionId: 101, siteUrl: 'https://synthetic-' + id + '.invalid/', isActive: id === 1 });
    await models.ClinicAnalyticsProperty.create({ id, clinicaId: 10 + id, googleConnectionId: 101, propertyName: 'properties/' + (123450 + id), isActive: id === 1 });
    await models.ClinicGoogleAdsAccount.create({ id, clinicaId: 10 + id, googleConnectionId: 101, customerId: '123456789' + id, isActive: id === 1 });
  }
  const legacy = require('../../services/googleLegacyCredentials.service').forModels(models);
  let hydrated = 0;
  models.GoogleConnection.addHook('afterFind', (row, options) => { if (row && options.attributes?.includes('accessToken')) hydrated++; });
  await assert.rejects(legacy.load(101), { code: 'google_credentials_unavailable' });
  assert.equal(hydrated, 0);
  report.checks.push('missing registries block the new credential loader before token hydration even with broker activation absent');
  const preserved = {};
  for (const [name] of legacyModels) {
    const table = models[name].getTableName();
    const [rows] = await sql.query('SELECT * FROM `' + table + '` ORDER BY id');
    preserved[table] = rows;
  }
  const migrations = migrationNames.map(name => ({ name, sha256: sha(fs.readFileSync(path.join(source, 'migrations', name))) }));
  const expected = { version: 1, defaults: contract.defaults, migrations,
    tables: Object.fromEntries(requiredNames.filter(name => contract.tables[name]).map(name => [name, contract.tables[name]])) };
  const info = { revision: 'isolated-google-schema', contractDigest: digest(expected), contract: expected,
    migrations: Object.fromEntries(migrations.map(m => [m.name, m.sha256])) };
  const raw = await sql.connectionManager.getConnection();
  const connection = raw.promise();
  const query = async (text, values = []) => (await connection.query(text, values))[0];
  try {
    const initial = await snapshot(query);
    assert.equal(initial.columns.find(c => c.TABLE_NAME === 'GoogleConnections' && c.COLUMN_NAME === 'accessToken').IS_NULLABLE, 'NO');
    const plan = { version: 1, runtime: 'dev', database: 'clinicaclick_dev_isolated', revision: info.revision,
      contractDigest: info.contractDigest, beforeDigest: digest(initial), migrations };
    const journal = [];
    const applied = await applyPlan({ connection, plan, info, journal: e => journal.push(structuredClone(e)),
      loadMigration: m => require(path.join(source, 'migrations', m.name)) });
    assert.deepEqual(applied.completed, migrationNames);
    assert.equal(journal.filter(e => e.status === 'migration_started').length, 13);
    assert.equal(journal.filter(e => e.status === 'migration_completed').length, 13);
    await assert.rejects(applyPlan({ connection, plan, info, journal: () => {}, loadMigration: () => assert.fail('stale plan') }), /schema_plan_stale_or_invalid/);
    report.checks.push('all 13 real migrations run in order under the deployment lock; journaled once and stale replay rejected');
    const after = await snapshot(query);
    assert.equal(after.columns.find(c => c.TABLE_NAME === 'GoogleConnections' && c.COLUMN_NAME === 'accessToken').IS_NULLABLE, 'YES');
    // Isolated schema evidence for reviewing the release contract, never data.
    const observed = { version: 1, defaults: after.defaults, tables: {}, migrations };
    for (const name of requiredNames) {
      const table = after.tables.find(t => t.TABLE_NAME === name);
      assert.ok(table, name);
      const columns = after.columns.filter(c => c.TABLE_NAME === name
        && (!mappingTables.includes(name) || c.COLUMN_NAME.startsWith('broker_read_'))
        && (name !== 'GoogleConnections' || c.COLUMN_NAME === 'accessToken'));
      const indexes = mappingTables.includes(name) || name === 'GoogleConnections' ? [] : after.indexes.filter(i => i.TABLE_NAME === name);
      observed.tables[name] = { ENGINE: table.ENGINE, TABLE_COLLATION: table.TABLE_COLLATION,
        columns: columns.map(({ TABLE_NAME, ...c }) => c),
        indexes: [...new Set(indexes.map(i => i.INDEX_NAME))].map(index => ({ name: index,
          columns: indexes.filter(i => i.INDEX_NAME === index).map(({ TABLE_NAME, ...i }) => i) })),
        checks: after.checks.filter(c => c.TABLE_NAME === name).map(({ TABLE_NAME, ...c }) => c) };
    }
    fs.writeFileSync(path.join(report.root, 'google-schema-contract.json'), JSON.stringify(observed, null, 2), { mode: 0o600, flag: 'wx' });
    for (const [table, rows] of Object.entries(preserved)) {
      const fields = Object.keys(rows[0]).map(name => '`' + name + '`').join(',');
      assert.deepEqual(await query('SELECT ' + fields + ' FROM `' + table + '` ORDER BY id'), rows);
    }
    for (const [name] of registryModels) assert.equal(await models[name].count(), 0);
    assert.equal((await legacy.load(101)).accessToken, 'FICTITIOUS_ACCESS_101');
    report.checks.push('active/inactive mappings, clinic/group/disconnected assignments and fictitious credentials preserved; empty registries leave legacy access available');
    for (const table of mappingTables) {
      for (const field of ['broker_read_connection_ref', 'broker_read_asset_ref']) {
        await assert.rejects(query('UPDATE `' + table + '` SET `' + field + "`='synthetic' WHERE id=1"), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
      }
      await query('UPDATE `' + table + "` SET broker_read_connection_ref='synthetic-connection',broker_read_asset_ref='synthetic-asset' WHERE id=1");
      await query('UPDATE `' + table + '` SET broker_read_connection_ref=NULL,broker_read_asset_ref=NULL WHERE id=1');
    }
    report.checks.push('all four real CHECK constraints reject either half binding and admit complete or empty pairs');
    assert.equal(requiredNames.length, 16);
    assert.equal(Object.keys(expected.tables).length, 16, 'release contract must cover all required Google tables');
    assert.equal(compare(after, expected).compatible, true, JSON.stringify(compare(after, expected)));
    for (const migration of migrations) assert.deepEqual(contract.migrations.find(m => m.name === migration.name), migration);
    // Test the metadata checker against a real disabled CHECK (not a mock).
    await query('ALTER TABLE ClinicWebAssets ALTER CHECK cc_sc_broker_read_pair NOT ENFORCED');
    const drift = compare(await snapshot(query), expected);
    assert.deepEqual(drift.issues, [{ table: 'ClinicWebAssets', constraint: 'cc_sc_broker_read_pair', reason: 'check_definition' }]);
    await query('ALTER TABLE ClinicWebAssets ALTER CHECK cc_sc_broker_read_pair ENFORCED');
    assert.equal(compare(await snapshot(query), expected).compatible, true);
    report.checks.push('release contract pins actual columns, compound uniqueness, enums, blocked defaults, migration hashes and enforced CHECK expressions');
    const beforeHydration = hydrated;
    await models.GoogleAdsEnrollmentScope.create({ scope_key: 'group:7', google_connection_id: 101, google_user_id: 'synthetic-shared-subject',
      connection_ref: 'synthetic', asset_ref: 'synthetic', tenant_clinic_id: 11, root_customer_id: '1234567890' });
    assert.equal((await models.GoogleAdsEnrollmentScope.findByPk('group:7')).state, 'blocked');
    for (const id of [101, 102]) await assert.rejects(legacy.load(id), { code: 'google_oauth_legacy_closed' });
    assert.equal(hydrated, beforeHydration);
    await assert.rejects(require('../../../migrations/20260913120000-create-google-ads-enrollment').down(qi));
    assert.equal(await models.GoogleAdsEnrollmentScope.count(), 1);
    report.checks.push('one blocked enrollment marker closes shared identity and duplicate ID before token hydration; destructive down refuses retained history');
  } finally { await sql.connectionManager.releaseConnection(raw); }
}).catch(() => { process.exitCode = 1; });

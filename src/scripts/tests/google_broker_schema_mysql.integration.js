'use strict';
// Full forward sequence on an owned MySQL socket; fictitious rows only. No app
// boot, environment files, production database, Redis or provider is reachable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
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
  '20260918110000-create-google-conversion-submissions.js',
  '20260918190000-create-google-ads-action-journal.js',
  '20260918203000-google-action-recovery-ownership.js',
  '20260918220000-create-google-destination-journal.js',
  '20260918224500-index-google-destination-recovery.js',
  '20260918235000-index-google-receipt-review.js',
];
const historicalMigrations = ['20260711003000-create-google-ads-conversion-upload-attempts.js',
  '20260711012000-add-google-ads-conversion-destination-key.js',
  '20260712090000-add-data-manager-conversion-statuses.js'];
const journalTables = ['GoogleConversionSubmissions','GoogleAdsActionPlans','GoogleAdsActionCommands',
  'GoogleDestinationAuthorizations','GoogleDestinationCommands'];
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
const requiredNames = ['GoogleConnections', ...mappingTables, 'GoogleAdsConversionUploadAttempts', ...journalTables];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const qi = sql.getQueryInterface();
  await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  await qi.createTable('Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true } });
  for (const [table,id] of [['Clinicas','id_clinica'],['GruposClinicas','id_grupo'],['IntakeConfigs','id']]) {
    await qi.createTable(table,{[id]:{type:D.INTEGER,primaryKey:true}});
  }
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
  // These three July migrations already exist in both observed runtimes. Seed
  // their real schema and history before the nineteen pending forward steps.
  for (const name of historicalMigrations) {
    await require(path.join(source,'migrations',name)).up(qi,D);
    await qi.bulkInsert('SequelizeMeta',[{name}]);
  }
  await qi.bulkInsert('GoogleAdsConversionUploadAttempts',['pending','accepted','partial_success'].map((status,i)=>({
    dedupe_key:String(i+1).repeat(64),assignment_scope:'clinic',event_name:'fixture',
    google_connection_id:101,google_connection_assignment_id:1,
    click_id_type:null,click_id_hash:null,status,history:JSON.stringify([{source:'fictitious'}])
  })));
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
  preserved.GoogleAdsConversionUploadAttempts=(await sql.query('SELECT * FROM GoogleAdsConversionUploadAttempts ORDER BY id'))[0];
  const migrations = migrationNames.map(name => ({ name, sha256: sha(fs.readFileSync(path.join(source, 'migrations', name))) }));
  const allMigrations = [...historicalMigrations.map(name=>({name,sha256:sha(fs.readFileSync(path.join(source,'migrations',name)))})),...migrations];
  const expected = { version: 1, defaults: contract.defaults, migrations:allMigrations,
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
    assert.equal(journal.filter(e => e.status === 'migration_started').length, 19);
    assert.equal(journal.filter(e => e.status === 'migration_completed').length, 19);
    await assert.rejects(applyPlan({ connection, plan, info, journal: () => {}, loadMigration: () => assert.fail('stale plan') }), /schema_plan_stale_or_invalid/);
    report.checks.push('all 19 real migrations run in order under the deployment lock; journaled once and stale replay rejected');
    const after = await snapshot(query);
    assert.equal(after.columns.find(c => c.TABLE_NAME === 'GoogleConnections' && c.COLUMN_NAME === 'accessToken').IS_NULLABLE, 'YES');
    // Isolated schema evidence for reviewing the release contract, never data.
    const observed = { version: 1, defaults: after.defaults, tables: {}, migrations:allMigrations };
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
        checks: after.checks.filter(c => c.TABLE_NAME === name).map(({ TABLE_NAME, ...c }) => c),
        foreignKeys: after.foreignKeys.filter(c => c.TABLE_NAME === name).map(({ TABLE_NAME, ...c }) => c) };
    }
    fs.writeFileSync(path.join(report.root, 'google-schema-contract.json'), JSON.stringify(observed, null, 2), { mode: 0o600, flag: 'wx' });
    for (const [table, rows] of Object.entries(preserved)) {
      const fields = Object.keys(rows[0]).map(name => '`' + name + '`').join(',');
      assert.deepEqual(await query('SELECT ' + fields + ' FROM `' + table + '` ORDER BY id'), rows);
    }
    for (const [name] of registryModels) assert.equal(await models[name].count(), 0);
    for (const table of journalTables) assert.equal(Number((await query('SELECT COUNT(*) n FROM '+table))[0].n),0);
    assert.equal((await legacy.load(101)).accessToken, 'FICTITIOUS_ACCESS_101');
    report.checks.push('active/inactive mappings, clinic/group/disconnected assignments, fictitious credentials and pending/accepted/partial conversion history preserved; sixteen new registries and journals empty, legacy access remains available');
    for (const table of mappingTables) {
      for (const field of ['broker_read_connection_ref', 'broker_read_asset_ref']) {
        await assert.rejects(query('UPDATE `' + table + '` SET `' + field + "`='synthetic' WHERE id=1"), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
      }
      await query('UPDATE `' + table + "` SET broker_read_connection_ref='synthetic-connection',broker_read_asset_ref='synthetic-asset' WHERE id=1");
      await query('UPDATE `' + table + '` SET broker_read_connection_ref=NULL,broker_read_asset_ref=NULL WHERE id=1');
    }
    report.checks.push('all four real CHECK constraints reject either half binding and admit complete or empty pairs');
    assert.equal(requiredNames.length, 22);
    assert.equal(Object.keys(expected.tables).length, 22, 'release contract must cover all required Google tables');
    assert.equal(compare(after, expected).compatible, true, JSON.stringify(compare(after, expected)));
    for (const migration of allMigrations) assert.deepEqual(contract.migrations.find(m => m.name === migration.name), migration);
    // Test the metadata checker against a real disabled CHECK (not a mock).
    await query('ALTER TABLE ClinicWebAssets ALTER CHECK cc_sc_broker_read_pair NOT ENFORCED');
    const drift = compare(await snapshot(query), expected);
    assert.deepEqual(drift.issues, [{ table: 'ClinicWebAssets', constraint: 'cc_sc_broker_read_pair', reason: 'check_definition' }]);
    await query('ALTER TABLE ClinicWebAssets ALTER CHECK cc_sc_broker_read_pair ENFORCED');
    assert.equal(compare(await snapshot(query), expected).compatible, true);
    for (const [table,index,columns] of [
      ['GoogleConversionSubmissions','cc_google_receipt_review',['mapping_id','scope_digest','delivery_digest','created_at','submission_id']],
      ['GoogleDestinationAuthorizations','cc_google_destination_recovery',['actor_user_id','mapping_id','scope_key','scope_digest','created_at','authorization_id']]
    ]) {
      await qi.removeIndex(table,index);
      assert(compare(await snapshot(query),expected).issues.some(i=>i.table===table&&i.index===index));
      await qi.addIndex(table,columns,{name:index});
    }
    await query('ALTER TABLE GoogleConversionSubmissions ALTER CHECK cc_google_conversion_attempt NOT ENFORCED');
    assert(compare(await snapshot(query),expected).issues.some(i=>i.constraint==='cc_google_conversion_attempt'));
    await query('ALTER TABLE GoogleConversionSubmissions ALTER CHECK cc_google_conversion_attempt ENFORCED');
    assert.equal(compare(await snapshot(query),expected).compatible,true);
    report.checks.push('release contract pins actual columns, compound uniqueness, enums, blocked defaults, migration hashes and enforced CHECK expressions');
    const stamp=new Date('2026-09-19T00:00:00.000Z'),planId=randomUUID(),authId=randomUUID(),session=randomUUID(),hash='a'.repeat(64);
    async function insert(table,row){const fields=Object.keys(row);await query('INSERT INTO '+table+' ('+fields.map(k=>'`'+k+'`').join(',')+') VALUES ('+fields.map(()=>'?').join(',')+')',Object.values(row));}
    await insert('GoogleConversionSubmissions',{submission_id:randomUUID(),attempt_id:1,dedupe_key:hash,mapping_id:1,google_connection_id:101,
      connection_ref:'fictitious',asset_ref:'fictitious',tenant_ref:'clinic:11',customer_id:'1234567890',conversion_action_id:'1',event_name:'fixture',
      scope_digest:hash,delivery_digest:hash,audit_digest:hash,payload_digest:hash,state:'unknown',attempted_at:stamp,created_at:stamp,updated_at:stamp});
    await assert.rejects(query("UPDATE GoogleConversionSubmissions SET attempted_at=NULL"),{code:'ER_CHECK_CONSTRAINT_VIOLATED'});
    await insert('GoogleAdsActionPlans',{plan_id:planId,owner_digest:hash,actor_user_id:1,session_ref:session,mapping_id:1,customer_id:'1234567890',input:'{}',created_at:stamp,updated_at:stamp});
    await insert('GoogleAdsActionCommands',{command_id:randomUUID(),plan_id:planId,family:'apply',state:'attempted',attempted_at:stamp});
    await insert('GoogleDestinationAuthorizations',{authorization_id:authId,plan_id:planId,owner_digest:hash,actor_user_id:1,session_ref:session,session_expires_at:stamp,
      scope_key:'clinic:11',scope_digest:hash,mapping_id:1,customer_id:'1234567890',input:'{}',created_at:stamp,updated_at:stamp});
    await insert('GoogleDestinationCommands',{command_id:randomUUID(),authorization_id:authId,family:'revoke',actor_user_id:1,session_ref:session,state:'attempted',attempted_at:stamp});
    for(const name of migrationNames.filter(n=>/create-google-(conversion-submissions|ads-action-journal|destination-journal)|google-action-recovery-ownership/.test(n))) {
      await assert.rejects(require(path.join(source,'migrations',name)).down(qi),/Preserve/);
    }
    await assert.rejects(query('DELETE FROM GoogleAdsActionPlans WHERE plan_id=?',[planId]),{code:'ER_ROW_IS_REFERENCED_2'});
    await assert.rejects(query('DELETE FROM GoogleDestinationAuthorizations WHERE authorization_id=?',[authId]),{code:'ER_ROW_IS_REFERENCED_2'});
    for(const table of journalTables)assert.equal(Number((await query('SELECT COUNT(*) n FROM '+table))[0].n),1);
    report.checks.push('unknown conversion, attempted action and pending withdrawal survive destructive down attempts; parent deletion cannot cascade away receipt/command ownership');
    const beforeHydration = hydrated;
    await models.GoogleAdsEnrollmentScope.create({ scope_key: 'group:7', google_connection_id: 101, google_user_id: 'synthetic-shared-subject',
      connection_ref: 'synthetic', asset_ref: 'synthetic', tenant_clinic_id: 11, root_customer_id: '1234567890' });
    assert.equal((await models.GoogleAdsEnrollmentScope.findByPk('group:7')).state, 'blocked');
    for (const id of [101, 102]) await assert.rejects(legacy.load(id), { code: 'google_oauth_legacy_closed' });
    assert.equal(hydrated, beforeHydration);
    await assert.rejects(require('../../../migrations/20260913120000-create-google-ads-enrollment').down(qi));
    assert.equal(await models.GoogleAdsEnrollmentScope.count(), 1);
    report.checks.push('one blocked enrollment marker closes shared identity and duplicate ID before token hydration; destructive down refuses retained history');
    report.migrations=migrationNames;report.historicalMigrations=historicalMigrations;report.tables=requiredNames;
    report.legacyRowsPreserved=Object.values(preserved).reduce((n,rows)=>n+rows.length,0);
  } finally { await sql.connectionManager.releaseConnection(raw); }
}).catch(() => { process.exitCode = 1; });

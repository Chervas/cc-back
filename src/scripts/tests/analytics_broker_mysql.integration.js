'use strict';
const assert = require('node:assert/strict'); const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { analyticsReport } = require('../../../services/integrations-broker/test/analytics-helpers');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  await require('./fixtures/google_ads_enrollment_mysql.fixture').installGoogleAdsEnrollmentTables({ sql, models });
  models.GoogleAdsBrokerBinding = require('../../../models/googleadsbrokerbinding')(sql, D);
  await models.GoogleAdsBrokerBinding.sync();
  models.GoogleAdsBrokerRevocation = require('../../../models/googleadsbrokerrevocation')(sql, D);
  await models.GoogleAdsBrokerRevocation.sync();
  const qi = sql.getQueryInterface(); await qi.createTable('Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true } });
  models.GoogleConnection = require('../../../models/googleconnection')(sql, D); await models.GoogleConnection.sync();
  await require('../../../migrations/20260913020000-create-google-oauth-broker-flows').up(qi, D);
  await require('../../../migrations/20260913070000-scope-google-oauth-by-service').up(qi, D);
  await qi.createTable('ClinicWebAssets', { id: { type: D.INTEGER, primaryKey: true } });
  await require('../../../migrations/20260913030000-add-search-console-broker-read-binding').up(qi, D);
  await require('../../../migrations/20260913050000-scope-search-console-bindings-by-mapping').up(qi, D);
  await qi.createTable('ClinicAnalyticsProperties', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true }, clinicaId: D.INTEGER,
    googleConnectionId: D.INTEGER, propertyName: D.STRING(128), propertyDisplayName: D.STRING(256), propertyType: D.STRING(32),
    parent: D.STRING(128), measurementId: D.STRING(128), isActive: { type: D.BOOLEAN, defaultValue: true }, created_at: D.DATE, updated_at: D.DATE });
  const migration = require('../../../migrations/20260913040000-add-analytics-broker-read-binding');
  await migration.up(qi, D); await migration.down(qi, D); await migration.up(qi, D);
  for (const [name, file] of [['ClinicAnalyticsProperty', 'clinicanalyticsproperty'], ['AnalyticsBrokerBinding', 'analyticsbrokerbinding'],
    ['SearchConsoleBrokerBinding', 'searchconsolebrokerbinding'], ['GoogleOAuthBrokerBinding', 'googleoauthbrokerbinding']]) models[name] = require('../../../models/' + file)(sql, D);
  report.checks.push('Actual GA migration applies, rolls back while empty and reapplies on owned MySQL');
  const G = models.GoogleConnection; const M = models.ClinicAnalyticsProperty; const B = models.AnalyticsBrokerBinding;
  await require('../../../migrations/20260913060000-create-google-property-broker-revocations').up(qi, D);
  models.GooglePropertyBrokerRevocation = require('../../../models/googlepropertybrokerrevocation')(sql, D);
  const subject = 'fictitious-ga-subject'; const connection = (id, googleUserId = subject) => G.create({ id, googleUserId, accessToken: null, refreshToken: null });
  await connection(81);
  const mapping = (await M.create({ id: 91, clinicaId: 71, googleConnectionId: 81, propertyName: 'properties/123',
    broker_read_connection_ref: 'connection:ga-qa', broker_read_asset_ref: 'ga4:123' })).get({ plain: true });
  await assert.rejects(M.create({ id: 999, clinicaId: 71, googleConnectionId: 81, propertyName: 'properties/999', broker_read_connection_ref: 'partial' }));
  report.checks.push('Paired GA references reject a partial marker');
  const binding = { property_name: 'properties/123', mapping_id: 91, connection_ref: 'connection:ga-qa', asset_ref: 'ga4:123',
    clinica_id: 71, google_connection_id: 81, google_user_id: subject, state: 'active' };
  await B.create(binding); await assert.rejects(migration.down(qi, D));
  let tokenReads = 0; let allowLegacyQuery = false;
  G.addHook('beforeFind', 'token_boundary', options => {
    if (!options.attributes || options.attributes.includes('accessToken') || options.attributes.includes('refreshToken')) {
      tokenReads++; assert(allowLegacyQuery, 'Managed GA must not select Google credentials');
    }
  });
  const { createAnalyticsBroker, createAnalyticsRepository } = require('../../services/analyticsBroker.service');
  const calls = []; let enabled = true; let afterCall;
  const create = () => createAnalyticsBroker({ ...createAnalyticsRepository(() => models), enabled: () => enabled,
    client: { execute: async command => { calls.push(command); await afterCall?.();
      if (command.operation === 'google.analytics.discovery.read.v1') return { data: { name: 'properties/123', displayName: 'Fictitious SQL property',
        account: 'accounts/456', parent: 'accounts/456', propertyType: 'PROPERTY_TYPE_ORDINARY' } };
      return { data: { ...analyticsReport('daily', { start: command.payload.startDate }), nextPageToken: null, rowLimitReached: false } }; } } });
  const service = create(); const context = await service.prepare(mapping); assert.deepEqual(context, {});
  const range = { startDate: '2026-09-01', endDate: '2026-09-02' };
  assert.equal((await service.read(mapping, context, 'daily', range)).rows[0].metricValues[0].value, '3'); assert.equal(tokenReads, 0);
  report.checks.push('Actual models and repository read only binding metadata and the SQL NULL-credential boolean');
  const { createGooglePropertyDiscovery, createDiscoveryRepository } = require('../../services/googlePropertyDiscovery.service');
  const discovery = createGooglePropertyDiscovery({ ...createDiscoveryRepository(() => models), readers: { analytics: service },
    enabled: () => enabled, hasManaged: async () => !!await B.findOne({ attributes: ['mapping_id'], raw: true }) });
  const inventory = { kind: 'analytics', clinicIds: [71], connectionId: 81, revalidate: async () => {} };
  assert.equal((await discovery.list(inventory))[0].name, 'properties/123'); assert.equal(tokenReads, 0);
  await assert.rejects(discovery.list({ ...inventory, clinicIds: [999] }), { code: 'broker_discovery_scope_unconfigured' });
  report.checks.push('Actual discovery repository filters registered clinic/connection metadata without credential columns or fallback');
  afterCall = () => M.update({ isActive: false }, { where: { id: 91 } });
  await assert.rejects(discovery.list(inventory), { code: 'broker_binding_invalid' }); afterCall = null;
  await M.update({ isActive: true }, { where: { id: 91 } });
  report.checks.push('A real SQL deactivation during property discovery prevents the response');
  await require('./fixtures/google_shared_property_mysql.fixture').verifySharedPropertyScope({ sql, models, report, kind: 'analytics',
    service, mapping, connectionId: 81, setAfterCall: fn => { afterCall = fn; } });
  await G.update({ accessToken: 'FICTITIOUS_SQL_TOKEN', refreshToken: 'FICTITIOUS_SQL_REFRESH' }, { where: { id: 81 } });
  await assert.rejects(service.prepare(mapping), { code: 'broker_binding_invalid' }); assert.equal(tokenReads, 0);
  await G.update({ accessToken: null, refreshToken: null }, { where: { id: 81 } });
  report.checks.push('Non-NULL SQL credentials prevent admission without hydrating their values');
  const shared = (await M.create({ ...mapping, id: 191, clinicaId: 72 })).get({ plain: true });
  await B.create({ ...binding, mapping_id: 191, clinica_id: 72 });
  const beforeDiscovery = calls.length;
  assert.equal((await discovery.list({ ...inventory, clinicIds: [71, 72] })).length, 1);
  assert.deepEqual(calls.slice(beforeDiscovery).map(row => row.tenantRef), ['clinic:71', 'clinic:72']); assert.equal(tokenReads, 0);
  report.checks.push('Real multi-clinic GA discovery verifies both independent grants and deduplicates the public property');
  const sharedContext = await service.prepare(shared); await service.read(shared, sharedContext, 'daily', range);
  assert.equal(calls.at(-1).tenantRef, 'clinic:72');
  await B.update({ state: 'blocked' }, { where: { property_name: binding.property_name, mapping_id: 191 } });
  await assert.rejects(service.prepare(shared), { code: 'broker_binding_invalid' });
  await service.read(mapping, context, 'daily', range); assert.equal(calls.at(-1).tenantRef, 'clinic:71');
  report.checks.push('The same GA property supports separately registered clinic mappings without inheriting or sharing their blocked state');
  await connection(82); await assert.rejects(service.prepare(mapping), { code: 'broker_binding_invalid' });
  const legacy = require('../../services/googleLegacyCredentials.service').createGoogleLegacyCredentials({ enrollmentScopeModel: models.GoogleAdsEnrollmentScope, enrollmentRequestModel: models.GoogleAdsEnrollmentRequest, connectionModel: G, adsModel: models.GoogleAdsBrokerBinding, adsRevocationModel: models.GoogleAdsBrokerRevocation,
    bindingModel: models.GoogleOAuthBrokerBinding, searchConsoleModel: models.SearchConsoleBrokerBinding, analyticsModel: B, propertyRevocationModel: models.GooglePropertyBrokerRevocation });
  for (const id of [81, 82]) await assert.rejects(legacy.load(id), { code: 'google_oauth_legacy_closed' });
  const oauth = require('../../services/googleOAuthBroker.service').createGoogleOAuthBroker({ models, sessions: {}, client: {}, audit: {}, enabled: () => false });
  await assert.rejects(oauth.assertLegacyAllowed(), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(oauth.assertLegacyConnection({ id: 82, googleUserId: subject }), { code: 'google_oauth_legacy_closed' });
  assert.equal(tokenReads, 0); await G.destroy({ where: { id: 82 } });
  report.checks.push('A GA marker alone blocks duplicate subjects, legacy Google credential loads and global OAuth while disabled');
  enabled = false; await assert.rejects(create().prepare(mapping), { code: 'broker_cohort_disabled' }); enabled = true;
  await B.update({ state: 'blocked' }, { where: { property_name: binding.property_name, mapping_id: 91 } });
  await assert.rejects(create().prepare(mapping), { code: 'broker_binding_invalid' }); await assert.rejects(migration.down(qi, D));
  await B.update({ state: 'active' }, { where: { property_name: binding.property_name, mapping_id: 91 } });
  report.checks.push('Disabled gates and durable blocks survive new service instances and prohibit a destructive down');
  afterCall = () => B.update({ state: 'blocked' }, { where: { property_name: binding.property_name, mapping_id: 91 } });
  await assert.rejects(service.read(mapping, context, 'daily', range), { code: 'broker_binding_invalid' }); afterCall = null;
  await B.update({ state: 'active' }, { where: { property_name: binding.property_name, mapping_id: 91 } });
  report.checks.push('SQL blocking during a broker read discards the returned metrics');
  for (const patch of [{ clinicaId: 72 }, { googleConnectionId: 82 }, { propertyName: 'properties/999' },
    { broker_read_connection_ref: null, broker_read_asset_ref: null }]) {
    await M.update(patch, { where: { id: 91 } }); await assert.rejects(create().prepare(mapping));
    await M.update({ clinicaId: 71, googleConnectionId: 81, propertyName: 'properties/123',
      broker_read_connection_ref: binding.connection_ref, broker_read_asset_ref: binding.asset_ref }, { where: { id: 91 } });
  }
  report.checks.push('Changing owner, connection, property or references cannot redirect a captured context');
  const raceBinding = (id, label) => ({ ...binding, property_name: 'properties/' + id, mapping_id: id + 10, google_connection_id: id,
    google_user_id: label, asset_ref: 'ga4:' + id, connection_ref: 'connection:' + label, state: 'blocked' });
  await connection(83, 'fictitious-race-select'); allowLegacyQuery = true; let pending = true;
  G.addHook('beforeFind', 'register_before_select', async options => {
    if (pending && options.attributes?.includes('accessToken')) { pending = false; await B.create(raceBinding(83, 'fictitious-race-select')); }
  });
  await assert.rejects(legacy.load(83), { code: 'google_oauth_legacy_closed' }); G.removeHook('beforeFind', 'register_before_select');
  report.checks.push('NOT EXISTS in the actual credential SELECT excludes a GA marker inserted after metadata checks');
  await connection(84, 'fictitious-race-update'); const old = await legacy.load(84);
  G.addHook('beforeBulkUpdate', 'register_before_update', async () => { await B.create(raceBinding(84, 'fictitious-race-update')); });
  await assert.rejects(legacy.saveRefresh(old, { accessToken: 'FICTITIOUS_NEW', expiresAt: new Date('2099-01-01') }), { code: 'google_oauth_legacy_closed' });
  G.removeHook('beforeBulkUpdate', 'register_before_update');
  const [unchanged] = await sql.query('SELECT (accessToken IS NULL) AS unchanged FROM GoogleConnections WHERE id=84'); assert.equal(unchanged[0].unchanged, 1);
  report.checks.push('Conditional UPDATE refuses a concurrent GA marker without persisting the refreshed token');
  await M.destroy({ where: { id: 91 } }); await G.destroy({ where: { id: 81 } }); await connection(81); await connection(85);
  await M.create({ ...mapping, id: 92, googleConnectionId: 85, broker_read_connection_ref: null, broker_read_asset_ref: null });
  await assert.rejects(create().prepare({ ...mapping, id: 92, googleConnectionId: 85 }), { code: 'broker_binding_invalid' });
  for (const id of [81, 85]) await assert.rejects(legacy.load(id), { code: 'google_oauth_legacy_closed' });
  assert.equal(await B.count({ where: { property_name: binding.property_name } }), 2);
  report.checks.push('Independent property/identity markers survive deletion, recreation and alternate SQL IDs');
  await qi.renameTable('AnalyticsBrokerBindings', 'OfflineHiddenAnalyticsBindings');
  await assert.rejects(legacy.load(85), { code: 'google_credentials_unavailable' });
  await assert.rejects(create().prepare({ ...mapping, id: 92, googleConnectionId: 85 }), { code: 'analytics_read_failed' });
  await qi.renameTable('OfflineHiddenAnalyticsBindings', 'AnalyticsBrokerBindings');
  report.checks.push('Missing GA schema fails closed for both managed and legacy consumers');
}).catch(() => { process.exitCode = 1; });

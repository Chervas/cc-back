'use strict';
const assert = require('node:assert/strict'); const { DataTypes: D, literal } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  models.GoogleAdsBrokerBinding = require('../../../models/googleadsbrokerbinding')(sql, D);
  await models.GoogleAdsBrokerBinding.sync();
  models.GoogleAdsBrokerRevocation = require('../../../models/googleadsbrokerrevocation')(sql, D);
  await models.GoogleAdsBrokerRevocation.sync();
  const qi = sql.getQueryInterface(); await qi.createTable('Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true } });
  models.GoogleConnection = require('../../../models/googleconnection')(sql, D); await models.GoogleConnection.sync();
  await require('../../../migrations/20260913020000-create-google-oauth-broker-flows').up(qi, D);
  await require('../../../migrations/20260913070000-scope-google-oauth-by-service').up(qi, D);
  await qi.createTable('ClinicWebAssets', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true }, clinicaId: D.INTEGER, googleConnectionId: D.INTEGER,
    siteUrl: D.STRING(512), propertyType: D.STRING(32), permissionLevel: D.STRING(64), verified: { type: D.BOOLEAN, defaultValue: true },
    isActive: { type: D.BOOLEAN, defaultValue: true }, created_at: D.DATE, updated_at: D.DATE });
  const migration = require('../../../migrations/20260913030000-add-search-console-broker-read-binding');
  await migration.up(qi, D); await migration.down(qi, D); await migration.up(qi, D);
  const composite = require('../../../migrations/20260913050000-scope-search-console-bindings-by-mapping');
  await composite.up(qi, D); await composite.down(qi, D);
  for (const [name, file] of [['ClinicWebAsset', 'clinicwebasset'], ['SearchConsoleBrokerBinding', 'searchconsolebrokerbinding'],
    ['GoogleOAuthBrokerBinding', 'googleoauthbrokerbinding'], ['GoogleOAuthBrokerRequest', 'googleoauthbrokerrequest']]) models[name] = require('../../../models/' + file)(sql, D);
  report.checks.push('Actual additive migration applies, rolls back while empty and reapplies on isolated MySQL');
  const G = models.GoogleConnection; const M = models.ClinicWebAsset; const B = models.SearchConsoleBrokerBinding;
  await qi.createTable('ClinicAnalyticsProperties', { id: { type: D.INTEGER, primaryKey: true } });
  await require('../../../migrations/20260913040000-add-analytics-broker-read-binding').up(qi, D);
  models.AnalyticsBrokerBinding = require('../../../models/analyticsbrokerbinding')(sql, D);
  await require('../../../migrations/20260913060000-create-google-property-broker-revocations').up(qi, D);
  models.GooglePropertyBrokerRevocation = require('../../../models/googlepropertybrokerrevocation')(sql, D);
  const { site } = require('../../../services/integrations-broker/src/google-search-console-contract');
  const resource = site('sc-domain:example.invalid'); const subject = 'fictitious-subject';
  const connection = (id, googleUserId = subject) => G.create({ id, googleUserId, accessToken: null, refreshToken: null });
  await connection(81);
  const mapping = (await M.create({ id: 91, clinicaId: 71, googleConnectionId: 81, siteUrl: resource.siteUrl,
    broker_read_connection_ref: 'connection:sc-qa', broker_read_asset_ref: resource.assetRef })).get({ plain: true });
  await assert.rejects(M.create({ id: 999, clinicaId: 71, googleConnectionId: 81, siteUrl: 'sc-domain:invalid.invalid', broker_read_connection_ref: 'partial' }));
  report.checks.push('The paired mapping reference constraint rejects a partial marker');
  const binding = { site_hash: resource.siteHash, site_url: resource.siteUrl, mapping_id: 91, connection_ref: 'connection:sc-qa', asset_ref: resource.assetRef,
    clinica_id: 71, google_connection_id: 81, google_user_id: subject, state: 'active' };
  await B.create(binding); await composite.up(qi, D);
  assert.deepEqual(await B.findOne({ where: { site_hash: resource.siteHash, mapping_id: 91 }, raw: true }), binding);
  await assert.rejects(composite.down(qi, D)); await assert.rejects(migration.down(qi, D));
  report.checks.push('Composite SC migration rolls back while empty, preserves populated boundary rows and refuses a managed down');
  let allowTokens = false; let fullReads = 0;
  G.addHook('beforeFind', 'credential_boundary', options => {
    if (options.attributes?.includes('accessToken') || options.attributes?.includes('refreshToken') || !options.attributes) {
      fullReads++; assert(allowTokens, 'Managed SC must select only metadata and the NULL-credential boolean');
    }
  });
  const { createSearchConsoleBroker, createSearchConsoleRepository } = require('../../services/searchConsoleBroker.service');
  const calls = []; let afterCall; let enabled = true;
  const create = () => createSearchConsoleBroker({ ...createSearchConsoleRepository(() => models), enabled: () => enabled,
    client: { execute: async command => { calls.push(command); await afterCall?.();
      if (command.operation === 'google.search_console.discovery.read.v1') return { data: { siteUrl: resource.siteUrl, permissionLevel: 'siteOwner' } };
      return { data: { rows: [{ keys: [command.payload.startDate], clicks: 3, impressions: 6, ctr: 0.5, position: 1 }] } }; } } });
  const service = create(); const context = await service.prepare(mapping); assert.deepEqual(context, {});
  assert.equal((await service.read(mapping, context, 'timeseries', { startDate: '2026-09-01', endDate: '2026-09-02' })).data.rows[0].clicks, 3);
  assert.equal(fullReads, 0); report.checks.push('Actual repository/model queries prepare and read an external credential binding with no token columns hydrated');
  const { createGooglePropertyDiscovery, createDiscoveryRepository } = require('../../services/googlePropertyDiscovery.service');
  const discovery = createGooglePropertyDiscovery({ ...createDiscoveryRepository(() => models), readers: { search_console: service },
    enabled: () => enabled, hasManaged: async () => !!await B.findOne({ attributes: ['mapping_id'], raw: true }) });
  const inventory = { kind: 'search_console', clinicIds: [71], connectionId: 81, revalidate: async () => {} };
  assert.equal((await discovery.list(inventory))[0].siteUrl, resource.siteUrl); assert.equal(fullReads, 0);
  await assert.rejects(discovery.list({ ...inventory, clinicIds: [999] }), { code: 'broker_discovery_scope_unconfigured' });
  report.checks.push('SC discovery uses actual SQL clinic/connection filters and metadata without legacy hydration');
  afterCall = () => M.update({ isActive: false }, { where: { id: 91 } });
  await assert.rejects(discovery.list(inventory), { code: 'broker_binding_invalid' }); afterCall = null;
  await M.update({ isActive: true }, { where: { id: 91 } });
  report.checks.push('SC discovery drops its full response after a real concurrent mapping deactivation');
  await require('./fixtures/google_shared_property_mysql.fixture').verifySharedPropertyScope({ sql, models, report, kind: 'search_console',
    service, mapping, connectionId: 81, setAfterCall: fn => { afterCall = fn; } });
  const shared = (await M.create({ ...mapping, id: 191, clinicaId: 72 })).get({ plain: true });
  await B.create({ ...binding, mapping_id: 191, clinica_id: 72 });
  const sharedContext = await service.prepare(shared);
  await service.read(shared, sharedContext, 'timeseries', { startDate: '2026-09-01', endDate: '2026-09-02' });
  assert.equal(calls.at(-1).tenantRef, 'clinic:72');
  await B.update({ state: 'blocked' }, { where: { site_hash: resource.siteHash, mapping_id: 191 } });
  await assert.rejects(service.prepare(shared), { code: 'broker_binding_invalid' }); await service.prepare(mapping);
  report.checks.push('Real SC composite registry admits two clinic mappings and blocks them independently');
  await G.update({ accessToken: 'FICTITIOUS_SQL_TOKEN', refreshToken: 'FICTITIOUS_SQL_REFRESH' }, { where: { id: 81 } });
  await assert.rejects(service.prepare(mapping), { code: 'broker_binding_invalid' }); assert.equal(fullReads, 0);
  await G.update({ accessToken: null, refreshToken: null }, { where: { id: 81 } });
  report.checks.push('Non-NULL SQL credentials exclude admission without selecting their values');
  await connection(82); await assert.rejects(service.prepare(mapping), { code: 'broker_binding_invalid' });
  const { createGoogleLegacyCredentials } = require('../../services/googleLegacyCredentials.service');
  const legacy = createGoogleLegacyCredentials({ connectionModel: G, adsModel: models.GoogleAdsBrokerBinding, adsRevocationModel: models.GoogleAdsBrokerRevocation, bindingModel: models.GoogleOAuthBrokerBinding, searchConsoleModel: B,
    analyticsModel: models.AnalyticsBrokerBinding, propertyRevocationModel: models.GooglePropertyBrokerRevocation });
  for (const id of [81, 82]) await assert.rejects(legacy.load(id), { code: 'google_oauth_legacy_closed' });
  const oauth = require('../../services/googleOAuthBroker.service').createGoogleOAuthBroker({ models, sessions: {}, client: {}, audit: {}, enabled: () => false });
  await assert.rejects(oauth.assertLegacyAllowed(), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(oauth.assertLegacyConnection({ id: 82, googleUserId: subject }), { code: 'google_oauth_legacy_closed' });
  assert.equal(fullReads, 0); await G.destroy({ where: { id: 82 } });
  report.checks.push('Duplicate subjects cannot be admitted; an SC marker alone closes legacy Google loads and global OAuth, even with OAuth disabled');
  enabled = false; await assert.rejects(create().prepare(mapping), { code: 'broker_cohort_disabled' }); enabled = true;
  await B.update({ state: 'blocked' }, { where: { site_hash: resource.siteHash } });
  await assert.rejects(create().prepare(mapping), { code: 'broker_binding_invalid' });
  await assert.rejects(migration.down(qi, D)); await B.update({ state: 'active' }, { where: { site_hash: resource.siteHash } });
  report.checks.push('Disabled gates and durable blocked state survive a new service instance and cannot be rolled back by dropping the markers');
  afterCall = () => B.update({ state: 'blocked' }, { where: { site_hash: resource.siteHash } });
  await assert.rejects(service.read(mapping, context, 'timeseries', { startDate: '2026-09-01', endDate: '2026-09-02' }), { code: 'broker_binding_invalid' });
  afterCall = null; await B.update({ state: 'active' }, { where: { site_hash: resource.siteHash } });
  report.checks.push('A concurrent SQL block discards an in-flight broker response');
  for (const patch of [{ clinicaId: 72 }, { googleConnectionId: 82 }, { broker_read_connection_ref: null, broker_read_asset_ref: null }]) {
    await M.update(patch, { where: { id: 91 } }); await assert.rejects(create().prepare(mapping));
    await M.update({ clinicaId: 71, googleConnectionId: 81, broker_read_connection_ref: binding.connection_ref, broker_read_asset_ref: binding.asset_ref }, { where: { id: 91 } });
  }
  report.checks.push('Clinic, Google connection and mapping-reference changes cannot redirect a captured binding');
  const raceBinding = (id, mappingId, label) => { const r = site('sc-domain:' + label + '.invalid'); return { ...binding, site_hash: r.siteHash, site_url: r.siteUrl,
    mapping_id: mappingId, google_connection_id: id, google_user_id: label, asset_ref: r.assetRef, connection_ref: 'connection:' + label, state: 'blocked' }; };
  await connection(83, 'race-select'); let selectHook = true; allowTokens = true;
  G.addHook('beforeFind', 'insert_sc_before_select', async options => {
    if (selectHook && options.attributes?.includes('accessToken')) { selectHook = false; await B.create(raceBinding(83, 93, 'race-select')); }
  });
  await assert.rejects(legacy.load(83), { code: 'google_oauth_legacy_closed' }); G.removeHook('beforeFind', 'insert_sc_before_select');
  report.checks.push('Conditional credential SELECT excludes a newly committed SC marker after its metadata checks');
  await connection(84, 'race-update'); await G.update({ accessToken: 'FICTITIOUS_ORIGINAL_84' }, { where: { id: 84 } }); const cached = await legacy.load(84);
  G.addHook('beforeBulkUpdate', 'insert_sc_before_update', async () => { await B.create(raceBinding(84, 94, 'race-update')); });
  await assert.rejects(legacy.saveRefresh(cached, { accessToken: 'FICTITIOUS_MUST_NOT_WRITE', expiresAt: new Date('2099-01-01') }), { code: 'google_oauth_legacy_closed' });
  G.removeHook('beforeBulkUpdate', 'insert_sc_before_update'); allowTokens = false;
  const unchanged = await G.findByPk(84, { attributes: [[literal("accessToken = 'FICTITIOUS_ORIGINAL_84'"), 'untouched']], raw: true }); assert.equal(unchanged.untouched, 1);
  report.checks.push('Conditional refresh UPDATE refuses a new SC marker at execution without persisting the response');
  await M.destroy({ where: { id: 91 } }); const recreated = (await M.create({ id: 95, clinicaId: 71, googleConnectionId: 81, siteUrl: resource.siteUrl })).get({ plain: true });
  await assert.rejects(create().prepare(recreated), { code: 'broker_binding_invalid' }); await assert.rejects(legacy.load(81), { code: 'google_oauth_legacy_closed' });
  await G.destroy({ where: { id: 81 } }); await connection(81, 'recreated-subject'); await connection(85, subject);
  for (const id of [81, 85]) await assert.rejects(legacy.load(id), { code: 'google_oauth_legacy_closed' });
  assert.equal(await B.count({ where: { site_hash: resource.siteHash } }), 2);
  report.checks.push('Independent property/identity markers survive mapping and connection deletion/recreation and close alternate SQL IDs');
  await qi.renameTable('SearchConsoleBrokerBindings', 'OfflineHiddenSearchConsoleBindings');
  await assert.rejects(legacy.load(85), { code: 'google_credentials_unavailable' });
  await qi.renameTable('OfflineHiddenSearchConsoleBindings', 'SearchConsoleBrokerBindings');
  report.checks.push('A missing SC schema fails closed instead of restoring the legacy source');
}).catch(() => { process.exitCode = 1; });

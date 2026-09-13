'use strict';
const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto'); const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const qi = sql.getQueryInterface();
  await qi.createTable('Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true } });
  models.GoogleConnection = require('../../../models/googleconnection')(sql, D); await models.GoogleConnection.sync();
  await require('../../../migrations/20260913020000-create-google-oauth-broker-flows').up(qi, D);
  await require('../../../migrations/20260913070000-scope-google-oauth-by-service').up(qi, D);
  models.GoogleOAuthBrokerBinding = require('../../../models/googleoauthbrokerbinding')(sql, D);
  models.Clinica = require('../../../models/clinica')(sql, D); await models.Clinica.sync();
  models.GrupoClinica = require('../../../models/grupoclinica')(sql, D);
  const groups = { id_grupo: { type: D.INTEGER, primaryKey: true } };
  for (const k of ['search_console_assignment_mode', 'analytics_assignment_mode', 'business_profile_assignment_mode']) groups[k] = D.STRING(32);
  for (const k of ['search_console_primary_asset_id', 'analytics_primary_property_id', 'business_profile_primary_location_id']) groups[k] = D.INTEGER;
  await qi.createTable('GruposClinicas', groups);
  for (const [name, file] of [['GroupAssetClinicAssignment', 'groupassetclinicassignment'], ['GoogleConnectionAssignment', 'googleconnectionassignment']]) {
    models[name] = require('../../../models/' + file)(sql, D); await models[name].sync();
  }
  for (const [name, file] of [['ClinicWebAsset', 'clinicwebasset'], ['ClinicAnalyticsProperty', 'clinicanalyticsproperty']]) {
    const base = require('../../../models/' + file)(sql, D);
    base.removeAttribute('broker_read_connection_ref'); base.removeAttribute('broker_read_asset_ref'); await base.sync();
    models[name] = require('../../../models/' + file)(sql, D);
  }
  await require('../../../migrations/20260913030000-add-search-console-broker-read-binding').up(qi, D);
  await require('../../../migrations/20260913040000-add-analytics-broker-read-binding').up(qi, D);
  await require('../../../migrations/20260913050000-scope-search-console-bindings-by-mapping').up(qi, D);
  await require('../../../migrations/20260912210000-create-platform-audit-events').up(qi, D);
  await require('../../../migrations/20260913003000-add-platform-audit-result-part').up(qi, D);
  const migration = require('../../../migrations/20260913060000-create-google-property-broker-revocations');
  await migration.up(qi); await migration.down(qi); await migration.up(qi);
  for (const [name, file] of [['SearchConsoleBrokerBinding', 'searchconsolebrokerbinding'], ['AnalyticsBrokerBinding', 'analyticsbrokerbinding'],
    ['GooglePropertyBrokerRevocation', 'googlepropertybrokerrevocation'], ['PlatformAuditEvent', 'platformauditevent']]) models[name] = require('../../../models/' + file)(sql, D);
  const R = models.GooglePropertyBrokerRevocation; const A = models.PlatformAuditEvent; const G = models.GoogleConnection;
  const empty = { findAll: async () => [] };
  models.ClinicBusinessLocation = models.ClinicGoogleAdsAccount = models.BusinessProfileBrokerBinding = models.BusinessProfileBrokerRevocation = empty;
  await models.Clinica.bulkCreate([{ id_clinica: 71, grupoClinicaId: 9 }, { id_clinica: 72, grupoClinicaId: 9 }, { id_clinica: 73, grupoClinicaId: 10 }]);
  await qi.bulkInsert('GruposClinicas', [9, 10].map(id_grupo => ({ id_grupo, search_console_assignment_mode: 'clinic', analytics_assignment_mode: 'clinic' })));
  await G.create({ id: 81, googleUserId: 'fictitious-subject', accessToken: null, refreshToken: null });
  await models.GoogleConnectionAssignment.create({ scopeKey: 'group:9', assignmentScope: 'group', grupoClinicaId: 9, googleConnectionId: 81 });
  const { KINDS } = require('../../services/googlePropertyRevocation.contract');
  const { revocationFor } = require('./fixtures/google_property_revocation.fixture');
  const { unpack } = require('../../../services/platform-audit/src/event'); const service = require('../../services/googlePropertyRevocation.service');
  const { deactivateGoogleMappingsForScope: disconnect } = require('../../services/oauthScopedDisconnect.service');
  const own = {}; const foreign = {}; const readers = {}; const contexts = {}; const calls = []; let afterRead;
  for (const [kind, spec] of Object.entries(KINDS)) {
    const resource = kind === 'search_console' ? spec.contract.site('sc-domain:example.invalid') : spec.contract.property('properties/123');
    const make = async (id, clinic) => {
      const m = await models[spec.mappingModel].create({ id, clinicaId: clinic, googleConnectionId: 81,
        [spec.mappingResourceField]: kind === 'search_console' ? resource.siteUrl : resource.propertyName,
        broker_read_connection_ref: 'connection:' + kind, broker_read_asset_ref: resource.assetRef });
      await models[spec.model].create({ mapping_id: id, clinica_id: clinic, google_connection_id: 81, google_user_id: 'fictitious-subject',
        [spec.resourceField]: m[spec.mappingResourceField], ...(kind === 'search_console' ? { site_hash: resource.siteHash } : {}),
        connection_ref: m.broker_read_connection_ref, asset_ref: resource.assetRef, state: 'active' }); return m;
    };
    own[kind] = await make(kind === 'search_console' ? 91 : 101, 71); foreign[kind] = await make(kind === 'search_console' ? 92 : 102, 72);
    const adapter = require(kind === 'search_console' ? '../../services/searchConsoleBroker.service' : '../../services/analyticsBroker.service');
    const factory = kind === 'search_console' ? adapter.createSearchConsoleBroker : adapter.createAnalyticsBroker;
    const repository = kind === 'search_console' ? adapter.createSearchConsoleRepository : adapter.createAnalyticsRepository;
    readers[kind] = factory({ ...repository(() => models), enabled: () => true, client: { execute: async command => {
      calls.push(command); await afterRead?.(kind);
      return { data: kind === 'search_console' ? { siteUrl: resource.siteUrl, permissionLevel: 'siteOwner' }
        : { name: resource.propertyName, account: 'accounts/456', parent: 'accounts/456', displayName: 'Fictitious SQL property', propertyType: 'PROPERTY_TYPE_ORDINARY' } };
    } } });
    contexts[kind] = await readers[kind].prepare(own[kind].get({ plain: true }));
  }
  const orphan = (await models.SearchConsoleBrokerBinding.findOne({ where: { mapping_id: 91 }, raw: true }));
  await models.SearchConsoleBrokerBinding.create({ ...orphan, mapping_id: 991 });
  const scope71 = { assignmentScope: 'clinic', clinicId: 71, groupId: 9 }; const group9 = { assignmentScope: 'group', groupId: 9 };
  const perform = (scope = scope71, extras = {}) => sql.transaction(async transaction => {
    const result = await disconnect({ scope, connectionId: 81, models, actorId: 501, sessionRef: randomUUID(), ...extras, transaction });
    await models.GoogleConnectionAssignment.upsert({ scopeKey: scope.assignmentScope === 'clinic' ? 'clinic:' + scope.clinicId : 'group:' + scope.groupId,
      assignmentScope: scope.assignmentScope, clinicaId: scope.clinicId || null, grupoClinicaId: scope.groupId, googleConnectionId: 81, status: 'disconnected' }, { transaction });
    return result;
  });
  const unchanged = async () => { assert.equal(await R.count(), 0); assert.equal(await A.count(), 0);
    for (const m of Object.values(own)) assert.equal((await m.reload()).isActive, true);
    assert.equal(await models.SearchConsoleBrokerBinding.count({ where: { state: 'blocked' } }), 0);
    assert.equal((await models.GoogleConnectionAssignment.findOne({ where: { scopeKey: 'group:9' } })).status, 'active'); };
  const missing = await models.AnalyticsBrokerBinding.findOne({ where: { mapping_id: 101 }, raw: true });
  await models.AnalyticsBrokerBinding.destroy({ where: { mapping_id: 101 } }); process.env.GOOGLE_PROPERTY_REVOCATION_ENABLED = 'true';
  await assert.rejects(perform(), { code: 'google_property_revocation_unavailable' }); await unchanged();
  await models.AnalyticsBrokerBinding.create(missing);
  report.checks.push('An active managed mapping with a missing binding and no durable tombstone cannot be disconnected as legacy');
  process.env.GOOGLE_PROPERTY_REVOCATION_ENABLED = 'false'; await assert.rejects(perform(), { code: 'google_property_revocation_unavailable' }); await unchanged();
  process.env.GOOGLE_PROPERTY_REVOCATION_ENABLED = 'true'; await assert.rejects(perform(scope71, { actorId: null }), { code: 'google_property_revocation_unavailable' }); await unchanged();
  const failAudit = () => { throw Error('FICTITIOUS_AUDIT_FAILURE'); };
  A.addHook('beforeCreate', 'qaFailure', failAudit); await assert.rejects(perform(), { code: 'google_property_revocation_unavailable' }); A.removeHook('beforeCreate', 'qaFailure'); await unchanged();
  report.checks.push('Actual additive schema applies/down-empty/reapplies; disabled capture, missing actor and audit failure leave mappings, queue, registry and assignment unchanged');
  models.BusinessProfileBrokerBinding = { findAll: async () => [{ external_location_id: '456' }] };
  process.env.GOOGLE_BUSINESS_PROFILE_REVOCATION_ENABLED = 'false'; await assert.rejects(perform(), { code: 'gbp_revocation_unavailable' });
  models.BusinessProfileBrokerBinding = empty; await unchanged();
  report.checks.push('A later GBP capture failure rolls back the already inserted SC/GA intent, v9 audit and blocked bindings in the same SQL transaction');
  const shared = await models.GroupAssetClinicAssignment.create({ grupoClinicaId: 9, clinicaId: 72, assetType: 'google.search_console', assetId: 91 });
  await assert.rejects(perform(), { code: 'scope_disconnect_shared_asset_conflict' }); await unchanged(); await shared.destroy();
  await models.GrupoClinica.update({ search_console_assignment_mode: 'group', search_console_primary_asset_id: 91 }, { where: { id_grupo: 9 } });
  await assert.rejects(perform(), { code: 'scope_disconnect_shared_asset_conflict' }); await unchanged();
  await models.GrupoClinica.update({ search_console_assignment_mode: 'clinic', search_console_primary_asset_id: null }, { where: { id_grupo: 9 } });
  await models.GrupoClinica.update({ analytics_assignment_mode: 'group', analytics_primary_property_id: 101 }, { where: { id_grupo: 10 } });
  await assert.rejects(perform(group9), { code: 'scope_disconnect_shared_asset_conflict' }); await unchanged();
  await models.GrupoClinica.update({ analytics_assignment_mode: 'clinic', analytics_primary_property_id: null }, { where: { id_grupo: 10 } });
  report.checks.push('Explicit shared assignments and group primaries, including a foreign group primary, prevent any partial disconnect outside the authorized removal scope');
  await models.GoogleConnectionAssignment.create({ scopeKey: 'clinic:72', assignmentScope: 'clinic', clinicaId: 72, grupoClinicaId: 9, googleConnectionId: 81 });
  await models.GrupoClinica.update({ search_console_assignment_mode: 'group', search_console_primary_asset_id: 91 }, { where: { id_grupo: 9 } });
  await assert.rejects(perform(group9), { code: 'scope_disconnect_shared_asset_conflict' }); await unchanged();
  await models.GrupoClinica.update({ search_console_assignment_mode: 'clinic', search_console_primary_asset_id: null }, { where: { id_grupo: 9 } });
  const first = await perform(group9); assert.equal(first.brokerRevocationsPending, 2); assert.equal(first.web, 1); assert.equal(first.analytics, 1);
  assert.equal(await R.count(), 2); assert.equal(await A.count(), 2);
  for (const [kind, m] of Object.entries(own)) {
    assert.equal((await m.reload()).isActive, false); assert.equal((await foreign[kind].reload()).isActive, true);
    await assert.rejects(readers[kind].read(m.get({ plain: true }), contexts[kind], 'discovery', {}), { code: 'asset_revoked' });
  }
  assert.equal(await models.SearchConsoleBrokerBinding.count({ where: { clinica_id: 71, state: 'blocked' } }), 2);
  assert.equal((await models.GoogleConnectionAssignment.findOne({ where: { scopeKey: 'clinic:72' } })).status, 'active');
  report.checks.push('Group disconnect preserves clinic overrides and refuses a primary that would affect one; valid removal atomically blocks both cohorts and deduplicates an orphan mapping of the same broker tuple');
  const originals = await R.findAll({ raw: true }); await perform(group9, { actorId: 502 });
  assert.equal(await A.count(), 2); assert.deepEqual((await R.findAll({ raw: true })).map(r => r.request_id).sort(), originals.map(r => r.request_id).sort());
  for (const row of await A.findAll({ raw: true })) { const e = unpack(row).event; assert.equal(e.version, 9); assert.equal(e.actor.id, '501'); assert.equal(e.scope.id, '71'); }
  report.checks.push('Repeated disconnect preserves original user, correlation and pending tuple without duplicate events');
  const foreignMapping = foreign.analytics.get({ plain: true }); const foreignContext = await readers.analytics.prepare(foreignMapping);
  afterRead = () => perform({ assignmentScope: 'clinic', clinicId: 72, groupId: 9 });
  await assert.rejects(readers.analytics.read(foreignMapping, foreignContext, 'discovery', {}), { code: 'asset_revoked' }); afterRead = null;
  assert.equal(await R.count(), 4); assert.equal(await A.count(), 4); assert.equal(calls.length, 1);
  report.checks.push('A real SQL disconnect committed while the GA provider double waits withholds its response and leaves both cohort tuples locally blocked before delivery');
  const repository = service.createRevocationRepository(models); let clock = new Date(Date.now() + 1000);
  const claims = (await Promise.all(Array.from({ length: 6 }, () => repository.claim(clock)))).filter(Boolean);
  assert.equal(claims.length, 4); assert.equal(new Set(claims.map(r => r.tuple_hash)).size, 4);
  const oldest = await R.findOne({ order: [['requested_at', 'ASC'], ['tuple_hash', 'ASC']], raw: true });
  const stale = claims.find(r => r.tuple_hash === oldest.tuple_hash); clock = new Date(clock.getTime() + 121000);
  const reclaimed = await repository.claim(clock); assert.equal(reclaimed.tuple_hash, stale.tuple_hash); assert.equal(reclaimed.request_id, stale.request_id);
  assert.equal(await repository.confirm(stale, clock), false);
  A.addHook('beforeCreate', 'qaFailure', failAudit); await assert.rejects(repository.confirm(reclaimed, clock), /FICTITIOUS_AUDIT_FAILURE/); A.removeHook('beforeCreate', 'qaFailure');
  assert.equal((await R.findByPk(reclaimed.tuple_hash)).state, 'pending'); assert.equal(await A.count({ where: { stage: 'completed' } }), 0);
  assert.equal(await repository.confirm(reclaimed, clock), true); assert.equal(await repository.confirm(reclaimed, clock), false);
  report.checks.push('Concurrent SKIP LOCKED claims are exclusive; a stale lease cannot confirm; confirmed state and completed v9 event commit together exactly once');
  let lose = true; const remote = new Set(); const sent = [];
  const clients = Object.fromEntries(Object.keys(KINDS).map(kind => [kind, { execute: async command => {
    assert.equal(command.operation, KINDS[kind].contract.REVOKE_OPERATION); assert.deepEqual(command.payload, {});
    sent.push(command); remote.add(command.requestId);
    if (lose) { lose = false; throw Object.assign(Error('FICTITIOUS_LOST_ACK'), { code: 'broker_timeout' }); }
    return { requestId: command.requestId, data: { revoked: true } };
  } }]));
  const worker = () => service.createRevocationWorker({ repository: service.createRevocationRepository(models), clients, enabled: () => true, now: () => clock });
  const attempt = await worker().run(); assert.equal(attempt.failed, 1); assert.equal(attempt.confirmed, 2); assert.equal(attempt.pending, 1);
  clock = new Date(clock.getTime() + 10000); assert.equal((await worker().run()).confirmed, 1);
  assert.equal(sent.length, 4); assert.equal(remote.size, 3); assert.equal(sent[0].requestId, sent[3].requestId);
  assert.equal(await A.count(), 8); assert.equal(await R.count({ where: { state: 'confirmed' } }), 4);
  assert.deepEqual(await service.status([71, 72], models), { status: 'confirmed', pending_assets: 0, confirmed_assets: 4 });
  assert.deepEqual(await service.status([73], models), { status: 'none', pending_assets: 0, confirmed_assets: 0 });
  for (const row of await A.findAll({ where: { stage: 'completed' }, raw: true })) {
    const e = unpack(row).event; assert.equal(e.actor.type, 'job'); assert.equal(e.actor.id, 'google_property_revocation_worker'); assert.equal(e.subjectUserId, '501');
  }
  report.checks.push('Fresh workers retry a lost ACK with the same UUID, route to the correct cohort, confirm once and report only authorized metadata counts');
  await assert.rejects(migration.down(qi));
  await models.AnalyticsBrokerBinding.destroy({ where: { mapping_id: 101 } }); await own.analytics.update({ isActive: true });
  assert.equal((await perform()).brokerRevocationsPending, 0); assert.equal((await own.analytics.reload()).isActive, false);
  assert.equal(await A.count(), 8);
  report.checks.push('A confirmed original tombstone permits repeating a local unlink after its binding is deleted without reopening access or duplicating audit');
  for (const [kind, spec] of Object.entries(KINDS)) {
    await own[kind].destroy(); await models[spec.model].destroy({ where: {} });
    const recreated = await models[spec.mappingModel].create({ id: kind === 'search_console' ? 291 : 301, clinicaId: 71, googleConnectionId: 81,
      [spec.mappingResourceField]: own[kind][spec.mappingResourceField] });
    await assert.rejects(readers[kind].prepare(recreated.get({ plain: true })), { code: 'broker_binding_invalid' });
  }
  const legacy = () => require('../../services/googleLegacyCredentials.service').createGoogleLegacyCredentials({ connectionModel: G,
    bindingModel: models.GoogleOAuthBrokerBinding, searchConsoleModel: models.SearchConsoleBrokerBinding, analyticsModel: models.AnalyticsBrokerBinding, propertyRevocationModel: R });
  const oauth = require('../../services/googleOAuthBroker.service').createGoogleOAuthBroker({ models, audit: {}, enabled: () => false });
  await G.create({ id: 82, googleUserId: 'fictitious-subject', accessToken: 'FICTITIOUS_ACCESS', refreshToken: 'FICTITIOUS_REFRESH' });
  await G.destroy({ where: { id: 81 } }); await G.create({ id: 81, googleUserId: 'recreated-subject', accessToken: 'FICTITIOUS_ACCESS', refreshToken: 'FICTITIOUS_REFRESH' });
  for (const id of [81, 82]) await assert.rejects(legacy().load(id), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(oauth.assertLegacyAllowed(), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(oauth.assertLegacyConnection({ id: 82, googleUserId: 'fictitious-subject' }), { code: 'google_oauth_legacy_closed' });
  assert.equal(calls.length, 1); assert.equal(await R.count(), 4);
  report.checks.push('Revocations survive deleted bindings, mapping recreation and connection ID/subject replacement; they alone close legacy credentials and global OAuth, and populated down is refused');
  const addConnection = id => G.create({ id, googleUserId: 'fresh-subject-' + id, accessToken: 'FICTITIOUS_ACCESS_' + id, refreshToken: 'FICTITIOUS_REFRESH' });
  const addMarker = id => R.create(revocationFor('analytics', { id: 999, clinicaId: 73, googleConnectionId: id,
    propertyName: 'properties/' + id, broker_read_connection_ref: 'connection:fresh-' + id, broker_read_asset_ref: 'ga4:' + id }, 'fresh-subject-' + id));
  await addConnection(83); let once = true;
  G.addHook('beforeFind', 'markerBeforeSelect', async options => { if (once && options.attributes?.includes('accessToken')) { once = false; await addMarker(83); } });
  await assert.rejects(legacy().load(83), { code: 'google_oauth_legacy_closed' }); G.removeHook('beforeFind', 'markerBeforeSelect');
  await addConnection(84); const cached = await legacy().load(84);
  G.addHook('beforeBulkUpdate', 'markerBeforeRefresh', () => addMarker(84));
  await assert.rejects(legacy().saveRefresh(cached, { accessToken: 'FICTITIOUS_MUST_NOT_WRITE', expiresAt: new Date() }), { code: 'google_oauth_legacy_closed' });
  G.removeHook('beforeBulkUpdate', 'markerBeforeRefresh'); assert.equal((await G.findByPk(84)).accessToken, 'FICTITIOUS_ACCESS_84');
  await addConnection(85); const beforeRequest = await legacy().load(85);
  await assert.rejects(legacy().request(beforeRequest, async () => { await addMarker(85); return 'FICTITIOUS_RESPONSE'; }), { code: 'google_oauth_legacy_closed' });
  report.checks.push('The new table participates in actual NOT EXISTS SELECT/UPDATE guards and post-provider checks, so markers committed between metadata and SQL execution win');
  await addConnection(86); await qi.renameTable('GooglePropertyBrokerRevocations', 'OfflineHiddenPropertyRevocations');
  await assert.rejects(legacy().load(86), { code: 'google_credentials_unavailable' });
  await qi.renameTable('OfflineHiddenPropertyRevocations', 'GooglePropertyBrokerRevocations');
  report.checks.push('Missing new schema fails closed rather than hydrating legacy credentials');
}).catch(error => { console.error(error.message); process.exitCode = 1; });

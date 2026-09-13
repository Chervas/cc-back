'use strict';
const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto'); const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const qi = sql.getQueryInterface();
  await qi.createTable('Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true } });
  models.GoogleConnection = require('../../../models/googleconnection')(sql, D); await models.GoogleConnection.sync();
  const base = require('../../../models/clinicgoogleadsaccount')(sql, D);
  base.removeAttribute('broker_read_connection_ref'); base.removeAttribute('broker_read_asset_ref'); await base.sync();
  const migration = require('../../../migrations/20260913080000-add-google-ads-broker-bindings');
  await migration.up(qi); await migration.down(qi); await migration.up(qi);

  models.ClinicGoogleAdsAccount = require('../../../models/clinicgoogleadsaccount')(sql, D);
  for (const [name, file] of [['GoogleAdsBrokerBinding', 'googleadsbrokerbinding'], ['GoogleAdsBrokerRevocation', 'googleadsbrokerrevocation'], ['GoogleOAuthBrokerBinding', 'googleoauthbrokerbinding'],
    ['SearchConsoleBrokerBinding', 'searchconsolebrokerbinding'], ['AnalyticsBrokerBinding', 'analyticsbrokerbinding'],
    ['GooglePropertyBrokerRevocation', 'googlepropertybrokerrevocation'], ['GoogleConnectionAssignment', 'googleconnectionassignment']]) {
    models[name] = require('../../../models/' + file)(sql, D); await models[name].sync();
  }
  models.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER }, { tableName: 'Clinicas', timestamps: false });
  models.GroupAssetClinicAssignment = sql.define('GroupAssetClinicAssignment', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
    assetType: D.STRING(64), assetId: D.INTEGER, clinicaId: D.INTEGER }, { tableName: 'GroupAssetClinicAssignments', timestamps: false });
  await models.Clinica.sync(); await models.GroupAssetClinicAssignment.sync();
  await models.Clinica.bulkCreate([{ id_clinica: 59, grupoClinicaId: 5 }, { id_clinica: 71, grupoClinicaId: 5 }, { id_clinica: 99, grupoClinicaId: 6 }]);
  await qi.dropTable('GoogleAdsBrokerRevocations');
  const revocationMigration = require('../../../migrations/20260913090000-create-google-ads-broker-revocations');
  await revocationMigration.up(qi); await revocationMigration.down(qi); await revocationMigration.up(qi);
  await require('../../../migrations/20260912210000-create-platform-audit-events').up(qi, D);
  await require('../../../migrations/20260913003000-add-platform-audit-result-part').up(qi, D);
  models.PlatformAuditEvent = require('../../../models/platformauditevent')(sql, D);
  const empty = { findAll: async () => [] };
  models.ClinicWebAsset = models.ClinicAnalyticsProperty = models.ClinicBusinessLocation = models.BusinessProfileBrokerBinding = models.BusinessProfileBrokerRevocation = models.GrupoClinica = empty;
  const f = require('./fixtures/google_ads_broker_scope.fixture').scopeFixture();
  const G = models.GoogleConnection; const M = models.ClinicGoogleAdsAccount; const B = models.GoogleAdsBrokerBinding;
  const R = models.GoogleAdsBrokerRevocation; const A = models.PlatformAuditEvent;
  await G.create({ id: 2, googleUserId: f.binding.google_user_id, accessToken: null, refreshToken: null });
  await M.create(f.mapping); await B.create(f.binding);
  const alias = { ...f.mapping, id: 12, assignmentScope: 'clinic', clinicaId: 71, customerId: '123-456-7890' };
  await M.create(alias); await B.create({ ...f.binding, mapping_id: 12, scope_key: 'clinic:71' });
  await B.create({ ...f.binding, mapping_id: 991 });
  await models.GoogleConnectionAssignment.create({ ...f.state.grants[0], scopeKey: 'group:5' });
  const service = require('../../services/googleAdsRevocation.service');
  const { deactivateGoogleMappingsForScope: disconnect } = require('../../services/oauthScopedDisconnect.service');
  const group = { assignmentScope: 'group', groupId: 5 };
  const perform = (scope = group, extras = {}) => sql.transaction(async transaction => {
    const result = await disconnect({ models, transaction, scope, connectionId: 2, actorId: 501, sessionRef: randomUUID(), ...extras });
    await models.GoogleConnectionAssignment.upsert({ scopeKey: scope.assignmentScope === 'group' ? 'group:' + scope.groupId : 'clinic:' + scope.clinicId,
      assignmentScope: scope.assignmentScope, grupoClinicaId: scope.groupId, clinicaId: scope.clinicId || null, googleConnectionId: 2, status: 'disconnected' }, { transaction });
    return result;
  });
  const unchanged = async () => {
    assert.equal(await R.count(), 0); assert.equal(await A.count(), 0); assert.equal(await B.count({ where: { state: 'blocked' } }), 0);
    assert.equal(await M.count({ where: { isActive: true } }), 2);
    assert.equal((await models.GoogleConnectionAssignment.findOne({ where: { scopeKey: 'group:5' } })).status, 'active');
  };
  const [fk] = await sql.query("SELECT COUNT(*) AS n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='GoogleAdsBrokerRevocations'");
  assert.equal(Number(fk[0].n), 0);
  report.checks.push('Actual Ads revocation DDL applies, rolls back empty and reapplies without cascading foreign keys');
  process.env.GOOGLE_ADS_REVOCATION_ENABLED = 'false'; await assert.rejects(perform(), { code: 'google_ads_revocation_unavailable' }); await unchanged();
  process.env.GOOGLE_ADS_REVOCATION_ENABLED = 'true'; await assert.rejects(perform(group, { actorId: null }), { code: 'google_ads_revocation_unavailable' }); await unchanged();
  const failAudit = () => { throw Error('FICTITIOUS_AUDIT_FAILURE'); };
  A.addHook('beforeCreate', 'qaFailure', failAudit); await assert.rejects(perform(), { code: 'google_ads_revocation_unavailable' }); A.removeHook('beforeCreate', 'qaFailure'); await unchanged();
  models.BusinessProfileBrokerBinding = { findAll: async () => [{ external_location_id: '456' }] };
  process.env.GOOGLE_BUSINESS_PROFILE_REVOCATION_ENABLED = 'false'; await assert.rejects(perform(), { code: 'gbp_revocation_unavailable' });
  models.BusinessProfileBrokerBinding = empty; await unchanged();
  report.checks.push('Disabled capture, missing actor, failed audit and later GBP failure roll back Ads intents, audit, bindings, mappings and assignments together');
  for (const assetId of [11, 12, 991]) {
    const shared = await models.GroupAssetClinicAssignment.create({ assetType: 'google.ads_account', assetId, clinicaId: 99 });
    await assert.rejects(perform(), { code: 'scope_disconnect_shared_asset_conflict' }); await unchanged(); await shared.destroy();
  }
  await assert.rejects(perform({ assignmentScope: 'clinic', clinicId: 59, groupId: 5 }), { code: 'scope_disconnect_shared_asset_conflict' }); await unchanged();
  const override = await models.GoogleConnectionAssignment.create({ scopeKey: 'clinic:71', assignmentScope: 'clinic', clinicaId: 71, grupoClinicaId: 5, googleConnectionId: 2, status: 'active' });
  await assert.rejects(perform(), { code: 'scope_disconnect_shared_asset_conflict' }); await unchanged(); await override.destroy();
  await models.Clinica.update({ grupoClinicaId: 6 }, { where: { id_clinica: 59 } });
  await assert.rejects(perform(), { code: 'scope_disconnect_shared_asset_conflict' }); await unchanged();
  await models.Clinica.update({ grupoClinicaId: 5 }, { where: { id_clinica: 59 } });
  report.checks.push('Group owners, inherited clinic removal, overrides, current membership and explicit sharing of aliases or deleted mappings reject out-of-scope disconnects before changes');
  const originalBinding = await B.findOne({ where: { mapping_id: 11 }, raw: true }); await B.destroy({ where: { mapping_id: 11 } });
  await assert.rejects(perform(), { code: 'google_ads_revocation_unavailable' }); await unchanged(); await B.create(originalBinding);
  await M.update({ broker_read_connection_ref: null, broker_read_asset_ref: null }, { where: { id: 12 } });
  await assert.rejects(perform(), { code: 'google_ads_revocation_unavailable' }); await unchanged();
  await M.update({ broker_read_connection_ref: f.binding.connection_ref, broker_read_asset_ref: f.binding.asset_ref }, { where: { id: 12 } });
  const outsider = await M.create({ ...alias, id: 13, clinicaId: 99, grupoClinicaId: 6 });
  await assert.rejects(perform(), { code: 'scope_disconnect_shared_asset_conflict' });
  await outsider.destroy(); await unchanged();
  report.checks.push('Missing bindings, legacy aliases and a foreign active mapping of the same customer cannot be silently absorbed into a managed account disconnect');
  const { createGoogleAdsBroker } = require('../../services/googleAdsBroker.service');
  const { createGoogleAdsScopeRepository } = require('../../services/googleAdsBrokerScope.service');
  let afterRead; let calls = 0;
  const reader = createGoogleAdsBroker({ ...createGoogleAdsScopeRepository(() => models), enabled: () => true, client: { execute: async command => {
    calls++; await afterRead?.(); return { requestId: command.requestId, data: { results: [], nextPageToken: null } };
  } } });
  const context = await reader.prepare(f.mapping);
  afterRead = async () => { const result = await perform(); assert.equal(result.ads, 2); assert.equal(result.brokerRevocationsPending, 1); };
  await assert.rejects(reader.read(f.mapping, context, 'campaigns', {})); afterRead = null;
  assert.equal(calls, 1); assert.equal(await R.count(), 1); assert.equal(await A.count(), 1); assert.equal(await B.count({ where: { state: 'blocked' } }), 3);
  const original = await R.findOne({ raw: true }); assert.equal(original.clinic_ids, '[59,71]'); assert.equal(original.mapping_ids, '[11,12,991]');
  await assert.rejects(revocationMigration.down(qi));
  await perform(group, { actorId: 502 }); assert.equal(await R.count(), 1); assert.equal(await A.count(), 1);
  assert.equal((await R.findOne()).request_id, original.request_id); assert.equal((await R.findOne()).actor_user_id, 501);
  report.checks.push('Real SQL capture atomically blocks a group tuple, aliases and orphan registry; concurrent broker results are withheld and repeated requests preserve the original actor and correlation');
  const repository = service.createRevocationRepository(models); let clock = new Date(Date.now() + 1000);
  const claims = (await Promise.all(Array.from({ length: 4 }, () => repository.claim(clock)))).filter(Boolean); assert.equal(claims.length, 1);
  const stale = claims[0]; clock = new Date(clock.getTime() + 121000); const reclaimed = await repository.claim(clock);
  assert.equal(reclaimed.request_id, stale.request_id); assert.equal(await repository.confirm(stale, clock), false);
  A.addHook('beforeCreate', 'qaFailure', failAudit); await assert.rejects(repository.confirm(reclaimed, clock), /FICTITIOUS_AUDIT_FAILURE/); A.removeHook('beforeCreate', 'qaFailure');
  assert.equal((await R.findOne()).state, 'pending'); assert.equal(await A.count(), 1);
  await repository.retry(reclaimed, 'broker_timeout', clock); clock = new Date(clock.getTime() + 10000);
  let lose = true; const sent = [];
  const client = { execute: async command => {
    sent.push(command); assert.equal(command.operation, 'google.ads.asset.revoke.v1'); assert.deepEqual(command.payload, {});
    if (lose) { lose = false; throw Object.assign(Error('FICTITIOUS_LOST_ACK'), { code: 'broker_timeout' }); }
    return { requestId: command.requestId, data: { revoked: true } };
  } };
  const worker = () => service.createRevocationWorker({ repository: service.createRevocationRepository(models), client, enabled: () => true, now: () => clock });
  assert.equal((await worker().run()).failed, 1); clock = new Date(clock.getTime() + 10000); assert.equal((await worker().run()).confirmed, 1);
  assert.equal(sent.length, 2); assert.equal(sent[0].requestId, sent[1].requestId); assert.equal(sent[0].requestId, original.request_id);
  assert.equal(await A.count(), 2); assert.equal((await R.findOne()).state, 'confirmed'); assert.equal(await repository.confirm(reclaimed, clock), false);
  report.checks.push('Concurrent claims are exclusive; expired leases cannot confirm, audit failure preserves pending state and a fresh worker retries a lost ACK with the same durable UUID');
  const { unpack } = require('../../../services/platform-audit/src/event');
  for (const audit of await A.findAll({ raw: true })) {
    const event = unpack(audit).event; assert.equal(event.version, 11); assert.equal(event.subjectUserId, '501');
    assert.equal(event.scope.type, 'group'); assert.equal(event.scope.id, '5'); assert.equal(event.affectedClinicCount, 2);
    assert.equal(event.actor.type, event.stage === 'attempted' ? 'user' : 'job'); assert(!audit.body.includes('fictitious-subject'));
  }
  assert.deepEqual(await service.status([59,71], models), { status: 'confirmed', pending_assets: 0, confirmed_assets: 1 });
  assert.deepEqual(await service.status([59], models), { status: 'none', pending_assets: 0, confirmed_assets: 0 });
  report.checks.push('Human v11 attempt and job completion share their correlation and clinic commitment; status requires the entire captured clinic set');
  await B.destroy({ where: {} });
  await M.update({ isActive: true }, { where: { id: 11 } });
  await perform(); assert.equal(await A.count(), 2); assert.equal((await M.findByPk(11)).isActive, false);
  await M.destroy({ where: {} }); await M.create({ ...f.mapping, broker_read_connection_ref: null, broker_read_asset_ref: null });
  await assert.rejects(reader.prepare({ ...f.mapping, broker_read_connection_ref: null, broker_read_asset_ref: null }), { code: 'asset_revoked' });
  let tokenReads = 0; G.addHook('beforeFind', 'neverHydrate', options => {
    if (!options.attributes || options.attributes.includes('accessToken') || options.attributes.includes('refreshToken')) tokenReads++;
  });
  await G.destroy({ where: { id: 2 } });
  await G.create({ id: 2, googleUserId: 'recreated-subject', accessToken: 'FICTITIOUS_ACCESS' });
  await G.create({ id: 3, googleUserId: f.binding.google_user_id, accessToken: 'FICTITIOUS_ACCESS' });
  const legacy = require('../../services/googleLegacyCredentials.service').forModels(models);
  for (const id of [2,3]) await assert.rejects(legacy.load(id), { code: 'google_oauth_legacy_closed' });
  const oauth = require('../../services/googleOAuthBroker.service').createGoogleOAuthBroker({ models, audit: {} });
  await assert.rejects(oauth.assertLegacyAllowed(), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(oauth.assertLegacyConnection({ id: 3, googleUserId: f.binding.google_user_id }), { code: 'google_oauth_legacy_closed' });
  assert.equal(tokenReads, 0); assert.equal(calls, 1);
  report.checks.push('Confirmed history survives removal of bindings, mappings and connections; reused SQL IDs or Google subjects cannot hydrate credentials or restart legacy OAuth');
  await G.create({ id: 4, googleUserId: 'unmarked-subject', accessToken: 'FICTITIOUS_ACCESS' });
  const { tupleHash } = require('../../services/googleAdsRevocation.contract');
  const race = { ...original, customer_id: '1111111111', asset_ref: 'ads:1111111111', google_connection_id: 4, google_user_id: 'unmarked-subject', request_id: randomUUID() };
  race.tuple_hash = tupleHash(race);
  let inserted = false;
  G.addHook('beforeFind', 'raceAdsHistory', async options => { if (options.attributes?.includes('accessToken') && !inserted) { inserted = true; await R.create(race); } });
  await assert.rejects(legacy.load(4), { code: 'google_oauth_legacy_closed' }); G.removeHook('beforeFind', 'raceAdsHistory');
  assert.equal(inserted, true);
  await R.destroy({ where: { tuple_hash: race.tuple_hash } });
  G.addHook('beforeBulkUpdate', 'raceAdsWrite', async () => { await R.create(race); });
  await assert.rejects(legacy.saveRefresh({ id: 4, googleUserId: 'unmarked-subject' }, { accessToken: 'FICTITIOUS_REPLACEMENT', expiresAt: new Date(Date.now() + 10000) }), { code: 'google_oauth_legacy_closed' });
  G.removeHook('beforeBulkUpdate', 'raceAdsWrite');
  const [tokenState] = await sql.query("SELECT accessToken = 'FICTITIOUS_ACCESS' AS unchanged FROM GoogleConnections WHERE id=4");
  assert.equal(Number(tokenState[0].unchanged), 1);
  report.checks.push('The actual credential SELECT and conditional UPDATE exclude a revocation committed after their metadata checks');
  await qi.renameTable('GoogleAdsBrokerRevocations', 'OfflineHiddenAdsRevocations');
  await assert.rejects(legacy.load(4)); await assert.rejects(reader.prepare(f.mapping), { code: 'broker_binding_invalid' });
  await assert.rejects(oauth.assertLegacyAllowed()); await assert.rejects(perform(), { code: 'google_ads_revocation_unavailable' });
  await qi.renameTable('OfflineHiddenAdsRevocations', 'GoogleAdsBrokerRevocations');
  report.checks.push('Missing revocation schema fails closed in read, credential, OAuth and disconnect paths');
});

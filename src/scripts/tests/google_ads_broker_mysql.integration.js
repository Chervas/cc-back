'use strict';
const assert = require('node:assert/strict'); const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  await require('./fixtures/google_ads_enrollment_mysql.fixture').installGoogleAdsEnrollmentTables({ sql, models });
  const qi = sql.getQueryInterface();
  await qi.createTable('Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true } });
  models.GoogleConnection = require('../../../models/googleconnection')(sql, D); await models.GoogleConnection.sync();
  const base = require('../../../models/clinicgoogleadsaccount')(sql, D);
  base.removeAttribute('broker_read_connection_ref'); base.removeAttribute('broker_read_asset_ref'); await base.sync();
  const migration = require('../../../migrations/20260913080000-add-google-ads-broker-bindings');
  await migration.up(qi); await migration.down(qi); await migration.up(qi);
  report.checks.push('Actual Ads schema applies, rolls back only empty and reapplies on an owned MySQL instance');
  const stagingMigration = require('../../../migrations/20260913110000-stage-google-ads-broker-mappings');
  await stagingMigration.up(qi); await assert.rejects(stagingMigration.up(qi), /google_ads_mapping_schema_mismatch/);
  await stagingMigration.down(qi); await stagingMigration.up(qi);
  report.checks.push('Staged Ads schema preflights the exact old ENUM, adds preparation without changing the blocked default, and round trips while empty');
  models.ClinicGoogleAdsAccount = require('../../../models/clinicgoogleadsaccount')(sql, D);
  for (const [name, file] of [['GoogleAdsBrokerBinding', 'googleadsbrokerbinding'], ['GoogleAdsBrokerRevocation', 'googleadsbrokerrevocation'], ['GoogleOAuthBrokerBinding', 'googleoauthbrokerbinding'],
    ['SearchConsoleBrokerBinding', 'searchconsolebrokerbinding'], ['AnalyticsBrokerBinding', 'analyticsbrokerbinding'],
    ['GooglePropertyBrokerRevocation', 'googlepropertybrokerrevocation'], ['GoogleConnectionAssignment', 'googleconnectionassignment']]) {
    models[name] = require('../../../models/' + file)(sql, D); await models[name].sync();
  }
  models.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER,
    nombre_clinica: D.STRING(128), url_avatar: D.STRING(256) }, { tableName: 'Clinicas', timestamps: false });
  models.GroupAssetClinicAssignment = sql.define('GroupAssetClinicAssignment', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
    assetType: D.STRING(64), assetId: D.INTEGER, clinicaId: D.INTEGER, grupoClinicaId: D.INTEGER }, { tableName: 'GroupAssetClinicAssignments', timestamps: false });
  await models.Clinica.sync(); await models.GroupAssetClinicAssignment.sync();
  await models.Clinica.bulkCreate([{ id_clinica: 59, grupoClinicaId: 5 }, { id_clinica: 71, grupoClinicaId: 5 }, { id_clinica: 99, grupoClinicaId: 6 }]);
  const f = require('./fixtures/google_ads_broker_scope.fixture').scopeFixture();
  const G = models.GoogleConnection; const M = models.ClinicGoogleAdsAccount; const B = models.GoogleAdsBrokerBinding;
  await G.create({ id: 2, googleUserId: f.binding.google_user_id, accessToken: null, refreshToken: null });
  await M.create(f.mapping); await B.create(f.binding);
  await models.GoogleConnectionAssignment.create({ ...f.state.grants[0], scopeKey: 'group:5' });
  await assert.rejects(M.create({ ...f.mapping, id: 13, broker_read_asset_ref: null }));
  await assert.rejects(migration.down(qi));
  const [fk] = await sql.query("SELECT COUNT(*) AS n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='GoogleAdsBrokerBindings'");
  assert.equal(Number(fk[0].n), 0);
  report.checks.push('Paired markers reject partial references; registry has no cascading FK and rollback rejects managed data');
  let tokenReads = 0;
  G.addHook('beforeFind', 'metadata_only_ads', options => {
    if (!options.attributes || options.attributes.includes('accessToken') || options.attributes.includes('refreshToken')) tokenReads++;
  });
  const { createGoogleAdsBrokerScope, createGoogleAdsScopeRepository } = require('../../services/googleAdsBrokerScope.service');
  const create = () => createGoogleAdsBrokerScope({ ...createGoogleAdsScopeRepository(() => models), enabled: () => true });
  const service = create(); const context = await service.prepare(f.mapping);
  assert.deepEqual((await service.assertContext(context)).clinicIds, [59, 71]); assert.equal(tokenReads, 0);
  report.checks.push('Actual repository reads group metadata and SQL NULL predicate without loading token values');
  const oldTransaction = await sql.transaction();
  try {
    await B.findAll({ transaction: oldTransaction, raw: true });
    await B.update({ state: 'blocked' }, { where: { mapping_id: 11 } });
    await assert.rejects(service.assertContext(context, { transaction: oldTransaction }), { code: 'asset_revoked' });
  } finally { await oldTransaction.rollback(); }
  await B.update({ state: 'active' }, { where: { mapping_id: 11 } });
  report.checks.push('A persistence fence uses current locking reads even inside an older REPEATABLE READ transaction');
  const holder = await sql.transaction(); const contender = await sql.transaction();
  try {
    await service.assertContext(context, { transaction: holder });
    await sql.query('SET SESSION innodb_lock_wait_timeout = 1', { transaction: contender });
    await assert.rejects(B.update({ state: 'blocked' }, { where: { mapping_id: 11 }, transaction: contender }),
      error => error.original?.code === 'ER_LOCK_WAIT_TIMEOUT');
  } finally { await contender.rollback(); await holder.rollback(); }
  report.checks.push('The persistence fence keeps the Ads registry locked until its surrounding transaction ends');
  const shared = await models.GroupAssetClinicAssignment.create({ assetType: 'google.ads_account', assetId: 11, clinicaId: 99 });
  await assert.rejects(service.assertContext(context), { code: 'scope_denied' }); await shared.destroy();
  const override = await models.GoogleConnectionAssignment.create({ id: 101, scopeKey: 'clinic:59', assignmentScope: 'clinic',
    clinicaId: 59, grupoClinicaId: 5, googleConnectionId: 2, status: 'revoked' });
  await assert.rejects(service.assertContext(context), { code: 'scope_denied' }); await override.destroy();
  report.checks.push('Real SQL sharing outside the group and revoked direct overrides both invalidate prior contexts');
  await G.update({ accessToken: 'FICTITIOUS_RESIDUAL_ACCESS' }, { where: { id: 2 } });
  await assert.rejects(create().prepare(f.mapping), { code: 'broker_binding_invalid' });
  await G.update({ accessToken: null }, { where: { id: 2 } });
  await G.create({ id: 3, googleUserId: f.binding.google_user_id, accessToken: 'FICTITIOUS_DUPLICATE_SUBJECT' });
  await assert.rejects(create().prepare(f.mapping), { code: 'broker_binding_invalid' });
  const legacy = require('../../services/googleLegacyCredentials.service').forModels(models);
  const before = tokenReads;
  for (const id of [2, 3]) await assert.rejects(legacy.load(id), { code: 'google_oauth_legacy_closed' });
  assert.equal(tokenReads, before); await G.destroy({ where: { id: 3 } });
  report.checks.push('Residual credentials and duplicate subject fail the broker boundary; durable Ads markers prevent legacy hydration for both IDs');
  const callback = require('../../services/googleOAuthBroker.service').createGoogleOAuthBroker({ models, audit: {} });
  await assert.rejects(callback.assertLegacyAllowed(), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(callback.assertLegacyConnection({ id: 2, googleUserId: f.binding.google_user_id }), { code: 'google_oauth_legacy_closed' });
  report.checks.push('Legacy OAuth entry and callback gates consult the Ads registry independently of feature flags');
  const { createGoogleAdsDiscovery, createGoogleAdsDiscoveryRepository } = require('../../services/googleAdsDiscovery.service');
  const { createGoogleAdsBroker } = require('../../services/googleAdsBroker.service');
  let afterDiscovery; let discoveryCalls = 0;
  const discoveryBroker = createGoogleAdsBroker({ ...createGoogleAdsScopeRepository(() => models), enabled: () => true,
    client: { execute: async command => { discoveryCalls++; await afterDiscovery?.();
      assert.equal(command.operation, 'google.ads.discovery.read.v1'); assert.equal(command.tenantRef, 'clinic:59');
      return { requestId: command.requestId, data: { results: [{ customer: { id: command.assetRef.slice(4), manager: false,
        descriptiveName: 'Fictitious SQL account', currencyCode: 'EUR', timeZone: 'Europe/Madrid', status: 'ENABLED' } }], nextPageToken: null } };
    } } });
  const discovery = createGoogleAdsDiscovery({ broker: discoveryBroker, ...createGoogleAdsDiscoveryRepository(() => models), enabled: () => true,
    hasManaged: async () => { try { await callback.assertLegacyAllowed(); return false; } catch (e) { if (e.code === 'google_oauth_legacy_closed') return true; throw e; } } });
  const discoveryInput = { clinicIds: [59, 71], scopeKey: 'group:5', connectionId: 2, revalidate: async () => {} };
  const tokenReadsBeforeDiscovery = tokenReads;
  assert.equal((await discovery.list(discoveryInput)).accounts[0].customerId, '1234567890');
  assert.equal((await discovery.list({ ...discoveryInput, clinicIds: [71], scopeKey: 'clinic:71' })).accounts.length, 1);
  assert.equal(discoveryCalls, 2); assert.equal(tokenReads, tokenReadsBeforeDiscovery);
  report.checks.push('Registered Ads inventory uses real SQL metadata for group and inherited clinic, actual reader and owner tenant without credential hydration');
  await sql.transaction(async transaction => {
    await M.update({ isActive: false }, { where: { id: 11 }, transaction });
    await B.update({ state: 'staged' }, { where: { mapping_id: 11 }, transaction });
  });
  await assert.rejects(stagingMigration.down(qi), /Preserve staged Ads mappings/);
  await assert.rejects(create().prepare(f.mapping), { code: 'broker_binding_invalid' });
  const oauthScope = require('../../services/googleAdsOAuthScope.service');
  const oauthOwner = { cohort: 'ads', google_connection_id: 2, google_user_id: f.binding.google_user_id,
    connection_ref: f.binding.connection_ref, asset_ref: f.binding.asset_ref, clinica_id: 59 };
  const stagedConsumers = await oauthScope.consumers(models, oauthOwner, { raw: true, logging: false, limit: 1001 });
  assert.deepEqual([...stagedConsumers.affected].sort(), [59, 71]); assert.deepEqual([...stagedConsumers.usage].sort(), [59, 71]);
  const orphanTransaction = await sql.transaction();
  try {
    await M.destroy({ where: { id: 11 }, transaction: orphanTransaction });
    await assert.rejects(oauthScope.consumers(models, oauthOwner, { raw: true, logging: false, limit: 1001,
      transaction: orphanTransaction, lock: orphanTransaction.LOCK.UPDATE }), { code: 'google_oauth_scope_conflict' });
  } finally { await orphanTransaction.rollback(); }
  report.checks.push('OAuth includes all staged group consumers without activating them and rejects an orphaned staged mapping using actual SQL');
  const preparedSelection = await discovery.capture(discoveryInput);
  assert.equal(preparedSelection.inventory.accounts.length, 1);
  assert.equal(tokenReads, tokenReadsBeforeDiscovery);
  report.checks.push('Inactive staged mapping is discoverable but not sync readable, uses no SQL credentials and prevents rollback that would erase its state');
  const preparedTransaction = await sql.transaction();
  try {
    const saved = await discovery.assertSelection(preparedSelection.selection, { transaction: preparedTransaction });
    assert.equal(saved.bindings[0].state, 'staged'); assert.equal(saved.mappings[0].isActive, 0);
    await M.update({ isActive: true }, { where: { id: 11 }, transaction: preparedTransaction });
    await B.update({ state: 'active' }, { where: { mapping_id: 11 }, transaction: preparedTransaction });
    // A later failure must restore preparation, including both sides of activation.
  } finally { await preparedTransaction.rollback(); }
  assert.equal((await B.findOne({ raw: true })).state, 'staged'); assert.equal((await M.findByPk(11, { raw: true })).isActive, 0);
  report.checks.push('Original prepared selection is revalidated by locking SQL reads and both activation updates roll back together');
  const staleSelectionTransaction = await sql.transaction();
  try {
    await B.findAll({ transaction: staleSelectionTransaction });
    await sql.transaction(async transaction => {
      await M.update({ isActive: true }, { where: { id: 11 }, transaction });
      await B.update({ state: 'active' }, { where: { mapping_id: 11 }, transaction });
    });
    await assert.rejects(discovery.assertSelection(preparedSelection.selection, { transaction: staleSelectionTransaction }), { code: 'broker_binding_invalid' });
  } finally { await staleSelectionTransaction.rollback(); discovery.releaseSelection(preparedSelection.selection); }
  assert.ok(await create().prepare(f.mapping));
  report.checks.push('A selection created before concurrent activation rejects current SQL state even in an older REPEATABLE READ transaction');
  await M.create({ ...f.mapping, id: 12, assignmentScope: 'clinic', clinicaId: 71, customerId: '123-456-7890' });
  await B.create({ ...f.binding, mapping_id: 12, scope_key: 'clinic:71' });
  const localShare = await models.GroupAssetClinicAssignment.create({ assetType: 'google.ads_account', assetId: 11, clinicaId: 71, grupoClinicaId: 5 });
  const beforeAliases = discoveryCalls;
  assert.equal((await discovery.list({ ...discoveryInput, clinicIds: [71], scopeKey: 'clinic:71' })).accounts.length, 1);
  assert.equal(discoveryCalls, beforeAliases + 1);
  report.checks.push('Group authority wins over a clinic alias for the same canonical account, with one broker read and bounded explicit sharing');
  afterDiscovery = () => models.GroupAssetClinicAssignment.create({ assetType: 'google.ads_account', assetId: 11, clinicaId: 99, grupoClinicaId: 6 });
  await assert.rejects(discovery.list(discoveryInput), { code: 'scope_denied' }); afterDiscovery = null;
  await models.GroupAssetClinicAssignment.destroy({ where: { clinicaId: 99 } });
  report.checks.push('A foreign shared consumer committed during Ads discovery invalidates the response before any account is returned');
  const RC = require('../../services/googleAdsRevocation.contract');
  const revoked = { ...f.binding, scope_key: 'group:5', clinic_ids: '[59,71]', mapping_ids: '[11,12]',
    request_id: require('node:crypto').randomUUID(), actor_user_id: 501, requested_at: new Date(), next_attempt_at: new Date(), state: 'pending' };
  revoked.tuple_hash = RC.tupleHash(revoked);
  afterDiscovery = () => models.GoogleAdsBrokerRevocation.create(revoked);
  await assert.rejects(discovery.list(discoveryInput), { code: 'asset_revoked' }); afterDiscovery = null;
  const afterRevocationCalls = discoveryCalls;
  await assert.rejects(discovery.list(discoveryInput), { code: 'asset_revoked' }); assert.equal(discoveryCalls, afterRevocationCalls);
  assert.equal(tokenReads, tokenReadsBeforeDiscovery);
  report.checks.push('Durable Ads revocation during discovery survives the next request and stops provider dispatch without fallback or credential reads');
  // Restore only this disposable fixture before continuing the original deletion/race checks.
  await models.GoogleAdsBrokerRevocation.destroy({ where: { tuple_hash: revoked.tuple_hash } });
  await localShare.destroy(); await B.destroy({ where: { mapping_id: 12 } }); await M.destroy({ where: { id: 12 } });
  models.PlatformAuditEvent = require('../../../models/platformauditevent')(sql, D); await models.PlatformAuditEvent.sync();
  const nextMapping = { ...f.mapping, id: 21, customerId: '1111111111', broker_read_asset_ref: 'ads:1111111111', isActive: false };
  const nextBinding = { ...f.binding, mapping_id: 21, customer_id: '1111111111', asset_ref: 'ads:1111111111', state: 'staged' };
  await M.create(nextMapping); await B.create(nextBinding);
  const { createGoogleAdsMapping } = require('../../services/googleAdsMapping.service');
  const actualAudit = require('../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const actualRevoke = args => require('../../services/googleAdsRevocation.service').enqueue({ ...args, enabled: 'true' });
  const request = { mappings: [{ clinicaId: 59, customerId: f.mapping.customerId }, { clinicaId: 59, customerId: nextMapping.customerId }],
    actorId: 501, sessionRef: require('node:crypto').randomUUID(), authorize: async ({ transaction, clinicIds }) => {
      assert.ok(transaction?.LOCK?.UPDATE); assert.deepEqual(clinicIds, [59, 71]); return true;
    } };
  const mappingFactory = extra => createGoogleAdsMapping({ models, discovery, broker: discoveryBroker, enabled: () => true, revoke: actualRevoke, ...extra });
  let appends = 0;
  const failingAudit = mappingFactory({ audit: { ...actualAudit, append: async (...args) => {
    await actualAudit.append(...args); if (++appends === 2) throw Error('FICTITIOUS_AUDIT_FAILURE');
  } } });
  let capturedMapping = await discovery.capture(discoveryInput);
  await assert.rejects(failingAudit.save({ ...request, selection: capturedMapping.selection }), { code: 'google_ads_mapping_unavailable' });
  assert.equal((await M.findByPk(11, { raw: true })).clinicaId, 999); assert.equal((await M.findByPk(21, { raw: true })).isActive, 0);
  assert.equal((await B.findOne({ where: { mapping_id: 21 }, raw: true })).state, 'staged'); assert.equal(await models.PlatformAuditEvent.count(), 0);
  report.checks.push('Actual managed mapping service rolls back both accounts, staged activation and all audit rows when the second audit append fails');
  capturedMapping = await discovery.capture(discoveryInput); let authorizations = 0;
  await assert.rejects(mappingFactory().save({ ...request, selection: capturedMapping.selection, authorize: async () => ++authorizations < 2 }), { code: 'google_discovery_scope_forbidden' });
  assert.equal((await M.findByPk(21, { raw: true })).isActive, 0); assert.equal(await models.PlatformAuditEvent.count(), 0);
  report.checks.push('Permission loss at the final mutation fence rolls back activation and its durable audit together');
  capturedMapping = await discovery.capture(discoveryInput);
  const savedMappings = await mappingFactory().save({ ...request, selection: capturedMapping.selection });
  assert.equal(savedMappings.mapped, 2); assert.doesNotMatch(JSON.stringify(savedMappings), /connection:|broker_read|fictitious-subject|token/i);
  const mappingEvents = await models.PlatformAuditEvent.findAll({ raw: true });
  assert.equal(mappingEvents.length, 2); assert.equal(new Set(mappingEvents.map(r => r.correlation_id)).size, 1);
  assert.deepEqual(mappingEvents.map(r => r.result_part).sort((a,b) => a-b), [11, 21]);
  for (const event of mappingEvents) assert.equal(require('../../../services/platform-audit/src/event').unpack(event).event.version, 12);
  assert.equal((await B.findOne({ where: { mapping_id: 21 }, raw: true })).state, 'active');
  assert.equal((await M.findByPk(11, { raw: true })).assignmentScope, 'group'); assert.equal((await M.findByPk(11, { raw: true })).clinicaId, 59);
  report.checks.push('Two managed accounts save atomically, preserve group ownership and tenant, activate staging and share one audit correlation with distinct durable parts');
  capturedMapping = await discovery.capture(discoveryInput);
  const replaced = await mappingFactory().save({ ...request, mappings: [request.mappings[1]], replaceExisting: true, selection: capturedMapping.selection });
  assert.equal(replaced.mapped, 1); assert.equal((await M.findByPk(11, { raw: true })).isActive, 0);
  assert.equal((await B.findOne({ where: { mapping_id: 11 }, raw: true })).state, 'blocked');
  assert.equal((await B.findOne({ where: { mapping_id: 21 }, raw: true })).state, 'active');
  assert.equal(await models.GoogleAdsBrokerRevocation.count(), 1);
  assert.deepEqual((await discovery.list(discoveryInput)).accounts.map(r => r.customerId), ['1111111111']);
  assert.equal(tokenReads, tokenReadsBeforeDiscovery);
  report.checks.push('Replacement revokes only the removed customer, keeps its independent history, and the remaining active account is still selectable without credential reads');
  const providerCallsBeforeMetadata = discoveryCalls;
  const metadata = await mappingFactory().list(discoveryInput);
  assert.equal(metadata.mappings[0].ads[0].customerId, '1111111111');
  const inheritedMetadata = await mappingFactory().list({ ...discoveryInput, clinicIds: [71], scopeKey: 'clinic:71' });
  assert.equal(inheritedMetadata.mappings[0].clinicaId, 71); assert.equal(discoveryCalls, providerCallsBeforeMetadata);
  assert.doesNotMatch(JSON.stringify(metadata), /broker_read|connection:|999|token/);
  report.checks.push('Stored mapping list uses bounded authorized metadata, supports inherited clinic display and makes no provider or credential calls');
  capturedMapping = await discovery.capture(discoveryInput);
  await assert.rejects(mappingFactory().save({ ...request, mappings: [request.mappings[0]], selection: capturedMapping.selection }), { code: 'google_ads_account_not_accessible' });
  const removeRequest = { ...discoveryInput, mappingId: 21, actorId: request.actorId, sessionRef: request.sessionRef, authorize: request.authorize };
  await assert.rejects(mappingFactory().remove({ ...removeRequest, clinicIds: [71], scopeKey: 'clinic:71', authorize: async () => true }), { code: 'google_ads_mapping_scope_conflict' });
  let removalAuthorizations = 0; const auditBeforeRemoval = await models.PlatformAuditEvent.count();
  await assert.rejects(mappingFactory().remove({ ...removeRequest, authorize: async () => ++removalAuthorizations < 2 }), { code: 'google_discovery_scope_forbidden' });
  assert.equal(await models.GoogleAdsBrokerRevocation.count(), 1); assert.equal(await models.PlatformAuditEvent.count(), auditBeforeRemoval);
  assert.equal((await B.findOne({ where: { mapping_id: 21 }, raw: true })).state, 'active');
  report.checks.push('Revoked accounts cannot be selected again; individual clinic removal cannot affect a group, and loss of permission rolls back targeted revocation');
  const callsBeforeRemoval = discoveryCalls;
  assert.equal((await mappingFactory().remove(removeRequest)).success, true);
  const auditAfterRemoval = await models.PlatformAuditEvent.count();
  assert.equal((await mappingFactory().remove(removeRequest)).success, true);
  assert.equal(await models.PlatformAuditEvent.count(), auditAfterRemoval); assert.equal(await models.GoogleAdsBrokerRevocation.count(), 2);
  assert.equal(await M.count(), 2); assert.equal(discoveryCalls, callsBeforeRemoval);
  assert.deepEqual((await mappingFactory().list(discoveryInput)).mappings, []);
  report.checks.push('Targeted removal works without provider access, retains original mappings and durable tombstones, and retries without duplicate audit or external commands');
  // Restore only the owned QA data before the original destruction/fallback checks.
  await models.GoogleAdsBrokerRevocation.destroy({ where: {} }); await B.destroy({ where: { mapping_id: 21 } }); await M.destroy({ where: { id: 21 } });
  await B.update({ state: 'active' }, { where: { mapping_id: 11 } });
  await M.destroy({ where: { id: 11 } });
  await assert.rejects(create().prepare(f.mapping));
  assert.equal(await B.count(), 1);
  await M.create({ ...f.mapping, broker_read_connection_ref: null, broker_read_asset_ref: null });
  await assert.rejects(create().prepare(f.mapping));
  await G.destroy({ where: { id: 2 } }); await G.create({ id: 2, googleUserId: 'fictitious-recreated', accessToken: 'FICTITIOUS_RECREATED_ACCESS' });
  await assert.rejects(legacy.load(2), { code: 'google_oauth_legacy_closed' });
  report.checks.push('Deleted and recreated mapping/connection IDs cannot remove the independent exclusion or enable fallback');
  await G.create({ id: 4, googleUserId: 'fictitious-unmarked', accessToken: 'FICTITIOUS_UNMARKED_ACCESS', refreshToken: 'FICTITIOUS_UNMARKED_REFRESH' });
  let armed = true;
  G.addHook('beforeFind', 'ads_race_select', async options => {
    if (armed && options.attributes?.includes('accessToken')) { armed = false; await B.create({ ...f.binding, mapping_id: 14, google_connection_id: 4, google_user_id: 'fictitious-unmarked' }); }
  });
  await assert.rejects(legacy.load(4), { code: 'google_oauth_legacy_closed' }); G.removeHook('beforeFind', 'ads_race_select');
  report.checks.push('Actual credential SELECT NOT EXISTS rejects an Ads marker committed after its metadata check');
  await qi.renameTable('GoogleAdsBrokerBindings', 'OfflineHiddenAdsBindings');
  await assert.rejects(legacy.load(4), { code: 'google_credentials_unavailable' });
  await assert.rejects(create().prepare(f.mapping), { code: 'broker_binding_invalid' });
  await qi.renameTable('OfflineHiddenAdsBindings', 'GoogleAdsBrokerBindings');
  report.checks.push('A missing Ads migration fails closed in broker and legacy paths');
}).catch(() => { process.exitCode = 1; });

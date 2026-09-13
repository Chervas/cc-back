'use strict';
const assert = require('node:assert/strict'); const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const qi = sql.getQueryInterface();
  await qi.createTable('Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true } });
  models.GoogleConnection = require('../../../models/googleconnection')(sql, D); await models.GoogleConnection.sync();
  const base = require('../../../models/clinicgoogleadsaccount')(sql, D);
  base.removeAttribute('broker_read_connection_ref'); base.removeAttribute('broker_read_asset_ref'); await base.sync();
  const migration = require('../../../migrations/20260913080000-add-google-ads-broker-bindings');
  await migration.up(qi); await migration.down(qi); await migration.up(qi);
  report.checks.push('Actual Ads schema applies, rolls back only empty and reapplies on an owned MySQL instance');
  models.ClinicGoogleAdsAccount = require('../../../models/clinicgoogleadsaccount')(sql, D);
  for (const [name, file] of [['GoogleAdsBrokerBinding', 'googleadsbrokerbinding'], ['GoogleOAuthBrokerBinding', 'googleoauthbrokerbinding'],
    ['SearchConsoleBrokerBinding', 'searchconsolebrokerbinding'], ['AnalyticsBrokerBinding', 'analyticsbrokerbinding'],
    ['GooglePropertyBrokerRevocation', 'googlepropertybrokerrevocation'], ['GoogleConnectionAssignment', 'googleconnectionassignment']]) {
    models[name] = require('../../../models/' + file)(sql, D); await models[name].sync();
  }
  models.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER }, { tableName: 'Clinicas', timestamps: false });
  models.GroupAssetClinicAssignment = sql.define('GroupAssetClinicAssignment', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
    assetType: D.STRING(64), assetId: D.INTEGER, clinicaId: D.INTEGER }, { tableName: 'GroupAssetClinicAssignments', timestamps: false });
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

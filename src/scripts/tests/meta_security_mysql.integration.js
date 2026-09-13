'use strict';
const assert = require('node:assert/strict'); const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const define = (name, attributes, tableName) => sql.define(name, attributes, { tableName, timestamps: false });
  const pk = { type: D.INTEGER, primaryKey: true };
  models.Clinica = define('Clinica', { id_clinica: pk, grupoClinicaId: D.INTEGER }, 'Clinicas');
  models.GrupoClinica = define('GrupoClinica', { id_grupo: pk, facebook_primary_asset_id: D.INTEGER, instagram_primary_asset_id: D.INTEGER }, 'GruposClinicas');
  models.MetaConnection = define('MetaConnection', { id: pk, userId: D.INTEGER, metaUserId: D.STRING, accessToken: D.STRING }, 'MetaConnections');
  models.MetaConnectionAssignment = define('MetaConnectionAssignment', { id: pk, scopeKey: D.STRING, assignmentScope: D.STRING,
    clinicaId: D.INTEGER, grupoClinicaId: D.INTEGER, metaConnectionId: D.INTEGER, status: D.STRING, authorizedByUserId: D.INTEGER }, 'MetaConnectionAssignments');
  models.ClinicMetaAsset = define('ClinicMetaAsset', { id: pk, clinicaId: D.INTEGER, grupoClinicaId: D.INTEGER,
    assignmentScope: D.STRING, metaConnectionId: D.INTEGER, assetType: D.STRING, isActive: D.BOOLEAN,
    metaAssetId: D.STRING, metaAssetName: D.STRING, pageAccessToken: D.STRING }, 'ClinicMetaAssets');
  models.GroupAssetClinicAssignment = define('GroupAssetClinicAssignment', { id: pk, assetType: D.STRING, assetId: D.INTEGER, clinicaId: D.INTEGER }, 'GroupAssetClinicAssignments');
  for (const model of Object.values(models).filter(value => value?.sync)) await model.sync();
  const qi = sql.getQueryInterface(); const migration = require('../../../migrations/20260913140000-create-meta-scope-blocks');
  await migration.up(qi); await migration.down(qi);
  await models.MetaConnectionAssignment.create({ id: 1, scopeKey: 'clinic:1', assignmentScope: 'clinic', clinicaId: 1, metaConnectionId: 9,
    authorizedByUserId: 123, status: 'disconnected' });
  await migration.up(qi); models.MetaScopeBlock = require('../../../models/metascopeblock')(sql, D);
  await require('../../../migrations/20260912210000-create-platform-audit-events').up(qi, D);
  await require('../../../migrations/20260913003000-add-platform-audit-result-part').up(qi);
  models.PlatformAuditEvent = require('../../../models/platformauditevent')(sql, D);
  await models.Clinica.bulkCreate([{ id_clinica: 1, grupoClinicaId: 10 }, { id_clinica: 2, grupoClinicaId: 20 }, { id_clinica: 3, grupoClinicaId: 20 }]);
  await models.MetaConnection.create({ id: 9, userId: 123, metaUserId: 'FICTITIOUS_META_SUBJECT', accessToken: 'SENTINEL_PROVIDER_TOKEN' });
  const blocks = require('../../services/metaScopeBlock.service');
  assert.equal((await models.MetaScopeBlock.findByPk('clinic:1')).reason, 'legacy_disconnected');
  assert.equal(await blocks.blocked({ assignmentScope: 'clinic', clinicId: 1 }), true);
  assert.equal(await blocks.blocked({ assignmentScope: 'clinic', clinicId: 2 }), false);
  report.checks.push('Actual Meta DDL imports old disconnected assignments, supports empty rollback and has no foreign keys to deleted originals');

  const disconnect = require('../../services/oauthScopedDisconnect.service').deactivateMetaMappingsForScope;
  const scope = { assignmentScope: 'clinic', clinicId: 2, groupId: 20, scopeKey: 'clinic:2' };
  const mapping = await models.ClinicMetaAsset.create({ id: 101, clinicaId: 2, grupoClinicaId: 20, assignmentScope: 'clinic', metaConnectionId: 9,
    assetType: 'facebook_page', isActive: true, pageAccessToken: 'SENTINEL_PAGE_TOKEN' });
  const run = () => sql.transaction(transaction => disconnect({ scope, connectionId: 9, actorId: 123, models, transaction }));
  await models.GrupoClinica.create({ id_grupo: 20, facebook_primary_asset_id: 101 });
  await assert.rejects(run(), { code: 'scope_disconnect_shared_asset_conflict' });
  await mapping.reload(); assert.equal(mapping.isActive, true); assert.equal(await models.MetaScopeBlock.count(), 1);
  assert.equal(await models.PlatformAuditEvent.count(), 0);
  await models.GrupoClinica.update({ facebook_primary_asset_id: null }, { where: { id_grupo: 20 } });
  await models.GroupAssetClinicAssignment.create({ id: 1, assetType: 'meta.facebook_page', assetId: 101, clinicaId: 3 });
  await assert.rejects(run(), { code: 'scope_disconnect_shared_asset_conflict' });
  assert.equal(await models.PlatformAuditEvent.count(), 0);
  report.checks.push('Group primary references and explicit shares outside the disconnected clinic both reject before any mapping, block or audit mutation');
  await models.GroupAssetClinicAssignment.destroy({ where: {} });

  const create = models.PlatformAuditEvent.create;
  models.PlatformAuditEvent.create = async () => { throw Error('FICTITIOUS_AUDIT_UNAVAILABLE'); };
  try { await assert.rejects(run(), /FICTITIOUS_AUDIT_UNAVAILABLE/); }
  finally { models.PlatformAuditEvent.create = create; }
  await mapping.reload(); assert.equal(mapping.isActive, true); assert.equal(await models.MetaScopeBlock.count(), 1);
  const outcomes = await Promise.all([run(), run()]); assert.equal(outcomes.reduce((n, value) => n + value.meta, 0), 1);
  assert.equal(await models.MetaScopeBlock.count({ where: { scope_key: 'clinic:2' } }), 1);
  assert.equal(await models.PlatformAuditEvent.count(), 2);
  report.checks.push('Audit failure rolls back the whole disconnect; concurrent retries deactivate once and preserve one independent scope block');

  await models.ClinicMetaAsset.destroy({ where: {} }); await models.MetaConnectionAssignment.destroy({ where: {} }); await models.MetaConnection.destroy({ where: {} });
  assert.equal(await blocks.blocked(scope), true); assert.equal(await blocks.blocked({ assignmentScope: 'group', groupId: 20 }), true);
  const resolver = require('../../services/scopeConnectionResolver.service');
  const resolved = await resolver.resolveMetaConnectionForScope({ userId: 123, clinicIdRaw: 2, allowLegacyUserFallback: true });
  assert.equal(resolved.connection, null); assert.equal(resolved.source, 'security_scope_blocked');
  await assert.rejects(resolver.upsertMetaAssignment({ connection: { id: 999, accessToken: 'SENTINEL' }, scope }), { code: 'meta_security_quarantine' });
  await assert.rejects(require('../../services/oauthConnectionPersistence.service').persistMetaConnection({ userId: 123,
    metaUserId: 'ALTERNATIVE_SUBJECT', accessToken: 'SENTINEL' }), { code: 'meta_security_quarantine' });
  report.checks.push('Deletion of mappings, assignments and connections does not remove the block; the resolver stops before user/group fallback and alternative enrollment is quarantined');

  const previousTable = models.MetaScopeBlock;
  models.MetaScopeBlock = { findOne: async () => { throw Error('FICTITIOUS_SQL_SECRET'); } };
  try { await assert.rejects(blocks.blocked(scope), { code: 'meta_security_state_unavailable' }); }
  finally { models.MetaScopeBlock = previousTable; }
  await assert.rejects(migration.down(qi), /Preserve Meta scope blocks/);
  report.checks.push('Unavailable security storage fails closed and populated rollback cannot remove historical blocks');
}).catch(error => { console.error(JSON.stringify({ success: false, error: error.message, stack: error.stack })); process.exitCode = 1; });

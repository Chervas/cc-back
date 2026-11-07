'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fail = code => { throw Object.assign(Error(code), { code, status: 409 }); };
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
function routes(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) fail('meta_lead_route_invalid');
  const seen = new Set();
  return value.map(row => {
    if (!row || Object.getPrototypeOf(row) !== Object.prototype
      || Object.keys(row).sort().join(',') !== 'adAccountAssetRef,pageAssetRef,recipientClinicId'
      || !/^meta-facebook_page:[1-9][0-9]{0,29}$/.test(row.pageAssetRef)
      || !/^meta-ad_account:[1-9][0-9]{0,29}$/.test(row.adAccountAssetRef)
      || !positive(row.recipientClinicId) || seen.has(row.pageAssetRef)) fail('meta_lead_route_invalid');
    seen.add(row.pageAssetRef);
    return { pageAssetRef: row.pageAssetRef, adAccountAssetRef: row.adAccountAssetRef, recipientClinicId: row.recipientClinicId };
  }).sort((left, right) => left.pageAssetRef.localeCompare(right.pageAssetRef));
}
async function loadRoute({ models, page, account, transaction = null }) {
  if (page.scopeKey !== account.scopeKey || JSON.stringify(page.clinicIds) !== JSON.stringify(account.clinicIds)) fail('meta_lead_route_invalid');
  const [scope_type, scopeId] = page.scopeKey.split(':');
  const options = { raw: true, logging: false, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) };
  const setting = await models.CampaignWorkspaceSetting.findOne({ where: { scope_type, scope_id: Number(scopeId) },
    attributes: ['id', 'version', 'preferences'], ...options });
  if (setting && (!Number.isSafeInteger(Number(setting.version)) || Number(setting.version) < 1)) fail('meta_lead_route_invalid');
  const normalized = routes(setting?.preferences?.meta_lead_routes);
  const selected = normalized.find(row => row.pageAssetRef === page.assetRef);
  if (selected && selected.adAccountAssetRef !== account.assetRef) fail('meta_lead_route_invalid');
  const recipientClinicId = selected?.recipientClinicId ?? null;
  if (recipientClinicId !== null) {
    if (!page.clinicIds.includes(recipientClinicId)) fail('meta_lead_route_invalid');
    const clinic = await models.Clinica.findByPk(recipientClinicId, { attributes: ['id_clinica', 'grupoClinicaId', 'estado_clinica'], ...options });
    if (!clinic || ![true, 1, '1'].includes(clinic.estado_clinica)
      || scope_type === 'group' && Number(clinic.grupoClinicaId) !== Number(scopeId)) fail('meta_lead_route_invalid');
  }
  return { recipientClinicId, digest: createHash('sha256').update(JSON.stringify([page.scopeKey,
    setting?.id ?? null, setting ? Number(setting.version) : null, normalized])).digest('hex') };
}
// Explicit business configuration writer for the administrative operator. It
// has no public webhook endpoint and cannot infer a route from clinic names,
// provider data, mapping representatives or submitted contact fields.
async function saveRegistry({ models, reader, scope, actorId, expectedVersion, value, authorize, now = () => new Date() }) {
  if (!positive(actorId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion >= 4294967295 || typeof authorize !== 'function') fail('meta_lead_route_invalid');
  const normalized = routes(value), owner = require('./campaignWorkspaceSettings.service').settingScope(scope);
  if (!Array.isArray(scope.clinicIds) || !scope.clinicIds.length) fail('meta_lead_route_invalid');
  if (await authorize({ userId: actorId, clinicIds: scope.clinicIds, access: 'write' }) !== true) fail('meta_lead_route_forbidden');
  const pairs = [];
  for (const row of normalized) {
    if (!scope.clinicIds.includes(row.recipientClinicId)) fail('meta_lead_route_invalid');
    const ids = [];
    for (const assetRef of [row.pageAssetRef, row.adAccountAssetRef]) {
      const bindings = await models.MetaMarketingBrokerBinding.findAll({ where: { asset_ref: assetRef,
        scope_key: `${owner.scope_type}:${owner.scope_id}`, state: 'active' }, attributes: ['mapping_id'], raw: true, logging: false, limit: 2 });
      if (bindings.length !== 1) fail('meta_lead_route_invalid');
      ids.push(Number(bindings[0].mapping_id));
    }
    pairs.push(await reader.preparePair(...ids));
  }
  return models.sequelize.transaction(async transaction => {
    if (await authorize({ userId: actorId, clinicIds: scope.clinicIds, access: 'write', transaction }) !== true) fail('meta_lead_route_forbidden');
    for (const pair of pairs) await reader.assertPair(pair, { transaction });
    const setting = await models.CampaignWorkspaceSetting.findOne({ where: owner, transaction, lock: transaction.LOCK.UPDATE });
    if (!setting || Number(setting.version) !== expectedVersion) fail('meta_lead_route_version_conflict');
    const previous = routes(setting.preferences?.meta_lead_routes);
    if (JSON.stringify(previous) === JSON.stringify(normalized)) return { changed: false, version: expectedVersion };
    for (const route of normalized) {
      const clinic = await models.Clinica.findByPk(route.recipientClinicId, { attributes: ['id_clinica', 'grupoClinicaId', 'estado_clinica'],
        raw: true, transaction, lock: transaction.LOCK.UPDATE });
      if (!clinic || ![true, 1, '1'].includes(clinic.estado_clinica)
        || scope.groupId && Number(clinic.grupoClinicaId) !== scope.groupId) fail('meta_lead_route_invalid');
    }
    const version = expectedVersion + 1;
    const [changed] = await models.CampaignWorkspaceSetting.update({ version, preferences: {
      ...(setting.preferences || {}), meta_lead_routes: normalized }, updated_by_user_id: actorId },
    { where: { id: setting.id, version: expectedVersion }, transaction });
    if (changed !== 1) fail('meta_lead_route_version_conflict');
    await models.CampaignWorkspaceEvent.create({ id: randomUUID(), setting_id: setting.id, version, actor_user_id: actorId,
      event_type: 'meta_lead_routes_saved', changes: { meta_lead_routes: { before: previous, after: normalized } }, created_at: now() }, { transaction });
    return { changed: true, version };
  });
}
module.exports = { routes, loadRoute, saveRegistry };

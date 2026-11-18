'use strict';

const { createHash } = require('node:crypto');
const { Op } = require('sequelize');
const { accountAliases } = require('./campaignWorkspaceReport.service');
const { metaCreativeContext } = require('./campaignAdCreative.service');
const { createMetaMarketingBrokerScope, createMetaMarketingScopeRepository, MAPPING_FIELDS } = require('./metaMarketingBrokerScope.service');

const fail = (code, status = 409) => { throw Object.assign(Error(code), { code, status }); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded = rows => {
  if (!Array.isArray(rows) || rows.length > 1000) fail('meta_broker_binding_invalid');
  return rows;
};

// This authorizes existing SQL/cache material, never a provider operation. Use
// the ordinary broker scope repository without constructing a transport client
// or borrowing the separate AdsSync admission flag.
function createAdSharingAuthority({ models, createScope = () => createMetaMarketingBrokerScope(createMetaMarketingScopeRepository(() => models)) }) {
  const phases = new WeakMap();
  const brokerContexts = new Map();
  let brokerScope;

  async function capture({ scope, reference, inventory, campaign }, key) {
    const aliases = accountAliases('meta_ads', reference.account_id);
    const options = { raw: true, logging: false, limit: 1001 };
    // Inspect every physical alias, including inactive/out-of-scope aliases.
    // Independent security records survive deletion of a local mapping.
    const mappings = bounded(await models.ClinicMetaAsset.findAll({ ...options,
      attributes: MAPPING_FIELDS, where: { assetType: 'ad_account', metaAssetId: { [Op.in]: aliases } }, order: [['id', 'ASC']] }));
    const assetRef = `meta-ad_account:${reference.account_id}`;
    const connectionIds = [...new Set(mappings.map(row => Number(row.metaConnectionId)))];
    const [bindings, revocations, claims, connections] = await Promise.all([
      models.MetaMarketingBrokerBinding.findAll({ ...options, attributes: ['mapping_id', 'asset_ref', 'state'],
        where: { [Op.or]: [{ asset_ref: assetRef }, ...(mappings.length ? [{ mapping_id: { [Op.in]: mappings.map(row => row.id) } }] : [])] } }),
      models.MetaMarketingBrokerRevocation.findAll({ ...options, attributes: ['tuple_hash'], where: { asset_ref: assetRef } }),
      models.MetaMarketingEnrollmentClaim.findAll({ ...options, attributes: ['asset_ref', 'enrollment_id'], where: { asset_ref: assetRef } }),
      connectionIds.length ? models.MetaConnection.findAll({ ...options, attributes: ['id', 'credentials_external', 'broker_app_id'],
        where: { id: { [Op.in]: connectionIds } } }) : [],
    ]);
    for (const rows of [bindings, revocations, claims, connections]) bounded(rows);
    const migrated = bindings.length || revocations.length || claims.length
      || connections.some(row => ![false, 0].includes(row.credentials_external) || row.broker_app_id != null) || brokerContexts.has(key);
    if (!migrated) return { authority: 'legacy' };
    // A malformed, staged, revoked or partially deleted broker installation is
    // still broker-exclusive. Never retry it using a remaining legacy token.
    if (revocations.length) fail('asset_revoked');
    const clinicId = Number(campaign.clinicId);
    const clinic = inventory.selectedClinics.find(row => Number(row.id_clinica) === clinicId);
    const candidates = mappings.filter(row => [true, 1].includes(row.isActive)
      && (row.assignmentScope === 'clinic' && Number(row.clinicaId) === clinicId
        || row.assignmentScope === 'group' && clinic?.grupoClinicaId != null && Number(row.grupoClinicaId) === Number(clinic.grupoClinicaId)));
    if (!candidates.length) fail('workspace_meta_permissions_required');
    brokerScope ||= createScope();
    let context = brokerContexts.get(key);
    if (!context) {
      context = await brokerScope.prepare(candidates[0].id);
      brokerContexts.set(key, context);
    }
    // The second phase asserts the original opaque capability, not a freshly
    // prepared replacement that could hide a credential/grant generation change.
    const state = await brokerScope.assertContext(context);
    if (state.kind !== 'ad_account' || state.id !== reference.account_id || state.assetRef !== assetRef
      || !state.clinicIds.includes(clinicId) || !candidates.some(row => Number(row.id) === state.mappingId)) fail('scope_denied');
    return { authority: 'broker', state };
  }

  return async function authorize(args) {
    const { scope, reference, inventory, campaign } = args;
    if (reference.provider !== 'meta_ads' || !campaign.assigned || !scope.clinicIds.map(Number).includes(Number(campaign.clinicId))) fail('scope_denied');
    const key = JSON.stringify([reference.account_id, Number(campaign.clinicId), scope.clinicIds.map(Number).sort((a, b) => a - b)]);
    if (!phases.has(args.models)) phases.set(args.models, new Map());
    const phase = phases.get(args.models);
    if (!phase.has(key)) phase.set(key, capture({ scope, reference, inventory, campaign }, key));
    let captured;
    try { captured = await phase.get(key); } catch (error) {
      if (error.code) error.status = 409;
      throw error;
    }
    if (captured.authority === 'legacy') return { ...await metaCreativeContext(args), authority: 'legacy' };
    const aliases = accountAliases('meta_ads', reference.account_id);
    const entity = await args.models.SocialAdsEntity.findOne({ where: { level: 'ad', ad_account_id: { [Op.in]: aliases },
      entity_id: reference.ad_id, parent_id: reference.group_id }, raw: true });
    const group = entity && await args.models.SocialAdsEntity.findOne({ where: { level: 'adset', ad_account_id: { [Op.in]: aliases },
      entity_id: reference.group_id, parent_id: reference.campaign_id }, raw: true });
    if (!entity || !group) fail('workspace_ad_not_in_scope', 404);
    return { authority: 'broker', entity, group, fingerprint: hash([reference, Number(campaign.clinicId),
      scope.clinicIds.map(Number).sort((a, b) => a - b), captured.state, entity.updated_time || null]) };
  };
}

module.exports = { createAdSharingAuthority };

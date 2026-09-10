'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { extractMetaWebAttribution, metaWebAdvertisingIdentity } = require('../lib/meta-web-attribution');
const { canonicalizeIntakeDomain, canonicalizeIntakeDomains } = require('../lib/intake-verification-attestation');
const { resolveWorkspaceWebSignalContext } = require('./campaignWorkspaceWebSignalContext.service');
const { loadSignalRoutingScope, resolveWorkspaceSignalRoute } = require('./campaignWorkspaceSignalRouting.service');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeKey = row => `${row.assignmentScope}:${row.assignmentScope === 'group' ? row.grupoClinicaId : row.clinicaId}`;
const eventKey = value => String(value || '').replace(/[_\s-]/g, '').toLowerCase();

async function readMetaWebInventory({ models, campaignIds, accountIds = [], transaction = null }) {
  const options = { raw: true, transaction };
  const refs = accountIds.flatMap(value => [value, `act_${value}`]);
  const stored = await models.ExternalCampaignInventory.findAll({ where: { provider: 'meta_ads', campaign_id: { [Op.in]: campaignIds },
    ...(refs.length ? { customer_id: { [Op.in]: refs } } : {}) }, attributes: ['provider', 'customer_id', 'campaign_id'], ...options });
  const social = await models.SocialAdsEntity.findAll({ where: { level: 'campaign', entity_id: { [Op.in]: campaignIds },
    ...(refs.length ? { ad_account_id: { [Op.in]: refs } } : {}) }, attributes: ['ad_account_id', 'entity_id'], ...options });
  const inventory = [...stored, ...social.map(row => ({ provider: 'meta_ads', customer_id: row.ad_account_id, campaign_id: row.entity_id }))];
  const { accountId } = require('./campaignWorkspaceReport.service');
  const accounts = [...new Set(inventory.flatMap(row => [accountId(row.customer_id), `act_${accountId(row.customer_id)}`]))];
  if (!accounts.length) return { inventory: [], assets: [], assignments: [], decisions: [] };
  // Read all owners so a shared account cannot be attributed to whichever clinic requested the form.
  const assets = await models.ClinicMetaAsset.findAll({ where: { assetType: 'ad_account', isActive: true,
    metaAssetId: { [Op.in]: accounts } }, ...options });
  const assignments = assets.length ? await models.MetaConnectionAssignment.findAll({ where: { status: 'active',
    scopeKey: { [Op.in]: [...new Set(assets.map(scopeKey))] } }, ...options }) : [];
  const decisions = await models.ExternalCampaignAssignment.findAll({ where: { provider: 'meta_ads', campaign_id: { [Op.in]: campaignIds },
    customer_id: { [Op.in]: accounts } }, ...options });
  return { inventory, assets, assignments, decisions };
}

async function resolveMetaWebAdvertisingIdentity({ models, clinicId, recordId, attribution, eventSourceUrl = null,
  transaction = null, webRecords = null, clinic: suppliedClinic = null, snapshot = null }) {
  if (!attribution?.campaign_id || !/^[0-9]{1,64}$/.test(attribution.campaign_id)
    || attribution.account_id && !/^[0-9]{1,64}$/.test(attribution.account_id)) return null;
  const options = { raw: true, transaction };
  const clinic = suppliedClinic || await models.Clinica.findByPk(clinicId, options);
  const web = await resolveWorkspaceWebSignalContext({ models, clinic, recordId, transaction, records: webRecords });
  if (eventSourceUrl) {
    let url; try { url = new URL(eventSourceUrl); } catch { fail('workspace_meta_web_origin_required'); }
    if (url.protocol !== 'https:' || url.username || url.password
      || !canonicalizeIntakeDomains(web.record.domains).includes(canonicalizeIntakeDomain(url.hostname))) fail('workspace_meta_web_origin_required');
  }
  const data = snapshot || await readMetaWebInventory({ models, campaignIds: [attribution.campaign_id],
    accountIds: attribution.account_id ? [attribution.account_id] : [], transaction });
  const { accountId, mappingIdentity, visibleCampaigns } = require('./campaignWorkspaceReport.service');
  const inventory = data.inventory.filter(row => row.campaign_id === attribution.campaign_id
    && (!attribution.account_id || accountId(row.customer_id) === attribution.account_id));
  const authorized = data.assets.filter(asset => data.assignments.some(row => row.scopeKey === scopeKey(asset)
    && Number(row.metaConnectionId) === Number(asset.metaConnectionId)));
  const decisions = data.decisions.filter(row => row.campaign_id === attribution.campaign_id);
  const campaigns = visibleCampaigns({ scope: { clinicIds: [clinicId], memberGroupIds: clinic.grupoClinicaId ? [clinic.grupoClinicaId] : [] },
    inventory, assignments: decisions, mappings: authorized.map(row => mappingIdentity(row, 'meta_ads')) })
    .filter(row => row.assigned && row.clinicId === clinicId && (!attribution.account_id || row.account_id === attribution.account_id));
  if (campaigns.length !== 1) return null;
  const campaign = campaigns[0];
  const owners = authorized.filter(row => accountId(row.metaAssetId) === campaign.account_id);
  const reviews = decisions.filter(row => accountId(row.customer_id) === campaign.account_id);
  return { version: 2, verified_by: 'workspace_web_inventory', provider: 'meta_ads', clinic_id: clinicId,
    account_id: campaign.account_id, campaign_id: campaign.campaign_id, intake_config_id: Number(web.record.id),
    web_fingerprint: web.fingerprint, campaign_binding: hash([
      owners.map(row => [Number(row.id), scopeKey(row), Number(row.metaConnectionId)]).sort(),
      reviews.map(row => [Number(row.id), Number(row.clinica_id), row.status]).sort(),
    ]) };
}

function metaWebDestinationKey(route, identity) { return hash([route.destinationKey, identity]); }

async function resolveMetaWebSignalContext({ models, input, now = new Date(), transaction = null }) {
  const identity = metaWebAdvertisingIdentity(input.webIdentity, input.clinicId);
  if (!identity) fail('workspace_meta_web_identity_required');
  const current = await resolveMetaWebAdvertisingIdentity({ models, clinicId: input.clinicId,
    recordId: identity.intake_config_id, attribution: identity, transaction,
    eventSourceUrl: ['lead', 'contact'].includes(eventKey(input.eventName)) ? input.eventSourceUrl : null });
  if (!current || JSON.stringify(current) !== JSON.stringify(identity)) fail('workspace_meta_web_source_changed');
  const route = await resolveWorkspaceSignalRoute({ models, provider: 'meta_ads', clinicId: input.clinicId,
    accountId: identity.account_id, campaignId: identity.campaign_id, eventName: input.eventName, crmEventSource: input.crmEventSource, now, transaction });
  if (!route || route.destinationId !== input.pixelId || input.adAccountId !== identity.account_id
    || input.campaignId !== identity.campaign_id) fail('workspace_meta_destination_changed');
  return { destinationKey: metaWebDestinationKey(route, current), accessToken: route.accessToken, connectionId: route.connectionId,
    workspaceAuthorization: route.authorization, webPolicyRecord: null, signalPolicyRecord: null };
}

async function sendCampaignMetaWebEvent(input, dependencies = {}) {
  const models = dependencies.models || require('../../models');
  const now = (dependencies.now || (() => new Date()))();
  const existing = dependencies.existing || require('./metaCapi.service').sendMetaEvent;
  try {
    if (!Number.isSafeInteger(input.clinicId) || input.clinicId < 1) {
      if (input.webPolicyRecord?.assignment_scope === 'group') {
        const setting = await models.CampaignWorkspaceSetting.findOne({ where: { scope_type: 'group',
          scope_id: Number(input.webPolicyRecord.group_id) }, raw: true });
        if (setting?.activation && setting.activation.schema_version !== 1) fail('workspace_clinic_required');
      }
      return existing(input);
    }
    const scope = await loadSignalRoutingScope({ models, clinicId: input.clinicId });
    if (!scope.settings.some(row => row.activation && row.activation.schema_version !== 1)) return existing(input);
    if (!['lead', 'contact', 'qualifiedlead', 'schedule'].includes(eventKey(input.eventName))) fail('workspace_event_not_authorized');
    if (input.advertisingConsent !== true) return { sent: false, reason: 'consent_not_granted' };
    if (input.requirePersistedIdentity && !input.webIdentity) fail('workspace_meta_web_identity_required');
    const identity = input.webIdentity || await resolveMetaWebAdvertisingIdentity({ models, clinicId: input.clinicId,
      recordId: input.webPolicyRecord?.id, attribution: extractMetaWebAttribution(input.attribution), eventSourceUrl: input.eventSourceUrl });
    if (!identity) fail('workspace_meta_web_identity_required');
    const route = await resolveWorkspaceSignalRoute({ models, provider: 'meta_ads', clinicId: input.clinicId,
      accountId: identity.account_id, campaignId: identity.campaign_id, eventName: input.eventName, crmEventSource: input.crmEventSource, now });
    if (!route) fail('workspace_signal_authorization_unavailable');
    const validateSource = async () => {
      await dependencies.validateSource?.(input);
      if (!input.requirePersistedIdentity) return;
      const lead = await models.LeadIntake.findByPk(input.leadId, { attributes: ['id', 'clinica_id', 'source', 'external_source',
        'archived_at', 'status_lead', 'consentimiento_canal'], raw: true });
      if (!lead || Number(lead.clinica_id) !== input.clinicId || lead.archived_at || lead.status_lead === 'descartado'
        || require('./googleAdsConversionUpload.service').normalizeGoogleConsent(lead.consentimiento_canal) !== 'GRANTED') fail('workspace_meta_web_source_changed');
      const persisted = await require('./leadAdvertisingIdentity.service').resolveMetaWebLeadIdentity({ models, lead });
      if (JSON.stringify(persisted) !== JSON.stringify(identity)) fail('workspace_meta_web_source_changed');
    };
    return await (dependencies.deliver || require('./metaWorkspaceSignalDelivery.service').sendWorkspaceMetaSignal)({
      ...input, webIdentity: identity, adAccountId: identity.account_id, campaignId: identity.campaign_id,
      pixelId: route.destinationId, accessToken: null,
    }, { ...dependencies, validateSource });
  } catch (error) {
    if (/^workspace_/.test(error.code || '')) return { sent: false, reason: error.code };
    throw error;
  }
}

module.exports = { readMetaWebInventory, resolveMetaWebAdvertisingIdentity, resolveMetaWebSignalContext, metaWebDestinationKey, sendCampaignMetaWebEvent };

'use strict';

const { Op } = require('sequelize');
const { extractWebAdAttribution, webAdAdvertisingIdentity, WEB_AD_SOURCES } = require('../lib/web-ad-attribution');
const { canonicalizeIntakeDomain, canonicalizeIntakeDomains } = require('../lib/intake-verification-attestation');
const { resolveWorkspaceWebSignalContext } = require('./campaignWorkspaceWebSignalContext.service');
const { metaWebAdvertisingIdentity } = require('../lib/meta-web-attribution');

// Local inventory validates membership, not the authenticity of an advertising click.
// This optional enrichment never calls a provider or enables signal delivery.
async function resolveWorkspaceWebAdIdentity({ models, body, clinicId, recordId, source, externalSource, metaIdentity = null,
  eventSourceUrl, now = new Date(), transaction = null }, dependencies = {}) {
  const candidate = extractWebAdAttribution(body);
  if (!candidate || !Number.isSafeInteger(clinicId) || !WEB_AD_SOURCES.includes(source)
    || ['google_lead_form', 'meta_leadgen'].includes(externalSource)) return null;
  const { accountAliases } = require('./campaignWorkspaceReport.service');
  const loadInventory = dependencies.loadInventory || require('./campaignWorkspace.service').loadWorkspaceInventory;
  const inventory = await loadInventory({ models, scope: { clinicIds: [clinicId], groupId: null }, accountReference: candidate, transaction });
  const clinic = inventory.selectedClinics.find(row => Number(row.id_clinica) === clinicId);
  const campaign = inventory.campaigns.find(row => row.assigned && row.clinicId === clinicId && row.provider === candidate.provider
    && row.account_id === candidate.account_id && row.campaign_id === candidate.campaign_id);
  if (!campaign) return null;
  let meta = null;
  if (candidate.provider === 'meta_ads') {
    meta = metaWebAdvertisingIdentity(metaIdentity, clinicId);
    if (!meta || meta.account_id !== candidate.account_id || meta.campaign_id !== candidate.campaign_id) return null;
  }
  const web = await (dependencies.resolveWeb || resolveWorkspaceWebSignalContext)({ models, clinic, recordId, transaction });
  if (meta && (meta.intake_config_id !== Number(web.record.id) || meta.web_fingerprint !== web.fingerprint)) return null;
  let origin; try { origin = new URL(eventSourceUrl); } catch { return null; }
  if (origin.protocol !== 'https:' || origin.username || origin.password
    || !canonicalizeIntakeDomains(web.record.domains).includes(canonicalizeIntakeDomain(origin.hostname))) return null;
  const aliases = accountAliases(candidate.provider, candidate.account_id);
  let groups;
  if (candidate.provider === 'google_ads') {
    const rows = await models.GoogleAdsAdInsightsDaily.findAll({ where: { customerId: { [Op.in]: aliases }, campaignId: candidate.campaign_id,
      adId: candidate.ad_id }, attributes: ['adGroupId'], group: ['adGroupId'], raw: true, transaction });
    groups = rows.map(row => row.adGroupId);
  } else {
    const rows = await models.SocialAdsEntity.findAll({ where: { level: 'ad', ad_account_id: { [Op.in]: aliases }, entity_id: candidate.ad_id },
      attributes: ['parent_id'], raw: true, transaction });
    const ids = [...new Set(rows.map(row => row.parent_id).filter(Boolean))];
    const adsets = ids.length ? await models.SocialAdsEntity.findAll({ where: { level: 'adset', ad_account_id: { [Op.in]: aliases },
      entity_id: { [Op.in]: ids }, parent_id: candidate.campaign_id }, attributes: ['entity_id'], raw: true, transaction }) : [];
    groups = adsets.map(row => row.entity_id);
  }
  const matches = [...new Set(groups.filter(group => !candidate.adgroup_id || candidate.adgroup_id === group))];
  if (matches.length !== 1) return null;
  return webAdAdvertisingIdentity({ version: 1, verified_by: 'workspace_web_ad_inventory', ...candidate,
    adgroup_id: matches[0], clinic_id: clinicId, intake_config_id: Number(web.record.id), web_fingerprint: web.fingerprint,
    verified_at: now.toISOString() }, clinicId);
}

module.exports = { resolveWorkspaceWebAdIdentity };

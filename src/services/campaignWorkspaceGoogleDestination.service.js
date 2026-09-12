'use strict';

const crypto = require('node:crypto');
const { settingScope } = require('./campaignWorkspaceSettings.service');
const { receptionAccount, receivingClinic } = require('./googleLeadReception.service');
const { googleAdsSearchRows } = require('../lib/googleAdsSearchRows');
const { googleUrlExpansionOptedOut } = require('../lib/googleAdsCampaignMeasurementDiagnosis');
const { ensureGoogleConnectionAccessToken, GOOGLE_ADS_SCOPE } = require('./googleAdsScopedRuntime.service');

const SOURCE = 'workspace_google_ads';
const TTL_MS = 86400000;
const CACHE_KEY = 'workspace_google';
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value || null)).digest('hex');
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const queryOptions = transaction => ({ raw: true, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });

function googleCampaignReference(input, write = false) {
  const keys = ['account_id', 'campaign_id', ...(write ? ['revision'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))
    || !id(input.account_id) || !id(input.campaign_id) || write && !/^[a-f0-9]{64}$/.test(input.revision || '')) fail('invalid_google_destination', 400);
  return { provider: 'google_ads', account_id: input.account_id, campaign_id: input.campaign_id };
}

function googleDestinationDetection(raw) {
  const value = raw?.[CACHE_KEY];
  return value?.source === SOURCE && value.version === 1 ? value : null;
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

async function saveObservedGoogleDestination({ models, reference, detection }) {
  const { account_id: customerId, campaign_id: campaignId } = googleCampaignReference(reference);
  // Both the nightly writer and the interactive check lock the current row before merging JSON.
  return models.sequelize.transaction(async transaction => {
    const inventory = await models.ExternalCampaignInventory.findOne({ where: { provider: 'google_ads',
      customer_id: customerId, campaign_id: campaignId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!inventory) return 0;
    const current = inventory.destination_detection && typeof inventory.destination_detection === 'object' ? inventory.destination_detection : {};
    const freshUrls = Array.isArray(detection.urls) && detection.urls.length > 0;
    await inventory.update({ destination_detection: { ...current, ...detection, [CACHE_KEY]: current[CACHE_KEY],
      ...(!freshUrls && Array.isArray(current.urls) && current.urls.length ? {
        status: 'observed_stale', urls: current.urls, domains: current.domains || [], primary_url: current.primary_url || current.urls[0],
        observed_destination_count: current.observed_destination_count || current.urls.length,
        expanded_beyond_primary: detection.url_expansion_enabled === true && current.urls.length > 1,
      } : {}),
    } }, { transaction });
    return 1;
  });
}

async function googleDestinationContext({ models, scope, reference, loadInventory, transaction = null, now = new Date() }) {
  const owner = settingScope(scope); const options = queryOptions(transaction);
  const ownerRow = await (scope.groupId ? models.GrupoClinica : models.Clinica).findByPk(owner.scope_id, options);
  if (!ownerRow) fail('scope_not_found', 404);
  const inventory = await loadInventory({ models, scope, transaction });
  const campaign = inventory.campaigns.find(row => row.provider === 'google_ads'
    && row.account_id === reference.account_id && row.campaign_id === reference.campaign_id);
  if (!campaign) fail('workspace_campaign_not_in_scope', 403);
  if (!campaign.assigned) fail('workspace_clinic_assignment_required');
  const setting = await models.CampaignWorkspaceSetting.findOne({ where: owner, ...options });
  if (!setting) fail('workspace_account_not_selected', 403);
  let account;
  try { account = await receptionAccount({ models, settingId: setting.id, accountId: reference.account_id, now, transaction }); }
  catch (error) {
    if (!/^google_lead_/.test(error.code || '')) throw error;
    fail('workspace_google_permissions_required');
  }
  if (JSON.stringify(account.members.map(row => Number(row.id_clinica)).sort((a, b) => a - b))
    !== JSON.stringify([...scope.clinicIds].sort((a, b) => a - b))) fail('workspace_scope_changed');
  let clinic;
  try { clinic = await receivingClinic({ models, context: account, identity: reference, transaction }); }
  catch (error) {
    if (!/^google_lead_/.test(error.code || '')) throw error;
    fail(error.code === 'google_lead_campaign_not_selected' ? 'workspace_account_not_selected' : 'workspace_clinic_assignment_required');
  }
  if (Number(clinic.id_clinica) !== campaign.clinicId) fail('workspace_scope_changed');
  const rows = await models.ExternalCampaignInventory.findAll({ where: { provider: 'google_ads',
    customer_id: reference.account_id, campaign_id: reference.campaign_id }, ...options });
  if (rows.length !== 1) fail('workspace_google_inventory_ambiguous');
  const cached = rows[0]; const detection = googleDestinationDetection(cached.destination_detection);
  return { campaign, account, cached, detection, revision: hash(detection) };
}

// Inspect only configuration metadata. No submissions, form answers or webhook credentials are requested.
async function inspectGoogleDestinations({ reference, accessToken, loginCustomerId, read = googleAdsSearchRows, now = new Date() }) {
  const { account_id: accountId, campaign_id: campaignId } = reference;
  const deadline = Date.now() + 50000;
  const search = async query => {
    const remaining = deadline - Date.now();
    if (remaining < 1000) fail('workspace_google_check_timeout');
    const rows = await read({ customerId: accountId, accessToken, loginCustomerId, query: `${query} LIMIT 2001`, maxPages: 5, timeoutMs: remaining });
    if (!Array.isArray(rows) || rows.length > 2000 || rows.some(row => String(row.customer?.id) !== accountId)) fail('workspace_google_destination_incomplete');
    return rows;
  };
  const campaignRows = await search(`SELECT customer.id, campaign.id, campaign.advertising_channel_type, campaign.asset_automation_settings
    FROM campaign WHERE campaign.id = ${campaignId} AND campaign.status != 'REMOVED'`);
  if (campaignRows.length !== 1 || String(campaignRows[0].campaign?.id) !== campaignId) fail('workspace_google_campaign_unavailable');
  const campaign = campaignRows[0].campaign;
  const groups = await search(`SELECT customer.id, campaign.id, ad_group.id FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.status != 'REMOVED'`);
  const groupIds = new Set(groups.map(row => String(row.adGroup?.id)));
  const formFields = 'asset.id, asset.name, asset.lead_form_asset.headline';
  const campaignForms = await search(`SELECT customer.id, campaign.id, campaign_asset.status, ${formFields}
    FROM campaign_asset WHERE campaign.id = ${campaignId} AND campaign_asset.field_type = 'LEAD_FORM' AND campaign_asset.status = 'ENABLED'`);
  const accountForms = await search(`SELECT customer.id, customer_asset.status, ${formFields}
    FROM customer_asset WHERE customer_asset.field_type = 'LEAD_FORM' AND customer_asset.status = 'ENABLED'`);
  const groupForms = await search(`SELECT customer.id, campaign.id, ad_group.id, ad_group_asset.status, ${formFields}
    FROM ad_group_asset WHERE campaign.id = ${campaignId} AND ad_group_asset.field_type = 'LEAD_FORM' AND ad_group_asset.status = 'ENABLED'`);
  const assetGroups = campaign.advertisingChannelType === 'PERFORMANCE_MAX' ? await search(`SELECT customer.id, asset_group.id,
    asset_group.campaign, asset_group.final_urls, asset_group.final_mobile_urls FROM asset_group
    WHERE asset_group.campaign = 'customers/${accountId}/campaigns/${campaignId}' AND asset_group.status != 'REMOVED'`) : [];
  const assetForms = campaign.advertisingChannelType === 'PERFORMANCE_MAX' ? await search(`SELECT customer.id, asset_group.id,
    asset_group.campaign, asset_group_asset.status, ${formFields} FROM asset_group_asset
    WHERE asset_group.campaign = 'customers/${accountId}/campaigns/${campaignId}' AND asset_group_asset.field_type = 'LEAD_FORM' AND asset_group_asset.status = 'ENABLED'`) : [];
  const ads = await search(`SELECT customer.id, campaign.id, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.type,
    ad_group_ad.ad.final_urls, ad_group_ad.ad.final_mobile_urls FROM ad_group_ad
    WHERE campaign.id = ${campaignId} AND ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED'`);
  for (const row of [...groups, ...campaignForms, ...groupForms, ...ads]) if (String(row.campaign?.id) !== campaignId) fail('workspace_google_destination_identity_mismatch');
  for (const row of [...assetGroups, ...assetForms]) if (row.assetGroup?.campaign !== `customers/${accountId}/campaigns/${campaignId}`) fail('workspace_google_destination_identity_mismatch');
  if (groups.some(row => !id(String(row.adGroup?.id)))) fail('workspace_google_destination_identity_mismatch');
  const forms = new Map(); const reasons = new Set(); const urls = new Set();
  const addForms = (rows, level) => rows.forEach(row => {
    const formId = String(row.asset?.id || '');
    if (!id(formId) || !row.asset?.leadFormAsset?.headline) fail('workspace_google_destination_incomplete');
    const form = { form_id: formId, name: String(row.asset.name || row.asset.leadFormAsset.headline).slice(0, 255), metadata_accessible: true };
    const previous = forms.get(formId);
    if (previous && previous.name !== form.name) fail('workspace_google_destination_identity_mismatch');
    forms.set(formId, { ...form, levels: [...new Set([...(previous?.levels || []), level])] });
  });
  // Specific links override inherited ones. Keep all remaining applicable groups in the coverage check.
  const baseForms = campaignForms.length ? campaignForms : accountForms;
  const overriddenGroups = new Set(groupForms.filter(row => groupIds.has(String(row.adGroup?.id))).map(row => String(row.adGroup.id)));
  const assetGroupIds = new Set(assetGroups.map(row => String(row.assetGroup?.id)));
  if (groupForms.some(row => !groupIds.has(String(row.adGroup?.id)))
    || assetForms.some(row => !assetGroupIds.has(String(row.assetGroup?.id)))) fail('workspace_google_destination_identity_mismatch');
  const overriddenAssetGroups = new Set(assetForms.filter(row => assetGroupIds.has(String(row.assetGroup?.id))).map(row => String(row.assetGroup.id)));
  if ((!groupIds.size && !assetGroupIds.size) || [...groupIds].some(group => !overriddenGroups.has(group))
    || [...assetGroupIds].some(group => !overriddenAssetGroups.has(group))) addForms(baseForms, campaignForms.length ? 'campaign' : 'account');
  addForms(groupForms.filter(row => groupIds.has(String(row.adGroup?.id))), 'ad_group');
  addForms(assetForms.filter(row => assetGroupIds.has(String(row.assetGroup?.id))), 'asset_group');
  const readUrls = (values, fallback = []) => {
    if (values != null && !Array.isArray(values)) fail('workspace_google_destination_incomplete');
    const list = values || fallback;
    for (const value of list) { const url = safeUrl(value); if (url) urls.add(url); else reasons.add('unsupported_url'); }
    return list.length;
  };
  for (const row of ads) {
    const ad = row.adGroupAd?.ad;
    if (!id(String(ad?.id)) || !groupIds.has(String(row.adGroup?.id))) fail('workspace_google_destination_identity_mismatch');
    const count = readUrls(ad.finalUrls) + readUrls(ad.finalMobileUrls);
    const applicableForms = overriddenGroups.has(String(row.adGroup.id)) ? groupForms.filter(form => form.adGroup.id === row.adGroup.id) : baseForms;
    if (!ad.type || /CALL|APP|TRAVEL|SHOPPING|HOTEL/.test(ad.type) || !count && !applicableForms.length) reasons.add('unsupported_ad_destination');
    if (/DYNAMIC_SEARCH/.test(ad.type || '')) reasons.add('dynamic_web_destinations');
  }
  for (const row of assetGroups) {
    if (!id(String(row.assetGroup.id))) fail('workspace_google_destination_identity_mismatch');
    readUrls(row.assetGroup.finalUrls); readUrls(row.assetGroup.finalMobileUrls);
  }
  if (campaign.advertisingChannelType === 'PERFORMANCE_MAX' && !googleUrlExpansionOptedOut(campaign)) reasons.add('dynamic_web_destinations');
  if (!ads.length && !assetGroups.length) reasons.add('no_ads');
  if (!forms.size && !urls.size) reasons.add('no_destinations');
  return { version: 1, source: SOURCE, status: 'checked', checked_at: now.toISOString(), account_id: accountId,
    campaign_id: campaignId, kind: forms.size && urls.size ? 'mixed' : forms.size ? 'lead_form' : urls.size ? 'web' : 'unknown',
    complete: reasons.size === 0, unknown_reasons: [...reasons], forms: [...forms.values()], urls: [...urls], ad_count: ads.length };
}

async function refreshGoogleDestinations({ models, scope, actorId, input, hasAccess, loadInventory,
  now = () => new Date(), read, ensureToken = ensureGoogleConnectionAccessToken }) {
  const reference = googleCampaignReference(input, true);
  const permitted = async () => {
    if (!Number.isSafeInteger(actorId) || actorId < 1 || !hasAccess || !await hasAccess({ userId: actorId, clinicIds: scope.clinicIds, access: 'write' })) fail('marketing_scope_forbidden', 403);
  };
  const store = async (context, value, transaction) => models.ExternalCampaignInventory.update({ destination_detection: {
    ...context.cached.destination_detection, [CACHE_KEY]: value,
  } }, { where: { id: context.cached.id }, transaction });
  const runId = crypto.randomUUID();
  const started = await models.sequelize.transaction(async transaction => {
    await permitted(); const context = await googleDestinationContext({ models, scope, reference, loadInventory, now: now(), transaction });
    if (context.revision !== input.revision) fail('workspace_google_check_conflict');
    if (context.detection?.status === 'checking' && +new Date(context.detection.started_at) > +now() - 120000) fail('workspace_google_check_busy');
    await store(context, { ...context.detection, version: 1, source: SOURCE, status: 'checking', complete: false,
      started_at: now().toISOString(), run_id: runId }, transaction);
    return context;
  });
  let detection;
  try {
    const { accessToken } = await ensureToken(started.account.connection, { requiredScopes: [GOOGLE_ADS_SCOPE] });
    detection = await inspectGoogleDestinations({ reference, accessToken, loginCustomerId: started.account.loginCustomerId, read, now: now() });
  } catch (error) {
    const { checkError } = require('./campaignWorkspaceGooglePreparation.service');
    detection = { version: 1, source: SOURCE, status: 'failed', complete: false, kind: 'unknown',
      forms: [], urls: [], checked_at: now().toISOString(), error: checkError(error) };
  }
  await models.sequelize.transaction(async transaction => {
    await permitted(); const context = await googleDestinationContext({ models, scope, reference, loadInventory, transaction, now: now() });
    if (context.detection?.run_id !== runId || context.detection.status !== 'checking'
      || context.account.fingerprint !== started.account.fingerprint || context.campaign.clinicId !== started.campaign.clinicId) fail('workspace_google_check_conflict');
    await store(context, { ...detection, access_fingerprint: context.account.fingerprint }, transaction);
  });
  return { success: true };
}

module.exports = { SOURCE, TTL_MS, CACHE_KEY, googleCampaignReference, googleDestinationDetection,
  googleDestinationContext, inspectGoogleDestinations, refreshGoogleDestinations, saveObservedGoogleDestination };

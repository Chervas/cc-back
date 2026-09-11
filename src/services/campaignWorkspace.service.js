'use strict';

const { Op } = require('sequelize');
const { accountId, mappingIdentity, reportPeriod, visibleCampaigns, aggregateReport } = require('./campaignWorkspaceReport.service');
const { assessConsentMeasurementReadiness, resolveWebMeasurementMarketingState } = require('./campaignMeasurementReadiness.service');
const { buildWorkspaceHealth } = require('./campaignWorkspaceHealth.service');
const { campaignIncluded } = require('./campaignWorkspaceSettings.service');
const { loadFormReceiptEvidence, combineReceptionEvidence } = require('./campaignWorkspaceReception.service');
const { loadBudgetCampaignAttribution } = require('./campaignEconomicAttribution.service');
const { attachLeadAdvertisingIdentities } = require('./leadAdvertisingIdentity.service');
const { loadNativeFormEvidence } = require('./campaignWorkspaceNativeReception.service');
const { loadGoogleNativeEvidence } = require('./campaignWorkspaceGoogleReception.service');
const { loadMetaSignalEvidence } = require('./campaignWorkspaceSignalEvidence.service');
const { loadGoogleSignalEvidence } = require('./campaignWorkspaceGoogleSignalEvidence.service');

const LEAD_FIELDS = ['id', 'clinica_id', 'source', 'channel', 'utm_source', 'utm_campaign', 'source_detail', 'google_ads_customer_id', 'google_ads_campaign_id', 'created_at'];
const GOOGLE_MAPPING_FIELDS = ['id', 'customerId', 'descriptiveName', 'currencyCode', 'clinicaId', 'grupoClinicaId', 'assignmentScope', 'lastSyncedAt'];
const META_MAPPING_FIELDS = ['id', 'metaAssetId', 'metaAssetName', 'clinicaId', 'grupoClinicaId', 'assignmentScope', 'ad_account_refreshed_at', 'additionalData'];

async function loadWorkspaceInventory({ models, scope, transaction = null }) {
  if (!scope.clinicIds?.length) throw Object.assign(new Error('empty_scope'), { status: 400 });
  const selectedClinics = await models.Clinica.findAll({ where: { id_clinica: { [Op.in]: scope.clinicIds } },
    attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica', 'estado_clinica'], raw: true, transaction });
  const groups = [...new Set(selectedClinics.map(row => row.grupoClinicaId).filter(Boolean))];
  const groupMembers = groups.length ? await models.Clinica.findAll({ where: { grupoClinicaId: { [Op.in]: groups } },
    attributes: ['id_clinica', 'grupoClinicaId'], raw: true, transaction }) : [];
  const authorizedGroups = groups.filter(id => groupMembers.filter(row => row.grupoClinicaId === id)
    .every(row => scope.clinicIds.includes(Number(row.id_clinica))));
  const assetScope = { isActive: true, [Op.or]: [
    { assignmentScope: 'clinic', clinicaId: { [Op.in]: scope.clinicIds } },
    ...(groups.length ? [{ assignmentScope: 'group', grupoClinicaId: { [Op.in]: groups } }] : []),
  ] };
  const google = await models.ClinicGoogleAdsAccount.findAll({ where: assetScope, attributes: GOOGLE_MAPPING_FIELDS, raw: true, transaction });
  const meta = await models.ClinicMetaAsset.findAll({ where: { ...assetScope, assetType: 'ad_account' }, attributes: META_MAPPING_FIELDS, raw: true, transaction });
  const googleStoredIds = [...new Set(google.flatMap(row => [row.customerId, accountId(row.customerId)]))];
  const metaStoredIds = [...new Set(meta.flatMap(row => [row.metaAssetId, accountId(row.metaAssetId), `act_${accountId(row.metaAssetId)}`]))];
  // Read all owners of these accounts; no names, tokens or data from those other clinics leave this service.
  const googleOwners = googleStoredIds.length ? await models.ClinicGoogleAdsAccount.findAll({
    where: { isActive: true, customerId: { [Op.in]: googleStoredIds } }, attributes: GOOGLE_MAPPING_FIELDS, raw: true, transaction,
  }) : [];
  const metaOwners = metaStoredIds.length ? await models.ClinicMetaAsset.findAll({
    where: { isActive: true, assetType: 'ad_account', metaAssetId: { [Op.in]: metaStoredIds } }, attributes: META_MAPPING_FIELDS, raw: true, transaction,
  }) : [];
  const mappings = [...googleOwners.map(row => mappingIdentity(row, 'google_ads')), ...metaOwners.map(row => mappingIdentity(row, 'meta_ads'))];
  const refs = [
    ...(googleStoredIds.length ? [{ provider: 'google_ads', customer_id: { [Op.in]: googleStoredIds } }] : []),
    ...(metaStoredIds.length ? [{ provider: 'meta_ads', customer_id: { [Op.in]: metaStoredIds } }] : []),
  ];
  const inventory = refs.length ? await models.ExternalCampaignInventory.findAll({ where: { [Op.or]: refs }, raw: true, transaction }) : [];
  // Meta's existing synchronizer persists entities, not ExternalCampaignInventory.
  if (metaStoredIds.length) {
    const metaInventory = await models.SocialAdsEntity.findAll({ where: { level: 'campaign', ad_account_id: { [Op.in]: metaStoredIds } },
      attributes: ['ad_account_id', 'entity_id', 'name', 'effective_status', 'status', 'updated_at'], raw: true, transaction });
    for (const row of metaInventory) {
      const cached = inventory.find(item => item.provider === 'meta_ads' && accountId(item.customer_id) === accountId(row.ad_account_id)
        && item.campaign_id === row.entity_id);
      const snapshot = { campaign_name: row.name, status: row.effective_status || row.status, last_seen_at: row.updated_at };
      // Destination checks must not freeze status/name ahead of the nightly entity synchronizer.
      if (cached) {
        if (+new Date(row.updated_at) >= +new Date(cached.last_seen_at || 0)) Object.assign(cached, snapshot);
      } else inventory.push({ provider: 'meta_ads', customer_id: row.ad_account_id, campaign_id: row.entity_id, ...snapshot });
    }
  }
  const assignments = refs.length ? await models.ExternalCampaignAssignment.findAll({ where: { [Op.or]: refs },
    attributes: ['provider', 'customer_id', 'campaign_id', 'clinica_id', 'status'], raw: true, transaction }) : [];
  const campaigns = visibleCampaigns({ scope: { ...scope, memberGroupIds: groups, authorizedGroupIds: authorizedGroups }, inventory, assignments, mappings });
  for (const campaign of campaigns) campaign.currency = campaign.provider === 'google_ads'
    ? google.find(row => accountId(row.customerId) === campaign.account_id)?.currencyCode || null
    : meta.find(row => accountId(row.metaAssetId) === campaign.account_id)?.additionalData?.currency || null;
  return { selectedClinics, groups, authorizedGroups, google, meta, campaigns, accounts: workspaceAccounts(google, meta) };
}

function workspaceAccounts(google, meta) {
  return [
    ...google.map(row => ({ provider: 'google_ads', id: accountId(row.customerId), name: row.descriptiveName || row.customerId,
      currency: row.currencyCode || null, lastSyncedAt: row.lastSyncedAt || null })),
    ...meta.map(row => ({ provider: 'meta_ads', id: accountId(row.metaAssetId), name: row.metaAssetName || row.metaAssetId,
      currency: row.additionalData?.currency || null, lastSyncedAt: row.ad_account_refreshed_at || null })),
  ].filter((row, index, list) => list.findIndex(other => row.provider === other.provider && row.id === other.id) === index);
}

function selectedByWorkspace(campaign, inventory, settings, scope) {
  const clinicSetting = settings.find(row => row.scope_type === 'clinic' && Number(row.scope_id) === campaign.clinicId);
  if (clinicSetting) return campaignIncluded(campaign, clinicSetting);
  const clinicGroup = inventory.selectedClinics.find(clinic => Number(clinic.id_clinica) === campaign.clinicId)?.grupoClinicaId;
  const accountMappings = campaign.provider === 'google_ads' ? inventory.google : inventory.meta;
  const accountGroups = accountMappings.filter(row => row.assignmentScope === 'group'
    && accountId(row.customerId || row.metaAssetId) === campaign.account_id
    && inventory.authorizedGroups.includes(row.grupoClinicaId)).map(row => Number(row.grupoClinicaId));
  const candidates = clinicGroup ? [Number(clinicGroup)] : scope.groupId ? [Number(scope.groupId)] : accountGroups;
  // Aggregates retain the same account selections as each constituent workspace.
  return !candidates.length || candidates.some(id => campaignIncluded(campaign,
    settings.find(row => row.scope_type === 'group' && Number(row.scope_id) === id)));
}

async function loadCampaignWorkspace({ models, scope, days, now = new Date() }) {
  const period = reportPeriod(days, now);
  const inventory = await loadWorkspaceInventory({ models, scope });
  const { selectedClinics, groups, campaigns: availableCampaigns } = inventory;
  const settings = await models.CampaignWorkspaceSetting.findAll({ where: { [Op.or]: [
    { scope_type: 'clinic', scope_id: { [Op.in]: scope.clinicIds } },
    ...(groups.length ? [{ scope_type: 'group', scope_id: { [Op.in]: groups } }] : []),
  ] }, raw: true });
  const campaigns = availableCampaigns.filter(campaign => selectedByWorkspace(campaign, inventory, settings, scope));
  const googleCampaigns = campaigns.filter(c => c.provider === 'google_ads');
  const metaCampaigns = campaigns.filter(c => c.provider === 'meta_ads');
  const dateWhere = { [Op.between]: [period.previousStart, period.end] };
  const googleWhere = googleCampaigns.map(c => ({ customerId: c.account_id, campaignId: c.campaign_id }));
  const metaWhere = metaCampaigns.map(c => ({ ad_account_id: { [Op.in]: [c.account_id, `act_${c.account_id}`] }, entity_id: c.campaign_id }));
  const facts = [];
  if (googleWhere.length) {
    const rows = await models.GoogleAdsInsightsDaily.findAll({ where: { [Op.or]: googleWhere, date: dateWhere },
      attributes: ['customerId', 'campaignId', 'date', 'adGroupId', 'network', 'device', 'costMicros', 'conversions', 'updated_at'],
      order: [['updated_at', 'DESC']], raw: true });
    for (const row of rows) facts.push({ provider: 'google_ads', account_id: row.customerId, campaign_id: row.campaignId,
      date: row.date, segment: [row.adGroupId || '', row.network || '', row.device || ''], spend: Number(row.costMicros) / 1e6,
      providerConversions: Number(row.conversions), updatedAt: row.updated_at });
  }
  if (metaWhere.length) {
    const rows = await models.SocialAdsInsightsDaily.findAll({ where: { [Op.or]: metaWhere, level: 'campaign', date: dateWhere },
      attributes: ['ad_account_id', 'entity_id', 'date', 'publisher_platform', 'platform_position', 'spend', 'updated_at'],
      order: [['updated_at', 'DESC']], raw: true });
    for (const row of rows) facts.push({ provider: 'meta_ads', account_id: row.ad_account_id, campaign_id: row.entity_id,
      date: row.date, segment: [row.publisher_platform || '', row.platform_position || ''], spend: Number(row.spend), updatedAt: row.updated_at });
  }
  const timeWhere = { [Op.gte]: period.from, [Op.lt]: period.until };
  const leads = await models.LeadIntake.findAll({ where: { clinica_id: { [Op.in]: scope.clinicIds }, created_at: timeWhere },
    attributes: LEAD_FIELDS, raw: true });
  const appointments = await models.CitaPaciente.findAll({ where: { clinica_id: { [Op.in]: scope.clinicIds },
    lead_intake_id: { [Op.ne]: null }, created_at: timeWhere },
    attributes: ['id_cita', 'clinica_id', 'lead_intake_id', 'created_at', 'estado', 'es_provisional'], raw: true });
  const loadedLeads = new Set(leads.map(row => Number(row.id)));
  const olderLeadIds = [...new Set(appointments.map(row => Number(row.lead_intake_id)).filter(id => !loadedLeads.has(id)))];
  if (olderLeadIds.length) leads.push(...await models.LeadIntake.findAll({ where: { id: { [Op.in]: olderLeadIds },
    clinica_id: { [Op.in]: scope.clinicIds } }, attributes: LEAD_FIELDS, raw: true }));
  const ads = await loadWorkspaceAds({ models, googleWhere, metaCampaigns, dateWhere });
  await attachLeadAdvertisingIdentities({ models, leads });
  const budgetAttribution = await loadBudgetCampaignAttribution({ models, campaigns, period });
  const metrics = aggregateReport({ campaigns, facts, leads, appointments, ads, budgetAttribution, period, now });
  const evidence = await loadWebEvidence({ models, campaigns, selectedClinics, groups, scope, now });
  const signals = await loadMetaSignalEvidence({ models, campaigns, selectedClinics, now });
  for (const [campaignId, delivery] of signals) evidence.set(campaignId, { ...evidence.get(campaignId), signals: delivery });
  const googleSignals = await loadGoogleSignalEvidence({ models, campaigns, selectedClinics, now });
  for (const [campaignId, delivery] of googleSignals) evidence.set(campaignId, { ...evidence.get(campaignId), signals: delivery });
  const report = buildWorkspaceHealth(metrics, evidence, now);
  return { success: true, version: 1, scope: { clinicIds: scope.clinicIds, groupId: scope.groupId || null },
    generatedAt: now.toISOString(), report,
    accounts: inventory.accounts,
  };
}

async function loadWebEvidence({ models, campaigns, selectedClinics, groups, scope = null, now, transaction = null }) {
  const receipts = await loadFormReceiptEvidence({ models, campaigns, now, transaction });
  const ids = selectedClinics.map(row => row.id_clinica);
  const records = await models.IntakeConfig.findAll({ where: { [Op.or]: [
    { assignment_scope: 'clinic', clinic_id: { [Op.in]: ids } },
    ...(groups.length ? [{ assignment_scope: 'group', group_id: { [Op.in]: groups } }] : []),
  ] }, raw: true, transaction });
  const byClinic = new Map();
  for (const clinic of selectedClinics) {
    const scope = { assignment_scope: 'clinic', clinic_id: clinic.id_clinica, group_id: clinic.grupoClinicaId };
    const state = resolveWebMeasurementMarketingState(scope, { scope, records: {
      clinicRecord: records.find(row => row.assignment_scope === 'clinic' && Number(row.clinic_id) === Number(clinic.id_clinica)),
      groupRecord: records.find(row => row.assignment_scope === 'group' && Number(row.group_id) === Number(clinic.grupoClinicaId)),
    } });
    byClinic.set(Number(clinic.id_clinica), { state, readiness: assessConsentMeasurementReadiness(state.marketingState) });
  }
  const evidence = await loadNativeFormEvidence({ models, campaigns, selectedClinics, scope, now, transaction });
  for (const [id, value] of await loadGoogleNativeEvidence({ models, campaigns, selectedClinics, scope, now, transaction })) evidence.set(id, value);
  for (const campaign of campaigns) {
    if (!campaign.assigned || !['web', 'mixed'].includes(campaign.destination)) continue;
    const { state, readiness } = byClinic.get(campaign.clinicId) || {};
    if (!readiness) continue;
    const destinationsCovered = campaign.urls.length > 0 && campaign.urls.every(url => {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      return readiness.domains.includes(host);
    });
    const ready = readiness.ready && destinationsCovered;
    const detail = !destinationsCovered ? 'Hay destinos publicitarios sin una comprobación de seguimiento para su dominio.'
      : readiness.renewal_required ? 'La comprobación de la web ha caducado. Es necesario renovarla.'
      : 'Falta completar la comprobación del aviso, las páginas legales o las señales de consentimiento.';
    const key = destinationsCovered ? `intake:${state.record?.id || campaign.clinicId}` : campaign.id;
    const destinationAge = +now - +new Date(campaign.destinationCheckedAt);
    const destinationsVerified = !campaign.destinationCheckedAt || campaign.destinationComplete === true
      && Number.isFinite(destinationAge) && destinationAge >= 0 && destinationAge < 86400000;
    const configured = ready && destinationsVerified && state.record?.config?.features?.form_intercept_enabled === true;
    const receipt = receipts.get(campaign.id);
    const webReception = !configured
      ? { checked: true, ready: false, configured: false, state: !destinationsVerified ? 'unverified' : 'action_required',
        detail: !destinationsVerified ? 'Falta completar la comprobación de todos los destinos anunciados.' : !ready ? detail : 'La captura de formularios está desactivada.',
        key: !destinationsVerified ? campaign.id : key }
      : { ...receipt, checked: true, ready: receipt?.ready === true, configured: true,
        state: receipt?.ready ? 'verified' : 'pending_confirmation',
        detail: receipt?.ready ? receipt.detail : 'La web está preparada. Aún no hay una recepción reciente confirmada para todos sus destinos.' };
    const native = evidence.get(campaign.id);
    evidence.set(campaign.id, {
      ...native,
      configurationScope: state.record ? { scope_type: state.record.assignment_scope, scope_id: Number(state.record.assignment_scope === 'group' ? state.record.group_id : state.record.clinic_id) } : null,
      privacy: { checked: true, ready, detail, key },
      // Setup and a received lead are separate evidence; mixed campaigns need both channels.
      webReception,
      ...(campaign.destination === 'mixed' ? { nativeReception: native?.reception || null } : {}),
      reception: campaign.destination === 'mixed' ? combineReceptionEvidence([webReception, native?.reception]) : webReception,
    });
  }
  return evidence;
}

async function loadWorkspaceAds({ models, googleWhere, metaCampaigns, dateWhere }) {
  const ads = [];
  if (googleWhere.length) {
    const rows = await models.GoogleAdsAdInsightsDaily.findAll({ where: { [Op.or]: googleWhere, date: dateWhere },
      attributes: ['customerId', 'campaignId', 'adId', 'adName', 'adStatus', 'date', 'network', 'device', 'costMicros', 'conversions', 'updated_at'],
      order: [['updated_at', 'DESC']], raw: true });
    for (const row of rows) ads.push({ provider: 'google_ads', account_id: row.customerId, campaign_id: row.campaignId,
      id: row.adId, title: row.adName, status: row.adStatus, date: row.date, segment: [row.network || '', row.device || ''],
      spend: Number(row.costMicros) / 1e6, providerConversions: Number(row.conversions), updatedAt: row.updated_at });
  }
  if (!metaCampaigns.length) return ads;
  const adsets = await models.SocialAdsEntity.findAll({ where: { level: 'adset', [Op.or]: metaCampaigns.map(c => ({
    ad_account_id: { [Op.in]: [c.account_id, `act_${c.account_id}`] }, parent_id: c.campaign_id,
  })) }, attributes: ['entity_id', 'parent_id', 'ad_account_id'], raw: true });
  if (!adsets.length) return ads;
  const entities = await models.SocialAdsEntity.findAll({ where: { level: 'ad', [Op.or]: adsets.map(row => ({
    ad_account_id: row.ad_account_id, parent_id: row.entity_id,
  })) }, attributes: ['entity_id', 'parent_id', 'name', 'ad_account_id', 'effective_status', 'status', 'updated_at'], raw: true });
  const byId = new Map(entities.map(row => [`${accountId(row.ad_account_id)}:${row.entity_id}`, row]));
  const byAdset = new Map(adsets.map(row => [`${accountId(row.ad_account_id)}:${row.entity_id}`, row.parent_id]));
  for (const entity of entities) ads.push({ provider: 'meta_ads', account_id: entity.ad_account_id,
    campaign_id: byAdset.get(`${accountId(entity.ad_account_id)}:${entity.parent_id}`), id: entity.entity_id,
    title: entity.name, status: entity.effective_status || entity.status, updatedAt: entity.updated_at, inventory: true });
  const rows = entities.length ? await models.SocialAdsInsightsDaily.findAll({ where: { level: 'ad', date: dateWhere,
    [Op.or]: entities.map(row => ({ entity_id: row.entity_id, ad_account_id: row.ad_account_id })) },
    attributes: ['ad_account_id', 'entity_id', 'date', 'publisher_platform', 'platform_position', 'spend', 'updated_at'],
    order: [['updated_at', 'DESC']], raw: true }) : [];
  for (const row of rows) {
    const entity = byId.get(`${accountId(row.ad_account_id)}:${row.entity_id}`);
    ads.push({ provider: 'meta_ads', account_id: row.ad_account_id,
      campaign_id: byAdset.get(`${accountId(row.ad_account_id)}:${entity.parent_id}`), id: entity.entity_id,
      title: entity.name, status: entity.effective_status || entity.status, date: row.date,
      segment: [row.publisher_platform || '', row.platform_position || ''], spend: Number(row.spend), updatedAt: entity.updated_at });
  }
  return ads;
}

module.exports = { loadCampaignWorkspace, loadWorkspaceInventory, loadWorkspaceAds, loadWebEvidence, selectedByWorkspace, workspaceAccounts };

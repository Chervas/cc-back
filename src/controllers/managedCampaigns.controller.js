'use strict';

const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const { publicHttpUrl } = require('../lib/safeHttpTarget');

const {
  Clinica,
  CampaignRequest,
  ManagedCampaign,
  ManagedCampaignFundingAccount,
  GoogleAdsInsightsDaily,
  SocialAdsInsightsDaily,
  SocialAdsActionsDaily,
  SocialAdsEntity,
} = db;

const META_LEAD_ACTION_TYPES = new Set([
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_form',
  'leadgen.other',
  'onsite_conversion.lead_grouped',
]);

function userId(req) {
  const value = Number.parseInt(String(req.userData?.userId || ''), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseClinicIds(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return Array.from(new Set(values.map(positiveInt).filter(Boolean)));
}

function clean(value, max = 255) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  const result = String(value ?? '').trim();
  return result ? result.slice(0, max) : null;
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function safeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function effectiveProposalRevision(reviewConfig, status) {
  const stored = Math.max(0, Math.trunc(Number(safeObject(reviewConfig).proposal_revision) || 0));
  // Campaigns sent for review before proposal revisions were introduced must
  // remain actionable. Their materialized legacy proposal is revision 1.
  return status === 'pending_client_review' ? Math.max(1, stored) : stored;
}

function publicCampaignName(value) {
  const name = clean(value, 255);
  return name?.replace(/\s*\((?:observaci[oó]n|observation)\)\s*$/iu, '').trim() || name;
}

function dateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function normalizedMetaAccountId(value) {
  const accountId = clean(value, 64);
  if (!accountId) return null;
  return accountId.startsWith('act_') ? accountId : `act_${accountId}`;
}

function entityIdsByAccount(rows, idField) {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const accountId = normalizedMetaAccountId(row?.ad_account_id);
    const entityId = clean(row?.[idField], 64);
    if (!accountId || !entityId) continue;
    if (!grouped.has(accountId)) grouped.set(accountId, new Set());
    grouped.get(accountId).add(entityId);
  }
  return grouped;
}

function accountEntityConditions(grouped, field) {
  return Array.from(grouped.entries()).map(([adAccountId, ids]) => ({
    ad_account_id: adAccountId,
    [field]: { [Op.in]: Array.from(ids) },
  }));
}

async function loadMetaCampaignAdMap({
  metaRefs,
  transaction = null,
  entityModel = SocialAdsEntity,
} = {}) {
  const refs = Array.isArray(metaRefs) ? metaRefs : [];
  if (!refs.length || !entityModel) return new Map();

  const campaignIdsByAccount = entityIdsByAccount(refs, 'entity_id');
  const adsetConditions = accountEntityConditions(campaignIdsByAccount, 'parent_id');
  if (!adsetConditions.length) return new Map();
  const adsets = await entityModel.findAll({
    attributes: ['ad_account_id', 'entity_id', 'parent_id'],
    where: { level: 'adset', [Op.or]: adsetConditions },
    transaction,
    raw: true,
  });
  const campaignByAdset = new Map();
  for (const adset of adsets) {
    const accountId = normalizedMetaAccountId(adset.ad_account_id);
    const adsetId = clean(adset.entity_id, 64);
    const campaignId = clean(adset.parent_id, 64);
    if (accountId && adsetId && campaignId) {
      campaignByAdset.set(`${accountId}:${adsetId}`, `${accountId}:${campaignId}`);
    }
  }

  const adsetIdsByAccount = entityIdsByAccount(adsets, 'entity_id');
  const adConditions = accountEntityConditions(adsetIdsByAccount, 'parent_id');
  if (!adConditions.length) return new Map();
  const ads = await entityModel.findAll({
    attributes: ['ad_account_id', 'entity_id', 'parent_id'],
    where: { level: 'ad', [Op.or]: adConditions },
    transaction,
    raw: true,
  });
  const campaignByAd = new Map();
  for (const ad of ads) {
    const accountId = normalizedMetaAccountId(ad.ad_account_id);
    const adId = clean(ad.entity_id, 64);
    const adsetId = clean(ad.parent_id, 64);
    const campaignKey = campaignByAdset.get(`${accountId}:${adsetId}`);
    if (accountId && adId && campaignKey) campaignByAd.set(`${accountId}:${adId}`, campaignKey);
  }

  return campaignByAd;
}

function metaAdIdsByAccount(campaignByAd) {
  const grouped = new Map();
  for (const key of campaignByAd instanceof Map ? campaignByAd.keys() : []) {
    const separator = key.indexOf(':');
    const accountId = separator > 0 ? key.slice(0, separator) : null;
    const adId = separator > 0 ? key.slice(separator + 1) : null;
    if (!accountId || !adId) continue;
    if (!grouped.has(accountId)) grouped.set(accountId, new Set());
    grouped.get(accountId).add(adId);
  }
  return grouped;
}

function attachMetaCampaignKeys(rows, campaignByAd) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    campaign_key: campaignByAd.get(`${normalizedMetaAccountId(row.ad_account_id)}:${row.entity_id}`) || null,
  })).filter((row) => row.campaign_key);
}

async function loadMetaCampaignInsightRows({
  campaignByAd,
  startDate,
  endDate,
  transaction = null,
  insightsModel = SocialAdsInsightsDaily,
} = {}) {
  if (!(campaignByAd instanceof Map) || !campaignByAd.size || !insightsModel) return [];
  const conditions = accountEntityConditions(metaAdIdsByAccount(campaignByAd), 'entity_id');
  if (!conditions.length) return [];
  const rows = await insightsModel.findAll({
    attributes: ['ad_account_id', 'entity_id', 'impressions', 'clicks', 'spend'],
    where: {
      level: 'ad',
      date: { [Op.between]: [startDate, endDate] },
      [Op.or]: conditions,
    },
    transaction,
    raw: true,
  });
  return attachMetaCampaignKeys(rows, campaignByAd);
}

async function loadMetaCampaignLeadActionRows({
  campaignByAd,
  startDate,
  endDate,
  transaction = null,
  actionsModel = SocialAdsActionsDaily,
} = {}) {
  if (!(campaignByAd instanceof Map) || !campaignByAd.size || !actionsModel) return [];
  const actionConditions = accountEntityConditions(metaAdIdsByAccount(campaignByAd), 'entity_id');
  if (!actionConditions.length) return [];
  const rows = await actionsModel.findAll({
    attributes: ['ad_account_id', 'entity_id', 'date', 'action_type', 'value'],
    where: {
      level: 'ad',
      date: { [Op.between]: [startDate, endDate] },
      [Op.or]: actionConditions,
    },
    transaction,
    raw: true,
  });
  return attachMetaCampaignKeys(rows, campaignByAd);
}

function metaLeadConversionsFromActionRows(rows) {
  const aliasesByCampaignDay = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const actionType = clean(row?.action_type, 128)?.toLowerCase();
    if (!actionType || (!META_LEAD_ACTION_TYPES.has(actionType) && !actionType.includes('add_meta_leads'))) continue;
    const campaignKey = clean(row?.campaign_key, 160);
    const day = dateOnly(row?.date);
    if (!campaignKey || !day) continue;
    const value = Number(row?.value || 0);
    if (!Number.isFinite(value) || value <= 0) continue;
    const key = `${campaignKey}:${day}`;
    const aliases = aliasesByCampaignDay.get(key) || new Map();
    aliases.set(actionType, (aliases.get(actionType) || 0) + value);
    aliasesByCampaignDay.set(key, aliases);
  }
  let conversions = 0;
  for (const aliases of aliasesByCampaignDay.values()) {
    conversions += Math.max(0, ...aliases.values());
  }
  return conversions;
}

function publicTargetConfig(value) {
  const target = safeObject(value);
  return {
    source: clean(target.source, 64),
    promotion_type: clean(target.promotion_type, 32),
    proposal_summary: clean(target.proposal_summary, 2000),
    area_medica_id: positiveInt(target.area_medica_id),
    area_medica_nombre: clean(target.area_medica_nombre, 255),
    treatments: (Array.isArray(target.treatments) ? target.treatments : []).slice(0, 100).map((item) => ({
      id: positiveInt(item?.id ?? item?.id_tratamiento),
      nombre: clean(item?.nombre ?? item?.name, 255),
    })).filter((item) => item.id || item.nombre),
  };
}

function publicBudgetConfig(value) {
  const budget = safeObject(value);
  return {
    amount: money(budget.amount),
    currency: (clean(budget.currency, 3) || 'EUR').toUpperCase(),
    period: clean(budget.period, 32) || 'monthly',
    leads: budget.leads === null ? null : Math.max(0, Number(budget.leads) || 0),
  };
}

function publicScheduleConfig(value) {
  const schedule = safeObject(value);
  return {
    start_date: clean(schedule.start_date, 32),
    end_date: clean(schedule.end_date, 32),
    time_zone: clean(schedule.time_zone, 64),
    days: (Array.isArray(schedule.days) ? schedule.days : [])
      .map((day) => clean(day, 16)).filter(Boolean).slice(0, 7),
  };
}

function publicDestinationConfig(value) {
  const destination = safeObject(value);
  return {
    kind: clean(destination.kind, 32),
    final_url: clean(destination.final_url || destination.effective_url || destination.landing_url || destination.url, 2048),
    instant_form: !!clean(destination.instant_form_id || destination.form_id, 128),
  };
}

function publicPolicyReadiness(value) {
  const policy = safeObject(value);
  return {
    status: clean(policy.status, 32),
    reasons: (Array.isArray(policy.reasons) ? policy.reasons : [])
      .map((reason) => clean(reason, 500)).filter(Boolean).slice(0, 20),
  };
}

function benchmarkCampaignsFromStrategyPayload(payload) {
  const seen = new Set();
  const refs = [];
  for (const target of Array.isArray(payload?.external_targets) ? payload.external_targets : []) {
    for (const campaign of Array.isArray(target?.campaigns) ? target.campaigns : []) {
      const provider = ['google_ads', 'meta_ads'].includes(String(campaign?.provider || '').trim())
        ? String(campaign.provider).trim()
        : null;
      const externalCampaignId = clean(campaign?.external_campaign_id, 128);
      if (!provider || !externalCampaignId) continue;
      const accountId = clean(campaign?.account_id, 128);
      const key = `${provider}:${accountId || ''}:${externalCampaignId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        provider,
        account_id: accountId,
        external_campaign_id: externalCampaignId,
        name: clean(campaign?.name, 255),
        status: clean(campaign?.status, 32),
        target_kind: clean(target?.kind, 32) || 'generic',
        treatment_id: positiveInt(target?.treatment_id),
        destination: (() => {
          const detection = safeObject(campaign?.destination_detection, null);
          if (!detection) return null;
          return {
            kind: clean(detection.kind, 32),
            reason: clean(detection.reason, 64),
            confidence: clean(detection.confidence, 32),
            urls: Array.isArray(detection.urls)
              ? detection.urls.map((url) => clean(url, 2048)).filter(Boolean).slice(0, 20)
              : [],
          };
        })(),
      });
    }
  }
  return refs;
}

async function loadBenchmarkMetricsSnapshot({
  clinicId,
  campaignRefs,
  capturedAt = new Date(),
  days = 30,
  transaction = null,
  googleModel = GoogleAdsInsightsDaily,
  metaInsightsModel = SocialAdsInsightsDaily,
  metaActionsModel = SocialAdsActionsDaily,
  metaEntityModel = SocialAdsEntity,
} = {}) {
  const normalizedDays = Math.max(1, Math.min(180, positiveInt(days) || 30));
  const end = new Date(capturedAt);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - ((normalizedDays - 1) * 86400000));
  const startDate = dateOnly(start);
  const endDate = dateOnly(end);
  const refs = Array.isArray(campaignRefs) ? campaignRefs : [];
  const googleRefs = refs
    .filter((ref) => ref.provider === 'google_ads' && clean(ref.account_id, 64) && clean(ref.external_campaign_id, 128))
    .map((ref) => ({
      customerId: String(ref.account_id).replace(/[^0-9]/g, ''),
      campaignId: String(ref.external_campaign_id),
    }));
  const metaRefs = refs
    .filter((ref) => ref.provider === 'meta_ads' && normalizedMetaAccountId(ref.account_id) && clean(ref.external_campaign_id, 128))
    .map((ref) => ({
      ad_account_id: normalizedMetaAccountId(ref.account_id),
      entity_id: String(ref.external_campaign_id),
    }));

  const totals = { investment: 0, impressions: 0, clicks: 0, conversions: 0 };
  let campaignsWithData = 0;

  if (googleModel && googleRefs.length) {
    const rows = await googleModel.findAll({
      attributes: ['campaignId', 'impressions', 'clicks', 'costMicros', 'conversions'],
      where: {
        clinicaId: positiveInt(clinicId),
        date: { [Op.between]: [startDate, endDate] },
        [Op.or]: googleRefs,
      },
      transaction,
      raw: true,
    });
    const seen = new Set();
    for (const row of rows) {
      totals.investment += Number(row.costMicros || 0) / 1000000;
      totals.impressions += Number(row.impressions || 0);
      totals.clicks += Number(row.clicks || 0);
      totals.conversions += Number(row.conversions || 0);
      seen.add(String(row.campaignId || ''));
    }
    campaignsWithData += seen.size;
  }

  const metaCampaignByAd = metaEntityModel && metaRefs.length
    ? await loadMetaCampaignAdMap({ metaRefs, transaction, entityModel: metaEntityModel })
    : new Map();

  if (metaInsightsModel && metaCampaignByAd.size) {
    const rows = await loadMetaCampaignInsightRows({
      campaignByAd: metaCampaignByAd,
      startDate,
      endDate,
      transaction,
      insightsModel: metaInsightsModel,
    });
    const seen = new Set();
    for (const row of rows) {
      totals.investment += Number(row.spend || 0);
      totals.impressions += Number(row.impressions || 0);
      totals.clicks += Number(row.clicks || 0);
      seen.add(String(row.campaign_key || ''));
    }
    campaignsWithData += seen.size;
  }

  if (metaActionsModel && metaCampaignByAd.size) {
    const rows = await loadMetaCampaignLeadActionRows({
      campaignByAd: metaCampaignByAd,
      startDate,
      endDate,
      transaction,
      actionsModel: metaActionsModel,
    });
    totals.conversions += metaLeadConversionsFromActionRows(rows);
  }

  const investment = money(totals.investment);
  const conversions = Math.round((Number(totals.conversions || 0) + Number.EPSILON) * 1000000) / 1000000;
  return {
    period_start: startDate,
    period_end: endDate,
    days: normalizedDays,
    captured_at: new Date(capturedAt).toISOString(),
    source: 'cached_provider_insights',
    currency: 'EUR',
    investment,
    impressions: Math.max(0, Math.round(totals.impressions)),
    clicks: Math.max(0, Math.round(totals.clicks)),
    conversions: Math.max(0, conversions),
    cost_per_conversion: conversions > 0 ? money(investment / conversions) : null,
    campaign_count: refs.length,
    campaigns_with_data: campaignsWithData,
  };
}

function buildAutopilotTransitionSnapshot(row, capturedAt = new Date(), benchmarkMetrics = null) {
  const payload = safeObject(row?.solicitud);
  const campaignRefs = benchmarkCampaignsFromStrategyPayload(payload);
  const summary = safeObject(payload.summary);
  const measurement = safeObject(payload.measurement);
  return {
    campaignRequestId: positiveInt(row?.id),
    strategyCampaignId: positiveInt(row?.campaign_id),
    targetConfig: {
      source: 'connect_only_benchmark',
      promotion_type: clean(payload.promotion_type, 32) || 'generic',
      treatments: Array.isArray(payload.treatments) ? payload.treatments : [],
      area_medica_id: positiveInt(payload.area_medica_id ?? summary.area_medica_id),
      area_medica_nombre: clean(payload.area_medica_nombre ?? summary.area_medica_nombre, 255),
    },
    budgetConfig: {
      amount: money(summary.budget_monthly),
      currency: 'EUR',
      period: 'monthly',
      leads: null,
    },
    destinationConfig: {
      ...safeObject(payload.destination),
      target_destinations: Array.isArray(payload.target_destinations) ? payload.target_destinations : [],
    },
    trackingPlan: {
      status: 'pending_validation',
      conversion_actions_ready: false,
      inherited_measurement: measurement,
    },
    platformRefs: {
      benchmark_external_campaigns: campaignRefs,
    },
    reviewTransition: {
      source_mode: 'connect_only',
      source_status: clean(payload.status, 32) || 'unknown',
      benchmark_preserved: true,
      benchmark_campaign_count: campaignRefs.length,
      benchmark_captured_at: capturedAt.toISOString(),
      source_strategy_updated_at: row?.updated_at || row?.created_at || null,
      source_strategy_campaign_id: positiveInt(row?.campaign_id),
      source_campaign_request_id: positiveInt(row?.id),
      ...(benchmarkMetrics ? { benchmark_metrics: benchmarkMetrics } : {}),
    },
  };
}

async function requireScope(req, res, clinicIds, access = 'read') {
  const allowed = await hasMarketingClinicScopeAccess({ userId: userId(req), clinicIds, access });
  if (allowed) return true;
  res.status(403).json({ success: false, error: 'scope_forbidden' });
  return false;
}

function managedReferenceError(message) {
  const error = new Error(message);
  error.code = 'managed_reference_scope_mismatch';
  error.httpStatus = 403;
  return error;
}

function isNewPatientsMarketingStrategyRequest(row, clinicId) {
  const payload = safeObject(row?.solicitud);
  return positiveInt(row?.clinica_id) === positiveInt(clinicId)
    && payload.kind === 'marketing_strategy'
    && String(payload.objective_id || '').trim().toLowerCase() === 'new_patients'
    && String(payload.mode_snapshot || payload.mode || '').trim().toLowerCase() === 'connect_only';
}

async function validateAutopilotReferences({
  clinicId,
  strategyCampaignId = null,
  campaignRequestId = null,
  transaction = null,
  campaignRequestModel = CampaignRequest,
  benchmarkLoader = null,
} = {}) {
  let normalizedStrategyId = positiveInt(strategyCampaignId);
  let normalizedRequestId = positiveInt(campaignRequestId);
  let requestRow = null;

  if (normalizedRequestId) {
    requestRow = await campaignRequestModel.findByPk(normalizedRequestId, {
      attributes: ['id', 'clinica_id', 'campaign_id', 'solicitud', 'created_at', 'updated_at'],
      transaction,
    });
    if (!requestRow || !isNewPatientsMarketingStrategyRequest(requestRow, clinicId)) {
      throw managedReferenceError('La solicitud de campaña no pertenece a una estrategia de nuevos pacientes de esta clínica');
    }
    const requestStrategyId = positiveInt(requestRow.campaign_id);
    if (!requestStrategyId || (normalizedStrategyId && normalizedStrategyId !== requestStrategyId)) {
      throw managedReferenceError('La solicitud y la estrategia indicadas no corresponden entre sí');
    }
    normalizedStrategyId = normalizedStrategyId || requestStrategyId;
  }

  if (normalizedStrategyId) {
    const strategyRows = await campaignRequestModel.findAll({
      where: { campaign_id: normalizedStrategyId, clinica_id: clinicId },
      attributes: ['id', 'clinica_id', 'campaign_id', 'solicitud', 'created_at', 'updated_at'],
      order: [['updated_at', 'DESC'], ['id', 'DESC']],
      transaction,
    });
    const matchingStrategyRow = strategyRows.find((row) => isNewPatientsMarketingStrategyRequest(row, clinicId));
    if (!matchingStrategyRow) {
      throw managedReferenceError('La estrategia indicada no pertenece a nuevos pacientes de esta clínica');
    }
    requestRow = requestRow || matchingStrategyRow;
    normalizedRequestId = normalizedRequestId || positiveInt(matchingStrategyRow.id);
  }

  let transition = requestRow ? buildAutopilotTransitionSnapshot(requestRow) : null;
  const effectiveBenchmarkLoader = benchmarkLoader
    || (campaignRequestModel === CampaignRequest ? loadBenchmarkMetricsSnapshot : null);
  if (transition && effectiveBenchmarkLoader) {
    const capturedAt = new Date(transition.reviewTransition.benchmark_captured_at);
    const benchmarkMetrics = await effectiveBenchmarkLoader({
      clinicId,
      campaignRefs: transition.platformRefs.benchmark_external_campaigns,
      capturedAt,
      transaction,
    });
    transition = buildAutopilotTransitionSnapshot(requestRow, capturedAt, benchmarkMetrics);
  }

  return {
    strategyCampaignId: normalizedStrategyId,
    campaignRequestId: normalizedRequestId,
    transition,
  };
}

function publicFunding(funding, leads = 0) {
  if (!funding) return null;
  const gross = money(funding.client_gross_funded);
  const net = money(funding.media_budget_net);
  const platformSpend = money(funding.media_spend);
  const consumedRatio = net > 0 ? Math.min(1, Math.max(0, platformSpend / net)) : 0;
  const consumed = money(gross * consumedRatio);
  const leadCount = Math.max(0, Number(leads) || 0);
  return {
    currency: funding.currency,
    status: funding.status,
    total_paid: gross,
    total_consumed: consumed,
    available: money(Math.max(0, gross - consumed)),
    leads: leadCount,
    cpl: leadCount > 0 ? money(consumed / leadCount) : null,
  };
}

function publicCampaign(row) {
  const plain = typeof row?.get === 'function' ? row.get({ plain: true }) : row;
  const funding = plain?.funding || null;
  const transition = safeObject(plain?.review_config?.transition);
  const benchmark = safeObject(transition.benchmark_metrics, null);
  return {
    id: plain.id,
    objective_id: plain.objective_id,
    clinica_id: plain.clinica_id,
    management_mode: 'autopilot',
    operation_mode: plain.operation_mode,
    provider: plain.provider,
    family: plain.family,
    status: plain.status,
    name: publicCampaignName(plain.name),
    target: publicTargetConfig(plain.target_config),
    budget: publicBudgetConfig(plain.budget_config),
    schedule: publicScheduleConfig(plain.schedule_config),
    destination: publicDestinationConfig(plain.destination_config),
    creative_summary: {
      assets_ready: plain.creative_config?.assets_ready === true,
      preview_url: publicHttpUrl(plain.creative_config?.client_preview_url, { requireHttps: true }),
    },
    review: {
      client_approval_required: plain.review_config?.client_approval_required === true,
      client_approved_at: plain.review_config?.client_approved_at || null,
      next_action: plain.review_config?.client_next_action || null,
      proposal_summary: clean(plain.review_config?.client_proposal_summary, 4000),
      proposal_revision: effectiveProposalRevision(plain.review_config, plain.status),
    },
    transition: transition.benchmark_preserved === true
      ? {
          source_mode: transition.source_mode || 'connect_only',
          benchmark_preserved: true,
          benchmark_campaign_count: Math.max(0, Number(transition.benchmark_campaign_count) || 0),
          benchmark_captured_at: transition.benchmark_captured_at || null,
          benchmark: benchmark
            ? {
                period_start: benchmark.period_start || null,
                period_end: benchmark.period_end || null,
                days: Math.max(0, Number(benchmark.days) || 0),
                currency: benchmark.currency || 'EUR',
                investment: money(benchmark.investment),
                conversions: Math.max(0, Number(benchmark.conversions) || 0),
                cost_per_conversion: benchmark.cost_per_conversion === null
                  ? null
                  : money(benchmark.cost_per_conversion),
              }
            : null,
        }
      : null,
    policy_readiness: publicPolicyReadiness(plain.policy_readiness),
    finance: publicFunding(funding, plain?.budget_config?.leads || 0),
    updated_at: plain.updated_at,
  };
}

async function loadRows(where) {
  return ManagedCampaign.findAll({
    where,
    include: [{ model: ManagedCampaignFundingAccount, as: 'funding', required: false }],
    order: [['updated_at', 'DESC']],
  });
}

exports.listClientCampaigns = asyncHandler(async (req, res) => {
  const clinicIds = parseClinicIds(req.query?.clinic_id ?? req.query?.clinic_ids);
  if (!clinicIds.length) return res.status(400).json({ success: false, error: 'clinic_scope_required' });
  if (!(await requireScope(req, res, clinicIds, 'read'))) return;
  const rows = await loadRows({ clinica_id: { [Op.in]: clinicIds }, status: { [Op.ne]: 'cancelled' } });
  return res.json({ success: true, items: rows.map(publicCampaign) });
});

exports.getClientCampaign = asyncHandler(async (req, res) => {
  const row = (await loadRows({ id: req.params.id }))[0];
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  if (!(await requireScope(req, res, [row.clinica_id], 'read'))) return;
  return res.json({ success: true, campaign: publicCampaign(row) });
});

exports.requestAutopilot = asyncHandler(async (req, res) => {
  const actorId = userId(req);
  const clinicId = positiveInt(req.body?.clinica_id);
  if (!actorId || !clinicId) return res.status(400).json({ success: false, error: 'clinic_id_required' });
  if (!(await requireScope(req, res, [clinicId], 'write'))) return;
  const provider = req.body?.provider === 'meta_ads' ? 'meta_ads' : 'google_ads';
  const family = provider === 'meta_ads'
    ? (req.body?.family === 'meta_instant_form' ? 'meta_instant_form' : 'meta_reach')
    : (['google_search', 'google_pmax', 'google_smart_observe'].includes(req.body?.family) ? req.body.family : 'google_smart_observe');
  const id = crypto.randomUUID();
  const fundingId = crypto.randomUUID();
  const budget = safeObject(req.body?.budget);
  const requestedBudgetAmount = money(budget.amount);
  if (requestedBudgetAmount < 100 || requestedBudgetAmount > 1000000) {
    return res.status(400).json({
      success: false,
      error: 'managed_budget_required',
      message: 'Indica un presupuesto mensual total entre 100 € y 1.000.000 € para preparar la propuesta.',
    });
  }
  let existingId = null;
  let clinic = null;

  try {
    await db.sequelize.transaction(async (transaction) => {
      clinic = await Clinica.findByPk(clinicId, {
        attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!clinic) {
        const error = new Error('Clínica no encontrada');
        error.code = 'clinic_not_found';
        error.httpStatus = 404;
        throw error;
      }

      const existing = await ManagedCampaign.findOne({
        where: {
          clinica_id: clinicId,
          objective_id: 'new_patients',
          status: { [Op.notIn]: ['completed', 'cancelled'] },
        },
        transaction,
      });
      if (existing) {
        existingId = existing.id;
        return;
      }

      const references = await validateAutopilotReferences({
        clinicId,
        strategyCampaignId: req.body?.strategy_campaign_id,
        campaignRequestId: req.body?.campaign_request_id,
        transaction,
      });
      const transition = references.transition;
      const requestedTarget = safeObject(req.body?.target);
      const requestedDestination = safeObject(req.body?.destination);
      const name = clean(req.body?.name) || `Piloto automático · ${clinic.nombre_clinica}`;

      await ManagedCampaign.create({
        id,
        strategy_campaign_id: references.strategyCampaignId,
        campaign_request_id: references.campaignRequestId,
        objective_id: 'new_patients',
        clinica_id: clinicId,
        grupo_clinica_id: clinic.grupoClinicaId || null,
        management_mode: 'autopilot',
        legacy_mode: clean(req.body?.legacy_mode, 32),
        operation_mode: 'observe',
        provider,
        family,
        status: 'draft',
        name,
        target_config: {
          ...(transition?.targetConfig || {}),
          ...requestedTarget,
        },
        budget_config: {
          ...(transition?.budgetConfig || {}),
          amount: requestedBudgetAmount,
          currency: (clean(budget.currency, 3) || 'EUR').toUpperCase(),
          period: clean(budget.period, 16) || 'monthly',
          leads: null,
        },
        schedule_config: safeObject(req.body?.schedule),
        destination_config: {
          ...(transition?.destinationConfig || {}),
          ...requestedDestination,
        },
        audience_config: { eligibility_status: 'warning', reasons: ['pending_internal_review'] },
        creative_config: { assets_ready: false },
        tracking_plan: transition?.trackingPlan || { status: 'pending', conversion_actions_ready: false },
        platform_refs: transition?.platformRefs || {},
        review_config: {
          client_approval_required: true,
          admin_approval_required: true,
          requested_at: new Date().toISOString(),
          client_next_action: 'Esperar la propuesta del equipo ClinicaClick',
          ...(transition ? { transition: transition.reviewTransition } : {}),
        },
        policy_readiness: { status: 'warning', reasons: ['pending_internal_review'] },
        created_by_user_id: actorId,
        updated_by_user_id: actorId,
      }, { transaction });
      await ManagedCampaignFundingAccount.create({
        id: fundingId,
        managed_campaign_id: id,
        clinica_id: clinicId,
        grupo_clinica_id: clinic.grupoClinicaId || null,
        currency: (clean(budget.currency, 3) || 'EUR').toUpperCase(),
        status: 'unfunded',
        commission_type: 'percentage',
        commission_value: 0,
      }, { transaction });
    });
  } catch (error) {
    if (error?.httpStatus) {
      return res.status(error.httpStatus).json({
        success: false,
        error: error.code || 'autopilot_request_failed',
        message: error.message,
      });
    }
    throw error;
  }

  if (existingId) {
    const existingRow = (await loadRows({ id: existingId }))[0];
    return res.status(409).json({ success: false, error: 'autopilot_request_exists', campaign: publicCampaign(existingRow) });
  }

  return res.status(201).json({ success: true, campaign: publicCampaign((await loadRows({ id }))[0]) });
});

exports.approveClientProposal = asyncHandler(async (req, res) => {
  const actorId = userId(req);
  const row = await ManagedCampaign.findByPk(req.params.id);
  if (!actorId || !row) return res.status(404).json({ success: false, error: 'not_found' });
  if (!(await requireScope(req, res, [row.clinica_id], 'write'))) return;
  if (row.status !== 'pending_client_review') {
    return res.status(409).json({ success: false, error: 'proposal_not_waiting_client' });
  }
  const currentReview = safeObject(row.review_config);
  const proposalRevision = positiveInt(req.body?.proposal_revision);
  const expectedRevision = effectiveProposalRevision(currentReview, row.status);
  if (!proposalRevision || proposalRevision !== expectedRevision) {
    return res.status(409).json({
      success: false,
      error: 'stale_proposal_revision',
      message: 'La propuesta cambió. Recarga antes de aprobarla.',
    });
  }
  const review = {
    ...currentReview,
    proposal_revision: expectedRevision,
    client_approved_at: new Date().toISOString(),
    client_approved_by_user_id: actorId,
    client_next_action: 'Pendiente de revisión y preparación técnica por ClinicaClick',
  };
  const [updated] = await ManagedCampaign.update(
    { status: 'pending_admin_review', review_config: review, updated_by_user_id: actorId, version: Number(row.version || 1) + 1 },
    { where: { id: row.id, status: 'pending_client_review', version: row.version } }
  );
  if (!updated) return res.status(409).json({ success: false, error: 'proposal_state_conflict' });
  return res.json({ success: true, campaign: publicCampaign((await loadRows({ id: row.id }))[0]) });
});

exports.requestClientProposalChanges = asyncHandler(async (req, res) => {
  const actorId = userId(req);
  const row = await ManagedCampaign.findByPk(req.params.id);
  if (!actorId || !row) return res.status(404).json({ success: false, error: 'not_found' });
  if (!(await requireScope(req, res, [row.clinica_id], 'write'))) return;
  if (row.status !== 'pending_client_review') {
    return res.status(409).json({ success: false, error: 'proposal_not_waiting_client' });
  }
  const currentReview = safeObject(row.review_config);
  const proposalRevision = positiveInt(req.body?.proposal_revision);
  const expectedRevision = effectiveProposalRevision(currentReview, row.status);
  if (!proposalRevision || proposalRevision !== expectedRevision) {
    return res.status(409).json({
      success: false,
      error: 'stale_proposal_revision',
      message: 'La propuesta cambió. Recarga antes de solicitar modificaciones.',
    });
  }
  const reason = clean(req.body?.reason, 2000);
  if (!reason || reason.length < 5) {
    return res.status(400).json({
      success: false,
      error: 'change_reason_required',
      message: 'Explica brevemente qué quieres cambiar en la propuesta.',
    });
  }
  const requestedAt = new Date().toISOString();
  const review = {
    ...currentReview,
    proposal_revision: expectedRevision,
    client_change_request: {
      reason,
      requested_at: requestedAt,
      requested_by_user_id: actorId,
    },
    client_next_action: 'El equipo de ClinicaClick está revisando los cambios solicitados',
  };
  const [updated] = await ManagedCampaign.update({
      status: 'changes_requested',
      review_config: review,
      updated_by_user_id: actorId,
      version: Number(row.version || 1) + 1,
    }, {
      where: { id: row.id, status: 'pending_client_review', version: row.version },
    });
  if (!updated) return res.status(409).json({ success: false, error: 'proposal_state_conflict' });
  return res.json({ success: true, campaign: publicCampaign((await loadRows({ id: row.id }))[0]) });
});

exports.__test = {
  benchmarkCampaignsFromStrategyPayload,
  buildAutopilotTransitionSnapshot,
  isNewPatientsMarketingStrategyRequest,
  loadBenchmarkMetricsSnapshot,
  loadMetaCampaignAdMap,
  loadMetaCampaignInsightRows,
  loadMetaCampaignLeadActionRows,
  metaLeadConversionsFromActionRows,
  money,
  effectiveProposalRevision,
  publicCampaign,
  publicCampaignName,
  publicFunding,
  publicTargetConfig,
  publicBudgetConfig,
  publicDestinationConfig,
  validateAutopilotReferences,
};

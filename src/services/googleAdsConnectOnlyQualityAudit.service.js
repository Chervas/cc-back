'use strict';

const { googleAdsRequest, normalizeCustomerId } = require('../lib/googleAdsClient');
const {
  GOOGLE_ADS_SCOPE,
  resolveScopedGoogleAdsRuntime,
} = require('./googleAdsScopedRuntime.service');

const SCHEMA_VERSION = 'clinicaclick-google-ads-connect-only-campaign-quality/v1';
const MAX_CAMPAIGNS_PER_ACCOUNT = 200;
const BIDDING_EVENTS = new Set(['qualified_lead', 'schedule', 'purchase']);
const OBSERVATION_EVENTS = new Set(['lead', 'contact']);

function cleanCustomerId(value) {
  const normalized = normalizeCustomerId(value);
  return /^\d{10}$/.test(normalized) ? normalized : '';
}

function cleanPositiveId(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized) || /^0+$/.test(normalized)) return '';
  return normalized.replace(/^0+(?=\d)/, '');
}

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function providerObject(row, camelKey, snakeKey) {
  const value = row?.[camelKey] ?? row?.[snakeKey] ?? {};
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanString(value))
    .filter(Boolean))];
}

function extractGoogleCampaignReferences(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const collections = [source.external_targets, source.targets, source.measurement?.external_targets];
  const output = new Map();
  for (const collection of collections) {
    for (const target of Array.isArray(collection) ? collection : []) {
      const campaigns = Array.isArray(target?.campaigns)
        ? target.campaigns
        : (Array.isArray(target?.external_campaigns) ? target.external_campaigns : []);
      for (const campaign of campaigns) {
        const provider = String(campaign?.provider || campaign?.type || '').trim().toLowerCase();
        if (provider && !['google_ads', 'google'].includes(provider)) continue;
        const customerId = cleanCustomerId(
          campaign?.customer_id
            ?? campaign?.customerId
            ?? campaign?.provider_account_id
            ?? campaign?.providerAccountId
            ?? campaign?.account_id
            ?? campaign?.accountId,
        );
        const campaignId = cleanPositiveId(
          campaign?.external_campaign_id
            ?? campaign?.externalCampaignId
            ?? campaign?.campaign_id
            ?? campaign?.campaignId
            ?? campaign?.id,
        );
        if (!customerId || !campaignId) continue;
        const key = `${customerId}:${campaignId}`;
        if (output.has(key)) continue;
        output.set(key, {
          customer_id: customerId,
          campaign_id: campaignId,
          campaign_name: cleanString(campaign?.name ?? campaign?.campaign_name),
        });
      }
    }
  }
  return [...output.values()].sort((left, right) => (
    left.customer_id.localeCompare(right.customer_id)
      || left.campaign_id.localeCompare(right.campaign_id, 'en', { numeric: true })
  ));
}

function buildCampaignQualityGaql(campaignIds, { includeOptimizationScore = true } = {}) {
  const ids = uniqueStrings(campaignIds.map(cleanPositiveId)).filter(Boolean);
  if (!ids.length || ids.length > MAX_CAMPAIGNS_PER_ACCOUNT) {
    const error = new Error('campaign_quality_scope_invalid');
    error.code = 'CAMPAIGN_QUALITY_SCOPE_INVALID';
    throw error;
  }
  return [
    'SELECT',
    '  customer.currency_code,',
    '  campaign.id,',
    '  campaign.name,',
    '  campaign.status,',
    '  campaign.advertising_channel_type,',
    '  campaign.advertising_channel_sub_type,',
    '  campaign.bidding_strategy_type,',
    '  campaign.bidding_strategy,',
    '  campaign.primary_status,',
    '  campaign.primary_status_reasons,',
    ...(includeOptimizationScore ? ['  campaign.optimization_score,'] : []),
    '  campaign_budget.id,',
    '  campaign_budget.name,',
    '  campaign_budget.status,',
    '  campaign_budget.amount_micros,',
    '  campaign_budget.total_amount_micros,',
    '  campaign_budget.delivery_method,',
    '  campaign_budget.period,',
    '  metrics.cost_micros,',
    '  metrics.impressions,',
    '  metrics.clicks,',
    '  metrics.conversions,',
    '  metrics.all_conversions,',
    '  metrics.conversions_value,',
    '  metrics.all_conversions_value',
    'FROM campaign',
    `WHERE campaign.id IN (${ids.join(', ')})`,
    '  AND segments.date DURING LAST_30_DAYS',
  ].join('\n');
}

function buildCampaignExistenceGaql(campaignIds, { includeOptimizationScore = true } = {}) {
  const ids = uniqueStrings(campaignIds.map(cleanPositiveId)).filter(Boolean);
  if (!ids.length || ids.length > MAX_CAMPAIGNS_PER_ACCOUNT) {
    const error = new Error('campaign_existence_scope_invalid');
    error.code = 'CAMPAIGN_EXISTENCE_SCOPE_INVALID';
    throw error;
  }
  return [
    'SELECT',
    '  customer.currency_code,',
    '  campaign.id,',
    '  campaign.name,',
    '  campaign.status,',
    '  campaign.advertising_channel_type,',
    '  campaign.advertising_channel_sub_type,',
    '  campaign.bidding_strategy_type,',
    '  campaign.bidding_strategy,',
    '  campaign.primary_status,',
    '  campaign.primary_status_reasons,',
    ...(includeOptimizationScore ? ['  campaign.optimization_score,'] : []),
    '  campaign_budget.id,',
    '  campaign_budget.name,',
    '  campaign_budget.status,',
    '  campaign_budget.amount_micros,',
    '  campaign_budget.total_amount_micros,',
    '  campaign_budget.delivery_method,',
    '  campaign_budget.period',
    'FROM campaign',
    `WHERE campaign.id IN (${ids.join(', ')})`,
  ].join('\n');
}

function buildCampaignGoalGaql(campaignIds) {
  const ids = uniqueStrings(campaignIds.map(cleanPositiveId)).filter(Boolean);
  if (!ids.length || ids.length > MAX_CAMPAIGNS_PER_ACCOUNT) {
    const error = new Error('campaign_goal_scope_invalid');
    error.code = 'CAMPAIGN_GOAL_SCOPE_INVALID';
    throw error;
  }
  return [
    'SELECT',
    '  conversion_goal_campaign_config.resource_name,',
    '  conversion_goal_campaign_config.campaign,',
    '  conversion_goal_campaign_config.custom_conversion_goal,',
    '  conversion_goal_campaign_config.goal_config_level,',
    '  campaign.id,',
    '  campaign.name,',
    '  custom_conversion_goal.name,',
    '  custom_conversion_goal.status,',
    '  custom_conversion_goal.conversion_actions',
    'FROM conversion_goal_campaign_config',
    `WHERE campaign.id IN (${ids.join(', ')})`,
  ].join('\n');
}

async function searchGoogleAds({ runtime, query, request = googleAdsRequest }) {
  const response = await request('POST', `customers/${runtime.customerId}/googleAds:search`, {
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId || undefined,
    singleAttempt: true,
    timeoutMs: 20_000,
    data: { query },
  });
  return Array.isArray(response?.results) ? response.results : [];
}

function campaignQualityFromRow(row) {
  const customer = providerObject(row, 'customer', 'customer');
  const campaign = providerObject(row, 'campaign', 'campaign');
  const budget = providerObject(row, 'campaignBudget', 'campaign_budget');
  const metrics = providerObject(row, 'metrics', 'metrics');
  const campaignId = cleanPositiveId(campaign.id);
  const costMicros = numberOrZero(metrics.costMicros ?? metrics.cost_micros);
  return {
    campaign_id: campaignId || null,
    campaign_name: cleanString(campaign.name),
    read_status: campaignId ? 'observed' : 'not_found',
    exists: Boolean(campaignId),
    status: cleanString(campaign.status)?.toUpperCase() || null,
    advertising_channel_type: cleanString(
      campaign.advertisingChannelType ?? campaign.advertising_channel_type,
    )?.toUpperCase() || null,
    advertising_channel_sub_type: cleanString(
      campaign.advertisingChannelSubType ?? campaign.advertising_channel_sub_type,
    )?.toUpperCase() || null,
    bidding_strategy_type: cleanString(
      campaign.biddingStrategyType ?? campaign.bidding_strategy_type,
    )?.toUpperCase() || null,
    bidding_strategy_resource_name: cleanString(
      campaign.biddingStrategy ?? campaign.bidding_strategy,
    ),
    primary_status: cleanString(
      campaign.primaryStatus ?? campaign.primary_status,
    )?.toUpperCase() || null,
    primary_status_reasons: uniqueStrings(
      campaign.primaryStatusReasons ?? campaign.primary_status_reasons,
    ).map((value) => value.toUpperCase()),
    optimization_score: nullableNumber(
      campaign.optimizationScore ?? campaign.optimization_score,
    ),
    budget: {
      id: cleanPositiveId(budget.id) || null,
      name: cleanString(budget.name),
      status: cleanString(budget.status)?.toUpperCase() || null,
      amount_micros: nullableNumber(budget.amountMicros ?? budget.amount_micros),
      total_amount_micros: nullableNumber(
        budget.totalAmountMicros ?? budget.total_amount_micros,
      ),
      delivery_method: cleanString(
        budget.deliveryMethod ?? budget.delivery_method,
      )?.toUpperCase() || null,
      period: cleanString(budget.period)?.toUpperCase() || null,
      currency: cleanString(customer.currencyCode ?? customer.currency_code),
    },
    metrics_30d: {
      cost_micros: costMicros,
      cost: costMicros / 1_000_000,
      impressions: numberOrZero(metrics.impressions),
      clicks: numberOrZero(metrics.clicks),
      conversions: numberOrZero(metrics.conversions),
      all_conversions: numberOrZero(metrics.allConversions ?? metrics.all_conversions),
      conversion_value: numberOrZero(metrics.conversionsValue ?? metrics.conversions_value),
      all_conversions_value: numberOrZero(
        metrics.allConversionsValue ?? metrics.all_conversions_value,
      ),
    },
  };
}

function campaignGoalFromRow(row) {
  const config = providerObject(row, 'conversionGoalCampaignConfig', 'conversion_goal_campaign_config');
  const campaign = providerObject(row, 'campaign', 'campaign');
  const customGoal = providerObject(row, 'customConversionGoal', 'custom_conversion_goal');
  const campaignId = cleanPositiveId(campaign.id)
    || cleanPositiveId(String(config.campaign || '').split('/').pop());
  return {
    campaign_id: campaignId || null,
    goal_config_level: cleanString(
      config.goalConfigLevel ?? config.goal_config_level,
    )?.toUpperCase() || null,
    custom_goal_resource_name: cleanString(
      config.customConversionGoal ?? config.custom_conversion_goal,
    ),
    custom_goal_name: cleanString(customGoal.name),
    custom_goal_status: cleanString(customGoal.status)?.toUpperCase() || null,
    custom_goal_conversion_action_ids: uniqueStrings(
      customGoal.conversionActions ?? customGoal.conversion_actions,
    ).map((resourceName) => cleanPositiveId(resourceName.split('/').pop())).filter(Boolean).sort(
      (left, right) => left.localeCompare(right, 'en', { numeric: true }),
    ),
  };
}

function canonicalTargetsForCampaign(canonicalTargets, customerId, campaignId) {
  const output = new Map();
  for (const target of Array.isArray(canonicalTargets) ? canonicalTargets : []) {
    if (cleanCustomerId(target?.customer_id) !== customerId) continue;
    const scopedCampaignIds = uniqueStrings(
      Array.isArray(target?.campaign_ids) ? target.campaign_ids.map(cleanPositiveId) : [],
    ).filter(Boolean);
    if (scopedCampaignIds.length && !scopedCampaignIds.includes(campaignId)) continue;
    const actionId = cleanPositiveId(
      target?.canonical_conversion_action_id ?? target?.conversion_action_id,
    );
    const event = String(target?.event || '').trim().toLowerCase();
    if (!actionId || !event) continue;
    output.set(`${event}:${actionId}`, { event, conversion_action_id: actionId });
  }
  return [...output.values()];
}

function assessCanonicalGoalAlignment({ goal, canonicalTargets }) {
  const expected = Array.isArray(canonicalTargets) ? canonicalTargets : [];
  const expectedBidding = expected.filter((item) => BIDDING_EVENTS.has(item.event));
  const expectedObservation = expected.filter((item) => OBSERVATION_EVENTS.has(item.event));
  const observedIds = uniqueStrings(goal?.custom_goal_conversion_action_ids || []);
  const expectedBiddingIds = new Set(expectedBidding.map((item) => item.conversion_action_id));
  const expectedObservationIds = new Set(expectedObservation.map((item) => item.conversion_action_id));
  const observedBidding = observedIds.filter((id) => expectedBiddingIds.has(id));
  const observedObservation = observedIds.filter((id) => expectedObservationIds.has(id));
  const reasons = [];

  if (!expected.length || !expectedBidding.length) {
    reasons.push('canonical_bidding_mapping_missing');
    return {
      status: 'canonical_mapping_missing',
      expected_actions: expected,
      observed_action_ids: observedIds,
      aligned_bidding_action_id: null,
      reasons,
    };
  }
  if (!goal?.custom_goal_resource_name || goal?.goal_config_level !== 'CAMPAIGN') {
    reasons.push('campaign_uses_customer_level_goals');
    return {
      status: 'not_verifiable_customer_goals',
      expected_actions: expected,
      observed_action_ids: observedIds,
      aligned_bidding_action_id: null,
      reasons,
    };
  }
  if (goal.custom_goal_status !== 'ENABLED') reasons.push('custom_goal_not_enabled');
  if (observedBidding.length !== 1) reasons.push('single_canonical_bidding_signal_required');
  if (observedObservation.length) reasons.push('observation_action_used_for_bidding');
  if (observedIds.length !== 1) reasons.push('custom_goal_contains_noncanonical_or_multiple_actions');
  return {
    status: reasons.length ? 'misaligned' : 'aligned',
    expected_actions: expected,
    observed_action_ids: observedIds,
    aligned_bidding_action_id: observedBidding.length === 1 ? observedBidding[0] : null,
    reasons,
  };
}

function campaignIssuesAndRecommendations(campaign) {
  const issues = [];
  const recommendations = [];
  const pushIssue = (severity, code, message, details = {}) => issues.push({
    severity,
    code,
    message,
    campaign_id: campaign.campaign_id,
    ...details,
  });
  const recommend = (code, message) => recommendations.push({
    code,
    campaign_id: campaign.campaign_id,
    message,
  });

  if (!campaign.exists) {
    pushIssue('critical', 'CONNECTED_CAMPAIGN_NOT_FOUND', 'Google Ads no devolvió la campaña conectada.');
    recommend('VERIFY_CONNECTED_CAMPAIGN', 'Comprueba que la campaña siga existiendo y que la cuenta conectada sea la correcta.');
    return { issues, recommendations };
  }
  if (campaign.status === 'REMOVED') {
    pushIssue('critical', 'CONNECTED_CAMPAIGN_REMOVED', 'La campaña conectada está eliminada.');
    recommend('REASSIGN_CONNECTED_CAMPAIGN', 'Asigna una campaña activa a la estrategia.');
  } else if (campaign.status === 'PAUSED') {
    pushIssue('warning', 'CONNECTED_CAMPAIGN_PAUSED', 'La campaña conectada está pausada.');
    recommend('REVIEW_PAUSED_CAMPAIGN', 'Confirma si la pausa es intencionada.');
  }
  if (
    ['LIMITED', 'ELIGIBLE_LIMITED'].includes(campaign.primary_status)
    || (campaign.primary_status === 'ELIGIBLE' && campaign.primary_status_reasons.length)
  ) {
    pushIssue('warning', 'CAMPAIGN_DELIVERY_LIMITED', 'La campaña tiene limitaciones de publicación.', {
      primary_status: campaign.primary_status,
      primary_status_reasons: campaign.primary_status_reasons,
    });
    recommend('REVIEW_CAMPAIGN_LIMITATIONS', 'Revisa presupuesto, puja, políticas y activos según los motivos de Google.');
  } else if (campaign.primary_status && campaign.primary_status !== 'ELIGIBLE') {
    const severity = ['NOT_ELIGIBLE', 'REMOVED', 'ENDED'].includes(campaign.primary_status) ? 'critical' : 'warning';
    pushIssue(severity, 'CAMPAIGN_PRIMARY_STATUS_PROBLEM', `Google informa estado ${campaign.primary_status}.`, {
      primary_status: campaign.primary_status,
      primary_status_reasons: campaign.primary_status_reasons,
    });
    recommend('RESOLVE_GOOGLE_PRIMARY_STATUS', 'Revisa en Google Ads los motivos concretos que limitan la publicación.');
  }
  if (campaign.optimization_score !== null && campaign.optimization_score < 0.7) {
    pushIssue('warning', 'CAMPAIGN_OPTIMIZATION_SCORE_LOW', 'La puntuación de optimización es inferior al 70%.', {
      optimization_score: campaign.optimization_score,
    });
    recommend('REVIEW_OPTIMIZATION_RECOMMENDATIONS', 'Evalúa las recomendaciones de Google una a una; no se aplicarán automáticamente.');
  }
  if (campaign.metrics_30d.impressions === 0) {
    pushIssue('warning', 'CAMPAIGN_NO_IMPRESSIONS_30D', 'La campaña no registró impresiones en los últimos 30 días.');
    recommend('REVIEW_CAMPAIGN_DELIVERY', 'Comprueba fechas, segmentación, presupuesto, anuncios y palabras clave.');
  }
  if (campaign.metrics_30d.cost_micros > 0 && campaign.metrics_30d.all_conversions <= 0) {
    pushIssue('warning', 'CAMPAIGN_SPEND_WITHOUT_CONVERSIONS_30D', 'Hay gasto en 30 días sin conversiones registradas.');
    recommend('REVIEW_MEASUREMENT_AND_TRAFFIC_QUALITY', 'Revisa la medición y la calidad del tráfico antes de cambiar pujas.');
  }
  const alignment = campaign.goal_alignment || {};
  if (alignment.status === 'canonical_mapping_missing') {
    pushIssue(
      campaign.status === 'ENABLED' ? 'critical' : 'warning',
      'CANONICAL_GOAL_MAPPING_MISSING',
      'No existe una señal canónica de puja de ClinicaClick verificable para esta campaña.',
    );
    recommend('COMPLETE_CANONICAL_GOAL_MAPPING', 'Completa el mapeo de Qualified Lead, Schedule o Purchase antes de optimizar.');
  } else if (alignment.status === 'misaligned') {
    pushIssue('warning', 'CAMPAIGN_GOALS_NOT_ALIGNED_WITH_CLINICACLICK', 'Los objetivos de la campaña no coinciden con el contrato canónico de ClinicaClick.', {
      reasons: alignment.reasons,
    });
    recommend('REVIEW_CANONICAL_GOAL_ALIGNMENT', 'Revisa el objetivo de puja recomendado; esta auditoría no modificará la campaña.');
  } else if (alignment.status === 'not_verifiable_customer_goals') {
    pushIssue('warning', 'CAMPAIGN_USES_CUSTOMER_LEVEL_GOALS', 'La campaña hereda objetivos de cuenta y no se puede verificar una acción canónica única.');
    recommend('REVIEW_CUSTOM_GOAL_MIGRATION', 'Valora migrar la campaña a un objetivo canónico de ClinicaClick cuando corresponda.');
  }
  return { issues, recommendations };
}

function sanitizedProviderError(error) {
  const provider = error?.response?.data?.error || {};
  return {
    code: cleanString(error?.code || provider.status || provider.code) || 'GOOGLE_ADS_CAMPAIGN_QUALITY_READ_FAILED',
    http_status: Number(error?.response?.status || error?.httpStatus) || null,
    message: String(provider.message || error?.message || 'No se pudo leer Google Ads').slice(0, 1_000),
    request_id: cleanString(error?.response?.headers?.['request-id']),
  };
}

function sanitizeIssue(issue) {
  return {
    severity: ['critical', 'warning', 'info'].includes(String(issue?.severity || '').toLowerCase())
      ? String(issue.severity).toLowerCase()
      : 'warning',
    code: cleanString(issue?.code),
    reason: cleanString(issue?.reason),
    message: cleanString(issue?.message),
    customer_id: cleanCustomerId(issue?.customer_id) || null,
    campaign_id: cleanPositiveId(issue?.campaign_id) || null,
    primary_status: cleanString(issue?.primary_status),
    primary_status_reasons: uniqueStrings(issue?.primary_status_reasons),
    optimization_score: nullableNumber(issue?.optimization_score),
    reasons: uniqueStrings(issue?.reasons),
  };
}

function sanitizeRecommendation(item) {
  return {
    code: cleanString(item?.code),
    message: cleanString(item?.message),
    customer_id: cleanCustomerId(item?.customer_id) || null,
    campaign_id: cleanPositiveId(item?.campaign_id) || null,
  };
}

function sanitizeCampaignQualityReport(report) {
  const source = report && typeof report === 'object' && !Array.isArray(report) ? report : {};
  const accounts = (Array.isArray(source.accounts) ? source.accounts : []).map((account) => ({
    customer_id: cleanCustomerId(account?.customer_id) || null,
    optimization_score_available: typeof account?.optimization_score_available === 'boolean'
      ? account.optimization_score_available
      : null,
    request_count: nullableNumber(account?.request_count),
    campaigns: (Array.isArray(account?.campaigns) ? account.campaigns : []).map((campaign) => ({
      campaign_id: cleanPositiveId(campaign?.campaign_id) || null,
      campaign_name: cleanString(campaign?.campaign_name),
      read_status: cleanString(campaign?.read_status),
      exists: typeof campaign?.exists === 'boolean' ? campaign.exists : null,
      status: cleanString(campaign?.status),
      advertising_channel_type: cleanString(campaign?.advertising_channel_type),
      advertising_channel_sub_type: cleanString(campaign?.advertising_channel_sub_type),
      bidding_strategy_type: cleanString(campaign?.bidding_strategy_type),
      bidding_strategy_resource_name: cleanString(campaign?.bidding_strategy_resource_name),
      primary_status: cleanString(campaign?.primary_status),
      primary_status_reasons: uniqueStrings(campaign?.primary_status_reasons),
      optimization_score: nullableNumber(campaign?.optimization_score),
      budget: {
        id: cleanPositiveId(campaign?.budget?.id) || null,
        name: cleanString(campaign?.budget?.name),
        status: cleanString(campaign?.budget?.status),
        amount_micros: nullableNumber(campaign?.budget?.amount_micros),
        total_amount_micros: nullableNumber(campaign?.budget?.total_amount_micros),
        delivery_method: cleanString(campaign?.budget?.delivery_method),
        period: cleanString(campaign?.budget?.period),
        currency: cleanString(campaign?.budget?.currency),
      },
      metrics_30d: {
        cost_micros: numberOrZero(campaign?.metrics_30d?.cost_micros),
        cost: numberOrZero(campaign?.metrics_30d?.cost),
        impressions: numberOrZero(campaign?.metrics_30d?.impressions),
        clicks: numberOrZero(campaign?.metrics_30d?.clicks),
        conversions: numberOrZero(campaign?.metrics_30d?.conversions),
        all_conversions: numberOrZero(campaign?.metrics_30d?.all_conversions),
        conversion_value: numberOrZero(campaign?.metrics_30d?.conversion_value),
        all_conversions_value: numberOrZero(campaign?.metrics_30d?.all_conversions_value),
      },
      goal_alignment: {
        goal_config_level: cleanString(campaign?.goal_alignment?.goal_config_level),
        custom_goal_resource_name: cleanString(campaign?.goal_alignment?.custom_goal_resource_name),
        custom_goal_name: cleanString(campaign?.goal_alignment?.custom_goal_name),
        custom_goal_status: cleanString(campaign?.goal_alignment?.custom_goal_status),
        status: cleanString(campaign?.goal_alignment?.status),
        expected_actions: (Array.isArray(campaign?.goal_alignment?.expected_actions)
          ? campaign.goal_alignment.expected_actions
          : []).map((action) => ({
            event: cleanString(action?.event),
            conversion_action_id: cleanPositiveId(action?.conversion_action_id) || null,
          })),
        observed_action_ids: uniqueStrings(campaign?.goal_alignment?.observed_action_ids)
          .map(cleanPositiveId).filter(Boolean),
        aligned_bidding_action_id: cleanPositiveId(
          campaign?.goal_alignment?.aligned_bidding_action_id,
        ) || null,
        reasons: uniqueStrings(campaign?.goal_alignment?.reasons),
      },
      issues: (Array.isArray(campaign?.issues) ? campaign.issues : []).map(sanitizeIssue),
      recommendations: (Array.isArray(campaign?.recommendations)
        ? campaign.recommendations
        : []).map(sanitizeRecommendation),
    })),
    ...(account?.error ? {
      error: {
        code: cleanString(account.error.code),
        http_status: nullableNumber(account.error.http_status),
        message: cleanString(account.error.message),
        request_id: cleanString(account.error.request_id),
      },
    } : {}),
  }));
  return {
    schema_version: SCHEMA_VERSION,
    mode: cleanString(source.mode) || 'connect_only_campaign_quality_read_only',
    audited_at: cleanString(source.audited_at),
    window: cleanString(source.window) || 'LAST_30_DAYS',
    autorepair: false,
    external_mutation_count: 0,
    google_ads_mutated: false,
    healthy: source.healthy === true,
    summary: {
      account_count: numberOrZero(source.summary?.account_count),
      configured_campaign_count: numberOrZero(source.summary?.configured_campaign_count),
      observed_campaign_count: numberOrZero(source.summary?.observed_campaign_count),
      issue_count: numberOrZero(source.summary?.issue_count),
      critical_count: numberOrZero(source.summary?.critical_count),
      recommendation_count: numberOrZero(source.summary?.recommendation_count),
    },
    accounts,
    issues: (Array.isArray(source.issues) ? source.issues : []).map(sanitizeIssue),
    recommendations: (Array.isArray(source.recommendations)
      ? source.recommendations
      : []).map(sanitizeRecommendation),
  };
}

async function auditConnectOnlyCampaignQuality({
  scope,
  campaigns,
  canonicalTargets,
  runtimeCache = new Map(),
  dependencies = {},
  now = new Date(),
} = {}) {
  const refs = new Map();
  for (const raw of Array.isArray(campaigns) ? campaigns : []) {
    const customerId = cleanCustomerId(raw?.customer_id);
    const campaignId = cleanPositiveId(raw?.campaign_id);
    if (!customerId || !campaignId) continue;
    refs.set(`${customerId}:${campaignId}`, {
      customer_id: customerId,
      campaign_id: campaignId,
      campaign_name: cleanString(raw?.campaign_name),
    });
  }
  const grouped = new Map();
  for (const ref of refs.values()) {
    const list = grouped.get(ref.customer_id) || [];
    list.push(ref);
    grouped.set(ref.customer_id, list);
  }
  const resolveRuntime = dependencies.resolveRuntime || resolveScopedGoogleAdsRuntime;
  const request = dependencies.request || googleAdsRequest;
  const accounts = [];
  const allIssues = [];
  const allRecommendations = [];

  for (const [customerId, accountRefs] of grouped.entries()) {
    const campaignIdChunks = [];
    const allCampaignIds = accountRefs.map((ref) => ref.campaign_id);
    for (let offset = 0; offset < allCampaignIds.length; offset += MAX_CAMPAIGNS_PER_ACCOUNT) {
      campaignIdChunks.push(allCampaignIds.slice(offset, offset + MAX_CAMPAIGNS_PER_ACCOUNT));
    }
    try {
      let runtime = runtimeCache instanceof Map ? runtimeCache.get(customerId) : null;
      if (!runtime) {
        runtime = await resolveRuntime({
          userId: scope?.user_id ?? scope?.userId ?? null,
          clinicId: scope?.clinic_id ?? scope?.clinicId ?? null,
          groupId: scope?.group_id ?? scope?.groupId ?? null,
          assignmentScope: scope?.assignment_scope ?? scope?.assignmentScope ?? null,
          customerId,
          requiredScopes: [GOOGLE_ADS_SCOPE],
        });
        if (runtimeCache instanceof Map) runtimeCache.set(customerId, runtime);
      }
      if (cleanCustomerId(runtime?.customerId) !== customerId) {
        const error = new Error('campaign_quality_runtime_account_mismatch');
        error.code = 'CAMPAIGN_QUALITY_RUNTIME_ACCOUNT_MISMATCH';
        throw error;
      }
      let qualityRows = [];
      let goalRows = [];
      let optimizationScoreAvailable = true;
      let requestCount = 0;
      for (const campaignIds of campaignIdChunks) {
        let chunkQualityRows;
        try {
          chunkQualityRows = await searchGoogleAds({
            runtime,
            request,
            query: buildCampaignQualityGaql(campaignIds, {
              includeOptimizationScore: optimizationScoreAvailable,
            }),
          });
          requestCount += 1;
        } catch (error) {
          const providerMessage = String(error?.response?.data?.error?.message || error?.message || '').toLowerCase();
          if (!optimizationScoreAvailable || !providerMessage.includes('optimization_score')) throw error;
          optimizationScoreAvailable = false;
          chunkQualityRows = await searchGoogleAds({
            runtime,
            request,
            query: buildCampaignQualityGaql(campaignIds, { includeOptimizationScore: false }),
          });
          requestCount += 2;
        }
        const qualityObservedIds = new Set(chunkQualityRows
          .map((row) => cleanPositiveId(providerObject(row, 'campaign', 'campaign').id))
          .filter(Boolean));
        const missingFromMetricQuery = campaignIds.filter((campaignId) => !qualityObservedIds.has(campaignId));
        if (missingFromMetricQuery.length) {
          const existenceRows = await searchGoogleAds({
            runtime,
            request,
            query: buildCampaignExistenceGaql(missingFromMetricQuery, {
              includeOptimizationScore: optimizationScoreAvailable,
            }),
          });
          requestCount += 1;
          chunkQualityRows = [...chunkQualityRows, ...existenceRows];
        }
        const chunkGoalRows = await searchGoogleAds({
          runtime,
          request,
          query: buildCampaignGoalGaql(campaignIds),
        });
        requestCount += 1;
        qualityRows.push(...chunkQualityRows);
        goalRows.push(...chunkGoalRows);
      }
      const qualityById = new Map(qualityRows
        .map(campaignQualityFromRow)
        .filter((campaign) => campaign.campaign_id)
        .map((campaign) => [campaign.campaign_id, campaign]));
      const goalById = new Map(goalRows
        .map(campaignGoalFromRow)
        .filter((goal) => goal.campaign_id)
        .map((goal) => [goal.campaign_id, goal]));
      const accountCampaigns = accountRefs.map((ref) => {
        const observed = qualityById.get(ref.campaign_id) || {
          campaign_id: ref.campaign_id,
          campaign_name: ref.campaign_name,
          read_status: 'not_found',
          exists: false,
          status: null,
          advertising_channel_type: null,
          advertising_channel_sub_type: null,
          bidding_strategy_type: null,
          bidding_strategy_resource_name: null,
          primary_status: null,
          primary_status_reasons: [],
          optimization_score: null,
          budget: {
            id: null,
            name: null,
            status: null,
            amount_micros: null,
            total_amount_micros: null,
            delivery_method: null,
            period: null,
            currency: null,
          },
          metrics_30d: {
            cost_micros: 0,
            cost: 0,
            impressions: 0,
            clicks: 0,
            conversions: 0,
            all_conversions: 0,
            conversion_value: 0,
            all_conversions_value: 0,
          },
        };
        const goal = goalById.get(ref.campaign_id) || {
          campaign_id: ref.campaign_id,
          goal_config_level: null,
          custom_goal_resource_name: null,
          custom_goal_name: null,
          custom_goal_status: null,
          custom_goal_conversion_action_ids: [],
        };
        const alignment = assessCanonicalGoalAlignment({
          goal,
          canonicalTargets: canonicalTargetsForCampaign(
            canonicalTargets,
            customerId,
            ref.campaign_id,
          ),
        });
        const campaign = {
          ...observed,
          goal_alignment: {
            goal_config_level: goal.goal_config_level,
            custom_goal_resource_name: goal.custom_goal_resource_name,
            custom_goal_name: goal.custom_goal_name,
            custom_goal_status: goal.custom_goal_status,
            ...alignment,
          },
        };
        const assessed = campaignIssuesAndRecommendations(campaign);
        campaign.issues = assessed.issues;
        campaign.recommendations = assessed.recommendations;
        allIssues.push(...assessed.issues.map((issue) => ({ ...issue, customer_id: customerId })));
        allRecommendations.push(...assessed.recommendations.map((item) => ({ ...item, customer_id: customerId })));
        return campaign;
      });
      accounts.push({
        customer_id: customerId,
        optimization_score_available: optimizationScoreAvailable,
        request_count: requestCount,
        campaigns: accountCampaigns,
      });
    } catch (error) {
      const safeError = sanitizedProviderError(error);
      const issue = {
        severity: 'critical',
        code: safeError.code,
        message: safeError.message,
        customer_id: customerId,
      };
      allIssues.push(issue);
      accounts.push({
        customer_id: customerId,
        optimization_score_available: null,
        request_count: null,
        campaigns: accountRefs.map((ref) => ({
          campaign_id: ref.campaign_id,
          campaign_name: ref.campaign_name,
          read_status: 'unavailable',
          exists: null,
          status: null,
          advertising_channel_type: null,
          advertising_channel_sub_type: null,
          bidding_strategy_type: null,
          bidding_strategy_resource_name: null,
          primary_status: null,
          primary_status_reasons: [],
          optimization_score: null,
          budget: {},
          metrics_30d: {},
          goal_alignment: {
            status: 'unavailable',
            expected_actions: [],
            observed_action_ids: [],
            aligned_bidding_action_id: null,
            reasons: ['google_ads_read_failed'],
          },
          issues: [{ ...issue, campaign_id: ref.campaign_id }],
          recommendations: [],
        })),
        error: safeError,
      });
    }
  }

  if (!refs.size) {
    allIssues.push({
      severity: 'critical',
      code: 'CONNECT_ONLY_CONNECTED_CAMPAIGNS_MISSING',
      message: 'La estrategia Mide y mejora no contiene campañas Google Ads conectadas auditables.',
    });
  }
  const observedCampaignCount = accounts.reduce((sum, account) => (
    sum + account.campaigns.filter((campaign) => campaign.exists === true).length
  ), 0);
  const criticalCount = allIssues.filter((issue) => issue.severity === 'critical').length;
  return {
    schema_version: SCHEMA_VERSION,
    mode: 'connect_only_campaign_quality_read_only',
    audited_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    window: 'LAST_30_DAYS',
    autorepair: false,
    external_mutation_count: 0,
    google_ads_mutated: false,
    summary: {
      account_count: accounts.length,
      configured_campaign_count: refs.size,
      observed_campaign_count: observedCampaignCount,
      issue_count: allIssues.length,
      critical_count: criticalCount,
      recommendation_count: allRecommendations.length,
    },
    healthy: criticalCount === 0,
    accounts,
    issues: allIssues.slice(0, 200),
    recommendations: allRecommendations.slice(0, 200),
  };
}

module.exports = {
  SCHEMA_VERSION,
  assessCanonicalGoalAlignment,
  auditConnectOnlyCampaignQuality,
  buildCampaignExistenceGaql,
  buildCampaignGoalGaql,
  buildCampaignQualityGaql,
  campaignGoalFromRow,
  campaignIssuesAndRecommendations,
  campaignQualityFromRow,
  extractGoogleCampaignReferences,
  sanitizeCampaignQualityReport,
};

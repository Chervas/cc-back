'use strict';

const { googleAdsRequest, normalizeCustomerId } = require('../lib/googleAdsClient');
const {
  GOOGLE_ADS_SCOPE,
  resolveScopedGoogleAdsRuntime,
} = require('./googleAdsScopedRuntime.service');

const ADAPTER_VERSION = 'managed-google-search-execution-adapter/v3';
const MARKER_PREFIX = 'CCME';
const PROVIDER_CALL_TIMEOUT_MS = 2 * 60 * 1000;
const SCHEDULE_DAYS = new Set([
  'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY',
]);
const SCHEDULE_MINUTES = new Set(['ZERO', 'FIFTEEN', 'THIRTY', 'FORTY_FIVE']);
const POSITIVE_GEO_TYPES = new Set(['PRESENCE', 'PRESENCE_OR_INTEREST']);
const REQUIRED_ACTIVATION_CONFIRMATIONS = Object.freeze([
  'confirm_activation',
  'confirm_budget_commitment',
  'confirm_targeting_configuration',
  'confirm_schedule_configuration',
  'confirm_policy_compliance',
  'confirm_recent_approval',
]);

class ManagedCampaignGoogleSearchExecutionError extends Error {
  constructor(code, message, { retryable = false, manualRecoveryRequired = false, cause = null } = {}) {
    super(message);
    this.name = 'ManagedCampaignGoogleSearchExecutionError';
    this.code = code;
    this.retryable = retryable;
    this.manualRecoveryRequired = manualRecoveryRequired;
    // Axios/provider errors can contain Authorization headers in their config.
    // Keep the cause available to control retry timing but never enumerable so
    // JobRequest.result_summary cannot serialize credentials accidentally.
    if (cause) {
      Object.defineProperty(this, 'cause', {
        value: cause,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
  }
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function beforeProviderMutation(dependencies, context) {
  if (typeof dependencies.beforeMutation !== 'function') {
    if (dependencies.requireMutationGuard === true) {
      throw new ManagedCampaignGoogleSearchExecutionError(
        'managed_google_mutation_guard_missing',
        'La mutación Google requiere un fencing durable y una autorización reciente.'
      );
    }
    return;
  }
  await dependencies.beforeMutation(context);
}

function text(value, max = 2_048) {
  const clean = String(value ?? '').trim();
  return clean ? clean.slice(0, max) : null;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function cleanCustomerId(value) {
  const normalized = normalizeCustomerId(value);
  return /^\d{10}$/.test(normalized) ? normalized : null;
}

function executionMarker(executionId, planHash) {
  const id = text(executionId, 36);
  const hash = text(planHash, 64);
  if (!id || !hash || !/^[a-f0-9]{64}$/i.test(hash)) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_execution_identity_invalid',
      'La ejecución no tiene una identidad durable válida.'
    );
  }
  return `${MARKER_PREFIX}-${id.replace(/[^a-z0-9]/gi, '').slice(0, 12)}-${hash.slice(0, 10).toLowerCase()}`;
}

function ownedCampaignName(specification, marker) {
  const suffix = ` · [${marker}]`;
  const base = text(specification?.name, 255 - suffix.length);
  if (!base) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_campaign_name_required',
      'Google Search requiere un nombre de campaña.'
    );
  }
  return `${base}${suffix}`;
}

function resourceName(customerId, collection, temporaryId) {
  return `customers/${customerId}/${collection}/${temporaryId}`;
}

function numericConstantIds(value) {
  const values = list(value).map((item) => text(item, 32)).filter(Boolean);
  return values.length > 0 && values.every((item) => /^\d+$/.test(item))
    && new Set(values).size === values.length
    ? values
    : [];
}

function normalizedSchedules(value) {
  const schedules = list(value).map((item) => {
    const row = safeObject(item);
    return {
      day_of_week: text(row.day_of_week, 32)?.toUpperCase(),
      start_hour: Number(row.start_hour),
      start_minute: text(row.start_minute, 32)?.toUpperCase(),
      end_hour: Number(row.end_hour),
      end_minute: text(row.end_minute, 32)?.toUpperCase(),
    };
  });
  const minuteNumber = { ZERO: 0, FIFTEEN: 15, THIRTY: 30, FORTY_FIVE: 45 };
  const valid = schedules.length > 0 && schedules.every((item) => (
    SCHEDULE_DAYS.has(item.day_of_week)
    && Number.isInteger(item.start_hour) && item.start_hour >= 0 && item.start_hour <= 23
    && Number.isInteger(item.end_hour) && item.end_hour >= 0 && item.end_hour <= 24
    && SCHEDULE_MINUTES.has(item.start_minute)
    && SCHEDULE_MINUTES.has(item.end_minute)
    && !(item.end_hour === 24 && item.end_minute !== 'ZERO')
    && item.start_hour * 60 + minuteNumber[item.start_minute]
      < item.end_hour * 60 + minuteNumber[item.end_minute]
  ));
  return valid && new Set(schedules.map((item) => JSON.stringify(item))).size === schedules.length
    ? schedules
    : [];
}

function ianaTimeZone(value) {
  const clean = text(value, 128);
  if (!clean) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: clean }).format(new Date(0));
    return clean;
  } catch (_) {
    return null;
  }
}

function assertExecutableInput({ execution, plan }) {
  const spec = safeObject(plan?.specification);
  const provider = text(plan?.campaign?.provider, 32);
  const family = text(plan?.campaign?.family, 64);
  const customerId = cleanCustomerId(spec.account_id);
  const operation = text(spec.operation, 32);
  const dryRun = safeObject(plan?.dry_run_adapter);
  const budget = safeObject(dryRun.budget);
  const dailyMicros = Number(budget.planning_daily_amount_micros);
  const finalUrl = text(spec.final_url, 2_048);
  const headlines = list(safeObject(spec.creative).headlines).map((item) => text(item, 30)).filter(Boolean);
  const descriptions = list(safeObject(spec.creative).descriptions).map((item) => text(item, 90)).filter(Boolean);
  const keywords = list(safeObject(spec.ad_group).keywords).map((item) => text(item, 80)).filter(Boolean);
  const targeting = safeObject(spec.targeting);
  const schedule = safeObject(spec.schedule);
  const planCurrency = text(safeObject(spec.budget).currency, 3)?.toUpperCase();
  const executionCurrency = text(execution?.currency, 3)?.toUpperCase();
  const scheduleTimeZone = ianaTimeZone(schedule.time_zone);
  const geoTargetConstantIds = numericConstantIds(targeting.geo_target_constant_ids);
  const languageConstantIds = numericConstantIds(targeting.language_constant_ids);
  const positiveGeoTargetType = text(targeting.positive_geo_target_type, 64)?.toUpperCase();
  const negativeGeoTargetType = text(targeting.negative_geo_target_type, 64)?.toUpperCase();
  const adSchedules = normalizedSchedules(schedule.ad_schedules);

  if (provider !== 'google_ads' || family !== 'google_search') {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_provider_family_unsupported',
      'La ejecución real solo admite Google Search.'
    );
  }
  if (operation !== 'create_new') {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_operation_unsupported',
      'La ejecución real no modifica campañas existentes; solo crea una campaña nueva en PAUSED.'
    );
  }
  if (!customerId || !Number.isSafeInteger(dailyMicros) || dailyMicros <= 0
    || !/^https:\/\//i.test(finalUrl || '') || headlines.length < 3
    || descriptions.length < 2 || keywords.length < 1
    || geoTargetConstantIds.length < 1 || languageConstantIds.length < 1
    || !POSITIVE_GEO_TYPES.has(positiveGeoTargetType)
    || negativeGeoTargetType !== 'PRESENCE' || adSchedules.length < 1
    || !scheduleTimeZone || !/^[A-Z]{3}$/.test(planCurrency || '')
    || planCurrency !== executionCurrency) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_plan_not_executable',
      'El plan Search no conserva presupuesto, destino, keywords, creatividades, ubicación, idiomas y horario válidos.'
    );
  }
  const marker = executionMarker(execution?.id, plan?.plan_hash);
  const campaignName = ownedCampaignName(spec, marker);
  return {
    customerId,
    marker,
    campaignName,
    // Non-shared Google budgets derive and keep their name in sync with the
    // owning campaign. Use that canonical name so readback remains exact.
    budgetName: campaignName,
    adGroupName: `${campaignName.slice(0, 235)} · Principal`,
    dailyMicros,
    finalUrl,
    headlines,
    descriptions,
    keywords,
    geoTargetConstantIds,
    languageConstantIds,
    positiveGeoTargetType,
    negativeGeoTargetType,
    currency: planCurrency,
    scheduleTimeZone,
    adSchedules,
    clinicId: Number(plan?.campaign?.clinic_id) || null,
    groupId: Number(plan?.campaign?.group_id) || null,
  };
}

function buildCreateOperations({
  customerId,
  marker,
  campaignName,
  budgetName = campaignName,
  adGroupName = `${campaignName.slice(0, 235)} · Principal`,
  dailyMicros,
  finalUrl,
  headlines,
  descriptions,
  keywords,
  geoTargetConstantIds,
  languageConstantIds,
  positiveGeoTargetType,
  negativeGeoTargetType,
  adSchedules,
}) {
  const budgetRef = resourceName(customerId, 'campaignBudgets', -1);
  const campaignRef = resourceName(customerId, 'campaigns', -2);
  const adGroupRef = resourceName(customerId, 'adGroups', -3);
  const operations = [
    {
      campaignBudgetOperation: {
        create: {
          resourceName: budgetRef,
          name: budgetName,
          amountMicros: String(dailyMicros),
          deliveryMethod: 'STANDARD',
          explicitlyShared: false,
        },
      },
    },
    {
      campaignOperation: {
        create: {
          resourceName: campaignRef,
          name: campaignName,
          advertisingChannelType: 'SEARCH',
          status: 'PAUSED',
          campaignBudget: budgetRef,
          maximizeConversions: {},
          containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          geoTargetTypeSetting: {
            positiveGeoTargetType,
            negativeGeoTargetType,
          },
          networkSettings: {
            targetGoogleSearch: true,
            targetSearchNetwork: false,
            targetContentNetwork: false,
            targetPartnerSearchNetwork: false,
          },
        },
      },
    },
    ...geoTargetConstantIds.map((criterionId) => ({
      campaignCriterionOperation: {
        create: {
          campaign: campaignRef,
          status: 'ENABLED',
          negative: false,
          location: { geoTargetConstant: `geoTargetConstants/${criterionId}` },
        },
      },
    })),
    ...languageConstantIds.map((criterionId) => ({
      campaignCriterionOperation: {
        create: {
          campaign: campaignRef,
          status: 'ENABLED',
          negative: false,
          language: { languageConstant: `languageConstants/${criterionId}` },
        },
      },
    })),
    ...adSchedules.map((item) => ({
      campaignCriterionOperation: {
        create: {
          campaign: campaignRef,
          status: 'ENABLED',
          negative: false,
          adSchedule: {
            dayOfWeek: item.day_of_week,
            startHour: item.start_hour,
            startMinute: item.start_minute,
            endHour: item.end_hour,
            endMinute: item.end_minute,
          },
        },
      },
    })),
    {
      adGroupOperation: {
        create: {
          resourceName: adGroupRef,
          campaign: campaignRef,
          name: adGroupName,
          type: 'SEARCH_STANDARD',
          status: 'PAUSED',
        },
      },
    },
    ...keywords.map((keyword) => ({
      adGroupCriterionOperation: {
        create: {
          adGroup: adGroupRef,
          status: 'ENABLED',
          keyword: { text: keyword, matchType: 'PHRASE' },
        },
      },
    })),
    {
      adGroupAdOperation: {
        create: {
          adGroup: adGroupRef,
          status: 'PAUSED',
          ad: {
            finalUrls: [finalUrl],
            responsiveSearchAd: {
              headlines: headlines.map((value) => ({ text: value })),
              descriptions: descriptions.map((value) => ({ text: value })),
            },
          },
        },
      },
    },
  ];
  return {
    marker,
    campaignName,
    operations,
    expected: {
      keyword_count: keywords.length,
      campaign_criterion_count: geoTargetConstantIds.length + languageConstantIds.length + adSchedules.length,
      campaign_status: 'PAUSED',
      ad_group_status: 'PAUSED',
      ad_status: 'PAUSED',
    },
  };
}

function gaqlLiteral(value) {
  return `'${String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function search(request, runtime, customerId, query) {
  const response = await request('POST', `customers/${customerId}/googleAds:search`, {
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId || undefined,
    data: { query },
    singleAttempt: true,
    timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
  });
  return Array.isArray(response?.results) ? response.results : [];
}

async function inspectCustomerContract({ request, runtime, input }) {
  const rows = await search(request, runtime, input.customerId, [
    'SELECT customer.id, customer.currency_code, customer.time_zone',
    'FROM customer',
    'LIMIT 1',
  ].join('\n'));
  if (rows.length !== 1) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_customer_contract_unavailable',
      'No se pudo leer de forma inequívoca la moneda y zona horaria de la cuenta Google Ads.'
    );
  }
  const customer = readField(rows[0], 'customer', 'customer');
  const customerId = cleanCustomerId(customer.id ?? input.customerId);
  const currency = text(customer.currencyCode ?? customer.currency_code, 3)?.toUpperCase();
  const timeZone = ianaTimeZone(customer.timeZone ?? customer.time_zone);
  if (customerId !== input.customerId || currency !== input.currency || timeZone !== input.scheduleTimeZone) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_customer_contract_mismatch',
      'La moneda o zona horaria del plan no coincide con la configuración real de la cuenta Google Ads.'
    );
  }
  return {
    customer_id: customerId,
    currency_code: currency,
    time_zone: timeZone,
    source: 'google_ads_customer_readback',
  };
}

function withCustomerContract(outcome, customerContract) {
  return {
    ...outcome,
    ownership: {
      ...safeObject(outcome?.ownership),
      customer_contract: customerContract,
    },
  };
}

function readField(row, camel, snake) {
  return row?.[camel] ?? row?.[snake] ?? {};
}

async function inspectOwnedCampaign({ request, runtime, input, expectedHierarchyStatus = 'PAUSED' }) {
  const expectedStatus = text(expectedHierarchyStatus, 32)?.toUpperCase();
  if (!['PAUSED', 'ENABLED'].includes(expectedStatus)) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_expected_status_invalid',
      'La comprobación de propiedad requiere PAUSED o ENABLED.'
    );
  }
  const campaignRows = await search(request, runtime, input.customerId, [
    'SELECT campaign.id, campaign.resource_name, campaign.name, campaign.status,',
    'campaign.advertising_channel_type, campaign.campaign_budget, campaign.bidding_strategy_type,',
    'campaign.contains_eu_political_advertising,',
    'campaign.geo_target_type_setting.positive_geo_target_type,',
    'campaign.geo_target_type_setting.negative_geo_target_type,',
    'campaign.network_settings.target_google_search,',
    'campaign.network_settings.target_search_network,',
    'campaign.network_settings.target_content_network,',
    'campaign.network_settings.target_partner_search_network,',
    'campaign_budget.resource_name, campaign_budget.name, campaign_budget.amount_micros,',
    'campaign_budget.delivery_method, campaign_budget.explicitly_shared',
    'FROM campaign',
    `WHERE campaign.name = ${gaqlLiteral(input.campaignName)}`,
    'AND campaign.status != REMOVED',
  ].join('\n'));
  if (!campaignRows.length) return { found: false };
  if (campaignRows.length !== 1) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_ownership_ambiguous',
      'Google devolvió más de una campaña con la marca durable de esta ejecución.',
      { manualRecoveryRequired: true }
    );
  }
  const campaign = readField(campaignRows[0], 'campaign', 'campaign');
  const campaignResource = text(campaign.resourceName ?? campaign.resource_name, 512);
  const campaignId = text(campaign.id, 64);
  const campaignStatus = text(campaign.status, 32)?.toUpperCase();
  const channel = text(campaign.advertisingChannelType ?? campaign.advertising_channel_type, 64)?.toUpperCase();
  const biddingStrategy = text(campaign.biddingStrategyType ?? campaign.bidding_strategy_type, 64)?.toUpperCase();
  const politicalAdvertising = text(
    campaign.containsEuPoliticalAdvertising ?? campaign.contains_eu_political_advertising,
    64
  )?.toUpperCase();
  const network = safeObject(campaign.networkSettings ?? campaign.network_settings);
  const geoTargetTypeSetting = safeObject(campaign.geoTargetTypeSetting ?? campaign.geo_target_type_setting);
  const budgetResource = text(campaign.campaignBudget ?? campaign.campaign_budget, 512);
  const campaignBudget = readField(campaignRows[0], 'campaignBudget', 'campaign_budget');
  const budgetResourceFromJoin = text(campaignBudget.resourceName ?? campaignBudget.resource_name, 512);
  const budgetName = text(campaignBudget.name, 255);
  const budgetMicros = Number(campaignBudget.amountMicros ?? campaignBudget.amount_micros);
  const budgetDelivery = text(campaignBudget.deliveryMethod ?? campaignBudget.delivery_method, 32)?.toUpperCase();
  const budgetShared = campaignBudget.explicitlyShared ?? campaignBudget.explicitly_shared ?? false;
  if (!campaignResource || !campaignId || campaign.name !== input.campaignName
    || campaignStatus !== expectedStatus || channel !== 'SEARCH' || biddingStrategy !== 'MAXIMIZE_CONVERSIONS'
    || politicalAdvertising !== 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'
    || text(geoTargetTypeSetting.positiveGeoTargetType ?? geoTargetTypeSetting.positive_geo_target_type, 64)?.toUpperCase()
      !== input.positiveGeoTargetType
    || text(geoTargetTypeSetting.negativeGeoTargetType ?? geoTargetTypeSetting.negative_geo_target_type, 64)?.toUpperCase()
      !== input.negativeGeoTargetType
    || (network.targetGoogleSearch ?? network.target_google_search) !== true
    || (network.targetSearchNetwork ?? network.target_search_network ?? false) !== false
    || (network.targetContentNetwork ?? network.target_content_network ?? false) !== false
    || (network.targetPartnerSearchNetwork ?? network.target_partner_search_network ?? false) !== false
    || !campaignResource.startsWith(`customers/${input.customerId}/campaigns/`)
    || !budgetResource?.startsWith(`customers/${input.customerId}/campaignBudgets/`)
    || budgetResourceFromJoin !== budgetResource
    || budgetName !== input.budgetName
    || budgetMicros !== input.dailyMicros
    || budgetDelivery !== 'STANDARD'
    || budgetShared !== false) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_ownership_guard_failed',
      `La campaña encontrada no conserva identidad, tipo y estado ${expectedStatus} compatibles con esta ejecución.`,
      { manualRecoveryRequired: true }
    );
  }

  const adRows = await search(request, runtime, input.customerId, [
    'SELECT ad_group.resource_name, ad_group.name, ad_group.status, ad_group.type,',
    'ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.type, ad_group_ad.ad.final_urls,',
    'ad_group_ad.ad.responsive_search_ad.headlines,',
    'ad_group_ad.ad.responsive_search_ad.descriptions',
    'FROM ad_group_ad',
    `WHERE campaign.id = ${campaignId}`,
    'AND ad_group.status != REMOVED',
    'AND ad_group_ad.status != REMOVED',
  ].join('\n'));
  const criterionRows = await search(request, runtime, input.customerId, [
    'SELECT ad_group.resource_name, ad_group_criterion.resource_name, ad_group_criterion.status,',
    'ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type',
    'FROM keyword_view',
    `WHERE campaign.id = ${campaignId}`,
    'AND ad_group_criterion.status != REMOVED',
  ].join('\n'));
  const campaignCriterionRows = await search(request, runtime, input.customerId, [
    'SELECT campaign_criterion.resource_name, campaign_criterion.status, campaign_criterion.type,',
    'campaign_criterion.negative, campaign_criterion.location.geo_target_constant,',
    'campaign_criterion.language.language_constant, campaign_criterion.ad_schedule.day_of_week,',
    'campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.start_minute,',
    'campaign_criterion.ad_schedule.end_hour, campaign_criterion.ad_schedule.end_minute',
    'FROM campaign_criterion',
    `WHERE campaign_criterion.campaign = ${gaqlLiteral(campaignResource)}`,
    'AND campaign_criterion.type IN (LOCATION, LANGUAGE, AD_SCHEDULE)',
    'AND campaign_criterion.status != REMOVED',
  ].join('\n'));
  const adGroupResources = Array.from(new Set(adRows.map((row) => {
    const value = readField(row, 'adGroup', 'ad_group');
    return text(value.resourceName ?? value.resource_name, 512);
  }).filter(Boolean)));
  const adResources = adRows.map((row) => {
    const value = readField(row, 'adGroupAd', 'ad_group_ad');
    return text(value.resourceName ?? value.resource_name, 512);
  }).filter(Boolean);
  const criterionResources = criterionRows.map((row) => {
    const value = readField(row, 'adGroupCriterion', 'ad_group_criterion');
    return text(value.resourceName ?? value.resource_name, 512);
  }).filter(Boolean);
  const campaignCriterionResources = campaignCriterionRows.map((row) => {
    const value = readField(row, 'campaignCriterion', 'campaign_criterion');
    return text(value.resourceName ?? value.resource_name, 512);
  }).filter(Boolean).sort();
  const pausedChildren = adRows.every((row) => {
    const adGroup = readField(row, 'adGroup', 'ad_group');
    const ad = readField(row, 'adGroupAd', 'ad_group_ad');
    return text(adGroup.status, 32)?.toUpperCase() === expectedStatus
      && text(ad.status, 32)?.toUpperCase() === expectedStatus;
  });
  const exactAdGroups = adRows.every((row) => {
    const adGroup = readField(row, 'adGroup', 'ad_group');
    return text(adGroup.name, 255) === input.adGroupName
      && text(adGroup.type, 64)?.toUpperCase() === 'SEARCH_STANDARD';
  });
  const exactAds = adRows.every((row) => {
    const adGroupAd = readField(row, 'adGroupAd', 'ad_group_ad');
    const ad = safeObject(adGroupAd.ad);
    const rsa = safeObject(ad.responsiveSearchAd ?? ad.responsive_search_ad);
    const finalUrls = list(ad.finalUrls ?? ad.final_urls).map((value) => text(value, 2_048)).filter(Boolean);
    const headlines = list(rsa.headlines).map((item) => text(item?.text, 30)).filter(Boolean);
    const descriptions = list(rsa.descriptions).map((item) => text(item?.text, 90)).filter(Boolean);
    return text(ad.type, 64)?.toUpperCase() === 'RESPONSIVE_SEARCH_AD'
      && JSON.stringify(finalUrls) === JSON.stringify([input.finalUrl])
      && JSON.stringify(headlines) === JSON.stringify(input.headlines)
      && JSON.stringify(descriptions) === JSON.stringify(input.descriptions);
  });
  const actualKeywords = criterionRows.map((row) => {
    const criterion = readField(row, 'adGroupCriterion', 'ad_group_criterion');
    const keyword = safeObject(criterion.keyword);
    return {
      text: text(keyword.text, 80),
      match_type: text(keyword.matchType ?? keyword.match_type, 32)?.toUpperCase(),
      status: text(criterion.status, 32)?.toUpperCase(),
    };
  }).sort((left, right) => String(left.text).localeCompare(String(right.text)));
  const expectedKeywords = input.keywords.map((value) => ({
    text: value,
    match_type: 'PHRASE',
    status: 'ENABLED',
  })).sort((left, right) => left.text.localeCompare(right.text));
  const exactKeywords = JSON.stringify(actualKeywords) === JSON.stringify(expectedKeywords);
  const actualCampaignCriteria = campaignCriterionRows.map((row) => {
    const criterion = readField(row, 'campaignCriterion', 'campaign_criterion');
    const type = text(criterion.type, 32)?.toUpperCase();
    const base = {
      type,
      status: text(criterion.status, 32)?.toUpperCase(),
      negative: criterion.negative === true,
    };
    if (type === 'LOCATION') {
      const location = safeObject(criterion.location);
      return {
        ...base,
        constant: text(location.geoTargetConstant ?? location.geo_target_constant, 128),
      };
    }
    if (type === 'LANGUAGE') {
      const language = safeObject(criterion.language);
      return {
        ...base,
        constant: text(language.languageConstant ?? language.language_constant, 128),
      };
    }
    const adSchedule = safeObject(criterion.adSchedule ?? criterion.ad_schedule);
    return {
      ...base,
      day_of_week: text(adSchedule.dayOfWeek ?? adSchedule.day_of_week, 32)?.toUpperCase(),
      start_hour: Number(adSchedule.startHour ?? adSchedule.start_hour),
      start_minute: text(adSchedule.startMinute ?? adSchedule.start_minute, 32)?.toUpperCase(),
      end_hour: Number(adSchedule.endHour ?? adSchedule.end_hour),
      end_minute: text(adSchedule.endMinute ?? adSchedule.end_minute, 32)?.toUpperCase(),
    };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const expectedCampaignCriteria = [
    ...input.geoTargetConstantIds.map((id) => ({
      type: 'LOCATION', status: 'ENABLED', negative: false, constant: `geoTargetConstants/${id}`,
    })),
    ...input.languageConstantIds.map((id) => ({
      type: 'LANGUAGE', status: 'ENABLED', negative: false, constant: `languageConstants/${id}`,
    })),
    ...input.adSchedules.map((item) => ({
      type: 'AD_SCHEDULE', status: 'ENABLED', negative: false, ...item,
    })),
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const exactCampaignCriteria = JSON.stringify(actualCampaignCriteria) === JSON.stringify(expectedCampaignCriteria);
  const criteriaBelongToOwnedAdGroup = adGroupResources.length === 1
    && criterionRows.every((row) => {
      const adGroup = readField(row, 'adGroup', 'ad_group');
      return text(adGroup.resourceName ?? adGroup.resource_name, 512) === adGroupResources[0];
    });
  return {
    found: true,
    complete: adGroupResources.length === 1
      && adResources.length === 1
      && criterionResources.length === input.keywords.length
      && pausedChildren
      && exactAdGroups
      && exactAds
      && exactKeywords
      && campaignCriterionResources.length === expectedCampaignCriteria.length
      && exactCampaignCriteria
      && criteriaBelongToOwnedAdGroup,
    provider_refs: {
      customer_id: input.customerId,
      campaign: campaignResource,
      campaign_budget: budgetResource,
      ad_groups: adGroupResources,
      ad_group_ads: adResources,
      ad_group_criteria: criterionResources,
      campaign_criteria: campaignCriterionResources,
    },
    ownership: {
      adapter_version: ADAPTER_VERSION,
      marker: input.marker,
      expected_campaign_name: input.campaignName,
      customer_id: input.customerId,
      campaign_status_at_ownership_check: campaignStatus,
      hierarchy_status_at_ownership_check: expectedStatus,
      channel_type_at_ownership_check: channel,
    },
  };
}

function providerRefsFromMutate(response, customerId) {
  const responses = list(response?.mutateOperationResponses ?? response?.mutate_operation_responses);
  const resourceNames = responses.map((item) => {
    const result = Object.values(safeObject(item))[0];
    return text(result?.resourceName ?? result?.resource_name, 512);
  }).filter(Boolean);
  const bySegment = (segment) => resourceNames.filter((value) => value.startsWith(`customers/${customerId}/${segment}/`));
  return {
    customer_id: customerId,
    campaign: bySegment('campaigns')[0] || null,
    campaign_budget: bySegment('campaignBudgets')[0] || null,
    ad_groups: bySegment('adGroups'),
    ad_group_ads: bySegment('adGroupAds'),
    ad_group_criteria: bySegment('adGroupCriteria'),
    campaign_criteria: bySegment('campaignCriteria'),
  };
}

function completeRefs(refs, expectedKeywordCount, expectedCampaignCriterionCount) {
  return Boolean(
    refs?.campaign
    && refs?.campaign_budget
    && refs?.ad_groups?.length === 1
    && refs?.ad_group_ads?.length === 1
    && refs?.ad_group_criteria?.length === expectedKeywordCount
    && refs?.campaign_criteria?.length === expectedCampaignCriterionCount
  );
}

async function runtimeFor(input, dependencies = {}) {
  const resolveRuntime = dependencies.resolveRuntime || resolveScopedGoogleAdsRuntime;
  const runtime = await resolveRuntime({
    clinicId: input.clinicId,
    groupId: input.groupId,
    assignmentScope: input.clinicId ? 'clinic' : 'group',
    customerId: input.customerId,
    requiredScopes: [GOOGLE_ADS_SCOPE],
  });
  if (cleanCustomerId(runtime?.customerId) !== input.customerId || !runtime?.accessToken) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_runtime_scope_mismatch',
      'El runtime Google no pertenece a la cuenta y scope aprobados.'
    );
  }
  return runtime;
}

async function execute({ execution, plan }, dependencies = {}) {
  const input = assertExecutableInput({ execution, plan });
  const runtime = await runtimeFor(input, dependencies);
  const request = dependencies.request || googleAdsRequest;
  const customerContract = await inspectCustomerContract({ request, runtime, input });
  const existing = await inspectOwnedCampaign({ request, runtime, input });
  if (existing.found) {
    if (!existing.complete) {
      throw new ManagedCampaignGoogleSearchExecutionError(
        'managed_google_partial_owned_campaign',
        'Existe una campaña marcada por esta ejecución, pero su estructura está incompleta.',
        { manualRecoveryRequired: true }
      );
    }
    return withCustomerContract({ recovered: true, provider_refs: existing.provider_refs, ownership: existing.ownership }, customerContract);
  }

  const manifest = buildCreateOperations(input);
  const requestData = {
    mutateOperations: manifest.operations,
    partialFailure: false,
    responseContentType: 'RESOURCE_NAME_ONLY',
  };
  await request('POST', `customers/${input.customerId}/googleAds:mutate`, {
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId || undefined,
    data: { ...requestData, validateOnly: true },
    singleAttempt: true,
    timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
  });
  await beforeProviderMutation(dependencies, {
    operation: 'create_google_search_paused',
    execution_id: execution.id,
    customer_id: input.customerId,
    plan_hash: plan.plan_hash,
  });

  try {
    const response = await request('POST', `customers/${input.customerId}/googleAds:mutate`, {
      accessToken: runtime.accessToken,
      loginCustomerId: runtime.loginCustomerId || undefined,
      data: { ...requestData, validateOnly: false },
      singleAttempt: true,
      timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
    });
    const responseRefs = providerRefsFromMutate(response, input.customerId);
    const readback = await inspectOwnedCampaign({ request, runtime, input });
    if (!completeRefs(
      responseRefs,
      input.keywords.length,
      input.geoTargetConstantIds.length + input.languageConstantIds.length + input.adSchedules.length,
    )
      || !readback.found
      || !readback.complete
      || readback.provider_refs.campaign !== responseRefs.campaign
      || readback.provider_refs.campaign_budget !== responseRefs.campaign_budget
      || JSON.stringify(readback.provider_refs.ad_groups) !== JSON.stringify(responseRefs.ad_groups)
      || JSON.stringify(readback.provider_refs.ad_group_ads) !== JSON.stringify(responseRefs.ad_group_ads)
      || JSON.stringify([...readback.provider_refs.ad_group_criteria].sort())
        !== JSON.stringify([...responseRefs.ad_group_criteria].sort())
      || JSON.stringify([...readback.provider_refs.campaign_criteria].sort())
        !== JSON.stringify([...responseRefs.campaign_criteria].sort())) {
      throw new ManagedCampaignGoogleSearchExecutionError(
        'managed_google_mutate_readback_incomplete',
        'Google aceptó la mutación, pero no se pudo demostrar la propiedad y configuración exactas de toda la estructura.',
        { manualRecoveryRequired: true }
      );
    }
    return withCustomerContract({
      recovered: false,
      provider_refs: readback.provider_refs,
      ownership: readback.ownership,
    }, customerContract);
  } catch (error) {
    if (error instanceof ManagedCampaignGoogleSearchExecutionError) throw error;
    // These two errors are raised by our quota guard before Axios sends the
    // mutate request. Retrying the same durable execution is therefore safe.
    if (['GOOGLE_ADS_PAUSED', 'GOOGLE_ADS_QUOTA_REACHED'].includes(error?.code)) {
      throw new ManagedCampaignGoogleSearchExecutionError(
        'managed_google_provider_temporarily_unavailable',
        'Google Ads ha aplazado temporalmente la operación.',
        { retryable: true, cause: error }
      );
    }
    try {
      const readback = await inspectOwnedCampaign({ request, runtime, input });
      if (readback.found && readback.complete) {
        return withCustomerContract({ recovered: true, provider_refs: readback.provider_refs, ownership: readback.ownership }, customerContract);
      }
      if (readback.found) {
        throw new ManagedCampaignGoogleSearchExecutionError(
          'managed_google_ambiguous_partial_mutation',
          'La llamada terminó de forma ambigua y existe una estructura parcial con la marca de la ejecución.',
          { manualRecoveryRequired: true, cause: error }
        );
      }
      const responseStatus = Number(error?.response?.status);
      const providerRejectedAtomically = Number.isInteger(responseStatus)
        && responseStatus >= 400
        && responseStatus < 500
        && responseStatus !== 408;
      if (!providerRejectedAtomically) {
        // A transport failure can lose the ACK after Google committed. An
        // immediate empty readback is not proof of absence because provider
        // reads can lag. Never retry or release funds automatically here.
        throw new ManagedCampaignGoogleSearchExecutionError(
          'managed_google_ambiguous_outcome',
          'No se pudo demostrar si Google aplicó la mutación atómica.',
          { manualRecoveryRequired: true, cause: error }
        );
      }
    } catch (reconcileError) {
      if (reconcileError instanceof ManagedCampaignGoogleSearchExecutionError) throw reconcileError;
      throw new ManagedCampaignGoogleSearchExecutionError(
        'managed_google_ambiguous_outcome',
        'No se pudo reconciliar el resultado de la mutación Google.',
        { manualRecoveryRequired: true, cause: error }
      );
    }
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_create_failed',
      'Google Ads rechazó la creación atómica de la campaña.',
      { retryable: false, cause: error }
    );
  }
}

function assertOwnedRefs(execution, input) {
  const refs = safeObject(execution?.provider_refs);
  const ownership = safeObject(execution?.ownership_snapshot);
  const customerContract = safeObject(ownership.customer_contract);
  if (ownership.adapter_version !== ADAPTER_VERSION
    || ownership.marker !== input.marker
    || ownership.expected_campaign_name !== input.campaignName
    || cleanCustomerId(ownership.customer_id) !== input.customerId
    || cleanCustomerId(customerContract.customer_id) !== input.customerId
    || text(customerContract.currency_code, 3)?.toUpperCase() !== input.currency
    || ianaTimeZone(customerContract.time_zone) !== input.scheduleTimeZone
    || cleanCustomerId(refs.customer_id) !== input.customerId
    || !completeRefs(
      refs,
      input.keywords.length,
      input.geoTargetConstantIds.length + input.languageConstantIds.length + input.adSchedules.length,
    )) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_rollback_ownership_missing',
      'El rollback no dispone de un snapshot de propiedad completo y coincidente.',
      { manualRecoveryRequired: true }
    );
  }
  return refs;
}

function assertActivationAuthorization(execution, plan) {
  const authorization = safeObject(execution?.activation_authorization_snapshot);
  const confirmations = safeObject(authorization.confirmations);
  const actorId = Number(execution?.activation_requested_by_user_id);
  const approvedBy = Number(authorization.approved_by_user_id);
  const valid = authorization.schema_version === 'managed-campaign-provider-activation-authorization/v1'
    && text(execution?.activation_idempotency_key, 191)
    && text(execution?.activation_change_reference, 191)
    && authorization.change_reference === execution.activation_change_reference
    && authorization.plan_hash === execution.plan_hash
    && plan?.plan_hash === execution.plan_hash
    && Number.isInteger(actorId) && actorId > 0
    && approvedBy === actorId
    && REQUIRED_ACTIVATION_CONFIRMATIONS.every((key) => confirmations[key] === true);
  if (!valid) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_activation_identity_invalid',
      'La activación no conserva la misma aprobación, referencia de cambio y huella del plan.',
      { manualRecoveryRequired: true }
    );
  }
  return authorization;
}

function buildRemoveOperations(refs) {
  return [
    ...list(refs.ad_group_ads).map((resource) => ({ adGroupAdOperation: { remove: resource } })),
    ...list(refs.ad_group_criteria).map((resource) => ({ adGroupCriterionOperation: { remove: resource } })),
    ...list(refs.ad_groups).map((resource) => ({ adGroupOperation: { remove: resource } })),
    ...list(refs.campaign_criteria).map((resource) => ({ campaignCriterionOperation: { remove: resource } })),
    { campaignOperation: { remove: refs.campaign } },
    { campaignBudgetOperation: { remove: refs.campaign_budget } },
  ];
}

function refsMatch(left, right) {
  return left?.campaign === right?.campaign
    && left?.campaign_budget === right?.campaign_budget
    && JSON.stringify([...list(left?.ad_groups)].sort()) === JSON.stringify([...list(right?.ad_groups)].sort())
    && JSON.stringify([...list(left?.ad_group_ads)].sort()) === JSON.stringify([...list(right?.ad_group_ads)].sort())
    && JSON.stringify([...list(left?.ad_group_criteria)].sort()) === JSON.stringify([...list(right?.ad_group_criteria)].sort())
    && JSON.stringify([...list(left?.campaign_criteria)].sort()) === JSON.stringify([...list(right?.campaign_criteria)].sort());
}

function buildActivationOperations(refs) {
  return [
    ...list(refs.ad_group_ads).map((resourceNameValue) => ({
      adGroupAdOperation: {
        update: { resourceName: resourceNameValue, status: 'ENABLED' },
        updateMask: 'status',
      },
    })),
    ...list(refs.ad_groups).map((resourceNameValue) => ({
      adGroupOperation: {
        update: { resourceName: resourceNameValue, status: 'ENABLED' },
        updateMask: 'status',
      },
    })),
    {
      campaignOperation: {
        update: { resourceName: refs.campaign, status: 'ENABLED' },
        updateMask: 'status',
      },
    },
  ];
}

async function inspectActivationState({ execution, plan }, dependencies = {}) {
  const input = assertExecutableInput({ execution, plan });
  assertActivationAuthorization(execution, plan);
  const refs = assertOwnedRefs(execution, input);
  const runtime = await runtimeFor(input, dependencies);
  const request = dependencies.request || googleAdsRequest;
  const customerContract = await inspectCustomerContract({ request, runtime, input });
  let paused;
  try {
    paused = await inspectOwnedCampaign({ request, runtime, input, expectedHierarchyStatus: 'PAUSED' });
  } catch (error) {
    if (error?.code !== 'managed_google_ownership_guard_failed') throw error;
    let enabled;
    try {
      enabled = await inspectOwnedCampaign({ request, runtime, input, expectedHierarchyStatus: 'ENABLED' });
    } catch (enabledError) {
      if (enabledError?.code !== 'managed_google_ownership_guard_failed') throw enabledError;
    }
    if (enabled?.found && enabled.complete && refsMatch(enabled.provider_refs, refs)) {
      return {
        state: 'ENABLED',
        outcome: withCustomerContract({
          recovered: true,
          recovered_after_restart: true,
          provider_mutation_performed: false,
          provider_refs: enabled.provider_refs,
          ownership: enabled.ownership,
          previous_status: 'PAUSED',
          current_status: 'ENABLED',
        }, customerContract),
      };
    }
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_activation_state_ambiguous',
      'La estructura ya no conserva un árbol PAUSED o ENABLED exacto para esta activación.',
      { manualRecoveryRequired: true, cause: error }
    );
  }
  if (!paused.found || !paused.complete || !refsMatch(paused.provider_refs, refs)) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_activation_precondition_changed',
      'La estructura PAUSED ya no coincide exactamente con los recursos creados por esta ejecución.',
      { manualRecoveryRequired: true }
    );
  }
  return { state: 'PAUSED', input, refs, runtime, request, customerContract };
}

async function recoverActivation(input, dependencies = {}) {
  const inspected = await inspectActivationState(input, dependencies);
  return inspected.state === 'ENABLED'
    ? inspected.outcome
    : {
        recovered: false,
        provider_mutation_performed: false,
        provider_refs: inspected.refs,
        current_status: 'PAUSED',
      };
}

async function activate({ execution, plan }, dependencies = {}) {
  const inspected = await inspectActivationState({ execution, plan }, dependencies);
  if (inspected.state === 'ENABLED') return inspected.outcome;
  const { input, refs, runtime, request, customerContract } = inspected;
  const requestData = {
    mutateOperations: buildActivationOperations(refs),
    partialFailure: false,
    responseContentType: 'RESOURCE_NAME_ONLY',
  };
  await request('POST', `customers/${input.customerId}/googleAds:mutate`, {
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId || undefined,
    data: { ...requestData, validateOnly: true },
    singleAttempt: true,
    timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
  });
  await beforeProviderMutation(dependencies, {
    operation: 'activate_google_search',
    execution_id: execution.id,
    customer_id: input.customerId,
    campaign: refs.campaign,
    plan_hash: plan.plan_hash,
    activation_change_reference: execution.activation_change_reference,
  });
  try {
    await request('POST', `customers/${input.customerId}/googleAds:mutate`, {
      accessToken: runtime.accessToken,
      loginCustomerId: runtime.loginCustomerId || undefined,
      data: { ...requestData, validateOnly: false },
      singleAttempt: true,
      timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
    });
    const enabled = await inspectOwnedCampaign({ request, runtime, input, expectedHierarchyStatus: 'ENABLED' });
    if (!enabled.found || !enabled.complete || !refsMatch(enabled.provider_refs, refs)) {
      throw new ManagedCampaignGoogleSearchExecutionError(
        'managed_google_activation_readback_incomplete',
        'Google aceptó la activación, pero el readback no demuestra el árbol ENABLED exacto.',
        { manualRecoveryRequired: true }
      );
    }
    return withCustomerContract({
      recovered: false,
      provider_refs: enabled.provider_refs,
      ownership: enabled.ownership,
      previous_status: 'PAUSED',
      current_status: 'ENABLED',
    }, customerContract);
  } catch (error) {
    if (error instanceof ManagedCampaignGoogleSearchExecutionError) throw error;
    if (['GOOGLE_ADS_PAUSED', 'GOOGLE_ADS_QUOTA_REACHED'].includes(error?.code)) {
      throw new ManagedCampaignGoogleSearchExecutionError(
        'managed_google_provider_temporarily_unavailable',
        'Google Ads ha aplazado temporalmente la activación antes de mutar.',
        { retryable: true, cause: error }
      );
    }
    try {
      const enabled = await inspectOwnedCampaign({ request, runtime, input, expectedHierarchyStatus: 'ENABLED' });
      if (enabled.found && enabled.complete && refsMatch(enabled.provider_refs, refs)) {
        return withCustomerContract({
          recovered: true,
          provider_refs: enabled.provider_refs,
          ownership: enabled.ownership,
          previous_status: 'PAUSED',
          current_status: 'ENABLED',
        }, customerContract);
      }
    } catch (readbackError) {
      if (readbackError instanceof ManagedCampaignGoogleSearchExecutionError
        && readbackError.code !== 'managed_google_ownership_guard_failed') throw readbackError;
    }
    const responseStatus = Number(error?.response?.status);
    if (Number.isInteger(responseStatus) && responseStatus >= 400 && responseStatus < 500 && responseStatus !== 408) {
      throw new ManagedCampaignGoogleSearchExecutionError(
        'managed_google_activation_rejected',
        'Google Ads rechazó atómicamente la activación.',
        { retryable: false, cause: error }
      );
    }
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_activation_ambiguous',
      'No se pudo demostrar si Google activó la estructura.',
      { manualRecoveryRequired: true, cause: error }
    );
  }
}

async function rollback({ execution, plan }, dependencies = {}) {
  const input = assertExecutableInput({ execution, plan });
  const refs = assertOwnedRefs(execution, input);
  const runtime = await runtimeFor(input, dependencies);
  const request = dependencies.request || googleAdsRequest;
  await inspectCustomerContract({ request, runtime, input });
  const expectedHierarchyStatus = execution?.activated_at ? 'ENABLED' : 'PAUSED';
  const readback = await inspectOwnedCampaign({ request, runtime, input, expectedHierarchyStatus });
  if (!readback.found) return { already_absent: true, removed_refs: refs };
  if (!readback.complete || !refsMatch(readback.provider_refs, refs)) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_rollback_ownership_changed',
      'La estructura Google ya no coincide exactamente con los recursos creados por esta ejecución.',
      { manualRecoveryRequired: true }
    );
  }
  const data = {
    mutateOperations: buildRemoveOperations(refs),
    partialFailure: false,
    responseContentType: 'RESOURCE_NAME_ONLY',
  };
  await request('POST', `customers/${input.customerId}/googleAds:mutate`, {
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId || undefined,
    data: { ...data, validateOnly: true },
    singleAttempt: true,
    timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
  });
  await beforeProviderMutation(dependencies, {
    operation: 'rollback_owned_google_search',
    execution_id: execution.id,
    customer_id: input.customerId,
    campaign: refs.campaign,
    plan_hash: plan.plan_hash,
  });
  await request('POST', `customers/${input.customerId}/googleAds:mutate`, {
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId || undefined,
    data: { ...data, validateOnly: false },
    singleAttempt: true,
    timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
  });
  const removed = await inspectOwnedCampaign({ request, runtime, input, expectedHierarchyStatus });
  if (removed.found) {
    throw new ManagedCampaignGoogleSearchExecutionError(
      'managed_google_rollback_readback_incomplete',
      'Google aceptó el rollback, pero la campaña propia todavía aparece en el readback.',
      { manualRecoveryRequired: true }
    );
  }
  return { already_absent: false, removed_refs: refs, removal_verified: true };
}

module.exports = {
  ADAPTER_VERSION,
  ManagedCampaignGoogleSearchExecutionError,
  activate,
  buildActivationOperations,
  buildCreateOperations,
  buildRemoveOperations,
  execute,
  executionMarker,
  inspectOwnedCampaign,
  inspectCustomerContract,
  recoverActivation,
  rollback,
  _assertActivationAuthorization: assertActivationAuthorization,
  _assertExecutableInput: assertExecutableInput,
  _providerRefsFromMutate: providerRefsFromMutate,
};

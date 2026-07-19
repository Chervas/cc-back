'use strict';

const crypto = require('node:crypto');
const { publicHttpUrl } = require('../lib/safeHttpTarget');
const {
  buildManagedCampaignDryRunAdapter,
} = require('./managedCampaignProviderAdapterRegistry.service');
const {
  executionCapability,
  hasManagedCampaignExecutionAdapter,
} = require('./managedCampaignProviderExecutionRegistry.service');

const PLAN_SCHEMA_VERSION = 'managed-campaign-publishing-plan/v1';
const AUTHORIZATION_SCHEMA_VERSION = 'managed-campaign-publishing-authorization/v1';
const SUPPORTED_FAMILIES = Object.freeze({
  google_ads: Object.freeze(['google_search', 'google_pmax']),
  meta_ads: Object.freeze(['meta_reach', 'meta_instant_form']),
});
const META_CTA_TYPES = Object.freeze({
  meta_reach: Object.freeze([
    'BOOK_NOW', 'CONTACT_US', 'GET_QUOTE', 'LEARN_MORE', 'SIGN_UP',
  ]),
  meta_instant_form: Object.freeze([
    'APPLY_NOW', 'BOOK_NOW', 'DOWNLOAD', 'GET_OFFER', 'GET_QUOTE',
    'LEARN_MORE', 'SIGN_UP', 'SUBSCRIBE',
  ]),
});
const REQUIRED_GATE_EVIDENCE = Object.freeze([
  'prepayment_verified',
  'budget_approved',
  'policy_reviewed',
  'tracking_verified',
  'creative_rights_confirmed',
]);
const REQUIRED_EXECUTION_CONFIRMATIONS = Object.freeze([
  'confirm_external_mutation',
  'confirm_budget_commitment',
  'confirm_policy_compliance',
  'confirm_tracking_configuration',
  'confirm_creative_rights',
]);
const GOOGLE_AD_SCHEDULE_DAYS = Object.freeze([
  'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY',
]);
const GOOGLE_AD_SCHEDULE_MINUTES = Object.freeze({
  0: 'ZERO',
  15: 'FIFTEEN',
  30: 'THIRTY',
  45: 'FORTY_FIVE',
});
const GOOGLE_POSITIVE_GEO_TARGET_TYPES = new Set(['PRESENCE', 'PRESENCE_OR_INTEREST']);
const GOOGLE_NEGATIVE_GEO_TARGET_TYPES = new Set(['PRESENCE']);
function plainCampaign(campaign) {
  if (!campaign || typeof campaign !== 'object') return null;
  return typeof campaign.get === 'function' ? campaign.get({ plain: true }) : campaign;
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, max = 2048) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  const clean = String(value).trim();
  return clean ? clean.slice(0, max) : null;
}

function currencyCode(value) {
  const clean = text(value, 16);
  return clean && /^[a-z]{3}$/i.test(clean) ? clean.toUpperCase() : null;
}

function httpUrl(value) {
  const candidate = text(value, 2048);
  return candidate && !sensitiveUrl(candidate) ? publicHttpUrl(candidate) : null;
}

function positiveNumber(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.round((parsed + Number.EPSILON) * 100) / 100
    : null;
}

function nonNegativeNumber(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.round((parsed + Number.EPSILON) * 100) / 100
    : null;
}

function moneyCents(value) {
  const parsed = nonNegativeNumber(value);
  return parsed === null ? null : Math.round(parsed * 100);
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedKey(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase();
}

function isSecretKey(key) {
  const normalized = normalizedKey(key);
  return /(^|_)(access_token|refresh_token|client_secret|api_key|private_key|password|passwd|authorization|cookie|session|hmac_key|credentials?|secret|token|appsecret_proof|signed_request|signature)($|_)/.test(normalized);
}

function isSensitiveQueryKey(key) {
  const normalized = normalizedKey(key);
  return isSecretKey(normalized)
    || /^(sig|key|auth|code|proof|aws_access_key_id)$/i.test(normalized);
}

function decodedSensitiveText(value) {
  let current = String(value || '').replace(/\+/g, ' ');
  for (let pass = 0; pass < 4; pass += 1) {
    if (/(?:^|[?&#\s])(access_token|refresh_token|client_secret|api_key|private_key|password|authorization|cookie|session|credential|secret|token|appsecret_proof|signed_request|signature|awsaccesskeyid|aws_access_key_id)=/i.test(current)) return true;
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch (_error) {
      return false;
    }
    if (decoded === current) break;
    current = decoded.replace(/\+/g, ' ');
  }
  return false;
}

function sensitiveUrl(value) {
  if (typeof value !== 'string') return false;
  const clean = value.trim();
  if (/(?:^|[?&#\s])(access_token|refresh_token|client_secret|api_key|private_key|password|authorization|cookie|session|credential|secret|token|appsecret_proof|signed_request|signature|awsaccesskeyid|aws_access_key_id)=/i.test(clean)) return true;
  if (!/^(?:https?:)?\/\//i.test(clean)) return false;
  if (decodedSensitiveText(clean)) return true;
  if (!/^https?:\/\//i.test(clean)) return false;
  let parsed;
  try {
    parsed = new URL(clean);
  } catch (_error) {
    return false;
  }
  if (Array.from(parsed.searchParams.keys()).some(isSensitiveQueryKey)) return true;
  if (Array.from(parsed.searchParams.values()).some(decodedSensitiveText)) return true;
  return decodedSensitiveText(parsed.hash.slice(1));
}

function containsSensitiveUrl(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return false;
  if (typeof value === 'string') return sensitiveUrl(value);
  if (Array.isArray(value)) return value.some((item) => containsSensitiveUrl(item, depth + 1));
  if (typeof value !== 'object') return false;
  return Object.values(value).some((item) => containsSensitiveUrl(item, depth + 1));
}

function sanitizeForPlan(value, depth = 0) {
  if (depth > 12 || value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sensitiveUrl(value) ? null : value.slice(0, 10000);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitizeForPlan(item, depth + 1));
  if (typeof value !== 'object') return null;

  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (isSecretKey(key)) continue;
    output[key] = sanitizeForPlan(value[key], depth + 1);
  }
  return output;
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalStringify(value[key])}`
  )).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function valuesAt(object, paths) {
  for (const path of paths) {
    let value = object;
    for (const segment of path.split('.')) {
      value = value && typeof value === 'object' ? value[segment] : undefined;
    }
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function stringArray(value, max = 2048) {
  const source = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return source.map((item) => text(item, max)).filter(Boolean);
}

function assetArray(config, paths, max = 2048) {
  return stringArray(valuesAt(config, paths), max);
}

function stringArrayAlias(object, keys, max = 10000) {
  const candidates = keys
    .map((key) => object?.[key])
    .filter((value) => value !== undefined && value !== null && value !== '');
  const values = candidates.map((value) => stringArray(value, max));
  return {
    value: values[0] || [],
    conflict: candidates.length > 1
      && new Set(values.map((items) => JSON.stringify(items))).size > 1,
  };
}

function safePlatformReferences(provider, rawRefs) {
  const refs = sanitizeForPlan(safeObject(rawRefs));
  const allowedPaths = provider === 'google_ads'
    ? [
        'customer_id', 'account_id', 'campaign_id', 'conversion_action_id',
        'google_ads.customer_id', 'google_ads.account_id', 'google_ads.campaign_id',
      ]
    : [
        'ad_account_id', 'account_id', 'campaign_id', 'page_id', 'instagram_actor_id', 'pixel_id', 'instant_form_id',
        'meta_ads.ad_account_id', 'meta_ads.account_id', 'meta_ads.campaign_id', 'meta_ads.page_id',
        'meta_ads.instagram_actor_id', 'meta_ads.pixel_id', 'meta_ads.instant_form_id',
      ];
  const output = {};
  for (const path of allowedPaths) {
    const value = text(valuesAt(refs, [path]), 256);
    if (value) output[path.replace('.', '_')] = value;
  }
  return output;
}

function providerAccountId(provider, refs) {
  return provider === 'google_ads'
    ? text(valuesAt(refs, ['google_ads_customer_id', 'customer_id', 'google_ads_account_id', 'account_id']), 128)
    : text(valuesAt(refs, ['meta_ads_ad_account_id', 'ad_account_id', 'meta_ads_account_id', 'account_id']), 128);
}

function normalizedProviderAccountId(value) {
  return String(value || '').replace(/[^0-9]/g, '').slice(0, 64) || null;
}

function managedCampaignPublishingAccountScopeInput(campaign) {
  const row = plainCampaign(campaign);
  if (!row) {
    return {
      groupId: null,
      clinicId: null,
      provider: null,
      accountId: null,
    };
  }
  const provider = text(row.provider, 32);
  const refs = safePlatformReferences(provider, row.platform_refs);
  return {
    groupId: positiveInteger(row.grupo_clinica_id),
    clinicId: positiveInteger(row.clinica_id),
    provider,
    accountId: providerAccountId(provider, refs),
  };
}

function publishingAccountScopeIsAuthorized(campaign, specification, authorization) {
  const row = plainCampaign(campaign);
  const resolvedScope = safeObject(authorization?.scope);
  const resolvedAccount = safeObject(authorization?.account);
  const expectedProvider = text(row?.provider, 32);
  const expectedAccountId = normalizedProviderAccountId(specification?.account_id);
  const expectedGroupId = positiveInteger(row?.grupo_clinica_id);
  const expectedClinicId = positiveInteger(row?.clinica_id);
  const resolvedGroupId = positiveInteger(resolvedScope.group_id);
  const resolvedClinicId = positiveInteger(resolvedScope.clinic_id);

  return Boolean(
    expectedProvider
    && expectedAccountId
    && resolvedAccount.provider === expectedProvider
    && normalizedProviderAccountId(resolvedAccount.account_id) === expectedAccountId
    && resolvedAccount.authorization_status === 'active'
    && resolvedAccount.selectable === true
    && (!expectedGroupId || resolvedGroupId === expectedGroupId)
    && (!expectedClinicId || resolvedClinicId === expectedClinicId)
  );
}

function scalarAlias(object, keys, normalize = (value) => value) {
  const candidates = keys
    .map((key) => object?.[key])
    .filter((value) => value !== undefined && value !== null && value !== '');
  const values = candidates.map((value) => text(value, 256));
  const comparable = values.map((value) => (value ? normalize(value) : null));
  return {
    value: values[0] || null,
    normalized: comparable[0] || null,
    conflict: candidates.length > 1
      && (comparable.some((value) => !value) || new Set(comparable).size > 1),
  };
}

function valueAt(object, path) {
  let value = object;
  for (const segment of String(path || '').split('.')) {
    if (!value || typeof value !== 'object') return undefined;
    value = value[segment];
  }
  return value;
}

function explicitConstantIds(config, paths, resourcePrefix) {
  const candidates = paths
    .map((path) => valueAt(config, path))
    .filter((value) => value !== undefined && value !== null && value !== '');
  const normalize = (value) => {
    const source = Array.isArray(value) ? value : [value];
    const normalized = source.map((item) => {
      const clean = text(item, 128);
      if (!clean) return null;
      const match = clean.match(new RegExp(`^(?:${resourcePrefix}/)?(\\d+)$`, 'i'));
      return match?.[1] || null;
    });
    return {
      valid: normalized.every(Boolean),
      values: Array.from(new Set(normalized.filter(Boolean))).sort((left, right) => (
        left.length - right.length || left.localeCompare(right)
      )),
    };
  };
  const normalized = candidates.map(normalize);
  return {
    values: normalized[0]?.values || [],
    invalid: normalized.some((item) => !item.valid),
    conflict: normalized.length > 1
      && new Set(normalized.map((item) => JSON.stringify(item.values))).size > 1,
  };
}

function googleMinute(value) {
  const clean = text(value, 32)?.toUpperCase();
  if (clean && Object.values(GOOGLE_AD_SCHEDULE_MINUTES).includes(clean)) return clean;
  const number = Number(value);
  return Number.isInteger(number) ? GOOGLE_AD_SCHEDULE_MINUTES[number] || null : null;
}

function googleMinuteNumber(value) {
  const entry = Object.entries(GOOGLE_AD_SCHEDULE_MINUTES).find(([, name]) => name === value);
  return entry ? Number(entry[0]) : null;
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

function canonicalGoogleSchedules(scheduleConfig, blockers) {
  const candidates = [
    valueAt(scheduleConfig, 'google_ads.ad_schedules'),
    valueAt(scheduleConfig, 'ad_schedules'),
  ].filter((value) => value !== undefined && value !== null && value !== '');
  if (candidates.length > 1 && canonicalStringify(candidates[0]) !== canonicalStringify(candidates[1])) {
    blockers.push(blocker(
      'search_schedule_alias_conflict',
      'schedule_config.google_ads.ad_schedules',
      'Hay horarios Google distintos en dos campos. Conserva una única configuración explícita.',
    ));
  }
  const source = candidates[0];
  if (!Array.isArray(source) || !source.length) {
    blockers.push(blocker(
      'search_ad_schedule_required',
      'schedule_config.google_ads.ad_schedules',
      'Google Search requiere al menos un horario semanal explícito.',
    ));
    return [];
  }
  const normalized = [];
  for (const item of source) {
    const row = safeObject(item);
    const day = text(row.day_of_week ?? row.day, 32)?.toUpperCase();
    const startHour = Number(row.start_hour);
    const endHour = Number(row.end_hour);
    const startMinute = googleMinute(row.start_minute);
    const endMinute = googleMinute(row.end_minute);
    const startTotal = startHour * 60 + googleMinuteNumber(startMinute);
    const endTotal = endHour * 60 + googleMinuteNumber(endMinute);
    if (!GOOGLE_AD_SCHEDULE_DAYS.includes(day)
      || !Number.isInteger(startHour) || startHour < 0 || startHour > 23
      || !Number.isInteger(endHour) || endHour < 0 || endHour > 24
      || !startMinute || !endMinute
      || (endHour === 24 && endMinute !== 'ZERO')
      || !Number.isFinite(startTotal) || !Number.isFinite(endTotal)
      || startTotal >= endTotal) {
      blockers.push(blocker(
        'search_ad_schedule_invalid',
        'schedule_config.google_ads.ad_schedules',
        'Cada horario debe usar un día oficial, horas válidas y minutos 00, 15, 30 o 45, con inicio anterior al fin.',
      ));
      continue;
    }
    normalized.push({
      day_of_week: day,
      start_hour: startHour,
      start_minute: startMinute,
      end_hour: endHour,
      end_minute: endMinute,
    });
  }
  const dayOrder = new Map(GOOGLE_AD_SCHEDULE_DAYS.map((day, index) => [day, index]));
  const unique = Array.from(new Map(normalized.map((item) => [canonicalStringify(item), item])).values())
    .sort((left, right) => (
      dayOrder.get(left.day_of_week) - dayOrder.get(right.day_of_week)
      || left.start_hour - right.start_hour
      || googleMinuteNumber(left.start_minute) - googleMinuteNumber(right.start_minute)
      || left.end_hour - right.end_hour
      || googleMinuteNumber(left.end_minute) - googleMinuteNumber(right.end_minute)
    ));
  for (const day of GOOGLE_AD_SCHEDULE_DAYS) {
    const items = unique.filter((item) => item.day_of_week === day);
    if (items.length > 6) {
      blockers.push(blocker(
        'search_ad_schedule_daily_limit',
        'schedule_config.google_ads.ad_schedules',
        'Google Ads admite como máximo seis franjas por día.',
      ));
    }
    for (let index = 1; index < items.length; index += 1) {
      const previousEnd = items[index - 1].end_hour * 60 + googleMinuteNumber(items[index - 1].end_minute);
      const currentStart = items[index].start_hour * 60 + googleMinuteNumber(items[index].start_minute);
      if (currentStart < previousEnd) {
        blockers.push(blocker(
          'search_ad_schedule_overlap',
          'schedule_config.google_ads.ad_schedules',
          'Las franjas de un mismo día no pueden solaparse.',
        ));
        break;
      }
    }
  }
  return unique;
}

function canonicalGoogleSearchTargeting(targetConfig, scheduleConfig, blockers) {
  const locations = explicitConstantIds(targetConfig, [
    'google_ads.geo_target_constant_ids',
    'geo_target_constant_ids',
    'google_geo_target_constant_ids',
  ], 'geoTargetConstants');
  const languages = explicitConstantIds(targetConfig, [
    'google_ads.language_constant_ids',
    'language_constant_ids',
    'google_language_constant_ids',
  ], 'languageConstants');
  if (locations.conflict) blockers.push(blocker('search_geo_alias_conflict', 'target_config.google_ads.geo_target_constant_ids', 'Hay ubicaciones Google distintas en dos campos.'));
  if (locations.invalid) blockers.push(blocker('search_geo_target_invalid', 'target_config.google_ads.geo_target_constant_ids', 'Las ubicaciones deben usar IDs numéricos de GeoTargetConstant.'));
  if (!locations.values.length) blockers.push(blocker('search_geo_target_required', 'target_config.google_ads.geo_target_constant_ids', 'Google Search requiere al menos una ubicación explícita.'));
  if (languages.conflict) blockers.push(blocker('search_language_alias_conflict', 'target_config.google_ads.language_constant_ids', 'Hay idiomas Google distintos en dos campos.'));
  if (languages.invalid) blockers.push(blocker('search_language_target_invalid', 'target_config.google_ads.language_constant_ids', 'Los idiomas deben usar IDs numéricos de LanguageConstant.'));
  if (!languages.values.length) blockers.push(blocker('search_language_target_required', 'target_config.google_ads.language_constant_ids', 'Google Search requiere al menos un idioma explícito.'));

  const positiveGeoType = text(
    valueAt(targetConfig, 'google_ads.positive_geo_target_type')
      ?? valueAt(targetConfig, 'positive_geo_target_type'),
    64,
  )?.toUpperCase();
  const negativeGeoType = text(
    valueAt(targetConfig, 'google_ads.negative_geo_target_type')
      ?? valueAt(targetConfig, 'negative_geo_target_type'),
    64,
  )?.toUpperCase();
  if (!GOOGLE_POSITIVE_GEO_TARGET_TYPES.has(positiveGeoType)) {
    blockers.push(blocker('search_positive_geo_type_required', 'target_config.google_ads.positive_geo_target_type', 'Define PRESENCE o PRESENCE_OR_INTEREST para la ubicación positiva.'));
  }
  if (!GOOGLE_NEGATIVE_GEO_TARGET_TYPES.has(negativeGeoType)) {
    blockers.push(blocker('search_negative_geo_type_required', 'target_config.google_ads.negative_geo_target_type', 'Define PRESENCE para la exclusión geográfica.'));
  }
  const timeZoneCandidates = [
    valueAt(scheduleConfig, 'google_ads.time_zone'),
    valueAt(scheduleConfig, 'time_zone'),
  ].filter((value) => value !== undefined && value !== null && value !== '');
  const normalizedTimeZones = timeZoneCandidates.map(ianaTimeZone);
  if (timeZoneCandidates.length > 1
    && (normalizedTimeZones.some((value) => !value) || new Set(normalizedTimeZones).size > 1)) {
    blockers.push(blocker(
      'search_time_zone_alias_conflict',
      'schedule_config.google_ads.time_zone',
      'Hay zonas horarias Google distintas en dos campos. Conserva una única configuración explícita.',
    ));
  }
  const timeZone = normalizedTimeZones[0] || null;
  if (!timeZone) {
    blockers.push(blocker(
      'search_time_zone_required',
      'schedule_config.google_ads.time_zone',
      'Google Search requiere una zona horaria IANA explícita que coincida con la cuenta publicitaria.',
    ));
  }
  return {
    targeting: {
      geo_target_constant_ids: locations.values,
      language_constant_ids: languages.values,
      positive_geo_target_type: positiveGeoType || null,
      negative_geo_target_type: negativeGeoType || null,
    },
    schedule: {
      time_zone: timeZone,
      ad_schedules: canonicalGoogleSchedules(scheduleConfig, blockers),
    },
  };
}

function blocker(code, field, message) {
  return { code, field, message };
}

function warning(code, field, message) {
  return { code, field, message };
}

function requireCount(blockers, values, minimum, code, field, message) {
  if (!Array.isArray(values) || values.length < minimum) blockers.push(blocker(code, field, message));
}

function commonSpecification(campaign, provider, family, refs) {
  const budget = safeObject(campaign.budget_config);
  const funding = safeObject(campaign.funding);
  const approvedGross = positiveNumber(budget.amount);
  const fundedGross = positiveNumber(funding.client_gross_funded);
  const commissionAmount = nonNegativeNumber(funding.commission_amount);
  const mediaBudgetNet = positiveNumber(funding.media_budget_net);
  const mediaBudgetAvailable = positiveNumber(funding.available_amount);
  const approvedMediaBudgetCap = approvedGross && fundedGross && mediaBudgetNet
    ? Math.round(((approvedGross * mediaBudgetNet / fundedGross) + Number.EPSILON) * 100) / 100
    : null;
  const fundingCurrency = currencyCode(funding.currency);
  const clientCurrency = currencyCode(budget.currency);
  return {
    provider,
    family,
    operation: text(refs.campaign_id || refs.google_ads_campaign_id || refs.meta_ads_campaign_id)
      ? 'update_existing'
      : 'create_new',
    existing_campaign_id: text(refs.campaign_id || refs.google_ads_campaign_id || refs.meta_ads_campaign_id, 256),
    account_id: providerAccountId(provider, refs),
    name: text(campaign.name, 255),
    objective_id: text(campaign.objective_id, 64),
    budget: {
      approved_client_gross_amount: approvedGross,
      funded_client_gross_amount: fundedGross,
      commission_amount: commissionAmount,
      media_budget_total: mediaBudgetNet,
      media_budget_available: mediaBudgetAvailable,
      approved_media_budget_cap: approvedMediaBudgetCap,
      provider_media_budget_amount: mediaBudgetNet && mediaBudgetAvailable && approvedMediaBudgetCap
        ? Math.min(mediaBudgetNet, mediaBudgetAvailable, approvedMediaBudgetCap)
        : null,
      currency: fundingCurrency || clientCurrency,
      client_currency: clientCurrency,
      funding_currency: fundingCurrency,
      period: text(budget.period, 32),
    },
    targeting: sanitizeForPlan(safeObject(campaign.target_config)),
    audience: sanitizeForPlan(safeObject(campaign.audience_config)),
    schedule: sanitizeForPlan(safeObject(campaign.schedule_config)),
    destination: sanitizeForPlan(safeObject(campaign.destination_config)),
  };
}

function addMediaBudgetBlockers(budget, blockers) {
  if (!budget.approved_client_gross_amount) {
    blockers.push(blocker('positive_budget_required', 'budget_config.amount', 'El presupuesto bruto del cliente debe ser mayor que cero.'));
  }
  if (!budget.funded_client_gross_amount) {
    blockers.push(blocker('funded_gross_required', 'funding.client_gross_funded', 'Falta el importe bruto realmente cobrado por adelantado.'));
  }
  if (budget.commission_amount === null) {
    blockers.push(blocker('commission_snapshot_required', 'funding.commission_amount', 'Falta el snapshot de comisión del prepago.'));
  }
  if (!budget.media_budget_total) {
    blockers.push(blocker('media_budget_net_required', 'funding.media_budget_net', 'Falta el presupuesto neto reservado para publicidad.'));
  }
  if (!budget.media_budget_available) {
    blockers.push(blocker('media_budget_available_required', 'funding.available_amount', 'No queda saldo neto disponible para publicidad.'));
  }
  if (budget.funded_client_gross_amount && budget.approved_client_gross_amount
    && budget.funded_client_gross_amount < budget.approved_client_gross_amount) {
    blockers.push(blocker('funding_below_approved_budget', 'funding.client_gross_funded', 'El prepago todavía no cubre el presupuesto bruto aprobado.'));
  }
  const fundedCents = moneyCents(budget.funded_client_gross_amount);
  const commissionCents = moneyCents(budget.commission_amount);
  const mediaBudgetCents = moneyCents(budget.media_budget_total);
  if (fundedCents !== null && commissionCents !== null && mediaBudgetCents !== null
    && fundedCents - commissionCents !== mediaBudgetCents) {
    blockers.push(blocker('funding_breakdown_inconsistent', 'funding', 'El bruto cobrado menos la comisión no coincide con el neto de medios.'));
  }
  if (budget.media_budget_available && budget.media_budget_total
    && budget.media_budget_available > budget.media_budget_total) {
    blockers.push(blocker('available_media_exceeds_net', 'funding.available_amount', 'El saldo disponible no puede superar el neto total de medios.'));
  }
  if (!budget.approved_media_budget_cap) {
    blockers.push(blocker('approved_media_budget_cap_required', 'funding', 'No se pudo calcular la asignación neta correspondiente al presupuesto aprobado.'));
  }
  if (budget.client_currency && budget.funding_currency && budget.client_currency !== budget.funding_currency) {
    blockers.push(blocker('funding_currency_mismatch', 'funding.currency', 'La moneda del prepago no coincide con la moneda aprobada para la campaña.'));
  }
}

function buildGoogleSearchSpec(campaign, refs, blockers) {
  const common = commonSpecification(campaign, 'google_ads', 'google_search', refs);
  const creative = safeObject(campaign.creative_config);
  const target = safeObject(campaign.target_config);
  const headlines = assetArray(creative, ['headlines', 'responsive_search_ad.headlines']);
  const descriptions = assetArray(creative, ['descriptions', 'responsive_search_ad.descriptions']);
  const keywords = assetArray(target, ['keywords', 'search_keywords']);
  const explicitTargeting = canonicalGoogleSearchTargeting(
    target,
    safeObject(campaign.schedule_config),
    blockers,
  );
  const rawFinalUrl = valuesAt(common.destination, ['final_url', 'effective_url', 'landing_url', 'url']);
  const finalUrl = httpUrl(rawFinalUrl);

  if (!common.account_id) blockers.push(blocker('provider_account_required', 'platform_refs.customer_id', 'Falta una cuenta Google Ads asignada.'));
  else if (!/^\d{10}$/.test(common.account_id.replace(/-/g, ''))) blockers.push(blocker('provider_account_invalid', 'platform_refs.customer_id', 'La cuenta Google Ads debe ser un customer ID de 10 dígitos.'));
  if (!common.name) blockers.push(blocker('campaign_name_required', 'name', 'Falta el nombre de campaña.'));
  addMediaBudgetBlockers(common.budget, blockers);
  if (!finalUrl) blockers.push(blocker(rawFinalUrl ? 'final_url_invalid' : 'final_url_required', 'destination_config.final_url', 'Google Search requiere una URL final http(s) válida.'));
  requireCount(blockers, headlines, 3, 'search_headlines_required', 'creative_config.headlines', 'Google Search requiere al menos tres titulares proporcionados.');
  requireCount(blockers, descriptions, 2, 'search_descriptions_required', 'creative_config.descriptions', 'Google Search requiere al menos dos descripciones proporcionadas.');
  requireCount(blockers, keywords, 1, 'search_keywords_required', 'target_config.keywords', 'Google Search requiere keywords revisadas.');

  return {
    ...common,
    targeting: explicitTargeting.targeting,
    schedule: explicitTargeting.schedule,
    provider_campaign_type: 'SEARCH',
    final_url: finalUrl,
    ad_group: { keywords },
    creative: { headlines, descriptions },
  };
}

function buildGooglePmaxSpec(campaign, refs, blockers) {
  const common = commonSpecification(campaign, 'google_ads', 'google_pmax', refs);
  const creative = safeObject(campaign.creative_config);
  const headlines = assetArray(creative, ['headlines', 'asset_group.headlines']);
  const longHeadlines = assetArray(creative, ['long_headlines', 'asset_group.long_headlines']);
  const descriptions = assetArray(creative, ['descriptions', 'asset_group.descriptions']);
  const images = assetArray(creative, ['images', 'image_asset_ids', 'asset_group.images']);
  const logos = assetArray(creative, ['logos', 'logo_asset_ids', 'asset_group.logos']);
  const rawFinalUrls = assetArray(common.destination, ['final_urls', 'urls']);
  const singleFinalUrl = valuesAt(common.destination, ['final_url', 'effective_url', 'landing_url', 'url']);
  if (!rawFinalUrls.length && singleFinalUrl) rawFinalUrls.push(singleFinalUrl);
  const finalUrls = rawFinalUrls.map(httpUrl).filter(Boolean);

  if (!common.account_id) blockers.push(blocker('provider_account_required', 'platform_refs.customer_id', 'Falta una cuenta Google Ads asignada.'));
  else if (!/^\d{10}$/.test(common.account_id.replace(/-/g, ''))) blockers.push(blocker('provider_account_invalid', 'platform_refs.customer_id', 'La cuenta Google Ads debe ser un customer ID de 10 dígitos.'));
  if (!common.name) blockers.push(blocker('campaign_name_required', 'name', 'Falta el nombre de campaña.'));
  addMediaBudgetBlockers(common.budget, blockers);
  requireCount(blockers, finalUrls, 1, 'pmax_final_url_required', 'destination_config.final_urls', 'Performance Max requiere al menos una URL final.');
  if (rawFinalUrls.length !== finalUrls.length) blockers.push(blocker('pmax_final_url_invalid', 'destination_config.final_urls', 'Todas las URLs de Performance Max deben usar http(s) y no incluir credenciales.'));
  requireCount(blockers, headlines, 3, 'pmax_headlines_required', 'creative_config.headlines', 'Performance Max requiere al menos tres titulares proporcionados.');
  requireCount(blockers, longHeadlines, 1, 'pmax_long_headline_required', 'creative_config.long_headlines', 'Performance Max requiere un titular largo proporcionado.');
  requireCount(blockers, descriptions, 2, 'pmax_descriptions_required', 'creative_config.descriptions', 'Performance Max requiere al menos dos descripciones proporcionadas.');
  requireCount(blockers, images, 1, 'pmax_image_required', 'creative_config.images', 'Performance Max requiere imágenes aportadas y revisadas.');
  requireCount(blockers, logos, 1, 'pmax_logo_required', 'creative_config.logos', 'Performance Max requiere un logotipo aportado y revisado.');

  return {
    ...common,
    provider_campaign_type: 'PERFORMANCE_MAX',
    final_urls: finalUrls,
    asset_group: { headlines, long_headlines: longHeadlines, descriptions, images, logos },
  };
}

function metaCreative(campaign, blockers) {
  const creative = safeObject(campaign.creative_config);
  const primaryTexts = stringArrayAlias(creative, ['primary_texts', 'primary_text', 'messages']);
  const headlines = stringArrayAlias(creative, ['headlines', 'headline', 'titles']);
  const descriptions = stringArrayAlias(creative, ['descriptions', 'description']);
  const media = stringArrayAlias(creative, ['media', 'media_asset_ids', 'image_hashes', 'video_ids']);
  const callToAction = scalarAlias(creative, ['call_to_action', 'cta_type']);
  for (const [alias, code, field, message] of [
    [primaryTexts, 'meta_primary_text_alias_conflict', 'creative_config.primary_text', 'Los aliases de texto principal contienen contenidos distintos.'],
    [headlines, 'meta_headline_alias_conflict', 'creative_config.headline', 'Los aliases de titular contienen contenidos distintos.'],
    [descriptions, 'meta_description_alias_conflict', 'creative_config.description', 'Los aliases de descripción contienen contenidos distintos.'],
    [media, 'meta_media_alias_conflict', 'creative_config.media', 'Los aliases de creatividad contienen referencias distintas.'],
    [callToAction, 'meta_cta_alias_conflict', 'creative_config.call_to_action', 'Los aliases de CTA contienen valores distintos.'],
  ]) {
    if (alias.conflict) blockers.push(blocker(code, field, `${message} Conserva una única fuente explícita.`));
  }
  return {
    primary_texts: primaryTexts.value,
    headlines: headlines.value,
    descriptions: descriptions.value,
    media: media.value,
    call_to_action: callToAction.value,
  };
}

function buildMetaSpec(campaign, family, refs, blockers, warnings) {
  if (containsSensitiveUrl({
    target_config: campaign.target_config,
    audience_config: campaign.audience_config,
    schedule_config: campaign.schedule_config,
    destination_config: campaign.destination_config,
    creative_config: campaign.creative_config,
    tracking_plan: campaign.tracking_plan,
  })) {
    blockers.push(blocker(
      'meta_sensitive_url_forbidden',
      'campaign',
      'La configuración Meta contiene una URL con credenciales, tokens o firma; se ha eliminado del plan y debe sustituirse por una referencia segura.',
    ));
  }
  const common = commonSpecification(campaign, 'meta_ads', family, refs);
  const creative = metaCreative(campaign, blockers);
  const trackingPlan = safeObject(campaign.tracking_plan);
  const policyReadiness = safeObject(campaign.policy_readiness);
  const accountRef = scalarAlias(
    refs,
    ['ad_account_id', 'meta_ads_ad_account_id', 'account_id', 'meta_ads_account_id'],
    (value) => value.replace(/^act_/, ''),
  );
  const campaignRef = scalarAlias(refs, ['campaign_id', 'meta_ads_campaign_id']);
  const pageRef = scalarAlias(refs, ['page_id', 'meta_ads_page_id']);
  const instagramRef = scalarAlias(refs, ['instagram_actor_id', 'meta_ads_instagram_actor_id']);
  const pixelRef = scalarAlias(refs, ['pixel_id', 'meta_ads_pixel_id']);
  const formRef = scalarAlias(refs, ['instant_form_id', 'meta_ads_instant_form_id']);
  for (const [alias, code, field, message] of [
    [accountRef, 'meta_account_alias_conflict', 'platform_refs.ad_account_id', 'Las referencias de cuenta Meta contienen IDs distintos.'],
    [campaignRef, 'meta_campaign_alias_conflict', 'platform_refs.campaign_id', 'Las referencias de campaña Meta contienen IDs distintos.'],
    [pageRef, 'meta_page_alias_conflict', 'platform_refs.page_id', 'Las referencias de página Meta contienen IDs distintos.'],
    [instagramRef, 'meta_instagram_alias_conflict', 'platform_refs.instagram_actor_id', 'Las referencias de Instagram contienen IDs distintos.'],
    [pixelRef, 'meta_pixel_alias_conflict', 'platform_refs.pixel_id', 'Las referencias de píxel Meta contienen IDs distintos.'],
    [formRef, 'meta_instant_form_ref_alias_conflict', 'platform_refs.instant_form_id', 'Las referencias de formulario Meta contienen IDs distintos.'],
  ]) {
    if (alias.conflict) blockers.push(blocker(code, field, `${message} Conserva una única referencia explícita.`));
  }
  common.account_id = accountRef.value;
  common.existing_campaign_id = campaignRef.value;
  common.operation = campaignRef.value ? 'update_existing' : 'create_new';
  const pageId = pageRef.value;
  const pixelId = pixelRef.value;
  const instantFormAliases = [
    common.destination.instant_form_id,
    common.destination.form_id,
    formRef.value,
  ].filter((value) => value !== undefined && value !== null && value !== '');
  const normalizedInstantFormAliases = instantFormAliases.map((value) => text(value, 128));
  if (instantFormAliases.length > 1
    && (normalizedInstantFormAliases.some((value) => !value)
      || new Set(normalizedInstantFormAliases).size > 1)) {
    blockers.push(blocker('meta_instant_form_alias_conflict', 'destination_config', 'Los aliases de formulario instantáneo contienen IDs distintos; conserva una única referencia explícita.'));
  }
  const instantFormId = normalizedInstantFormAliases[0] || null;
  const destinationAliases = [
    common.destination.final_url,
    common.destination.landing_url,
    common.destination.url,
    common.destination.effective_url,
  ].filter((value) => value !== undefined && value !== null && value !== '');
  const normalizedDestinationAliases = destinationAliases.map(httpUrl);
  if (destinationAliases.length > 1
    && (normalizedDestinationAliases.some((value) => !value)
      || new Set(normalizedDestinationAliases).size > 1)) {
    blockers.push(blocker('meta_destination_alias_conflict', 'destination_config', 'Los aliases de destino Meta contienen URLs distintas; conserva una única URL final.'));
  }
  const rawMetaDestination = destinationAliases[0] || null;
  const metaDestination = normalizedDestinationAliases[0] || null;

  if (!common.account_id) blockers.push(blocker('provider_account_required', 'platform_refs.ad_account_id', 'Falta una cuenta publicitaria Meta asignada.'));
  else if (!/^(?:act_)?\d+$/.test(common.account_id)) blockers.push(blocker('provider_account_invalid', 'platform_refs.ad_account_id', 'La cuenta Meta debe ser un ID numérico, con prefijo act_ opcional.'));
  if (!pageId) blockers.push(blocker('meta_page_required', 'platform_refs.page_id', 'Meta requiere una página asignada como identidad.'));
  else if (!/^\d+$/.test(pageId)) blockers.push(blocker('meta_page_invalid', 'platform_refs.page_id', 'La página Meta debe usar un ID numérico.'));
  if (!common.name) blockers.push(blocker('campaign_name_required', 'name', 'Falta el nombre de campaña.'));
  addMediaBudgetBlockers(common.budget, blockers);
  requireCount(blockers, creative.primary_texts, 1, 'meta_primary_text_required', 'creative_config.primary_text', 'Meta requiere un texto principal proporcionado.');
  requireCount(blockers, creative.media, 1, 'meta_media_required', 'creative_config.media', 'Meta requiere una imagen o vídeo proporcionado.');
  if (creative.call_to_action && !(META_CTA_TYPES[family] || []).includes(creative.call_to_action)) {
    blockers.push(blocker('meta_cta_invalid', 'creative_config.call_to_action', `El CTA no pertenece a la lista admitida para ${family}; usa un valor revisado como LEARN_MORE.`));
  }
  if (family === 'meta_instant_form' && !instantFormId) {
    blockers.push(blocker('meta_instant_form_required', 'destination_config.instant_form_id', 'La campaña de formulario requiere un formulario instantáneo existente.'));
  } else if (family === 'meta_instant_form' && !/^\d+$/.test(instantFormId)) {
    blockers.push(blocker('meta_instant_form_invalid', 'destination_config.instant_form_id', 'El formulario instantáneo debe usar un ID numérico.'));
  }
  if (family === 'meta_instant_form' && !creative.call_to_action) {
    blockers.push(blocker('meta_cta_required', 'creative_config.call_to_action', 'El formulario instantáneo requiere un CTA explícito.'));
  } else if (family === 'meta_reach' && metaDestination && !creative.call_to_action) {
    blockers.push(blocker('meta_cta_required', 'creative_config.call_to_action', 'El anuncio de alcance con destino web requiere un CTA explícito.'));
  } else if (family === 'meta_reach' && !metaDestination && creative.call_to_action) {
    blockers.push(blocker('meta_cta_destination_required', 'destination_config.final_url', 'No se puede preparar un CTA de alcance sin una URL pública de destino.'));
  }
  if (family === 'meta_reach' && !rawMetaDestination) {
    warnings.push(warning('meta_destination_optional', 'destination_config', 'No se ha indicado URL; el plan de alcance queda limitado al destino nativo configurado.'));
  } else if (family === 'meta_reach' && !metaDestination) {
    blockers.push(blocker('meta_destination_invalid', 'destination_config.final_url', 'La URL de destino Meta debe usar http(s) y no incluir credenciales.'));
  }

  return {
    ...common,
    provider_objective: family === 'meta_instant_form' ? 'OUTCOME_LEADS' : 'OUTCOME_AWARENESS',
    identity: { page_id: pageId, instagram_actor_id: instagramRef.value },
    instant_form_id: family === 'meta_instant_form' ? instantFormId : null,
    destination: {
      final_url: family === 'meta_reach' ? metaDestination : null,
      instant_form_id: family === 'meta_instant_form' ? instantFormId : null,
    },
    tracking: {
      status: text(trackingPlan.status, 32)?.toLowerCase() || null,
      conversion_actions_ready: trackingPlan.conversion_actions_ready === true,
      pixel_id: pixelId,
    },
    compliance: {
      dsa_beneficiary: text(valuesAt(policyReadiness, ['dsa_beneficiary', 'dsa.beneficiary']), 10000),
      dsa_payor: text(valuesAt(policyReadiness, ['dsa_payor', 'dsa.payor']), 10000),
    },
    creative,
  };
}

function addOperationalBlockers(campaign, evidence, blockers) {
  if (campaign.management_mode !== 'autopilot') blockers.push(blocker('autopilot_mode_required', 'management_mode', 'Solo Piloto automático puede publicarse de forma gestionada.'));
  if (campaign.operation_mode !== 'managed') blockers.push(blocker('managed_operation_required', 'operation_mode', 'La campaña sigue en observación.'));
  if (campaign.status !== 'approved_to_launch') blockers.push(blocker('approved_to_launch_required', 'status', 'La campaña debe estar aprobada para lanzamiento.'));

  const review = safeObject(campaign.review_config);
  if (review.client_approval_required === true && !review.client_approved_at) {
    blockers.push(blocker('client_approval_required', 'review_config.client_approved_at', 'Falta la aprobación explícita del cliente.'));
  }
  if (!campaign.approved_at || !positiveInteger(campaign.approved_by_user_id)) {
    blockers.push(blocker('admin_approval_required', 'approved_at', 'Falta la aprobación interna auditada.'));
  }

  const policy = safeObject(campaign.policy_readiness);
  if (!['ready', 'configured', 'approved'].includes(String(policy.status || '').toLowerCase())) {
    blockers.push(blocker('policy_not_ready', 'policy_readiness.status', 'La revisión de políticas no está lista.'));
  }
  const tracking = safeObject(campaign.tracking_plan);
  if (!['ready', 'configured'].includes(String(tracking.status || '').toLowerCase()) && tracking.conversion_actions_ready !== true) {
    blockers.push(blocker('tracking_not_ready', 'tracking_plan.status', 'El tracking y las conversiones no están listos.'));
  }
  const funding = safeObject(campaign.funding);
  if (!positiveNumber(funding.available_amount)) {
    blockers.push(blocker('funding_not_available', 'funding.available_amount', 'No hay saldo publicitario neto disponible.'));
  }
  if (safeObject(campaign.creative_config).assets_ready !== true) {
    blockers.push(blocker('creative_assets_not_ready', 'creative_config.assets_ready', 'Los assets creativos no están marcados como revisados.'));
  }

  for (const gate of REQUIRED_GATE_EVIDENCE) {
    if (evidence[gate] !== true) {
      const labels = {
        prepayment_verified: 'cobro por adelantado verificado',
        budget_approved: 'presupuesto aprobado por el cliente',
        policy_reviewed: 'políticas revisadas',
        tracking_verified: 'tracking verificado',
        creative_rights_confirmed: 'derechos de uso de creatividades confirmados',
      };
      blockers.push(blocker(`gate_${gate}_required`, `gate_evidence.${gate}`, `Falta confirmar: ${labels[gate]}.`));
    }
  }
}

function buildManagedCampaignPublishingPlan({
  campaign,
  gateEvidence = {},
  accountAuthorization = null,
} = {}) {
  const row = plainCampaign(campaign);
  if (!row) {
    const error = new Error('ManagedCampaign es obligatorio');
    error.code = 'MANAGED_CAMPAIGN_REQUIRED';
    throw error;
  }

  const provider = text(row.provider, 32);
  const family = text(row.family, 64);
  const blockers = [];
  const warnings = [];
  const refs = safePlatformReferences(provider, row.platform_refs);
  const supported = Boolean(provider && family && SUPPORTED_FAMILIES[provider]?.includes(family));
  if (!supported) {
    blockers.push(blocker('unsupported_provider_family', 'family', 'La familia seleccionada todavía no tiene adaptador de publicación gestionada. Elige Search, Performance Max, Alcance o Formulario instantáneo.'));
  }

  let specification = commonSpecification(row, provider, family, refs);
  if (provider === 'google_ads' && family === 'google_search') {
    specification = buildGoogleSearchSpec(row, refs, blockers);
  } else if (provider === 'google_ads' && family === 'google_pmax') {
    specification = buildGooglePmaxSpec(row, refs, blockers);
  } else if (provider === 'meta_ads' && ['meta_reach', 'meta_instant_form'].includes(family)) {
    specification = buildMetaSpec(row, family, refs, blockers, warnings);
  }

  if (specification.account_id
    && !publishingAccountScopeIsAuthorized(row, specification, accountAuthorization)) {
    blockers.push(blocker(
      'provider_account_scope_forbidden',
      provider === 'meta_ads' ? 'platform_refs.ad_account_id' : 'platform_refs.customer_id',
      'La cuenta publicitaria seleccionada no pertenece al ámbito autorizado de esta clínica o grupo, o su autorización ya no está activa. Elige una cuenta autorizada antes de publicar.',
    ));
  }

  const evidence = Object.fromEntries(REQUIRED_GATE_EVIDENCE.map((key) => [key, gateEvidence?.[key] === true]));
  addOperationalBlockers(row, evidence, blockers);
  const sanitizedSpecification = sanitizeForPlan(specification);
  const dryRunAdapter = buildManagedCampaignDryRunAdapter({
    provider,
    family,
    specification: sanitizedSpecification,
  });
  for (const item of dryRunAdapter.readiness.blockers || []) {
    if (!blockers.some((existing) => existing.code === item.code)) blockers.push(item);
  }
  for (const item of dryRunAdapter.readiness.warnings || []) {
    if (!warnings.some((existing) => existing.code === item.code)) warnings.push(item);
  }
  const providerExecution = executionCapability(provider, family, sanitizedSpecification.operation);
  const deterministicPayload = {
    schema_version: PLAN_SCHEMA_VERSION,
    mode: 'dry_run',
    campaign: {
      id: text(row.id, 64),
      version: positiveInteger(row.version) || 1,
      clinic_id: positiveInteger(row.clinica_id),
      group_id: positiveInteger(row.grupo_clinica_id),
      provider,
      family,
    },
    specification: sanitizedSpecification,
    dry_run_adapter: dryRunAdapter,
    gate_evidence: evidence,
    readiness: {
      ready: blockers.length === 0,
      blockers,
      warnings,
    },
    execution: {
      dry_run_adapter_available: dryRunAdapter.dry_run_adapter_available === true,
      dry_run_adapter_version: dryRunAdapter.adapter_version || null,
      dry_run_operation_count: Array.isArray(dryRunAdapter.operations) ? dryRunAdapter.operations.length : 0,
      execution_adapter_available: providerExecution.registered,
      execution_adapter_version: providerExecution.adapter_version,
      adapter_available: providerExecution.registered,
      supported_operation: providerExecution.operation,
      safety: providerExecution.safety,
      provider_call_performed: false,
      required_confirmations: [...REQUIRED_EXECUTION_CONFIRMATIONS],
    },
  };
  const planHash = sha256(canonicalStringify(deterministicPayload));
  return {
    ...deterministicPayload,
    plan_id: `managed:${deterministicPayload.campaign.id || 'missing'}:v${deterministicPayload.campaign.version}:${planHash.slice(0, 16)}`,
    plan_hash: planHash,
  };
}

function deterministicPublishingPayload(plan) {
  const source = safeObject(plan);
  // Keep this projection byte-for-byte equivalent to deterministicPayload in
  // buildManagedCampaignPublishingPlan. Re-sanitizing here is asymmetric: for
  // example, a legitimate safety key containing "authorization" would be
  // removed only during verification and invalidate every genuine plan.
  return {
    schema_version: source.schema_version,
    mode: source.mode,
    campaign: source.campaign,
    specification: source.specification,
    dry_run_adapter: source.dry_run_adapter,
    gate_evidence: source.gate_evidence,
    readiness: source.readiness,
    execution: source.execution,
  };
}

function evaluateManagedCampaignExecutionGates({ plan, confirmation = {} } = {}) {
  const failures = [];
  if (!plan || plan.schema_version !== PLAN_SCHEMA_VERSION || plan.mode !== 'dry_run') {
    failures.push(blocker('invalid_plan', 'plan', 'Se requiere un plan dry-run válido.'));
  }
  if (plan?.readiness?.ready !== true || (plan?.readiness?.blockers || []).length > 0) {
    failures.push(blocker('plan_not_ready', 'plan.readiness', 'El plan conserva blockers de publicación.'));
  }
  const planHash = text(plan?.plan_hash, 64);
  const recomputedPlanHash = planHash && /^[a-f0-9]{64}$/i.test(planHash)
    ? sha256(canonicalStringify(deterministicPublishingPayload(plan)))
    : null;
  if (!recomputedPlanHash || recomputedPlanHash !== planHash) {
    failures.push(blocker('plan_hash_invalid', 'plan.plan_hash', 'El hash interno del plan no coincide con su contenido canónico.'));
  }
  const expectedPlanId = recomputedPlanHash
    ? `managed:${text(plan?.campaign?.id, 64) || 'missing'}:v${positiveInteger(plan?.campaign?.version) || 1}:${recomputedPlanHash.slice(0, 16)}`
    : null;
  if (!expectedPlanId || text(plan?.plan_id, 191) !== expectedPlanId) {
    failures.push(blocker('plan_id_invalid', 'plan.plan_id', 'El identificador del plan no corresponde con campaña, versión y hash.'));
  }
  const expectedDryRunAdapter = buildManagedCampaignDryRunAdapter({
    provider: plan?.campaign?.provider,
    family: plan?.campaign?.family,
    specification: plan?.specification,
  });
  if (expectedDryRunAdapter.dry_run_adapter_available !== true
    || canonicalStringify(expectedDryRunAdapter) !== canonicalStringify(plan?.dry_run_adapter)) {
    failures.push(blocker('dry_run_manifest_invalid', 'plan.dry_run_adapter', 'El manifiesto dry-run no coincide con el adaptador versionado del servidor.'));
  }
  const currentExecutionCapability = executionCapability(
    plan?.campaign?.provider,
    plan?.campaign?.family,
    plan?.specification?.operation,
  );
  if (!hasManagedCampaignExecutionAdapter(
    plan?.campaign?.provider,
    plan?.campaign?.family,
    plan?.specification?.operation,
  ) || plan?.execution?.execution_adapter_available !== true
    || plan?.execution?.adapter_available !== true) {
    failures.push(blocker('execution_adapter_unavailable', 'plan.execution', 'No existe un adaptador de ejecución registrado para esta familia; el dry-run nunca autoriza una mutación externa.'));
  }
  if (currentExecutionCapability.registered
    && (plan?.execution?.execution_adapter_version !== currentExecutionCapability.adapter_version
      || plan?.execution?.supported_operation !== currentExecutionCapability.operation
      || canonicalStringify(plan?.execution?.safety) !== canonicalStringify(currentExecutionCapability.safety)
      || canonicalStringify(plan?.execution?.required_confirmations)
        !== canonicalStringify(REQUIRED_EXECUTION_CONFIRMATIONS))) {
    failures.push(blocker(
      'execution_adapter_manifest_invalid',
      'plan.execution',
      'El plan fue generado con otro contrato de ejecución; crea y confirma un dry-run nuevo.',
    ));
  }
  if (!text(confirmation.plan_hash, 64) || confirmation.plan_hash !== plan?.plan_hash) {
    failures.push(blocker('plan_hash_confirmation_required', 'confirmation.plan_hash', 'La confirmación no corresponde al hash del plan.'));
  }
  if (!positiveInteger(confirmation.actor_user_id)) {
    failures.push(blocker('actor_required', 'confirmation.actor_user_id', 'Falta el operador autenticado.'));
  }
  if (!text(confirmation.idempotency_key, 191)) {
    failures.push(blocker('idempotency_key_required', 'confirmation.idempotency_key', 'Falta una clave de idempotencia explícita.'));
  }
  if (!text(confirmation.change_reference, 191)) {
    failures.push(blocker('change_reference_required', 'confirmation.change_reference', 'Falta una referencia de cambio auditable.'));
  }
  for (const gate of REQUIRED_EXECUTION_CONFIRMATIONS) {
    if (confirmation[gate] !== true) {
      failures.push(blocker(`${gate}_required`, `confirmation.${gate}`, `Falta la confirmación explícita ${gate}.`));
    }
  }
  return {
    schema_version: AUTHORIZATION_SCHEMA_VERSION,
    allowed: failures.length === 0,
    failures,
    plan_id: text(plan?.plan_id, 191),
    plan_hash: text(plan?.plan_hash, 64),
    campaign_id: text(plan?.campaign?.id, 64),
    provider: text(plan?.campaign?.provider, 32),
    family: text(plan?.campaign?.family, 64),
    actor_user_id: positiveInteger(confirmation.actor_user_id),
    idempotency_key: text(confirmation.idempotency_key, 191),
    change_reference: text(confirmation.change_reference, 191),
    provider_call_performed: false,
  };
}

function assertManagedCampaignExecutionGates(input) {
  const authorization = evaluateManagedCampaignExecutionGates(input);
  if (authorization.allowed) return authorization;
  const error = new Error('No se cumplen los gates para una futura ejecución gestionada');
  error.code = 'MANAGED_CAMPAIGN_EXECUTION_GATES_FAILED';
  error.failures = authorization.failures;
  throw error;
}

module.exports = {
  AUTHORIZATION_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  REQUIRED_EXECUTION_CONFIRMATIONS,
  REQUIRED_GATE_EVIDENCE,
  SUPPORTED_FAMILIES,
  assertManagedCampaignExecutionGates,
  buildManagedCampaignPublishingPlan,
  canonicalStringify,
  evaluateManagedCampaignExecutionGates,
  isSecretKey,
  httpUrl,
  managedCampaignPublishingAccountScopeInput,
  sanitizeForPlan,
};

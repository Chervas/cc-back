'use strict';

const crypto = require('node:crypto');
const { publicHttpUrl } = require('../lib/safeHttpTarget');

const ADAPTER_SCHEMA_VERSION = 'managed-google-ads-dry-run-adapter/v1';
const ADAPTER_VERSION = '1.0.0';
const MONTHLY_BUDGET_DAYS = 30.4;
const SUPPORTED_FAMILIES = Object.freeze(['google_search', 'google_pmax']);
const SUPPORTED_OPERATIONS = Object.freeze(['create_new', 'update_existing']);
const GOOGLE_LIMITS = Object.freeze({
  search: Object.freeze({
    keywords: Object.freeze({ min: 1, max: 20_000, text: 80 }),
    headlines: Object.freeze({ min: 3, max: 15, text: 30 }),
    descriptions: Object.freeze({ min: 2, max: 4, text: 90 }),
  }),
  pmax: Object.freeze({
    final_urls: Object.freeze({ min: 1, max: 1, text: 2048 }),
    headlines: Object.freeze({ min: 3, max: 15, text: 30 }),
    long_headlines: Object.freeze({ min: 1, max: 5, text: 90 }),
    descriptions: Object.freeze({ min: 2, max: 5, text: 90 }),
    images: Object.freeze({ min: 1, max: 20, text: 2048 }),
    logos: Object.freeze({ min: 1, max: 5, text: 2048 }),
  }),
});

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, max = 2048) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  const clean = String(value).trim();
  return clean ? clean.slice(0, max) : null;
}

function positiveNumber(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function moneyCents(value) {
  const parsed = nonNegativeNumber(value);
  return parsed === null ? null : Math.round(parsed * 100);
}

function normalizedKey(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase();
}

function isSecretKey(key) {
  return /(^|_)(access_token|refresh_token|client_secret|api_key|private_key|password|passwd|authorization|cookie|session|hmac_key|credentials?|secret|token)($|_)/.test(normalizedKey(key));
}

function sanitize(value, depth = 0) {
  if (depth > 12 || value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 10000);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (typeof value !== 'object') return null;

  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (isSecretKey(key)) continue;
    output[key] = sanitize(value[key], depth + 1);
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

function issue(code, field, message) {
  return { code, field, message };
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [];
}

function strictText(value, max) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) return { value: null, reason: 'type' };
  const clean = String(value).trim();
  if (!clean) return { value: null, reason: 'empty' };
  if (clean.length > max) return { value: null, reason: 'length' };
  return { value: clean, reason: null };
}

function normalizeTextList(value, {
  field,
  code,
  label,
  min,
  max,
  text: maxTextLength,
}, blockers) {
  const source = list(value);
  const normalized = [];
  const seen = new Set();
  let invalidCount = 0;
  let tooLongCount = 0;
  let duplicateCount = 0;

  for (const item of source) {
    const parsed = strictText(item, maxTextLength);
    if (!parsed.value) {
      if (parsed.reason === 'length') tooLongCount += 1;
      else invalidCount += 1;
      continue;
    }
    if (seen.has(parsed.value)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(parsed.value);
    normalized.push(parsed.value);
  }

  if (invalidCount) {
    blockers.push(issue(
      `${code}_invalid`,
      field,
      `${label}: ${invalidCount} elemento(s) no son texto escalar válido.`,
    ));
  }
  if (tooLongCount) {
    blockers.push(issue(
      `${code}_too_long`,
      field,
      `${label}: ${tooLongCount} elemento(s) superan ${maxTextLength} caracteres.`,
    ));
  }
  if (duplicateCount) {
    blockers.push(issue(
      `${code}_duplicate`,
      field,
      `${label}: elimina ${duplicateCount} duplicado(s) antes de preparar el manifiesto.`,
    ));
  }
  if (normalized.length < min) {
    blockers.push(issue(
      `${code}_required`,
      field,
      `${label}: se requieren al menos ${min} valor(es) válidos y únicos.`,
    ));
  }
  if (normalized.length > max) {
    blockers.push(issue(
      `${code}_too_many`,
      field,
      `${label}: Google admite como máximo ${max} valor(es).`,
    ));
  }
  return normalized.slice(0, max);
}

function normalizePublicUrlList(value, {
  field,
  code,
  label,
  min,
  max,
}, blockers) {
  const source = list(value);
  const normalized = [];
  const seen = new Set();
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const item of source) {
    const candidate = strictText(item, 2048).value;
    const safeUrl = candidate ? publicHttpUrl(candidate) : null;
    if (!safeUrl) {
      invalidCount += 1;
      continue;
    }
    if (seen.has(safeUrl)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(safeUrl);
    normalized.push(safeUrl);
  }

  if (invalidCount) {
    blockers.push(issue(
      `${code}_invalid`,
      field,
      `${label}: ${invalidCount} URL(s) no son HTTP(S) públicas sin credenciales.`,
    ));
  }
  if (duplicateCount) {
    blockers.push(issue(
      `${code}_duplicate`,
      field,
      `${label}: elimina ${duplicateCount} URL(s) duplicada(s).`,
    ));
  }
  if (normalized.length < min) {
    blockers.push(issue(`${code}_required`, field, `${label}: se requieren al menos ${min} URL(s) públicas válidas.`));
  }
  if (normalized.length > max) {
    blockers.push(issue(`${code}_too_many`, field, `${label}: Google admite como máximo ${max} URL(s).`));
  }
  return normalized.slice(0, max);
}

function planningBudget(specification, blockers, warnings) {
  const budget = safeObject(specification.budget);
  const requestedAmount = positiveNumber(budget.provider_media_budget_amount);
  const approvedClientGrossAmount = positiveNumber(budget.approved_client_gross_amount);
  const fundedClientGrossAmount = positiveNumber(budget.funded_client_gross_amount);
  const commissionAmount = nonNegativeNumber(budget.commission_amount);
  const mediaBudgetTotal = positiveNumber(budget.media_budget_total);
  const mediaBudgetAvailable = positiveNumber(budget.media_budget_available);
  const declaredApprovedMediaBudgetCap = positiveNumber(budget.approved_media_budget_cap);
  const expectedApprovedMediaBudgetCap = approvedClientGrossAmount && fundedClientGrossAmount && mediaBudgetTotal
    ? Math.round(((approvedClientGrossAmount * mediaBudgetTotal / fundedClientGrossAmount) + Number.EPSILON) * 100) / 100
    : null;
  const amount = requestedAmount && mediaBudgetTotal && mediaBudgetAvailable && expectedApprovedMediaBudgetCap
    ? Math.min(requestedAmount, mediaBudgetTotal, mediaBudgetAvailable, expectedApprovedMediaBudgetCap)
    : null;
  const period = text(budget.period, 32)?.toLowerCase();
  if (!requestedAmount) blockers.push(issue('adapter_provider_budget_required', 'specification.budget.provider_media_budget_amount', 'El adaptador Google requiere un presupuesto neto disponible para medios.'));
  if (!approvedClientGrossAmount) blockers.push(issue('adapter_approved_gross_budget_required', 'specification.budget.approved_client_gross_amount', 'Falta el total bruto aprobado por el cliente.'));
  if (!fundedClientGrossAmount) blockers.push(issue('adapter_funded_gross_budget_required', 'specification.budget.funded_client_gross_amount', 'Falta el total bruto realmente cobrado.'));
  if (commissionAmount === null) blockers.push(issue('adapter_commission_snapshot_required', 'specification.budget.commission_amount', 'Falta el snapshot de comisión del prepago.'));
  if (!mediaBudgetTotal) blockers.push(issue('adapter_media_budget_total_required', 'specification.budget.media_budget_total', 'Falta el presupuesto neto total después de comisión.'));
  if (!mediaBudgetAvailable) blockers.push(issue('adapter_media_budget_available_required', 'specification.budget.media_budget_available', 'Falta el saldo neto todavía disponible para medios.'));
  if (!declaredApprovedMediaBudgetCap) blockers.push(issue('adapter_approved_media_cap_required', 'specification.budget.approved_media_budget_cap', 'Falta la asignación neta del periodo aprobado.'));
  if (declaredApprovedMediaBudgetCap && expectedApprovedMediaBudgetCap
    && moneyCents(declaredApprovedMediaBudgetCap) !== moneyCents(expectedApprovedMediaBudgetCap)) {
    blockers.push(issue('adapter_approved_media_cap_inconsistent', 'specification.budget.approved_media_budget_cap', 'La asignación neta declarada no coincide con el presupuesto aprobado y el desglose financiado.'));
  }
  if (requestedAmount && mediaBudgetTotal && requestedAmount > mediaBudgetTotal) {
    blockers.push(issue('adapter_provider_budget_exceeds_net', 'specification.budget.provider_media_budget_amount', 'El presupuesto del proveedor no puede superar el neto destinado a publicidad.'));
  }
  if (requestedAmount && mediaBudgetAvailable && requestedAmount > mediaBudgetAvailable) {
    blockers.push(issue('adapter_provider_budget_exceeds_available', 'specification.budget.provider_media_budget_amount', 'El presupuesto del proveedor no puede superar el saldo neto disponible.'));
  }
  if (requestedAmount && expectedApprovedMediaBudgetCap && requestedAmount > expectedApprovedMediaBudgetCap) {
    blockers.push(issue('adapter_provider_budget_exceeds_approved_cap', 'specification.budget.provider_media_budget_amount', 'El presupuesto del proveedor no puede superar la asignación neta del periodo aprobado.'));
  }
  if (mediaBudgetTotal && fundedClientGrossAmount && mediaBudgetTotal > fundedClientGrossAmount) {
    blockers.push(issue('adapter_media_budget_exceeds_gross', 'specification.budget.media_budget_total', 'El presupuesto neto de medios no puede superar el total bruto del cliente.'));
  }
  if (mediaBudgetAvailable && mediaBudgetTotal && mediaBudgetAvailable > mediaBudgetTotal) {
    blockers.push(issue('adapter_available_media_exceeds_net', 'specification.budget.media_budget_available', 'El saldo neto disponible no puede superar el neto total de medios.'));
  }
  const fundedCents = moneyCents(fundedClientGrossAmount);
  const commissionCents = moneyCents(commissionAmount);
  const mediaBudgetCents = moneyCents(mediaBudgetTotal);
  if (fundedCents !== null && commissionCents !== null && mediaBudgetCents !== null
    && fundedCents - commissionCents !== mediaBudgetCents) {
    blockers.push(issue('adapter_funding_breakdown_inconsistent', 'specification.budget', 'El bruto cobrado menos la comisión no coincide con el neto de medios.'));
  }
  if (fundedClientGrossAmount && approvedClientGrossAmount && fundedClientGrossAmount < approvedClientGrossAmount) {
    blockers.push(issue('adapter_funding_below_approved_budget', 'specification.budget.funded_client_gross_amount', 'El prepago no cubre el presupuesto bruto aprobado.'));
  }
  if (!['daily', 'monthly'].includes(period)) {
    blockers.push(issue('adapter_budget_period_unsupported', 'specification.budget.period', 'El adaptador Google solo admite presupuesto diario o mensual.'));
  }

  const divisor = period === 'monthly' ? MONTHLY_BUDGET_DAYS : 1;
  const flooredMicros = amount && ['daily', 'monthly'].includes(period)
    ? Math.floor(amount * 1_000_000 / divisor)
    : null;
  const validMicros = Number.isSafeInteger(flooredMicros) && flooredMicros > 0;
  const dailyAmount = validMicros ? flooredMicros / 1_000_000 : null;
  if (requestedAmount && ['daily', 'monthly'].includes(period) && !validMicros) {
    blockers.push(issue(
      'adapter_budget_micros_invalid',
      'specification.budget.provider_media_budget_amount',
      'El presupuesto diario convertido a micros debe ser un entero positivo y seguro.',
    ));
  }
  if (requestedAmount && period === 'monthly') {
    warnings.push(issue(
      'adapter_monthly_budget_normalized',
      'specification.budget',
      `La simulación divide el presupuesto mensual entre ${MONTHLY_BUDGET_DAYS} días; el operador debe revisar el importe diario antes de una futura ejecución.`,
    ));
  }

  return {
    client_period: period || null,
    approved_client_gross_amount: approvedClientGrossAmount,
    funded_client_gross_amount: fundedClientGrossAmount,
    media_budget_total: mediaBudgetTotal,
    media_budget_available: mediaBudgetAvailable,
    approved_media_budget_cap: expectedApprovedMediaBudgetCap,
    declared_approved_media_budget_cap: declaredApprovedMediaBudgetCap,
    requested_provider_media_budget_amount: requestedAmount,
    provider_media_budget_amount: amount,
    planning_daily_amount: dailyAmount,
    planning_daily_amount_micros: validMicros ? flooredMicros : null,
    currency: text(budget.currency, 3)?.toUpperCase() || null,
    divisor_days: period === 'monthly' ? MONTHLY_BUDGET_DAYS : null,
  };
}

function operation(order, key, resourceType, action, label, payloadPreview, dependsOn = []) {
  return {
    order,
    key,
    resource_type: resourceType,
    action,
    label,
    depends_on: dependsOn,
    payload_preview: sanitize(payloadPreview),
    provider_call_performed: false,
  };
}

function updatesExistingCampaign(specification) {
  return specification.operation === 'update_existing';
}

function baseOperations(specification, budget) {
  const updateExisting = updatesExistingCampaign(specification);
  const campaignName = text(specification.name, 255);
  return [
    operation(1, 'campaign_budget', 'CampaignBudget', updateExisting ? 'resolve_campaign_budget_then_update' : 'create', 'Preparar presupuesto diario', {
      name: campaignName ? `${campaignName} · Presupuesto` : null,
      amount_micros: budget.planning_daily_amount_micros,
      delivery_method: 'STANDARD',
      explicitly_shared: false,
      ...(updateExisting
        ? { selector: { via_campaign_id: text(specification.existing_campaign_id, 256) } }
        : { temporary_reference: '$campaign_budget' }),
    }),
  ];
}

function googleSearchOperations(specification, budget, warnings) {
  const updateExisting = updatesExistingCampaign(specification);
  const campaignName = text(specification.name, 255);
  const keywords = list(safeObject(specification.ad_group).keywords).map((item) => ({
    text: text(item, 2048),
    match_type: 'PHRASE',
    source: 'clinicaclick_managed_default',
  })).filter((item) => item.text);
  const creative = safeObject(specification.creative);
  warnings.push(issue(
    'adapter_search_defaults_applied',
    'dry_run_adapter.operations',
    updateExisting
      ? 'La simulación conserva el estado de la campaña existente y prepara nuevos recursos en pausa con Maximize Conversions y keywords de frase; no se enviarán sin aprobación futura.'
      : 'La simulación crea la campaña y el anuncio en pausa con Maximize Conversions y keywords de frase; no se enviarán sin aprobación futura.',
  ));

  return [
    ...baseOperations(specification, budget),
    operation(2, 'campaign', 'Campaign', updateExisting ? 'update' : 'create', updateExisting ? 'Preparar actualización de campaña Search' : 'Preparar campaña Search en pausa', {
      existing_campaign_id: text(specification.existing_campaign_id, 256),
      name: campaignName,
      advertising_channel_type: 'SEARCH',
      ...(!updateExisting ? { status: 'PAUSED' } : {}),
      campaign_budget_ref: '$campaign_budget',
      bidding_strategy_type: 'MAXIMIZE_CONVERSIONS',
      targeting: safeObject(specification.targeting),
      schedule: safeObject(specification.schedule),
    }, ['campaign_budget']),
    operation(3, 'ad_group', 'AdGroup', 'create', 'Preparar nuevo grupo de anuncios', {
      name: campaignName ? `${campaignName} · Grupo principal` : null,
      campaign_ref: '$campaign',
      status: 'ENABLED',
      type: 'SEARCH_STANDARD',
    }, ['campaign']),
    operation(4, 'keywords', 'AdGroupCriterion', 'sync', 'Preparar keywords revisadas', {
      ad_group_ref: '$ad_group',
      criteria: keywords,
      destructive_replace: false,
    }, ['ad_group']),
    operation(5, 'responsive_search_ad', 'AdGroupAd', 'create', 'Preparar nuevo anuncio de búsqueda adaptable', {
      ad_group_ref: '$ad_group',
      status: 'PAUSED',
      final_urls: list(specification.final_urls),
      headlines: list(creative.headlines).map((value) => ({ text: text(value, 2048) })).filter((item) => item.text),
      descriptions: list(creative.descriptions).map((value) => ({ text: text(value, 2048) })).filter((item) => item.text),
    }, ['ad_group']),
  ];
}

function googlePmaxOperations(specification, budget, warnings) {
  const updateExisting = updatesExistingCampaign(specification);
  const campaignName = text(specification.name, 255);
  const assetGroup = safeObject(specification.asset_group);
  warnings.push(issue(
    'adapter_pmax_defaults_applied',
    'dry_run_adapter.operations',
    updateExisting
      ? 'La simulación conserva el estado de la campaña existente y prepara el nuevo grupo de recursos en pausa con Maximize Conversions; los assets deben resolverse y revisarse.'
      : 'La simulación crea la campaña y el grupo de recursos en pausa con Maximize Conversions; los assets deben resolverse y revisarse.',
  ));

  return [
    ...baseOperations(specification, budget),
    operation(2, 'campaign', 'Campaign', updateExisting ? 'update' : 'create', updateExisting ? 'Preparar actualización de campaña Performance Max' : 'Preparar campaña Performance Max en pausa', {
      existing_campaign_id: text(specification.existing_campaign_id, 256),
      name: campaignName,
      advertising_channel_type: 'PERFORMANCE_MAX',
      ...(!updateExisting ? { status: 'PAUSED' } : {}),
      campaign_budget_ref: '$campaign_budget',
      bidding_strategy_type: 'MAXIMIZE_CONVERSIONS',
      targeting: safeObject(specification.targeting),
      schedule: safeObject(specification.schedule),
    }, ['campaign_budget']),
    operation(3, 'assets', 'Asset', 'resolve_or_create', 'Resolver assets aportados', {
      headlines: list(assetGroup.headlines),
      long_headlines: list(assetGroup.long_headlines),
      descriptions: list(assetGroup.descriptions),
      images: list(assetGroup.images),
      logos: list(assetGroup.logos),
    }, ['campaign']),
    operation(4, 'asset_group', 'AssetGroup', 'create', 'Preparar nuevo grupo de recursos', {
      name: campaignName ? `${campaignName} · Recursos` : null,
      campaign_ref: '$campaign',
      status: 'PAUSED',
      final_urls: list(specification.final_urls),
    }, ['campaign', 'assets']),
    operation(5, 'asset_group_links', 'AssetGroupAsset', 'sync', 'Preparar enlaces de assets', {
      asset_group_ref: '$asset_group',
      asset_refs: '$assets',
      destructive_replace: false,
    }, ['asset_group', 'assets']),
  ];
}

function normalizeOperation(specification, blockers) {
  const operation = text(specification.operation, 32);
  const rawCampaignId = text(specification.existing_campaign_id, 256);
  const campaignId = rawCampaignId && /^\d{1,20}$/.test(rawCampaignId) ? rawCampaignId : null;
  if (!SUPPORTED_OPERATIONS.includes(operation)) {
    blockers.push(issue(
      'adapter_operation_unsupported',
      'specification.operation',
      'La operación debe ser create_new o update_existing; no se aplicará un default implícito.',
    ));
    return { operation: null, existingCampaignId: null, ready: false };
  }
  if (operation === 'update_existing' && !campaignId) {
    blockers.push(issue(
      'adapter_existing_campaign_id_required',
      'specification.existing_campaign_id',
      'update_existing requiere un campaign ID Google numérico explícito.',
    ));
    return { operation, existingCampaignId: null, ready: false };
  }
  if (operation === 'create_new' && rawCampaignId) {
    blockers.push(issue(
      'adapter_existing_campaign_id_conflict',
      'specification.existing_campaign_id',
      'create_new no puede incluir un campaign ID existente.',
    ));
    return { operation, existingCampaignId: null, ready: false };
  }
  return { operation, existingCampaignId: campaignId, ready: true };
}

function normalizeSpecification(specification, family, blockers) {
  const operation = normalizeOperation(specification, blockers);
  const rawAccountId = text(specification.account_id, 128);
  const accountId = rawAccountId?.replace(/-/g, '') || null;
  if (!accountId || !/^\d{10}$/.test(accountId)) {
    blockers.push(issue('adapter_google_account_required', 'specification.account_id', 'El adaptador dry-run requiere un customer ID Google Ads de 10 dígitos.'));
  }

  const campaignName = strictText(specification.name, 255);
  if (!campaignName.value) {
    blockers.push(issue(
      campaignName.reason === 'length' ? 'adapter_campaign_name_too_long' : 'adapter_campaign_name_required',
      'specification.name',
      campaignName.reason === 'length'
        ? 'El nombre de campaña supera 255 caracteres.'
        : 'El adaptador dry-run requiere un nombre de campaña.',
    ));
  }

  const normalized = {
    ...specification,
    operation: operation.operation,
    existing_campaign_id: operation.existingCampaignId,
    account_id: /^\d{10}$/.test(accountId || '') ? accountId : null,
    name: campaignName.value,
  };

  if (family === 'google_search') {
    const creative = safeObject(specification.creative);
    const adGroup = safeObject(specification.ad_group);
    normalized.final_url = null;
    normalized.final_urls = normalizePublicUrlList([specification.final_url], {
      field: 'specification.final_url', code: 'adapter_search_final_url', label: 'URL final de Search', min: 1, max: 1,
    }, blockers);
    normalized.ad_group = {
      keywords: normalizeTextList(adGroup.keywords, {
        field: 'specification.ad_group.keywords', code: 'adapter_search_keywords', label: 'Keywords de Search', ...GOOGLE_LIMITS.search.keywords,
      }, blockers),
    };
    normalized.creative = {
      headlines: normalizeTextList(creative.headlines, {
        field: 'specification.creative.headlines', code: 'adapter_search_headlines', label: 'Titulares de Search', ...GOOGLE_LIMITS.search.headlines,
      }, blockers),
      descriptions: normalizeTextList(creative.descriptions, {
        field: 'specification.creative.descriptions', code: 'adapter_search_descriptions', label: 'Descripciones de Search', ...GOOGLE_LIMITS.search.descriptions,
      }, blockers),
    };
  }

  if (family === 'google_pmax') {
    const assets = safeObject(specification.asset_group);
    normalized.final_urls = normalizePublicUrlList(specification.final_urls, {
      field: 'specification.final_urls', code: 'adapter_pmax_final_urls', label: 'URLs finales de Performance Max', ...GOOGLE_LIMITS.pmax.final_urls,
    }, blockers);
    normalized.asset_group = {
      headlines: normalizeTextList(assets.headlines, {
        field: 'specification.asset_group.headlines', code: 'adapter_pmax_headlines', label: 'Titulares de Performance Max', ...GOOGLE_LIMITS.pmax.headlines,
      }, blockers),
      long_headlines: normalizeTextList(assets.long_headlines, {
        field: 'specification.asset_group.long_headlines', code: 'adapter_pmax_long_headlines', label: 'Titulares largos de Performance Max', ...GOOGLE_LIMITS.pmax.long_headlines,
      }, blockers),
      descriptions: normalizeTextList(assets.descriptions, {
        field: 'specification.asset_group.descriptions', code: 'adapter_pmax_descriptions', label: 'Descripciones de Performance Max', ...GOOGLE_LIMITS.pmax.descriptions,
      }, blockers),
      images: normalizeTextList(assets.images, {
        field: 'specification.asset_group.images', code: 'adapter_pmax_images', label: 'Referencias de imagen de Performance Max', ...GOOGLE_LIMITS.pmax.images,
      }, blockers),
      logos: normalizeTextList(assets.logos, {
        field: 'specification.asset_group.logos', code: 'adapter_pmax_logos', label: 'Referencias de logotipo de Performance Max', ...GOOGLE_LIMITS.pmax.logos,
      }, blockers),
    };
  }

  return { specification: normalized, operationReady: operation.ready };
}

function buildGoogleAdsDryRunAdapter({ family, specification } = {}) {
  const normalizedFamily = text(family, 64);
  const cleanSpecification = sanitize(safeObject(specification));
  const blockers = [];
  const warnings = [];

  if (!SUPPORTED_FAMILIES.includes(normalizedFamily)) {
    blockers.push(issue('adapter_family_unsupported', 'family', 'El adaptador Google dry-run solo admite Search y Performance Max.'));
  }
  const normalized = normalizeSpecification(cleanSpecification, normalizedFamily, blockers);
  const normalizedSpecification = normalized.specification;
  const budget = planningBudget(normalizedSpecification, blockers, warnings);
  const operations = !normalized.operationReady
    ? []
    : normalizedFamily === 'google_search'
      ? googleSearchOperations(normalizedSpecification, budget, warnings)
      : normalizedFamily === 'google_pmax'
        ? googlePmaxOperations(normalizedSpecification, budget, warnings)
        : [];

  const manifest = {
    schema_version: ADAPTER_SCHEMA_VERSION,
    adapter_version: ADAPTER_VERSION,
    provider: 'google_ads',
    family: normalizedFamily,
    mode: 'dry_run',
    dry_run_adapter_available: SUPPORTED_FAMILIES.includes(normalizedFamily),
    execution_adapter_available: false,
    provider_call_performed: false,
    network_calls_performed: 0,
    account_id: text(normalizedSpecification.account_id, 128),
    operation_mode: SUPPORTED_OPERATIONS.includes(normalizedSpecification.operation) ? normalizedSpecification.operation : null,
    budget,
    readiness: {
      ready: blockers.length === 0,
      blockers,
      warnings,
    },
    operations,
    safety: {
      initial_campaign_status: normalizedSpecification.operation === 'create_new' ? 'PAUSED' : null,
      existing_campaign_status_preserved: normalizedSpecification.operation === 'update_existing',
      destructive_replace: false,
      requires_future_explicit_execution_authorization: true,
    },
  };

  return {
    ...manifest,
    manifest_hash: sha256(canonicalStringify(manifest)),
  };
}

module.exports = {
  ADAPTER_SCHEMA_VERSION,
  ADAPTER_VERSION,
  MONTHLY_BUDGET_DAYS,
  SUPPORTED_FAMILIES,
  buildGoogleAdsDryRunAdapter,
  canonicalStringify,
  sanitize,
};

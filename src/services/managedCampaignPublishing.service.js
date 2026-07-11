'use strict';

const crypto = require('node:crypto');
const { publicHttpUrl } = require('../lib/safeHttpTarget');

const PLAN_SCHEMA_VERSION = 'managed-campaign-publishing-plan/v1';
const AUTHORIZATION_SCHEMA_VERSION = 'managed-campaign-publishing-authorization/v1';
const SUPPORTED_FAMILIES = Object.freeze({
  google_ads: Object.freeze(['google_search', 'google_pmax']),
  meta_ads: Object.freeze(['meta_reach', 'meta_instant_form']),
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

function httpUrl(value) {
  const candidate = text(value, 2048);
  return candidate ? publicHttpUrl(candidate) : null;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.round((parsed + Number.EPSILON) * 100) / 100
    : null;
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
  return /(^|_)(access_token|refresh_token|client_secret|api_key|private_key|password|passwd|authorization|cookie|session|hmac_key|credentials?|secret|token)($|_)/.test(normalized);
}

function sanitizeForPlan(value, depth = 0) {
  if (depth > 12 || value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 10000);
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

function stringArray(value) {
  const source = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return source.map((item) => text(item, 2048)).filter(Boolean);
}

function assetArray(config, paths) {
  return stringArray(valuesAt(config, paths));
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
      amount: positiveNumber(budget.amount),
      currency: text(budget.currency, 3)?.toUpperCase() || null,
      period: text(budget.period, 32),
    },
    targeting: sanitizeForPlan(safeObject(campaign.target_config)),
    audience: sanitizeForPlan(safeObject(campaign.audience_config)),
    schedule: sanitizeForPlan(safeObject(campaign.schedule_config)),
    destination: sanitizeForPlan(safeObject(campaign.destination_config)),
  };
}

function buildGoogleSearchSpec(campaign, refs, blockers) {
  const common = commonSpecification(campaign, 'google_ads', 'google_search', refs);
  const creative = safeObject(campaign.creative_config);
  const target = safeObject(campaign.target_config);
  const headlines = assetArray(creative, ['headlines', 'responsive_search_ad.headlines']);
  const descriptions = assetArray(creative, ['descriptions', 'responsive_search_ad.descriptions']);
  const keywords = assetArray(target, ['keywords', 'search_keywords']);
  const rawFinalUrl = valuesAt(common.destination, ['final_url', 'effective_url', 'landing_url', 'url']);
  const finalUrl = httpUrl(rawFinalUrl);

  if (!common.account_id) blockers.push(blocker('provider_account_required', 'platform_refs.customer_id', 'Falta una cuenta Google Ads asignada.'));
  else if (!/^\d{10}$/.test(common.account_id.replace(/-/g, ''))) blockers.push(blocker('provider_account_invalid', 'platform_refs.customer_id', 'La cuenta Google Ads debe ser un customer ID de 10 dígitos.'));
  if (!common.name) blockers.push(blocker('campaign_name_required', 'name', 'Falta el nombre de campaña.'));
  if (!common.budget.amount) blockers.push(blocker('positive_budget_required', 'budget_config.amount', 'El presupuesto debe ser mayor que cero.'));
  if (!finalUrl) blockers.push(blocker(rawFinalUrl ? 'final_url_invalid' : 'final_url_required', 'destination_config.final_url', 'Google Search requiere una URL final http(s) válida.'));
  requireCount(blockers, headlines, 3, 'search_headlines_required', 'creative_config.headlines', 'Google Search requiere al menos tres titulares proporcionados.');
  requireCount(blockers, descriptions, 2, 'search_descriptions_required', 'creative_config.descriptions', 'Google Search requiere al menos dos descripciones proporcionadas.');
  requireCount(blockers, keywords, 1, 'search_keywords_required', 'target_config.keywords', 'Google Search requiere keywords revisadas.');

  return {
    ...common,
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
  if (!common.budget.amount) blockers.push(blocker('positive_budget_required', 'budget_config.amount', 'El presupuesto debe ser mayor que cero.'));
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

function metaCreative(campaign) {
  const creative = safeObject(campaign.creative_config);
  return {
    primary_texts: assetArray(creative, ['primary_texts', 'primary_text', 'messages']),
    headlines: assetArray(creative, ['headlines', 'headline', 'titles']),
    descriptions: assetArray(creative, ['descriptions', 'description']),
    media: assetArray(creative, ['media', 'media_asset_ids', 'image_hashes', 'video_ids']),
    call_to_action: text(valuesAt(creative, ['call_to_action', 'cta_type']), 64),
  };
}

function buildMetaSpec(campaign, family, refs, blockers, warnings) {
  const common = commonSpecification(campaign, 'meta_ads', family, refs);
  const creative = metaCreative(campaign);
  const pageId = text(valuesAt(refs, ['page_id', 'meta_ads_page_id']), 128);
  const instantFormId = text(
    valuesAt(common.destination, ['instant_form_id', 'form_id'])
      || valuesAt(refs, ['instant_form_id', 'meta_ads_instant_form_id']),
    128
  );

  if (!common.account_id) blockers.push(blocker('provider_account_required', 'platform_refs.ad_account_id', 'Falta una cuenta publicitaria Meta asignada.'));
  else if (!/^(?:act_)?\d+$/.test(common.account_id)) blockers.push(blocker('provider_account_invalid', 'platform_refs.ad_account_id', 'La cuenta Meta debe ser un ID numérico, con prefijo act_ opcional.'));
  if (!pageId) blockers.push(blocker('meta_page_required', 'platform_refs.page_id', 'Meta requiere una página asignada como identidad.'));
  else if (!/^\d+$/.test(pageId)) blockers.push(blocker('meta_page_invalid', 'platform_refs.page_id', 'La página Meta debe usar un ID numérico.'));
  if (!common.name) blockers.push(blocker('campaign_name_required', 'name', 'Falta el nombre de campaña.'));
  if (!common.budget.amount) blockers.push(blocker('positive_budget_required', 'budget_config.amount', 'El presupuesto debe ser mayor que cero.'));
  requireCount(blockers, creative.primary_texts, 1, 'meta_primary_text_required', 'creative_config.primary_text', 'Meta requiere un texto principal proporcionado.');
  requireCount(blockers, creative.media, 1, 'meta_media_required', 'creative_config.media', 'Meta requiere una imagen o vídeo proporcionado.');
  if (!creative.call_to_action) blockers.push(blocker('meta_cta_required', 'creative_config.call_to_action', 'Meta requiere un CTA explícito.'));
  else if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(creative.call_to_action)) blockers.push(blocker('meta_cta_invalid', 'creative_config.call_to_action', 'El CTA Meta debe usar un valor canónico como LEARN_MORE.'));
  if (family === 'meta_instant_form' && !instantFormId) {
    blockers.push(blocker('meta_instant_form_required', 'destination_config.instant_form_id', 'La campaña de formulario requiere un formulario instantáneo existente.'));
  } else if (family === 'meta_instant_form' && !/^\d+$/.test(instantFormId)) {
    blockers.push(blocker('meta_instant_form_invalid', 'destination_config.instant_form_id', 'El formulario instantáneo debe usar un ID numérico.'));
  }
  const metaDestination = valuesAt(common.destination, ['url', 'final_url', 'effective_url']);
  if (family === 'meta_reach' && !metaDestination) {
    warnings.push(warning('meta_destination_optional', 'destination_config', 'No se ha indicado URL; el plan de alcance queda limitado al destino nativo configurado.'));
  } else if (family === 'meta_reach' && !httpUrl(metaDestination)) {
    blockers.push(blocker('meta_destination_invalid', 'destination_config.final_url', 'La URL de destino Meta debe usar http(s) y no incluir credenciales.'));
  }

  return {
    ...common,
    provider_objective: family === 'meta_instant_form' ? 'OUTCOME_LEADS' : 'OUTCOME_AWARENESS',
    identity: { page_id: pageId, instagram_actor_id: text(valuesAt(refs, ['instagram_actor_id', 'meta_ads_instagram_actor_id']), 128) },
    instant_form_id: family === 'meta_instant_form' ? instantFormId : null,
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

function buildManagedCampaignPublishingPlan({ campaign, gateEvidence = {} } = {}) {
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

  const evidence = Object.fromEntries(REQUIRED_GATE_EVIDENCE.map((key) => [key, gateEvidence?.[key] === true]));
  addOperationalBlockers(row, evidence, blockers);
  const sanitizedSpecification = sanitizeForPlan(specification);
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
    gate_evidence: evidence,
    readiness: {
      ready: blockers.length === 0,
      blockers,
      warnings,
    },
    execution: {
      adapter_available: false,
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

function evaluateManagedCampaignExecutionGates({ plan, confirmation = {} } = {}) {
  const failures = [];
  if (!plan || plan.schema_version !== PLAN_SCHEMA_VERSION || plan.mode !== 'dry_run') {
    failures.push(blocker('invalid_plan', 'plan', 'Se requiere un plan dry-run válido.'));
  }
  if (plan?.readiness?.ready !== true || (plan?.readiness?.blockers || []).length > 0) {
    failures.push(blocker('plan_not_ready', 'plan.readiness', 'El plan conserva blockers de publicación.'));
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
  sanitizeForPlan,
};

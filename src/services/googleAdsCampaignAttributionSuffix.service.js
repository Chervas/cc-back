'use strict';

const crypto = require('node:crypto');
const { googleAdsRequest, normalizeCustomerId } = require('../lib/googleAdsClient');
const {
  GOOGLE_ADS_SCOPE,
  resolveScopedGoogleAdsRuntime,
  runtimeError,
} = require('./googleAdsScopedRuntime.service');

const SCHEMA_VERSION = 'clinicaclick-google-ads-campaign-attribution/v1';
const CUSTOMER_PARAM = 'cc_gads_customer_id';
const CAMPAIGN_PARAM = 'cc_gads_campaign_id';
const CAMPAIGN_VALUE_TRACK = '{campaignid}';
const MAX_CAMPAIGNS_PER_ACCOUNT = 1_000;
const MAX_FINAL_URL_SUFFIX_LENGTH = 2_048;
const SUPPORTED_CHANNEL_TYPES = new Set(['SEARCH', 'PERFORMANCE_MAX', 'SMART']);
const MUTABLE_CAMPAIGN_STATUSES = new Set(['ENABLED', 'PAUSED']);

function cleanCampaignId(value) {
  const clean = String(value ?? '').trim();
  return /^\d+$/.test(clean) && !/^0+$/.test(clean) ? clean.replace(/^0+(?=\d)/, '') : '';
}

function cleanCustomerId(value) {
  const clean = normalizeCustomerId(value);
  return /^\d{10}$/.test(clean) ? clean : '';
}

function safeDecodeParameterName(value) {
  const normalized = String(value || '').replace(/^\?/, '').replace(/\+/g, ' ');
  try {
    return decodeURIComponent(normalized).trim().toLowerCase();
  } catch (_error) {
    return normalized.trim().toLowerCase();
  }
}

function suffixSegmentName(segment) {
  const value = String(segment ?? '');
  const equalsAt = value.indexOf('=');
  return safeDecodeParameterName(equalsAt >= 0 ? value.slice(0, equalsAt) : value);
}

function mergeClinicaclickAttributionSuffix(existingSuffix, customerId) {
  const normalizedCustomerId = cleanCustomerId(customerId);
  if (!normalizedCustomerId) {
    throw runtimeError('CUSTOMER_ID_REQUIRED', 'customer_id es obligatorio para preparar la atribución', 400);
  }

  const before = String(existingSuffix ?? '');
  const preserved = before
    ? before.split('&').filter((segment) => {
      const name = suffixSegmentName(segment);
      return name !== CUSTOMER_PARAM && name !== CAMPAIGN_PARAM;
    })
    : [];
  const after = [
    ...preserved,
    `${CUSTOMER_PARAM}=${normalizedCustomerId}`,
    `${CAMPAIGN_PARAM}=${CAMPAIGN_VALUE_TRACK}`,
  ].join('&');

  if (after.length > MAX_FINAL_URL_SUFFIX_LENGTH) {
    throw runtimeError(
      'FINAL_URL_SUFFIX_TOO_LONG',
      `El final URL suffix resultante supera ${MAX_FINAL_URL_SUFFIX_LENGTH} caracteres`,
      422,
    );
  }

  return {
    before,
    after,
    changed: before !== after,
    preserved_parameter_count: preserved.filter(Boolean).length,
    clinicaclick_parameters: {
      [CUSTOMER_PARAM]: normalizedCustomerId,
      [CAMPAIGN_PARAM]: CAMPAIGN_VALUE_TRACK,
    },
  };
}

function normalizeConfiguredAccounts(configuredAccounts) {
  if (!Array.isArray(configuredAccounts) || configuredAccounts.length === 0) {
    throw runtimeError('CONFIGURED_ACCOUNTS_REQUIRED', 'Debe indicarse al menos una cuenta configurada', 400);
  }

  const seenAccounts = new Set();
  return configuredAccounts.map((raw, accountIndex) => {
    const customerId = cleanCustomerId(raw?.customer_id ?? raw?.customerId);
    if (!customerId) {
      throw runtimeError(
        'CONFIGURED_CUSTOMER_ID_INVALID',
        `La cuenta configurada ${accountIndex + 1} no tiene un customer_id válido`,
        400,
      );
    }
    if (seenAccounts.has(customerId)) {
      throw runtimeError(
        'CONFIGURED_CUSTOMER_DUPLICATE',
        `La cuenta ${customerId} aparece más de una vez en el lote`,
        400,
      );
    }
    seenAccounts.add(customerId);

    const sourceCampaignIds = raw?.campaign_ids ?? raw?.campaignIds;
    if (!Array.isArray(sourceCampaignIds) || sourceCampaignIds.length === 0) {
      throw runtimeError(
        'CONFIGURED_CAMPAIGNS_REQUIRED',
        `La cuenta ${customerId} no tiene campañas configuradas`,
        400,
      );
    }
    const campaignIds = [];
    const seenCampaigns = new Set();
    for (const rawCampaignId of sourceCampaignIds) {
      const campaignId = cleanCampaignId(rawCampaignId);
      if (!campaignId) {
        throw runtimeError(
          'CONFIGURED_CAMPAIGN_ID_INVALID',
          `La cuenta ${customerId} contiene un campaign_id inválido`,
          400,
        );
      }
      if (seenCampaigns.has(campaignId)) continue;
      seenCampaigns.add(campaignId);
      campaignIds.push(campaignId);
    }
    if (campaignIds.length > MAX_CAMPAIGNS_PER_ACCOUNT) {
      throw runtimeError(
        'CONFIGURED_CAMPAIGN_LIMIT_EXCEEDED',
        `La cuenta ${customerId} supera el máximo de ${MAX_CAMPAIGNS_PER_ACCOUNT} campañas por lote`,
        400,
      );
    }

    return { customer_id: customerId, campaign_ids: campaignIds };
  });
}

function campaignFromGoogleRow(row) {
  const campaign = row?.campaign && typeof row.campaign === 'object' ? row.campaign : {};
  const id = cleanCampaignId(campaign.id);
  return {
    campaign_id: id,
    resource_name: String(campaign.resourceName ?? campaign.resource_name ?? '').trim(),
    name: String(campaign.name ?? '').trim() || null,
    status: String(campaign.status ?? '').trim().toUpperCase() || null,
    channel_type: String(
      campaign.advertisingChannelType ?? campaign.advertising_channel_type ?? '',
    ).trim().toUpperCase() || null,
    final_url_suffix: String(campaign.finalUrlSuffix ?? campaign.final_url_suffix ?? ''),
  };
}

async function fetchCampaignAttributionState({
  accessToken,
  loginCustomerId,
  customerId,
  campaignIds,
  request = googleAdsRequest,
}) {
  const normalizedCustomerId = cleanCustomerId(customerId);
  const cleanCampaignIds = Array.from(new Set((campaignIds || []).map(cleanCampaignId).filter(Boolean)));
  if (!accessToken || !normalizedCustomerId || cleanCampaignIds.length === 0) {
    throw runtimeError('CAMPAIGN_LOOKUP_INPUT_INVALID', 'Faltan datos para consultar las campañas', 400);
  }

  const query = [
    'SELECT',
    '  campaign.id,',
    '  campaign.resource_name,',
    '  campaign.name,',
    '  campaign.status,',
    '  campaign.advertising_channel_type,',
    '  campaign.final_url_suffix',
    'FROM campaign',
    `WHERE campaign.id IN (${cleanCampaignIds.join(', ')})`,
  ].join('\n');
  const response = await request('POST', `customers/${normalizedCustomerId}/googleAds:search`, {
    accessToken,
    loginCustomerId: loginCustomerId || undefined,
    data: { query, pageSize: MAX_CAMPAIGNS_PER_ACCOUNT },
    singleAttempt: true,
  });
  return (Array.isArray(response?.results) ? response.results : [])
    .map(campaignFromGoogleRow)
    .filter((campaign) => campaign.campaign_id);
}

function buildCampaignAttributionPlan({ customerId, campaignIds, providerCampaigns }) {
  const normalizedCustomerId = cleanCustomerId(customerId);
  if (!normalizedCustomerId) {
    throw runtimeError('CUSTOMER_ID_INVALID', 'customer_id debe contener exactamente 10 dígitos', 400);
  }
  const requestedIds = Array.from(new Set((campaignIds || []).map(cleanCampaignId).filter(Boolean)));
  const providerById = new Map();
  const blockers = [];

  for (const campaign of Array.isArray(providerCampaigns) ? providerCampaigns : []) {
    const campaignId = cleanCampaignId(campaign?.campaign_id);
    if (!campaignId || providerById.has(campaignId)) {
      blockers.push({
        code: 'CAMPAIGN_PROVIDER_RESPONSE_AMBIGUOUS',
        campaign_id: campaignId || null,
        message: 'Google devolvió una campaña sin identidad única.',
      });
      continue;
    }
    if (!requestedIds.includes(campaignId)) {
      blockers.push({
        code: 'CAMPAIGN_PROVIDER_RESPONSE_UNEXPECTED',
        campaign_id: campaignId,
        message: 'Google devolvió una campaña que no formaba parte de la consulta.',
      });
      continue;
    }
    providerById.set(campaignId, campaign);
  }

  const campaigns = requestedIds.map((campaignId) => {
    const provider = providerById.get(campaignId);
    if (!provider) {
      const blocker = {
        code: 'CONFIGURED_CAMPAIGN_NOT_FOUND',
        campaign_id: campaignId,
        message: 'La campaña configurada no existe o no es visible en esta cuenta.',
      };
      blockers.push(blocker);
      return { campaign_id: campaignId, outcome: 'blocked', blockers: [blocker] };
    }

    const expectedResourceName = `customers/${normalizedCustomerId}/campaigns/${campaignId}`;
    const itemBlockers = [];
    if (provider.resource_name !== expectedResourceName) {
      itemBlockers.push({
        code: 'CAMPAIGN_ACCOUNT_MISMATCH',
        campaign_id: campaignId,
        message: 'El resource_name de la campaña no pertenece a la cuenta configurada.',
      });
    }
    if (!SUPPORTED_CHANNEL_TYPES.has(provider.channel_type)) {
      itemBlockers.push({
        code: 'CAMPAIGN_CHANNEL_UNSUPPORTED',
        campaign_id: campaignId,
        message: `El tipo ${provider.channel_type || 'desconocido'} no está autorizado para esta operación.`,
      });
    }
    if (!MUTABLE_CAMPAIGN_STATUSES.has(provider.status)) {
      itemBlockers.push({
        code: provider.status === 'REMOVED' ? 'CAMPAIGN_REMOVED' : 'CAMPAIGN_STATUS_UNSUPPORTED',
        campaign_id: campaignId,
        message: provider.status === 'REMOVED'
          ? 'No se modifica una campaña eliminada.'
          : `No se modifica una campaña con estado ${provider.status || 'desconocido'}.`,
      });
    }

    let suffix = null;
    if (!itemBlockers.length) {
      try {
        suffix = mergeClinicaclickAttributionSuffix(provider.final_url_suffix, normalizedCustomerId);
      } catch (error) {
        itemBlockers.push({
          code: error.code || 'FINAL_URL_SUFFIX_INVALID',
          campaign_id: campaignId,
          message: error.message,
        });
      }
    }
    blockers.push(...itemBlockers);

    return {
      campaign_id: campaignId,
      resource_name: expectedResourceName,
      name: provider.name,
      status: provider.status,
      channel_type: provider.channel_type,
      compatibility: {
        campaign_final_url_suffix: SUPPORTED_CHANNEL_TYPES.has(provider.channel_type),
        provider_validation_required: true,
        more_specific_url_options_may_override: true,
      },
      before_suffix: provider.final_url_suffix,
      after_suffix: suffix?.after ?? null,
      preserved_parameter_count: suffix?.preserved_parameter_count ?? 0,
      changed: suffix?.changed === true,
      outcome: itemBlockers.length ? 'blocked' : (suffix?.changed ? 'update_ready' : 'unchanged'),
      blockers: itemBlockers,
    };
  });

  const candidateOperations = campaigns
    .filter((campaign) => campaign.outcome === 'update_ready')
    .map((campaign) => ({
      updateMask: 'final_url_suffix',
      update: {
        resourceName: campaign.resource_name,
        finalUrlSuffix: campaign.after_suffix,
      },
    }));
  // Si cualquier campaña configurada es ambigua o incompatible, la cuenta
  // completa queda sin operaciones. Así el plan también es fail-closed aunque
  // un integrador omita por error comprobar `blocked`.
  const operations = blockers.length ? [] : candidateOperations;
  const digestInput = candidateOperations.map((operation) => ({
    resource_name: operation.update.resourceName,
    final_url_suffix: operation.update.finalUrlSuffix,
  }));

  return {
    customer_id: normalizedCustomerId,
    requested_campaign_count: requestedIds.length,
    campaign_count: campaigns.length,
    changed_campaign_count: candidateOperations.length,
    unchanged_campaign_count: campaigns.filter((campaign) => campaign.outcome === 'unchanged').length,
    blocked: blockers.length > 0,
    blockers,
    campaigns,
    operations,
    plan_digest: crypto.createHash('sha256').update(JSON.stringify(digestInput)).digest('hex'),
  };
}

function sameCampaignState(plan, currentRows) {
  const currentById = new Map((currentRows || []).map((campaign) => [campaign.campaign_id, campaign]));
  return plan.campaigns.every((campaign) => {
    const current = currentById.get(campaign.campaign_id);
    return current
      && current.resource_name === campaign.resource_name
      && current.channel_type === campaign.channel_type
      && current.status === campaign.status
      && current.final_url_suffix === campaign.before_suffix;
  });
}

function googleProviderError(error) {
  const responseError = error?.response?.data?.error;
  return {
    code: error?.code || responseError?.status || 'GOOGLE_ADS_REQUEST_FAILED',
    http_status: Number(error?.response?.status) || Number(error?.httpStatus) || null,
    message: String(responseError?.message || error?.message || 'Google Ads rechazó la operación').slice(0, 1_000),
    request_id: String(
      error?.response?.headers?.['request-id']
      || error?.response?.headers?.['request_id']
      || '',
    ).trim() || null,
    details: Array.isArray(responseError?.details)
      ? responseError.details.slice(0, 20).map((detail) => ({
          type: detail?.['@type'] || null,
          errors: Array.isArray(detail?.errors)
            ? detail.errors.slice(0, 20).map((item) => ({
                message: String(item?.message || '').slice(0, 500) || null,
                error_code: item?.errorCode || item?.error_code || null,
                location: item?.location || null,
              }))
            : undefined,
        }))
      : [],
  };
}

async function sendCampaignMutations({
  runtime,
  operations,
  validateOnly,
  request = googleAdsRequest,
}) {
  const customerId = cleanCustomerId(runtime?.customerId);
  if (!customerId || !runtime?.accessToken) {
    throw runtimeError('MUTATION_RUNTIME_INVALID', 'El runtime de mutación no contiene una cuenta y token válidos', 403);
  }
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > MAX_CAMPAIGNS_PER_ACCOUNT) {
    throw runtimeError('MUTATION_OPERATIONS_INVALID', 'El lote de operaciones de campaña no es válido', 400);
  }
  const expectedCustomerParam = `${CUSTOMER_PARAM}=${customerId}`;
  const expectedCampaignParam = `${CAMPAIGN_PARAM}=${CAMPAIGN_VALUE_TRACK}`;
  const resourceNames = new Set();
  const unsafeOperation = operations.find((operation) => (
    operation?.updateMask !== 'final_url_suffix'
    || !new RegExp(`^customers/${customerId}/campaigns/\\d+$`).test(String(operation?.update?.resourceName || ''))
    || resourceNames.has(String(operation?.update?.resourceName || ''))
    || !resourceNames.add(String(operation?.update?.resourceName || ''))
    || !String(operation?.update?.finalUrlSuffix || '').split('&').includes(expectedCustomerParam)
    || !String(operation?.update?.finalUrlSuffix || '').split('&').includes(expectedCampaignParam)
  ));
  if (unsafeOperation) {
    throw runtimeError(
      'MUTATION_ACCOUNT_OR_SUFFIX_MISMATCH',
      'El lote contiene una campaña de otra cuenta o un suffix no canónico',
      403,
    );
  }

  return request('POST', `customers/${customerId}/campaigns:mutate`, {
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId || undefined,
    data: {
      operations,
      partialFailure: false,
      validateOnly: validateOnly === true,
      responseContentType: 'MUTABLE_RESOURCE',
    },
    singleAttempt: true,
  });
}

async function processConfiguredAccount({
  account,
  scope,
  apply,
  validateOnly,
  resolveRuntime,
  request,
  now,
}) {
  const startedAt = now().toISOString();
  let runtime;
  try {
    runtime = await resolveRuntime({
      userId: scope?.user_id ?? scope?.userId ?? null,
      clinicId: scope?.clinic_id ?? scope?.clinicId ?? null,
      groupId: scope?.group_id ?? scope?.groupId ?? null,
      assignmentScope: scope?.assignment_scope ?? scope?.assignmentScope ?? null,
      customerId: account.customer_id,
      requiredScopes: [GOOGLE_ADS_SCOPE],
    });
    if (normalizeCustomerId(runtime?.customerId) !== account.customer_id) {
      throw runtimeError(
        'RUNTIME_ACCOUNT_MISMATCH',
        'El runtime resuelto no pertenece a la cuenta configurada',
        403,
      );
    }

    const providerCampaigns = await fetchCampaignAttributionState({
      accessToken: runtime.accessToken,
      loginCustomerId: runtime.loginCustomerId,
      customerId: account.customer_id,
      campaignIds: account.campaign_ids,
      request,
    });
    const plan = buildCampaignAttributionPlan({
      customerId: account.customer_id,
      campaignIds: account.campaign_ids,
      providerCampaigns,
    });
    const result = {
      customer_id: account.customer_id,
      fail_closed: true,
      started_at: startedAt,
      plan: {
        requested_campaign_count: plan.requested_campaign_count,
        changed_campaign_count: plan.changed_campaign_count,
        unchanged_campaign_count: plan.unchanged_campaign_count,
        plan_digest: plan.plan_digest,
        blockers: plan.blockers,
        campaigns: plan.campaigns,
      },
      validation: { requested: validateOnly || apply, completed: false },
      mutation: { requested: apply, completed: false },
    };

    if (plan.blocked) {
      return { ...result, outcome: 'blocked', finished_at: now().toISOString() };
    }
    if (plan.operations.length === 0) {
      return { ...result, outcome: 'unchanged', finished_at: now().toISOString() };
    }
    if (!validateOnly && !apply) {
      return { ...result, outcome: 'ready', finished_at: now().toISOString() };
    }

    await sendCampaignMutations({ runtime, operations: plan.operations, validateOnly: true, request });
    result.validation = { requested: true, completed: true, operation_count: plan.operations.length };
    if (validateOnly) {
      return { ...result, outcome: 'validated', finished_at: now().toISOString() };
    }

    const currentRows = await fetchCampaignAttributionState({
      accessToken: runtime.accessToken,
      loginCustomerId: runtime.loginCustomerId,
      customerId: account.customer_id,
      campaignIds: account.campaign_ids,
      request,
    });
    if (!sameCampaignState(plan, currentRows)) {
      return {
        ...result,
        outcome: 'blocked',
        blockers: [{
          code: 'CAMPAIGN_STATE_CHANGED',
          message: 'La configuración de una campaña cambió después de validarla; no se aplicó el lote.',
        }],
        finished_at: now().toISOString(),
      };
    }

    const mutationResponse = await sendCampaignMutations({
      runtime,
      operations: plan.operations,
      validateOnly: false,
      request,
    });
    result.mutation = {
      requested: true,
      completed: true,
      operation_count: plan.operations.length,
      result_count: Array.isArray(mutationResponse?.results) ? mutationResponse.results.length : 0,
    };

    const verifiedRows = await fetchCampaignAttributionState({
      accessToken: runtime.accessToken,
      loginCustomerId: runtime.loginCustomerId,
      customerId: account.customer_id,
      campaignIds: account.campaign_ids,
      request,
    });
    const verifiedById = new Map(verifiedRows.map((campaign) => [campaign.campaign_id, campaign]));
    const verification = plan.campaigns.map((campaign) => ({
      campaign_id: campaign.campaign_id,
      expected_suffix: campaign.after_suffix,
      observed_suffix: verifiedById.get(campaign.campaign_id)?.final_url_suffix ?? null,
      verified: verifiedById.get(campaign.campaign_id)?.final_url_suffix === campaign.after_suffix,
    }));
    const verificationComplete = verification.every((campaign) => campaign.verified);
    return {
      ...result,
      outcome: verificationComplete ? 'applied' : 'applied_unverified',
      verification,
      finished_at: now().toISOString(),
    };
  } catch (error) {
    return {
      customer_id: account.customer_id,
      fail_closed: true,
      outcome: 'failed',
      started_at: startedAt,
      finished_at: now().toISOString(),
      validation: { requested: validateOnly || apply, completed: false },
      mutation: { requested: apply, completed: false },
      error: googleProviderError(error),
    };
  }
}

function summarizeAccountResults(accounts) {
  const campaigns = accounts.flatMap((account) => account.plan?.campaigns || []);
  return {
    account_count: accounts.length,
    ready_account_count: accounts.filter((item) => item.outcome === 'ready').length,
    validated_account_count: accounts.filter((item) => item.outcome === 'validated').length,
    applied_account_count: accounts.filter((item) => item.outcome === 'applied').length,
    unchanged_account_count: accounts.filter((item) => item.outcome === 'unchanged').length,
    blocked_or_failed_account_count: accounts.filter((item) => (
      ['blocked', 'failed', 'applied_unverified'].includes(item.outcome)
    )).length,
    campaign_count: campaigns.length,
    changed_campaign_count: campaigns.filter((item) => item.changed).length,
    verified_campaign_count: accounts.flatMap((item) => item.verification || [])
      .filter((item) => item.verified).length,
  };
}

/**
 * Configura únicamente las campañas declaradas en `configuredAccounts`.
 *
 * - Sin flags: consulta y devuelve el plan, sin endpoint mutate.
 * - `validateOnly: true`: envía exactamente el plan a Google con validateOnly.
 * - `apply: true`: valida, comprueba que no haya drift, aplica y relee.
 *
 * Cada cuenta resuelve su propio runtime OAuth/mapping; una cuenta bloqueada no
 * genera operaciones y no impide auditar o validar de forma aislada las demás.
 */
async function configureGoogleAdsCampaignAttribution({
  scope,
  configuredAccounts,
  apply = false,
  validateOnly = false,
  dependencies = {},
} = {}) {
  if (apply !== true && apply !== false) {
    throw runtimeError('APPLY_FLAG_INVALID', 'apply debe ser booleano', 400);
  }
  if (validateOnly !== true && validateOnly !== false) {
    throw runtimeError('VALIDATE_ONLY_FLAG_INVALID', 'validateOnly debe ser booleano', 400);
  }
  if (apply && validateOnly) {
    throw runtimeError(
      'ATTRIBUTION_MODE_CONFLICT',
      'apply y validateOnly no pueden ser true en la misma ejecución',
      400,
    );
  }

  const accounts = normalizeConfiguredAccounts(configuredAccounts);
  const resolveRuntime = dependencies.resolveRuntime || resolveScopedGoogleAdsRuntime;
  const request = dependencies.request || googleAdsRequest;
  const now = dependencies.now || (() => new Date());
  const startedAt = now().toISOString();
  const results = [];
  // Deliberadamente secuencial: cada cuenta se resuelve y se valida de forma
  // independiente para impedir mezclar credenciales, login customer u operaciones.
  for (const account of accounts) {
    results.push(await processConfiguredAccount({
      account,
      scope,
      apply,
      validateOnly,
      resolveRuntime,
      request,
      now,
    }));
  }

  return {
    schema_version: SCHEMA_VERSION,
    mode: apply ? 'apply' : (validateOnly ? 'validate_only' : 'preview'),
    fail_closed_per_account: true,
    started_at: startedAt,
    finished_at: now().toISOString(),
    summary: summarizeAccountResults(results),
    accounts: results,
  };
}

module.exports = {
  CAMPAIGN_PARAM,
  CAMPAIGN_VALUE_TRACK,
  CUSTOMER_PARAM,
  MAX_CAMPAIGNS_PER_ACCOUNT,
  SCHEMA_VERSION,
  SUPPORTED_CHANNEL_TYPES,
  buildCampaignAttributionPlan,
  campaignFromGoogleRow,
  configureGoogleAdsCampaignAttribution,
  fetchCampaignAttributionState,
  mergeClinicaclickAttributionSuffix,
  normalizeConfiguredAccounts,
  sameCampaignState,
  sendCampaignMutations,
};

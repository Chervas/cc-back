'use strict';

// Contrato oficial de objetivos por campaña y custom goals:
// https://developers.google.com/google-ads/api/docs/conversions/goals/campaign-goals
// AD_CALL es el tipo oficial para llamadas originadas al pulsar un anuncio:
// https://developers.google.com/google-ads/api/reference/rpc/v21/ConversionActionTypeEnum.ConversionActionType
// Los tres mutates usados abajo admiten validate_only en Google Ads API v21.

const db = require('../../models');
const { cleanCustomerId, cleanPositiveId, cleanString, objectValue, sortedUniqueIds, stableValue, stableStringify, sha256, cohortKey, stageGoalName, goalResourcePattern, actionResourceName, campaignResourceName, campaignConfigResourceName, campaignConversionGoalResourceName, normalizeOwnedGoalResource, normalizeCanonicalActionIds, normalizeSupplementalActionIds, normalizeBiddingSelection, normalizeConfiguredAccounts, providerObject, conversionActionFromRow, customGoalFromRow, campaignConfigFromRow, campaignGoalFromRow, customerGoalFromRow, conversionTrackingFromRows, blocker, canonicalActionState, supplementalActionState, ownedGoalState, isSmartCampaign, configuredCampaignState, campaignConversionGoalState, buildClinicaclickGoalPolicyPlan, assertSafePlanOperations, SCHEMA_VERSION, GOAL_NAME, GOAL_NAME_PREFIX, STRATEGY_KEY, OBSERVATION_ACTION_KEYS, BIDDING_SIGNAL_KEYS, ALL_CANONICAL_KEYS, DESIRED_ACTION_KEYS, CANONICAL_ACTIONS, STAGE_LABELS, CANONICAL_BY_NAME, MAX_CAMPAIGNS_PER_ACCOUNT, MAX_SUPPLEMENTAL_ACTIONS_PER_ACCOUNT, MAX_DIAGNOSTIC_ROWS, DEFAULT_DIAGNOSTIC_FRESHNESS_HOURS, NEW_GOAL_PLACEHOLDER } = require('../../services/integrations-broker/src/google-goal-policy-plan');
const googleLegacyCredentials = require('./googleLegacyCredentials.service');
const { safe: safeBrokerReadError } = require('./googleAdsBrokerReader.service');
const { googleAdsRequest } = require('../lib/googleAdsClient');
const notificationsService = require('./notifications.service');
const {
  auditConnectOnlyMeasurementTarget,
} = require('../controllers/campaignOnboarding.controller');
const {
  GOOGLE_ADS_SCOPE,
  resolveScopedGoogleAdsRuntime,
  runtimeError,
} = require('./googleAdsScopedRuntime.service');
const {
  extractGoogleCampaignReferences,
  sanitizeCampaignQualityReport,
} = require('./googleAdsConnectOnlyQualityAudit.service');

async function searchGoogleAds({ runtime, query, request = googleAdsRequest, credentials = googleLegacyCredentials }) {
  await credentials.assert(runtime.connection);
  let response;
  try {
    response = await request('POST', `customers/${runtime.customerId}/googleAds:search`, {
      accessToken: runtime.accessToken,
      loginCustomerId: runtime.loginCustomerId || undefined,
      singleAttempt: true,
      timeoutMs: 20_000,
      data: { query },
    });
  } catch (error) { await credentials.assert(runtime.connection); throw error; }
  await credentials.assert(runtime.connection);
  return Array.isArray(response?.results) ? response.results : [];
}

async function fetchGoalPolicySnapshot({ runtime, account, request = googleAdsRequest, credentials = googleLegacyCredentials }) {
  const campaignFilter = account.campaign_ids.join(', ');
  const deadline = Date.now() + 120000; let brokerRows = 0, brokerBytes = 0;
  async function managed(section) {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Object.assign(Error('broker_timeout'), { code: 'broker_timeout' });
      const rows = await runtime.broker.read(runtime.account, runtime.brokerContext, 'goal_policy',
        { section, campaignIds: account.campaign_ids }, { timeoutMs: Math.min(20000, remaining) });
      if (!Array.isArray(rows) || section === 'tracking' && rows.length !== 1 || Date.now() >= deadline)
        throw Object.assign(Error('broker_response_invalid'), { code: 'broker_response_invalid' });
      brokerRows += rows.length; brokerBytes += Buffer.byteLength(JSON.stringify(rows));
      if (brokerRows > 25001 || brokerBytes > 33554432) throw Object.assign(Error('broker_response_invalid'), { code: 'broker_response_invalid' });
      return rows;
    } catch (error) { const code = safeBrokerReadError(error); throw Object.assign(Error(code), { code }); }
  }
  const trackingRows = runtime.deliveryMode === 'broker' ? await managed('tracking') : await searchGoogleAds({
    runtime,
    request,
    credentials,
    query: [
      'SELECT',
      '  customer.id,',
      '  customer.conversion_tracking_setting.google_ads_conversion_customer,',
      '  customer.conversion_tracking_setting.conversion_tracking_status',
      'FROM customer',
    ].join('\n'),
  });
  const conversionActionRows = runtime.deliveryMode === 'broker' ? await managed('actions') : await searchGoogleAds({
    runtime,
    request,
    credentials,
    query: [
      'SELECT',
      '  conversion_action.id,',
      '  conversion_action.resource_name,',
      '  conversion_action.owner_customer,',
      '  conversion_action.name,',
      '  conversion_action.type,',
      '  conversion_action.status,',
      '  conversion_action.counting_type,',
      '  conversion_action.primary_for_goal,',
      '  conversion_action.category,',
      '  conversion_action.origin',
      'FROM conversion_action',
    ].join('\n'),
  });
  const customGoalRows = runtime.deliveryMode === 'broker' ? await managed('custom_goals') : await searchGoogleAds({
    runtime,
    request,
    credentials,
    query: [
      'SELECT',
      '  custom_conversion_goal.id,',
      '  custom_conversion_goal.resource_name,',
      '  custom_conversion_goal.name,',
      '  custom_conversion_goal.status,',
      '  custom_conversion_goal.conversion_actions',
      'FROM custom_conversion_goal',
    ].join('\n'),
  });
  const campaignConfigRows = runtime.deliveryMode === 'broker' ? await managed('campaign_configs') : await searchGoogleAds({
    runtime,
    request,
    credentials,
    query: [
      'SELECT',
      '  conversion_goal_campaign_config.resource_name,',
      '  conversion_goal_campaign_config.campaign,',
      '  conversion_goal_campaign_config.custom_conversion_goal,',
      '  conversion_goal_campaign_config.goal_config_level,',
      '  campaign.id,',
      '  campaign.name,',
      '  campaign.status,',
      '  campaign.advertising_channel_type,',
      '  campaign.advertising_channel_sub_type,',
      '  custom_conversion_goal.name,',
      '  custom_conversion_goal.status',
      'FROM conversion_goal_campaign_config',
      "WHERE campaign.status != 'REMOVED'",
    ].join('\n'),
  });
  const campaignGoalRows = runtime.deliveryMode === 'broker' ? await managed('campaign_goals') : await searchGoogleAds({
    runtime,
    request,
    credentials,
    query: [
      'SELECT',
      '  campaign_conversion_goal.resource_name,',
      '  campaign_conversion_goal.campaign,',
      '  campaign_conversion_goal.category,',
      '  campaign_conversion_goal.origin,',
      '  campaign_conversion_goal.biddable,',
      '  campaign.id,',
      '  campaign.name',
      'FROM campaign_conversion_goal',
      `WHERE campaign.id IN (${campaignFilter})`,
    ].join('\n'),
  });
  const customerGoalRows = runtime.deliveryMode === 'broker' ? await managed('customer_goals') : await searchGoogleAds({
    runtime,
    request,
    credentials,
    query: [
      'SELECT',
      '  customer_conversion_goal.resource_name,',
      '  customer_conversion_goal.category,',
      '  customer_conversion_goal.origin,',
      '  customer_conversion_goal.biddable',
      'FROM customer_conversion_goal',
    ].join('\n'),
  });

  return {
    conversion_tracking: conversionTrackingFromRows(trackingRows, account.customer_id),
    conversion_actions: conversionActionRows.map(conversionActionFromRow).filter((item) => item.id)
      .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })),
    custom_goals: customGoalRows.map(customGoalFromRow).filter((item) => item.resource_name)
      .sort((a, b) => a.resource_name.localeCompare(b.resource_name)),
    campaign_configs: campaignConfigRows.map(campaignConfigFromRow).filter((item) => item.campaign_id)
      .sort((a, b) => a.campaign_id.localeCompare(b.campaign_id, 'en', { numeric: true })),
    campaign_conversion_goals: campaignGoalRows.map(campaignGoalFromRow).filter((item) => item.campaign_id)
      .sort((a, b) => `${a.campaign_id}:${a.category}:${a.origin}`.localeCompare(`${b.campaign_id}:${b.category}:${b.origin}`)),
    customer_conversion_goals: customerGoalRows.map(customerGoalFromRow)
      .sort((a, b) => `${a.category}:${a.origin}`.localeCompare(`${b.category}:${b.origin}`)),
  };
}

function sanitizedProviderError(error) {
  const provider = error?.response?.data?.error || {};
  return {
    code: cleanString(error?.code || provider.status || provider.code) || 'GOOGLE_ADS_REQUEST_FAILED',
    http_status: Number(error?.response?.status || error?.httpStatus) || null,
    message: String(provider.message || error?.message || 'Google Ads rechazó la operación').slice(0, 1_000),
    request_id: cleanString(error?.response?.headers?.['request-id']),
  };
}

async function previewAccount({ account, scope, dependencies }) {
  const resolveRuntime = dependencies.resolveRuntime || resolveScopedGoogleAdsRuntime;
  const fetchSnapshot = dependencies.fetchSnapshot || fetchGoalPolicySnapshot;
  const request = dependencies.request || googleAdsRequest;
  try {
    const runtime = await resolveRuntime({
      userId: scope?.user_id ?? scope?.userId ?? null,
      clinicId: scope?.clinic_id ?? scope?.clinicId ?? null,
      groupId: scope?.group_id ?? scope?.groupId ?? null,
      assignmentScope: scope?.assignment_scope ?? scope?.assignmentScope ?? null,
      customerId: account.customer_id,
      requiredScopes: [GOOGLE_ADS_SCOPE],
    });
    if (cleanCustomerId(runtime?.customerId) !== account.customer_id) {
      throw runtimeError('GOAL_POLICY_RUNTIME_ACCOUNT_MISMATCH', 'El runtime pertenece a otra cuenta', 403);
    }
    const snapshot = await fetchSnapshot({ runtime, account, request, credentials: dependencies.credentials || googleLegacyCredentials });
    const plan = buildClinicaclickGoalPolicyPlan({ account, snapshot });
    return {
      customer_id: account.customer_id,
      outcome: plan.ready ? (plan.changed ? 'ready' : 'unchanged') : 'blocked',
      fail_closed: true,
      conversion_tracking: snapshot.conversion_tracking,
      plan,
    };
  } catch (error) {
    return {
      customer_id: account.customer_id,
      outcome: 'failed',
      fail_closed: true,
      error: sanitizedProviderError(error),
    };
  }
}

async function previewClinicaclickGoalPolicy({
  scope,
  configuredAccounts,
  dependencies = {},
} = {}) {
  const accounts = normalizeConfiguredAccounts(configuredAccounts);
  const now = dependencies.now || (() => new Date());
  const observedAt = now().toISOString();
  const results = [];
  for (const account of accounts) {
    results.push(await previewAccount({ account, scope, dependencies }));
  }
  const digestInput = results.map((result) => ({
    customer_id: result.customer_id,
    outcome: result.outcome,
    plan_digest: result.plan?.plan_digest || null,
    error_code: result.error?.code || null,
  }));
  return {
    schema_version: SCHEMA_VERSION,
    mode: 'preview_read_only',
    observed_at: observedAt,
    external_mutation_count: 0,
    digest: sha256(stableStringify(digestInput)),
    ready: results.every((result) => ['ready', 'unchanged'].includes(result.outcome)),
    accounts: results,
  };
}

async function mutateCustomGoal({ runtime, operation, validateOnly, request }) {
  if (!operation) return null;
  return request('POST', `customers/${runtime.customerId}/customConversionGoals:mutate`, {
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId || undefined,
    singleAttempt: true,
    timeoutMs: 20_000,
    data: {
      operations: [operation],
      validateOnly: validateOnly === true,
      responseContentType: 'MUTABLE_RESOURCE',
    },
  });
}

async function mutateCampaignGoalConfigs({ runtime, operations, validateOnly, request }) {
  if (!Array.isArray(operations) || !operations.length) return null;
  return request('POST', `customers/${runtime.customerId}/conversionGoalCampaignConfigs:mutate`, {
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId || undefined,
    singleAttempt: true,
    timeoutMs: 20_000,
    data: {
      operations,
      validateOnly: validateOnly === true,
      responseContentType: 'MUTABLE_RESOURCE',
    },
  });
}

async function mutateCampaignConversionGoals({ runtime, operations, validateOnly, request }) {
  if (!Array.isArray(operations) || !operations.length) return null;
  return request('POST', `customers/${runtime.customerId}/campaignConversionGoals:mutate`, {
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId || undefined,
    singleAttempt: true,
    timeoutMs: 20_000,
    data: {
      operations,
      validateOnly: validateOnly === true,
    },
  });
}

function createdGoalResource(response, customerId) {
  const first = Array.isArray(response?.results) ? response.results[0] : null;
  const nested = first?.customConversionGoal || first?.custom_conversion_goal || {};
  const resourceName = cleanString(first?.resourceName ?? first?.resource_name ?? nested.resourceName ?? nested.resource_name);
  return resourceName && goalResourcePattern(customerId).test(resourceName) ? resourceName : null;
}

function replaceGoalPlaceholder(operations, resourceName) {
  return (operations || []).map((operation) => ({
    ...operation,
    update: {
      ...operation.update,
      customConversionGoal: operation.update.customConversionGoal === NEW_GOAL_PLACEHOLDER
        ? resourceName
        : operation.update.customConversionGoal,
    },
  }));
}

async function applyClinicaclickGoalPolicy({
  scope,
  configuredAccounts,
  expectedDigest,
  confirmExternalMutation = false,
  dependencies = {},
} = {}) {
  if (confirmExternalMutation !== true) {
    throw runtimeError(
      'EXTERNAL_MUTATION_CONFIRMATION_REQUIRED',
      'Aplicar la política requiere confirmExternalMutation=true',
      400,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(String(expectedDigest || ''))) {
    throw runtimeError('GOAL_POLICY_EXPECTED_DIGEST_REQUIRED', 'expectedDigest no es válido', 400);
  }
  const accounts = normalizeConfiguredAccounts(configuredAccounts);
  if (accounts.length !== 1) {
    throw runtimeError(
      'GOAL_POLICY_APPLY_SINGLE_ACCOUNT_REQUIRED',
      'Cada apply debe limitarse a una cuenta para contener el radio de impacto',
      400,
    );
  }
  const account = accounts[0];
  // This early observation only closes managed apply. Never reuse it as
  // mutation authority after preview: the original fresh resolution below stays.
  const earlyRuntime = await (dependencies.resolveRuntime || resolveScopedGoogleAdsRuntime)({
    userId: scope?.user_id ?? scope?.userId ?? null,
    clinicId: scope?.clinic_id ?? scope?.clinicId ?? null,
    groupId: scope?.group_id ?? scope?.groupId ?? null,
    assignmentScope: scope?.assignment_scope ?? scope?.assignmentScope ?? null,
    customerId: account.customer_id, requiredScopes: [GOOGLE_ADS_SCOPE],
  });
  if (cleanCustomerId(earlyRuntime?.customerId) !== account.customer_id)
    throw runtimeError('GOAL_POLICY_RUNTIME_ACCOUNT_MISMATCH', 'El runtime pertenece a otra cuenta', 403);
  if (earlyRuntime.deliveryMode === 'broker') {
    if (process.env.GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED !== 'true' && typeof dependencies.managedExecutor !== 'function')
      throw runtimeError('GOAL_POLICY_BROKER_APPLY_UNAVAILABLE', 'El writer gestionado sigue cerrado', 409);
    const execute = dependencies.managedExecutor || require('./googleAdsGoalPolicyManagedExecution.service').forModels(db).execute;
    return execute({runtime:earlyRuntime,scope,configuredAccounts:accounts,expectedDigest,confirmExternalMutation,
      context:dependencies.managedGoalPolicyContext,beforeExternalMutation:dependencies.beforeExternalMutation,
      previewGoalPolicy:()=>previewClinicaclickGoalPolicy({scope,configuredAccounts:accounts,dependencies})});
  }
  const initialPreview = await previewClinicaclickGoalPolicy({ scope, configuredAccounts: accounts, dependencies });
  if (initialPreview.digest !== expectedDigest) {
    throw runtimeError(
      'GOAL_POLICY_DIGEST_STALE',
      'El estado de Google cambió desde el preview; vuelve a revisar el plan',
      409,
    );
  }
  const previewAccountResult = initialPreview.accounts[0];
  if (!previewAccountResult?.plan) {
    throw runtimeError('GOAL_POLICY_PREVIEW_FAILED', 'No se pudo construir un plan aplicable', 409);
  }
  const plan = previewAccountResult.plan;
  assertSafePlanOperations(account, plan);
  if (!plan.changed) {
    return {
      schema_version: SCHEMA_VERSION,
      mode: 'apply',
      outcome: 'unchanged',
      expected_digest: expectedDigest,
      external_mutation_count: 0,
      validation: { completed: true, operation_count: 0 },
      verification: { completed: true, healthy: true },
    };
  }

  const resolveRuntime = dependencies.resolveRuntime || resolveScopedGoogleAdsRuntime;
  const request = dependencies.request || googleAdsRequest;
  const runtime = await resolveRuntime({
    userId: scope?.user_id ?? scope?.userId ?? null,
    clinicId: scope?.clinic_id ?? scope?.clinicId ?? null,
    groupId: scope?.group_id ?? scope?.groupId ?? null,
    assignmentScope: scope?.assignment_scope ?? scope?.assignmentScope ?? null,
    customerId: account.customer_id,
    requiredScopes: [GOOGLE_ADS_SCOPE],
  });
  if (cleanCustomerId(runtime?.customerId) !== account.customer_id) {
    throw runtimeError('GOAL_POLICY_RUNTIME_ACCOUNT_MISMATCH', 'El runtime pertenece a otra cuenta', 403);
  }

  if (runtime.deliveryMode === 'broker') throw runtimeError('GOAL_POLICY_BROKER_APPLY_UNAVAILABLE',
    'La identidad pasó a gestionada durante el preview; no se aplicaron objetivos', 409);

  const goalOperation = plan.operations.custom_goal;
  const createsGoal = !!goalOperation?.create;
  if (createsGoal && typeof dependencies.persistOwnership !== 'function') {
    throw runtimeError(
      'GOAL_POLICY_OWNERSHIP_PERSISTENCE_REQUIRED',
      'Crear un custom goal requiere persistencia durable de ownership antes de asociar campañas',
      409,
    );
  }
  let campaignOperations = plan.operations.campaign_goal_configs;
  const campaignConversionGoalOperations = plan.operations.campaign_conversion_goals;
  let goalResource = plan.observed_custom_goal?.resource_name || null;
  let externalMutationCount = 0;
  let ownershipPersisted = false;

  await mutateCustomGoal({ runtime, operation: goalOperation, validateOnly: true, request });
  if (!createsGoal) {
    await mutateCampaignGoalConfigs({ runtime, operations: campaignOperations, validateOnly: true, request });
  }
  await mutateCampaignConversionGoals({
    runtime,
    operations: campaignConversionGoalOperations,
    validateOnly: true,
    request,
  });

  const driftPreview = await previewClinicaclickGoalPolicy({ scope, configuredAccounts: accounts, dependencies });
  if (driftPreview.digest !== expectedDigest) {
    throw runtimeError(
      'GOAL_POLICY_DIGEST_STALE',
      'El estado cambió después de validateOnly; no se aplicó ninguna mutación real',
      409,
    );
  }

  if (goalOperation) {
    const response = await mutateCustomGoal({ runtime, operation: goalOperation, validateOnly: false, request });
    externalMutationCount += 1;
    if (createsGoal) {
      goalResource = createdGoalResource(response, account.customer_id);
      if (!goalResource) {
        const error = runtimeError(
          'GOAL_POLICY_CREATED_GOAL_RESOURCE_MISSING',
          'Google creó el custom goal, pero no devolvió un resource_name verificable',
          502,
        );
        error.externalMutationCount = externalMutationCount;
        throw error;
      }
      campaignOperations = replaceGoalPlaceholder(campaignOperations, goalResource);
      const postCreatePreview = await previewClinicaclickGoalPolicy({
        scope,
        configuredAccounts: [{
          ...account,
          owned_custom_goal_resource_name: goalResource,
        }],
        dependencies,
      });
      const postCreatePlan = postCreatePreview.accounts[0]?.plan;
      if (
        !postCreatePlan
        || postCreatePlan.action_state_digest !== plan.action_state_digest
        || postCreatePlan.campaign_state_digest !== plan.campaign_state_digest
      ) {
        const error = runtimeError(
          'GOAL_POLICY_STATE_CHANGED_AFTER_GOAL_CREATE',
          'Las acciones o campañas cambiaron tras crear el custom goal; no se asociaron campañas',
          409,
        );
        error.createdGoalResourceName = goalResource;
        error.externalMutationCount = externalMutationCount;
        throw error;
      }
      if (typeof dependencies.persistOwnership === 'function') {
        try {
          await dependencies.persistOwnership({
            scope,
            customer_id: account.customer_id,
            strategy_ref: account.strategy_ref,
            custom_goal_resource_name: goalResource,
          });
          ownershipPersisted = true;
        } catch (error) {
          // Google ya creó el recurso. Propagarlo permite que el caller deje
          // ownership durable antes de cualquier retry y evita goals huérfanos.
          error.createdGoalResourceName = error.createdGoalResourceName || goalResource;
          error.externalMutationCount = Math.max(
            Number(error.externalMutationCount) || 0,
            externalMutationCount,
          );
          throw error;
        }
      }
      await mutateCampaignGoalConfigs({ runtime, operations: campaignOperations, validateOnly: true, request });
    }
  }

  // Asociar primero el custom goal evita dejar una campaña sin objetivos
  // pujables si una segunda mutación fuera rechazada por Google.
  await mutateCampaignGoalConfigs({ runtime, operations: campaignOperations, validateOnly: false, request });
  if (campaignOperations.length) externalMutationCount += 1;
  await mutateCampaignConversionGoals({
    runtime,
    operations: campaignConversionGoalOperations,
    validateOnly: false,
    request,
  });
  if (campaignConversionGoalOperations.length) externalMutationCount += 1;

  const verificationAccount = {
    ...account,
    owned_custom_goal_resource_name: goalResource,
  };
  const verification = await previewClinicaclickGoalPolicy({
    scope,
    configuredAccounts: [verificationAccount],
    dependencies,
  });
  const verified = verification.accounts[0]?.outcome === 'unchanged'
    && verification.accounts[0]?.plan?.changed === false;
  return {
    schema_version: SCHEMA_VERSION,
    mode: 'apply',
    outcome: verified ? 'applied' : 'applied_unverified',
    expected_digest: expectedDigest,
    external_mutation_count: externalMutationCount,
    validation: {
      completed: true,
      custom_goal_operation_count: goalOperation ? 1 : 0,
      campaign_config_operation_count: campaignOperations.length,
      campaign_conversion_goal_operation_count: campaignConversionGoalOperations.length,
    },
    ownership: {
      custom_goal_resource_name: goalResource,
      created: createsGoal,
      persisted: ownershipPersisted,
      persistence_required: createsGoal && !ownershipPersisted,
    },
    verification: {
      completed: true,
      healthy: verified,
      preview: verification,
    },
  };
}

function rowValue(row, camel, snake) {
  return row?.[camel] ?? row?.[snake] ?? null;
}

async function loadDiagnosticsSnapshot({
  scope,
  customerId,
  attemptModel = db.GoogleAdsConversionUploadAttempt,
  now = new Date(),
  freshnessHours = DEFAULT_DIAGNOSTIC_FRESHNESS_HOURS,
} = {}) {
  const where = { customerId };
  const assignmentScope = String(scope?.assignment_scope ?? scope?.assignmentScope ?? '').toLowerCase() === 'group'
    ? 'group'
    : 'clinic';
  where.assignmentScope = assignmentScope;
  if (assignmentScope === 'group') {
    const groupId = Number(scope?.group_id ?? scope?.groupId) || null;
    if (groupId) where.grupoClinicaId = groupId;
  } else {
    const clinicId = Number(scope?.clinic_id ?? scope?.clinicId) || null;
    if (clinicId) where.clinicaId = clinicId;
  }
  const rows = await attemptModel.findAll({
    where,
    order: [['attemptedAt', 'DESC']],
    limit: MAX_DIAGNOSTIC_ROWS,
    raw: true,
  });
  const counts = {};
  let latestAttemptAt = null;
  let latestDiagnosticsAt = null;
  let staleAcceptedCount = 0;
  const staleBefore = now.getTime() - Math.max(1, Number(freshnessHours) || DEFAULT_DIAGNOSTIC_FRESHNESS_HOURS) * 60 * 60 * 1000;
  for (const row of rows) {
    const status = String(rowValue(row, 'status', 'status') || 'unknown');
    counts[status] = (counts[status] || 0) + 1;
    const attemptedAt = new Date(rowValue(row, 'attemptedAt', 'attempted_at') || 0);
    if (!latestAttemptAt || attemptedAt > latestAttemptAt) latestAttemptAt = attemptedAt;
    const metadata = objectValue(rowValue(row, 'responseMetadata', 'response_metadata'));
    const diagnosticsAt = new Date(metadata.diagnostics_checked_at || 0);
    if (!Number.isNaN(diagnosticsAt.getTime()) && (!latestDiagnosticsAt || diagnosticsAt > latestDiagnosticsAt)) {
      latestDiagnosticsAt = diagnosticsAt;
    }
    if (status === 'accepted' && !Number.isNaN(attemptedAt.getTime()) && attemptedAt.getTime() < staleBefore) {
      staleAcceptedCount += 1;
    }
  }
  const issues = [];
  if (staleAcceptedCount) {
    issues.push({
      severity: 'critical',
      code: 'DATA_MANAGER_DIAGNOSTICS_STALE_ACCEPTED',
      message: `${staleAcceptedCount} conversiones siguen aceptadas sin diagnóstico terminal`,
    });
  }
  if ((counts.failed || 0) + (counts.partial_success || 0) > 0) {
    issues.push({
      severity: 'warning',
      code: 'DATA_MANAGER_DIAGNOSTICS_FAILURES_PRESENT',
      message: 'Existen conversiones con fallo o éxito parcial en la muestra reciente',
    });
  }
  return {
    sample_size: rows.length,
    counts,
    latest_attempt_at: latestAttemptAt && !Number.isNaN(latestAttemptAt.getTime()) ? latestAttemptAt.toISOString() : null,
    latest_diagnostics_at: latestDiagnosticsAt ? latestDiagnosticsAt.toISOString() : null,
    freshness_hours: Math.max(1, Number(freshnessHours) || DEFAULT_DIAGNOSTIC_FRESHNESS_HOURS),
    freshness_status: !rows.length ? 'no_data' : (staleAcceptedCount ? 'stale' : 'fresh'),
    issues,
  };
}

async function auditClinicaclickGoalPolicy({
  scope,
  configuredAccounts,
  dependencies = {},
} = {}) {
  const now = dependencies.now || (() => new Date());
  const preview = await previewClinicaclickGoalPolicy({ scope, configuredAccounts, dependencies });
  const loadDiagnostics = dependencies.loadDiagnostics || loadDiagnosticsSnapshot;
  const auditedAccounts = [];
  for (const account of preview.accounts) {
    const issues = [];
    if (!account.plan) {
      issues.push({
        severity: 'critical',
        code: account.error?.code || 'GOAL_POLICY_PREVIEW_FAILED',
        message: account.error?.message || 'No se pudo leer la política de objetivos',
      });
    } else {
      for (const item of account.plan.blockers || []) issues.push({ severity: 'critical', ...item });
      for (const operation of account.plan.operations?.campaign_conversion_goals || []) {
        issues.push({
          severity: 'critical',
          code: 'CAMPAIGN_CONVERSION_GOAL_STILL_BIDDABLE',
          message: 'Una campaña opt-in todavía permite pujar por objetivos fuera del custom goal de ClinicaClick',
          resource_name: operation.update.resourceName,
        });
      }
      const hasOtherDrift = !!account.plan.operations?.custom_goal
        || (account.plan.operations?.campaign_goal_configs || []).length > 0;
      if (account.plan.ready && hasOtherDrift) {
        issues.push({
          severity: 'critical',
          code: 'GOAL_POLICY_DRIFT',
          message: 'La cuenta no coincide con la política aprobada; la auditoría no la repara automáticamente',
        });
      }
      for (const item of account.plan.warnings || []) issues.push({ severity: 'warning', ...item });
    }
    let diagnostics;
    try {
      diagnostics = await loadDiagnostics({
        scope,
        customerId: account.customer_id,
        now: now(),
        attemptModel: dependencies.attemptModel || db.GoogleAdsConversionUploadAttempt,
      });
      issues.push(...(diagnostics.issues || []));
    } catch (error) {
      diagnostics = { freshness_status: 'unknown', issues: [] };
      issues.push({
        severity: 'warning',
        code: 'DATA_MANAGER_DIAGNOSTICS_READ_FAILED',
        message: String(error?.message || 'No se pudo leer Diagnostics').slice(0, 500),
      });
    }
    auditedAccounts.push({
      customer_id: account.customer_id,
      healthy: !issues.some((item) => item.severity === 'critical'),
      plan_digest: account.plan?.plan_digest || null,
      configured_campaign_ids: account.plan?.configured_campaign_ids || [],
      custom_goal_resource_name: account.plan?.observed_custom_goal?.resource_name || null,
      canonical_actions: account.plan
        ? DESIRED_ACTION_KEYS.map((key) => ({
            key,
            id: account.plan.canonical_actions[key]?.action?.id || null,
            status: account.plan.canonical_actions[key]?.action?.status || null,
            counting_type: account.plan.canonical_actions[key]?.action?.counting_type || null,
            primary_for_goal: account.plan.canonical_actions[key]?.action?.primary_for_goal ?? null,
          }))
        : [],
      supplemental_actions: account.plan
        ? (account.plan.supplemental_actions || []).map((item) => ({
            id: item.action_id,
            name: item.action?.name || null,
            status: item.action?.status || null,
            type: item.action?.type || null,
            resource_name: item.action?.resource_name || null,
            valid: item.valid === true,
            included_in_goal: item.included_in_goal === true,
          }))
        : [],
      diagnostics,
      issues,
    });
  }
  const issueCount = auditedAccounts.reduce((sum, account) => sum + account.issues.length, 0);
  const criticalCount = auditedAccounts.reduce(
    (sum, account) => sum + account.issues.filter((item) => item.severity === 'critical').length,
    0,
  );
  return {
    schema_version: SCHEMA_VERSION,
    mode: 'audit_read_only',
    audited_at: now().toISOString(),
    autorepair: false,
    external_mutation_count: 0,
    preview_digest: preview.digest,
    summary: {
      account_count: auditedAccounts.length,
      healthy_account_count: auditedAccounts.filter((account) => account.healthy).length,
      issue_count: issueCount,
      critical_count: criticalCount,
    },
    accounts: auditedAccounts,
  };
}

function intakeScope(row) {
  const assignmentScope = String(row.assignment_scope ?? row.assignmentScope ?? '').toLowerCase() === 'group'
    ? 'group'
    : 'clinic';
  return {
    assignment_scope: assignmentScope,
    clinic_id: Number(row.clinic_id ?? row.clinicId) || null,
    group_id: Number(row.group_id ?? row.groupId) || null,
  };
}

function hasConnectOnlyMeasurementConfig(config) {
  const googleAds = objectValue(objectValue(config).google_ads);
  if (googleAds.enabled !== true) return false;
  const events = objectValue(googleAds.events);
  return Object.values(events).some((rawEvent) => {
    const event = objectValue(rawEvent);
    if (event.enabled === false) return false;
    if (Object.prototype.hasOwnProperty.call(event, 'destinations')) {
      return Array.isArray(event.destinations)
        && event.destinations.some((destination) => destination?.enabled !== false);
    }
    return Boolean(
      cleanCustomerId(event.customer_id || googleAds.customer_id)
      && cleanPositiveId(event.conversion_action_id || googleAds.conversion_action_id)
    );
  });
}

function readCampaignRequestPayload(row) {
  const raw = row?.solicitud ?? row?.get?.('solicitud') ?? null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }
  return {};
}

function strategyPayloadUsesGoogle(payload) {
  const channels = Array.isArray(payload?.channels) ? payload.channels : [];
  if (channels.some((channel) => (
    String(channel?.channel || '').trim().toLowerCase() === 'google_ads'
      && channel?.enabled !== false
  ))) return true;
  const externalTargets = Array.isArray(payload?.external_targets) ? payload.external_targets : [];
  return externalTargets.some((target) => (
    (Array.isArray(target?.campaigns) ? target.campaigns : []).some((campaign) => (
      String(campaign?.provider || '').trim().toLowerCase() === 'google_ads'
    ))
  ));
}

function activeConnectOnlyGoogleClinicIds(rows) {
  const ids = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const payload = readCampaignRequestPayload(row);
    if (!['connect_only', 'guided_improvement'].includes(
      String(payload.mode_snapshot || payload.mode || '').trim().toLowerCase()
    )) continue;
    if (String(payload.objective_id || '').trim().toLowerCase() !== STRATEGY_KEY) continue;
    if (!strategyPayloadUsesGoogle(payload)) continue;
    const scope = objectValue(payload.scope);
    const candidates = [
      row?.clinica_id,
      scope.clinic_id,
      ...(Array.isArray(scope.clinic_ids) ? scope.clinic_ids : []),
    ];
    for (const candidate of candidates) {
      const clinicId = Number(candidate);
      if (Number.isSafeInteger(clinicId) && clinicId > 0) ids.add(clinicId);
    }
  }
  return ids;
}

function connectOnlyGoogleCampaignsByClinicId(rows) {
  const output = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const payload = readCampaignRequestPayload(row);
    if (!['connect_only', 'guided_improvement'].includes(
      String(payload.mode_snapshot || payload.mode || '').trim().toLowerCase()
    )) continue;
    if (String(payload.objective_id || '').trim().toLowerCase() !== STRATEGY_KEY) continue;
    if (!strategyPayloadUsesGoogle(payload)) continue;
    const scope = objectValue(payload.scope);
    const clinicIds = [...new Set([
      row?.clinica_id,
      scope.clinic_id,
      ...(Array.isArray(scope.clinic_ids) ? scope.clinic_ids : []),
    ].map(Number).filter((clinicId) => Number.isSafeInteger(clinicId) && clinicId > 0))];
    const campaigns = extractGoogleCampaignReferences(payload);
    for (const clinicId of clinicIds) {
      const current = output.get(clinicId) || new Map();
      for (const campaign of campaigns) {
        current.set(`${campaign.customer_id}:${campaign.campaign_id}`, campaign);
      }
      output.set(clinicId, current);
    }
  }
  return output;
}

function campaignsForClinicIds(campaignsByClinicId, clinicIds) {
  const output = new Map();
  for (const clinicId of Array.isArray(clinicIds) ? clinicIds : []) {
    for (const campaign of campaignsByClinicId.get(Number(clinicId))?.values?.() || []) {
      output.set(`${campaign.customer_id}:${campaign.campaign_id}`, campaign);
    }
  }
  return [...output.values()].sort((left, right) => (
    left.customer_id.localeCompare(right.customer_id)
      || left.campaign_id.localeCompare(right.campaign_id, 'en', { numeric: true })
  ));
}

async function discoverGoalPolicyAuditTargets({
  intakeModel = db.IntakeConfig,
  campaignRequestModel = db.CampaignRequest,
} = {}) {
  const rows = await intakeModel.findAll({ raw: true });
  const activeStrategyRows = await campaignRequestModel.findAll({
    where: { estado: 'activa' },
    attributes: ['id', 'clinica_id', 'estado', 'solicitud'],
    raw: true,
  });
  const activeMeasurementClinicIds = activeConnectOnlyGoogleClinicIds(activeStrategyRows);
  const activeCampaignsByClinicId = connectOnlyGoogleCampaignsByClinicId(activeStrategyRows);
  const targets = [];
  const measurementTargets = [];
  const issues = [];
  const seen = new Set();
  // Una configuración rota o deshabilitada también debe auditarse: filtrar
  // aquí por google_ads.enabled ocultaría precisamente el drift que buscamos.
  // Si hay filas legacy duplicadas, preferimos primero la que aún conserva
  // destinos de medición válidos y después el id más antiguo.
  const orderedRows = [...rows].sort((left, right) => (
    Number(hasConnectOnlyMeasurementConfig(objectValue(right.config)))
      - Number(hasConnectOnlyMeasurementConfig(objectValue(left.config)))
      || (Number(left.id) || 0) - (Number(right.id) || 0)
  ));
  const groupMeasurementRows = orderedRows.filter((row) => intakeScope(row).assignment_scope === 'group');
  const coveredClinicIds = new Set();
  for (const row of groupMeasurementRows) {
    const locations = Array.isArray(objectValue(row.config).locations)
      ? objectValue(row.config).locations
      : [];
    const scopedClinicIds = locations
      .map((location) => Number(location?.id || location?.clinic_id))
      .filter((clinicId) => (
        activeMeasurementClinicIds.has(clinicId) && !coveredClinicIds.has(clinicId)
      ));
    if (scopedClinicIds.length === 0) continue;
    scopedClinicIds.forEach((clinicId) => coveredClinicIds.add(clinicId));
    measurementTargets.push({
      intake_config_id: Number(row.id) || null,
      scope: intakeScope(row),
      intake_record: row,
      strategy_clinic_ids: scopedClinicIds.sort((left, right) => left - right),
      strategy_campaigns: campaignsForClinicIds(activeCampaignsByClinicId, scopedClinicIds),
    });
  }
  for (const row of orderedRows) {
    const scope = intakeScope(row);
    if (scope.assignment_scope === 'group') continue;
    if (!scope.clinic_id || !activeMeasurementClinicIds.has(scope.clinic_id)) continue;
    if (coveredClinicIds.has(scope.clinic_id)) continue;
    measurementTargets.push({
      intake_config_id: Number(row.id) || null,
      scope,
      intake_record: row,
      strategy_clinic_ids: [scope.clinic_id],
      strategy_campaigns: campaignsForClinicIds(activeCampaignsByClinicId, [scope.clinic_id]),
    });
    coveredClinicIds.add(scope.clinic_id);
  }
  for (const clinicId of activeMeasurementClinicIds) {
    if (coveredClinicIds.has(clinicId)) continue;
    issues.push({
      severity: 'critical',
      code: 'CONNECT_ONLY_MEASUREMENT_INTAKE_CONFIG_MISSING',
      reason: 'connect_only_measurement_intake_config_missing',
      message: `La clínica ${clinicId} tiene Mide y entiende activo, pero no existe una configuración de medición vinculada para auditar.`,
      clinic_id: clinicId,
    });
  }

  for (const row of rows) {
    const config = objectValue(row.config);
    const googleAds = objectValue(config.google_ads);
    const policy = objectValue(googleAds.goal_policy);
    if (policy.enabled !== true) continue;
    const rawAccounts = Array.isArray(policy.accounts) ? policy.accounts : [policy];
    for (const raw of rawAccounts) {
      const scope = intakeScope(row);
      try {
        const [account] = normalizeConfiguredAccounts([{
          ...raw,
          strategy_ref: raw.strategy_ref || policy.strategy_ref,
        }]);
        const key = [
          scope.assignment_scope,
          scope.group_id || scope.clinic_id || 'missing',
          account.customer_id,
          account.strategy_ref,
          account.cohort_key,
        ].join(':');
        if (seen.has(key)) {
          throw runtimeError('GOAL_POLICY_AUDIT_TARGET_DUPLICATE', `El target ${key} aparece repetido`, 400);
        }
        seen.add(key);
        targets.push({
          intake_config_id: Number(row.id) || null,
          scope,
          configured_accounts: [account],
        });
      } catch (error) {
        issues.push({
          severity: 'critical',
          code: error.code || 'GOAL_POLICY_AUDIT_TARGET_INVALID',
          message: String(error.message || 'Target de auditoría inválido').slice(0, 500),
          intake_config_id: Number(row.id) || null,
        });
      }
    }
  }
  return { targets, measurement_targets: measurementTargets, issues };
}

async function executePersistedGoalPolicyAudit({ dependencies = {} } = {}) {
  const syncLogModel = dependencies.syncLogModel || db.SyncLog;
  const notify = dependencies.notifications || notificationsService;
  const discover = dependencies.discoverTargets || discoverGoalPolicyAuditTargets;
  const audit = dependencies.audit || auditClinicaclickGoalPolicy;
  const auditMeasurement = dependencies.auditMeasurement || auditConnectOnlyMeasurementTarget;
  const now = dependencies.now || (() => new Date());
  const syncLog = await syncLogModel.create({
    job_type: 'google_conversion_goal_policy_audit',
    status: 'running',
    start_time: now(),
    records_processed: 0,
  });
  try {
    const discovered = await discover({
      intakeModel: dependencies.intakeModel || db.IntakeConfig,
      campaignRequestModel: dependencies.campaignRequestModel || db.CampaignRequest,
    });
    const reports = [];
    const measurementReports = [];
    const issues = [...(discovered.issues || [])];
    for (const target of discovered.targets || []) {
      const report = await audit({
        scope: target.scope,
        configuredAccounts: target.configured_accounts,
        dependencies,
      });
      reports.push({ intake_config_id: target.intake_config_id, scope: target.scope, report });
      for (const account of report.accounts || []) {
        for (const issue of account.issues || []) {
          issues.push({ ...issue, customer_id: account.customer_id, intake_config_id: target.intake_config_id });
        }
      }
    }
    for (const target of discovered.measurement_targets || []) {
      try {
        const report = await auditMeasurement({
          scope: target.scope,
          intakeRecord: target.intake_record,
          strategyCampaigns: target.strategy_campaigns,
          now: now(),
          dependencies,
        });
        const safeReport = {
          ...report,
          campaign_quality: sanitizeCampaignQualityReport(report.campaign_quality),
        };
        measurementReports.push({
          intake_config_id: target.intake_config_id,
          scope: target.scope,
          report: safeReport,
        });
        for (const issue of safeReport.issues || []) {
          issues.push({
            ...issue,
            intake_config_id: target.intake_config_id,
            audit_mode: 'connect_only_measurement',
          });
        }
      } catch (error) {
        issues.push({
          severity: 'critical',
          code: error.code || 'CONNECT_ONLY_MEASUREMENT_AUDIT_FAILED',
          message: String(error.message || 'No se pudo auditar Mide y entiende').slice(0, 500),
          intake_config_id: target.intake_config_id,
          audit_mode: 'connect_only_measurement',
        });
      }
    }
    const goalPolicyTargetCount = (discovered.targets || []).length;
    const measurementTargetCount = (discovered.measurement_targets || []).length;
    const totalTargetCount = goalPolicyTargetCount + measurementTargetCount;
    const criticalCount = issues.filter((item) => item.severity === 'critical').length;
    const statusReport = {
      schema_version: SCHEMA_VERSION,
      audited_at: now().toISOString(),
      autorepair: false,
      external_mutation_count: 0,
      target_count: totalTargetCount,
      goal_policy_target_count: goalPolicyTargetCount,
      connect_only_measurement_target_count: measurementTargetCount,
      issue_count: issues.length,
      critical_count: criticalCount,
      issues: issues.slice(0, 100),
      targets: reports.map((item) => ({
        intake_config_id: item.intake_config_id,
        scope: item.scope,
        summary: item.report.summary,
        preview_digest: item.report.preview_digest,
        accounts: item.report.accounts,
      })),
      connect_only_measurement_targets: measurementReports.map((item) => ({
        intake_config_id: item.intake_config_id,
        scope: item.scope,
        healthy: item.report.healthy,
        runtime_ready: item.report.runtime_ready,
        summary: item.report.summary,
        consent: item.report.consent,
        enhanced_conversions: item.report.enhanced_conversions,
        targets: item.report.targets,
        campaign_quality: item.report.campaign_quality,
        issues: item.report.issues,
      })),
    };
    await syncLog.update({
      status: criticalCount ? 'failed' : 'completed',
      end_time: now(),
      records_processed: totalTargetCount,
      error_message: criticalCount ? `Se detectaron ${criticalCount} desviaciones críticas en medición u objetivos Google Ads.` : null,
      status_report: statusReport,
    });
    if (criticalCount && typeof notify?.dispatchEvent === 'function') {
      await notify.dispatchEvent({
        event: 'jobs.failed',
        data: {
          jobName: 'Auditoría de medición y objetivos de conversión Google Ads',
          error: `Se detectaron ${criticalCount} desviaciones críticas.`,
        },
      });
    }
    return { status: criticalCount ? 'failed' : 'completed', ...statusReport };
  } catch (error) {
    await syncLog.update({
      status: 'failed',
      end_time: now(),
      error_message: String(error.message || error).slice(0, 2_000),
      status_report: {
        schema_version: SCHEMA_VERSION,
        audited_at: now().toISOString(),
        autorepair: false,
        external_mutation_count: 0,
        technical_error: sanitizedProviderError(error),
      },
    });
    if (typeof notify?.dispatchEvent === 'function') {
      await notify.dispatchEvent({
        event: 'jobs.failed',
        data: {
          jobName: 'googleConversionGoalPolicyAudit',
          error: String(error.message || error).slice(0, 1_000),
        },
      });
    }
    throw error;
  }
}

module.exports = {
  ALL_CANONICAL_KEYS,
  BIDDING_SIGNAL_KEYS,
  CANONICAL_ACTIONS,
  DESIRED_ACTION_KEYS,
  GOAL_NAME,
  GOAL_NAME_PREFIX,
  NEW_GOAL_PLACEHOLDER,
  OBSERVATION_ACTION_KEYS,
  SCHEMA_VERSION,
  STRATEGY_KEY,
  applyClinicaclickGoalPolicy,
  assertSafePlanOperations,
  auditClinicaclickGoalPolicy,
  buildClinicaclickGoalPolicyPlan,
  campaignConfigFromRow,
  conversionActionFromRow,
  customGoalFromRow,
  discoverGoalPolicyAuditTargets,
  executePersistedGoalPolicyAudit,
  fetchGoalPolicySnapshot,
  loadDiagnosticsSnapshot,
  normalizeConfiguredAccounts,
  previewClinicaclickGoalPolicy,
  stageGoalName,
  stableStringify,
};

'use strict';

const crypto = require('node:crypto');
const { googleAdsRequest, normalizeCustomerId } = require('../lib/googleAdsClient');
const {
  GOOGLE_ADS_SCOPE,
  resolveScopedGoogleAdsRuntime,
  runtimeError,
} = require('./googleAdsScopedRuntime.service');

const SCHEMA_VERSION = 'clinicaclick-google-ads-canonical-conversion-normalization/v1';
const DESIRED_COUNTING_TYPE = 'MANY_PER_CLICK';
const DESIRED_PRIMARY_FOR_GOAL = false;
const EXPECTED_ACTION_TYPE = 'UPLOAD_CLICKS';
const MUTABLE_STATUSES = new Set(['ENABLED', 'HIDDEN']);
const MAX_ACTIONS_PER_ACCOUNT = 5;
const CANONICAL_ACTIONS = Object.freeze({
  lead: Object.freeze({ key: 'lead', name: 'Lead - ClinicaClick' }),
  contact: Object.freeze({ key: 'contact', name: 'Contact - ClinicaClick' }),
  qualified_lead: Object.freeze({ key: 'qualified_lead', name: 'Qualified Lead - ClinicaClick' }),
  schedule: Object.freeze({ key: 'schedule', name: 'Schedule - ClinicaClick' }),
  purchase: Object.freeze({ key: 'purchase', name: 'Purchase - ClinicaClick' }),
});
const CANONICAL_BY_NAME = new Map(
  Object.values(CANONICAL_ACTIONS).map((action) => [action.name, action]),
);

function cleanCustomerId(value) {
  const clean = normalizeCustomerId(value);
  return /^\d{10}$/.test(clean) ? clean : '';
}

function cleanActionId(value) {
  const clean = String(value ?? '').trim();
  return /^\d+$/.test(clean) && !/^0+$/.test(clean) ? clean.replace(/^0+(?=\d)/, '') : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeExpectedAction(raw, customerId, index) {
  const source = typeof raw === 'string' ? { name: raw } : raw;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw runtimeError(
      'EXPECTED_ACTION_INVALID',
      `La acción esperada ${index + 1} de ${customerId} no es válida`,
      400,
    );
  }
  const id = source.id === undefined || source.id === null || source.id === ''
    ? null
    : cleanActionId(source.id);
  if (source.id !== undefined && source.id !== null && source.id !== '' && !id) {
    throw runtimeError(
      'EXPECTED_ACTION_ID_INVALID',
      `La acción esperada ${index + 1} de ${customerId} tiene un ID inválido`,
      400,
    );
  }
  const name = source.name === undefined || source.name === null || source.name === ''
    ? null
    : String(source.name);
  if (name && !CANONICAL_BY_NAME.has(name)) {
    throw runtimeError(
      'EXPECTED_ACTION_NAME_NOT_CANONICAL',
      `El nombre "${name}" no es una acción canónica exacta de ClinicaClick`,
      400,
    );
  }
  if (!id && !name) {
    throw runtimeError(
      'EXPECTED_ACTION_SELECTOR_REQUIRED',
      `La acción esperada ${index + 1} de ${customerId} necesita ID o nombre exacto`,
      400,
    );
  }
  return { id, name };
}

function normalizeConfiguredAccounts(configuredAccounts) {
  if (!Array.isArray(configuredAccounts) || configuredAccounts.length === 0) {
    throw runtimeError('CONFIGURED_ACCOUNTS_REQUIRED', 'Debe indicarse al menos una cuenta configurada', 400);
  }
  const seenCustomers = new Set();
  return configuredAccounts.map((raw, accountIndex) => {
    const customerId = cleanCustomerId(raw?.customer_id ?? raw?.customerId);
    if (!customerId) {
      throw runtimeError(
        'CONFIGURED_CUSTOMER_ID_INVALID',
        `La cuenta configurada ${accountIndex + 1} no tiene un customer_id de 10 dígitos`,
        400,
      );
    }
    if (seenCustomers.has(customerId)) {
      throw runtimeError('CONFIGURED_CUSTOMER_DUPLICATE', `La cuenta ${customerId} aparece repetida`, 400);
    }
    seenCustomers.add(customerId);

    const rawActions = raw?.expected_actions ?? raw?.expectedActions;
    if (!Array.isArray(rawActions) || rawActions.length === 0) {
      throw runtimeError(
        'EXPECTED_ACTIONS_REQUIRED',
        `La cuenta ${customerId} debe declarar las acciones que autoriza normalizar`,
        400,
      );
    }
    if (rawActions.length > MAX_ACTIONS_PER_ACCOUNT) {
      throw runtimeError(
        'EXPECTED_ACTION_LIMIT_EXCEEDED',
        `La cuenta ${customerId} no puede declarar más de ${MAX_ACTIONS_PER_ACCOUNT} acciones`,
        400,
      );
    }
    const expectedActions = rawActions.map((action, index) => (
      normalizeExpectedAction(action, customerId, index)
    ));
    const seenIds = new Set();
    const seenNames = new Set();
    for (const action of expectedActions) {
      if (action.id && seenIds.has(action.id)) {
        throw runtimeError('EXPECTED_ACTION_ID_DUPLICATE', `El ID ${action.id} aparece repetido`, 400);
      }
      if (action.name && seenNames.has(action.name)) {
        throw runtimeError('EXPECTED_ACTION_NAME_DUPLICATE', `La acción ${action.name} aparece repetida`, 400);
      }
      if (action.id) seenIds.add(action.id);
      if (action.name) seenNames.add(action.name);
    }
    return { customer_id: customerId, expected_actions: expectedActions };
  });
}

function actionFromGoogleRow(row) {
  const action = row?.conversionAction && typeof row.conversionAction === 'object'
    ? row.conversionAction
    : (row?.conversion_action && typeof row.conversion_action === 'object' ? row.conversion_action : {});
  const primary = action.primaryForGoal ?? action.primary_for_goal;
  return {
    id: cleanActionId(action.id),
    resource_name: String(action.resourceName ?? action.resource_name ?? '').trim(),
    owner_customer: String(action.ownerCustomer ?? action.owner_customer ?? '').trim(),
    name: action.name === undefined || action.name === null ? '' : String(action.name),
    type: String(action.type ?? '').trim().toUpperCase() || null,
    status: String(action.status ?? '').trim().toUpperCase() || null,
    counting_type: String(action.countingType ?? action.counting_type ?? '').trim().toUpperCase() || null,
    primary_for_goal: typeof primary === 'boolean' ? primary : null,
  };
}

async function fetchConversionActions({
  accessToken,
  loginCustomerId,
  customerId,
  request = googleAdsRequest,
}) {
  const normalizedCustomerId = cleanCustomerId(customerId);
  if (!accessToken || !normalizedCustomerId) {
    throw runtimeError('CONVERSION_ACTION_LOOKUP_INPUT_INVALID', 'Faltan datos para consultar conversiones', 400);
  }
  const query = [
    'SELECT',
    '  conversion_action.id,',
    '  conversion_action.resource_name,',
    '  conversion_action.owner_customer,',
    '  conversion_action.name,',
    '  conversion_action.type,',
    '  conversion_action.status,',
    '  conversion_action.counting_type,',
    '  conversion_action.primary_for_goal',
    'FROM conversion_action',
  ].join('\n');
  const response = await request('POST', `customers/${normalizedCustomerId}/googleAds:search`, {
    accessToken,
    loginCustomerId: loginCustomerId || undefined,
    data: { query },
    singleAttempt: true,
    timeoutMs: 15_000,
  });
  return (Array.isArray(response?.results) ? response.results : [])
    .map(actionFromGoogleRow)
    .filter((action) => action.id);
}

function selectorLabel(selector) {
  if (selector.id && selector.name) return `${selector.name} (${selector.id})`;
  return selector.name || selector.id || 'desconocida';
}

function selectProviderAction(selector, providerActions) {
  if (selector.id) {
    const matches = providerActions.filter((action) => action.id === selector.id);
    if (matches.length !== 1) {
      return {
        action: null,
        blocker: {
          code: matches.length ? 'EXPECTED_ACTION_ID_AMBIGUOUS' : 'EXPECTED_ACTION_NOT_FOUND',
          selector: selectorLabel(selector),
          message: matches.length
            ? 'Google devolvió el mismo ID de acción más de una vez.'
            : 'No se encontró el ID esperado en la cuenta.',
        },
      };
    }
    return { action: matches[0], blocker: null };
  }
  const matches = providerActions.filter((action) => action.name === selector.name);
  if (matches.length !== 1) {
    return {
      action: null,
      blocker: {
        code: matches.length ? 'EXPECTED_ACTION_NAME_AMBIGUOUS' : 'EXPECTED_ACTION_NOT_FOUND',
        selector: selectorLabel(selector),
        message: matches.length
          ? 'Hay varias acciones con ese nombre; debe indicarse el ID exacto.'
          : 'No se encontró el nombre canónico exacto en la cuenta.',
      },
    };
  }
  return { action: matches[0], blocker: null };
}

function buildCanonicalConversionNormalizationPlan({
  customerId,
  expectedActions,
  providerActions,
}) {
  const normalizedCustomerId = cleanCustomerId(customerId);
  if (!normalizedCustomerId) {
    throw runtimeError('CUSTOMER_ID_INVALID', 'customer_id debe contener exactamente 10 dígitos', 400);
  }
  const sourceActions = Array.isArray(providerActions) ? providerActions : [];
  const selected = [];
  const blockers = [];
  const selectedIds = new Set();
  const selectedCanonicalNames = new Set();

  for (const selector of Array.isArray(expectedActions) ? expectedActions : []) {
    const found = selectProviderAction(selector, sourceActions);
    if (found.blocker) {
      blockers.push(found.blocker);
      selected.push({ selector, outcome: 'blocked', blockers: [found.blocker] });
      continue;
    }
    const action = found.action;
    const itemBlockers = [];
    const canonical = CANONICAL_BY_NAME.get(action.name) || null;
    const expectedResourceName = `customers/${normalizedCustomerId}/conversionActions/${action.id}`;
    const expectedOwner = `customers/${normalizedCustomerId}`;

    if (!canonical) {
      itemBlockers.push({
        code: 'ACTION_NAME_NOT_CANONICAL',
        action_id: action.id,
        message: 'El ID esperado no corresponde a uno de los cuatro nombres canónicos exactos.',
      });
    }
    if (selector.name && action.name !== selector.name) {
      itemBlockers.push({
        code: 'ACTION_NAME_MISMATCH',
        action_id: action.id,
        message: 'El ID y el nombre esperados no identifican la misma acción.',
      });
    }
    if (selectedIds.has(action.id)) {
      itemBlockers.push({
        code: 'ACTION_SELECTED_TWICE',
        action_id: action.id,
        message: 'Dos selectores resolvieron la misma acción.',
      });
    }
    if (canonical && selectedCanonicalNames.has(canonical.name)) {
      itemBlockers.push({
        code: 'ACTION_CANONICAL_NAME_SELECTED_TWICE',
        action_id: action.id,
        message: 'Más de un ID esperado resuelve el mismo nombre canónico.',
      });
    }
    if (action.resource_name !== expectedResourceName || action.owner_customer !== expectedOwner) {
      itemBlockers.push({
        code: 'ACTION_ACCOUNT_MISMATCH',
        action_id: action.id,
        message: 'La acción no pertenece de forma inequívoca a la cuenta configurada.',
      });
    }
    if (action.type !== EXPECTED_ACTION_TYPE) {
      itemBlockers.push({
        code: 'ACTION_TYPE_NOT_UPLOAD_CLICKS',
        action_id: action.id,
        message: `La acción es ${action.type || 'de tipo desconocido'}, no UPLOAD_CLICKS.`,
      });
    }
    if (!MUTABLE_STATUSES.has(action.status)) {
      itemBlockers.push({
        code: 'ACTION_STATUS_NOT_MUTABLE',
        action_id: action.id,
        message: `La acción tiene estado ${action.status || 'desconocido'} y no se modificará.`,
      });
    }
    selectedIds.add(action.id);
    if (canonical) selectedCanonicalNames.add(canonical.name);
    blockers.push(...itemBlockers);
    const changed = action.counting_type !== DESIRED_COUNTING_TYPE
      || action.primary_for_goal !== DESIRED_PRIMARY_FOR_GOAL;
    selected.push({
      selector,
      key: canonical?.key || null,
      id: action.id,
      resource_name: expectedResourceName,
      owner_customer: action.owner_customer,
      name: action.name,
      type: action.type,
      status: action.status,
      before: {
        counting_type: action.counting_type,
        primary_for_goal: action.primary_for_goal,
      },
      after: {
        counting_type: DESIRED_COUNTING_TYPE,
        primary_for_goal: DESIRED_PRIMARY_FOR_GOAL,
      },
      changed,
      outcome: itemBlockers.length ? 'blocked' : (changed ? 'update_ready' : 'unchanged'),
      blockers: itemBlockers,
    });
  }

  const candidateOperations = selected
    .filter((action) => action.outcome === 'update_ready')
    .map((action) => ({
      update: {
        resourceName: action.resource_name,
        countingType: DESIRED_COUNTING_TYPE,
        primaryForGoal: DESIRED_PRIMARY_FOR_GOAL,
      },
      updateMask: 'counting_type,primary_for_goal',
    }));
  const operations = blockers.length ? [] : candidateOperations;
  const selectedState = selected.map((action) => ({
    selector: action.selector,
    id: action.id || null,
    resource_name: action.resource_name || null,
    owner_customer: action.owner_customer || null,
    name: action.name || null,
    type: action.type || null,
    status: action.status || null,
    counting_type: action.before?.counting_type ?? null,
    primary_for_goal: action.before?.primary_for_goal ?? null,
    outcome: action.outcome,
  }));
  const operationState = candidateOperations.map((operation) => ({
    resource_name: operation.update.resourceName,
    counting_type: operation.update.countingType,
    primary_for_goal: operation.update.primaryForGoal,
  }));

  return {
    customer_id: normalizedCustomerId,
    requested_action_count: Array.isArray(expectedActions) ? expectedActions.length : 0,
    provider_action_count: sourceActions.length,
    selected_action_count: selected.filter((action) => !!action.id).length,
    changed_action_count: selected.filter((action) => action.outcome === 'update_ready').length,
    unchanged_action_count: selected.filter((action) => action.outcome === 'unchanged').length,
    blocked: blockers.length > 0,
    blockers,
    actions: selected,
    operations,
    state_digest: sha256(JSON.stringify(selectedState)),
    plan_digest: sha256(JSON.stringify(operationState)),
  };
}

function sameSelectedActionState(previousPlan, currentPlan) {
  return !!previousPlan
    && !!currentPlan
    && currentPlan.blocked === false
    && previousPlan.state_digest === currentPlan.state_digest
    && previousPlan.plan_digest === currentPlan.plan_digest;
}

function sanitizedProviderError(error) {
  const provider = error?.response?.data?.error;
  return {
    code: error?.code || provider?.status || 'GOOGLE_ADS_REQUEST_FAILED',
    http_status: Number(error?.response?.status) || Number(error?.httpStatus) || null,
    message: String(provider?.message || error?.message || 'Google Ads rechazó la operación').slice(0, 1_000),
    request_id: String(
      error?.response?.headers?.['request-id']
      || error?.response?.headers?.['request_id']
      || '',
    ).trim() || null,
    details: Array.isArray(provider?.details)
      ? provider.details.slice(0, 20).map((detail) => ({
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

function assertSafeOperations(customerId, operations) {
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > MAX_ACTIONS_PER_ACCOUNT) {
    throw runtimeError('NORMALIZATION_OPERATIONS_INVALID', 'El lote de normalización no es válido', 400);
  }
  const seen = new Set();
  for (const operation of operations) {
    const update = operation?.update;
    const resourceName = String(update?.resourceName || '');
    const keys = update && typeof update === 'object' ? Object.keys(update).sort() : [];
    if (
      operation?.updateMask !== 'counting_type,primary_for_goal'
      || !new RegExp(`^customers/${customerId}/conversionActions/\\d+$`).test(resourceName)
      || seen.has(resourceName)
      || keys.join(',') !== 'countingType,primaryForGoal,resourceName'
      || update.countingType !== DESIRED_COUNTING_TYPE
      || update.primaryForGoal !== DESIRED_PRIMARY_FOR_GOAL
    ) {
      throw runtimeError(
        'NORMALIZATION_OPERATION_NOT_CANONICAL',
        'El lote contiene una acción de otra cuenta o campos no autorizados',
        403,
      );
    }
    seen.add(resourceName);
  }
}

async function sendNormalizationMutations({
  runtime,
  operations,
  validateOnly,
  request = googleAdsRequest,
}) {
  const customerId = cleanCustomerId(runtime?.customerId);
  if (!customerId || !runtime?.accessToken) {
    throw runtimeError('NORMALIZATION_RUNTIME_INVALID', 'El runtime de Google Ads no es válido', 403);
  }
  assertSafeOperations(customerId, operations);
  return request('POST', `customers/${customerId}/conversionActions:mutate`, {
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId || undefined,
    singleAttempt: true,
    timeoutMs: 15_000,
    data: {
      operations,
      partialFailure: false,
      validateOnly: validateOnly === true,
      responseContentType: 'MUTABLE_RESOURCE',
    },
  });
}

function publicPlan(plan) {
  return {
    requested_action_count: plan.requested_action_count,
    provider_action_count: plan.provider_action_count,
    selected_action_count: plan.selected_action_count,
    changed_action_count: plan.changed_action_count,
    unchanged_action_count: plan.unchanged_action_count,
    state_digest: plan.state_digest,
    plan_digest: plan.plan_digest,
    blockers: plan.blockers,
    actions: plan.actions,
  };
}

async function processAccount({
  account,
  scope,
  apply,
  validateOnly,
  resolveRuntime,
  request,
  now,
}) {
  const startedAt = now().toISOString();
  let mutationCompleted = false;
  let result = {
    customer_id: account.customer_id,
    fail_closed: true,
    started_at: startedAt,
    validation: { requested: validateOnly || apply, completed: false },
    mutation: { requested: apply, completed: false },
  };
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
      throw runtimeError('RUNTIME_ACCOUNT_MISMATCH', 'El runtime no pertenece a la cuenta configurada', 403);
    }
    const providerActions = await fetchConversionActions({
      accessToken: runtime.accessToken,
      loginCustomerId: runtime.loginCustomerId,
      customerId: account.customer_id,
      request,
    });
    const plan = buildCanonicalConversionNormalizationPlan({
      customerId: account.customer_id,
      expectedActions: account.expected_actions,
      providerActions,
    });
    result = { ...result, plan: publicPlan(plan) };
    if (plan.blocked) {
      return { ...result, outcome: 'blocked', finished_at: now().toISOString() };
    }
    if (!plan.operations.length) {
      return { ...result, outcome: 'unchanged', finished_at: now().toISOString() };
    }
    if (!validateOnly && !apply) {
      return { ...result, outcome: 'ready', finished_at: now().toISOString() };
    }

    await sendNormalizationMutations({ runtime, operations: plan.operations, validateOnly: true, request });
    result.validation = { requested: true, completed: true, operation_count: plan.operations.length };
    if (validateOnly) {
      return { ...result, outcome: 'validated', finished_at: now().toISOString() };
    }

    const driftActions = await fetchConversionActions({
      accessToken: runtime.accessToken,
      loginCustomerId: runtime.loginCustomerId,
      customerId: account.customer_id,
      request,
    });
    const driftPlan = buildCanonicalConversionNormalizationPlan({
      customerId: account.customer_id,
      expectedActions: account.expected_actions,
      providerActions: driftActions,
    });
    if (!sameSelectedActionState(plan, driftPlan)) {
      return {
        ...result,
        outcome: 'blocked',
        blockers: [{
          code: 'CONVERSION_ACTION_STATE_CHANGED',
          message: 'Una acción cambió después de la validación; no se aplicó el lote.',
        }],
        finished_at: now().toISOString(),
      };
    }

    const mutationResponse = await sendNormalizationMutations({
      runtime,
      operations: plan.operations,
      validateOnly: false,
      request,
    });
    mutationCompleted = true;
    result.mutation = {
      requested: true,
      completed: true,
      operation_count: plan.operations.length,
      result_count: Array.isArray(mutationResponse?.results) ? mutationResponse.results.length : 0,
    };

    const verifiedActions = await fetchConversionActions({
      accessToken: runtime.accessToken,
      loginCustomerId: runtime.loginCustomerId,
      customerId: account.customer_id,
      request,
    });
    const verifiedPlan = buildCanonicalConversionNormalizationPlan({
      customerId: account.customer_id,
      expectedActions: account.expected_actions,
      providerActions: verifiedActions,
    });
    const verification = verifiedPlan.actions.map((action) => ({
      id: action.id || null,
      name: action.name || action.selector?.name || null,
      verified: action.outcome === 'unchanged'
        && action.before?.counting_type === DESIRED_COUNTING_TYPE
        && action.before?.primary_for_goal === DESIRED_PRIMARY_FOR_GOAL,
    }));
    const verified = !verifiedPlan.blocked
      && verification.length === account.expected_actions.length
      && verification.every((action) => action.verified);
    return {
      ...result,
      outcome: verified ? 'applied' : 'applied_unverified',
      verification,
      finished_at: now().toISOString(),
    };
  } catch (error) {
    return {
      ...result,
      outcome: mutationCompleted ? 'applied_unverified' : 'failed',
      finished_at: now().toISOString(),
      error: sanitizedProviderError(error),
    };
  }
}

function summarize(accounts) {
  const actions = accounts.flatMap((account) => account.plan?.actions || []);
  return {
    account_count: accounts.length,
    ready_account_count: accounts.filter((account) => account.outcome === 'ready').length,
    validated_account_count: accounts.filter((account) => account.outcome === 'validated').length,
    applied_account_count: accounts.filter((account) => account.outcome === 'applied').length,
    unchanged_account_count: accounts.filter((account) => account.outcome === 'unchanged').length,
    blocked_or_failed_account_count: accounts.filter((account) => (
      ['blocked', 'failed', 'applied_unverified'].includes(account.outcome)
    )).length,
    selected_action_count: actions.filter((action) => !!action.id).length,
    changed_action_count: actions.filter((action) => action.outcome === 'update_ready').length,
    verified_action_count: accounts.flatMap((account) => account.verification || [])
      .filter((action) => action.verified).length,
  };
}

/**
 * `configuredAccounts` usa la forma:
 * [{ customer_id, expected_actions: [{ id?, name? }] }]
 *
 * Cada selector exige al menos el ID esperado o uno de los cuatro nombres
 * canónicos exactos. Un ID siempre se contrasta además con el nombre, tipo,
 * owner y resource_name que devuelve Google.
 *
 * Sin flags solo se previsualiza. `validateOnly: true` valida sin ejecutar.
 * `apply: true` requiere también `confirmExternalMutation: true`; después
 * valida, detecta drift, aplica con partialFailure=false y relee.
 */
async function normalizeCanonicalGoogleAdsConversions({
  scope,
  configuredAccounts,
  apply = false,
  validateOnly = false,
  confirmExternalMutation = false,
  dependencies = {},
} = {}) {
  for (const [key, value] of Object.entries({ apply, validateOnly, confirmExternalMutation })) {
    if (value !== true && value !== false) {
      throw runtimeError('NORMALIZATION_FLAG_INVALID', `${key} debe ser booleano`, 400);
    }
  }
  if (apply && validateOnly) {
    throw runtimeError('NORMALIZATION_MODE_CONFLICT', 'apply y validateOnly no pueden ser true a la vez', 400);
  }
  if (apply && !confirmExternalMutation) {
    throw runtimeError(
      'EXTERNAL_MUTATION_CONFIRMATION_REQUIRED',
      'La normalización requiere confirmación externa explícita',
      400,
    );
  }

  const accounts = normalizeConfiguredAccounts(configuredAccounts);
  const resolveRuntime = dependencies.resolveRuntime || resolveScopedGoogleAdsRuntime;
  const request = dependencies.request || googleAdsRequest;
  const now = dependencies.now || (() => new Date());
  const startedAt = now().toISOString();
  const results = [];
  for (const account of accounts) {
    results.push(await processAccount({
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
    external_mutation_confirmed: apply && confirmExternalMutation,
    started_at: startedAt,
    finished_at: now().toISOString(),
    summary: summarize(results),
    accounts: results,
  };
}

module.exports = {
  CANONICAL_ACTIONS,
  DESIRED_COUNTING_TYPE,
  DESIRED_PRIMARY_FOR_GOAL,
  EXPECTED_ACTION_TYPE,
  MAX_ACTIONS_PER_ACCOUNT,
  SCHEMA_VERSION,
  actionFromGoogleRow,
  assertSafeOperations,
  buildCanonicalConversionNormalizationPlan,
  fetchConversionActions,
  normalizeCanonicalGoogleAdsConversions,
  normalizeConfiguredAccounts,
  sameSelectedActionState,
};

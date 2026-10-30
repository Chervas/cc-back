'use strict';
// Pure existing GoalPolicy planner. No models, configuration or transport imports.
const crypto = require('node:crypto');
function normalizeCustomerId(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^0-9]/g, '');
}
function runtimeError(code, message, httpStatus = 400) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}
const SCHEMA_VERSION = 'clinicaclick-google-ads-conversion-goal-policy/v4';
// Nombre reservado por la policy v3. Se conserva exclusivamente para detectar
// configuraciones antiguas: nunca se crea ni se actualiza desde v4.
const GOAL_NAME = 'Clinicaclick · Captar nuevos pacientes';
const GOAL_NAME_PREFIX = 'Clinicaclick · Nuevos pacientes';
const STRATEGY_KEY = 'new_patients';
const OBSERVATION_ACTION_KEYS = Object.freeze(['lead', 'contact']);
const BIDDING_SIGNAL_KEYS = Object.freeze(['qualified_lead', 'schedule', 'purchase']);
const ALL_CANONICAL_KEYS = Object.freeze([...OBSERVATION_ACTION_KEYS, ...BIDDING_SIGNAL_KEYS]);
// Alias exportado por compatibilidad. En v4 son las acciones que se auditan y
// se mantienen secundarias globalmente, no las que comparten un custom goal.
const DESIRED_ACTION_KEYS = ALL_CANONICAL_KEYS;
const CANONICAL_ACTIONS = Object.freeze({
  lead: Object.freeze({ key: 'lead', name: 'Lead - ClinicaClick' }),
  contact: Object.freeze({ key: 'contact', name: 'Contact - ClinicaClick' }),
  qualified_lead: Object.freeze({ key: 'qualified_lead', name: 'Qualified Lead - ClinicaClick' }),
  schedule: Object.freeze({ key: 'schedule', name: 'Schedule - ClinicaClick' }),
  purchase: Object.freeze({ key: 'purchase', name: 'Purchase - ClinicaClick' }),
});
const STAGE_LABELS = Object.freeze({
  qualified_lead: 'Lead cualificado',
  schedule: 'Cita cerrada',
  purchase: 'Tratamiento aceptado',
});
const CANONICAL_BY_NAME = new Map(
  Object.values(CANONICAL_ACTIONS).map((item) => [item.name, item]),
);
const MAX_CAMPAIGNS_PER_ACCOUNT = 200;
const MAX_SUPPLEMENTAL_ACTIONS_PER_ACCOUNT = 20;
const MAX_DIAGNOSTIC_ROWS = 200;
const DEFAULT_DIAGNOSTIC_FRESHNESS_HOURS = 6;
const NEW_GOAL_PLACEHOLDER = '@clinicaclick/new-custom-conversion-goal';

function cleanCustomerId(value) {
  const normalized = normalizeCustomerId(value);
  return /^\d{10}$/.test(normalized) ? normalized : '';
}

function cleanPositiveId(value) {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) && !/^0+$/.test(normalized)
    ? normalized.replace(/^0+(?=\d)/, '')
    : '';
}

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }
  return {};
}

function sortedUniqueIds(values, { label, maximum = Number.POSITIVE_INFINITY } = {}) {
  const source = Array.isArray(values) ? values : [];
  const output = [];
  const seen = new Set();
  for (const raw of source) {
    const id = cleanPositiveId(raw);
    if (!id) {
      throw runtimeError('GOAL_POLICY_ID_INVALID', `${label || 'El identificador'} contiene un valor inválido`, 400);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  output.sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
  if (output.length > maximum) {
    throw runtimeError(
      'GOAL_POLICY_BLAST_RADIUS_EXCEEDED',
      `${label || 'La lista'} supera el máximo seguro de ${maximum}`,
      400,
    );
  }
  return output;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((output, key) => {
    output[key] = stableValue(value[key]);
    return output;
  }, {});
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function cohortKey({ strategyRef, campaignIds }) {
  return sha256(stableStringify({
    strategy_ref: strategyRef,
    campaign_ids: campaignIds,
  })).slice(0, 10);
}

function stageGoalName(stage, cohort) {
  const label = STAGE_LABELS[stage];
  if (!label || !/^[a-f0-9]{10}$/.test(String(cohort || ''))) {
    throw runtimeError('GOAL_POLICY_STAGE_INVALID', 'No se puede construir un custom goal sin etapa y cohorte válidas', 400);
  }
  return `${GOAL_NAME_PREFIX} · ${label} · cohorte ${cohort}`;
}

function goalResourcePattern(customerId) {
  return new RegExp(`^customers/${customerId}/customConversionGoals/\\d+$`);
}

function actionResourceName(customerId, actionId) {
  return `customers/${customerId}/conversionActions/${actionId}`;
}

function campaignResourceName(customerId, campaignId) {
  return `customers/${customerId}/campaigns/${campaignId}`;
}

function campaignConfigResourceName(customerId, campaignId) {
  return `customers/${customerId}/conversionGoalCampaignConfigs/${campaignId}`;
}

function campaignConversionGoalResourceName(customerId, campaignId, category, origin) {
  return `customers/${customerId}/campaignConversionGoals/${campaignId}~${category}~${origin}`;
}

function normalizeOwnedGoalResource(customerId, raw) {
  const resourceName = cleanString(raw);
  if (!resourceName) return null;
  if (!goalResourcePattern(customerId).test(resourceName)) {
    throw runtimeError(
      'OWNED_CUSTOM_GOAL_RESOURCE_INVALID',
      `El custom goal declarado para ${customerId} no pertenece inequívocamente a la cuenta`,
      400,
    );
  }
  return resourceName;
}

function normalizeCanonicalActionIds(raw, customerId) {
  const source = objectValue(raw);
  const output = {};
  for (const key of ALL_CANONICAL_KEYS) {
    const id = cleanPositiveId(source[key]);
    output[key] = id || null;
  }
  const ids = Object.values(output).filter(Boolean);
  if (new Set(ids).size !== ids.length) {
    throw runtimeError(
      'CANONICAL_ACTION_ID_DUPLICATE',
      `La cuenta ${customerId} reutiliza un ID para más de una acción canónica`,
      400,
    );
  }
  return output;
}

function normalizeSupplementalActionIds(raw, customerId, canonicalActionIds) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw runtimeError(
      'SUPPLEMENTAL_ACTION_IDS_INVALID',
      `supplemental_action_ids de ${customerId} debe ser una lista explícita`,
      400,
    );
  }
  const ids = sortedUniqueIds(raw, {
    label: `Las acciones suplementarias de ${customerId}`,
    maximum: MAX_SUPPLEMENTAL_ACTIONS_PER_ACCOUNT,
  });
  const canonicalEntries = Object.entries(canonicalActionIds || {});
  for (const id of ids) {
    const canonical = canonicalEntries.find(([, canonicalId]) => canonicalId === id);
    if (!canonical) continue;
    if (canonical[0] === 'purchase') {
      throw runtimeError(
        'SUPPLEMENTAL_ACTION_PURCHASE_FORBIDDEN',
        'Purchase nunca puede declararse como acción suplementaria',
        400,
      );
    }
    throw runtimeError(
      'SUPPLEMENTAL_ACTION_CANONICAL_DUPLICATE',
      `${CANONICAL_ACTIONS[canonical[0]].name} ya es obligatoria y no puede repetirse como suplementaria`,
      400,
    );
  }
  return ids;
}

function normalizeBiddingSelection(raw, customerId) {
  const explicitlyMissing = raw === undefined || raw === null;
  const source = explicitlyMissing
    ? ['lead', 'contact', 'schedule']
    : (Array.isArray(raw) ? raw : [raw]);
  if (source.length === 0) {
    return {
      input_keys: [],
      bidding_action_key: null,
      migration_required: true,
      migration_reasons: ['BIDDING_SIGNAL_REQUIRED'],
    };
  }
  const output = [];
  const seen = new Set();
  for (const value of source) {
    const key = String(value || '').trim().toLowerCase();
    if (!ALL_CANONICAL_KEYS.includes(key)) {
      throw runtimeError(
        'BIDDING_ACTION_KEY_NOT_ALLOWED',
        `${key || 'El valor vacío'} no es una acción canónica apta para puja`,
        400,
      );
    }
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(key);
  }
  output.sort((left, right) => ALL_CANONICAL_KEYS.indexOf(left) - ALL_CANONICAL_KEYS.indexOf(right));
  const validSingleStage = output.length === 1 && BIDDING_SIGNAL_KEYS.includes(output[0]);
  const migrationReasons = [];
  if (explicitlyMissing) migrationReasons.push('LEGACY_BIDDING_SELECTION_IMPLICIT');
  if (output.some((key) => OBSERVATION_ACTION_KEYS.includes(key))) {
    migrationReasons.push('LEGACY_OBSERVATION_ACTION_USED_FOR_BIDDING');
  }
  if (output.length !== 1) migrationReasons.push('MULTIPLE_BIDDING_SIGNALS_NOT_ALLOWED');
  if (!validSingleStage && !migrationReasons.length) migrationReasons.push('BIDDING_SIGNAL_REQUIRED');
  return {
    input_keys: output,
    bidding_action_key: validSingleStage ? output[0] : null,
    migration_required: migrationReasons.length > 0,
    migration_reasons: migrationReasons,
  };
}

/**
 * Configuración por cuenta:
 * {
 *   customer_id, strategy_ref, campaign_ids,
 *   canonical_action_ids: { lead, contact, qualified_lead, schedule, purchase },
 *   bidding_action_key: 'qualified_lead'|'schedule'|'purchase',
 *   supplemental_action_ids?: string[],
 *   owned_custom_goal_resource_name?
 * }
 *
 * Los `supplemental_action_ids` de v3 se siguen leyendo para diagnosticar la
 * migración, pero v4 no los incorpora al custom goal. Cada cohorte y etapa usa
 * un goal inmutable e inequívoco con exactamente una señal canónica.
 */
function normalizeConfiguredAccounts(configuredAccounts) {
  if (!Array.isArray(configuredAccounts) || configuredAccounts.length === 0) {
    throw runtimeError('GOAL_POLICY_ACCOUNTS_REQUIRED', 'Debe indicarse al menos una cuenta Google Ads', 400);
  }
  const seenCohorts = new Set();
  const campaignOwnersByCustomer = new Map();
  return configuredAccounts.map((raw, index) => {
    const customerId = cleanCustomerId(raw?.customer_id ?? raw?.customerId);
    if (!customerId) {
      throw runtimeError(
        'GOAL_POLICY_CUSTOMER_ID_INVALID',
        `La cuenta ${index + 1} no tiene un customer_id de 10 dígitos`,
        400,
      );
    }
    const strategyRef = cleanString(raw?.strategy_ref ?? raw?.strategyRef ?? raw?.strategy_id ?? raw?.strategyId);
    if (!strategyRef) {
      throw runtimeError(
        'GOAL_POLICY_STRATEGY_REF_REQUIRED',
        `La cuenta ${customerId} necesita una referencia explícita a la estrategia`,
        400,
      );
    }
    const cohortIdentity = `${customerId}:${strategyRef}`;
    if (seenCohorts.has(cohortIdentity)) {
      throw runtimeError(
        'GOAL_POLICY_COHORT_DUPLICATE',
        `La cohorte ${strategyRef} de la cuenta ${customerId} aparece repetida`,
        400,
      );
    }
    seenCohorts.add(cohortIdentity);
    const campaignIds = sortedUniqueIds(raw?.campaign_ids ?? raw?.campaignIds, {
      label: `Las campañas de ${customerId}`,
      maximum: MAX_CAMPAIGNS_PER_ACCOUNT,
    });
    if (!campaignIds.length) {
      throw runtimeError(
        'GOAL_POLICY_CAMPAIGNS_REQUIRED',
        `La cuenta ${customerId} no tiene campañas asociadas explícitamente a la estrategia`,
        400,
      );
    }
    const campaignOwners = campaignOwnersByCustomer.get(customerId) || new Map();
    const overlappingCampaigns = campaignIds.filter((campaignId) => campaignOwners.has(campaignId));
    if (overlappingCampaigns.length) {
      throw runtimeError(
        'GOAL_POLICY_CAMPAIGN_COHORT_OVERLAP',
        `Las campañas ${overlappingCampaigns.join(', ')} de ${customerId} pertenecen a más de una cohorte`,
        400,
      );
    }
    campaignIds.forEach((campaignId) => campaignOwners.set(campaignId, strategyRef));
    campaignOwnersByCustomer.set(customerId, campaignOwners);
    const actionIds = normalizeCanonicalActionIds(
      raw?.canonical_action_ids ?? raw?.canonicalActionIds ?? raw?.canonical_actions,
      customerId,
    );
    const supplementalActionIds = normalizeSupplementalActionIds(
      raw?.supplemental_action_ids ?? raw?.supplementalActionIds,
      customerId,
      actionIds,
    );
    const biddingSelection = normalizeBiddingSelection(
      raw?.bidding_action_key
        ?? raw?.biddingActionKey
        ?? raw?.policy_stage
        ?? raw?.policyStage
        ?? raw?.bidding_action_keys
        ?? raw?.biddingActionKeys,
      customerId,
    );
    const cohort = cohortKey({ strategyRef, campaignIds });
    return {
      customer_id: customerId,
      strategy_key: STRATEGY_KEY,
      strategy_ref: strategyRef,
      campaign_ids: campaignIds,
      canonical_action_ids: actionIds,
      bidding_action_key: biddingSelection.bidding_action_key,
      bidding_action_keys: biddingSelection.input_keys,
      policy_stage: biddingSelection.bidding_action_key,
      cohort_key: cohort,
      custom_goal_name: biddingSelection.bidding_action_key
        ? stageGoalName(biddingSelection.bidding_action_key, cohort)
        : null,
      migration_required: biddingSelection.migration_required || supplementalActionIds.length > 0,
      migration_reasons: [
        ...biddingSelection.migration_reasons,
        ...(supplementalActionIds.length ? ['SUPPLEMENTAL_BIDDING_ACTIONS_NOT_SUPPORTED'] : []),
      ],
      supplemental_action_ids: supplementalActionIds,
      owned_custom_goal_resource_name: normalizeOwnedGoalResource(
        customerId,
        raw?.owned_custom_goal_resource_name ?? raw?.ownedCustomGoalResourceName,
      ),
    };
  });
}

function providerObject(row, camelKey, snakeKey) {
  if (row?.[camelKey] && typeof row[camelKey] === 'object') return row[camelKey];
  if (row?.[snakeKey] && typeof row[snakeKey] === 'object') return row[snakeKey];
  return {};
}

function conversionActionFromRow(row) {
  const action = providerObject(row, 'conversionAction', 'conversion_action');
  const primary = action.primaryForGoal ?? action.primary_for_goal;
  return {
    id: cleanPositiveId(action.id),
    resource_name: cleanString(action.resourceName ?? action.resource_name),
    owner_customer: cleanString(action.ownerCustomer ?? action.owner_customer),
    name: cleanString(action.name) || '',
    type: cleanString(action.type)?.toUpperCase() || null,
    status: cleanString(action.status)?.toUpperCase() || null,
    counting_type: cleanString(action.countingType ?? action.counting_type)?.toUpperCase() || null,
    primary_for_goal: typeof primary === 'boolean' ? primary : null,
    category: cleanString(action.category)?.toUpperCase() || null,
    origin: cleanString(action.origin)?.toUpperCase() || null,
  };
}

function customGoalFromRow(row) {
  const goal = providerObject(row, 'customConversionGoal', 'custom_conversion_goal');
  return {
    id: cleanPositiveId(goal.id),
    resource_name: cleanString(goal.resourceName ?? goal.resource_name),
    name: cleanString(goal.name) || '',
    status: cleanString(goal.status)?.toUpperCase() || null,
    conversion_actions: Array.from(new Set(
      (Array.isArray(goal.conversionActions) ? goal.conversionActions : goal.conversion_actions || [])
        .map(cleanString)
        .filter(Boolean),
    )).sort(),
  };
}

function campaignConfigFromRow(row) {
  const config = providerObject(row, 'conversionGoalCampaignConfig', 'conversion_goal_campaign_config');
  const campaign = providerObject(row, 'campaign', 'campaign');
  const customGoal = providerObject(row, 'customConversionGoal', 'custom_conversion_goal');
  return {
    resource_name: cleanString(config.resourceName ?? config.resource_name),
    campaign_resource_name: cleanString(config.campaign),
    campaign_id: cleanPositiveId(campaign.id)
      || cleanPositiveId(String(config.campaign || '').split('/').pop()),
    campaign_name: cleanString(campaign.name),
    campaign_status: cleanString(campaign.status)?.toUpperCase() || null,
    advertising_channel_type: cleanString(campaign.advertisingChannelType ?? campaign.advertising_channel_type)?.toUpperCase() || null,
    advertising_channel_sub_type: cleanString(campaign.advertisingChannelSubType ?? campaign.advertising_channel_sub_type)?.toUpperCase() || null,
    goal_config_level: cleanString(config.goalConfigLevel ?? config.goal_config_level)?.toUpperCase() || null,
    custom_conversion_goal: cleanString(config.customConversionGoal ?? config.custom_conversion_goal),
    custom_goal_name: cleanString(customGoal.name),
    custom_goal_status: cleanString(customGoal.status)?.toUpperCase() || null,
  };
}

function campaignGoalFromRow(row) {
  const goal = providerObject(row, 'campaignConversionGoal', 'campaign_conversion_goal');
  const campaign = providerObject(row, 'campaign', 'campaign');
  return {
    resource_name: cleanString(goal.resourceName ?? goal.resource_name),
    campaign_id: cleanPositiveId(campaign.id)
      || cleanPositiveId(String(goal.campaign || '').split('/').pop()),
    campaign_name: cleanString(campaign.name),
    category: cleanString(goal.category)?.toUpperCase() || null,
    origin: cleanString(goal.origin)?.toUpperCase() || null,
    // En el JSON protobuf de Google, los escalares con su valor por defecto
    // se omiten. Como esta consulta selecciona expresamente `biddable`, la
    // ausencia del campo significa `false`, no “estado desconocido”.
    biddable: goal.biddable === true,
  };
}

function customerGoalFromRow(row) {
  const goal = providerObject(row, 'customerConversionGoal', 'customer_conversion_goal');
  return {
    resource_name: cleanString(goal.resourceName ?? goal.resource_name),
    category: cleanString(goal.category)?.toUpperCase() || null,
    origin: cleanString(goal.origin)?.toUpperCase() || null,
    biddable: goal.biddable === true,
  };
}

function conversionTrackingFromRows(rows, customerId) {
  const customer = providerObject(Array.isArray(rows) ? rows[0] : null, 'customer', 'customer');
  const settings = customer.conversionTrackingSetting || customer.conversion_tracking_setting || {};
  const resourceName = cleanString(settings.googleAdsConversionCustomer ?? settings.google_ads_conversion_customer)
    || `customers/${customerId}`;
  return {
    customer_id: cleanPositiveId(customer.id) || customerId,
    google_ads_conversion_customer: resourceName,
    conversion_customer_id: cleanCustomerId(resourceName),
    conversion_tracking_status: cleanString(settings.conversionTrackingStatus ?? settings.conversion_tracking_status)?.toUpperCase() || null,
  };
}


function blocker(code, message, data = {}) {
  return { code, message, ...data };
}

function canonicalActionState(account, snapshot, blockers) {
  const actions = Array.isArray(snapshot.conversion_actions) ? snapshot.conversion_actions : [];
  const result = {};
  for (const key of ALL_CANONICAL_KEYS) {
    const definition = CANONICAL_ACTIONS[key];
    const configuredId = account.canonical_action_ids[key];
    const nameMatches = actions.filter((action) => action.name === definition.name);
    const configuredMatch = configuredId
      ? actions.find((action) => action.id === configuredId) || null
      : null;
    if (nameMatches.length > 1) {
      blockers.push(blocker(
        'CANONICAL_ACTION_NAME_AMBIGUOUS',
        `Hay más de una acción llamada ${definition.name}`,
        { action_key: key, action_ids: nameMatches.map((action) => action.id) },
      ));
    }
    if (!configuredId) {
      blockers.push(blocker(
        'CANONICAL_ACTION_ID_REQUIRED',
        `${definition.name} necesita un ID canónico explícito en ${account.customer_id}`,
        { action_key: key },
      ));
    }
    if (configuredId && !configuredMatch) {
      blockers.push(blocker(
        'CANONICAL_ACTION_NOT_FOUND',
        `No existe el ID configurado para ${definition.name}`,
        { action_key: key, action_id: configuredId },
      ));
    }
    if (configuredMatch && configuredMatch.name !== definition.name) {
      blockers.push(blocker(
        'CANONICAL_ACTION_ID_NAME_MISMATCH',
        `El ID configurado para ${definition.name} pertenece a otra acción`,
        { action_key: key, action_id: configuredId, observed_name: configuredMatch.name },
      ));
    }
    const action = configuredMatch && configuredMatch.name === definition.name
      ? configuredMatch
      : (nameMatches.length === 1 ? nameMatches[0] : null);
    result[key] = {
      key,
      expected_name: definition.name,
      configured_id: configuredId,
      action,
      included_in_goal: account.bidding_action_key === key,
    };
    if (!action || !configuredId) continue;
    const expectedResource = actionResourceName(account.customer_id, configuredId);
    for (const issue of [
      action.id !== configuredId
        ? blocker('CANONICAL_ACTION_SELECTOR_MISMATCH', `${definition.name} no coincide con el ID autorizado`, { action_key: key })
        : null,
      action.resource_name !== expectedResource || action.owner_customer !== `customers/${account.customer_id}`
        ? blocker('CANONICAL_ACTION_ACCOUNT_MISMATCH', `${definition.name} no pertenece inequívocamente a la cuenta`, { action_key: key })
        : null,
      action.type !== 'UPLOAD_CLICKS'
        ? blocker('CANONICAL_ACTION_TYPE_INVALID', `${definition.name} no es UPLOAD_CLICKS`, { action_key: key, observed: action.type })
        : null,
      action.status !== 'ENABLED'
        ? blocker('CANONICAL_ACTION_NOT_ENABLED', `${definition.name} no está ENABLED`, { action_key: key, observed: action.status })
        : null,
      action.counting_type !== 'MANY_PER_CLICK'
        ? blocker('CANONICAL_ACTION_COUNTING_TYPE_INVALID', `${definition.name} debe usar MANY_PER_CLICK`, { action_key: key, observed: action.counting_type })
        : null,
      action.primary_for_goal !== false
        ? blocker('CANONICAL_ACTION_NOT_SECONDARY', `${definition.name} debe seguir globalmente como secundaria`, { action_key: key, observed: action.primary_for_goal })
        : null,
    ].filter(Boolean)) blockers.push(issue);
  }
  return result;
}

function supplementalActionState(account, snapshot, blockers) {
  const providerActions = Array.isArray(snapshot.conversion_actions) ? snapshot.conversion_actions : [];
  const items = [];
  const validResourceNames = [];
  for (const actionId of account.supplemental_action_ids || []) {
    const matches = providerActions.filter((action) => action.id === actionId);
    if (matches.length !== 1) {
      blockers.push(blocker(
        matches.length ? 'SUPPLEMENTAL_ACTION_ID_AMBIGUOUS' : 'SUPPLEMENTAL_ACTION_NOT_FOUND',
        matches.length
          ? `Google devolvió más de una acción con ID ${actionId}`
          : `No existe la acción suplementaria ${actionId}`,
        { action_id: actionId },
      ));
      items.push({ action_id: actionId, action: null, valid: false });
      continue;
    }
    const action = matches[0];
    const itemBlockers = [];
    const expectedResource = actionResourceName(account.customer_id, actionId);
    if (action.name === CANONICAL_ACTIONS.purchase.name) {
      itemBlockers.push(blocker(
        'SUPPLEMENTAL_ACTION_PURCHASE_FORBIDDEN',
        'Purchase nunca puede formar parte de las acciones suplementarias',
        { action_id: actionId },
      ));
    } else if (CANONICAL_BY_NAME.has(action.name)) {
      itemBlockers.push(blocker(
        'SUPPLEMENTAL_ACTION_CANONICAL_NAME_FORBIDDEN',
        'Una acción con nombre canónico no puede entrar por la allowlist suplementaria',
        { action_id: actionId, action_name: action.name },
      ));
    }
    if (action.resource_name !== expectedResource || action.owner_customer !== `customers/${account.customer_id}`) {
      itemBlockers.push(blocker(
        'SUPPLEMENTAL_ACTION_ACCOUNT_MISMATCH',
        `La acción suplementaria ${actionId} no pertenece inequívocamente a la cuenta`,
        { action_id: actionId },
      ));
    }
    if (action.status !== 'ENABLED') {
      itemBlockers.push(blocker(
        'SUPPLEMENTAL_ACTION_NOT_ENABLED',
        `La acción suplementaria ${actionId} no está ENABLED`,
        { action_id: actionId, observed: action.status },
      ));
    }
    if (action.type !== 'AD_CALL') {
      itemBlockers.push(blocker(
        'SUPPLEMENTAL_ACTION_TYPE_NOT_ALLOWED',
        `La acción suplementaria ${actionId} es ${action.type || 'de tipo desconocido'}; solo se admite AD_CALL`,
        { action_id: actionId, observed: action.type, allowed_types: ['AD_CALL'] },
      ));
    }
    blockers.push(...itemBlockers);
    const valid = itemBlockers.length === 0;
    if (valid) validResourceNames.push(action.resource_name);
    items.push({
      action_id: actionId,
      action,
      valid,
      blockers: itemBlockers,
      included_in_goal: false,
    });
  }
  return { items, valid_resource_names: validResourceNames };
}

function ownedGoalState(account, snapshot, desiredActions, supplementalActions, blockers) {
  const goals = Array.isArray(snapshot.custom_goals) ? snapshot.custom_goals : [];
  const expectedName = account.custom_goal_name;
  const nameMatches = expectedName ? goals.filter((goal) => goal.name === expectedName) : [];
  const legacyGoals = goals.filter((goal) => goal.name === GOAL_NAME);
  const ownedResource = account.owned_custom_goal_resource_name;
  let ownedGoal = ownedResource
    ? goals.find((goal) => goal.resource_name === ownedResource) || null
    : null;

  if (ownedResource && !ownedGoal) {
    blockers.push(blocker(
      'OWNED_CUSTOM_GOAL_NOT_FOUND',
      'El custom goal declarado como propio ya no existe o no es visible',
      { resource_name: ownedResource },
    ));
  }
  if (ownedGoal && ownedGoal.name === GOAL_NAME) {
    blockers.push(blocker(
      'LEGACY_CUSTOM_GOAL_MIGRATION_REQUIRED',
      'El recurso configurado usa el goal genérico v3; debe asignarse un goal nuevo y específico de etapa/cohorte',
      { resource_name: ownedGoal.resource_name, observed_name: ownedGoal.name },
    ));
  } else if (ownedGoal && ownedGoal.name !== expectedName) {
    blockers.push(blocker(
      'OWNED_CUSTOM_GOAL_NAME_MISMATCH',
      'El recurso declarado como propio pertenece a otra etapa o cohorte y no se sobrescribirá',
      { resource_name: ownedGoal.resource_name, observed_name: ownedGoal.name, expected_name: expectedName },
    ));
  }
  if (legacyGoals.length && !legacyGoals.some((goal) => goal.resource_name === ownedResource)) {
    blockers.push(blocker(
      'LEGACY_CUSTOM_GOAL_MIGRATION_REQUIRED',
      'Existe un goal genérico v3; no se reutilizará ni modificará silenciosamente',
      { resource_names: legacyGoals.map((goal) => goal.resource_name) },
    ));
  }
  const foreignNameCollisions = nameMatches.filter((goal) => goal.resource_name !== ownedResource);
  if (foreignNameCollisions.length) {
    blockers.push(blocker(
      'CUSTOM_GOAL_NAME_COLLISION_UNOWNED',
      'Ya existe un custom goal con el nombre reservado, pero no consta como propiedad de ClinicaClick',
      { resource_names: foreignNameCollisions.map((goal) => goal.resource_name) },
    ));
  }
  if (!ownedResource && nameMatches.length) {
    ownedGoal = null;
  }
  if (ownedGoal && ownedGoal.status !== 'ENABLED') {
    blockers.push(blocker(
      'OWNED_CUSTOM_GOAL_NOT_ENABLED',
      'El custom goal de ClinicaClick no está ENABLED y no se reactivará automáticamente',
      { resource_name: ownedGoal.resource_name, status: ownedGoal.status },
    ));
  }

  const desiredResourceNames = account.bidding_action_key
    ? [desiredActions[account.bidding_action_key]?.action?.resource_name].filter(Boolean)
    : [];
  return {
    owned_goal: ownedGoal,
    goal_resource_for_plan: ownedGoal?.resource_name || NEW_GOAL_PLACEHOLDER,
    desired_conversion_actions: desiredResourceNames,
    name_collisions: nameMatches,
    legacy_goals: legacyGoals,
  };
}

function isSmartCampaign(config) {
  return config?.advertising_channel_type === 'SMART'
    || String(config?.advertising_channel_sub_type || '').includes('SMART');
}

function configuredCampaignState(account, snapshot, goalState, blockers) {
  const allConfigs = Array.isArray(snapshot.campaign_configs) ? snapshot.campaign_configs : [];
  const configured = [];
  const operations = [];
  for (const campaignId of account.campaign_ids) {
    const matches = allConfigs.filter((item) => item.campaign_id === campaignId);
    if (matches.length !== 1) {
      blockers.push(blocker(
        matches.length ? 'CAMPAIGN_CONFIG_AMBIGUOUS' : 'CAMPAIGN_CONFIG_NOT_FOUND',
        matches.length
          ? `Google devolvió varias configuraciones para la campaña ${campaignId}`
          : `La campaña asociada ${campaignId} no existe o no admite configuración de objetivos`,
        { campaign_id: campaignId },
      ));
      configured.push({ campaign_id: campaignId, found: false });
      continue;
    }
    const current = matches[0];
    const expectedResource = campaignConfigResourceName(account.customer_id, campaignId);
    if (
      current.resource_name !== expectedResource
      || current.campaign_resource_name !== campaignResourceName(account.customer_id, campaignId)
    ) {
      blockers.push(blocker(
        'CAMPAIGN_CONFIG_ACCOUNT_MISMATCH',
        `La configuración de la campaña ${campaignId} no pertenece inequívocamente a la cuenta`,
        { campaign_id: campaignId },
      ));
    }
    const smartCampaign = isSmartCampaign(current);
    if (smartCampaign) {
      blockers.push(blocker(
        'SMART_CAMPAIGN_OBSERVE_ONLY',
        `La campaña Smart ${campaignId} solo se audita; Google no permite aplicar esta policy de custom goal con garantías`,
        {
          campaign_id: campaignId,
          advertising_channel_type: current.advertising_channel_type,
          advertising_channel_sub_type: current.advertising_channel_sub_type,
        },
      ));
    }
    const currentGoal = current.custom_conversion_goal;
    const ownedResource = goalState.owned_goal?.resource_name || null;
    if (currentGoal && currentGoal !== ownedResource) {
      blockers.push(blocker(
        'CAMPAIGN_USES_FOREIGN_CUSTOM_GOAL',
        `La campaña ${campaignId} ya usa un custom goal ajeno y no se sobrescribirá`,
        { campaign_id: campaignId, custom_conversion_goal: currentGoal },
      ));
    }
    const changed = currentGoal !== goalState.goal_resource_for_plan;
    configured.push({ ...current, found: true, changed });
    if (changed && !smartCampaign) {
      operations.push({
        update: {
          resourceName: expectedResource,
          customConversionGoal: goalState.goal_resource_for_plan,
        },
        updateMask: 'custom_conversion_goal',
      });
    }
  }

  const outsideOptIn = goalState.owned_goal
    ? allConfigs.filter((item) => (
        item.custom_conversion_goal === goalState.owned_goal.resource_name
        && !account.campaign_ids.includes(item.campaign_id)
      ))
    : [];
  if (outsideOptIn.length) {
    blockers.push(blocker(
      'OWNED_GOAL_ATTACHED_OUTSIDE_STRATEGY',
      'El custom goal de ClinicaClick está asociado a campañas fuera del alcance explícito; no se tocarán automáticamente',
      { campaign_ids: outsideOptIn.map((item) => item.campaign_id) },
    ));
  }
  return { configured, operations, outside_opt_in: outsideOptIn };
}

function campaignConversionGoalState(account, snapshot, blockers) {
  const providerGoals = Array.isArray(snapshot.campaign_conversion_goals)
    ? snapshot.campaign_conversion_goals
    : [];
  const before = [];
  const operations = [];
  const rollbackOperations = [];
  const smartCampaignIds = new Set(
    (Array.isArray(snapshot.campaign_configs) ? snapshot.campaign_configs : [])
      .filter(isSmartCampaign)
      .map((config) => config.campaign_id),
  );
  for (const campaignId of account.campaign_ids) {
    const rows = providerGoals.filter((goal) => goal.campaign_id === campaignId);
    if (!rows.length) {
      blockers.push(blocker(
        'CAMPAIGN_CONVERSION_GOALS_NOT_FOUND',
        `No se pudieron enumerar todos los objetivos actuales de la campaña ${campaignId}`,
        { campaign_id: campaignId },
      ));
      continue;
    }
    const seenPairs = new Set();
    const seenResources = new Set();
    for (const goal of rows) {
      const pair = `${goal.category || ''}:${goal.origin || ''}`;
      const expectedResource = goal.category && goal.origin
        ? campaignConversionGoalResourceName(
            account.customer_id,
            campaignId,
            goal.category,
            goal.origin,
          )
        : null;
      if (
        !goal.category
        || !goal.origin
        || !expectedResource
        || goal.resource_name !== expectedResource
        || seenPairs.has(pair)
        || seenResources.has(goal.resource_name)
      ) {
        blockers.push(blocker(
          'CAMPAIGN_CONVERSION_GOAL_AMBIGUOUS',
          `La campaña ${campaignId} contiene un objetivo incompleto, duplicado o ajeno`,
          {
            campaign_id: campaignId,
            resource_name: goal.resource_name || null,
            category: goal.category || null,
            origin: goal.origin || null,
          },
        ));
        continue;
      }
      seenPairs.add(pair);
      seenResources.add(goal.resource_name);
      if (typeof goal.biddable !== 'boolean') {
        blockers.push(blocker(
          'CAMPAIGN_CONVERSION_GOAL_BIDDABLE_UNKNOWN',
          `Google no devolvió el estado biddable de un objetivo de ${campaignId}`,
          { campaign_id: campaignId, resource_name: goal.resource_name },
        ));
        continue;
      }
      before.push({
        campaign_id: campaignId,
        resource_name: goal.resource_name,
        category: goal.category,
        origin: goal.origin,
        biddable: goal.biddable,
      });
      if (goal.biddable !== true || smartCampaignIds.has(campaignId)) continue;
      operations.push({
        update: {
          resourceName: goal.resource_name,
          biddable: false,
        },
        updateMask: 'biddable',
      });
      rollbackOperations.push({
        update: {
          resourceName: goal.resource_name,
          biddable: true,
        },
        updateMask: 'biddable',
      });
    }
  }
  before.sort((left, right) => left.resource_name.localeCompare(right.resource_name));
  operations.sort((left, right) => left.update.resourceName.localeCompare(right.update.resourceName));
  rollbackOperations.sort((left, right) => left.update.resourceName.localeCompare(right.update.resourceName));
  return {
    before,
    operations,
    rollback_operations: rollbackOperations,
  };
}

function buildClinicaclickGoalPolicyPlan({ account, snapshot }) {
  const blockers = [];
  if (account.migration_required) {
    blockers.push(blocker(
      'GOAL_POLICY_MIGRATION_REQUIRED',
      'La configuración pertenece al contrato v3 o intenta usar más de una señal; debe migrarse explícitamente antes de aplicar',
      { reasons: account.migration_reasons || [] },
    ));
  }
  if (!account.bidding_action_key || !BIDDING_SIGNAL_KEYS.includes(account.bidding_action_key)) {
    blockers.push(blocker(
      'GOAL_POLICY_SINGLE_BIDDING_SIGNAL_REQUIRED',
      'Cada policy/cohorte debe elegir exactamente una señal: qualified_lead, schedule o purchase',
      { observed: account.bidding_action_keys || [] },
    ));
  }
  const conversionTracking = snapshot?.conversion_tracking || {};
  if (conversionTracking.customer_id !== account.customer_id) {
    blockers.push(blocker(
      'SNAPSHOT_ACCOUNT_MISMATCH',
      'El snapshot no corresponde a la cuenta configurada',
      { observed_customer_id: conversionTracking.customer_id || null },
    ));
  }
  if (conversionTracking.conversion_customer_id !== account.customer_id) {
    blockers.push(blocker(
      'CROSS_ACCOUNT_CONVERSION_CUSTOMER_REQUIRES_EXPLICIT_SUPPORT',
      'La cuenta usa conversiones administradas por otra cuenta; no se mutará hasta mapearla explícitamente al scope',
      { conversion_customer_id: conversionTracking.conversion_customer_id || null },
    ));
  }

  const canonical = canonicalActionState(account, snapshot, blockers);
  const actions = Array.isArray(snapshot.conversion_actions) ? snapshot.conversion_actions : [];
  const supplemental = supplementalActionState(account, snapshot, blockers);
  const supplementalIds = new Set(account.supplemental_action_ids || []);
  const clientActions = actions.filter((action) => !CANONICAL_BY_NAME.has(action.name)).map((action) => ({
    ...action,
    supplemental_allowlisted: supplementalIds.has(action.id),
  }));
  const goalState = ownedGoalState(account, snapshot, canonical, supplemental, blockers);
  const campaignState = configuredCampaignState(account, snapshot, goalState, blockers);
  const campaignGoalState = campaignConversionGoalState(account, snapshot, blockers);
  const warnings = [];

  let goalOperation = null;
  if (!goalState.owned_goal) {
    goalOperation = {
      create: {
        name: account.custom_goal_name,
        conversionActions: goalState.desired_conversion_actions,
        status: 'ENABLED',
      },
    };
  } else if (stableStringify(goalState.owned_goal.conversion_actions) !== stableStringify(goalState.desired_conversion_actions.slice().sort())) {
    goalOperation = {
      update: {
        resourceName: goalState.owned_goal.resource_name,
        conversionActions: goalState.desired_conversion_actions,
      },
      updateMask: 'conversion_actions',
    };
  }

  const actionState = ALL_CANONICAL_KEYS.map((key) => {
    const entry = canonical[key];
    return {
      key,
      configured_id: entry.configured_id,
      action: entry.action,
      included_in_goal: entry.included_in_goal,
    };
  });
  actionState.push(...supplemental.items.map((item) => ({
    key: 'supplemental_ad_call',
    configured_id: item.action_id,
    action: item.action,
    included_in_goal: item.included_in_goal === true,
    valid: item.valid === true,
  })));
  const campaignStateForDigest = campaignState.configured.map((item) => ({
    campaign_id: item.campaign_id,
    resource_name: item.resource_name || null,
    campaign_status: item.campaign_status || null,
    advertising_channel_type: item.advertising_channel_type || null,
    advertising_channel_sub_type: item.advertising_channel_sub_type || null,
    goal_config_level: item.goal_config_level || null,
    custom_conversion_goal: item.custom_conversion_goal || null,
  }));
  campaignStateForDigest.push(...campaignGoalState.before.map((item) => ({
    campaign_id: item.campaign_id,
    campaign_conversion_goal: item.resource_name,
    category: item.category,
    origin: item.origin,
    biddable: item.biddable,
  })));
  const operations = {
    custom_goal: goalOperation,
    campaign_goal_configs: campaignState.operations,
    conversion_actions: [],
    campaign_conversion_goals: campaignGoalState.operations,
    customer_conversion_goals: [],
  };
  const rollback = {
    automatic: false,
    custom_goal_before: goalState.owned_goal
      ? {
          resource_name: goalState.owned_goal.resource_name,
          conversion_actions: goalState.owned_goal.conversion_actions,
          status: goalState.owned_goal.status,
        }
      : null,
    custom_goal_created_by_plan: !goalState.owned_goal,
    campaign_goal_configs_before: campaignState.configured.filter((item) => item.found).map((item) => ({
      campaign_id: item.campaign_id,
      resource_name: item.resource_name,
      goal_config_level: item.goal_config_level,
      custom_conversion_goal: item.custom_conversion_goal,
    })),
    campaign_conversion_goals_before: campaignGoalState.before,
    campaign_conversion_goal_operations: campaignGoalState.rollback_operations,
  };
  const planCore = {
    schema_version: SCHEMA_VERSION,
    customer_id: account.customer_id,
    strategy_key: account.strategy_key,
    strategy_ref: account.strategy_ref,
    policy_stage: account.policy_stage,
    cohort_key: account.cohort_key,
    configured_campaign_ids: account.campaign_ids,
    bidding_action_key: account.bidding_action_key,
    bidding_action_keys: account.bidding_action_keys,
    supplemental_action_ids: account.supplemental_action_ids,
    owned_custom_goal_resource_name: account.owned_custom_goal_resource_name,
    desired_custom_goal: {
      name: account.custom_goal_name,
      conversion_actions: goalState.desired_conversion_actions,
      required_canonical_action_keys: account.bidding_action_key ? [account.bidding_action_key] : [],
      tracked_canonical_action_keys: DESIRED_ACTION_KEYS,
      observation_only_action_keys: OBSERVATION_ACTION_KEYS,
      supplemental_action_ids: [],
      single_bidding_signal: true,
      purchase_included: account.bidding_action_key === 'purchase',
      legacy_generic_goal_forbidden: true,
    },
    observed_custom_goal: goalState.owned_goal,
    outside_opt_in_campaigns: campaignState.outside_opt_in.map((item) => item.campaign_id),
    operations,
    rollback,
    blockers,
    warnings,
    migration: {
      required: account.migration_required || goalState.legacy_goals.length > 0,
      reasons: account.migration_reasons || [],
      legacy_custom_goal_resources: goalState.legacy_goals.map((goal) => goal.resource_name),
    },
  };
  return {
    ...planCore,
    ready: blockers.length === 0,
    apply_allowed: blockers.length === 0,
    observe_only: blockers.some((item) => item.code === 'SMART_CAMPAIGN_OBSERVE_ONLY'),
    changed: !!goalOperation || campaignState.operations.length > 0 || campaignGoalState.operations.length > 0,
    action_state_digest: sha256(stableStringify(actionState)),
    campaign_state_digest: sha256(stableStringify(campaignStateForDigest)),
    custom_goal_state_digest: sha256(stableStringify(snapshot.custom_goals || [])),
    plan_digest: sha256(stableStringify(planCore)),
    canonical_actions: canonical,
    supplemental_actions: supplemental.items,
    client_actions: clientActions,
    configured_campaigns: campaignState.configured,
    current_customer_conversion_goals: snapshot.customer_conversion_goals || [],
    current_campaign_conversion_goals: snapshot.campaign_conversion_goals || [],
    current_custom_goals: snapshot.custom_goals || [],
  };
}


function assertSafePlanOperations(account, plan) {
  if (!plan?.ready) {
    throw runtimeError('GOAL_POLICY_PLAN_BLOCKED', 'El plan contiene bloqueos y no puede aplicarse', 409);
  }
  if (
    !account.bidding_action_key
    || !BIDDING_SIGNAL_KEYS.includes(account.bidding_action_key)
    || account.migration_required
    || plan.desired_custom_goal?.name !== account.custom_goal_name
    || plan.desired_custom_goal?.name === GOAL_NAME
    || plan.desired_custom_goal?.single_bidding_signal !== true
    || plan.desired_custom_goal?.legacy_generic_goal_forbidden !== true
  ) {
    throw runtimeError('GOAL_POLICY_PLAN_NOT_CANONICAL', 'El plan no conserva el contrato canónico', 403);
  }
  const desired = plan.desired_custom_goal.conversion_actions || [];
  const expectedDesired = [
    actionResourceName(account.customer_id, account.canonical_action_ids[account.bidding_action_key]),
  ];
  if (
    desired.length !== expectedDesired.length
    || stableStringify(desired.slice().sort()) !== stableStringify(expectedDesired.slice().sort())
  ) {
    throw runtimeError(
      'GOAL_POLICY_MEMBERSHIP_INVALID',
      'El custom goal no contiene exactamente la única señal canónica aprobada',
      403,
    );
  }
  if (desired.length !== 1 || !desired.includes(expectedDesired[0])) {
    throw runtimeError('GOAL_POLICY_MEMBERSHIP_INVALID', `Falta ${CANONICAL_ACTIONS[account.bidding_action_key].name}`, 403);
  }
  for (const key of OBSERVATION_ACTION_KEYS) {
    const resourceName = actionResourceName(account.customer_id, account.canonical_action_ids[key]);
    if (desired.includes(resourceName)) {
      throw runtimeError('GOAL_POLICY_OBSERVATION_ACTION_INCLUDED', `${CANONICAL_ACTIONS[key].name} debe ser solo observación`, 403);
    }
  }
  if ((account.supplemental_action_ids || []).length || (plan.desired_custom_goal.supplemental_action_ids || []).length) {
    throw runtimeError('GOAL_POLICY_SUPPLEMENTAL_ACTION_NOT_SAFE', 'La policy v4 no admite señales suplementarias de puja', 403);
  }
  if ((plan.operations?.conversion_actions || []).length
    || (plan.operations?.customer_conversion_goals || []).length) {
    throw runtimeError('GOAL_POLICY_FORBIDDEN_OPERATION', 'El plan intenta modificar objetivos o acciones fuera del contrato', 403);
  }
  const goalOperation = plan.operations?.custom_goal;
  if (goalOperation) {
    const allowed = goalOperation.create || goalOperation.update;
    const keys = Object.keys(goalOperation).sort();
    if (!allowed || keys.some((key) => !['create', 'update', 'updateMask'].includes(key))) {
      throw runtimeError('GOAL_POLICY_CUSTOM_GOAL_OPERATION_INVALID', 'La operación del custom goal no es segura', 403);
    }
    if (goalOperation.create) {
      if (
        goalOperation.create.name !== account.custom_goal_name
        || goalOperation.create.status !== 'ENABLED'
        || stableStringify(goalOperation.create.conversionActions) !== stableStringify(desired)
      ) {
        throw runtimeError('GOAL_POLICY_CUSTOM_GOAL_OPERATION_INVALID', 'La creación del custom goal no es canónica', 403);
      }
    } else if (
      goalOperation.updateMask !== 'conversion_actions'
      || goalOperation.update.resourceName !== account.owned_custom_goal_resource_name
      || !goalResourcePattern(account.customer_id).test(goalOperation.update.resourceName)
      || stableStringify(goalOperation.update.conversionActions) !== stableStringify(desired)
    ) {
      throw runtimeError('GOAL_POLICY_CUSTOM_GOAL_OPERATION_INVALID', 'La actualización del custom goal no es canónica', 403);
    }
  }
  if ((plan.configured_campaigns || []).some((campaign) => (
    campaign.advertising_channel_type === 'SMART'
    || String(campaign.advertising_channel_sub_type || '').includes('SMART')
  ))) {
    throw runtimeError('SMART_CAMPAIGN_OBSERVE_ONLY', 'Las campañas Smart son solo observación', 403);
  }
  const allowedCampaigns = new Set(account.campaign_ids);
  for (const operation of plan.operations?.campaign_goal_configs || []) {
    const update = operation?.update || {};
    const campaignId = cleanPositiveId(String(update.resourceName || '').split('/').pop());
    const fields = Object.keys(update).sort();
    if (
      operation.updateMask !== 'custom_conversion_goal'
      || !campaignId
      || !allowedCampaigns.has(campaignId)
      || update.resourceName !== campaignConfigResourceName(account.customer_id, campaignId)
      || ![NEW_GOAL_PLACEHOLDER, account.owned_custom_goal_resource_name].filter(Boolean)
        .includes(update.customConversionGoal)
      || fields.join(',') !== 'customConversionGoal,resourceName'
    ) {
      throw runtimeError(
        'GOAL_POLICY_CAMPAIGN_OPERATION_OUT_OF_SCOPE',
        'El plan intenta modificar una campaña no asociada explícitamente',
        403,
      );
    }
  }
  const observedCampaignGoalResources = new Set(
    (plan.current_campaign_conversion_goals || [])
      .filter((goal) => allowedCampaigns.has(goal.campaign_id))
      .map((goal) => goal.resource_name),
  );
  for (const operation of plan.operations?.campaign_conversion_goals || []) {
    const update = operation?.update || {};
    const match = String(update.resourceName || '').match(
      new RegExp(`^customers/${account.customer_id}/campaignConversionGoals/(\\d+)~([A-Z_]+)~([A-Z_]+)$`),
    );
    const fields = Object.keys(update).sort();
    if (
      operation.updateMask !== 'biddable'
      || !match
      || !allowedCampaigns.has(match[1])
      || !observedCampaignGoalResources.has(update.resourceName)
      || update.biddable !== false
      || fields.join(',') !== 'biddable,resourceName'
    ) {
      throw runtimeError(
        'GOAL_POLICY_CAMPAIGN_CONVERSION_GOAL_OUT_OF_SCOPE',
        'El plan intenta cambiar un objetivo de campaña fuera del alcance explícito',
        403,
      );
    }
  }
}


module.exports = { cleanCustomerId, cleanPositiveId, cleanString, objectValue, sortedUniqueIds, stableValue, stableStringify, sha256, cohortKey, stageGoalName, goalResourcePattern, actionResourceName, campaignResourceName, campaignConfigResourceName, campaignConversionGoalResourceName, normalizeOwnedGoalResource, normalizeCanonicalActionIds, normalizeSupplementalActionIds, normalizeBiddingSelection, normalizeConfiguredAccounts, providerObject, conversionActionFromRow, customGoalFromRow, campaignConfigFromRow, campaignGoalFromRow, customerGoalFromRow, conversionTrackingFromRows, blocker, canonicalActionState, supplementalActionState, ownedGoalState, isSmartCampaign, configuredCampaignState, campaignConversionGoalState, buildClinicaclickGoalPolicyPlan, assertSafePlanOperations, SCHEMA_VERSION, GOAL_NAME, GOAL_NAME_PREFIX, STRATEGY_KEY, OBSERVATION_ACTION_KEYS, BIDDING_SIGNAL_KEYS, ALL_CANONICAL_KEYS, DESIRED_ACTION_KEYS, CANONICAL_ACTIONS, STAGE_LABELS, CANONICAL_BY_NAME, MAX_CAMPAIGNS_PER_ACCOUNT, MAX_SUPPLEMENTAL_ACTIONS_PER_ACCOUNT, MAX_DIAGNOSTIC_ROWS, DEFAULT_DIAGNOSTIC_FRESHNESS_HOURS, NEW_GOAL_PLACEHOLDER };

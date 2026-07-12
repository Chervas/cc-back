'use strict';

// Contrato oficial de objetivos por campaña y custom goals:
// https://developers.google.com/google-ads/api/docs/conversions/goals/campaign-goals
// Los tres mutates usados abajo admiten validate_only en Google Ads API v21.

const crypto = require('node:crypto');
const db = require('../../models');
const { googleAdsRequest, normalizeCustomerId } = require('../lib/googleAdsClient');
const notificationsService = require('./notifications.service');
const {
  GOOGLE_ADS_SCOPE,
  resolveScopedGoogleAdsRuntime,
  runtimeError,
} = require('./googleAdsScopedRuntime.service');

const SCHEMA_VERSION = 'clinicaclick-google-ads-conversion-goal-policy/v1';
const GOAL_NAME = 'Clinicaclick · Captar nuevos pacientes';
const STRATEGY_KEY = 'new_patients';
const DESIRED_ACTION_KEYS = Object.freeze(['lead', 'contact', 'schedule']);
const ALL_CANONICAL_KEYS = Object.freeze([...DESIRED_ACTION_KEYS, 'purchase']);
const CANONICAL_ACTIONS = Object.freeze({
  lead: Object.freeze({ key: 'lead', name: 'Lead - ClinicaClick' }),
  contact: Object.freeze({ key: 'contact', name: 'Contact - ClinicaClick' }),
  schedule: Object.freeze({ key: 'schedule', name: 'Schedule - ClinicaClick' }),
  purchase: Object.freeze({ key: 'purchase', name: 'Purchase - ClinicaClick' }),
});
const CANONICAL_BY_NAME = new Map(
  Object.values(CANONICAL_ACTIONS).map((item) => [item.name, item]),
);
const MAX_CAMPAIGNS_PER_ACCOUNT = 200;
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
    if (!id && DESIRED_ACTION_KEYS.includes(key)) {
      throw runtimeError(
        'CANONICAL_ACTION_ID_REQUIRED',
        `${CANONICAL_ACTIONS[key].name} necesita un ID canónico explícito en ${customerId}`,
        400,
      );
    }
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

function normalizeConfiguredAccounts(configuredAccounts) {
  if (!Array.isArray(configuredAccounts) || configuredAccounts.length === 0) {
    throw runtimeError('GOAL_POLICY_ACCOUNTS_REQUIRED', 'Debe indicarse al menos una cuenta Google Ads', 400);
  }
  const seen = new Set();
  return configuredAccounts.map((raw, index) => {
    const customerId = cleanCustomerId(raw?.customer_id ?? raw?.customerId);
    if (!customerId) {
      throw runtimeError(
        'GOAL_POLICY_CUSTOMER_ID_INVALID',
        `La cuenta ${index + 1} no tiene un customer_id de 10 dígitos`,
        400,
      );
    }
    if (seen.has(customerId)) {
      throw runtimeError('GOAL_POLICY_CUSTOMER_DUPLICATE', `La cuenta ${customerId} aparece repetida`, 400);
    }
    seen.add(customerId);
    const strategyRef = cleanString(raw?.strategy_ref ?? raw?.strategyRef ?? raw?.strategy_id ?? raw?.strategyId);
    if (!strategyRef) {
      throw runtimeError(
        'GOAL_POLICY_STRATEGY_REF_REQUIRED',
        `La cuenta ${customerId} necesita una referencia explícita a la estrategia`,
        400,
      );
    }
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
    const actionIds = normalizeCanonicalActionIds(
      raw?.canonical_action_ids ?? raw?.canonicalActionIds ?? raw?.canonical_actions,
      customerId,
    );
    return {
      customer_id: customerId,
      strategy_key: STRATEGY_KEY,
      strategy_ref: strategyRef,
      campaign_ids: campaignIds,
      canonical_action_ids: actionIds,
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

async function fetchGoalPolicySnapshot({ runtime, account, request = googleAdsRequest }) {
  const campaignFilter = account.campaign_ids.join(', ');
  const trackingRows = await searchGoogleAds({
    runtime,
    request,
    query: [
      'SELECT',
      '  customer.id,',
      '  customer.conversion_tracking_setting.google_ads_conversion_customer,',
      '  customer.conversion_tracking_setting.conversion_tracking_status',
      'FROM customer',
    ].join('\n'),
  });
  const conversionActionRows = await searchGoogleAds({
    runtime,
    request,
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
  const customGoalRows = await searchGoogleAds({
    runtime,
    request,
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
  const campaignConfigRows = await searchGoogleAds({
    runtime,
    request,
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
      '  custom_conversion_goal.name,',
      '  custom_conversion_goal.status',
      'FROM conversion_goal_campaign_config',
      "WHERE campaign.status != 'REMOVED'",
    ].join('\n'),
  });
  const campaignGoalRows = await searchGoogleAds({
    runtime,
    request,
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
  const customerGoalRows = await searchGoogleAds({
    runtime,
    request,
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
      included_in_goal: DESIRED_ACTION_KEYS.includes(key),
    };
    if (!DESIRED_ACTION_KEYS.includes(key) || !action) continue;
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

function ownedGoalState(account, snapshot, desiredActions, blockers) {
  const goals = Array.isArray(snapshot.custom_goals) ? snapshot.custom_goals : [];
  const nameMatches = goals.filter((goal) => goal.name === GOAL_NAME);
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
  if (ownedGoal && ownedGoal.name !== GOAL_NAME) {
    blockers.push(blocker(
      'OWNED_CUSTOM_GOAL_NAME_MISMATCH',
      'El recurso declarado como propio tiene otro nombre y no se sobrescribirá',
      { resource_name: ownedGoal.resource_name, observed_name: ownedGoal.name },
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

  const desiredResourceNames = DESIRED_ACTION_KEYS.map((key) => desiredActions[key]?.action?.resource_name)
    .filter(Boolean);
  return {
    owned_goal: ownedGoal,
    goal_resource_for_plan: ownedGoal?.resource_name || NEW_GOAL_PLACEHOLDER,
    desired_conversion_actions: desiredResourceNames,
    name_collisions: nameMatches,
  };
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
    if (changed) {
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
      if (goal.biddable !== true) continue;
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
  const clientActions = actions.filter((action) => !CANONICAL_BY_NAME.has(action.name));
  const goalState = ownedGoalState(account, snapshot, canonical, blockers);
  const campaignState = configuredCampaignState(account, snapshot, goalState, blockers);
  const campaignGoalState = campaignConversionGoalState(account, snapshot, blockers);
  const warnings = [];

  let goalOperation = null;
  if (!goalState.owned_goal) {
    goalOperation = {
      create: {
        name: GOAL_NAME,
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
  const campaignStateForDigest = campaignState.configured.map((item) => ({
    campaign_id: item.campaign_id,
    resource_name: item.resource_name || null,
    campaign_status: item.campaign_status || null,
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
    configured_campaign_ids: account.campaign_ids,
    owned_custom_goal_resource_name: account.owned_custom_goal_resource_name,
    desired_custom_goal: {
      name: GOAL_NAME,
      conversion_actions: goalState.desired_conversion_actions,
      purchase_excluded: true,
    },
    observed_custom_goal: goalState.owned_goal,
    outside_opt_in_campaigns: campaignState.outside_opt_in.map((item) => item.campaign_id),
    operations,
    rollback,
    blockers,
    warnings,
  };
  return {
    ...planCore,
    ready: blockers.length === 0,
    changed: !!goalOperation || campaignState.operations.length > 0 || campaignGoalState.operations.length > 0,
    action_state_digest: sha256(stableStringify(actionState)),
    campaign_state_digest: sha256(stableStringify(campaignStateForDigest)),
    custom_goal_state_digest: sha256(stableStringify(snapshot.custom_goals || [])),
    plan_digest: sha256(stableStringify(planCore)),
    canonical_actions: canonical,
    client_actions: clientActions,
    configured_campaigns: campaignState.configured,
    current_customer_conversion_goals: snapshot.customer_conversion_goals || [],
    current_campaign_conversion_goals: snapshot.campaign_conversion_goals || [],
    current_custom_goals: snapshot.custom_goals || [],
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
    const snapshot = await fetchSnapshot({ runtime, account, request });
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

function assertSafePlanOperations(account, plan) {
  if (!plan?.ready) {
    throw runtimeError('GOAL_POLICY_PLAN_BLOCKED', 'El plan contiene bloqueos y no puede aplicarse', 409);
  }
  if (plan.desired_custom_goal?.name !== GOAL_NAME || plan.desired_custom_goal?.purchase_excluded !== true) {
    throw runtimeError('GOAL_POLICY_PLAN_NOT_CANONICAL', 'El plan no conserva el contrato canónico', 403);
  }
  const desired = plan.desired_custom_goal.conversion_actions || [];
  if (desired.length !== DESIRED_ACTION_KEYS.length) {
    throw runtimeError('GOAL_POLICY_MEMBERSHIP_INVALID', 'El custom goal debe contener exactamente tres acciones', 403);
  }
  const purchaseResource = account.canonical_action_ids.purchase
    ? actionResourceName(account.customer_id, account.canonical_action_ids.purchase)
    : null;
  if (purchaseResource && desired.includes(purchaseResource)) {
    throw runtimeError('GOAL_POLICY_PURCHASE_INCLUDED', 'Purchase no puede formar parte de este custom goal', 403);
  }
  for (const key of DESIRED_ACTION_KEYS) {
    if (!desired.includes(actionResourceName(account.customer_id, account.canonical_action_ids[key]))) {
      throw runtimeError('GOAL_POLICY_MEMBERSHIP_INVALID', `Falta ${CANONICAL_ACTIONS[key].name}`, 403);
    }
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
        goalOperation.create.name !== GOAL_NAME
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

  const goalOperation = plan.operations.custom_goal;
  const createsGoal = !!goalOperation?.create;
  let campaignOperations = plan.operations.campaign_goal_configs;
  const campaignConversionGoalOperations = plan.operations.campaign_conversion_goals;
  let goalResource = plan.observed_custom_goal?.resource_name || null;
  let externalMutationCount = 0;

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

  let ownershipPersisted = false;
  if (createsGoal && typeof dependencies.persistOwnership === 'function') {
    await dependencies.persistOwnership({
      scope,
      customer_id: account.customer_id,
      strategy_ref: account.strategy_ref,
      custom_goal_resource_name: goalResource,
    });
    ownershipPersisted = true;
  }

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

async function discoverGoalPolicyAuditTargets({ intakeModel = db.IntakeConfig } = {}) {
  const rows = await intakeModel.findAll({ raw: true });
  const targets = [];
  const issues = [];
  const seen = new Set();
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
        const key = `${scope.assignment_scope}:${scope.group_id || scope.clinic_id || 'missing'}:${account.customer_id}`;
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
  return { targets, issues };
}

async function executePersistedGoalPolicyAudit({ dependencies = {} } = {}) {
  const syncLogModel = dependencies.syncLogModel || db.SyncLog;
  const notify = dependencies.notifications || notificationsService;
  const discover = dependencies.discoverTargets || discoverGoalPolicyAuditTargets;
  const audit = dependencies.audit || auditClinicaclickGoalPolicy;
  const now = dependencies.now || (() => new Date());
  const syncLog = await syncLogModel.create({
    job_type: 'google_conversion_goal_policy_audit',
    status: 'running',
    start_time: now(),
    records_processed: 0,
  });
  try {
    const discovered = await discover({ intakeModel: dependencies.intakeModel || db.IntakeConfig });
    const reports = [];
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
    const criticalCount = issues.filter((item) => item.severity === 'critical').length;
    const statusReport = {
      schema_version: SCHEMA_VERSION,
      audited_at: now().toISOString(),
      autorepair: false,
      external_mutation_count: 0,
      target_count: (discovered.targets || []).length,
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
    };
    await syncLog.update({
      status: criticalCount ? 'failed' : 'completed',
      end_time: now(),
      records_processed: (discovered.targets || []).length,
      error_message: criticalCount ? `Se detectaron ${criticalCount} desviaciones críticas en objetivos Google Ads.` : null,
      status_report: statusReport,
    });
    if (criticalCount && typeof notify?.dispatchEvent === 'function') {
      await notify.dispatchEvent({
        event: 'jobs.failed',
        data: {
          jobName: 'Auditoría de objetivos de conversión Google Ads',
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
  CANONICAL_ACTIONS,
  DESIRED_ACTION_KEYS,
  GOAL_NAME,
  NEW_GOAL_PLACEHOLDER,
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
  stableStringify,
};

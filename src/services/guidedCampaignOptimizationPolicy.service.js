'use strict';

const crypto = require('node:crypto');
const db = require('../../models');
const { Op } = require('sequelize');
const {
  DEFAULT_THRESHOLDS,
  MODES,
  STAGES,
  normalizeThresholds,
} = require('./campaignOptimizationLifecycle.service');
const {
  SCHEMA_VERSION: GOAL_POLICY_SCHEMA_VERSION,
  applyClinicaclickGoalPolicy,
  normalizeConfiguredAccounts,
  previewClinicaclickGoalPolicy,
} = require('./googleAdsClinicaclickGoalPolicy.service');
const {
  persistGoalOwnership,
  resolveCanonicalActionIds,
} = require('./managedCampaignOptimizationPolicy.service');

const SCHEMA_VERSION = 'clinicaclick-guided-campaign-optimization/v1';
const AUTHORIZATION_VERSION = 1;
const REQUIRED_SCOPES = Object.freeze([
  'landing_publish',
  'campaign_destination',
  'conversion_goal',
]);
const SUPPORTED_GOOGLE_CHANNEL_TYPES = new Set(['SEARCH', 'PERFORMANCE_MAX']);
const MAX_CAMPAIGNS = 200;
const APPLICATION_LEASE_MS = 15 * 60 * 1000;

function plain(value) {
  return value?.get ? value.get({ plain: true }) : value;
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

function positiveInteger(value) {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) && !/^0+$/.test(normalized)
    ? Number(normalized)
    : null;
}

function cleanCustomerId(value) {
  const normalized = String(value ?? '').replace(/\D/g, '');
  return /^\d{10}$/.test(normalized) ? normalized : null;
}

function cleanCampaignId(value) {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) && !/^0+$/.test(normalized)
    ? normalized.replace(/^0+(?=\d)/, '')
    : null;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stable(value[key]);
    return result;
  }, {});
}

function stableStringify(value) {
  return JSON.stringify(stable(value));
}

function guidedError(code, message, httpStatus = 409, details = null) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  if (details) error.details = details;
  return error;
}

async function acquireGuidedApplicationLease(policy, {
  now = new Date(),
  Policy = db.CampaignOptimizationPolicy,
} = {}) {
  if (policy?.reload) await policy.reload();
  const row = plain(policy) || {};
  const state = objectValue(row.lifecycleState);
  if (['paused', 'completed'].includes(String(state.strategy_status || '').toLowerCase())) {
    throw guidedError('GUIDED_STRATEGY_NOT_ACTIVE', 'La estrategia dejó de estar activa antes de aplicar objetivos.', 409);
  }
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('now debe ser una fecha válida');
  const currentExpiry = state.execution_lease?.expires_at
    ? new Date(state.execution_lease.expires_at)
    : null;
  if (
    state.execution_lease?.token
    && currentExpiry
    && Number.isFinite(currentExpiry.getTime())
    && currentExpiry.getTime() > instant.getTime()
  ) {
    throw guidedError('GUIDED_POLICY_EXECUTION_IN_PROGRESS', 'Ya hay un cambio de objetivos en ejecución.', 409);
  }
  const token = crypto.randomUUID();
  const nextState = {
    ...state,
    execution_lease: {
      token,
      purpose: 'guided_initial_goal_policy_apply',
      acquired_at: instant.toISOString(),
      expires_at: new Date(instant.getTime() + APPLICATION_LEASE_MS).toISOString(),
    },
  };
  const [updated] = await Policy.update({
    lifecycleState: nextState,
    version: Number(row.version || 1) + 1,
  }, {
    where: { id: row.id, version: row.version, status: row.status },
  });
  if (updated !== 1) {
    throw guidedError('GUIDED_POLICY_LEASE_CONFLICT', 'La política cambió antes de reservar su aplicación.', 409);
  }
  if (policy?.reload) await policy.reload();
  else if (policy?.update) await policy.update({ lifecycleState: nextState, version: Number(row.version || 1) + 1 });
  return { token, policy };
}

function assertGuidedAuthorization(payload) {
  const source = objectValue(payload);
  if (String(source.mode_snapshot || source.mode || '').trim().toLowerCase() !== MODES.GUIDED_IMPROVEMENT) {
    throw guidedError('GUIDED_IMPROVEMENT_MODE_REQUIRED', 'La estrategia no está en modo Mejora.', 403);
  }
  const contract = objectValue(source.mode_contract);
  const authorization = objectValue(contract.authorization);
  const scopes = Array.from(new Set(
    (Array.isArray(authorization.scopes) ? authorization.scopes : [])
      .map((value) => String(value || '').trim().toLowerCase())
  ));
  const missingScopes = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
  const actorUserId = positiveInteger(authorization.accepted_by_user_id);
  if (
    contract.mode !== MODES.GUIDED_IMPROVEMENT
    || contract.manage_conversion_goals !== true
    || contract.mutate_bids === true
    || contract.mutate_budget === true
    || contract.mutate_campaign_status === true
    || authorization.accepted !== true
    || Number(authorization.version) !== AUTHORIZATION_VERSION
    || !authorization.accepted_at
    || !actorUserId
    || missingScopes.length
  ) {
    throw guidedError(
      'GUIDED_IMPROVEMENT_AUTHORIZATION_INVALID',
      'La autorización de Mejora no es completa o ya no coincide con el contrato vigente.',
      403,
      { missing_scopes: missingScopes }
    );
  }
  return {
    version: AUTHORIZATION_VERSION,
    accepted: true,
    accepted_at: String(authorization.accepted_at),
    accepted_by_user_id: actorUserId,
    scopes: REQUIRED_SCOPES.slice(),
  };
}

function strategyScope(campaign, payload) {
  const row = plain(campaign) || {};
  const source = objectValue(payload);
  const scope = objectValue(source.scope);
  const clinicId = positiveInteger(scope.clinic_id ?? row.clinica_id);
  const groupId = positiveInteger(scope.group_id ?? row.grupo_clinica_id);
  const assignmentScope = String(scope.assignment_scope || (clinicId ? 'clinic' : groupId ? 'group' : '')).trim().toLowerCase();
  if (assignmentScope === 'clinic' && clinicId) {
    return {
      type: 'clinic',
      id: clinicId,
      clinicId,
      groupId: null,
      intakeWhere: { clinic_id: clinicId, assignment_scope: 'clinic' },
      providerScope: { assignment_scope: 'clinic', clinic_id: clinicId, group_id: null },
    };
  }
  if (assignmentScope === 'group' && groupId) {
    return {
      type: 'group',
      id: groupId,
      clinicId: null,
      groupId,
      intakeWhere: { group_id: groupId, assignment_scope: 'group' },
      providerScope: { assignment_scope: 'group', clinic_id: null, group_id: groupId },
    };
  }
  throw guidedError('GUIDED_IMPROVEMENT_SCOPE_INVALID', 'La estrategia no tiene un scope publicitario inequívoco.', 400);
}

function collectGoogleCohorts(payload) {
  const source = objectValue(payload);
  const cohorts = new Map();
  const seenCampaigns = new Set();
  for (const target of Array.isArray(source.external_targets) ? source.external_targets : []) {
    for (const campaign of Array.isArray(target?.campaigns) ? target.campaigns : []) {
      const provider = String(campaign?.provider || '').trim().toLowerCase();
      if (provider !== 'google_ads') continue;
      const customerId = cleanCustomerId(
        campaign?.customer_id || campaign?.account_id || campaign?.provider_account_id
      );
      const campaignId = cleanCampaignId(
        campaign?.external_campaign_id || campaign?.campaign_id
      );
      if (!customerId || !campaignId) {
        throw guidedError(
          'GUIDED_GOOGLE_CAMPAIGN_IDENTITY_INVALID',
          'Todas las campañas de Google deben incluir cuenta de 10 dígitos y campaign_id numérico.',
          400
        );
      }
      const identity = `${customerId}:${campaignId}`;
      if (seenCampaigns.has(identity)) {
        throw guidedError('GUIDED_GOOGLE_CAMPAIGN_DUPLICATE', 'Una campaña de Google aparece vinculada más de una vez.', 400);
      }
      seenCampaigns.add(identity);
      if (!cohorts.has(customerId)) cohorts.set(customerId, []);
      cohorts.get(customerId).push(campaignId);
    }
  }
  const normalized = Array.from(cohorts.entries()).map(([customerId, campaignIds]) => ({
    customer_id: customerId,
    campaign_ids: Array.from(new Set(campaignIds)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
  }));
  const total = normalized.reduce((sum, cohort) => sum + cohort.campaign_ids.length, 0);
  if (!total) {
    throw guidedError('GUIDED_GOOGLE_CAMPAIGNS_REQUIRED', 'Mejora necesita al menos una campaña de Google vinculada para gestionar objetivos.', 400);
  }
  if (total > MAX_CAMPAIGNS) {
    throw guidedError('GUIDED_GOOGLE_CAMPAIGN_LIMIT_EXCEEDED', `Mejora admite un máximo de ${MAX_CAMPAIGNS} campañas por estrategia.`, 400);
  }
  return normalized;
}

function policyCohortFromPayload(payload) {
  const cohorts = collectGoogleCohorts(payload);
  return {
    customer_ids: cohorts.map((cohort) => cohort.customer_id),
    campaign_ids: cohorts.flatMap((cohort) => cohort.campaign_ids),
  };
}

function assertGuidedPolicyPayloadCompatible(policy, payload) {
  const row = plain(policy) || {};
  if (!positiveInteger(row.id)) return { compatible: true, policy: null };
  if (row.mode !== MODES.GUIDED_IMPROVEMENT) {
    throw guidedError('GUIDED_POLICY_MODE_CONFLICT', 'La estrategia ya tiene una política de otro modo.', 409);
  }
  assertGuidedAuthorization(payload);
  const expected = policyCohortFromPayload(payload);
  if (
    stableStringify(row.customerIds || []) !== stableStringify(expected.customer_ids)
    || stableStringify(row.campaignIds || []) !== stableStringify(expected.campaign_ids)
  ) {
    throw guidedError(
      'GUIDED_POLICY_COHORT_IMMUTABLE',
      'No se pueden cambiar las cuentas o campañas vinculadas mientras exista una política de Mejora. Completa la estrategia y crea otra configuración.',
      409
    );
  }
  return { compatible: true, policy: row, cohort: expected };
}

async function syncGuidedPolicyStrategyStatus({
  strategyId,
  strategyStatus,
  transaction = null,
  dependencies = {},
} = {}) {
  const Policy = dependencies.Policy || db.CampaignOptimizationPolicy;
  const normalizedStrategyId = positiveInteger(strategyId);
  if (!normalizedStrategyId) return { updated: false, reason: 'strategy_id_missing' };
  const policy = await Policy.findOne({
    where: { strategyId: normalizedStrategyId },
    ...(transaction ? {
      transaction,
      ...(transaction.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    } : {}),
  });
  if (!policy) return { updated: false, reason: 'policy_not_found' };
  const normalizedStatus = String(strategyStatus || '').trim().toLowerCase();
  const policyStatus = normalizedStatus === 'completed'
    ? 'completed'
    : normalizedStatus === 'active'
      ? null
      : 'paused';
  if (!policyStatus) return { updated: false, reason: 'active_status_owned_by_provider_apply', policy };
  const row = plain(policy) || {};
  const state = objectValue(row.lifecycleState);
  if (
    row.status === policyStatus
    && state.strategy_status === normalizedStatus
    && !row.nextEvaluationAt
  ) {
    return { updated: false, reason: 'already_synchronized', policy, status: policyStatus };
  }
  const leaseExpiry = state.execution_lease?.expires_at
    ? new Date(state.execution_lease.expires_at)
    : null;
  if (
    state.execution_lease?.token
    && leaseExpiry
    && Number.isFinite(leaseExpiry.getTime())
    && leaseExpiry.getTime() > Date.now()
  ) {
    throw guidedError(
      'GUIDED_POLICY_EXECUTION_IN_PROGRESS',
      'Hay un cambio de objetivo verificándose en Google. Vuelve a intentar la pausa o finalización cuando termine.',
      409
    );
  }
  const nextState = {
    ...state,
    strategy_status: normalizedStatus,
    strategy_status_synced_at: new Date().toISOString(),
  };
  delete nextState.execution_lease;
  delete nextState.pending_provider_transition;
  await policy.update({
    status: policyStatus,
    lifecycleState: nextState,
    nextEvaluationAt: null,
    version: Number(row.version || 1) + 1,
  }, transaction ? { transaction } : undefined);
  return { updated: true, policy, status: policyStatus };
}

function validateInventory(cohorts, inventoryRows) {
  const index = new Map((inventoryRows || []).map((row) => [
    `${cleanCustomerId(row.customer_id)}:${cleanCampaignId(row.campaign_id)}`,
    row,
  ]));
  const issues = [];
  for (const cohort of cohorts) {
    for (const campaignId of cohort.campaign_ids) {
      const identity = `${cohort.customer_id}:${campaignId}`;
      const row = index.get(identity);
      const channelType = String(row?.channel_type || '').trim().toUpperCase();
      if (!row) issues.push({ identity, reason: 'inventory_missing' });
      else if (!SUPPORTED_GOOGLE_CHANNEL_TYPES.has(channelType)) {
        issues.push({ identity, reason: 'unsupported_channel_type', channel_type: channelType || null });
      }
    }
  }
  if (issues.length) {
    throw guidedError(
      'GUIDED_GOOGLE_CAMPAIGNS_NOT_ELIGIBLE',
      'Solo se pueden mejorar objetivos de campañas Google Search o Performance Max verificadas.',
      409,
      { issues }
    );
  }
}

function buildGuidedProvisioningPlan({ campaign, payload, intakeConfig, inventoryRows, stage = STAGES.QUALIFIED_LEAD } = {}) {
  const campaignRow = plain(campaign) || {};
  const strategyId = positiveInteger(campaignRow.id);
  if (!strategyId) throw guidedError('GUIDED_STRATEGY_ID_REQUIRED', 'Falta el ID técnico de la estrategia.', 400);
  if (![STAGES.QUALIFIED_LEAD, STAGES.SCHEDULE, STAGES.PURCHASE].includes(stage)) {
    throw guidedError('GUIDED_OPTIMIZATION_STAGE_INVALID', 'La etapa solicitada no es una señal canónica de puja.', 400);
  }
  const authorization = assertGuidedAuthorization(payload);
  const scope = strategyScope(campaignRow, payload);
  const cohorts = collectGoogleCohorts(payload);
  validateInventory(cohorts, inventoryRows);
  const intake = plain(intakeConfig);
  if (!intake) throw guidedError('INTAKE_CONFIG_REQUIRED', 'No existe configuración de medición para este scope.', 409);
  const config = objectValue(intake.config);
  const googleAds = objectValue(config.google_ads);
  if (!Object.keys(googleAds).length) {
    throw guidedError('GOOGLE_ADS_CONFIG_REQUIRED', 'Falta la configuración canónica de Google Ads.', 409);
  }
  const persistedGoalPolicy = objectValue(googleAds.goal_policy);
  if (Object.keys(persistedGoalPolicy).length
    && persistedGoalPolicy.schema_version !== GOAL_POLICY_SCHEMA_VERSION) {
    throw guidedError('GOAL_POLICY_V4_REQUIRED', 'Existe una política de objetivos antigua que requiere revisión antes de usar Mejora.', 409);
  }
  const existingAccounts = Array.isArray(persistedGoalPolicy.accounts) && persistedGoalPolicy.accounts.length
    ? normalizeConfiguredAccounts(persistedGoalPolicy.accounts)
    : [];
  const strategyRef = `strategy:${strategyId}`;
  const configuredAccounts = cohorts.map((cohort) => {
    const canonical = resolveCanonicalActionIds(googleAds, cohort.customer_id);
    const structuralBlockers = canonical.blockers.filter((item) => item.code !== 'CANONICAL_ACTION_MAPPING_REQUIRED');
    if (structuralBlockers.length || !canonical.canonicalActionIds?.[stage]) {
      throw guidedError(
        'GUIDED_CANONICAL_ACTIONS_REQUIRED',
        `Falta una acción canónica única para la etapa ${stage}.`,
        409,
        { customer_id: cohort.customer_id, stage, blockers: structuralBlockers }
      );
    }
    const previous = existingAccounts.find((account) => (
      account.customer_id === cohort.customer_id && account.strategy_ref === strategyRef
    ));
    return normalizeConfiguredAccounts([{
      customer_id: cohort.customer_id,
      strategy_ref: strategyRef,
      campaign_ids: cohort.campaign_ids,
      canonical_action_ids: canonical.canonicalActionIds,
      bidding_action_key: stage,
      ...(previous?.bidding_action_key === stage && previous?.owned_custom_goal_resource_name
        ? { owned_custom_goal_resource_name: previous.owned_custom_goal_resource_name }
        : {}),
    }])[0];
  });
  const nextAccounts = existingAccounts.filter((account) => account.strategy_ref !== strategyRef)
    .concat(configuredAccounts);
  // Revalidar el conjunto completo detecta solapamientos con otras estrategias.
  const normalizedNextAccounts = normalizeConfiguredAccounts(nextAccounts);
  const nextConfig = {
    ...config,
    google_ads: {
      ...googleAds,
      goal_policy: {
        ...persistedGoalPolicy,
        enabled: true,
        schema_version: GOAL_POLICY_SCHEMA_VERSION,
        automation_schema_version: SCHEMA_VERSION,
        strategy_key: 'new_patients',
        managed_service_only: false,
        allowed_modes: [MODES.GUIDED_IMPROVEMENT, MODES.MANAGED_SERVICE],
        accounts: normalizedNextAccounts,
      },
    },
  };
  return {
    schema_version: SCHEMA_VERSION,
    ready: true,
    mode: MODES.GUIDED_IMPROVEMENT,
    strategy_id: strategyId,
    strategy_ref: strategyRef,
    scope,
    authorization,
    stage,
    customer_ids: configuredAccounts.map((account) => account.customer_id),
    campaign_ids: configuredAccounts.flatMap((account) => account.campaign_ids),
    configured_accounts: configuredAccounts,
    next_intake_config: nextConfig,
  };
}

async function loadInventoryForCohorts(cohorts, Inventory = db.ExternalCampaignInventory, transaction = null) {
  const identities = cohorts.flatMap((cohort) => cohort.campaign_ids.map((campaignId) => ({
    provider: 'google_ads',
    customer_id: cohort.customer_id,
    campaign_id: campaignId,
  })));
  if (!identities.length) return [];
  return Inventory.findAll({
    where: { [Op.or]: identities },
    raw: true,
    ...(transaction ? { transaction } : {}),
  });
}

async function provisionGuidedCampaignOptimization({
  campaign,
  payload,
  now = new Date(),
  stage = STAGES.QUALIFIED_LEAD,
  targetStage = null,
  transitionLeaseToken = null,
  transaction = null,
  dependencies = {},
} = {}) {
  const Policy = dependencies.Policy || db.CampaignOptimizationPolicy;
  const IntakeConfig = dependencies.IntakeConfig || db.IntakeConfig;
  const Inventory = dependencies.Inventory || db.ExternalCampaignInventory;
  const campaignRow = plain(campaign) || {};
  const scope = strategyScope(campaignRow, payload);
  const cohorts = collectGoogleCohorts(payload);
  const intakeConfig = await IntakeConfig.findOne({
    where: scope.intakeWhere,
    ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}),
  });
  const inventoryRows = await loadInventoryForCohorts(cohorts, Inventory, transaction);
  const existing = await Policy.findOne({
    where: { strategyId: positiveInteger(campaignRow.id) },
    ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}),
  });
  const existingRow = plain(existing);
  const currentStage = existingRow?.lifecycleState?.stage || null;
  const requestedTargetStage = targetStage || null;
  if (existingRow && requestedTargetStage && requestedTargetStage !== currentStage) {
    const state = objectValue(existingRow.lifecycleState);
    const lease = objectValue(state.execution_lease);
    const pending = objectValue(state.pending_provider_transition);
    if (
      !transitionLeaseToken
      || String(lease.token || '') !== String(transitionLeaseToken)
      || lease.purpose !== 'guided_lifecycle_transition'
      || pending.to_stage !== requestedTargetStage
    ) {
      throw guidedError(
        'GUIDED_TRANSITION_LEASE_REQUIRED',
        'Cambiar de etapa requiere la reserva durable de una evaluación aprobada.',
        409
      );
    }
  }
  const effectiveStage = requestedTargetStage || currentStage || stage;
  const plan = buildGuidedProvisioningPlan({
    campaign: campaignRow,
    payload,
    intakeConfig,
    inventoryRows,
    stage: effectiveStage,
  });
  if (existingRow && existingRow.mode !== MODES.GUIDED_IMPROVEMENT) {
    throw guidedError('GUIDED_POLICY_MODE_CONFLICT', 'La estrategia ya tiene una política de otro modo.', 409);
  }
  if (existingRow && (
    stableStringify(existingRow.customerIds || []) !== stableStringify(plan.customer_ids)
    || stableStringify(existingRow.campaignIds || []) !== stableStringify(plan.campaign_ids)
  )) {
    throw guidedError('GUIDED_POLICY_COHORT_IMMUTABLE', 'La cohorte vinculada no puede cambiar después de aplicar objetivos.', 409);
  }
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('now debe ser una fecha válida');
  let policy = existing;
  let created = false;
  if (!policy) {
    policy = await Policy.create({
      scopeType: plan.scope.type,
      scopeId: plan.scope.id,
      clinicaId: plan.scope.clinicId,
      grupoClinicaId: plan.scope.groupId,
      mode: MODES.GUIDED_IMPROVEMENT,
      strategyId: plan.strategy_id,
      managedCampaignId: null,
      customerIds: plan.customer_ids,
      campaignIds: plan.campaign_ids,
      lifecycleState: {
        stage: plan.stage,
        stage_entered_at: instant.toISOString(),
        last_transition_at: instant.toISOString(),
        last_evaluation_at: null,
        pending_transition: null,
        strategy_status: String(payload?.status || 'active').toLowerCase(),
        strategy_status_synced_at: instant.toISOString(),
        authorization: plan.authorization,
        provider_application: { status: 'pending', attempted_at: null, applied_at: null },
      },
      thresholds: normalizeThresholds(DEFAULT_THRESHOLDS),
      status: 'paused',
      version: 1,
      nextEvaluationAt: null,
      lastEvaluatedAt: null,
    }, transaction ? { transaction } : undefined);
    created = true;
  } else if (String(payload?.status || '').toLowerCase() === 'active') {
    const row = plain(policy) || {};
    const state = objectValue(row.lifecycleState);
    if (state.strategy_status !== 'active') {
      await policy.update({
        lifecycleState: {
          ...state,
          strategy_status: 'active',
          strategy_status_synced_at: instant.toISOString(),
        },
        version: Number(row.version || 1) + 1,
      }, transaction ? { transaction } : undefined);
    }
  }
  if (stableStringify(objectValue(plain(intakeConfig)?.config)) !== stableStringify(plan.next_intake_config)) {
    await intakeConfig.update({ config: plan.next_intake_config }, transaction ? { transaction } : undefined);
  }
  return { provisioned: true, created, policy, intakeConfig, plan };
}

async function applyGuidedCampaignGoalPolicy({
  provisioning,
  actorUserId = null,
  finalizePolicy = true,
  dependencies = {},
} = {}) {
  const context = provisioning;
  if (!context?.provisioned || !context.plan?.configured_accounts?.length) {
    throw guidedError('GUIDED_POLICY_PROVISIONING_REQUIRED', 'La política local debe provisionarse antes de aplicarla.', 409);
  }
  const actor = positiveInteger(actorUserId) || context.plan.authorization.accepted_by_user_id;
  if (actor !== context.plan.authorization.accepted_by_user_id) {
    throw guidedError('GUIDED_POLICY_ACTOR_MISMATCH', 'El actor no coincide con quien autorizó Mejora.', 403);
  }
  const scope = { ...context.plan.scope.providerScope, user_id: actor };
  let applicationLeaseToken = null;
  if (finalizePolicy) {
    const lease = await (dependencies.acquireApplicationLease || acquireGuidedApplicationLease)(
      context.policy,
      dependencies.applicationLeaseDependencies || {}
    );
    applicationLeaseToken = lease.token;
  }
  const persistOwnership = async (ownership) => {
    const configuredAccount = context.plan.configured_accounts.find((account) => (
      account.customer_id === ownership?.customer_id
      && account.strategy_ref === ownership?.strategy_ref
    ));
    if (!configuredAccount) {
      throw guidedError('GUIDED_GOAL_POLICY_OWNERSHIP_SCOPE_INVALID', 'Google devolvió ownership fuera de la cohorte autorizada.', 409);
    }
    return persistGoalOwnership({
      intakeConfig: context.intakeConfig,
      configuredAccount,
      ownership,
      dependencies: dependencies.persistenceDependencies || {},
    });
  };
  const attemptedAt = new Date();
  const persistAccountApplication = async (configuredAccount, patch) => {
    const policyRow = plain(context.policy) || {};
    const state = objectValue(policyRow.lifecycleState);
    const currentApplication = objectValue(state.provider_application);
    const accounts = objectValue(currentApplication.accounts);
    const customerId = configuredAccount.customer_id;
    await context.policy.update({
      lifecycleState: {
        ...state,
        provider_application: {
          ...currentApplication,
          status: 'applying',
          attempted_at: currentApplication.attempted_at || attemptedAt.toISOString(),
          applied_at: null,
          accounts: {
            ...accounts,
            [customerId]: {
              ...(objectValue(accounts[customerId])),
              customer_id: customerId,
              campaign_ids: configuredAccount.campaign_ids,
              ...patch,
            },
          },
        },
      },
      version: Number(policyRow.version || 1) + 1,
    });
  };
  try {
    const accountResults = [];
    // Google enforces a one-account blast radius per apply. Apply and verify
    // every authorized account independently before advancing local state.
    for (const configuredAccount of context.plan.configured_accounts) {
      await persistAccountApplication(configuredAccount, {
        status: 'applying',
        attempted_at: new Date().toISOString(),
        applied_at: null,
        error_code: null,
      });
      try {
        const preview = await (dependencies.previewGoalPolicy || previewClinicaclickGoalPolicy)({
          scope,
          configuredAccounts: [configuredAccount],
          dependencies: dependencies.goalPolicyDependencies || {},
        });
        if (!preview?.ready) {
          throw guidedError('GUIDED_GOAL_POLICY_PREVIEW_BLOCKED', 'Google no ha validado todavía el cambio de objetivos.', 409, {
            customer_id: configuredAccount.customer_id,
            accounts: preview?.accounts || [],
          });
        }
        const result = await (dependencies.applyGoalPolicy || applyClinicaclickGoalPolicy)({
          scope,
          configuredAccounts: [configuredAccount],
          expectedDigest: preview.digest,
          confirmExternalMutation: true,
          dependencies: {
            ...(dependencies.goalPolicyDependencies || {}),
            persistOwnership,
          },
        });
        if (!['applied', 'unchanged'].includes(result?.outcome) || result?.verification?.healthy !== true) {
          throw guidedError('GUIDED_GOAL_POLICY_READBACK_FAILED', 'Google no confirmó los objetivos mediante readback.', 502, {
            customer_id: configuredAccount.customer_id,
          });
        }
        await persistAccountApplication(configuredAccount, {
          status: 'applied',
          preview_digest: preview.digest,
          provider_outcome: result.outcome,
          readback_healthy: true,
          applied_at: new Date().toISOString(),
          error_code: null,
        });
        accountResults.push({
          customer_id: configuredAccount.customer_id,
          preview,
          result,
        });
      } catch (error) {
        await persistAccountApplication(configuredAccount, {
          status: 'failed',
          readback_healthy: false,
          applied_at: null,
          error_code: String(error.code || 'GUIDED_GOAL_POLICY_APPLY_FAILED').slice(0, 120),
        });
        throw error;
      }
    }
    const preview = {
      ready: true,
      digests: accountResults.map((item) => ({ customer_id: item.customer_id, digest: item.preview.digest })),
    };
    const result = {
      outcome: accountResults.some((item) => item.result.outcome === 'applied') ? 'applied' : 'unchanged',
      verification: { healthy: accountResults.every((item) => item.result.verification?.healthy === true) },
      accounts: accountResults,
    };
    if (!finalizePolicy) return { preview, result, policy: context.policy };
    const policyRow = plain(context.policy) || {};
    const state = objectValue(policyRow.lifecycleState);
    const nextState = {
      ...state,
      provider_application: {
        status: 'applied',
        attempted_at: attemptedAt.toISOString(),
        applied_at: new Date().toISOString(),
        digests: preview.digests,
        accounts: objectValue(state.provider_application).accounts || {},
      },
    };
    if (applicationLeaseToken && state.execution_lease?.token === applicationLeaseToken) {
      delete nextState.execution_lease;
    }
    await context.policy.update({
      status: 'active',
      lifecycleState: nextState,
      nextEvaluationAt: new Date(Date.now() + 22 * 60 * 60 * 1000),
      version: Number(policyRow.version || 1) + 1,
    });
    return { preview, result, policy: context.policy };
  } catch (error) {
    if (!finalizePolicy) throw error;
    const policyRow = plain(context.policy) || {};
    const state = objectValue(policyRow.lifecycleState);
    const nextState = {
      ...state,
      provider_application: {
        status: 'failed',
        attempted_at: attemptedAt.toISOString(),
        applied_at: null,
        error_code: error.code || 'GUIDED_GOAL_POLICY_APPLY_FAILED',
        accounts: objectValue(state.provider_application).accounts || {},
      },
    };
    if (applicationLeaseToken && state.execution_lease?.token === applicationLeaseToken) {
      delete nextState.execution_lease;
    }
    await context.policy.update({
      status: 'paused',
      lifecycleState: nextState,
      nextEvaluationAt: null,
      version: Number(policyRow.version || 1) + 1,
    });
    throw error;
  }
}

module.exports = {
  AUTHORIZATION_VERSION,
  MAX_CAMPAIGNS,
  REQUIRED_SCOPES,
  SCHEMA_VERSION,
  SUPPORTED_GOOGLE_CHANNEL_TYPES,
  acquireGuidedApplicationLease,
  applyGuidedCampaignGoalPolicy,
  assertGuidedPolicyPayloadCompatible,
  assertGuidedAuthorization,
  buildGuidedProvisioningPlan,
  collectGoogleCohorts,
  loadInventoryForCohorts,
  provisionGuidedCampaignOptimization,
  policyCohortFromPayload,
  strategyScope,
  syncGuidedPolicyStrategyStatus,
  validateInventory,
};

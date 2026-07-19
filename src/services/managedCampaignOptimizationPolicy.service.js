'use strict';

const crypto = require('node:crypto');
const db = require('../../models');
const {
  DEFAULT_THRESHOLDS,
  MODES,
  STAGES,
  normalizeThresholds,
} = require('./campaignOptimizationLifecycle.service');
const {
  ALL_CANONICAL_KEYS,
  SCHEMA_VERSION: GOAL_POLICY_SCHEMA_VERSION,
  applyClinicaclickGoalPolicy,
  normalizeConfiguredAccounts,
  previewClinicaclickGoalPolicy,
} = require('./googleAdsClinicaclickGoalPolicy.service');

const SCHEMA_VERSION = 'clinicaclick-managed-campaign-optimization/v1';
const MANAGED_GOOGLE_FAMILIES = new Set(['google_search', 'google_pmax']);
const LIVE_ENTRY_STATUSES = new Set(['launching', 'active']);
const EXECUTABLE_STATUSES = new Set(['approved_to_launch', 'launching', 'active']);
const MAX_CAMPAIGNS = 200;
const EXECUTION_LEASE_TTL_MS = 30 * 60 * 1000;

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

function cleanPositiveId(value) {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) && !/^0+$/.test(normalized)
    ? normalized.replace(/^0+(?=\d)/, '')
    : null;
}

function cleanCustomerId(value) {
  const normalized = String(value ?? '').replace(/\D/g, '');
  return /^\d{10}$/.test(normalized) ? normalized : null;
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function blocker(code, message, details = null) {
  return { code, message, ...(details ? { details } : {}) };
}

function optimizationError(code, message, httpStatus = 409, blockers = []) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  error.blockers = blockers;
  return error;
}

function valuesAt(source, paths) {
  return paths.map((path) => path.split('.').reduce(
    (value, segment) => (value && typeof value === 'object' ? value[segment] : undefined),
    source,
  )).filter((value) => value !== undefined && value !== null && value !== '');
}

function normalizedIdList(value) {
  const source = Array.isArray(value) ? value : [value];
  return Array.from(new Set(source.map(cleanPositiveId).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
}

function resolveGoogleReferences(campaign) {
  const refs = objectValue(plain(campaign)?.platform_refs);
  const blockers = [];
  const accountCandidates = valuesAt(refs, [
    'customer_id',
    'account_id',
    'google_ads.customer_id',
    'google_ads.account_id',
  ]).map(cleanCustomerId);
  if (accountCandidates.some((value) => !value)) {
    blockers.push(blocker('GOOGLE_ACCOUNT_ID_INVALID', 'account_id debe ser un customer ID de 10 dígitos.'));
  }
  const accountIds = Array.from(new Set(accountCandidates.filter(Boolean)));
  if (!accountIds.length) {
    blockers.push(blocker('GOOGLE_ACCOUNT_ID_REQUIRED', 'Falta account_id/customer_id explícito para la campaña gestionada.'));
  } else if (accountIds.length > 1) {
    blockers.push(blocker('GOOGLE_ACCOUNT_ID_CONFLICT', 'Las referencias de cuenta Google no coinciden.', { account_ids: accountIds }));
  }

  const rawCampaignCandidates = valuesAt(refs, [
    'campaign_ids',
    'campaign_id',
    'google_ads.campaign_ids',
    'google_ads.campaign_id',
  ]);
  const campaignCandidates = rawCampaignCandidates.map(normalizedIdList);
  const hasInvalidCampaignId = rawCampaignCandidates.some((candidate) => {
    const values = Array.isArray(candidate) ? candidate : [candidate];
    return !values.length || values.some((value) => !cleanPositiveId(value));
  });
  if (hasInvalidCampaignId || campaignCandidates.some((values) => !values.length)) {
    blockers.push(blocker('GOOGLE_CAMPAIGN_IDS_INVALID', 'campaign_ids contiene un identificador inválido.'));
  }
  const serializedCandidates = Array.from(new Set(campaignCandidates.map(stableStringify)));
  if (!campaignCandidates.length || !campaignCandidates[0].length) {
    blockers.push(blocker('GOOGLE_CAMPAIGN_IDS_REQUIRED', 'Falta campaign_ids explícito para la cohorte gestionada.'));
  } else if (serializedCandidates.length > 1) {
    blockers.push(blocker('GOOGLE_CAMPAIGN_IDS_CONFLICT', 'Las referencias campaign_id/campaign_ids no coinciden.'));
  }
  const campaignIds = campaignCandidates[0] || [];
  if (campaignIds.length > MAX_CAMPAIGNS) {
    blockers.push(blocker('GOOGLE_CAMPAIGN_COHORT_TOO_LARGE', `La cohorte supera el máximo seguro de ${MAX_CAMPAIGNS} campañas.`));
  }
  return { customerId: accountIds[0] || null, campaignIds, blockers };
}

function actionIdFromTarget(target) {
  const explicit = cleanPositiveId(target?.conversion_action_id ?? target?.conversionActionId);
  if (explicit) return explicit;
  const resource = String(target?.conversion_action ?? target?.conversionAction ?? '').trim();
  const match = resource.match(/\/conversionActions\/(\d+)$/);
  return match ? cleanPositiveId(match[1]) : null;
}

function resolveCanonicalActionIds(googleAdsConfig, customerId) {
  const googleAds = objectValue(googleAdsConfig);
  const events = objectValue(googleAds.events);
  const canonicalActionIds = {};
  const blockers = [];
  for (const key of ALL_CANONICAL_KEYS) {
    const event = objectValue(events[key]);
    const destinations = Array.isArray(event.destinations) ? event.destinations : [];
    let targets = destinations.filter((destination) => (
      cleanCustomerId(destination?.customer_id ?? destination?.customerId) === customerId
    ));
    if (!destinations.length) {
      const eventCustomerId = cleanCustomerId(
        event.customer_id
        ?? event.customerId
        ?? googleAds[`${key}_customer_id`]
        ?? googleAds.customer_id,
      );
      if (eventCustomerId === customerId) targets = [event];
    }
    const ids = Array.from(new Set(targets.map(actionIdFromTarget).filter(Boolean)));
    if (targets.length !== 1 || ids.length !== 1) {
      blockers.push(blocker(
        'CANONICAL_ACTION_MAPPING_REQUIRED',
        `Falta un único ID canónico de ${key} para ${customerId}.`,
        { action_key: key, destination_count: targets.length, action_ids: ids },
      ));
      canonicalActionIds[key] = null;
      continue;
    }
    canonicalActionIds[key] = ids[0];
  }
  const ids = Object.values(canonicalActionIds).filter(Boolean);
  if (new Set(ids).size !== ids.length) {
    blockers.push(blocker('CANONICAL_ACTION_IDS_DUPLICATE', 'Dos eventos canónicos comparten el mismo conversion_action_id.'));
  }
  return { canonicalActionIds, blockers };
}

function campaignScope(campaign) {
  const row = plain(campaign) || {};
  const groupId = positiveInteger(row.grupo_clinica_id);
  const clinicId = positiveInteger(row.clinica_id);
  return groupId
    ? {
        type: 'group',
        id: groupId,
        clinicId: null,
        groupId,
        intakeWhere: { group_id: groupId, assignment_scope: 'group' },
        providerScope: { assignment_scope: 'group', group_id: groupId, clinic_id: null },
      }
    : {
        type: 'clinic',
        id: clinicId,
        clinicId,
        groupId: null,
        intakeWhere: { clinic_id: clinicId, assignment_scope: 'clinic' },
        providerScope: { assignment_scope: 'clinic', clinic_id: clinicId, group_id: null },
      };
}

function isConnectOnly(campaign) {
  const row = plain(campaign) || {};
  return row.management_mode === 'connect_only'
    || row.legacy_mode === 'connect_only'
    || row.operation_mode !== 'managed';
}

function goalPolicyAccountForStage({ campaign, customerId, campaignIds, canonicalActionIds, stage, existingAccount = null }) {
  const strategyRef = `managed_campaign:${plain(campaign).id}`;
  const existingStage = existingAccount?.policy_stage || existingAccount?.bidding_action_key || null;
  return normalizeConfiguredAccounts([{
    customer_id: customerId,
    strategy_ref: strategyRef,
    campaign_ids: campaignIds,
    canonical_action_ids: canonicalActionIds,
    bidding_action_key: stage,
    ...(existingStage === stage && existingAccount?.owned_custom_goal_resource_name
      ? { owned_custom_goal_resource_name: existingAccount.owned_custom_goal_resource_name }
      : {}),
  }])[0];
}

function lifecycleStageExecutionBlockers(policy) {
  const persisted = plain(policy) || {};
  const state = objectValue(persisted.lifecycleState);
  const stage = state.stage || STAGES.QUALIFIED_LEAD;
  if (stage === STAGES.QUALIFIED_LEAD) return [];
  const approval = objectValue(state.approved_transition);
  const evaluationIds = normalizedIdList(approval.evaluation_ids);
  const requiredPasses = Number(persisted.thresholds?.consecutive_passing_evaluations)
    || DEFAULT_THRESHOLDS.consecutive_passing_evaluations;
  const expectedFrom = stage === STAGES.SCHEDULE ? STAGES.QUALIFIED_LEAD : STAGES.SCHEDULE;
  const valid = approval.from_stage === expectedFrom
    && approval.to_stage === stage
    && evaluationIds.length >= requiredPasses
    && Number(approval.consecutive_passing_evaluations) >= requiredPasses
    && approval.approved_by_role === 'operator'
    && positiveInteger(approval.approved_by_user_id)
    && /^[a-f0-9]{64}$/.test(String(approval.decision_digest || ''));
  return valid ? [] : [blocker(
    'LIFECYCLE_PROMOTION_APPROVAL_EVIDENCE_REQUIRED',
    `La migración a ${stage} necesita al menos ${requiredPasses} evaluaciones correctas y aprobación operativa persistida.`,
  )];
}

function buildProvisioningPlan({ campaign, intakeConfig, stage = STAGES.QUALIFIED_LEAD, targetStatus = null } = {}) {
  const row = plain(campaign) || {};
  const effectiveStatus = targetStatus || row.status;
  const blockers = [];
  if (isConnectOnly(row)) {
    return {
      schema_version: SCHEMA_VERSION,
      ready: true,
      eligible: false,
      observe_only: true,
      reason: 'connect_only_never_mutates_bidding',
      blockers: [],
    };
  }
  if (row.provider !== 'google_ads') {
    return { schema_version: SCHEMA_VERSION, ready: true, eligible: false, reason: 'provider_not_google_ads', blockers: [] };
  }
  if (!MANAGED_GOOGLE_FAMILIES.has(row.family)) {
    blockers.push(blocker('GOOGLE_FAMILY_OBSERVE_ONLY', 'Solo Search y Performance Max admiten objetivos gestionados; Smart permanece en observación.'));
  }
  if (!LIVE_ENTRY_STATUSES.has(effectiveStatus)) {
    blockers.push(blocker('MANAGED_CAMPAIGN_LIVE_STATUS_REQUIRED', 'La policy solo se provisiona al entrar en launching/active.'));
  }
  if (row.management_mode !== 'autopilot' || row.operation_mode !== 'managed') {
    blockers.push(blocker('MANAGED_SERVICE_REQUIRED', 'La campaña no tiene el gate de Piloto automático en modo gestionado.'));
  }
  if (!positiveInteger(row.approved_by_user_id) || !row.approved_at) {
    blockers.push(blocker('ADMIN_MANAGEMENT_APPROVAL_REQUIRED', 'Falta la aprobación administrativa que autoriza la gestión del piloto.'));
  }
  if (![STAGES.QUALIFIED_LEAD, STAGES.SCHEDULE, STAGES.PURCHASE].includes(stage)) {
    blockers.push(blocker('OPTIMIZATION_STAGE_INVALID', 'La etapa de optimización no es canónica.'));
  }

  const refs = resolveGoogleReferences(row);
  blockers.push(...refs.blockers);
  const intake = plain(intakeConfig);
  if (!intake) blockers.push(blocker('INTAKE_CONFIG_REQUIRED', 'No existe IntakeConfig para el scope de la campaña.'));
  const config = objectValue(intake?.config);
  const googleAds = objectValue(config.google_ads);
  if (!Object.keys(googleAds).length) blockers.push(blocker('GOOGLE_ADS_CONFIG_REQUIRED', 'IntakeConfig no contiene configuración Google Ads.'));
  const actions = refs.customerId
    ? resolveCanonicalActionIds(googleAds, refs.customerId)
    : { canonicalActionIds: {}, blockers: [] };
  blockers.push(...actions.blockers);

  const persistedGoalPolicy = objectValue(googleAds.goal_policy);
  if (Object.keys(persistedGoalPolicy).length
    && persistedGoalPolicy.schema_version !== GOAL_POLICY_SCHEMA_VERSION) {
    blockers.push(blocker('GOAL_POLICY_V4_REQUIRED', 'Existe una goal_policy legacy; no se sobrescribirá sin migración explícita.'));
  }
  const existingAccounts = Array.isArray(persistedGoalPolicy.accounts) ? persistedGoalPolicy.accounts : [];
  for (const existingAccount of existingAccounts) {
    try {
      normalizeConfiguredAccounts([existingAccount]);
    } catch (error) {
      blockers.push(blocker(
        'GOAL_POLICY_EXISTING_COHORT_INVALID',
        'Existe una cohorte v4 inválida; no se modificará el documento hasta repararla.',
        { code: error.code || null },
      ));
    }
  }
  const strategyRef = `managed_campaign:${row.id}`;
  const sameStrategies = existingAccounts.filter((account) => (
    cleanCustomerId(account?.customer_id) === refs.customerId
    && String(account?.strategy_ref || '') === strategyRef
  ));
  const sameStrategy = sameStrategies[0] || null;
  if (sameStrategies.length > 1) {
    blockers.push(blocker(
      'GOAL_POLICY_COHORT_DUPLICATE',
      'La misma cuenta/cohorte aparece repetida en goal_policy; debe repararse antes de aplicar.',
    ));
  }
  const siblingCohorts = existingAccounts.filter((account) => (
    cleanCustomerId(account?.customer_id) === refs.customerId
    && String(account?.strategy_ref || '') !== strategyRef
  ));
  const requestedCampaigns = new Set(refs.campaignIds);
  for (const sibling of siblingCohorts) {
    const overlap = normalizedIdList(sibling.campaign_ids).filter((campaignId) => requestedCampaigns.has(campaignId));
    if (overlap.length) {
      blockers.push(blocker(
        'GOAL_POLICY_CAMPAIGN_COHORT_OVERLAP',
        'Dos cohortes gestionadas de la misma cuenta no pueden compartir campaign_ids.',
        { strategy_ref: sibling.strategy_ref || null, campaign_ids: overlap },
      ));
    }
  }

  let configuredAccount = null;
  if (!blockers.length) {
    configuredAccount = goalPolicyAccountForStage({
      campaign: row,
      customerId: refs.customerId,
      campaignIds: refs.campaignIds,
      canonicalActionIds: actions.canonicalActionIds,
      stage,
      existingAccount: sameStrategy,
    });
    if (sameStrategy) {
      const normalizedExisting = normalizeConfiguredAccounts([sameStrategy])[0];
      if (stableStringify(normalizedExisting.campaign_ids) !== stableStringify(configuredAccount.campaign_ids)) {
        blockers.push(blocker('GOAL_POLICY_CAMPAIGN_COHORT_IMMUTABLE', 'La cohorte de campaign_ids no puede cambiar después del lanzamiento.'));
      }
      if (stableStringify(normalizedExisting.canonical_action_ids) !== stableStringify(configuredAccount.canonical_action_ids)) {
        blockers.push(blocker('GOAL_POLICY_CANONICAL_ACTIONS_CHANGED', 'Los IDs canónicos cambiaron; se requiere revisión explícita antes de aplicar.'));
      }
    }
  }

  const nextAccounts = existingAccounts
    .filter((account) => !(
      cleanCustomerId(account?.customer_id) === refs.customerId
      && String(account?.strategy_ref || '') === strategyRef
    ))
    .concat(configuredAccount ? [configuredAccount] : []);
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
        managed_service_only: true,
        accounts: nextAccounts,
      },
    },
  };
  return {
    schema_version: SCHEMA_VERSION,
    ready: blockers.length === 0,
    eligible: true,
    observe_only: false,
    blockers,
    scope: campaignScope(row),
    customer_id: refs.customerId,
    campaign_ids: refs.campaignIds,
    canonical_action_ids: actions.canonicalActionIds,
    stage,
    configured_account: configuredAccount,
    intake_config_id: positiveInteger(intake?.id),
    next_intake_config: nextConfig,
  };
}

async function findScopedIntakeConfig(campaign, { IntakeConfig = db.IntakeConfig, transaction = null } = {}) {
  const scope = campaignScope(campaign);
  if (!scope.id) return null;
  return IntakeConfig.findOne({
    where: scope.intakeWhere,
    ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}),
  });
}

async function provisionManagedCampaignOptimization({
  campaign,
  targetStatus = null,
  now = new Date(),
  activate = false,
  transaction = null,
  dependencies = {},
} = {}) {
  const Policy = dependencies.Policy || db.CampaignOptimizationPolicy;
  const IntakeConfig = dependencies.IntakeConfig || db.IntakeConfig;
  const row = plain(campaign) || {};
  const existingPolicyRow = await Policy.findOne({
    where: { managedCampaignId: row.id },
    ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}),
  });
  const existingPolicy = plain(existingPolicyRow);
  const stage = existingPolicy?.lifecycleState?.stage || STAGES.QUALIFIED_LEAD;
  const intakeConfig = await findScopedIntakeConfig(row, { IntakeConfig, transaction });
  const plan = buildProvisioningPlan({ campaign: row, intakeConfig, stage, targetStatus });
  const promotionBlockers = existingPolicy ? lifecycleStageExecutionBlockers(existingPolicy) : [];
  if (promotionBlockers.length) {
    plan.blockers.push(...promotionBlockers);
    plan.ready = false;
  }
  if (!plan.eligible) return { provisioned: false, skipped: true, plan };
  if (!plan.ready) {
    throw optimizationError(
      'MANAGED_CAMPAIGN_OPTIMIZATION_NOT_READY',
      'No se puede provisionar la política automática de objetivos.',
      409,
      plan.blockers,
    );
  }

  const currentCustomerIds = Array.isArray(existingPolicy?.customerIds) ? existingPolicy.customerIds.map(cleanCustomerId).filter(Boolean) : [];
  const currentCampaignIds = Array.isArray(existingPolicy?.campaignIds) ? normalizedIdList(existingPolicy.campaignIds) : [];
  if (existingPolicy && (
    existingPolicy.mode !== MODES.MANAGED_SERVICE
    || existingPolicy.scopeType !== plan.scope.type
    || Number(existingPolicy.scopeId) !== Number(plan.scope.id)
    || stableStringify(currentCustomerIds) !== stableStringify([plan.customer_id])
    || stableStringify(currentCampaignIds) !== stableStringify(plan.campaign_ids)
  )) {
    throw optimizationError(
      'CAMPAIGN_OPTIMIZATION_POLICY_IMMUTABLE_CONFLICT',
      'La policy existente no coincide con la cohorte aprobada; no se sobrescribirá.',
      409,
    );
  }

  const timestamp = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError('now debe ser una fecha válida');
  let policy = existingPolicyRow;
  let created = false;
  if (!policy) {
    policy = await Policy.create({
      scopeType: plan.scope.type,
      scopeId: plan.scope.id,
      clinicaId: plan.scope.clinicId,
      grupoClinicaId: plan.scope.groupId,
      mode: MODES.MANAGED_SERVICE,
      strategyId: positiveInteger(row.strategy_campaign_id),
      managedCampaignId: row.id,
      customerIds: [plan.customer_id],
      campaignIds: plan.campaign_ids,
      lifecycleState: {
        stage: STAGES.QUALIFIED_LEAD,
        stage_entered_at: timestamp.toISOString(),
        last_transition_at: timestamp.toISOString(),
        last_evaluation_at: null,
        pending_transition: null,
      },
      thresholds: normalizeThresholds(DEFAULT_THRESHOLDS),
      // El provisioning local precede a la llamada Google. Solo el CAS final
      // tras readback healthy activa la evaluación periódica.
      status: activate ? 'active' : 'paused',
      version: 1,
      nextEvaluationAt: new Date(timestamp.getTime() + 24 * 60 * 60 * 1000),
      lastEvaluatedAt: null,
    }, transaction ? { transaction } : undefined);
    created = true;
  } else if (activate && policy.status !== 'active') {
    await policy.update({ status: 'active' }, transaction ? { transaction } : undefined);
  }
  const configChanged = stableStringify(objectValue(plain(intakeConfig)?.config))
    !== stableStringify(plan.next_intake_config);
  if (configChanged) {
    await intakeConfig.update({ config: plan.next_intake_config }, transaction ? { transaction } : undefined);
  }
  return {
    provisioned: true,
    created,
    policy,
    intakeConfig,
    configUpdated: configChanged,
    plan,
  };
}

async function withPolicyTransaction(transaction, dependencies, callback) {
  if (transaction) return callback(transaction);
  const sequelize = dependencies.sequelize || db.sequelize;
  if (sequelize?.transaction) return sequelize.transaction(callback);
  return callback(null);
}

function policyLockOptions(transaction) {
  return transaction
    ? { transaction, ...(transaction.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}) }
    : {};
}

async function acquireManagedCampaignOptimizationLease({
  managedCampaignId,
  actorUserId = null,
  purpose = 'apply_goal_policy',
  now = new Date(),
  ttlMs = EXECUTION_LEASE_TTL_MS,
  transaction = null,
  dependencies = {},
} = {}) {
  const Policy = dependencies.Policy || db.CampaignOptimizationPolicy;
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new TypeError('now debe ser una fecha válida');
  const safeTtl = Number(ttlMs);
  if (!Number.isFinite(safeTtl) || safeTtl < 60_000 || safeTtl > 60 * 60 * 1000) {
    throw new TypeError('ttlMs debe estar entre 1 y 60 minutos');
  }
  return withPolicyTransaction(transaction, dependencies, async (ownedTransaction) => {
    const policy = await Policy.findOne({
      where: { managedCampaignId },
      ...policyLockOptions(ownedTransaction),
    });
    if (!policy) {
      throw optimizationError('CAMPAIGN_OPTIMIZATION_POLICY_REQUIRED', 'No existe policy para reservar la ejecución.', 409);
    }
    const row = plain(policy) || {};
    const state = objectValue(row.lifecycleState);
    const existing = objectValue(state.execution_lease);
    const existingExpiry = new Date(existing.expires_at || 0);
    if (
      String(existing.token || '').trim()
      && Number.isFinite(existingExpiry.getTime())
      && existingExpiry.getTime() > instant.getTime()
    ) {
      throw optimizationError(
        'GOAL_POLICY_EXECUTION_IN_PROGRESS',
        'Ya hay una aplicación de objetivos en curso para esta campaña.',
        409,
      );
    }
    const token = crypto.randomUUID();
    const executionLease = {
      token,
      purpose: String(purpose || 'apply_goal_policy').slice(0, 80),
      actor_user_id: positiveInteger(actorUserId),
      acquired_at: instant.toISOString(),
      expires_at: new Date(instant.getTime() + safeTtl).toISOString(),
    };
    await policy.update({
      lifecycleState: { ...state, execution_lease: executionLease },
      version: Number(row.version || 1) + 1,
    }, ownedTransaction ? { transaction: ownedTransaction } : undefined);
    return { token, lease: executionLease, policy };
  });
}

async function releaseManagedCampaignOptimizationLease({
  managedCampaignId,
  leaseToken,
  transaction = null,
  dependencies = {},
} = {}) {
  const Policy = dependencies.Policy || db.CampaignOptimizationPolicy;
  const token = String(leaseToken || '').trim();
  if (!token) return { released: false, reason: 'lease_token_missing' };
  return withPolicyTransaction(transaction, dependencies, async (ownedTransaction) => {
    const policy = await Policy.findOne({
      where: { managedCampaignId },
      ...policyLockOptions(ownedTransaction),
    });
    if (!policy) return { released: false, reason: 'policy_missing' };
    const row = plain(policy) || {};
    const state = objectValue(row.lifecycleState);
    const existing = objectValue(state.execution_lease);
    if (String(existing.token || '') !== token) {
      return { released: false, reason: 'lease_mismatch' };
    }
    const nextState = { ...state };
    delete nextState.execution_lease;
    await policy.update({
      lifecycleState: nextState,
      version: Number(row.version || 1) + 1,
    }, ownedTransaction ? { transaction: ownedTransaction } : undefined);
    return { released: true };
  });
}

async function activateManagedCampaignOptimizationPolicy({
  managedCampaignId,
  leaseToken,
  transaction = null,
  dependencies = {},
} = {}) {
  const Policy = dependencies.Policy || db.CampaignOptimizationPolicy;
  const existing = await Policy.findOne({
    where: { managedCampaignId },
    ...policyLockOptions(transaction),
  });
  if (!existing) {
    throw optimizationError('CAMPAIGN_OPTIMIZATION_POLICY_ACTIVATION_FAILED', 'No existe policy tras el readback.', 409);
  }
  const row = plain(existing) || {};
  const state = objectValue(row.lifecycleState);
  if (!leaseToken || String(state.execution_lease?.token || '') !== String(leaseToken)) {
    throw optimizationError(
      'GOAL_POLICY_EXECUTION_LEASE_MISMATCH',
      'La reserva de ejecución cambió antes de activar la policy.',
      409,
    );
  }
  const nextState = { ...state };
  delete nextState.execution_lease;
  await existing.update({
    status: 'active',
    lifecycleState: nextState,
    version: Number(row.version || 1) + 1,
  }, transaction ? { transaction } : undefined);
  return existing;
}

function assertManagementConsent(campaign, targetStatus = null) {
  const row = plain(campaign) || {};
  const status = targetStatus || row.status;
  const blockers = [];
  if (isConnectOnly(row)) blockers.push(blocker('CONNECT_ONLY_BIDDING_MUTATION_FORBIDDEN', 'Conecta y mejora nunca puede mutar objetivos o pujas.'));
  if (!EXECUTABLE_STATUSES.has(status)) blockers.push(blocker('GOAL_POLICY_EXECUTION_STATUS_INVALID', 'La campaña no está aprobada para lanzamiento ni viva.'));
  if (row.provider !== 'google_ads' || !MANAGED_GOOGLE_FAMILIES.has(row.family)) blockers.push(blocker('GOAL_POLICY_EXECUTION_FAMILY_INVALID', 'La familia no admite ejecución gestionada de objetivos.'));
  if (!positiveInteger(row.approved_by_user_id) || !row.approved_at) blockers.push(blocker('ADMIN_MANAGEMENT_APPROVAL_REQUIRED', 'El gate admin del piloto no está aprobado.'));
  if (blockers.length) {
    throw optimizationError('GOAL_POLICY_MANAGEMENT_CONSENT_REQUIRED', 'Falta consentimiento de gestión válido.', 403, blockers);
  }
}

async function persistGoalOwnership({
  intakeConfig,
  configuredAccount,
  ownership,
  transaction = null,
  dependencies = {},
} = {}) {
  const IntakeConfig = dependencies.IntakeConfig || db.IntakeConfig;
  const sequelize = dependencies.sequelize || db.sequelize;
  if (!transaction && sequelize?.transaction && positiveInteger(plain(intakeConfig)?.id)) {
    return sequelize.transaction(async (ownedTransaction) => {
      const locked = await IntakeConfig.findByPk(positiveInteger(plain(intakeConfig).id), {
        transaction: ownedTransaction,
        lock: ownedTransaction.LOCK.UPDATE,
      });
      if (!locked) throw optimizationError('INTAKE_CONFIG_REQUIRED', 'IntakeConfig ya no existe.', 409);
      return persistGoalOwnership({
        intakeConfig: locked,
        configuredAccount,
        ownership,
        transaction: ownedTransaction,
        dependencies: { IntakeConfig, sequelize: null },
      });
    });
  }
  const row = intakeConfig;
  const config = objectValue(plain(row)?.config);
  const googleAds = objectValue(config.google_ads);
  const goalPolicy = objectValue(googleAds.goal_policy);
  const accounts = Array.isArray(goalPolicy.accounts) ? goalPolicy.accounts : [];
  const customerId = cleanCustomerId(ownership?.customer_id);
  const strategyRef = String(ownership?.strategy_ref || '').trim();
  const resourceName = String(ownership?.custom_goal_resource_name || '').trim();
  if (resourceName !== `customers/${customerId}/customConversionGoals/${cleanPositiveId(resourceName.split('/').pop()) || ''}`) {
    throw optimizationError('GOAL_POLICY_OWNERSHIP_RESOURCE_INVALID', 'El custom goal no pertenece inequívocamente a la cuenta.', 409);
  }
  const index = accounts.findIndex((account) => (
    cleanCustomerId(account?.customer_id) === customerId
    && String(account?.strategy_ref || '').trim() === strategyRef
  ));
  if (index < 0 || strategyRef !== configuredAccount.strategy_ref || customerId !== configuredAccount.customer_id) {
    throw optimizationError('GOAL_POLICY_OWNERSHIP_TARGET_STALE', 'No se puede persistir ownership sobre otra policy.', 409);
  }
  const nextAccounts = accounts.slice();
  nextAccounts[index] = { ...accounts[index], owned_custom_goal_resource_name: resourceName };
  await row.update({
    config: {
      ...config,
      google_ads: {
        ...googleAds,
        goal_policy: { ...goalPolicy, accounts: nextAccounts },
      },
    },
  }, transaction ? { transaction } : undefined);
}

async function previewManagedCampaignGoalPolicy({
  campaign,
  provisioning,
  targetStatus = null,
  dependencies = {},
} = {}) {
  assertManagementConsent(campaign, targetStatus);
  const context = provisioning;
  if (!context?.provisioned || !context.plan?.configured_account) {
    throw optimizationError('GOAL_POLICY_PROVISIONING_REQUIRED', 'La policy local debe provisionarse antes del preview.', 409);
  }
  const preview = dependencies.previewGoalPolicy || previewClinicaclickGoalPolicy;
  return preview({
    scope: {
      ...context.plan.scope.providerScope,
      user_id: dependencies.actorUserId || null,
    },
    configuredAccounts: [context.plan.configured_account],
    dependencies: dependencies.goalPolicyDependencies || {},
  });
}

async function executeManagedCampaignGoalPolicy({
  campaign,
  provisioning,
  targetStatus = null,
  expectedDigest = null,
  actorUserId = null,
  transaction = null,
  dependencies = {},
} = {}) {
  assertManagementConsent(campaign, targetStatus);
  const context = provisioning;
  if (!context?.provisioned || !context.plan?.configured_account) {
    throw optimizationError('GOAL_POLICY_PROVISIONING_REQUIRED', 'La policy local debe provisionarse antes de ejecutar.', 409);
  }
  const preview = await previewManagedCampaignGoalPolicy({
    campaign,
    provisioning: context,
    targetStatus,
    dependencies: { ...dependencies, actorUserId },
  });
  if (!preview.ready) {
    const previewBlockers = (preview.accounts || []).flatMap((account) => (
      account.plan?.blockers || [blocker(account.error?.code || 'GOAL_POLICY_PREVIEW_FAILED', account.error?.message || 'Falló el preview.')]
    ));
    throw optimizationError('GOAL_POLICY_PREVIEW_BLOCKED', 'El preview de objetivos no está listo.', 409, previewBlockers);
  }
  if (expectedDigest && preview.digest !== expectedDigest) {
    throw optimizationError('GOAL_POLICY_DIGEST_STALE', 'El digest indicado no coincide con el preview actual.', 409);
  }
  const apply = dependencies.applyGoalPolicy || applyClinicaclickGoalPolicy;
  const persistOwnership = async (ownership) => persistGoalOwnership({
    intakeConfig: context.intakeConfig,
    configuredAccount: context.plan.configured_account,
    ownership,
    transaction,
    dependencies: dependencies.persistenceDependencies || {},
  });
  let result;
  try {
    if (typeof dependencies.beforeExternalMutation === 'function') {
      await dependencies.beforeExternalMutation({
        operation: 'google_ads_goal_policy_apply',
        customer_id: context.plan.configured_account.customer_id,
        campaign_ids: context.plan.campaign_ids,
        preview_digest: preview.digest,
      });
    }
    result = await apply({
      scope: {
        ...context.plan.scope.providerScope,
        user_id: actorUserId,
      },
      configuredAccounts: [context.plan.configured_account],
      expectedDigest: preview.digest,
      // Esta confirmación se deriva del POST/gate admin ya persistido en la
      // ManagedCampaign. Ningún GET puede llegar a este executor.
      confirmExternalMutation: true,
      dependencies: {
        ...(dependencies.goalPolicyDependencies || {}),
        persistOwnership,
      },
    });
  } catch (error) {
    // applyClinicaclickGoalPolicy expone el resource_name si Google alcanzó a
    // crear el goal antes de detectar drift. Persistirlo evita duplicados en
    // un retry aunque el status de ManagedCampaign permanezca sin avanzar.
    let recoverableResource = error?.createdGoalResourceName || null;
    if (!recoverableResource) {
      try {
        const recoveryPreview = await previewManagedCampaignGoalPolicy({
          campaign,
          provisioning: context,
          targetStatus,
          dependencies: { ...dependencies, actorUserId },
        });
        recoverableResource = recoveryPreview.accounts?.[0]?.plan?.observed_custom_goal?.resource_name || null;
      } catch (_recoveryError) {
        recoverableResource = null;
      }
    }
    if (recoverableResource) {
      await persistOwnership({
        customer_id: context.plan.configured_account.customer_id,
        strategy_ref: context.plan.configured_account.strategy_ref,
        custom_goal_resource_name: recoverableResource,
      });
    }
    throw error;
  }
  if (!['applied', 'unchanged'].includes(result?.outcome) || result?.verification?.healthy !== true) {
    throw optimizationError(
      'GOAL_POLICY_READBACK_FAILED',
      'Google no confirmó por readback la policy aplicada; la campaña no puede entrar en launching.',
      502,
      [blocker('GOAL_POLICY_READBACK_UNHEALTHY', 'El resultado quedó aplicado pero no verificado.')],
    );
  }
  return { preview, digest: preview.digest, result };
}

module.exports = {
  EXECUTION_LEASE_TTL_MS,
  EXECUTABLE_STATUSES,
  LIVE_ENTRY_STATUSES,
  MANAGED_GOOGLE_FAMILIES,
  MAX_CAMPAIGNS,
  SCHEMA_VERSION,
  acquireManagedCampaignOptimizationLease,
  buildProvisioningPlan,
  activateManagedCampaignOptimizationPolicy,
  campaignScope,
  executeManagedCampaignGoalPolicy,
  findScopedIntakeConfig,
  goalPolicyAccountForStage,
  isConnectOnly,
  lifecycleStageExecutionBlockers,
  persistGoalOwnership,
  previewManagedCampaignGoalPolicy,
  provisionManagedCampaignOptimization,
  releaseManagedCampaignOptimizationLease,
  resolveCanonicalActionIds,
  resolveGoogleReferences,
};

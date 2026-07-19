'use strict';

const crypto = require('node:crypto');
const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const {
  REQUIRED_EXECUTION_CONFIRMATIONS,
  assertManagedCampaignExecutionGates,
  managedCampaignPublishingAccountScopeInput,
} = require('./managedCampaignPublishing.service');
const {
  getManagedCampaignExecutionAdapter,
  hasManagedCampaignExecutionAdapter,
} = require('./managedCampaignProviderExecutionRegistry.service');
const {
  findManagedCampaignAssociationAccountScope,
} = require('./managedCampaignAssociationScopes.service');
const managedCampaignOptimizationPolicy = require('./managedCampaignOptimizationPolicy.service');

const EXECUTE_JOB_TYPE = 'managed_campaign.google_search_create.v1';
const ACTIVATE_JOB_TYPE = 'managed_campaign.google_search_activate.v1';
const ROLLBACK_JOB_TYPE = 'managed_campaign.google_search_rollback.v1';
const ACTIVATION_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const EXECUTION_LEASE_TTL_MS = 30 * 60 * 1000;
const REQUIRED_ACTIVATION_CONFIRMATIONS = Object.freeze([
  'confirm_activation',
  'confirm_budget_commitment',
  'confirm_targeting_configuration',
  'confirm_schedule_configuration',
  'confirm_policy_compliance',
  'confirm_recent_approval',
]);
const ACTIVE_EXECUTION_STATUSES = new Set([
  'queued', 'executing', 'succeeded', 'activation_queued', 'activating', 'active',
  'activation_failed', 'manual_recovery_required', 'rollback_queued', 'rolling_back',
]);

class ManagedCampaignProviderExecutionError extends Error {
  constructor(code, message, httpStatus = 422, details = null) {
    super(message);
    this.name = 'ManagedCampaignProviderExecutionError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function explicitEnabled(value = process.env.MANAGED_CAMPAIGN_PROVIDER_EXECUTION_ENABLED) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function explicitActivationEnabled(value = process.env.MANAGED_CAMPAIGN_PROVIDER_ACTIVATION_ENABLED) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function featureEnabledFor(dependencies = {}) {
  return typeof dependencies.featureEnabled === 'function'
    ? dependencies.featureEnabled() === true
    : explicitEnabled();
}

function assertFeatureEnabled(dependencies = {}) {
  if (!featureEnabledFor(dependencies)) {
    throw new ManagedCampaignProviderExecutionError(
      'managed_campaign_provider_execution_disabled',
      'La ejecución de Piloto está desactivada en este entorno.',
      503
    );
  }
}

function activationFeatureEnabledFor(dependencies = {}) {
  const activationEnabled = typeof dependencies.activationFeatureEnabled === 'function'
    ? dependencies.activationFeatureEnabled() === true
    : explicitActivationEnabled();
  return featureEnabledFor(dependencies) && activationEnabled;
}

function assertActivationFeatureEnabled(dependencies = {}) {
  if (!activationFeatureEnabledFor(dependencies)) {
    throw new ManagedCampaignProviderExecutionError(
      'managed_campaign_provider_activation_disabled',
      'La activación de Piloto está desactivada en este entorno.',
      503
    );
  }
}

function plain(value) {
  return value?.get ? value.get({ plain: true }) : value;
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, max = 191) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function leaseExpiry(now = new Date()) {
  return new Date(new Date(now).getTime() + EXECUTION_LEASE_TTL_MS);
}

function leaseIsLive(execution, now = Date.now()) {
  const expiresAt = new Date(execution?.lease_expires_at || 0).getTime();
  return Boolean(execution?.lease_owner)
    && Number.isFinite(expiresAt)
    && expiresAt > now;
}

function phaseStatus(phase) {
  return phase === 'rollback' ? 'rolling_back' : phase === 'activate' ? 'activating' : 'executing';
}

function normalizedAccountId(value) {
  return String(value || '').replace(/\D/g, '') || null;
}

async function assertCurrentProviderAccountAuthorization({
  campaign,
  plan,
  transaction = null,
  dependencies = {},
} = {}) {
  const row = plain(campaign);
  const accountId = normalizedAccountId(plan?.specification?.account_id);
  const scopeInput = managedCampaignPublishingAccountScopeInput(row);
  let authorization;
  if (typeof dependencies.resolveAccountAuthorization === 'function') {
    authorization = await dependencies.resolveAccountAuthorization({
      campaign: row,
      plan,
      account_id: accountId,
      transaction,
    });
  } else {
    authorization = await findManagedCampaignAssociationAccountScope({
      ...scopeInput,
      accountId,
      transaction,
      lock: Boolean(transaction),
      models: modelsFor(dependencies),
    });
  }
  const scope = safeObject(authorization?.scope);
  const account = safeObject(authorization?.account);
  const expectedGroupId = positiveInteger(row?.grupo_clinica_id);
  const expectedClinicId = positiveInteger(row?.clinica_id);
  const valid = accountId
    && scopeInput.provider === 'google_ads'
    && account.provider === 'google_ads'
    && normalizedAccountId(account.account_id) === accountId
    && account.authorization_status === 'active'
    && account.selectable === true
    && (!expectedGroupId || positiveInteger(scope.group_id) === expectedGroupId)
    && (!expectedClinicId || positiveInteger(scope.clinic_id) === expectedClinicId);
  if (!valid) {
    throw new ManagedCampaignProviderExecutionError(
      'managed_execution_account_authorization_revoked',
      'La cuenta Google Ads ya no conserva una asignación activa para el scope aprobado.',
      403,
      {
        provider: scopeInput.provider || null,
        account_id: accountId,
        clinic_id: expectedClinicId,
        group_id: expectedGroupId,
      }
    );
  }
  return authorization;
}

function providerErrorCode(error, fallback) {
  const code = text(error?.code, 128);
  return code && /^[A-Za-z0-9_.-]+$/.test(code) ? code : fallback;
}

function retryableProviderError(error) {
  return error?.retryable === true || [
    'GOOGLE_ADS_PAUSED',
    'GOOGLE_ADS_QUOTA_REACHED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
  ].includes(error?.code);
}

function jobHasRetryRemaining(jobRequest) {
  const attempts = Math.max(0, Number(jobRequest?.attempts) || 0);
  const maxAttempts = Math.max(1, Number(jobRequest?.max_attempts) || 5);
  return attempts < maxAttempts;
}

function activationAuthorizationIsRecent(execution, now = Date.now()) {
  const requestedAt = new Date(execution?.activation_requested_at || 0).getTime();
  const authorization = safeObject(execution?.activation_authorization_snapshot);
  const authorizedAt = new Date(authorization.approved_at || 0).getTime();
  const actorMatches = positiveInteger(authorization.approved_by_user_id)
    === positiveInteger(execution?.activation_requested_by_user_id);
  const confirmation = safeObject(authorization.confirmations).confirm_recent_approval === true;
  const notFuture = requestedAt <= now + 5 * 60 * 1000 && authorizedAt <= now + 5 * 60 * 1000;
  const sameRequest = Math.abs(requestedAt - authorizedAt) <= 1_000;
  return requestedAt > 0
    && authorizedAt > 0
    && now - requestedAt <= ACTIVATION_APPROVAL_TTL_MS
    && now - authorizedAt <= ACTIVATION_APPROVAL_TTL_MS
    && notFuture
    && sameRequest
    && actorMatches
    && confirmation;
}

function uniqueConstraintCollision(error) {
  return error?.name === 'SequelizeUniqueConstraintError'
    || error?.original?.code === 'ER_DUP_ENTRY'
    || error?.parent?.code === 'ER_DUP_ENTRY';
}

function sanitizedWorkerError(error, fallbackCode, message) {
  const sanitized = new Error(message);
  sanitized.code = providerErrorCode(error, fallbackCode);
  return sanitized;
}

function executionDto(value) {
  const row = plain(value);
  if (!row) return null;
  return {
    id: row.id,
    managed_campaign_id: row.managed_campaign_id,
    funding_account_id: row.funding_account_id,
    source_publishing_audit_id: row.source_publishing_audit_id,
    job_request_id: positiveInteger(row.job_request_id),
    activation_job_request_id: positiveInteger(row.activation_job_request_id),
    rollback_job_request_id: positiveInteger(row.rollback_job_request_id),
    idempotency_key: row.idempotency_key,
    activation_idempotency_key: row.activation_idempotency_key,
    rollback_idempotency_key: row.rollback_idempotency_key,
    plan_id: row.plan_id,
    plan_hash: row.plan_hash,
    campaign_version: Number(row.campaign_version || 0),
    provider: row.provider,
    family: row.family,
    operation: row.operation,
    status: row.status,
    reservation_amount: money(row.reservation_amount),
    currency: row.currency,
    change_reference: row.change_reference,
    activation_change_reference: row.activation_change_reference || null,
    provider_refs: safeObject(row.provider_refs),
    ownership_snapshot: safeObject(row.ownership_snapshot),
    goal_policy_snapshot: row.goal_policy_snapshot ? safeObject(row.goal_policy_snapshot) : null,
    activation_snapshot: row.activation_snapshot ? safeObject(row.activation_snapshot) : null,
    rollback_snapshot: row.rollback_snapshot ? safeObject(row.rollback_snapshot) : null,
    requested_by_user_id: positiveInteger(row.requested_by_user_id),
    activation_requested_by_user_id: positiveInteger(row.activation_requested_by_user_id),
    rollback_requested_by_user_id: positiveInteger(row.rollback_requested_by_user_id),
    attempt_count: Number(row.attempt_count || 0),
    activation_attempt_count: Number(row.activation_attempt_count || 0),
    lease_version: Number(row.lease_version || 0),
    lease_expires_at: row.lease_expires_at || null,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    activation_requested_at: row.activation_requested_at || null,
    activated_at: row.activated_at || null,
    rolled_back_at: row.rolled_back_at || null,
    error_code: row.error_code || null,
    error_message: row.error_message || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function modelsFor(dependencies = {}) {
  return dependencies.models || db;
}

async function appendExecutionAudit({ models, campaign, execution, eventType, actorUserId, changes, transaction }) {
  if (!models.ManagedCampaignOperationAudit?.create || !positiveInteger(actorUserId)) return null;
  const version = Math.max(1, Number(campaign?.version || execution?.campaign_version) || 1);
  return models.ManagedCampaignOperationAudit.create({
    id: crypto.randomUUID(),
    managed_campaign_id: execution.managed_campaign_id,
    event_type: text(eventType, 64),
    actor_user_id: actorUserId,
    from_version: version,
    to_version: version,
    changes: safeObject(changes),
  }, { transaction });
}

function assertPlanMatchesLockedState({ plan, campaign, funding, audit, expectedPlanHash }) {
  const campaignRow = plain(campaign);
  const fundingRow = plain(funding);
  const auditRow = plain(audit);
  const planCampaign = safeObject(plan?.campaign);
  const spec = safeObject(plan?.specification);
  const budget = safeObject(spec.budget);
  const expectedHash = text(expectedPlanHash, 64);
  if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)
    || auditRow.plan_hash !== expectedHash || plan?.plan_hash !== expectedHash) {
    throw new ManagedCampaignProviderExecutionError(
      'managed_execution_plan_changed',
      'El plan auditado ya no coincide con el hash confirmado.',
      409
    );
  }
  if (auditRow.mode !== 'dry_run' || auditRow.readiness_status !== 'ready'
    || auditRow.provider_call_performed === true || plan?.readiness?.ready !== true
    || auditRow.plan_id !== plan?.plan_id
    || auditRow.provider !== campaignRow.provider
    || auditRow.family !== campaignRow.family) {
    throw new ManagedCampaignProviderExecutionError(
      'managed_execution_source_audit_not_ready',
      'La ejecución requiere un dry-run listo y sin llamadas previas al proveedor.',
      409
    );
  }
  if (String(planCampaign.id) !== String(campaignRow.id)
    || Number(planCampaign.version) !== Number(campaignRow.version)
    || Number(auditRow.campaign_version) !== Number(campaignRow.version)
    || planCampaign.provider !== campaignRow.provider
    || planCampaign.family !== campaignRow.family
    || campaignRow.status !== 'approved_to_launch') {
    throw new ManagedCampaignProviderExecutionError(
      'managed_execution_campaign_changed',
      'La campaña cambió o ya no está aprobada para lanzamiento.',
      409
    );
  }
  if (campaignRow.management_mode !== 'autopilot' || campaignRow.operation_mode !== 'managed') {
    throw new ManagedCampaignProviderExecutionError(
      'managed_execution_mode_forbidden',
      'Solo una campaña Piloto en modo gestionado puede ejecutarse.',
      409
    );
  }
  if (!hasManagedCampaignExecutionAdapter(campaignRow.provider, campaignRow.family, spec.operation)) {
    throw new ManagedCampaignProviderExecutionError(
      'managed_execution_adapter_unsupported',
      'Esta combinación de proveedor, familia u operación no tiene ejecución real.',
      422,
      { provider: campaignRow.provider, family: campaignRow.family, operation: spec.operation || null }
    );
  }
  if (campaignRow.provider !== 'google_ads' || campaignRow.family !== 'google_search' || spec.operation !== 'create_new') {
    throw new ManagedCampaignProviderExecutionError(
      'managed_execution_only_google_search_create',
      'Piloto solo puede crear Google Search en PAUSED; Meta, PMax y update_existing no están admitidos.',
      422
    );
  }
  const reservationAmount = money(budget.provider_media_budget_amount);
  const availableAmount = money(fundingRow.available_amount);
  const currency = text(budget.currency, 3)?.toUpperCase();
  if (reservationAmount <= 0 || availableAmount < reservationAmount
    || currency !== text(fundingRow.currency, 3)?.toUpperCase()) {
    throw new ManagedCampaignProviderExecutionError(
      'managed_execution_funding_changed',
      'El saldo disponible o su moneda ya no coincide con el plan auditado.',
      409
    );
  }
  if (money(budget.media_budget_available) !== availableAmount) {
    throw new ManagedCampaignProviderExecutionError(
      'managed_execution_available_balance_changed',
      'El saldo cambió después del dry-run; genera y confirma un plan nuevo.',
      409
    );
  }
  return { campaignRow, fundingRow, auditRow, spec, reservationAmount, currency };
}

async function reserveFunding({ models, funding, executionId, amount, currency, actorUserId, transaction }) {
  const nextReserved = money(money(funding.reserved_amount) + amount);
  const nextAvailable = money(money(funding.available_amount) - amount);
  if (nextAvailable < 0) {
    throw new ManagedCampaignProviderExecutionError('managed_execution_insufficient_funds', 'El saldo ya no cubre la reserva.', 409);
  }
  await funding.update({
    reserved_amount: nextReserved,
    available_amount: nextAvailable,
    status: nextAvailable <= 0 ? 'depleted' : (nextAvailable <= money(funding.media_budget_net) * 0.2 ? 'low_balance' : 'funded'),
  }, { transaction });
  await models.ManagedCampaignLedgerEntry.create({
    id: crypto.randomUUID(),
    funding_account_id: funding.id,
    entry_type: 'media_reserve',
    direction: 'debit',
    amount,
    currency,
    occurred_at: new Date(),
    external_ref: `provider-execution:${executionId}:reserve`,
    metadata: { execution_id: executionId, purpose: 'google_search_paused_creation' },
    created_by_user_id: actorUserId,
  }, { transaction });
}

async function releaseFunding({ models, funding, execution, actorUserId = null, reason, transaction }) {
  const externalRef = `provider-execution:${execution.id}:release`;
  const existing = await models.ManagedCampaignLedgerEntry.findOne({
    where: { funding_account_id: funding.id, entry_type: 'release', external_ref: externalRef },
    transaction,
    ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (existing) return { released: 0, idempotent: true };
  const releasable = Math.min(money(execution.reservation_amount), money(funding.reserved_amount));
  if (releasable <= 0) return { released: 0, idempotent: false };
  const nextReserved = money(money(funding.reserved_amount) - releasable);
  const capacity = money(money(funding.media_budget_net) - money(funding.media_spend) - nextReserved);
  const nextAvailable = Math.max(0, capacity);
  await funding.update({
    reserved_amount: nextReserved,
    available_amount: nextAvailable,
    status: nextAvailable <= 0 ? 'depleted' : (nextAvailable <= money(funding.media_budget_net) * 0.2 ? 'low_balance' : 'funded'),
  }, { transaction });
  await models.ManagedCampaignLedgerEntry.create({
    id: crypto.randomUUID(),
    funding_account_id: funding.id,
    entry_type: 'release',
    direction: 'credit',
    amount: releasable,
    currency: execution.currency,
    occurred_at: new Date(),
    external_ref: externalRef,
    metadata: { execution_id: execution.id, reason: text(reason, 128) },
    created_by_user_id: actorUserId,
  }, { transaction });
  return { released: releasable, idempotent: false };
}

async function enqueueExecution(input, dependencies = {}) {
  assertFeatureEnabled(dependencies);
  const models = modelsFor(dependencies);
  const sequelize = dependencies.sequelize || models.sequelize;
  const campaignId = text(input?.campaignId, 36);
  const auditId = text(input?.sourcePublishingAuditId, 36);
  const actorUserId = positiveInteger(input?.actorUserId);
  const idempotencyKey = text(input?.idempotencyKey, 191);
  const changeReference = text(input?.changeReference, 191);
  if (!campaignId || !auditId || !actorUserId || !idempotencyKey || !changeReference) {
    throw new ManagedCampaignProviderExecutionError(
      'managed_execution_request_invalid',
      'Campaña, dry-run, operador, idempotencia y referencia de cambio son obligatorios.',
      400
    );
  }

  try {
    return await sequelize.transaction(async (transaction) => {
    const campaign = await models.ManagedCampaign.findByPk(campaignId, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!campaign) throw new ManagedCampaignProviderExecutionError('managed_execution_campaign_not_found', 'La campaña no existe.', 404);
    const funding = await models.ManagedCampaignFundingAccount.findOne({
      where: { managed_campaign_id: campaignId },
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!funding) throw new ManagedCampaignProviderExecutionError('managed_execution_funding_not_found', 'La campaña no tiene prepago.', 409);
    const verifiedTopups = await models.ManagedCampaignLedgerEntry.findAll({
      where: { funding_account_id: funding.id, entry_type: 'topup' },
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!verifiedTopups.some((entry) => safeObject(plain(entry).metadata).payment_verified === true)) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_execution_prepayment_not_verified',
        'El prepago ya no conserva una verificación bancaria auditable.',
        409
      );
    }
    const audit = await models.ManagedCampaignPublishingAudit.findOne({
      where: { id: auditId, managed_campaign_id: campaignId },
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!audit) throw new ManagedCampaignProviderExecutionError('managed_execution_audit_not_found', 'El dry-run no existe.', 404);

    const plan = safeObject(plain(audit).plan_snapshot);
    await assertCurrentProviderAccountAuthorization({
      campaign,
      plan,
      transaction,
      dependencies,
    });

    const existing = await models.ManagedCampaignProviderExecution.findOne({
      where: { managed_campaign_id: campaignId, idempotency_key: idempotencyKey },
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (existing) {
      if (existing.plan_hash !== input.expectedPlanHash || existing.source_publishing_audit_id !== auditId) {
        throw new ManagedCampaignProviderExecutionError(
          'managed_execution_idempotency_conflict',
          'La clave de idempotencia ya identifica otro plan.',
          409
        );
      }
      return { created: false, execution: existing, job: existing.job_request_id ? { id: existing.job_request_id } : null };
    }

    const locked = assertPlanMatchesLockedState({
      plan,
      campaign,
      funding,
      audit,
      expectedPlanHash: input.expectedPlanHash,
    });
    let authorization;
    try {
      authorization = assertManagedCampaignExecutionGates({
        plan,
        confirmation: {
          ...Object.fromEntries(REQUIRED_EXECUTION_CONFIRMATIONS.map((key) => (
            [key, input?.confirmation?.[key] === true]
          ))),
          plan_hash: input.expectedPlanHash,
          actor_user_id: actorUserId,
          idempotency_key: idempotencyKey,
          change_reference: changeReference,
        },
      });
    } catch (error) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_execution_gates_failed',
        'No se cumplen todos los gates explícitos de ejecución.',
        409,
        { failures: error.failures || [] }
      );
    }

    const active = await models.ManagedCampaignProviderExecution.findOne({
      where: { managed_campaign_id: campaignId, status: Array.from(ACTIVE_EXECUTION_STATUSES) },
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (active) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_execution_already_active',
        'La campaña ya tiene una ejecución o rollback sin cerrar.',
        409,
        { execution_id: active.id, status: active.status }
      );
    }

    const executionId = crypto.randomUUID();
    await reserveFunding({
      models,
      funding,
      executionId,
      amount: locked.reservationAmount,
      currency: locked.currency,
      actorUserId,
      transaction,
    });
    const execution = await models.ManagedCampaignProviderExecution.create({
      id: executionId,
      managed_campaign_id: campaignId,
      funding_account_id: funding.id,
      source_publishing_audit_id: audit.id,
      idempotency_key: idempotencyKey,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      plan_snapshot: plan,
      campaign_version: Number(campaign.version),
      provider: campaign.provider,
      family: campaign.family,
      operation: locked.spec.operation,
      status: 'queued',
      reservation_amount: locked.reservationAmount,
      currency: locked.currency,
      change_reference: changeReference,
      authorization_snapshot: authorization,
      provider_refs: {},
      ownership_snapshot: {},
      lease_version: 0,
      lease_expires_at: null,
      requested_by_user_id: actorUserId,
    }, { transaction });
    const job = await (dependencies.enqueueJobRequest || jobRequestsService.enqueueJobRequest)({
      type: EXECUTE_JOB_TYPE,
      priority: 'high',
      origin: 'managed_campaign_operator',
      requestedBy: actorUserId,
      maxAttempts: 5,
      payload: {
        execution_id: executionId,
        managed_campaign_id: campaignId,
        plan_hash: plan.plan_hash,
      },
    }, { transaction, JobRequestModel: models.JobRequest });
    const launchingVersion = Number(campaign.version || 0) + 1;
    await execution.update({
      job_request_id: job.id,
      campaign_version: launchingVersion,
    }, { transaction });
    await campaign.update({
      version: launchingVersion,
      status: 'launching',
      platform_refs: {
        ...safeObject(campaign.platform_refs),
        managed_execution_id: executionId,
      },
      operational_blocker: 'Creación Google Search en PAUSED encolada; todavía no puede servir anuncios.',
    }, { transaction });
      return { created: true, execution, job };
    });
  } catch (error) {
    // Two identical operator requests can pass the first read concurrently.
    // The database uniqueness constraint is the final serialization point;
    // after its rollback, return the durable winner instead of surfacing a 500
    // or reserving funds twice.
    if (!uniqueConstraintCollision(error)) throw error;
    const existing = await models.ManagedCampaignProviderExecution.findOne({
      where: { managed_campaign_id: campaignId, idempotency_key: idempotencyKey },
    });
    if (!existing
      || existing.plan_hash !== input.expectedPlanHash
      || existing.source_publishing_audit_id !== auditId) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_execution_idempotency_conflict',
        'La clave de idempotencia ya identifica otro plan.',
        409
      );
    }
    return {
      created: false,
      execution: existing,
      job: existing.job_request_id ? { id: existing.job_request_id } : null,
    };
  }
}

function executionCampaignId(execution) {
  return text(safeObject(execution?.provider_refs).campaign, 512)?.split('/').pop() || null;
}

function campaignOwnsExecution(campaign, execution, { requireCampaignId = false } = {}) {
  const refs = safeObject(campaign?.platform_refs);
  const ownedCampaignId = executionCampaignId(execution);
  return refs.managed_execution_id === execution?.id
    && (!requireCampaignId || (ownedCampaignId
      && String(refs.campaign_id || '') === String(ownedCampaignId)));
}

function rollbackAuthorizationSnapshot({ campaign, funding, execution, actorUserId }) {
  return {
    schema_version: 'managed-campaign-provider-rollback-authorization/v1',
    approved_at: new Date().toISOString(),
    approved_by_user_id: actorUserId,
    plan_hash: execution.plan_hash,
    campaign_version: Number(campaign.version),
    campaign_status: campaign.status,
    managed_execution_id: execution.id,
    campaign_id: executionCampaignId(execution),
    funding_account_id: funding.id,
    funding_currency: funding.currency,
    funding_reserved_amount: money(funding.reserved_amount),
    reservation_amount: money(execution.reservation_amount),
  };
}

function rollbackAuthorizationIsCurrent({ campaign, funding, execution }) {
  const authorization = safeObject(execution?.rollback_snapshot);
  return authorization.schema_version === 'managed-campaign-provider-rollback-authorization/v1'
    && authorization.plan_hash === execution.plan_hash
    && positiveInteger(authorization.approved_by_user_id) === positiveInteger(execution.rollback_requested_by_user_id)
    && Number(authorization.campaign_version) === Number(campaign?.version)
    && authorization.campaign_status === campaign?.status
    && authorization.managed_execution_id === execution.id
    && String(authorization.campaign_id || '') === String(executionCampaignId(execution) || '')
    && authorization.funding_account_id === funding?.id
    && authorization.funding_currency === funding?.currency
    && money(authorization.funding_reserved_amount) === money(funding?.reserved_amount)
    && money(authorization.reservation_amount) === money(execution.reservation_amount)
    && campaignOwnsExecution(campaign, execution, { requireCampaignId: true })
    && money(funding?.reserved_amount) === money(execution.reservation_amount);
}

function phaseCampaignFenceIsCurrent({ campaign, funding, execution, phase }) {
  if (!campaign || !funding || funding.currency !== execution.currency
    || money(funding.reserved_amount) !== money(execution.reservation_amount)) return false;
  if (phase === 'rollback') return rollbackAuthorizationIsCurrent({ campaign, funding, execution });
  return campaign.status === 'launching'
    && Number(campaign.version) === Number(execution.campaign_version)
    && campaignOwnsExecution(campaign, execution, { requireCampaignId: phase === 'activate' });
}

async function terminalizeRevokedAuthorization({
  models,
  execution,
  campaign,
  funding,
  phase,
  reclaimedExpiredLease = false,
  transaction,
}) {
  const actorUserId = phase === 'activate'
    ? execution.activation_requested_by_user_id
    : phase === 'rollback'
      ? execution.rollback_requested_by_user_id
      : execution.requested_by_user_id;
  const fundingFenceCurrent = funding?.currency === execution.currency
    && money(funding?.reserved_amount) === money(execution.reservation_amount);
  const uncertainLocalOutcome = reclaimedExpiredLease
    || (phase === 'execute' && !fundingFenceCurrent);
  const mayUpdateCampaign = !reclaimedExpiredLease
    && phaseCampaignFenceIsCurrent({ campaign, funding, execution, phase });
  if (phase === 'execute' && !uncertainLocalOutcome) {
    await releaseFunding({
      models,
      funding,
      execution,
      actorUserId,
      reason: 'provider_account_authorization_revoked_before_mutation',
      transaction,
    });
  }
  const status = uncertainLocalOutcome || phase === 'rollback'
    ? 'manual_recovery_required'
    : phase === 'execute'
      ? 'cancelled'
      : 'activation_failed';
  await execution.update({
    status,
    ...(phase === 'activate' ? {
      activation_snapshot: {
        outcome: uncertainLocalOutcome ? 'unknown_after_expired_lease' : 'definitive_no_mutation',
        reason: 'provider_account_authorization_revoked',
        checked_at: new Date().toISOString(),
      },
    } : {}),
    completed_at: new Date(),
    lease_owner: null,
    lease_expires_at: null,
    error_code: 'managed_execution_account_authorization_revoked',
    error_message: uncertainLocalOutcome
      ? 'La autorización fue revocada tras expirar un lease en curso; el resultado externo requiere reconciliación manual.'
      : phase === 'rollback'
        ? 'La autorización fue revocada; no se intentó retirar Google y se requiere reconciliación operativa.'
        : 'La autorización fue revocada antes de mutar Google.',
  }, { transaction });
  if (mayUpdateCampaign) {
    await campaign.update({
      version: Number(campaign.version || 0) + 1,
      status: 'blocked',
      operational_blocker: phase === 'rollback'
        ? 'La cuenta Google perdió autorización antes del rollback. No hubo llamada al proveedor; conserva la reserva y requiere intervención.'
        : 'La cuenta Google perdió autorización antes de la mutación. No hubo llamada al proveedor.',
    }, { transaction });
  }
  await appendExecutionAudit({
    models,
    campaign,
    execution,
    eventType: 'provider_account_authorization_revoked',
    actorUserId,
    changes: {
      execution_id: execution.id,
      phase,
      provider_mutation_performed: false,
      expired_in_progress_lease: reclaimedExpiredLease,
      campaign_state_preserved: !mayUpdateCampaign,
      terminal_status: status,
    },
    transaction,
  });
  return { terminal: true, execution };
}

async function claimExecution({ executionId, jobId, phase, dependencies }) {
  const models = modelsFor(dependencies);
  const sequelize = dependencies.sequelize || models.sequelize;
  return sequelize.transaction(async (transaction) => {
    const execution = await models.ManagedCampaignProviderExecution.findByPk(executionId, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!execution) throw new ManagedCampaignProviderExecutionError('managed_execution_not_found', 'La ejecución no existe.', 404);
    const expectedJobId = phase === 'rollback'
      ? execution.rollback_job_request_id
      : phase === 'activate'
        ? execution.activation_job_request_id
        : execution.job_request_id;
    if (!positiveInteger(jobId) || Number(expectedJobId) !== Number(jobId)) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_execution_job_ownership_mismatch',
        'El JobRequest no es propietario de esta fase de ejecución.',
        409
      );
    }
    const terminal = phase === 'rollback'
      ? ['rolled_back', 'manual_recovery_required', 'cancelled'].includes(execution.status)
      : phase === 'activate'
        ? ['active', 'activation_failed', 'manual_recovery_required', 'rolled_back', 'cancelled'].includes(execution.status)
        : ['succeeded', 'failed', 'manual_recovery_required', 'rolled_back', 'cancelled'].includes(execution.status);
    if (terminal) return { terminal: true, execution };
    const allowed = phase === 'rollback'
      ? ['rollback_queued', 'rolling_back']
      : phase === 'activate'
        ? ['activation_queued', 'activating']
        : ['queued', 'executing'];
    if (!allowed.includes(execution.status)) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_execution_state_conflict',
        `La ejecución no puede iniciar ${phase} desde ${execution.status}.`,
        409
      );
    }
    const reclaimedExpiredLease = execution.status === phaseStatus(phase) && !leaseIsLive(execution);
    if (execution.status === phaseStatus(phase) && leaseIsLive(execution)) {
      return {
        terminal: false,
        contended: true,
        execution,
        retryAt: execution.lease_expires_at,
      };
    }
    const campaign = await models.ManagedCampaign.findByPk(execution.managed_campaign_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const funding = await models.ManagedCampaignFundingAccount.findByPk(execution.funding_account_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!campaign || !funding) {
      throw new ManagedCampaignProviderExecutionError('managed_execution_graph_missing', 'Falta campaña o cuenta de prepago.', 409);
    }
    if (!featureEnabledFor(dependencies)) {
      if (phase === 'execute') {
        const fundingFenceCurrent = funding.currency === execution.currency
          && money(funding.reserved_amount) === money(execution.reservation_amount);
        const uncertainLocalOutcome = reclaimedExpiredLease || !fundingFenceCurrent;
        const mayUpdateCampaign = !reclaimedExpiredLease
          && phaseCampaignFenceIsCurrent({ campaign, funding, execution, phase });
        if (!uncertainLocalOutcome) {
          await releaseFunding({ models, funding, execution, reason: 'feature_disabled_before_provider_call', transaction });
        }
        await execution.update({
          status: uncertainLocalOutcome ? 'manual_recovery_required' : 'cancelled',
          error_code: 'managed_campaign_provider_execution_disabled',
          error_message: uncertainLocalOutcome
            ? 'El flag se desactivó tras expirar un lease en curso; conserva la reserva hasta reconciliar Google.'
            : 'La ejecución fue cancelada antes de llamar al proveedor porque el flag está desactivado.',
          completed_at: new Date(),
          lease_owner: null,
          lease_expires_at: null,
        }, { transaction });
        if (mayUpdateCampaign) {
          await campaign.update({
            version: Number(campaign.version || 0) + 1,
            status: 'blocked',
            operational_blocker: 'Piloto desactivado antes de crear la campaña.',
          }, { transaction });
        }
        return { terminal: true, execution };
      }
      if (reclaimedExpiredLease) {
        await execution.update({
          status: 'manual_recovery_required',
          completed_at: new Date(),
          lease_owner: null,
          lease_expires_at: null,
          error_code: 'managed_campaign_provider_execution_disabled',
          error_message: 'El flag se desactivó tras expirar un lease en curso; el resultado externo requiere reconciliación manual.',
        }, { transaction });
        return { terminal: true, execution };
      }
      throw new ManagedCampaignProviderExecutionError(
        'managed_campaign_provider_execution_disabled',
        'El rollback automático está desactivado; requiere intervención operativa.',
        503
      );
    }
    if (phase === 'execute'
      && (Number(campaign.version) !== Number(execution.campaign_version) || campaign.status !== 'launching')) {
      const fundingFenceCurrent = funding.currency === execution.currency
        && money(funding.reserved_amount) === money(execution.reservation_amount);
      const uncertainLocalOutcome = reclaimedExpiredLease || !fundingFenceCurrent;
      if (!uncertainLocalOutcome) {
        await releaseFunding({ models, funding, execution, reason: 'campaign_changed_before_provider_call', transaction });
      }
      await execution.update({
        status: uncertainLocalOutcome ? 'manual_recovery_required' : 'cancelled',
        error_code: 'managed_execution_campaign_changed',
        error_message: uncertainLocalOutcome
          ? 'La campaña cambió tras expirar un lease en curso; conserva la reserva hasta reconciliar Google.'
          : 'La campaña cambió antes de llamar al proveedor.',
        completed_at: new Date(),
        lease_owner: null,
        lease_expires_at: null,
      }, { transaction });
      return { terminal: true, execution };
    }
    if (phase === 'activate') {
      const refs = safeObject(campaign.platform_refs);
      const reservationAmount = money(execution.reservation_amount);
      const localActivationFenceValid = campaign.status === 'launching'
        && Number(campaign.version) === Number(execution.campaign_version)
        && refs.managed_execution_id === execution.id
        && String(refs.campaign_id || '') === String(executionCampaignId(execution) || '')
        && money(funding.reserved_amount) === reservationAmount
        && funding.currency === execution.currency;
      if (!localActivationFenceValid
        || (!activationAuthorizationIsRecent(execution) && !reclaimedExpiredLease)) {
        await execution.update({
          status: reclaimedExpiredLease ? 'manual_recovery_required' : 'activation_failed',
          activation_snapshot: {
            outcome: reclaimedExpiredLease ? 'unknown_after_expired_lease' : 'definitive_no_mutation',
            reason: 'activation_preconditions_changed',
            checked_at: new Date().toISOString(),
          },
          error_code: 'managed_activation_preconditions_changed',
          error_message: reclaimedExpiredLease
            ? 'El estado local cambió tras expirar un lease de activación; requiere reconciliación del estado Google.'
            : 'La aprobación, saldo reservado o estado local dejó de ser válido antes de llamar a Google.',
          completed_at: new Date(),
          lease_owner: null,
          lease_expires_at: null,
        }, { transaction });
        if (!reclaimedExpiredLease && localActivationFenceValid) {
          await campaign.update({
            version: Number(campaign.version || 0) + 1,
            status: 'blocked',
            operational_blocker: 'La activación se canceló sin mutar Google porque la aprobación dejó de ser válida. Ejecuta rollback o prepara un plan nuevo.',
          }, { transaction });
        }
        await appendExecutionAudit({
          models,
          campaign,
          execution,
          eventType: 'provider_activation_preconditions_failed',
          actorUserId: execution.activation_requested_by_user_id,
          changes: {
            execution_id: execution.id,
            provider_mutation_performed: false,
            expired_in_progress_lease: reclaimedExpiredLease,
            campaign_state_preserved: reclaimedExpiredLease || !localActivationFenceValid,
            reason: 'activation_preconditions_changed',
          },
          transaction,
        });
        return { terminal: true, execution };
      }
    }
    if (phase === 'rollback' && !rollbackAuthorizationIsCurrent({ campaign, funding, execution })) {
      await execution.update({
        status: 'manual_recovery_required',
        completed_at: new Date(),
        lease_owner: null,
        lease_expires_at: null,
        error_code: 'managed_rollback_authorization_fence_changed',
        error_message: 'Campaña, referencias o reserva cambiaron después de autorizar el rollback; no se llamó al proveedor.',
      }, { transaction });
      await appendExecutionAudit({
        models,
        campaign,
        execution,
        eventType: 'provider_rollback_authorization_fence_changed',
        actorUserId: execution.rollback_requested_by_user_id,
        changes: {
          execution_id: execution.id,
          provider_mutation_performed: false,
          campaign_state_preserved: true,
          funding_state_preserved: true,
          expired_in_progress_lease: reclaimedExpiredLease,
        },
        transaction,
      });
      return { terminal: true, execution };
    }
    const plan = safeObject(plain(execution).plan_snapshot);
    try {
      await assertCurrentProviderAccountAuthorization({
        campaign,
        plan,
        transaction,
        dependencies,
      });
    } catch (error) {
      if (error?.code !== 'managed_execution_account_authorization_revoked') throw error;
      return terminalizeRevokedAuthorization({
        models,
        execution,
        campaign,
        funding,
        phase,
        reclaimedExpiredLease,
        transaction,
      });
    }
    const leaseOwner = crypto.randomUUID();
    const leaseVersion = Number(execution.lease_version || 0) + 1;
    const expiresAt = leaseExpiry();
    await execution.update({
      status: phaseStatus(phase),
      lease_owner: leaseOwner,
      lease_version: leaseVersion,
      lease_expires_at: expiresAt,
      ...(phase === 'activate'
        ? { activation_attempt_count: Number(execution.activation_attempt_count || 0) + 1 }
        : { attempt_count: Number(execution.attempt_count || 0) + 1 }),
      started_at: execution.started_at || new Date(),
      error_code: null,
      error_message: null,
    }, { transaction });
    return {
      terminal: false,
      execution,
      campaign,
      funding,
      leaseOwner,
      leaseVersion,
      leaseExpiresAt: expiresAt,
      campaignFenceVersion: Number(campaign.version),
      reclaimedExpiredLease,
    };
  });
}

async function renewExecutionFence({
  claimed,
  phase,
  dependencies = {},
  allowStaleActivationApproval = false,
}) {
  const models = modelsFor(dependencies);
  const sequelize = dependencies.sequelize || models.sequelize;
  return sequelize.transaction(async (transaction) => {
    const execution = await models.ManagedCampaignProviderExecution.findByPk(claimed.execution.id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!execution
      || execution.status !== phaseStatus(phase)
      || execution.lease_owner !== claimed.leaseOwner
      || Number(execution.lease_version || 0) !== Number(claimed.leaseVersion || 0)
      || !leaseIsLive(execution)) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_execution_fence_lost',
        'La ejecución perdió su fencing durable antes de mutar el proveedor.',
        409
      );
    }
    const campaign = await models.ManagedCampaign.findByPk(execution.managed_campaign_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const funding = await models.ManagedCampaignFundingAccount.findByPk(execution.funding_account_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!campaign || !funding) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_execution_graph_missing',
        'Falta campaña o cuenta de prepago antes de la mutación.',
        409
      );
    }
    const platformRefs = safeObject(campaign.platform_refs);
    const ownedCampaignId = text(safeObject(execution.provider_refs).campaign, 512)?.split('/').pop() || null;
    const baseFenceValid = Number(campaign.version) === Number(claimed.campaignFenceVersion)
      && platformRefs.managed_execution_id === execution.id
      && funding.currency === execution.currency
      && money(funding.reserved_amount) === money(execution.reservation_amount);
    const providerRefsValid = phase === 'execute'
      ? true
      : String(platformRefs.campaign_id || '') === String(ownedCampaignId || '');
    const lifecycleValid = phase === 'rollback'
      ? baseFenceValid
        && providerRefsValid
        && rollbackAuthorizationIsCurrent({ campaign, funding, execution })
      : baseFenceValid
        && providerRefsValid
        && campaign.status === 'launching'
        && Number(campaign.version) === Number(execution.campaign_version)
        && money(funding.reserved_amount) === money(execution.reservation_amount);
    const activationValid = phase !== 'activate'
      || ((allowStaleActivationApproval || activationAuthorizationIsRecent(execution))
        && Boolean(campaign.approved_at)
        && positiveInteger(campaign.approved_by_user_id));
    if (!lifecycleValid || !activationValid) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_execution_fence_state_changed',
        'Campaña, referencias, aprobación o reserva cambiaron durante la ejecución.',
        409,
        { phase }
      );
    }
    await assertCurrentProviderAccountAuthorization({
      campaign,
      plan: safeObject(plain(execution).plan_snapshot),
      transaction,
      dependencies,
    });
    const expiresAt = leaseExpiry();
    await execution.update({ lease_expires_at: expiresAt }, { transaction });
    claimed.execution = execution;
    claimed.campaign = campaign;
    claimed.funding = funding;
    claimed.leaseExpiresAt = expiresAt;
    return { execution, campaign, funding, expiresAt };
  });
}

function providerMutationGuard({ claimed, phase, dependencies }) {
  return async () => renewExecutionFence({ claimed, phase, dependencies });
}

async function finalizeExecution({ claimed, outcome, error, manualRecoveryRequired, dependencies }) {
  const models = modelsFor(dependencies);
  const sequelize = dependencies.sequelize || models.sequelize;
  return sequelize.transaction(async (transaction) => {
    const execution = await models.ManagedCampaignProviderExecution.findByPk(claimed.execution.id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!execution || execution.status !== 'executing'
      || execution.lease_owner !== claimed.leaseOwner
      || Number(execution.lease_version || 0) !== Number(claimed.leaseVersion || 0)) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_execution_lease_lost',
        'El worker perdió la propiedad de la ejecución y no puede escribir su resultado.',
        409
      );
    }
    const campaign = await models.ManagedCampaign.findByPk(execution.managed_campaign_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const funding = await models.ManagedCampaignFundingAccount.findByPk(execution.funding_account_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const platformRefs = safeObject(campaign?.platform_refs);
    let accountAuthorized = false;
    try {
      await assertCurrentProviderAccountAuthorization({
        campaign,
        plan: safeObject(plain(execution).plan_snapshot),
        transaction,
        dependencies,
      });
      accountAuthorized = true;
    } catch (authorizationError) {
      if (authorizationError?.code !== 'managed_execution_account_authorization_revoked') throw authorizationError;
    }
    const fundingFenceValid = Boolean(funding)
      && funding.currency === execution.currency
      && money(funding.reserved_amount) === money(execution.reservation_amount);
    const structuralFenceValid = Boolean(campaign)
      && fundingFenceValid
      && Number(campaign.version) === Number(claimed.campaignFenceVersion)
      && Number(campaign.version) === Number(execution.campaign_version)
      && campaign.status === 'launching'
      && platformRefs.managed_execution_id === execution.id;
    const localFenceValid = structuralFenceValid && accountAuthorized;
    if (outcome) {
      if (!localFenceValid) {
        await execution.update({
          status: 'manual_recovery_required',
          provider_refs: safeObject(outcome.provider_refs),
          ownership_snapshot: safeObject(outcome.ownership),
          completed_at: new Date(),
          lease_owner: null,
          lease_expires_at: null,
          error_code: 'managed_execution_post_mutation_fence_changed',
          error_message: 'Google creó la estructura PAUSED, pero el estado local cambió; requiere reconciliación manual.',
        }, { transaction });
        await appendExecutionAudit({
          models,
          campaign,
          execution,
          eventType: 'provider_creation_local_fence_changed',
          actorUserId: execution.requested_by_user_id,
          changes: {
            execution_id: execution.id,
            provider_mutation_performed: true,
            provider_status: 'PAUSED',
            campaign_state_preserved: true,
          },
          transaction,
        });
        return execution;
      }
      const succeededCampaignVersion = Number(campaign.version || 0) + 1;
      await execution.update({
        status: 'succeeded',
        campaign_version: succeededCampaignVersion,
        provider_refs: safeObject(outcome.provider_refs),
        ownership_snapshot: safeObject(outcome.ownership),
        completed_at: new Date(),
        lease_owner: null,
        lease_expires_at: null,
        error_code: null,
        error_message: null,
      }, { transaction });
      await campaign.update({
        version: succeededCampaignVersion,
        status: 'launching',
        platform_refs: {
          ...safeObject(campaign.platform_refs),
          campaign_id: text(outcome.provider_refs?.campaign, 512)?.split('/').pop() || null,
          managed_execution_id: execution.id,
        },
        operational_blocker: 'Campaña Google Search creada en PAUSED con ubicación, idiomas y horario verificados. Requiere una activación administrativa separada.',
      }, { transaction });
      return execution;
    }
    const effectiveManualRecovery = manualRecoveryRequired || !fundingFenceValid;
    const status = effectiveManualRecovery ? 'manual_recovery_required' : 'failed';
    if (!effectiveManualRecovery) {
      await releaseFunding({ models, funding, execution, reason: 'definitive_provider_failure', transaction });
    }
    await execution.update({
      status,
      completed_at: new Date(),
      lease_owner: null,
      lease_expires_at: null,
      error_code: text(error?.code, 128) || 'managed_execution_failed',
      error_message: effectiveManualRecovery
        ? 'El resultado externo es ambiguo; conserva la reserva y requiere reconciliación manual.'
        : 'Google rechazó la creación atómica; la reserva se ha liberado.',
    }, { transaction });
    if (structuralFenceValid) {
      await campaign.update({
        version: Number(campaign.version || 0) + 1,
        status: 'blocked',
        operational_blocker: effectiveManualRecovery
          ? 'Resultado Google ambiguo: no reintentar ni liberar fondos hasta reconciliar la marca durable.'
          : 'Google rechazó la creación; revisa el plan antes de volver a aprobar.',
      }, { transaction });
    }
    return execution;
  });
}

async function resetExecutionForRetry(claimed, error, dependencies = {}) {
  const models = modelsFor(dependencies);
  const [updated] = await models.ManagedCampaignProviderExecution.update({
    status: claimed.reclaimedExpiredLease ? 'executing' : 'queued',
    lease_owner: null,
    lease_expires_at: null,
    error_code: text(error?.code, 128) || 'managed_provider_retryable',
    error_message: 'Google Ads ha aplazado temporalmente la operación; se reintentará en el mismo JobRequest.',
  }, {
    where: {
      id: claimed.execution.id,
      status: 'executing',
      lease_owner: claimed.leaseOwner,
      lease_version: claimed.leaseVersion,
    },
  });
  if (!updated) {
    throw new ManagedCampaignProviderExecutionError('managed_execution_lease_lost', 'No se pudo devolver la ejecución a cola.', 409);
  }
}

async function runExecutionJob(payload = {}, jobRequest = null, dependencies = {}) {
  const executionId = text(payload.execution_id, 36);
  const jobId = positiveInteger(jobRequest?.id);
  if (!executionId || !jobId) throw new Error('managed campaign execution job requires execution_id and JobRequest id');
  const claimed = await claimExecution({ executionId, jobId, phase: 'execute', dependencies });
  if (claimed.terminal) {
    return { status: 'completed', result: { execution_id: executionId, terminal: true, execution_status: claimed.execution.status } };
  }
  if (claimed.contended) {
    return {
      status: 'waiting',
      pauseUntil: claimed.retryAt,
      error: sanitizedWorkerError(null, 'managed_execution_lease_contended', 'Otra instancia conserva el lease de creación.'),
      result: { execution_id: executionId, provider_call_performed: false, lease_contended: true },
    };
  }
  const plan = safeObject(plain(claimed.execution).plan_snapshot);
  const adapter = (dependencies.getAdapter || getManagedCampaignExecutionAdapter)(
    claimed.execution.provider,
    claimed.execution.family,
    claimed.execution.operation,
  );
  if (!adapter) {
    const error = new ManagedCampaignProviderExecutionError('managed_execution_adapter_missing', 'El adaptador desapareció antes del job.', 409);
    await finalizeExecution({
      claimed,
      error,
      manualRecoveryRequired: claimed.reclaimedExpiredLease,
      dependencies,
    });
    return { status: 'failed', retryable: false, error, result: { execution_id: executionId } };
  }
  if (adapter.ADAPTER_VERSION !== plan?.execution?.execution_adapter_version
    || plan?.execution?.safety?.initial_campaign_status !== 'PAUSED'
    || plan?.execution?.safety?.targeting_materialized !== true
    || plan?.execution?.safety?.schedule_materialized !== true
    || plan?.execution?.safety?.customer_currency_and_time_zone_readback !== true) {
    const error = new ManagedCampaignProviderExecutionError(
      'managed_execution_adapter_contract_changed',
      'El adaptador o su contrato de seguridad cambió antes del job.',
      409
    );
    await finalizeExecution({
      claimed,
      error,
      manualRecoveryRequired: claimed.reclaimedExpiredLease,
      dependencies,
    });
    return { status: 'failed', retryable: false, error, result: { execution_id: executionId } };
  }
  try {
    await renewExecutionFence({ claimed, phase: 'execute', dependencies });
    const outcome = await adapter.execute(
      { execution: plain(claimed.execution), plan },
      {
        ...(dependencies.adapterDependencies || {}),
        requireMutationGuard: true,
        beforeMutation: providerMutationGuard({ claimed, phase: 'execute', dependencies }),
      }
    );
    const finalized = await finalizeExecution({ claimed, outcome, dependencies });
    if (finalized.status !== 'succeeded') {
      const fenceError = new ManagedCampaignProviderExecutionError(
        'managed_execution_post_mutation_fence_changed',
        'Google quedó PAUSED, pero la finalización local requiere reconciliación manual.',
        409
      );
      return {
        status: 'failed',
        retryable: false,
        error: fenceError,
        result: { execution_id: executionId, manual_recovery_required: true, provider_status: 'PAUSED' },
      };
    }
    return {
      status: 'completed',
      result: {
        execution_id: executionId,
        execution_status: 'succeeded',
        recovered_after_ambiguous_response: outcome.recovered === true,
        campaign_status: 'PAUSED',
        activation_supported: true,
        activation_requires_separate_job: true,
      },
    };
  } catch (error) {
    if (retryableProviderError(error)) {
      if (!jobHasRetryRemaining(jobRequest)) {
        const exhaustedError = new ManagedCampaignProviderExecutionError(
          'managed_google_provider_retry_exhausted',
          'Google Ads agotó los reintentos seguros antes de mutar recursos.',
          503
        );
        exhaustedError.manualRecoveryRequired = claimed.reclaimedExpiredLease;
        await finalizeExecution({
          claimed,
          error: exhaustedError,
          manualRecoveryRequired: claimed.reclaimedExpiredLease,
          dependencies,
        });
        return {
          status: 'failed',
          retryable: false,
          error: exhaustedError,
          result: { execution_id: executionId, retryable: false, attempts_exhausted: true },
        };
      }
      await resetExecutionForRetry(claimed, error, dependencies);
      const safeError = sanitizedWorkerError(
        error,
        'managed_google_provider_temporarily_unavailable',
        'Google Ads ha aplazado temporalmente la operación.'
      );
      return {
        status: 'waiting',
        pauseUntil: error?.cause?.retryAt || null,
        backoffMs: 15 * 60 * 1000,
        error: safeError,
        result: { execution_id: executionId, retryable: true },
      };
    }
    await finalizeExecution({
      claimed,
      error,
      manualRecoveryRequired: error?.manualRecoveryRequired === true || claimed.reclaimedExpiredLease,
      dependencies,
    });
    const safeError = sanitizedWorkerError(
      error,
      'managed_execution_failed',
      error?.manualRecoveryRequired === true
        ? 'El resultado externo es ambiguo y requiere reconciliación manual.'
        : 'Google Ads rechazó la creación atómica.'
    );
    return {
      status: 'failed',
      retryable: false,
      error: safeError,
      result: {
        execution_id: executionId,
        manual_recovery_required: error?.manualRecoveryRequired === true || claimed.reclaimedExpiredLease,
      },
    };
  }
}

async function enqueueActivation(input, dependencies = {}) {
  assertActivationFeatureEnabled(dependencies);
  const models = modelsFor(dependencies);
  const sequelize = dependencies.sequelize || models.sequelize;
  const campaignId = text(input?.campaignId, 36);
  const executionId = text(input?.executionId, 36);
  const actorUserId = positiveInteger(input?.actorUserId);
  const idempotencyKey = text(input?.idempotencyKey, 191);
  const changeReference = text(input?.changeReference, 191);
  const expectedPlanHash = text(input?.expectedPlanHash, 64);
  if (!campaignId || !executionId || !actorUserId || !idempotencyKey || !changeReference
    || !expectedPlanHash || !/^[a-f0-9]{64}$/i.test(expectedPlanHash)) {
    throw new ManagedCampaignProviderExecutionError(
      'managed_activation_request_invalid',
      'Activación requiere campaña, ejecución, operador, Idempotency-Key y referencia de cambio.',
      400
    );
  }
  const missingConfirmations = REQUIRED_ACTIVATION_CONFIRMATIONS.filter((key) => input?.confirmation?.[key] !== true);
  if (missingConfirmations.length) {
    throw new ManagedCampaignProviderExecutionError(
      'managed_activation_confirmations_required',
      'Faltan confirmaciones explícitas para activar la campaña.',
      409,
      { missing_confirmations: missingConfirmations }
    );
  }

  return sequelize.transaction(async (transaction) => {
    const execution = await models.ManagedCampaignProviderExecution.findOne({
      where: { id: executionId, managed_campaign_id: campaignId },
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!execution) throw new ManagedCampaignProviderExecutionError('managed_execution_not_found', 'La ejecución no existe.', 404);
    if (execution.plan_hash !== expectedPlanHash) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_activation_plan_changed',
        'La activación no corresponde con el hash del plan creado.',
        409
      );
    }
    const idempotentReplay = execution.activation_idempotency_key === idempotencyKey;
    if (execution.activation_idempotency_key) {
      if (execution.activation_idempotency_key !== idempotencyKey) {
        throw new ManagedCampaignProviderExecutionError(
          'managed_activation_idempotency_conflict',
          'Esta ejecución ya tiene otra activación durable.',
          409
        );
      }
    }
    if ([execution.idempotency_key, execution.rollback_idempotency_key].filter(Boolean).includes(idempotencyKey)) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_activation_idempotency_key_reused',
        'La activación requiere un Idempotency-Key nuevo.',
        409
      );
    }
    if (!idempotentReplay && execution.status !== 'succeeded') {
      throw new ManagedCampaignProviderExecutionError(
        'managed_activation_state_forbidden',
        'Solo una creación succeeded y todavía PAUSED puede solicitar activación.',
        409,
        { execution_status: execution.status }
      );
    }
    const campaign = await models.ManagedCampaign.findByPk(campaignId, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const funding = await models.ManagedCampaignFundingAccount.findByPk(execution.funding_account_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!campaign || !funding) {
      throw new ManagedCampaignProviderExecutionError('managed_activation_graph_missing', 'Falta campaña o cuenta de prepago.', 409);
    }
    const plan = safeObject(plain(execution).plan_snapshot);
    await assertCurrentProviderAccountAuthorization({
      campaign,
      plan,
      transaction,
      dependencies,
    });
    if (idempotentReplay) {
      return {
        created: false,
        execution,
        job: execution.activation_job_request_id ? { id: execution.activation_job_request_id } : null,
      };
    }
    const adapter = (dependencies.getAdapter || getManagedCampaignExecutionAdapter)(
      execution.provider,
      execution.family,
      execution.operation,
    );
    const refs = safeObject(execution.provider_refs);
    const ownership = safeObject(execution.ownership_snapshot);
    const customerContract = safeObject(ownership.customer_contract);
    const planSchedule = safeObject(plan?.specification?.schedule);
    const platformRefs = safeObject(campaign.platform_refs);
    if (!adapter?.activate
      || adapter.ADAPTER_VERSION !== plan?.execution?.execution_adapter_version
      || plan?.execution?.safety?.activation_supported !== true
      || plan?.execution?.safety?.targeting_materialized !== true
      || plan?.execution?.safety?.schedule_materialized !== true
      || plan?.execution?.safety?.customer_currency_and_time_zone_readback !== true
      || plan?.execution?.safety?.optimization_goal_required !== 'qualified_lead'
      || plan?.execution?.safety?.optimization_goal_verified_before_activation !== true
      || plan?.readiness?.ready !== true
      || plan?.plan_hash !== execution.plan_hash
      || campaign.status !== 'launching'
      || Number(campaign.version) !== Number(execution.campaign_version)
      || platformRefs.managed_execution_id !== execution.id
      || !refs.campaign || !ownership.marker
      || text(customerContract.currency_code, 3)?.toUpperCase() !== text(execution.currency, 3)?.toUpperCase()
      || text(customerContract.time_zone, 128) !== text(planSchedule.time_zone, 128)
      || !campaign.approved_at || !positiveInteger(campaign.approved_by_user_id)
      || money(funding.reserved_amount) !== money(execution.reservation_amount)
      || funding.currency !== execution.currency) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_activation_preconditions_failed',
        'La campaña ya no conserva plan, propiedad, aprobación y saldo reservado aptos para activar.',
        409
      );
    }
    const verifiedTopups = await models.ManagedCampaignLedgerEntry.findAll({
      where: { funding_account_id: funding.id, entry_type: 'topup' },
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!verifiedTopups.some((entry) => safeObject(plain(entry).metadata).payment_verified === true)) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_activation_prepayment_not_verified',
        'El prepago dejó de conservar una verificación bancaria auditable.',
        409
      );
    }
    const requestedAt = new Date();
    const job = await (dependencies.enqueueJobRequest || jobRequestsService.enqueueJobRequest)({
      type: ACTIVATE_JOB_TYPE,
      priority: 'critical',
      origin: 'managed_campaign_operator',
      requestedBy: actorUserId,
      maxAttempts: 5,
      payload: { execution_id: executionId, managed_campaign_id: campaignId, plan_hash: execution.plan_hash },
    }, { transaction, JobRequestModel: models.JobRequest });
    const activationQueuedCampaignVersion = Number(campaign.version || 0) + 1;
    await execution.update({
      status: 'activation_queued',
      campaign_version: activationQueuedCampaignVersion,
      activation_idempotency_key: idempotencyKey,
      activation_job_request_id: job.id,
      activation_requested_by_user_id: actorUserId,
      activation_requested_at: requestedAt,
      activation_change_reference: changeReference,
      activation_authorization_snapshot: {
        schema_version: 'managed-campaign-provider-activation-authorization/v1',
        approved_at: requestedAt.toISOString(),
        approved_by_user_id: actorUserId,
        change_reference: changeReference,
        plan_hash: execution.plan_hash,
        confirmations: Object.fromEntries(REQUIRED_ACTIVATION_CONFIRMATIONS.map((key) => [key, true])),
      },
      activation_snapshot: null,
      error_code: null,
      error_message: null,
    }, { transaction });
    await campaign.update({
      version: activationQueuedCampaignVersion,
      operational_blocker: 'Activación PAUSED → ENABLED encolada. La campaña no se considera activa hasta completar el readback exacto.',
    }, { transaction });
    await appendExecutionAudit({
      models,
      campaign,
      execution,
      eventType: 'provider_activation_queued',
      actorUserId,
      changes: {
        execution_id: execution.id,
        job_request_id: job.id,
        plan_hash: execution.plan_hash,
        provider_transition: 'PAUSED_TO_ENABLED',
        change_reference: changeReference,
      },
      transaction,
    });
    return { created: true, execution, job };
  });
}

function validatedGoalPolicySnapshot(value, { execution, plan }) {
  const snapshot = safeObject(value);
  const campaignId = text(safeObject(execution.provider_refs).campaign, 512)?.split('/').pop() || null;
  const customerId = text(safeObject(execution.provider_refs).customer_id, 32)?.replace(/\D/g, '') || null;
  const campaignIds = Array.isArray(snapshot.campaign_ids)
    ? snapshot.campaign_ids.map((item) => text(item, 32)).filter(Boolean)
    : [];
  if (snapshot.stage !== 'qualified_lead'
    || snapshot.verification_healthy !== true
    || !['applied', 'unchanged'].includes(snapshot.outcome)
    || snapshot.plan_hash !== execution.plan_hash
    || snapshot.customer_id !== customerId
    || campaignIds.length !== 1
    || campaignIds[0] !== campaignId
    || !/^[a-f0-9]{64}$/i.test(String(snapshot.preview_digest || ''))
    || plan?.execution?.safety?.optimization_goal_required !== 'qualified_lead') {
    throw new ManagedCampaignProviderExecutionError(
      'managed_activation_goal_policy_unhealthy',
      'La policy canónica Qualified Lead no quedó aplicada y verificada para esta campaña.',
      409
    );
  }
  return {
    schema_version: 'managed-campaign-activation-goal-policy/v1',
    policy_id: positiveInteger(snapshot.policy_id),
    stage: 'qualified_lead',
    customer_id: customerId,
    campaign_ids: campaignIds,
    preview_digest: snapshot.preview_digest,
    outcome: snapshot.outcome,
    verification_healthy: true,
    plan_hash: execution.plan_hash,
    verified_at: snapshot.verified_at || new Date().toISOString(),
  };
}

async function runDefaultManagedGoalPolicy({ claimed, dependencies }) {
  const models = modelsFor(dependencies);
  const sequelize = dependencies.sequelize || models.sequelize;
  const api = dependencies.optimizationPolicy || managedCampaignOptimizationPolicy;
  let leaseToken = null;
  let stagedCampaign = null;
  let provisioning = null;
  let goalPolicyMutationStarted = false;
  try {
    await sequelize.transaction(async (transaction) => {
      const execution = await models.ManagedCampaignProviderExecution.findByPk(claimed.execution.id, {
        transaction,
        ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
      });
      const campaign = await models.ManagedCampaign.findByPk(claimed.execution.managed_campaign_id, {
        transaction,
        ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
      });
      if (!execution || execution.status !== 'activating' || execution.lease_owner !== claimed.leaseOwner
        || Number(execution.lease_version || 0) !== Number(claimed.leaseVersion || 0)
        || !campaign || campaign.status !== 'launching') {
        throw new ManagedCampaignProviderExecutionError(
          'managed_activation_goal_policy_state_changed',
          'El estado local cambió antes de preparar el objetivo Qualified Lead.',
          409
        );
      }
      await assertCurrentProviderAccountAuthorization({
        campaign,
        plan: safeObject(plain(execution).plan_snapshot),
        transaction,
        dependencies,
      });
      stagedCampaign = { ...plain(campaign), status: 'launching' };
      provisioning = await api.provisionManagedCampaignOptimization({
        campaign: stagedCampaign,
        targetStatus: 'launching',
        transaction,
        dependencies: dependencies.optimizationPolicyDependencies || {},
      });
      if (provisioning?.skipped || !provisioning?.provisioned
        || provisioning?.plan?.stage !== 'qualified_lead') {
        throw new ManagedCampaignProviderExecutionError(
          'managed_activation_goal_policy_not_provisioned',
          'Piloto requiere una policy gestionada Qualified Lead antes de activar Google.',
          409
        );
      }
      const acquired = await api.acquireManagedCampaignOptimizationLease({
        managedCampaignId: campaign.id,
        actorUserId: execution.activation_requested_by_user_id,
        purpose: `provider_activation:${execution.id}`,
        transaction,
        dependencies: dependencies.optimizationPolicyDependencies || {},
      });
      leaseToken = acquired.token;
    });

    await renewExecutionFence({ claimed, phase: 'activate', dependencies });
    const applied = await api.executeManagedCampaignGoalPolicy({
      campaign: stagedCampaign,
      provisioning,
      targetStatus: 'launching',
      actorUserId: claimed.execution.activation_requested_by_user_id,
      dependencies: {
        ...(dependencies.optimizationExecutionDependencies || {}),
        beforeExternalMutation: async (...args) => {
          await providerMutationGuard({ claimed, phase: 'activate', dependencies })(...args);
          goalPolicyMutationStarted = true;
        },
      },
    });
    if (!['applied', 'unchanged'].includes(applied?.result?.outcome)
      || applied?.result?.verification?.healthy !== true) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_activation_goal_policy_readback_failed',
        'Google no confirmó por readback el objetivo Qualified Lead.',
        409
      );
    }
    await renewExecutionFence({ claimed, phase: 'activate', dependencies });
    await sequelize.transaction(async (transaction) => {
      await api.activateManagedCampaignOptimizationPolicy({
        managedCampaignId: claimed.execution.managed_campaign_id,
        leaseToken,
        transaction,
        dependencies: dependencies.optimizationPolicyDependencies || {},
      });
    });
    leaseToken = null;
    return {
      policy_id: positiveInteger(plain(provisioning.policy)?.id),
      stage: provisioning.plan.stage,
      customer_id: provisioning.plan.customer_id,
      campaign_ids: provisioning.plan.campaign_ids,
      preview_digest: applied.digest,
      outcome: applied.result.outcome,
      verification_healthy: applied.result.verification.healthy === true,
      plan_hash: claimed.execution.plan_hash,
      verified_at: new Date().toISOString(),
    };
  } catch (error) {
    if (goalPolicyMutationStarted) {
      error.manualRecoveryRequired = true;
      error.activationPhase = error.activationPhase || 'goal_policy_post_mutation_ambiguous';
    }
    if (leaseToken) {
      try {
        await api.releaseManagedCampaignOptimizationLease({
          managedCampaignId: claimed.execution.managed_campaign_id,
          leaseToken,
          dependencies: dependencies.optimizationPolicyDependencies || {},
        });
      } catch (_) {
        // The goal executor has not enabled the campaign. A stale local lease
        // is safer than concealing the original failure and expires by TTL.
      }
    }
    throw error;
  }
}

async function ensureManagedGoalPolicyForActivation({ claimed, dependencies = {} }) {
  const plan = safeObject(plain(claimed.execution).plan_snapshot);
  const rawSnapshot = typeof dependencies.ensureManagedGoalPolicy === 'function'
    ? await dependencies.ensureManagedGoalPolicy({
        execution: plain(claimed.execution),
        campaign: plain(claimed.campaign),
        plan,
      })
    : await runDefaultManagedGoalPolicy({ claimed, dependencies });
  const snapshot = validatedGoalPolicySnapshot(rawSnapshot, {
    execution: plain(claimed.execution),
    plan,
  });
  const models = modelsFor(dependencies);
  const sequelize = dependencies.sequelize || models.sequelize;
  await sequelize.transaction(async (transaction) => {
    const execution = await models.ManagedCampaignProviderExecution.findByPk(claimed.execution.id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const campaign = await models.ManagedCampaign.findByPk(claimed.execution.managed_campaign_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!execution || execution.status !== 'activating' || execution.lease_owner !== claimed.leaseOwner
      || Number(execution.lease_version || 0) !== Number(claimed.leaseVersion || 0)
      || !campaign || campaign.status !== 'launching'
      || Number(campaign.version) !== Number(claimed.campaignFenceVersion)
      || safeObject(campaign.platform_refs).managed_execution_id !== execution.id) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_activation_goal_policy_state_changed',
        'El estado local cambió después del readback del objetivo.',
        409
      );
    }
    await execution.update({ goal_policy_snapshot: snapshot }, { transaction });
    await appendExecutionAudit({
      models,
      campaign,
      execution,
      eventType: 'provider_activation_goal_policy_verified',
      actorUserId: execution.activation_requested_by_user_id,
      changes: {
        execution_id: execution.id,
        stage: 'qualified_lead',
        customer_id: snapshot.customer_id,
        campaign_ids: snapshot.campaign_ids,
        preview_digest: snapshot.preview_digest,
        outcome: snapshot.outcome,
        verification_healthy: true,
      },
      transaction,
    });
  });
  return snapshot;
}

async function recordGoalPolicyFailure({ claimed, error, dependencies = {} }) {
  const models = modelsFor(dependencies);
  const sequelize = dependencies.sequelize || models.sequelize;
  return sequelize.transaction(async (transaction) => {
    const execution = await models.ManagedCampaignProviderExecution.findByPk(claimed.execution.id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const campaign = await models.ManagedCampaign.findByPk(claimed.execution.managed_campaign_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!execution || execution.status !== 'activating' || execution.lease_owner !== claimed.leaseOwner
      || Number(execution.lease_version || 0) !== Number(claimed.leaseVersion || 0) || !campaign) return false;
    const snapshot = {
      schema_version: 'managed-campaign-activation-goal-policy/v1',
      stage: 'qualified_lead',
      verification_healthy: false,
      outcome: 'failed',
      plan_hash: execution.plan_hash,
      error_code: providerErrorCode(error, 'managed_activation_goal_policy_failed'),
      checked_at: new Date().toISOString(),
    };
    await execution.update({ goal_policy_snapshot: snapshot }, { transaction });
    await appendExecutionAudit({
      models,
      campaign,
      execution,
      eventType: 'provider_activation_goal_policy_failed',
      actorUserId: execution.activation_requested_by_user_id,
      changes: {
        execution_id: execution.id,
        stage: 'qualified_lead',
        verification_healthy: false,
        campaign_enable_mutation_performed: false,
        error_code: snapshot.error_code,
      },
      transaction,
    });
    return true;
  });
}

async function finalizeActivation({ claimed, outcome, error, manualRecoveryRequired, dependencies }) {
  const models = modelsFor(dependencies);
  const sequelize = dependencies.sequelize || models.sequelize;
  return sequelize.transaction(async (transaction) => {
    const execution = await models.ManagedCampaignProviderExecution.findByPk(claimed.execution.id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!execution || execution.status !== 'activating'
      || execution.lease_owner !== claimed.leaseOwner
      || Number(execution.lease_version || 0) !== Number(claimed.leaseVersion || 0)) {
      throw new ManagedCampaignProviderExecutionError('managed_execution_lease_lost', 'El worker perdió el lease de activación.', 409);
    }
    const campaign = await models.ManagedCampaign.findByPk(execution.managed_campaign_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const funding = await models.ManagedCampaignFundingAccount.findByPk(execution.funding_account_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const refs = safeObject(campaign?.platform_refs);
    const ownedCampaignId = text(safeObject(execution.provider_refs).campaign, 512)?.split('/').pop() || null;
    const structuralFenceValid = Boolean(campaign && funding)
      && campaign.status === 'launching'
      && Number(campaign.version) === Number(claimed.campaignFenceVersion)
      && Number(campaign.version) === Number(execution.campaign_version)
      && refs.managed_execution_id === execution.id
      && String(refs.campaign_id || '') === String(ownedCampaignId || '')
      && funding.currency === execution.currency
      && money(funding.reserved_amount) === money(execution.reservation_amount);
    let accountAuthorized = false;
    try {
      await assertCurrentProviderAccountAuthorization({
        campaign,
        plan: safeObject(plain(execution).plan_snapshot),
        transaction,
        dependencies,
      });
      accountAuthorized = true;
    } catch (authorizationError) {
      if (authorizationError?.code !== 'managed_execution_account_authorization_revoked') throw authorizationError;
    }
    if (outcome) {
      const activatedAt = new Date();
      if (!structuralFenceValid || !accountAuthorized) {
        await execution.update({
          status: 'manual_recovery_required',
          provider_refs: safeObject(outcome.provider_refs),
          ownership_snapshot: safeObject(outcome.ownership),
          activation_snapshot: {
            outcome: 'enabled_readback_verified_local_fence_changed',
            recovered_after_ambiguous_response: outcome.recovered === true,
            provider_enabled_readback_verified: true,
            previous_status: 'PAUSED',
            current_status: 'ENABLED',
            checked_at: activatedAt.toISOString(),
          },
          lease_owner: null,
          lease_expires_at: null,
          error_code: 'managed_activation_post_mutation_fence_changed',
          error_message: 'Google ENABLED quedó verificado, pero el estado o autorización local cambió; requiere reconciliación manual.',
        }, { transaction });
        await appendExecutionAudit({
          models,
          campaign,
          execution,
          eventType: 'provider_activation_local_fence_changed',
          actorUserId: execution.activation_requested_by_user_id,
          changes: {
            execution_id: execution.id,
            provider_transition: 'PAUSED_TO_ENABLED',
            provider_enabled_readback_verified: true,
            campaign_state_preserved: true,
            account_authorization_active: accountAuthorized,
          },
          transaction,
        });
        return execution;
      }
      const activeCampaignVersion = Number(campaign.version || 0) + 1;
      await execution.update({
        status: 'active',
        campaign_version: activeCampaignVersion,
        provider_refs: safeObject(outcome.provider_refs),
        ownership_snapshot: safeObject(outcome.ownership),
        activation_snapshot: {
          outcome: 'enabled_readback_verified',
          recovered_after_ambiguous_response: outcome.recovered === true,
          previous_status: 'PAUSED',
          current_status: 'ENABLED',
          verified_at: activatedAt.toISOString(),
        },
        activated_at: activatedAt,
        lease_owner: null,
        lease_expires_at: null,
        error_code: null,
        error_message: null,
      }, { transaction });
      await campaign.update({
        version: activeCampaignVersion,
        status: 'active',
        operational_blocker: null,
      }, { transaction });
      await appendExecutionAudit({
        models,
        campaign,
        execution,
        eventType: 'provider_activation_succeeded',
        actorUserId: execution.activation_requested_by_user_id,
        changes: {
          execution_id: execution.id,
          provider_transition: 'PAUSED_TO_ENABLED',
          readback_verified: true,
          recovered_after_ambiguous_response: outcome.recovered === true,
        },
        transaction,
      });
      return execution;
    }
    const enabledReadbackVerifiedLocalFinalizeFailed = manualRecoveryRequired
      && error?.activationPhase === 'local_finalize_after_verified_enable';
    const status = manualRecoveryRequired ? 'manual_recovery_required' : 'activation_failed';
    await execution.update({
      status,
      activation_snapshot: {
        outcome: enabledReadbackVerifiedLocalFinalizeFailed
          ? 'enabled_readback_verified_local_finalize_failed'
          : manualRecoveryRequired
            ? 'ambiguous'
            : 'definitive_no_mutation',
        phase: error?.activationPhase || 'provider_enable',
        error_code: providerErrorCode(error, 'managed_activation_failed'),
        provider_enabled_readback_verified: enabledReadbackVerifiedLocalFinalizeFailed,
        checked_at: new Date().toISOString(),
      },
      lease_owner: null,
      lease_expires_at: null,
      error_code: providerErrorCode(error, 'managed_activation_failed'),
      error_message: enabledReadbackVerifiedLocalFinalizeFailed
        ? 'Google ENABLED quedó verificado, pero el estado local no pudo finalizarse; requiere reconciliación manual.'
        : manualRecoveryRequired
          ? 'El estado PAUSED/ENABLED es ambiguo; requiere reconciliación manual.'
        : error?.activationPhase === 'goal_policy'
          ? 'Qualified Lead no quedó verificado; la campaña sigue PAUSED y los recursos quedan reservados para rollback.'
          : 'La activación fue rechazada sin mutación; los recursos propios siguen reservados para rollback.',
    }, { transaction });
    if (structuralFenceValid) {
      await campaign.update({
        version: Number(campaign.version || 0) + 1,
        status: 'blocked',
        operational_blocker: enabledReadbackVerifiedLocalFinalizeFailed
          ? 'Google ENABLED quedó verificado, pero falló la finalización local. No reintentar la activación ni ejecutar rollback automático hasta reconciliar el estado.'
          : manualRecoveryRequired
            ? 'Activación Google ambigua: no reintentar ni ejecutar rollback automático hasta reconciliar el estado.'
            : error?.activationPhase === 'goal_policy'
              ? 'El objetivo Qualified Lead no superó el readback; Google permanece PAUSED. Ejecuta rollback o prepara un plan nuevo.'
              : 'Google rechazó la activación; ejecuta rollback de los recursos propios o prepara un plan nuevo.',
      }, { transaction });
    }
    await appendExecutionAudit({
      models,
      campaign,
      execution,
      eventType: enabledReadbackVerifiedLocalFinalizeFailed
        ? 'provider_activation_local_finalize_failed'
        : manualRecoveryRequired
          ? 'provider_activation_ambiguous'
          : 'provider_activation_failed',
      actorUserId: execution.activation_requested_by_user_id,
      changes: {
        execution_id: execution.id,
        provider_transition: 'PAUSED_TO_ENABLED',
        provider_mutation_ambiguous: manualRecoveryRequired === true
          && !enabledReadbackVerifiedLocalFinalizeFailed,
        provider_enabled_readback_verified: enabledReadbackVerifiedLocalFinalizeFailed,
        phase: error?.activationPhase || 'provider_enable',
        error_code: providerErrorCode(error, 'managed_activation_failed'),
      },
      transaction,
    });
    return execution;
  });
}

async function resetActivationForRetry(claimed, error, dependencies = {}) {
  const models = modelsFor(dependencies);
  const [updated] = await models.ManagedCampaignProviderExecution.update({
    status: claimed.reclaimedExpiredLease ? 'activating' : 'activation_queued',
    lease_owner: null,
    lease_expires_at: null,
    error_code: providerErrorCode(error, 'managed_activation_retryable'),
    error_message: 'Google Ads ha aplazado la activación antes de mutar; se reintentará con el mismo JobRequest.',
  }, {
    where: {
      id: claimed.execution.id,
      status: 'activating',
      lease_owner: claimed.leaseOwner,
      lease_version: claimed.leaseVersion,
    },
  });
  if (!updated) throw new ManagedCampaignProviderExecutionError('managed_execution_lease_lost', 'No se pudo devolver la activación a cola.', 409);
}

async function runActivationJob(payload = {}, jobRequest = null, dependencies = {}) {
  const executionId = text(payload.execution_id, 36);
  const jobId = positiveInteger(jobRequest?.id);
  if (!executionId || !jobId) throw new Error('managed activation job requires execution_id and JobRequest id');
  if (!activationFeatureEnabledFor(dependencies)) {
    return {
      status: 'waiting',
      backoffMs: 15 * 60 * 1000,
      error: sanitizedWorkerError(null, 'managed_campaign_provider_activation_disabled', 'La activación sigue desactivada.'),
      result: { execution_id: executionId, provider_call_performed: false },
    };
  }
  const claimed = await claimExecution({ executionId, jobId, phase: 'activate', dependencies });
  if (claimed.terminal) {
    const failed = ['activation_failed', 'manual_recovery_required'].includes(claimed.execution.status);
    return {
      status: failed ? 'failed' : 'completed',
      ...(failed ? { retryable: false } : {}),
      result: { execution_id: executionId, terminal: true, execution_status: claimed.execution.status },
    };
  }
  if (claimed.contended) {
    return {
      status: 'waiting',
      pauseUntil: claimed.retryAt,
      error: sanitizedWorkerError(null, 'managed_execution_lease_contended', 'Otra instancia conserva el lease de activación.'),
      result: { execution_id: executionId, provider_call_performed: false, lease_contended: true },
    };
  }
  const adapter = (dependencies.getAdapter || getManagedCampaignExecutionAdapter)(
    claimed.execution.provider,
    claimed.execution.family,
    claimed.execution.operation,
  );
  if (!adapter?.activate) {
    const error = new ManagedCampaignProviderExecutionError('managed_activation_adapter_missing', 'Falta el adaptador de activación.', 409);
    await finalizeActivation({
      claimed,
      error,
      manualRecoveryRequired: claimed.reclaimedExpiredLease,
      dependencies,
    });
    return { status: 'failed', retryable: false, error, result: { execution_id: executionId } };
  }
  let providerEnableReadbackVerified = false;
  let verifiedProviderOutcome = null;
  let takeoverProviderState = claimed.reclaimedExpiredLease ? 'unknown' : 'not_applicable';
  try {
    const plan = safeObject(plain(claimed.execution).plan_snapshot);
    if (adapter.ADAPTER_VERSION !== plan?.execution?.execution_adapter_version
      || plan?.execution?.safety?.optimization_goal_required !== 'qualified_lead'
      || plan?.execution?.safety?.optimization_goal_verified_before_activation !== true) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_activation_adapter_contract_changed',
        'El contrato de activación cambió antes del JobRequest.',
        409
      );
    }
    let outcome = null;
    if (claimed.reclaimedExpiredLease && typeof adapter.recoverActivation === 'function') {
      try {
        await renewExecutionFence({
          claimed,
          phase: 'activate',
          dependencies,
          allowStaleActivationApproval: true,
        });
        const recovery = await adapter.recoverActivation({
          execution: plain(claimed.execution),
          plan,
        }, dependencies.adapterDependencies || {});
        if (recovery?.current_status === 'ENABLED' && recovery?.recovered === true) {
          outcome = recovery;
          takeoverProviderState = 'ENABLED';
          providerEnableReadbackVerified = true;
          verifiedProviderOutcome = recovery;
        } else if (recovery?.current_status === 'PAUSED') {
          takeoverProviderState = 'PAUSED';
        } else {
          throw new ManagedCampaignProviderExecutionError(
            'managed_activation_recovery_state_unknown',
            'El readback de recuperación no demostró PAUSED ni ENABLED.',
            409
          );
        }
      } catch (error) {
        error.activationPhase = 'provider_recovery';
        throw error;
      }
    }
    if (!outcome) {
      try {
        await renewExecutionFence({ claimed, phase: 'activate', dependencies });
        await ensureManagedGoalPolicyForActivation({ claimed, dependencies });
        try {
          await renewExecutionFence({ claimed, phase: 'activate', dependencies });
        } catch (fenceError) {
          fenceError.manualRecoveryRequired = true;
          fenceError.activationPhase = 'goal_policy_post_mutation_fence';
          throw fenceError;
        }
      } catch (error) {
        error.activationPhase = error.activationPhase || 'goal_policy';
        try {
          await recordGoalPolicyFailure({ claimed, error, dependencies });
        } catch (_) {
          // Finalization below still fails closed and keeps the media reserve.
        }
        throw error;
      }
      try {
        outcome = await adapter.activate({
          execution: plain(claimed.execution),
          plan,
        }, {
          ...(dependencies.adapterDependencies || {}),
          requireMutationGuard: true,
          beforeMutation: providerMutationGuard({ claimed, phase: 'activate', dependencies }),
        });
        providerEnableReadbackVerified = true;
        takeoverProviderState = 'ENABLED';
        verifiedProviderOutcome = outcome;
      } catch (error) {
        error.activationPhase = 'provider_enable';
        throw error;
      }
    }
    const finalized = await finalizeActivation({ claimed, outcome, dependencies });
    if (finalized.status !== 'active') {
      return {
        status: 'failed',
        retryable: false,
        error: sanitizedWorkerError(
          null,
          'managed_activation_post_mutation_fence_changed',
          'Google ENABLED quedó verificado, pero el estado local requiere reconciliación manual.'
        ),
        result: {
          execution_id: executionId,
          manual_recovery_required: true,
          provider_enabled_readback_verified: true,
        },
      };
    }
    return {
      status: 'completed',
      result: {
        execution_id: executionId,
        execution_status: 'active',
        campaign_status: 'ENABLED',
        recovered_after_ambiguous_response: outcome.recovered === true,
      },
    };
  } catch (error) {
    if (providerEnableReadbackVerified) {
      const models = modelsFor(dependencies);
      let persistedExecution = null;
      try {
        persistedExecution = await models.ManagedCampaignProviderExecution.findByPk(claimed.execution.id);
      } catch (_) {
        // The durable reconciliation write below remains the source of truth.
      }
      if (persistedExecution?.status === 'active') {
        return {
          status: 'completed',
          result: {
            execution_id: executionId,
            execution_status: 'active',
            campaign_status: 'ENABLED',
            recovered_after_ambiguous_response: verifiedProviderOutcome?.recovered === true,
            recovered_after_local_finalize_response_loss: true,
          },
        };
      }
      const terminalError = new ManagedCampaignProviderExecutionError(
        'managed_activation_local_finalize_failed',
        'Google ENABLED quedó verificado, pero el estado local no pudo finalizarse.',
        503,
        { original_error_code: providerErrorCode(error, 'managed_activation_local_finalize_failed') }
      );
      terminalError.activationPhase = 'local_finalize_after_verified_enable';
      terminalError.manualRecoveryRequired = true;
      await finalizeActivation({
        claimed,
        error: terminalError,
        manualRecoveryRequired: true,
        dependencies,
      });
      return {
        status: 'failed',
        retryable: false,
        error: sanitizedWorkerError(
          terminalError,
          'managed_activation_local_finalize_failed',
          'Google ENABLED quedó verificado, pero la finalización local requiere reconciliación manual.'
        ),
        result: {
          execution_id: executionId,
          manual_recovery_required: true,
          provider_enabled_readback_verified: true,
        },
      };
    }
    if (retryableProviderError(error) && jobHasRetryRemaining(jobRequest)) {
      await resetActivationForRetry(claimed, error, dependencies);
      return {
        status: 'waiting',
        pauseUntil: error?.cause?.retryAt || null,
        backoffMs: 15 * 60 * 1000,
        error: sanitizedWorkerError(error, 'managed_google_provider_temporarily_unavailable', 'Google Ads ha aplazado temporalmente la activación.'),
        result: { execution_id: executionId, retryable: true },
      };
    }
    const terminalError = retryableProviderError(error)
      ? new ManagedCampaignProviderExecutionError('managed_activation_retry_exhausted', 'La activación agotó sus reintentos seguros antes de mutar.', 503)
      : error;
    const takeoverOutcomeUnknown = claimed.reclaimedExpiredLease && takeoverProviderState === 'unknown';
    const manualRecoveryRequired = error?.manualRecoveryRequired === true || takeoverOutcomeUnknown;
    if (error?.activationPhase && !terminalError.activationPhase) {
      terminalError.activationPhase = error.activationPhase;
    }
    await finalizeActivation({
      claimed,
      error: terminalError,
      manualRecoveryRequired,
      dependencies,
    });
    return {
      status: 'failed',
      retryable: false,
      error: sanitizedWorkerError(
        terminalError,
        'managed_activation_failed',
        manualRecoveryRequired
          ? 'La activación es ambigua y requiere reconciliación manual.'
          : 'La activación terminó sin mutar Google.'
      ),
      result: { execution_id: executionId, manual_recovery_required: manualRecoveryRequired },
    };
  }
}

async function enqueueRollback(input, dependencies = {}) {
  assertFeatureEnabled(dependencies);
  const models = modelsFor(dependencies);
  const sequelize = dependencies.sequelize || models.sequelize;
  const campaignId = text(input?.campaignId, 36);
  const executionId = text(input?.executionId, 36);
  const actorUserId = positiveInteger(input?.actorUserId);
  const idempotencyKey = text(input?.idempotencyKey, 191);
  if (!campaignId || !executionId || !actorUserId || !idempotencyKey || input?.confirmRollback !== true) {
    throw new ManagedCampaignProviderExecutionError(
      'managed_execution_rollback_confirmation_required',
      'Rollback requiere campaña, ejecución, operador, idempotencia y confirm_rollback=true.',
      400
    );
  }
  return sequelize.transaction(async (transaction) => {
    const execution = await models.ManagedCampaignProviderExecution.findOne({
      where: { id: executionId, managed_campaign_id: campaignId },
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!execution) throw new ManagedCampaignProviderExecutionError('managed_execution_not_found', 'La ejecución no existe.', 404);
    const idempotentReplay = execution.rollback_idempotency_key === idempotencyKey;
    if (execution.rollback_idempotency_key) {
      if (execution.rollback_idempotency_key !== idempotencyKey) {
        throw new ManagedCampaignProviderExecutionError('managed_rollback_idempotency_conflict', 'Ya existe otro rollback.', 409);
      }
    }
    if ([execution.idempotency_key, execution.activation_idempotency_key].filter(Boolean).includes(idempotencyKey)) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_rollback_idempotency_key_reused',
        'El rollback requiere un Idempotency-Key nuevo y distinto de create/activate.',
        409
      );
    }
    if (!idempotentReplay && !['succeeded', 'active', 'activation_failed'].includes(execution.status)) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_rollback_state_forbidden',
        'Rollback automático solo admite una creación verificada, una campaña activa verificada o una activación definitivamente rechazada.',
        409
      );
    }
    if (!idempotentReplay
      && (!safeObject(execution.ownership_snapshot).marker || !safeObject(execution.provider_refs).campaign)) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_rollback_ownership_missing',
        'No existe prueba de propiedad suficiente para retirar recursos.',
        409
      );
    }
    const campaign = await models.ManagedCampaign.findByPk(campaignId, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!campaign) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_execution_campaign_not_found',
        'La campaña no existe.',
        404
      );
    }
    const funding = await models.ManagedCampaignFundingAccount.findByPk(execution.funding_account_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!funding) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_execution_funding_not_found',
        'La cuenta de prepago no existe.',
        409
      );
    }
    await assertCurrentProviderAccountAuthorization({
      campaign,
      plan: safeObject(plain(execution).plan_snapshot),
      transaction,
      dependencies,
    });
    if (idempotentReplay) {
      return {
        created: false,
        execution,
        job: execution.rollback_job_request_id ? { id: execution.rollback_job_request_id } : null,
      };
    }
    const expectedCampaignStatus = execution.status === 'active'
      ? 'active'
      : execution.status === 'succeeded'
        ? 'launching'
        : 'blocked';
    if (campaign.status !== expectedCampaignStatus
      || !campaignOwnsExecution(campaign, execution, { requireCampaignId: true })
      || funding.currency !== execution.currency
      || money(funding.reserved_amount) !== money(execution.reservation_amount)) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_rollback_preconditions_changed',
        'Rollback requiere el mismo estado, referencias propias y reserva que el operador está autorizando.',
        409
      );
    }
    const authorizationSnapshot = rollbackAuthorizationSnapshot({
      campaign,
      funding,
      execution,
      actorUserId,
    });
    const job = await (dependencies.enqueueJobRequest || jobRequestsService.enqueueJobRequest)({
      type: ROLLBACK_JOB_TYPE,
      priority: 'critical',
      origin: 'managed_campaign_operator',
      requestedBy: actorUserId,
      maxAttempts: 3,
      payload: { execution_id: executionId, managed_campaign_id: campaignId },
    }, { transaction, JobRequestModel: models.JobRequest });
    await execution.update({
      status: 'rollback_queued',
      rollback_idempotency_key: idempotencyKey,
      rollback_job_request_id: job.id,
      rollback_requested_by_user_id: actorUserId,
      rollback_snapshot: authorizationSnapshot,
      error_code: null,
      error_message: null,
    }, { transaction });
    await appendExecutionAudit({
      models,
      campaign,
      execution,
      eventType: 'provider_rollback_queued',
      actorUserId,
      changes: { execution_id: execution.id, job_request_id: job.id, owned_resources_only: true },
      transaction,
    });
    return { created: true, execution, job };
  });
}

async function finalizeRollback({ claimed, outcome, error, dependencies = {} }) {
  const models = modelsFor(dependencies);
  const sequelize = dependencies.sequelize || models.sequelize;
  return sequelize.transaction(async (transaction) => {
    const execution = await models.ManagedCampaignProviderExecution.findByPk(claimed.execution.id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!execution || execution.status !== 'rolling_back'
      || execution.lease_owner !== claimed.leaseOwner
      || Number(execution.lease_version || 0) !== Number(claimed.leaseVersion || 0)) {
      throw new ManagedCampaignProviderExecutionError(
        'managed_execution_lease_lost',
        'El rollback perdió su fencing durable y no puede escribir el resultado.',
        409
      );
    }
    const funding = await models.ManagedCampaignFundingAccount.findByPk(execution.funding_account_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const campaign = await models.ManagedCampaign.findByPk(execution.managed_campaign_id, {
      transaction,
      ...(transaction?.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    const currentPlatformRefs = safeObject(campaign?.platform_refs);
    const ownedCampaignId = text(safeObject(execution.provider_refs).campaign, 512)?.split('/').pop() || null;
    const localFenceValid = Boolean(campaign && funding)
      && Number(campaign.version) === Number(claimed.campaignFenceVersion)
      && currentPlatformRefs.managed_execution_id === execution.id
      && String(currentPlatformRefs.campaign_id || '') === String(ownedCampaignId || '')
      && funding.currency === execution.currency
      && money(funding.reserved_amount) === money(execution.reservation_amount)
      && rollbackAuthorizationIsCurrent({ campaign, funding, execution });

    if (outcome && !localFenceValid) {
      await execution.update({
        status: 'manual_recovery_required',
        rollback_snapshot: {
          ...safeObject(outcome),
          local_fence_changed_after_removal: true,
        },
        completed_at: new Date(),
        lease_owner: null,
        lease_expires_at: null,
        error_code: 'managed_rollback_post_mutation_fence_changed',
        error_message: 'Google retiró los recursos, pero el estado local cambió; conserva fondos y referencias para reconciliación manual.',
      }, { transaction });
      await appendExecutionAudit({
        models,
        campaign,
        execution,
        eventType: 'provider_rollback_local_fence_changed',
        actorUserId: execution.rollback_requested_by_user_id,
        changes: {
          execution_id: execution.id,
          removal_verified: outcome.removal_verified === true || outcome.already_absent === true,
          campaign_state_preserved: true,
          funding_state_preserved: true,
        },
        transaction,
      });
      return execution;
    }

    if (outcome) {
      await releaseFunding({
        models,
        funding,
        execution,
        actorUserId: execution.rollback_requested_by_user_id,
        reason: 'owned_google_resources_rolled_back',
        transaction,
      });
      const rolledBackCampaignVersion = Number(campaign.version || 0) + 1;
      await execution.update({
        status: 'rolled_back',
        campaign_version: rolledBackCampaignVersion,
        rollback_snapshot: outcome,
        rolled_back_at: new Date(),
        completed_at: new Date(),
        lease_owner: null,
        lease_expires_at: null,
        error_code: null,
        error_message: null,
      }, { transaction });
      const nextPlatformRefs = Object.fromEntries(Object.entries(currentPlatformRefs).filter(([key]) => (
        !['campaign_id', 'managed_execution_id'].includes(key)
      )));
      await campaign.update({
        version: rolledBackCampaignVersion,
        status: 'blocked',
        platform_refs: {
          ...nextPlatformRefs,
          last_rolled_back_managed_execution_id: execution.id,
        },
        operational_blocker: 'La campaña creada por Piloto se retiró mediante rollback verificado; requiere un plan nuevo.',
      }, { transaction });
      await appendExecutionAudit({
        models,
        campaign,
        execution,
        eventType: 'provider_rollback_succeeded',
        actorUserId: execution.rollback_requested_by_user_id,
        changes: {
          execution_id: execution.id,
          owned_resources_only: true,
          removal_verified: outcome.removal_verified === true || outcome.already_absent === true,
        },
        transaction,
      });
      return execution;
    }

    await execution.update({
      status: 'manual_recovery_required',
      completed_at: new Date(),
      lease_owner: null,
      lease_expires_at: null,
      error_code: text(error?.code, 128) || 'managed_rollback_failed',
      error_message: 'El rollback no pudo demostrar una retirada segura; requiere reconciliación manual.',
    }, { transaction });
    await appendExecutionAudit({
      models,
      campaign,
      execution,
      eventType: 'provider_rollback_failed',
      actorUserId: execution.rollback_requested_by_user_id,
      changes: {
        execution_id: execution.id,
        provider_mutation_ambiguous: error?.manualRecoveryRequired === true,
        campaign_state_preserved: true,
        funding_state_preserved: true,
        error_code: providerErrorCode(error, 'managed_rollback_failed'),
      },
      transaction,
    });
    return execution;
  });
}

async function runRollbackJob(payload = {}, jobRequest = null, dependencies = {}) {
  const executionId = text(payload.execution_id, 36);
  const jobId = positiveInteger(jobRequest?.id);
  if (!executionId || !jobId) throw new Error('managed rollback job requires execution_id and JobRequest id');
  const claimed = await claimExecution({ executionId, jobId, phase: 'rollback', dependencies });
  if (claimed.terminal) {
    return { status: 'completed', result: { execution_id: executionId, terminal: true, execution_status: claimed.execution.status } };
  }
  if (claimed.contended) {
    return {
      status: 'waiting',
      pauseUntil: claimed.retryAt,
      error: sanitizedWorkerError(null, 'managed_execution_lease_contended', 'Otra instancia conserva el lease de rollback.'),
      result: { execution_id: executionId, provider_call_performed: false, lease_contended: true },
    };
  }
  try {
    const adapter = (dependencies.getAdapter || getManagedCampaignExecutionAdapter)(
      claimed.execution.provider,
      claimed.execution.family,
      claimed.execution.operation,
    );
    if (!adapter?.rollback) {
      throw new ManagedCampaignProviderExecutionError('managed_execution_adapter_missing', 'Falta el adaptador de rollback.', 409);
    }
    await renewExecutionFence({ claimed, phase: 'rollback', dependencies });
    const outcome = await adapter.rollback({
      execution: plain(claimed.execution),
      plan: safeObject(plain(claimed.execution).plan_snapshot),
    }, {
      ...(dependencies.adapterDependencies || {}),
      requireMutationGuard: true,
      beforeMutation: providerMutationGuard({ claimed, phase: 'rollback', dependencies }),
    });
    const finalized = await finalizeRollback({ claimed, outcome, dependencies });
    if (finalized.status !== 'rolled_back') {
      return {
        status: 'failed',
        retryable: false,
        error: sanitizedWorkerError(
          null,
          'managed_rollback_post_mutation_fence_changed',
          'Google retiró los recursos, pero el estado local requiere reconciliación manual.'
        ),
        result: { execution_id: executionId, manual_recovery_required: true, removal_verified: true },
      };
    }
    return { status: 'completed', result: { execution_id: executionId, execution_status: 'rolled_back' } };
  } catch (error) {
    try {
      await finalizeRollback({ claimed, error, dependencies });
    } catch (finalizeError) {
      if (finalizeError?.code !== 'managed_execution_lease_lost') throw finalizeError;
    }
    return {
      status: 'failed',
      retryable: false,
      error: sanitizedWorkerError(
        error,
        'managed_rollback_failed',
        'El rollback no pudo demostrar una retirada segura y requiere reconciliación manual.'
      ),
      result: { execution_id: executionId, manual_recovery_required: true },
    };
  }
}

async function listExecutions({ campaignId, limit = 25 }, dependencies = {}) {
  const models = modelsFor(dependencies);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  return models.ManagedCampaignProviderExecution.findAll({
    where: { managed_campaign_id: campaignId },
    order: [['created_at', 'DESC']],
    limit: safeLimit,
  });
}

module.exports = {
  EXECUTE_JOB_TYPE,
  ACTIVATE_JOB_TYPE,
  ROLLBACK_JOB_TYPE,
  REQUIRED_ACTIVATION_CONFIRMATIONS,
  ManagedCampaignProviderExecutionError,
  enqueueActivation,
  enqueueExecution,
  enqueueRollback,
  executionDto,
  explicitActivationEnabled,
  explicitEnabled,
  listExecutions,
  runActivationJob,
  runExecutionJob,
  runRollbackJob,
  _assertPlanMatchesLockedState: assertPlanMatchesLockedState,
  _releaseFunding: releaseFunding,
  _reserveFunding: reserveFunding,
};

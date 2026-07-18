'use strict';

const crypto = require('node:crypto');
const db = require('../../models');
const {
  APPROVAL_ROLES,
  MODES,
  STAGE_TRANSITIONS,
  applyApprovedLifecycleTransition,
} = require('./campaignOptimizationLifecycle.service');

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

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw transitionError('GUIDED_TRANSITION_DATE_INVALID', `${label} no es una fecha válida.`, 400);
  return date;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stable(value[key]);
    return result;
  }, {});
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function transitionError(code, message, httpStatus = 409, details = null) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  if (details) error.details = details;
  return error;
}

function policyLockOptions(transaction) {
  if (!transaction) return {};
  return {
    transaction,
    ...(transaction.LOCK?.UPDATE ? { lock: transaction.LOCK.UPDATE } : {}),
  };
}

function lifecycleDecision(evaluation) {
  return objectValue(objectValue(plain(evaluation)?.evidence).lifecycle_decision);
}

function evaluationDigestInput(evaluation) {
  const row = plain(evaluation) || {};
  return {
    policy_id: positiveInteger(row.policyId),
    policy_version: Number(row.policyVersion),
    evaluated_at: validDate(row.evaluatedAt, 'evaluated_at').toISOString(),
    metrics: objectValue(row.metrics),
    evidence: objectValue(row.evidence),
    blockers: Array.isArray(row.blockers) ? row.blockers : [],
    eligible_now: row.eligibleNow === true,
    ready_for_approval: row.readyForApproval === true,
  };
}

function computeEvaluationDigest(evaluation) {
  return digest(evaluationDigestInput(evaluation));
}

function verifyReadyGuidedEvaluation({ policy, evaluation, now = new Date() } = {}) {
  const policyRow = plain(policy) || {};
  const evaluationRow = plain(evaluation) || {};
  const instant = validDate(now, 'now');
  if (policyRow.mode !== MODES.GUIDED_IMPROVEMENT || policyRow.status !== 'active') {
    throw transitionError('GUIDED_ACTIVE_POLICY_REQUIRED', 'La política ya no está activa en modo Mejora.', 409);
  }
  if (positiveInteger(evaluationRow.policyId) !== positiveInteger(policyRow.id)) {
    throw transitionError('GUIDED_EVALUATION_POLICY_MISMATCH', 'La evaluación no pertenece a esta política.', 409);
  }
  if (
    evaluationRow.status !== 'ready'
    || evaluationRow.readyForApproval !== true
    || evaluationRow.eligibleNow !== true
    || (Array.isArray(evaluationRow.blockers) && evaluationRow.blockers.length)
  ) {
    throw transitionError('GUIDED_EVALUATION_NOT_READY', 'La evaluación diaria todavía no autoriza un cambio de objetivo.', 409);
  }
  const observedDigest = String(evaluationRow.decisionDigest || '').trim();
  const expectedDigest = computeEvaluationDigest(evaluationRow);
  if (!/^[a-f0-9]{64}$/.test(observedDigest) || observedDigest !== expectedDigest) {
    throw transitionError('GUIDED_EVALUATION_DIGEST_INVALID', 'La evidencia de la evaluación cambió después de persistirse.', 409);
  }
  const decision = lifecycleDecision(evaluationRow);
  const state = objectValue(policyRow.lifecycleState);
  const authorization = objectValue(state.authorization);
  const actorId = positiveInteger(authorization.accepted_by_user_id);
  const expectedCandidate = STAGE_TRANSITIONS[state.stage];
  if (
    !Object.keys(decision).length
    || decision.mode !== MODES.GUIDED_IMPROVEMENT
    || decision.from_stage !== state.stage
    || !expectedCandidate
    || decision.candidate_stage !== expectedCandidate
    || decision.evaluated_at !== validDate(evaluationRow.evaluatedAt, 'evaluated_at').toISOString()
    || decision.ready_for_approval !== true
    || decision.approval?.role !== APPROVAL_ROLES.CLIENT
    || decision.approval?.automatic_provider_mutation !== true
    || authorization.accepted !== true
    || Number(authorization.version) !== 1
    || !actorId
  ) {
    throw transitionError('GUIDED_LIFECYCLE_DECISION_INVALID', 'La decisión no coincide con la etapa y autorización vigentes.', 409);
  }
  if (Number(policyRow.version) < Number(evaluationRow.policyVersion) + 1) {
    throw transitionError('GUIDED_EVALUATION_POLICY_VERSION_INVALID', 'La evaluación no se ha consolidado todavía en la política.', 409);
  }
  const lastEvaluatedAt = policyRow.lastEvaluatedAt ? validDate(policyRow.lastEvaluatedAt, 'last_evaluated_at') : null;
  const evaluatedAt = validDate(evaluationRow.evaluatedAt, 'evaluated_at');
  if (!lastEvaluatedAt || lastEvaluatedAt.getTime() !== evaluatedAt.getTime()) {
    throw transitionError('GUIDED_EVALUATION_SUPERSEDED', 'Existe una evaluación posterior; no se aplicará una decisión antigua.', 409);
  }
  const transition = applyApprovedLifecycleTransition({
    evaluation: decision,
    approval: {
      approved: true,
      role: APPROVAL_ROLES.CLIENT,
      actor_id: String(actorId),
      approved_at: instant.toISOString(),
    },
    now: instant,
  });
  return {
    actor_user_id: actorId,
    decision_digest: observedDigest,
    evaluation_id: positiveInteger(evaluationRow.id),
    policy_id: positiveInteger(policyRow.id),
    transition,
  };
}

async function withTransaction(transaction, dependencies, callback) {
  if (transaction) return callback(transaction);
  const sequelize = dependencies.sequelize || db.sequelize;
  if (sequelize?.transaction) return sequelize.transaction(callback);
  return callback(null);
}

async function acquireGuidedTransitionLease({
  policyId,
  evaluationId,
  now = new Date(),
  ttlMs = EXECUTION_LEASE_TTL_MS,
  transaction = null,
  dependencies = {},
} = {}) {
  const Policy = dependencies.Policy || db.CampaignOptimizationPolicy;
  const Evaluation = dependencies.Evaluation || db.CampaignOptimizationEvaluation;
  const normalizedPolicyId = positiveInteger(policyId);
  const normalizedEvaluationId = positiveInteger(evaluationId);
  if (!normalizedPolicyId || !normalizedEvaluationId) {
    throw transitionError('GUIDED_TRANSITION_ID_REQUIRED', 'policy_id y evaluation_id son obligatorios.', 400);
  }
  const instant = validDate(now, 'now');
  const safeTtl = Number(ttlMs);
  if (!Number.isFinite(safeTtl) || safeTtl < 60_000 || safeTtl > 60 * 60 * 1000) {
    throw new TypeError('ttlMs debe estar entre 1 y 60 minutos');
  }
  return withTransaction(transaction, dependencies, async (ownedTransaction) => {
    const policy = await Policy.findByPk(normalizedPolicyId, policyLockOptions(ownedTransaction));
    if (!policy) throw transitionError('GUIDED_POLICY_NOT_FOUND', 'La política ya no existe.', 404);
    const evaluation = await Evaluation.findByPk(normalizedEvaluationId, {
      ...(ownedTransaction ? { transaction: ownedTransaction } : {}),
    });
    if (!evaluation) throw transitionError('GUIDED_EVALUATION_NOT_FOUND', 'La evaluación ya no existe.', 404);
    const policyRow = plain(policy) || {};
    const state = objectValue(policyRow.lifecycleState);
    const decision = lifecycleDecision(evaluation);
    const completed = objectValue(state.approved_transition);
    if (
      positiveInteger(completed.evaluation_id) === normalizedEvaluationId
      && completed.decision_digest === plain(evaluation).decisionDigest
      && state.stage === decision.candidate_stage
    ) {
      return { acquired: false, already_applied: true, policy, evaluation };
    }
    const latest = typeof Evaluation.findOne === 'function'
      ? await Evaluation.findOne({
          where: { policyId: normalizedPolicyId },
          order: [['evaluatedAt', 'DESC'], ['id', 'DESC']],
          ...(ownedTransaction ? { transaction: ownedTransaction } : {}),
        })
      : evaluation;
    if (positiveInteger(plain(latest)?.id) !== normalizedEvaluationId) {
      throw transitionError('GUIDED_EVALUATION_SUPERSEDED', 'Existe una evaluación posterior; no se aplicará una decisión antigua.', 409);
    }
    const existingLease = objectValue(state.execution_lease);
    const existingExpiry = new Date(existingLease.expires_at || 0);
    if (
      String(existingLease.token || '').trim()
      && Number.isFinite(existingExpiry.getTime())
      && existingExpiry.getTime() > instant.getTime()
    ) {
      throw transitionError('GUIDED_TRANSITION_IN_PROGRESS', 'Ya hay un cambio de objetivo en curso.', 409);
    }
    const verified = verifyReadyGuidedEvaluation({ policy, evaluation, now: instant });
    const token = crypto.randomUUID();
    const lease = {
      token,
      purpose: 'guided_lifecycle_transition',
      evaluation_id: normalizedEvaluationId,
      from_stage: verified.transition.from_stage,
      to_stage: verified.transition.to_stage,
      acquired_at: instant.toISOString(),
      expires_at: new Date(instant.getTime() + safeTtl).toISOString(),
    };
    await policy.update({
      lifecycleState: {
        ...state,
        execution_lease: lease,
        pending_provider_transition: {
          evaluation_id: normalizedEvaluationId,
          decision_digest: verified.decision_digest,
          from_stage: verified.transition.from_stage,
          to_stage: verified.transition.to_stage,
          requested_at: instant.toISOString(),
        },
      },
      version: Number(policyRow.version) + 1,
    }, ownedTransaction ? { transaction: ownedTransaction } : undefined);
    return { acquired: true, token, lease, policy, evaluation, verified };
  });
}

async function finalizeGuidedTransition({
  policyId,
  evaluationId,
  leaseToken,
  providerResult,
  now = new Date(),
  transaction = null,
  dependencies = {},
} = {}) {
  const Policy = dependencies.Policy || db.CampaignOptimizationPolicy;
  const Evaluation = dependencies.Evaluation || db.CampaignOptimizationEvaluation;
  const instant = validDate(now, 'now');
  return withTransaction(transaction, dependencies, async (ownedTransaction) => {
    const policy = await Policy.findByPk(positiveInteger(policyId), policyLockOptions(ownedTransaction));
    const evaluation = await Evaluation.findByPk(positiveInteger(evaluationId), {
      ...(ownedTransaction ? { transaction: ownedTransaction } : {}),
    });
    if (!policy || !evaluation) throw transitionError('GUIDED_TRANSITION_CONTEXT_MISSING', 'La política o evaluación desapareció.', 409);
    const row = plain(policy) || {};
    const state = objectValue(row.lifecycleState);
    if (String(state.execution_lease?.token || '') !== String(leaseToken || '')) {
      throw transitionError('GUIDED_TRANSITION_LEASE_MISMATCH', 'La reserva cambió antes de confirmar Google.', 409);
    }
    const verified = verifyReadyGuidedEvaluation({ policy, evaluation, now: instant });
    if (providerResult?.verification?.healthy !== true) {
      throw transitionError('GUIDED_GOAL_POLICY_READBACK_FAILED', 'Google no confirmó el cambio mediante readback.', 502);
    }
    const nextState = {
      ...state,
      ...verified.transition.next_state,
      authorization: state.authorization,
      approved_transition: {
        evaluation_id: verified.evaluation_id,
        from_stage: verified.transition.from_stage,
        to_stage: verified.transition.to_stage,
        approved_at: verified.transition.approved_at,
        approved_by_role: APPROVAL_ROLES.CLIENT,
        approved_by_user_id: verified.actor_user_id,
        initial_authorization_reused: true,
        decision_digest: verified.decision_digest,
      },
      provider_application: {
        status: 'applied',
        attempted_at: state.pending_provider_transition?.requested_at || instant.toISOString(),
        applied_at: instant.toISOString(),
        stage: verified.transition.to_stage,
        digests: providerResult.digests || [],
        accounts: objectValue(state.provider_application).accounts || {},
      },
    };
    delete nextState.execution_lease;
    delete nextState.pending_provider_transition;
    await policy.update({
      status: 'active',
      lifecycleState: nextState,
      nextEvaluationAt: new Date(instant.getTime() + 22 * 60 * 60 * 1000),
      version: Number(row.version) + 1,
    }, ownedTransaction ? { transaction: ownedTransaction } : undefined);
    return { finalized: true, policy, transition: verified.transition };
  });
}

async function failGuidedTransition({
  policyId,
  evaluationId,
  leaseToken,
  error,
  now = new Date(),
  transaction = null,
  dependencies = {},
} = {}) {
  const Policy = dependencies.Policy || db.CampaignOptimizationPolicy;
  const instant = validDate(now, 'now');
  return withTransaction(transaction, dependencies, async (ownedTransaction) => {
    const policy = await Policy.findByPk(positiveInteger(policyId), policyLockOptions(ownedTransaction));
    if (!policy) return { released: false, reason: 'policy_missing' };
    const row = plain(policy) || {};
    const state = objectValue(row.lifecycleState);
    if (String(state.execution_lease?.token || '') !== String(leaseToken || '')) {
      return { released: false, reason: 'lease_mismatch' };
    }
    const nextState = {
      ...state,
      provider_application: {
        status: 'failed',
        attempted_at: state.pending_provider_transition?.requested_at || instant.toISOString(),
        applied_at: null,
        evaluation_id: positiveInteger(evaluationId),
        stage: state.pending_provider_transition?.to_stage || null,
        error_code: String(error?.code || 'GUIDED_TRANSITION_FAILED').slice(0, 120),
        accounts: objectValue(state.provider_application).accounts || {},
      },
    };
    delete nextState.execution_lease;
    delete nextState.pending_provider_transition;
    await policy.update({
      // A provider failure must not pretend the lifecycle advanced and must
      // not silently stop measurement/evaluation for the current stage.
      status: 'active',
      lifecycleState: nextState,
      version: Number(row.version) + 1,
    }, ownedTransaction ? { transaction: ownedTransaction } : undefined);
    return { released: true, policy };
  });
}

module.exports = {
  EXECUTION_LEASE_TTL_MS,
  acquireGuidedTransitionLease,
  computeEvaluationDigest,
  evaluationDigestInput,
  failGuidedTransition,
  finalizeGuidedTransition,
  verifyReadyGuidedEvaluation,
};

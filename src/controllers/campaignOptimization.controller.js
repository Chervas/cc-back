'use strict';

const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../models');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveRequestedScope(query = {}) {
  const explicit = String(query.scope_type || query.assignment_scope || '').trim().toLowerCase();
  const groupId = positiveInteger(query.group_id);
  const clinicId = positiveInteger(query.clinic_id ?? query.clinica_id);
  const scopeId = positiveInteger(query.scope_id);
  const scopeType = explicit || (groupId ? 'group' : clinicId ? 'clinic' : null);
  if (!['clinic', 'group'].includes(scopeType)) {
    const error = new Error('scope_type debe ser clinic o group');
    error.status = 400;
    throw error;
  }
  const id = scopeId || (scopeType === 'group' ? groupId : clinicId);
  if (!id) {
    const error = new Error('scope_id es obligatorio');
    error.status = 400;
    throw error;
  }
  return { scopeType, scopeId: id };
}

async function clinicIdsForScope(scope) {
  if (scope.scopeType === 'clinic') {
    const clinic = await db.Clinica.findByPk(scope.scopeId, {
      attributes: ['id_clinica'],
      raw: true,
    });
    if (!clinic) {
      const error = new Error('Clínica no encontrada');
      error.status = 404;
      throw error;
    }
    return [clinic.id_clinica];
  }

  const group = await db.GrupoClinica.findByPk(scope.scopeId, {
    attributes: ['id_grupo'],
    raw: true,
  });
  if (!group) {
    const error = new Error('Grupo no encontrado');
    error.status = 404;
    throw error;
  }
  const clinics = await db.Clinica.findAll({
    where: { grupoClinicaId: scope.scopeId },
    attributes: ['id_clinica'],
    raw: true,
  });
  return clinics.map((clinic) => clinic.id_clinica).filter(Boolean);
}

async function requireReadAccess(req, scope) {
  const clinicIds = await clinicIdsForScope(scope);
  const allowed = await hasMarketingClinicScopeAccess({
    userId: req.userData?.userId,
    clinicIds,
    access: 'read',
  });
  if (!allowed) {
    const error = new Error('No tienes acceso a todas las clínicas de esta política.');
    error.status = 403;
    error.code = 'scope_forbidden';
    throw error;
  }
}

function serializePolicy(row) {
  const policy = row?.get ? row.get({ plain: true }) : row;
  return {
    id: policy.id,
    scope_type: policy.scopeType,
    scope_id: policy.scopeId,
    mode: policy.mode,
    strategy_id: policy.strategyId,
    managed_campaign_id: policy.managedCampaignId,
    customer_ids: policy.customerIds || [],
    campaign_ids: policy.campaignIds || [],
    lifecycle_state: policy.lifecycleState || {},
    thresholds: policy.thresholds || {},
    status: policy.status,
    version: policy.version,
    next_evaluation_at: policy.nextEvaluationAt,
    last_evaluated_at: policy.lastEvaluatedAt,
    created_at: policy.created_at,
    updated_at: policy.updated_at,
  };
}

function serializeEvaluation(row) {
  const evaluation = row?.get ? row.get({ plain: true }) : row;
  return {
    id: evaluation.id,
    policy_id: evaluation.policyId,
    policy_version: evaluation.policyVersion,
    evaluation_date: evaluation.evaluationDate,
    evaluated_at: evaluation.evaluatedAt,
    metrics: evaluation.metrics || {},
    evidence: evaluation.evidence || {},
    blockers: evaluation.blockers || [],
    decision_digest: evaluation.decisionDigest,
    eligible_now: Boolean(evaluation.eligibleNow),
    ready_for_approval: Boolean(evaluation.readyForApproval),
    status: evaluation.status,
  };
}

const getOptimizationStatus = asyncHandler(async (req, res) => {
  const scope = resolveRequestedScope(req.query);
  await requireReadAccess(req, scope);
  const requestedLimit = positiveInteger(req.query.evaluation_limit) || 30;
  const evaluationLimit = Math.min(requestedLimit, 90);
  const policies = await db.CampaignOptimizationPolicy.findAll({
    where: { scopeType: scope.scopeType, scopeId: scope.scopeId },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
  });
  const policyIds = policies.map((row) => row.id);
  const evaluations = policyIds.length
    ? await db.CampaignOptimizationEvaluation.findAll({
        where: { policyId: { [Op.in]: policyIds } },
        order: [['evaluatedAt', 'DESC'], ['id', 'DESC']],
        limit: evaluationLimit,
      })
    : [];
  const serializedEvaluations = evaluations.map(serializeEvaluation);
  const latestByPolicy = new Map();
  serializedEvaluations.forEach((evaluation) => {
    if (!latestByPolicy.has(String(evaluation.policy_id))) {
      latestByPolicy.set(String(evaluation.policy_id), evaluation);
    }
  });

  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    read_only: true,
    scope: { type: scope.scopeType, id: scope.scopeId },
    policies: policies.map((row) => {
      const policy = serializePolicy(row);
      return { ...policy, latest_evaluation: latestByPolicy.get(String(policy.id)) || null };
    }),
    evaluations: serializedEvaluations,
  });
});

module.exports = {
  clinicIdsForScope,
  getOptimizationStatus,
  requireReadAccess,
  resolveRequestedScope,
  serializeEvaluation,
  serializePolicy,
};

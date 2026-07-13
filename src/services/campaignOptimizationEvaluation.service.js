'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const {
  STAGES,
  STAGE_TRANSITIONS,
  evaluateCampaignOptimizationLifecycle,
} = require('./campaignOptimizationLifecycle.service');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_STALE_HOURS = 48;
const TRACKED_EVENTS = Object.freeze(['qualified_lead', 'schedule', 'purchase']);
const FINAL_SUCCESS_STATUSES = new Set(['succeeded']);
const IN_FLIGHT_STATUSES = new Set(['pending', 'accepted']);

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function cleanIdList(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').replace(/\D/g, ''))
    .filter(Boolean)));
}

function dateOrNull(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function utcDate(value) {
  return value.toISOString().slice(0, 10);
}

function activeExecutionLease(policy, now) {
  const lease = policy?.lifecycleState?.execution_lease;
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) return null;
  const expiresAt = dateOrNull(lease.expires_at);
  return String(lease.token || '').trim() && expiresAt && expiresAt.getTime() > now.getTime()
    ? { expires_at: expiresAt.toISOString(), purpose: String(lease.purpose || '') || null }
    : null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function qualityBlocker(code, message, details = null) {
  return { code, message, ...(details ? { details } : {}) };
}

function eventIdentity(row) {
  return [row.customerId, row.conversionAction, row.eventName, row.eventId]
    .map((value) => String(value || ''))
    .join('|');
}

function buildScopeWhere(policy, operators = Op) {
  if (policy.scopeType === 'clinic') return { clinicaId: Number(policy.scopeId) };
  if (policy.scopeType === 'group') return { grupoClinicaId: Number(policy.scopeId) };
  throw new Error(`Alcance de política inválido: ${policy.scopeType || 'vacío'}`);
}

function buildAttemptWhere(policy, now, operators = Op) {
  const customerIds = cleanIdList(policy.customerIds);
  return {
    ...buildScopeWhere(policy, operators),
    eventName: { [operators.in]: TRACKED_EVENTS },
    attemptedAt: { [operators.gte]: new Date(now.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS) },
    ...(customerIds.length ? { customerId: { [operators.in]: customerIds } } : {}),
  };
}

function duplicateEvidence(rows) {
  if (!rows.length) {
    return { complete: true, duplicateEvents: 0, totalEvents: 0, duplicateRate: 0 };
  }
  const missingEventIds = rows.filter((row) => !String(row.eventId || '').trim()).length;
  if (missingEventIds) {
    return {
      complete: false,
      missingEventIds,
      duplicateEvents: null,
      totalEvents: rows.length,
      duplicateRate: null,
    };
  }
  const groups = new Map();
  rows.forEach((row) => {
    const key = eventIdentity(row);
    groups.set(key, (groups.get(key) || 0) + 1);
  });
  const duplicateEvents = Array.from(groups.values()).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  return {
    complete: true,
    duplicateEvents,
    totalEvents: rows.length,
    duplicateRate: rows.length ? duplicateEvents / rows.length : 0,
  };
}

function summarizeEventRows(rows, now, staleHours = DEFAULT_STALE_HOURS) {
  const staleBefore = now.getTime() - staleHours * 60 * 60 * 1000;
  const statuses = rows.reduce((counts, row) => {
    const status = String(row.status || 'unknown').toLowerCase();
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  const succeededRows = rows.filter((row) => FINAL_SUCCESS_STATUSES.has(String(row.status || '').toLowerCase()));
  const stale = rows.filter((row) => {
    const status = String(row.status || '').toLowerCase();
    const attemptedAt = dateOrNull(row.attemptedAt);
    return IN_FLIGHT_STATUSES.has(status) && attemptedAt && attemptedAt.getTime() < staleBefore;
  }).length;
  const duplicate = duplicateEvidence(rows);
  const successfulConversions = duplicate.complete
    ? new Set(succeededRows.map(eventIdentity)).size
    : succeededRows.length;
  return {
    conversions_30d: successfulConversions,
    uploaded_successfully: succeededRows.length,
    upload_attempts: rows.length,
    upload_success_rate: rows.length ? succeededRows.length / rows.length : null,
    stale_attempts: stale,
    stale_rate: rows.length ? stale / rows.length : 0,
    statuses,
    duplicate,
  };
}

function buildLifecycleMetrics({ policy, attempts, now }) {
  const customerIds = cleanIdList(policy.customerIds);
  const campaignIds = cleanIdList(policy.campaignIds);
  const metrics = {};
  const qualityBlockers = [];

  if (!customerIds.length) {
    qualityBlockers.push(qualityBlocker(
      'CUSTOMER_COHORT_MISSING',
      'La política no tiene una cohorte explícita de cuentas de Google Ads.'
    ));
  }
  if (!campaignIds.length) {
    qualityBlockers.push(qualityBlocker(
      'CAMPAIGN_COHORT_MISSING',
      'La política no tiene una cohorte explícita de campañas.'
    ));
  }

  const summaries = {};
  TRACKED_EVENTS.forEach((eventName) => {
    const eventRows = attempts.filter((row) => String(row.eventName || '').toLowerCase() === eventName);
    summaries[eventName] = summarizeEventRows(eventRows, now);
  });

  const nextStage = STAGE_TRANSITIONS[policy.lifecycleState?.stage || STAGES.MEASUREMENT];
  if (nextStage === STAGES.QUALIFIED_LEAD) {
    const summary = summaries.qualified_lead;
    metrics.qualified_lead = {
      conversions_30d: summary.conversions_30d,
      uploaded_successfully: summary.uploaded_successfully,
      upload_attempts: summary.upload_attempts,
      upload_success_rate: summary.upload_success_rate,
      stale_attempts: summary.stale_attempts,
      stale_rate: summary.stale_rate,
      selected_campaign_ids: campaignIds,
      // GoogleAdsConversionUploadAttempts no conserva campaign_id. No se
      // fabrica un reparto: el evaluador puro bloqueará la transición.
      campaigns: [],
      ...(summary.duplicate.complete ? {
        duplicate_events: summary.duplicate.duplicateEvents,
        total_events: summary.duplicate.totalEvents,
        duplicate_rate: summary.duplicate.duplicateRate,
      } : {}),
    };
    qualityBlockers.push(qualityBlocker(
      'CAMPAIGN_BREAKDOWN_UNAVAILABLE',
      'Los intentos de subida no guardan todavía un desglose fiable por campaña.'
    ));
    if (!summary.duplicate.complete) {
      qualityBlockers.push(qualityBlocker(
        'DUPLICATE_EVENT_ID_COVERAGE_INCOMPLETE',
        'No puede calcularse la tasa de duplicados porque faltan event_id.',
        { missing_event_ids: summary.duplicate.missingEventIds }
      ));
    }
    if (summary.stale_attempts > 0) {
      qualityBlockers.push(qualityBlocker(
        'STALE_QUALIFIED_LEAD_UPLOADS',
        'Hay cargas de lead válido pendientes o aceptadas sin resolución desde hace más de 48 horas.',
        { count: summary.stale_attempts }
      ));
    }
  } else if (nextStage === STAGES.SCHEDULE) {
    const summary = summaries.schedule;
    metrics.schedule = {
      conversions_30d: summary.conversions_30d,
      uploaded_successfully: summary.uploaded_successfully,
      upload_attempts: summary.upload_attempts,
      upload_success_rate: summary.upload_success_rate,
      stale_attempts: summary.stale_attempts,
      stale_rate: summary.stale_rate,
      // attempted_at es el momento de transporte, no la fecha de la cita.
      // No se usa como sustituto de cuatro semanas de citas reales.
    };
    qualityBlockers.push(qualityBlocker(
      'SCHEDULE_WEEKLY_HISTORY_UNAVAILABLE',
      'Falta una serie semanal por fecha real de cita; attempted_at no es una sustitución válida.'
    ));
    if (summary.stale_attempts > 0) {
      qualityBlockers.push(qualityBlocker(
        'STALE_SCHEDULE_UPLOADS',
        'Hay cargas de cita pendientes o aceptadas sin resolución desde hace más de 48 horas.',
        { count: summary.stale_attempts }
      ));
    }
  } else if (nextStage === STAGES.PURCHASE) {
    const summary = summaries.purchase;
    metrics.purchase = {
      conversions_30d: summary.conversions_30d,
      upload_attempts: summary.upload_attempts,
      stale_attempts: summary.stale_attempts,
      stale_rate: summary.stale_rate,
      // request_metadata.has_value no acredita importe cobrado, margen ni
      // distingue valor real de fallback. Las tasas se dejan ausentes.
    };
    qualityBlockers.push(qualityBlocker(
      'PURCHASE_VALUE_PROVENANCE_UNAVAILABLE',
      'Falta procedencia verificable del valor real y del valor fallback de tratamientos.'
    ));
    if (summary.stale_attempts > 0) {
      qualityBlockers.push(qualityBlocker(
        'STALE_PURCHASE_UPLOADS',
        'Hay cargas de tratamiento pendientes o aceptadas sin resolución desde hace más de 48 horas.',
        { count: summary.stale_attempts }
      ));
    }
  }

  metrics.transport = {
    window_days: DEFAULT_WINDOW_DAYS,
    customer_ids: customerIds,
    campaign_ids: campaignIds,
    by_event: summaries,
  };
  return { metrics, qualityBlockers };
}

function statusForEvaluation(result) {
  if (!result.candidate_stage) return 'terminal';
  if (result.ready_for_approval) return 'ready';
  if (result.eligible_now) return 'observing';
  return 'blocked';
}

function isUniqueDayCollision(error) {
  return error?.name === 'SequelizeUniqueConstraintError'
    || error?.original?.code === 'ER_DUP_ENTRY'
    || error?.parent?.code === 'ER_DUP_ENTRY';
}

function nextDailyEvaluation(now) {
  return new Date(now.getTime() + 22 * 60 * 60 * 1000);
}

function createCampaignOptimizationEvaluationService(overrides = {}) {
  const dependencies = {
    Policy: db.CampaignOptimizationPolicy,
    Evaluation: db.CampaignOptimizationEvaluation,
    Attempt: db.GoogleAdsConversionUploadAttempt,
    sequelize: db.sequelize,
    operators: Op,
    ...overrides,
  };

  async function loadAttempts(policy, now, transaction = null) {
    if (!cleanIdList(policy.customerIds).length) return [];
    return dependencies.Attempt.findAll({
      where: buildAttemptWhere(policy, now, dependencies.operators),
      attributes: [
        'customerId',
        'conversionAction',
        'eventName',
        'eventId',
        'status',
        'reason',
        'attemptCount',
        'attemptedAt',
        'completedAt',
        'requestMetadata',
      ],
      order: [['attemptedAt', 'ASC'], ['id', 'ASC']],
      raw: true,
      ...(transaction ? { transaction } : {}),
    });
  }

  async function findDailyEvaluation(policyId, evaluationDate, transaction = null) {
    return dependencies.Evaluation.findOne({
      where: { policyId, evaluationDate },
      ...(transaction ? { transaction } : {}),
    });
  }

  async function evaluatePolicy(policyRow, { now = new Date(), transaction = null } = {}) {
    const policy = plain(policyRow);
    const evaluatedAt = dateOrNull(now);
    if (!evaluatedAt) throw new TypeError('now debe ser una fecha válida');
    const executionLease = activeExecutionLease(policy, evaluatedAt);
    if (executionLease) {
      return {
        evaluation: null,
        created: false,
        idempotent: true,
        skipped: true,
        reason: 'goal_policy_execution_in_progress',
        lease: executionLease,
      };
    }
    const evaluationDate = utcDate(evaluatedAt);
    const existing = await findDailyEvaluation(policy.id, evaluationDate, transaction);
    if (existing) return { evaluation: plain(existing), created: false, idempotent: true };

    const attempts = await loadAttempts(policy, evaluatedAt, transaction);
    const aggregated = buildLifecycleMetrics({ policy, attempts, now: evaluatedAt });
    const pure = evaluateCampaignOptimizationLifecycle({
      mode: policy.mode,
      state: policy.lifecycleState || {},
      metrics: aggregated.metrics,
      thresholds: policy.thresholds || {},
      now: evaluatedAt,
    });
    const blockers = [...pure.blockers, ...aggregated.qualityBlockers];
    const eligibleNow = pure.eligible_now && aggregated.qualityBlockers.length === 0;
    const readyForApproval = pure.ready_for_approval && aggregated.qualityBlockers.length === 0;
    const nextState = aggregated.qualityBlockers.length
      ? { ...pure.next_state, pending_transition: null }
      : pure.next_state;
    const evidence = {
      lifecycle: pure.evidence,
      transport: aggregated.metrics.transport,
      pure_decision_digest: pure.decision_digest,
      provider_mutation: null,
    };
    const decisionDigest = digest({
      policy_id: policy.id,
      policy_version: policy.version,
      evaluated_at: evaluatedAt.toISOString(),
      metrics: aggregated.metrics,
      evidence,
      blockers,
      eligible_now: eligibleNow,
      ready_for_approval: readyForApproval,
    });
    const values = {
      policyId: policy.id,
      policyVersion: policy.version,
      evaluationDate,
      evaluatedAt,
      metrics: aggregated.metrics,
      evidence,
      blockers,
      decisionDigest,
      eligibleNow,
      readyForApproval,
      status: statusForEvaluation({
        ...pure,
        eligible_now: eligibleNow,
        ready_for_approval: readyForApproval,
      }),
    };

    let evaluation;
    try {
      evaluation = await dependencies.Evaluation.create(values, transaction ? { transaction } : undefined);
    } catch (error) {
      if (!isUniqueDayCollision(error)) throw error;
      const concurrent = await findDailyEvaluation(policy.id, evaluationDate, transaction);
      if (!concurrent) throw error;
      return { evaluation: plain(concurrent), created: false, idempotent: true, concurrent: true };
    }

    const [updated] = await dependencies.Policy.update({
      lifecycleState: nextState,
      lastEvaluatedAt: evaluatedAt,
      nextEvaluationAt: nextDailyEvaluation(evaluatedAt),
      version: Number(policy.version) + 1,
    }, {
      where: { id: policy.id, version: policy.version, status: 'active' },
      ...(transaction ? { transaction } : {}),
    });
    if (updated !== 1) {
      const error = new Error(`CAS de política ${policy.id} rechazado`);
      error.code = 'CAMPAIGN_OPTIMIZATION_POLICY_CAS_CONFLICT';
      throw error;
    }

    return { evaluation: plain(evaluation), created: true, idempotent: false };
  }

  async function evaluatePolicyAtomically(policyRow, options = {}) {
    if (!dependencies.sequelize?.transaction) return evaluatePolicy(policyRow, options);
    return dependencies.sequelize.transaction((transaction) => evaluatePolicy(policyRow, { ...options, transaction }));
  }

  async function discoverDuePolicies(now = new Date()) {
    return dependencies.Policy.findAll({
      where: {
        status: 'active',
        [dependencies.operators.or]: [
          { nextEvaluationAt: { [dependencies.operators.is]: null } },
          { nextEvaluationAt: { [dependencies.operators.lte]: now } },
        ],
      },
      order: [['nextEvaluationAt', 'ASC'], ['id', 'ASC']],
    });
  }

  async function evaluateDuePolicies({ now = new Date() } = {}) {
    const policies = await discoverDuePolicies(now);
    const report = { discovered: policies.length, evaluated: 0, idempotent: 0, skipped: 0, failed: 0, errors: [] };
    for (const policy of policies) {
      try {
        const result = await evaluatePolicyAtomically(policy, { now });
        if (result.created) report.evaluated += 1;
        else if (result.skipped) report.skipped += 1;
        else report.idempotent += 1;
      } catch (error) {
        report.failed += 1;
        report.errors.push({ policy_id: plain(policy)?.id || null, code: error.code || null, message: error.message });
      }
    }
    return report;
  }

  return {
    buildLifecycleMetrics,
    discoverDuePolicies,
    evaluateDuePolicies,
    evaluatePolicy,
    evaluatePolicyAtomically,
    loadAttempts,
  };
}

const campaignOptimizationEvaluationService = createCampaignOptimizationEvaluationService();

module.exports = {
  DEFAULT_STALE_HOURS,
  DEFAULT_WINDOW_DAYS,
  TRACKED_EVENTS,
  activeExecutionLease,
  buildAttemptWhere,
  buildLifecycleMetrics,
  createCampaignOptimizationEvaluationService,
  ...campaignOptimizationEvaluationService,
};

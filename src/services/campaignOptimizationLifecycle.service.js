'use strict';

const crypto = require('node:crypto');

const SCHEMA_VERSION = 'clinicaclick-campaign-optimization-lifecycle/v1';

const MODES = Object.freeze({
  CONNECT_ONLY: 'connect_only',
  MANAGED_SERVICE: 'managed_service',
});

const APPROVAL_ROLES = Object.freeze({
  CLIENT: 'client',
  OPERATOR: 'operator',
});

const STAGES = Object.freeze({
  MEASUREMENT: 'measurement',
  QUALIFIED_LEAD: 'qualified_lead',
  SCHEDULE: 'schedule',
  PURCHASE: 'purchase',
});

const STAGE_TRANSITIONS = Object.freeze({
  [STAGES.MEASUREMENT]: STAGES.QUALIFIED_LEAD,
  [STAGES.QUALIFIED_LEAD]: STAGES.SCHEDULE,
  [STAGES.SCHEDULE]: STAGES.PURCHASE,
  [STAGES.PURCHASE]: null,
});

const DEFAULT_THRESHOLDS = deepFreeze({
  consecutive_passing_evaluations: 2,
  minimum_evaluation_spacing_hours: 24,
  qualified_lead: {
    minimum_observation_days: 14,
    minimum_conversions_30d: 30,
    minimum_conversions_per_campaign_30d: 10,
    minimum_upload_success_rate: 0.95,
    maximum_duplicate_rate_exclusive: 0.01,
  },
  schedule: {
    minimum_conversions_30d: 30,
    minimum_stable_weeks: 4,
    minimum_conversions_per_week: 5,
    minimum_upload_success_rate: 0.95,
    cooldown_days: 14,
  },
  purchase: {
    minimum_conversions_30d: 30,
    minimum_real_value_rate: 0.90,
    maximum_fallback_value_rate: 0.05,
    minimum_stage_dwell_weeks: 4,
  },
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).trim();
  return cleaned || null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function rate(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && number <= 1 ? number : null;
}

function dateValue(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} debe ser una fecha válida`);
  }
  return date;
}

function isoDate(value, label) {
  return dateValue(value, label).toISOString();
}

function daysBetween(start, end) {
  return (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
}

function hoursBetween(start, end) {
  return (end.getTime() - start.getTime()) / (60 * 60 * 1000);
}

function numericOverride(value, fallback, path, { integer = false, minimum = 0, maximum = Number.POSITIVE_INFINITY } = {}) {
  if (value === undefined) return fallback;
  const number = finiteNumber(value);
  if (number === null || number < minimum || number > maximum || (integer && !Number.isInteger(number))) {
    throw new TypeError(`${path} contiene un umbral inválido`);
  }
  return number;
}

function normalizeThresholds(overrides = {}) {
  if (!isObject(overrides)) throw new TypeError('thresholds debe ser un objeto');
  const ql = isObject(overrides.qualified_lead) ? overrides.qualified_lead : {};
  const schedule = isObject(overrides.schedule) ? overrides.schedule : {};
  const purchase = isObject(overrides.purchase) ? overrides.purchase : {};
  return {
    consecutive_passing_evaluations: numericOverride(
      overrides.consecutive_passing_evaluations,
      DEFAULT_THRESHOLDS.consecutive_passing_evaluations,
      'consecutive_passing_evaluations',
      { integer: true, minimum: 2, maximum: 20 },
    ),
    minimum_evaluation_spacing_hours: numericOverride(
      overrides.minimum_evaluation_spacing_hours,
      DEFAULT_THRESHOLDS.minimum_evaluation_spacing_hours,
      'minimum_evaluation_spacing_hours',
      { minimum: 0, maximum: 24 * 30 },
    ),
    qualified_lead: {
      minimum_observation_days: numericOverride(ql.minimum_observation_days, DEFAULT_THRESHOLDS.qualified_lead.minimum_observation_days, 'qualified_lead.minimum_observation_days'),
      minimum_conversions_30d: numericOverride(ql.minimum_conversions_30d, DEFAULT_THRESHOLDS.qualified_lead.minimum_conversions_30d, 'qualified_lead.minimum_conversions_30d'),
      minimum_conversions_per_campaign_30d: numericOverride(ql.minimum_conversions_per_campaign_30d, DEFAULT_THRESHOLDS.qualified_lead.minimum_conversions_per_campaign_30d, 'qualified_lead.minimum_conversions_per_campaign_30d'),
      minimum_upload_success_rate: numericOverride(ql.minimum_upload_success_rate, DEFAULT_THRESHOLDS.qualified_lead.minimum_upload_success_rate, 'qualified_lead.minimum_upload_success_rate', { maximum: 1 }),
      maximum_duplicate_rate_exclusive: numericOverride(ql.maximum_duplicate_rate_exclusive, DEFAULT_THRESHOLDS.qualified_lead.maximum_duplicate_rate_exclusive, 'qualified_lead.maximum_duplicate_rate_exclusive', { maximum: 1 }),
    },
    schedule: {
      minimum_conversions_30d: numericOverride(schedule.minimum_conversions_30d, DEFAULT_THRESHOLDS.schedule.minimum_conversions_30d, 'schedule.minimum_conversions_30d'),
      minimum_stable_weeks: numericOverride(schedule.minimum_stable_weeks, DEFAULT_THRESHOLDS.schedule.minimum_stable_weeks, 'schedule.minimum_stable_weeks', { integer: true, minimum: 1, maximum: 52 }),
      minimum_conversions_per_week: numericOverride(schedule.minimum_conversions_per_week, DEFAULT_THRESHOLDS.schedule.minimum_conversions_per_week, 'schedule.minimum_conversions_per_week'),
      minimum_upload_success_rate: numericOverride(schedule.minimum_upload_success_rate, DEFAULT_THRESHOLDS.schedule.minimum_upload_success_rate, 'schedule.minimum_upload_success_rate', { maximum: 1 }),
      cooldown_days: numericOverride(schedule.cooldown_days, DEFAULT_THRESHOLDS.schedule.cooldown_days, 'schedule.cooldown_days'),
    },
    purchase: {
      minimum_conversions_30d: numericOverride(purchase.minimum_conversions_30d, DEFAULT_THRESHOLDS.purchase.minimum_conversions_30d, 'purchase.minimum_conversions_30d'),
      minimum_real_value_rate: numericOverride(purchase.minimum_real_value_rate, DEFAULT_THRESHOLDS.purchase.minimum_real_value_rate, 'purchase.minimum_real_value_rate', { maximum: 1 }),
      maximum_fallback_value_rate: numericOverride(purchase.maximum_fallback_value_rate, DEFAULT_THRESHOLDS.purchase.maximum_fallback_value_rate, 'purchase.maximum_fallback_value_rate', { maximum: 1 }),
      minimum_stage_dwell_weeks: numericOverride(purchase.minimum_stage_dwell_weeks, DEFAULT_THRESHOLDS.purchase.minimum_stage_dwell_weeks, 'purchase.minimum_stage_dwell_weeks'),
    },
  };
}

function normalizeMode(mode) {
  if (!Object.values(MODES).includes(mode)) {
    throw new TypeError(`mode debe ser ${MODES.CONNECT_ONLY} o ${MODES.MANAGED_SERVICE}`);
  }
  return mode;
}

function approvalPolicyForMode(mode) {
  const normalized = normalizeMode(mode);
  return {
    required: true,
    role: normalized === MODES.CONNECT_ONLY ? APPROVAL_ROLES.CLIENT : APPROVAL_ROLES.OPERATOR,
    automatic_provider_mutation: false,
  };
}

function normalizeState(rawState, now) {
  if (!isObject(rawState)) throw new TypeError('state debe ser un objeto');
  const stage = rawState.stage || STAGES.MEASUREMENT;
  if (!Object.values(STAGES).includes(stage)) throw new TypeError('state.stage no es válido');
  const stageEnteredAt = dateValue(rawState.stage_entered_at || rawState.measurement_started_at || now, 'state.stage_entered_at');
  if (stageEnteredAt > now) throw new TypeError('state.stage_entered_at no puede estar en el futuro');
  const lastTransitionAt = rawState.last_transition_at
    ? dateValue(rawState.last_transition_at, 'state.last_transition_at')
    : null;
  if (lastTransitionAt && lastTransitionAt > now) throw new TypeError('state.last_transition_at no puede estar en el futuro');
  const lastEvaluationAt = rawState.last_evaluation_at
    ? dateValue(rawState.last_evaluation_at, 'state.last_evaluation_at')
    : null;
  if (lastEvaluationAt && lastEvaluationAt > now) throw new TypeError('state.last_evaluation_at no puede estar en el futuro');
  const pending = isObject(rawState.pending_transition) ? {
    from: rawState.pending_transition.from,
    to: rawState.pending_transition.to,
    consecutive_passes: Math.max(0, Math.floor(nonNegativeNumber(rawState.pending_transition.consecutive_passes) || 0)),
    first_passed_at: rawState.pending_transition.first_passed_at
      ? isoDate(rawState.pending_transition.first_passed_at, 'state.pending_transition.first_passed_at')
      : null,
    last_passed_at: rawState.pending_transition.last_passed_at
      ? isoDate(rawState.pending_transition.last_passed_at, 'state.pending_transition.last_passed_at')
      : null,
  } : null;
  const expectedTo = STAGE_TRANSITIONS[stage];
  const validPending = pending && pending.from === stage && pending.to === expectedTo ? pending : null;
  return {
    stage,
    stage_entered_at: stageEnteredAt.toISOString(),
    last_transition_at: lastTransitionAt ? lastTransitionAt.toISOString() : null,
    last_evaluation_at: lastEvaluationAt ? lastEvaluationAt.toISOString() : null,
    pending_transition: validPending,
  };
}

function metricValue(source, key, blockers, code, label) {
  const value = nonNegativeNumber(source?.[key]);
  if (value === null) blockers.push({ code, message: `${label} no está disponible`, actual: null });
  return value;
}

function metricRate(source, directKey, numeratorKey, denominatorKey, blockers, code, label) {
  const direct = rate(source?.[directKey]);
  if (direct !== null) return direct;
  const numerator = nonNegativeNumber(source?.[numeratorKey]);
  const denominator = nonNegativeNumber(source?.[denominatorKey]);
  if (numerator !== null && denominator !== null && denominator > 0 && numerator <= denominator) {
    return numerator / denominator;
  }
  blockers.push({ code, message: `${label} no está disponible`, actual: null });
  return null;
}

function requireAtLeast(blockers, code, label, actual, expected) {
  if (actual !== null && actual < expected) blockers.push({ code, message: `${label}: ${actual} < ${expected}`, actual, expected });
}

function requireAtMost(blockers, code, label, actual, expected) {
  if (actual !== null && actual > expected) blockers.push({ code, message: `${label}: ${actual} > ${expected}`, actual, expected });
}

function evaluateQualifiedLead({ metrics, state, now, thresholds }) {
  const source = metrics.qualified_lead;
  const blockers = [];
  if (!isObject(source)) {
    return { blockers: [{ code: 'QL_METRICS_MISSING', message: 'Faltan métricas de lead válido', actual: null }], evidence: {} };
  }
  const observationDays = daysBetween(dateValue(state.stage_entered_at, 'state.stage_entered_at'), now);
  const conversions = metricValue(source, 'conversions_30d', blockers, 'QL_CONVERSIONS_MISSING', 'Leads válidos en 30 días');
  const uploadRate = metricRate(source, 'upload_success_rate', 'uploaded_successfully', 'upload_attempts', blockers, 'QL_UPLOAD_RATE_MISSING', 'Éxito de carga de lead válido');
  const duplicateRate = metricRate(source, 'duplicate_rate', 'duplicate_events', 'total_events', blockers, 'QL_DUPLICATE_RATE_MISSING', 'Duplicados de lead válido');
  requireAtLeast(blockers, 'QL_OBSERVATION_TOO_SHORT', 'Observación de lead válido en días', observationDays, thresholds.minimum_observation_days);
  requireAtLeast(blockers, 'QL_VOLUME_TOO_LOW', 'Leads válidos en 30 días', conversions, thresholds.minimum_conversions_30d);
  requireAtLeast(blockers, 'QL_UPLOAD_RATE_TOO_LOW', 'Éxito de carga de lead válido', uploadRate, thresholds.minimum_upload_success_rate);
  if (duplicateRate !== null && duplicateRate >= thresholds.maximum_duplicate_rate_exclusive) {
    blockers.push({
      code: 'QL_DUPLICATE_RATE_TOO_HIGH',
      message: `Duplicados de lead válido: ${duplicateRate} no es menor que ${thresholds.maximum_duplicate_rate_exclusive}`,
      actual: duplicateRate,
      expected_exclusive_maximum: thresholds.maximum_duplicate_rate_exclusive,
    });
  }
  const campaigns = Array.isArray(source.campaigns) ? source.campaigns : [];
  const selectedCampaignIds = Array.isArray(source.selected_campaign_ids)
    ? [...new Set(source.selected_campaign_ids.map(cleanString).filter(Boolean))]
    : [];
  if (!selectedCampaignIds.length) {
    blockers.push({ code: 'QL_SELECTED_CAMPAIGNS_MISSING', message: 'Falta la lista explícita de campañas incluidas en el piloto', actual: null });
  }
  if (!campaigns.length) {
    blockers.push({ code: 'QL_CAMPAIGN_METRICS_MISSING', message: 'Falta el desglose por campaña del piloto', actual: null });
  } else {
    const seen = new Set();
    for (const campaign of campaigns) {
      const campaignId = cleanString(campaign?.campaign_id);
      const count = nonNegativeNumber(campaign?.conversions_30d);
      if (!campaignId || seen.has(campaignId) || count === null) {
        blockers.push({ code: 'QL_CAMPAIGN_METRIC_INVALID', message: 'El desglose por campaña contiene una fila inválida', actual: clone(campaign) });
        continue;
      }
      seen.add(campaignId);
      requireAtLeast(blockers, 'QL_CAMPAIGN_VOLUME_TOO_LOW', `Leads válidos de la campaña ${campaignId}`, count, thresholds.minimum_conversions_per_campaign_30d);
    }
    selectedCampaignIds.forEach((campaignId) => {
      if (!seen.has(campaignId)) {
        blockers.push({ code: 'QL_CAMPAIGN_METRIC_MISSING', message: `Faltan métricas de la campaña ${campaignId}`, actual: campaignId });
      }
    });
    seen.forEach((campaignId) => {
      if (selectedCampaignIds.length && !selectedCampaignIds.includes(campaignId)) {
        blockers.push({ code: 'QL_CAMPAIGN_NOT_SELECTED', message: `La campaña ${campaignId} no pertenece al piloto evaluado`, actual: campaignId });
      }
    });
  }
  return {
    blockers,
    evidence: {
      observation_days: observationDays,
      conversions_30d: conversions,
      upload_success_rate: uploadRate,
      duplicate_rate: duplicateRate,
      selected_campaign_ids: selectedCampaignIds,
      campaigns: clone(campaigns),
    },
  };
}

function evaluateSchedule({ metrics, state, now, thresholds }) {
  const source = metrics.schedule;
  const blockers = [];
  if (!isObject(source)) {
    return { blockers: [{ code: 'SCHEDULE_METRICS_MISSING', message: 'Faltan métricas de cita cerrada', actual: null }], evidence: {} };
  }
  const conversions = metricValue(source, 'conversions_30d', blockers, 'SCHEDULE_CONVERSIONS_MISSING', 'Citas cerradas en 30 días');
  const uploadRate = metricRate(source, 'upload_success_rate', 'uploaded_successfully', 'upload_attempts', blockers, 'SCHEDULE_UPLOAD_RATE_MISSING', 'Éxito de carga de citas');
  const weeks = Array.isArray(source.weekly_conversions) ? source.weekly_conversions.map(nonNegativeNumber) : [];
  const recentWeeks = weeks.slice(-thresholds.minimum_stable_weeks);
  requireAtLeast(blockers, 'SCHEDULE_VOLUME_TOO_LOW', 'Citas cerradas en 30 días', conversions, thresholds.minimum_conversions_30d);
  requireAtLeast(blockers, 'SCHEDULE_UPLOAD_RATE_TOO_LOW', 'Éxito de carga de citas', uploadRate, thresholds.minimum_upload_success_rate);
  if (recentWeeks.length < thresholds.minimum_stable_weeks || recentWeeks.some((value) => value === null)) {
    blockers.push({ code: 'SCHEDULE_WEEKLY_HISTORY_MISSING', message: `Se necesitan ${thresholds.minimum_stable_weeks} semanas completas`, actual: recentWeeks });
  } else {
    recentWeeks.forEach((value, index) => requireAtLeast(
      blockers,
      'SCHEDULE_WEEKLY_VOLUME_TOO_LOW',
      `Citas de la semana ${index + 1} del periodo estable`,
      value,
      thresholds.minimum_conversions_per_week,
    ));
  }
  const cooldownStart = state.last_transition_at || state.stage_entered_at;
  const elapsedCooldown = daysBetween(dateValue(cooldownStart, 'cooldown_start'), now);
  requireAtLeast(blockers, 'SCHEDULE_COOLDOWN_ACTIVE', 'Días desde el último cambio de objetivo', elapsedCooldown, thresholds.cooldown_days);
  return {
    blockers,
    evidence: {
      conversions_30d: conversions,
      upload_success_rate: uploadRate,
      weekly_conversions: recentWeeks,
      cooldown_days_elapsed: elapsedCooldown,
    },
  };
}

function evaluatePurchase({ metrics, state, now, thresholds }) {
  const source = metrics.purchase;
  const blockers = [];
  if (!isObject(source)) {
    return { blockers: [{ code: 'PURCHASE_METRICS_MISSING', message: 'Faltan métricas de tratamiento con valor real', actual: null }], evidence: {} };
  }
  const conversions = metricValue(source, 'conversions_30d', blockers, 'PURCHASE_CONVERSIONS_MISSING', 'Tratamientos en 30 días');
  const realValueRate = metricRate(source, 'real_value_rate', 'real_value_events', 'value_events', blockers, 'PURCHASE_REAL_VALUE_RATE_MISSING', 'Cobertura de valor real');
  const fallbackRate = metricRate(source, 'fallback_value_rate', 'fallback_value_events', 'value_events', blockers, 'PURCHASE_FALLBACK_RATE_MISSING', 'Uso de valor de respaldo');
  const dwellWeeks = daysBetween(dateValue(state.stage_entered_at, 'state.stage_entered_at'), now) / 7;
  requireAtLeast(blockers, 'PURCHASE_VOLUME_TOO_LOW', 'Tratamientos en 30 días', conversions, thresholds.minimum_conversions_30d);
  requireAtLeast(blockers, 'PURCHASE_REAL_VALUE_RATE_TOO_LOW', 'Cobertura de valor real', realValueRate, thresholds.minimum_real_value_rate);
  requireAtMost(blockers, 'PURCHASE_FALLBACK_RATE_TOO_HIGH', 'Uso de valor de respaldo', fallbackRate, thresholds.maximum_fallback_value_rate);
  requireAtLeast(blockers, 'PURCHASE_DWELL_TOO_SHORT', 'Semanas optimizando a cita cerrada', dwellWeeks, thresholds.minimum_stage_dwell_weeks);
  return {
    blockers,
    evidence: {
      conversions_30d: conversions,
      real_value_rate: realValueRate,
      fallback_value_rate: fallbackRate,
      stage_dwell_weeks: dwellWeeks,
    },
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((output, key) => {
    output[key] = stableValue(value[key]);
    return output;
  }, {});
}

function decisionDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function evaluateCampaignOptimizationLifecycle({ mode, state, metrics = {}, now = new Date(), thresholds = {} } = {}) {
  const normalizedMode = normalizeMode(mode);
  const instant = dateValue(now, 'now');
  const normalizedThresholds = normalizeThresholds(thresholds);
  const current = normalizeState(state || {}, instant);
  const candidate = STAGE_TRANSITIONS[current.stage];
  const approval = approvalPolicyForMode(normalizedMode);
  if (!candidate) {
    return {
      schema_version: SCHEMA_VERSION,
      mode: normalizedMode,
      from_stage: current.stage,
      candidate_stage: null,
      eligible_now: false,
      consecutive_passes: 0,
      ready_for_approval: false,
      approval,
      blockers: [{ code: 'TERMINAL_STAGE', message: 'Purchase es el último peldaño de optimización' }],
      evidence: {},
      next_state: { ...current, last_evaluation_at: instant.toISOString(), pending_transition: null },
      provider_mutation: null,
      decision_digest: decisionDigest({ mode: normalizedMode, stage: current.stage, now: instant.toISOString(), terminal: true }),
    };
  }

  const evaluator = candidate === STAGES.QUALIFIED_LEAD
    ? evaluateQualifiedLead
    : candidate === STAGES.SCHEDULE
      ? evaluateSchedule
      : evaluatePurchase;
  const stageThresholds = normalizedThresholds[candidate];
  const evaluated = evaluator({ metrics: isObject(metrics) ? metrics : {}, state: current, now: instant, thresholds: stageThresholds });
  const eligibleNow = evaluated.blockers.length === 0;
  let pending = null;
  let consecutivePasses = 0;
  let spacingSatisfied = true;
  const previous = current.pending_transition;
  if (eligibleNow) {
    if (previous && previous.from === current.stage && previous.to === candidate) {
      const previousPassedAt = dateValue(previous.last_passed_at || previous.first_passed_at, 'pending_transition.last_passed_at');
      spacingSatisfied = hoursBetween(previousPassedAt, instant) >= normalizedThresholds.minimum_evaluation_spacing_hours;
      consecutivePasses = previous.consecutive_passes + (spacingSatisfied ? 1 : 0);
      pending = {
        ...previous,
        consecutive_passes: consecutivePasses,
        last_passed_at: spacingSatisfied ? instant.toISOString() : previous.last_passed_at,
      };
    } else {
      consecutivePasses = 1;
      pending = {
        from: current.stage,
        to: candidate,
        consecutive_passes: 1,
        first_passed_at: instant.toISOString(),
        last_passed_at: instant.toISOString(),
      };
    }
  }
  const stabilityBlockers = [];
  if (eligibleNow && !spacingSatisfied) {
    stabilityBlockers.push({
      code: 'CONSECUTIVE_EVALUATION_TOO_SOON',
      message: `La siguiente evaluación debe separarse al menos ${normalizedThresholds.minimum_evaluation_spacing_hours} horas`,
      actual: consecutivePasses,
      expected: normalizedThresholds.consecutive_passing_evaluations,
    });
  } else if (eligibleNow && consecutivePasses < normalizedThresholds.consecutive_passing_evaluations) {
    stabilityBlockers.push({
      code: 'CONSECUTIVE_EVALUATIONS_PENDING',
      message: `Faltan evaluaciones consecutivas correctas: ${consecutivePasses}/${normalizedThresholds.consecutive_passing_evaluations}`,
      actual: consecutivePasses,
      expected: normalizedThresholds.consecutive_passing_evaluations,
    });
  }
  const readyForApproval = eligibleNow
    && spacingSatisfied
    && consecutivePasses >= normalizedThresholds.consecutive_passing_evaluations;
  const nextState = {
    ...current,
    last_evaluation_at: instant.toISOString(),
    pending_transition: pending,
  };
  const digestInput = {
    schema_version: SCHEMA_VERSION,
    mode: normalizedMode,
    from_stage: current.stage,
    candidate_stage: candidate,
    evaluated_at: instant.toISOString(),
    evidence: evaluated.evidence,
    thresholds: normalizedThresholds,
    consecutive_passes: consecutivePasses,
    ready_for_approval: readyForApproval,
    approval_role: approval.role,
  };
  return {
    ...digestInput,
    eligible_now: eligibleNow,
    approval,
    blockers: [...evaluated.blockers, ...stabilityBlockers],
    next_state: nextState,
    provider_mutation: null,
    decision_digest: decisionDigest(digestInput),
  };
}

function applyApprovedLifecycleTransition({ evaluation, approval, now = new Date() } = {}) {
  if (!isObject(evaluation) || evaluation.schema_version !== SCHEMA_VERSION) {
    throw new TypeError('evaluation no pertenece a este contrato');
  }
  if (!evaluation.ready_for_approval || !evaluation.candidate_stage) {
    throw new Error('La transición todavía no está lista para aprobación');
  }
  if (!isObject(approval) || approval.approved !== true) {
    throw new Error('La transición necesita una aprobación explícita');
  }
  const actorRole = cleanString(approval.role);
  if (actorRole !== evaluation.approval.role) {
    throw new Error(`La aprobación debe realizarla el rol ${evaluation.approval.role}`);
  }
  const actorId = cleanString(approval.actor_id);
  if (!actorId) throw new Error('La aprobación necesita actor_id');
  const approvedAt = dateValue(approval.approved_at || now, 'approval.approved_at');
  const evaluatedAt = dateValue(evaluation.evaluated_at, 'evaluation.evaluated_at');
  if (approvedAt < evaluatedAt) throw new Error('approval.approved_at no puede ser anterior a la evaluación');
  const expectedDigest = decisionDigest({
    schema_version: evaluation.schema_version,
    mode: evaluation.mode,
    from_stage: evaluation.from_stage,
    candidate_stage: evaluation.candidate_stage,
    evaluated_at: evaluation.evaluated_at,
    evidence: evaluation.evidence,
    thresholds: evaluation.thresholds,
    consecutive_passes: evaluation.consecutive_passes,
    ready_for_approval: evaluation.ready_for_approval,
    approval_role: evaluation.approval.role,
  });
  if (expectedDigest !== evaluation.decision_digest) throw new Error('La evaluación fue modificada después de calcularse');
  return {
    schema_version: SCHEMA_VERSION,
    transitioned: true,
    from_stage: evaluation.from_stage,
    to_stage: evaluation.candidate_stage,
    approved_at: approvedAt.toISOString(),
    approval: {
      role: actorRole,
      actor_id: actorId,
      decision_digest: evaluation.decision_digest,
    },
    next_state: {
      stage: evaluation.candidate_stage,
      stage_entered_at: approvedAt.toISOString(),
      last_transition_at: approvedAt.toISOString(),
      last_evaluation_at: evaluation.evaluated_at,
      pending_transition: null,
    },
    provider_mutation: null,
  };
}

module.exports = {
  APPROVAL_ROLES,
  DEFAULT_THRESHOLDS,
  MODES,
  SCHEMA_VERSION,
  STAGES,
  STAGE_TRANSITIONS,
  applyApprovedLifecycleTransition,
  approvalPolicyForMode,
  evaluateCampaignOptimizationLifecycle,
  normalizeThresholds,
};

'use strict';

const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const { Op, fn, col, literal } = require('sequelize');
const db = require('../../models');
const { ADMIN_USER_IDS } = require('../lib/role-helpers');
const { publicHttpUrl } = require('../lib/safeHttpTarget');
const {
  REQUIRED_GATE_EVIDENCE,
  buildManagedCampaignPublishingPlan,
  managedCampaignPublishingAccountScopeInput,
} = require('../services/managedCampaignPublishing.service');
const {
  assignmentBelongsToGroup,
  findAssociationAccountScope,
  findManagedCampaignAssociationAccountScope,
  listAssociationOptions,
  saveAssignmentWithinScope,
  upsertInventoryWithinScope,
} = require('../services/managedCampaignAssociationScopes.service');
const {
  COORDINATION_FIELDS,
  campaignOperatorIds,
  listActiveCampaignOperators,
  operationAuditDto,
  operatorSummaryDto,
  requireActiveCampaignOperator,
  updateManagedCampaignCoordination,
} = require('../services/managedCampaignCoordination.service');
const {
  AUDIT_EVENT_TYPES,
  appendAssignmentAudit,
  assignmentAuditDto,
  assignmentDto,
  buildChanges: buildAssignmentChanges,
  clearExternalAssignmentTarget,
  listValidStrategyTargetsForClinic,
  matchingIssueForAssignment,
  updateExternalAssignmentTarget,
} = require('../services/externalCampaignAssignmentTargets.service');

const {
  Clinica,
  Campaign,
  CampaignRequest,
  ExternalCampaignInventory,
  ExternalCampaignAssignment,
  ExternalCampaignAssignmentAudit,
  GoogleAdsInsightsDaily,
  ManagedCampaign,
  ManagedCampaignOperationAudit,
  ManagedCampaignFundingAccount,
  ManagedCampaignLedgerEntry,
  ManagedCampaignSpendSnapshot,
  ManagedCampaignBankTransaction,
  ManagedCampaignReconciliationMatch,
  ManagedCampaignPublishingAudit,
  Tratamiento,
  Usuario,
} = db;

const MANAGED_STATUSES = new Set([
  'draft', 'pending_client_review', 'pending_admin_review', 'changes_requested',
  'approved_to_launch', 'launching', 'active', 'paused', 'blocked', 'completed', 'cancelled',
]);
const PROVIDERS = new Set(['google_ads', 'meta_ads']);
const FAMILIES = new Set(['google_search', 'google_pmax', 'google_smart_observe', 'meta_reach', 'meta_instant_form']);
const CLIENT_PROPOSAL_FAMILIES = new Set(['google_search', 'google_pmax', 'meta_reach', 'meta_instant_form']);
const MATCH_KINDS = new Set(['exact', 'alias', 'fuzzy', 'manual']);
const ASSIGNMENT_REVIEW_FIELDS = Object.freeze([
  'inventory_id', 'provider', 'customer_id', 'campaign_id',
  'campaign_name_snapshot', 'grupo_clinica_id', 'clinica_id',
  'match_kind', 'match_confidence', 'match_explanation', 'status',
  'archive_reason', 'archived_by_user_id', 'archived_at',
]);
const STOP_WORDS = new Set(['propdental', 'clinica', 'clinicas', 'dental', 'dentales', 'centre', 'centro']);
const STATUS_TRANSITIONS = {
  draft: new Set(['pending_client_review', 'pending_admin_review', 'blocked', 'cancelled']),
  pending_client_review: new Set(['pending_admin_review', 'changes_requested', 'cancelled']),
  pending_admin_review: new Set(['changes_requested', 'approved_to_launch', 'blocked', 'cancelled']),
  changes_requested: new Set(['pending_client_review', 'pending_admin_review', 'cancelled']),
  approved_to_launch: new Set(['launching', 'blocked', 'cancelled']),
  launching: new Set(['active', 'blocked']),
  active: new Set(['paused', 'blocked', 'completed']),
  paused: new Set(['active', 'completed', 'cancelled']),
  blocked: new Set(['draft', 'pending_admin_review', 'cancelled']),
  completed: new Set([]),
  cancelled: new Set([]),
};

function operatorIds() {
  return campaignOperatorIds(ADMIN_USER_IDS, process.env.CAMPAIGN_OPERATOR_USER_IDS);
}

function assertOperator(req, res) {
  const userId = Number.parseInt(String(req.userData?.userId || ''), 10);
  if (!operatorIds().has(userId)) {
    res.status(403).json({ success: false, error: 'campaign_operator_only' });
    return null;
  }
  return userId;
}

async function requireAssociationAccountScope(res, {
  groupId,
  provider,
  customerId,
  transaction = null,
} = {}) {
  const scope = await findAssociationAccountScope({
    groupId,
    provider,
    accountId: customerId,
    transaction,
  });
  if (scope) return scope;
  res.status(403).json({
    success: false,
    error: 'matching_account_scope_forbidden',
    message: 'La cuenta publicitaria no está autorizada y activa para el grupo indicado.',
  });
  return null;
}

exports.getAccess = asyncHandler(async (req, res) => {
  const userId = Number.parseInt(String(req.userData?.userId || ''), 10);
  const allowedById = Number.isInteger(userId) && operatorIds().has(userId);
  const activeUser = allowedById
    ? await Usuario.findOne({
        where: { id_usuario: userId, estado_cuenta: 'activo' },
        attributes: ['id_usuario'],
        raw: true,
      })
    : null;
  res.set('Cache-Control', 'no-store');
  return res.json({
    success: true,
    allowed: !!activeUser,
  });
});

async function requireActiveOperatorRequest(req, res) {
  const userId = assertOperator(req, res);
  if (!userId) return null;
  try {
    await requireActiveCampaignOperator({
      userId,
      allowedOperatorIds: operatorIds(),
      userModel: Usuario,
    });
    return userId;
  } catch (error) {
    res.status(error.httpStatus || 403).json({
      success: false,
      error: error.code || 'campaign_operator_inactive',
      message: error.message,
    });
    return null;
  }
}

exports.requireActiveOperator = asyncHandler(async (req, res, next) => {
  const userId = await requireActiveOperatorRequest(req, res);
  if (!userId) return;
  req.campaignOperatorUserId = userId;
  return next();
});

exports.getOperators = asyncHandler(async (req, res) => {
  const userId = positiveInt(req.campaignOperatorUserId)
    || await requireActiveOperatorRequest(req, res);
  if (!userId) return;
  const items = await listActiveCampaignOperators({
    allowedOperatorIds: operatorIds(),
    userModel: Usuario,
  });
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, current_user_id: userId, items });
});

function cleanString(value, max = 1024) {
  if (value === undefined || value === null) return null;
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  const clean = String(value).trim();
  return clean ? clean.slice(0, max) : null;
}

function cleanCustomerId(value) {
  return String(value || '').replace(/[^0-9]/g, '').slice(0, 64);
}

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isActiveClinic(row) {
  return [true, 1, '1'].includes(row?.estado_clinica);
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function safeHttpUrl(value, options) {
  return publicHttpUrl(value, options);
}

function proposalReadiness(campaign) {
  const budget = safeObject(campaign?.budget_config);
  const target = safeObject(campaign?.target_config);
  const destination = safeObject(campaign?.destination_config);
  const creative = safeObject(campaign?.creative_config);
  const review = safeObject(campaign?.review_config);
  const blockers = [];
  if (!CLIENT_PROPOSAL_FAMILIES.has(String(campaign?.family || ''))) {
    blockers.push('Selecciona una familia publicitaria concreta para el piloto');
  }
  if (money(budget.amount) < 100) blockers.push('El presupuesto mensual propuesto debe ser de al menos 100 €');
  if ((cleanString(review.client_proposal_summary, 4000) || '').length < 20) {
    blockers.push('Añade un resumen de propuesta para el cliente');
  }
  if ((cleanString(target.proposal_summary, 2000) || '').length < 10) {
    blockers.push('Define el público, zona o tratamiento objetivo');
  }
  const destinationReady = campaign?.family === 'meta_instant_form'
    ? !!cleanString(destination.instant_form_id, 128)
    : !!safeHttpUrl(destination.final_url || destination.effective_url || destination.landing_url || destination.url);
  if (!destinationReady) blockers.push('Configura un destino válido para la familia seleccionada');
  if (!safeHttpUrl(creative.client_preview_url, { requireHttps: true })) {
    blockers.push('Añade una vista previa https pública para que el cliente pueda revisarla');
  }
  return { ready: blockers.length === 0, blockers };
}

function protectedReviewConfigPatch(currentValue, requestedValue) {
  const current = safeObject(currentValue);
  const requested = safeObject(requestedValue);
  return {
    ...requested,
    client_approval_required: current.client_approval_required === true,
    admin_approval_required: current.admin_approval_required === true,
    requested_at: current.requested_at || null,
    client_approved_at: current.client_approved_at || null,
    client_approved_by_user_id: current.client_approved_by_user_id || null,
    client_change_request: current.client_change_request || null,
    proposal_revision: Math.max(0, Math.trunc(Number(current.proposal_revision) || 0)),
    transition: current.transition || null,
  };
}

function protectedPlatformRefsPatch(currentValue, requestedValue) {
  const current = safeObject(currentValue);
  const requested = safeObject(requestedValue);
  return {
    ...requested,
    ...(Array.isArray(current.benchmark_external_campaigns)
      ? { benchmark_external_campaigns: current.benchmark_external_campaigns }
      : {}),
  };
}

function hasVerifiedPrepaymentEntries(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .some((entry) => safeObject(entry?.metadata).payment_verified === true);
}

function assignmentReactivationAuditReset() {
  return {
    archive_reason: null,
    archived_by_user_id: null,
    archived_at: null,
  };
}

function matchingConfirmationIsNoop(currentValue, nextValue) {
  const current = safeObject(currentValue);
  const next = safeObject(nextValue);
  const numericFields = [
    'inventory_id', 'grupo_clinica_id', 'clinica_id', 'approved_by_user_id',
  ];
  const textFields = [
    'provider', 'customer_id', 'campaign_id', 'campaign_name_snapshot',
    'match_kind', 'match_explanation', 'status', 'archive_reason',
  ];
  if (numericFields.some((field) => Number(current[field] || 0) !== Number(next[field] || 0))) return false;
  if (textFields.some((field) => String(current[field] || '') !== String(next[field] || ''))) return false;
  const currentConfidence = current.match_confidence === null || current.match_confidence === undefined
    ? null
    : Number(current.match_confidence);
  const nextConfidence = next.match_confidence === null || next.match_confidence === undefined
    ? null
    : Number(next.match_confidence);
  if (currentConfidence !== nextConfidence) return false;
  return !current.archived_at && !next.archived_at
    && !positiveInt(current.archived_by_user_id)
    && !positiveInt(next.archived_by_user_id);
}

async function archiveMatchingAssignment({
  provider,
  customerId,
  campaignId,
  groupId,
  reason,
  userId,
  assignmentModel = ExternalCampaignAssignment,
  auditModel = ExternalCampaignAssignmentAudit,
  clinicModel = Clinica,
  accountScopeResolver = findAssociationAccountScope,
  sequelize = db.sequelize,
  now = () => new Date(),
}) {
  let result = {
    assignment: null,
    idempotent: false,
    notFound: false,
    scopeConflict: false,
    accountScopeForbidden: false,
    groupScopeChanged: false,
  };
  await sequelize.transaction(async (transaction) => {
    const groupClinics = await clinicModel.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica', 'nombre_clinica', 'estado_clinica'],
      raw: true,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const groupClinicIds = new Set(groupClinics.map((clinic) => Number(clinic.id_clinica)));
    if (!groupClinicIds.size) {
      result = { ...result, groupScopeChanged: true };
      return;
    }
    const accountScope = await accountScopeResolver({
      groupId,
      provider,
      accountId: customerId,
      transaction,
      lock: true,
    });
    if (!accountScope) {
      result = { ...result, accountScopeForbidden: true };
      return;
    }
    const assignment = await assignmentModel.findOne({
      where: {
        provider,
        customer_id: customerId,
        campaign_id: campaignId,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!assignment) {
      result = { ...result, notFound: true };
      return;
    }
    if (!assignmentBelongsToGroup(assignment, groupId, groupClinicIds)) {
      result = { ...result, scopeConflict: true };
      return;
    }
    if (assignment.status === 'archived') {
      result = { ...result, assignment, idempotent: true };
      return;
    }
    const before = typeof assignment.get === 'function'
      ? assignment.get({ plain: true })
      : { ...assignment };
    const fromVersion = Math.max(1, Number(before.version) || 1);
    const archiveValues = {
      status: 'archived',
      archive_reason: reason,
      archived_by_user_id: userId,
      archived_at: now(),
      version: fromVersion + 1,
    };
    await assignment.update(archiveValues, { transaction });
    const after = typeof assignment.get === 'function'
      ? assignment.get({ plain: true })
      : assignment;
    await appendAssignmentAudit({
      auditModel,
      assignmentId: after.id,
      eventType: AUDIT_EVENT_TYPES.ARCHIVED,
      actorUserId: userId,
      fromVersion,
      toVersion: fromVersion + 1,
      reason,
      changes: buildAssignmentChanges(before, after, ASSIGNMENT_REVIEW_FIELDS),
      transaction,
    });
    result = { ...result, assignment };
  });
  return result;
}

function explicitTrue(value) {
  return value === true || String(value || '').trim().toLowerCase() === 'true';
}

function publishingGateEvidence(input, prepaymentVerified) {
  const source = safeObject(input?.gate_evidence, safeObject(input));
  return Object.fromEntries(REQUIRED_GATE_EVIDENCE.map((gate) => [
    gate,
    gate === 'prepayment_verified' ? prepaymentVerified === true : explicitTrue(source[gate]),
  ]));
}

async function verifiedPrepaymentForCampaign(row) {
  const funding = row?.funding || null;
  if (!funding) return false;
  const entries = await ManagedCampaignLedgerEntry.findAll({
    where: { funding_account_id: funding.id, entry_type: 'topup' },
    attributes: ['metadata'],
    raw: true,
  });
  return hasVerifiedPrepaymentEntries(entries);
}

async function managedCampaignPublishingAccountAuthorization(row) {
  const scopeInput = managedCampaignPublishingAccountScopeInput(row);
  if (!scopeInput.provider || !scopeInput.accountId
    || (!scopeInput.groupId && !scopeInput.clinicId)) {
    return null;
  }
  return findManagedCampaignAssociationAccountScope(scopeInput);
}

async function managedLaunchGateReasons(row, userId) {
  const funding = await ManagedCampaignFundingAccount.findOne({
    where: { managed_campaign_id: row.id },
    raw: true,
  });
  const prepaymentVerified = await verifiedPrepaymentForCampaign({ funding });
  const review = safeObject(row.review_config);
  const policy = safeObject(row.policy_readiness);
  const tracking = safeObject(row.tracking_plan);
  const creative = safeObject(row.creative_config);
  const policyReady = ['ready', 'configured', 'approved'].includes(String(policy.status || '').toLowerCase());
  const trackingReady = ['ready', 'configured'].includes(String(tracking.status || '').toLowerCase())
    || tracking.conversion_actions_ready === true;
  const clientApproved = review.client_approval_required !== true || !!review.client_approved_at;
  const plain = typeof row?.get === 'function' ? row.get({ plain: true }) : row;
  const accountAuthorization = await managedCampaignPublishingAccountAuthorization(row);
  const plan = buildManagedCampaignPublishingPlan({
    campaign: {
      ...plain,
      funding,
      status: 'approved_to_launch',
      approved_at: row.approved_at || new Date(),
      approved_by_user_id: row.approved_by_user_id || userId,
    },
    gateEvidence: {
      prepayment_verified: prepaymentVerified,
      budget_approved: clientApproved,
      policy_reviewed: policyReady,
      tracking_verified: trackingReady,
      creative_rights_confirmed: creative.rights_confirmed === true,
    },
    accountAuthorization,
  });
  return plan.readiness.blockers.map((item) => item.message);
}

function publishingAuditDto(row, { includePlan = true } = {}) {
  const plain = typeof row?.get === 'function' ? row.get({ plain: true }) : row;
  if (!plain) return null;
  return {
    id: plain.id,
    managed_campaign_id: plain.managed_campaign_id,
    plan_id: plain.plan_id,
    plan_hash: plain.plan_hash,
    campaign_version: Number(plain.campaign_version),
    provider: plain.provider,
    family: plain.family,
    mode: plain.mode,
    readiness_status: plain.readiness_status,
    blocker_count: Number(plain.blocker_count || 0),
    warning_count: Number(plain.warning_count || 0),
    gate_evidence: safeObject(plain.gate_evidence),
    idempotency_key: plain.idempotency_key,
    requested_by_user_id: Number(plain.requested_by_user_id),
    provider_call_performed: plain.provider_call_performed === true,
    created_at: plain.created_at,
    ...(includePlan ? { plan_snapshot: safeObject(plain.plan_snapshot) } : {}),
  };
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function words(value) {
  return normalizeText(value).split(' ').filter(Boolean);
}

function levenshtein(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left) return right.length;
  if (!right) return left.length;
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      previous = current;
    }
  }
  return row[right.length];
}

function clinicAliases(clinicName) {
  const normalized = normalizeText(clinicName);
  const tokens = words(clinicName).filter((token) => !STOP_WORDS.has(token));
  const short = tokens.join(' ');
  return Array.from(new Set([normalized, short, ...tokens.filter((token) => token.length >= 4)].filter(Boolean)));
}

function scoreClinicMatch(campaignName, clinic) {
  const normalizedCampaign = normalizeText(campaignName);
  const aliases = clinicAliases(clinic.nombre_clinica);
  const normalizedClinic = normalizeText(clinic.nombre_clinica);
  const shortAlias = aliases.find((alias) => alias !== normalizedClinic && alias.includes(' '))
    || aliases.find((alias) => alias !== normalizedClinic)
    || normalizedClinic;

  if (normalizedCampaign.includes(normalizedClinic)) {
    return { score: 1, kind: 'exact', explanation: `Contiene “${clinic.nombre_clinica}”` };
  }
  if (shortAlias && shortAlias.length >= 4 && normalizedCampaign.includes(shortAlias)) {
    return { score: 0.97, kind: 'alias', explanation: `Contiene el alias “${shortAlias}”` };
  }

  const campaignWords = words(campaignName);
  const clinicWords = words(shortAlias).filter((token) => token.length >= 4);
  if (!clinicWords.length || !campaignWords.length) {
    return { score: 0, kind: 'fuzzy', explanation: 'Sin términos comparables' };
  }

  const similarities = clinicWords.map((clinicWord) => {
    let best = 0;
    let bestWord = null;
    for (const campaignWord of campaignWords) {
      const maxLength = Math.max(clinicWord.length, campaignWord.length);
      const similarity = maxLength ? 1 - (levenshtein(clinicWord, campaignWord) / maxLength) : 0;
      if (similarity > best) {
        best = similarity;
        bestWord = campaignWord;
      }
    }
    return { clinicWord, campaignWord: bestWord, similarity: best };
  });
  const score = similarities.reduce((sum, item) => sum + item.similarity, 0) / similarities.length;
  const explanation = similarities
    .filter((item) => item.similarity >= 0.7)
    .map((item) => `${item.clinicWord}≈${item.campaignWord}`)
    .join(', ');
  return {
    score: score >= 0.7 ? Math.min(0.94, score) : score * 0.75,
    kind: 'fuzzy',
    explanation: explanation || 'Coincidencia débil',
  };
}

function commissionFor(amount, type, value) {
  const gross = Math.max(0, money(amount));
  const normalizedType = type === 'fixed' ? 'fixed' : 'percentage';
  const normalizedValue = Math.max(0, Number(value) || 0);
  const raw = normalizedType === 'fixed' ? normalizedValue : gross * normalizedValue / 100;
  return {
    type: normalizedType,
    value: normalizedValue,
    amount: money(clamp(raw, 0, gross)),
  };
}

function fundingPublicDto(funding, leads = 0) {
  if (!funding) return null;
  const gross = money(funding.client_gross_funded);
  const net = money(funding.media_budget_net);
  const spend = money(funding.media_spend);
  const consumedRatio = net > 0 ? clamp(spend / net, 0, 1) : 0;
  const clientConsumed = money(gross * consumedRatio);
  const leadCount = Math.max(0, Number(leads) || 0);
  return {
    currency: funding.currency,
    status: funding.status,
    total_paid: gross,
    total_consumed: clientConsumed,
    available: money(Math.max(0, gross - clientConsumed)),
    leads: leadCount,
    cpl: leadCount > 0 ? money(clientConsumed / leadCount) : null,
  };
}

function fundingAdminDto(funding) {
  if (!funding) return null;
  return {
    id: funding.id,
    currency: funding.currency,
    status: funding.status,
    client_gross_funded: money(funding.client_gross_funded),
    commission_type: funding.commission_type,
    commission_value: Number(funding.commission_value) || 0,
    commission_amount: money(funding.commission_amount),
    media_budget_net: money(funding.media_budget_net),
    media_spend: money(funding.media_spend),
    reserved_amount: money(funding.reserved_amount),
    available_amount: money(funding.available_amount),
    provisional_margin: money(funding.commission_amount),
    realised_margin: null,
    margin_status: 'provisional_bank_costs_pending',
    terms_version: funding.terms_version,
  };
}

function managedCampaignDisplayName(value) {
  const name = cleanString(value, 255);
  return name
    ? name.replace(/\s*\(\s*observaci[oó]n\s*\)\s*$/iu, '').trim()
    : null;
}

function campaignAdminDto(row) {
  const plain = typeof row?.get === 'function' ? row.get({ plain: true }) : row;
  const funding = plain?.funding || null;
  const assignee = operatorSummaryDto(plain?.assignee);
  return {
    ...plain,
    name: managedCampaignDisplayName(plain?.name),
    assignee,
    responsible_name: assignee?.display_name || null,
    funding: fundingAdminDto(funding),
    client_finance_preview: fundingPublicDto(funding, plain?.budget_config?.leads || 0),
  };
}

async function listCampaignRows(where = {}) {
  return ManagedCampaign.findAll({
    where,
    include: [
      { model: Clinica, as: 'clinic', attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'], required: false },
      { model: Usuario, as: 'assignee', attributes: ['id_usuario', 'nombre', 'apellidos'], required: false },
      { model: ManagedCampaignFundingAccount, as: 'funding', required: false },
    ],
    order: [['updated_at', 'DESC']],
  });
}

async function campaignInventoryRows(customerId, provider = 'google_ads') {
  const inventoryRows = ExternalCampaignInventory
    ? await ExternalCampaignInventory.findAll({
        where: { provider, customer_id: customerId },
        raw: true,
        order: [['campaign_name', 'ASC']],
      })
    : [];
  if (inventoryRows.length || provider !== 'google_ads' || !GoogleAdsInsightsDaily) {
    return inventoryRows;
  }

  const rows = await GoogleAdsInsightsDaily.findAll({
    where: { customerId },
    attributes: [
      ['campaignId', 'campaign_id'],
      ['campaignName', 'campaign_name'],
      ['campaignStatus', 'status'],
      [fn('MAX', col('date')), 'last_seen_at'],
      [fn('SUM', col('costMicros')), 'cost_micros'],
      [fn('SUM', col('clicks')), 'clicks'],
      [fn('SUM', col('conversions')), 'conversions'],
    ],
    group: ['campaignId', 'campaignName', 'campaignStatus'],
    raw: true,
  });
  return rows.map((row) => ({
    id: null,
    provider: 'google_ads',
    customer_id: customerId,
    campaign_id: String(row.campaign_id),
    campaign_name: row.campaign_name,
    status: row.status,
    channel_type: null,
    latest_metrics: {
      spend: money((Number(row.cost_micros) || 0) / 1000000),
      clicks: Number(row.clicks) || 0,
      conversions: Number(row.conversions) || 0,
    },
    last_seen_at: row.last_seen_at,
    source: 'google_ads_daily_cache',
  }));
}

exports.getDashboard = asyncHandler(async (req, res) => {
  if (!assertOperator(req, res)) return;
  const campaigns = await listCampaignRows();
  const bankUnmatched = await ManagedCampaignBankTransaction.count({ where: { status: { [Op.in]: ['unmatched', 'partially_matched'] } } });
  const assignments = await ExternalCampaignAssignment.count({ where: { status: 'active' } });
  const totals = campaigns.reduce((acc, row) => {
    const funding = row.funding;
    acc.client_gross += money(funding?.client_gross_funded);
    acc.media_budget += money(funding?.media_budget_net);
    acc.media_spend += money(funding?.media_spend);
    acc.commission += money(funding?.commission_amount);
    return acc;
  }, { client_gross: 0, media_budget: 0, media_spend: 0, commission: 0 });

  res.json({
    success: true,
    summary: {
      total: campaigns.length,
      attention: campaigns.filter((row) => ['pending_admin_review', 'blocked', 'changes_requested'].includes(row.status)
        || !!String(row.operational_blocker || '').trim()).length,
      active: campaigns.filter((row) => row.status === 'active').length,
      observe: campaigns.filter((row) => row.operation_mode === 'observe').length,
      unassigned: campaigns.filter((row) => !row.assigned_to_user_id).length,
      operational_blockers: campaigns.filter((row) => !!String(row.operational_blocker || '').trim()).length,
      unmatched_bank_transactions: bankUnmatched,
      active_assignments: assignments,
      ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, money(value)])),
      provisional_margin: money(totals.commission),
      realised_margin: null,
      margin_status: 'provisional_bank_costs_pending',
      bank_difference: null,
    },
    campaigns: campaigns.map(campaignAdminDto),
  });
});

exports.listCampaigns = asyncHandler(async (req, res) => {
  if (!assertOperator(req, res)) return;
  const where = {};
  const clinicId = positiveInt(req.query?.clinic_id);
  const groupId = positiveInt(req.query?.group_id);
  const status = cleanString(req.query?.status, 64);
  if (clinicId) where.clinica_id = clinicId;
  if (groupId) where.grupo_clinica_id = groupId;
  if (status && MANAGED_STATUSES.has(status)) where.status = status;
  const rows = await listCampaignRows(where);
  res.json({ success: true, items: rows.map(campaignAdminDto) });
});

exports.getCampaign = asyncHandler(async (req, res) => {
  if (!assertOperator(req, res)) return;
  const row = (await listCampaignRows({ id: req.params.id }))[0];
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  const ledger = row.funding
    ? await ManagedCampaignLedgerEntry.findAll({ where: { funding_account_id: row.funding.id }, order: [['occurred_at', 'DESC'], ['created_at', 'DESC']], raw: true })
    : [];
  const spend = await ManagedCampaignSpendSnapshot.findAll({ where: { managed_campaign_id: row.id }, order: [['spend_date', 'DESC']], raw: true });
  return res.json({ success: true, campaign: campaignAdminDto(row), ledger, spend });
});

exports.getPublishingPlan = asyncHandler(async (req, res) => {
  if (!assertOperator(req, res)) return;
  const row = (await listCampaignRows({ id: req.params.id }))[0];
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  const prepaymentVerified = await verifiedPrepaymentForCampaign(row);
  const gateEvidence = publishingGateEvidence(req.query, prepaymentVerified);
  const accountAuthorization = await managedCampaignPublishingAccountAuthorization(row);
  const plan = buildManagedCampaignPublishingPlan({ campaign: row, gateEvidence, accountAuthorization });
  res.set('Cache-Control', 'no-store');
  return res.json({
    success: true,
    dry_run: true,
    audit_persisted: false,
    external_mutation_performed: false,
    execute_available: false,
    plan,
  });
});

exports.createPublishingDryRun = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  if (req.body?.confirm_dry_run !== true) {
    return res.status(400).json({
      success: false,
      error: 'dry_run_confirmation_required',
      message: 'confirm_dry_run=true es obligatorio; esta ruta nunca publica en proveedores.',
    });
  }
  const idempotencyKey = cleanString(req.body?.idempotency_key, 191);
  if (!idempotencyKey) {
    return res.status(400).json({ success: false, error: 'idempotency_key_required' });
  }
  const expectedPlanHash = cleanString(req.body?.expected_plan_hash, 64);
  if (!expectedPlanHash || !/^[a-f0-9]{64}$/i.test(expectedPlanHash)) {
    return res.status(400).json({
      success: false,
      error: 'expected_plan_hash_required',
      message: 'Calcula y confirma el plan mostrado antes de guardar la simulación.',
    });
  }
  const row = (await listCampaignRows({ id: req.params.id }))[0];
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });

  const prepaymentVerified = await verifiedPrepaymentForCampaign(row);
  const gateEvidence = publishingGateEvidence(req.body, prepaymentVerified);
  const accountAuthorization = await managedCampaignPublishingAccountAuthorization(row);
  const plan = buildManagedCampaignPublishingPlan({ campaign: row, gateEvidence, accountAuthorization });
  if (plan.plan_hash !== expectedPlanHash) {
    return res.status(409).json({
      success: false,
      error: 'publishing_plan_changed',
      message: 'La campaña, su saldo o las confirmaciones cambiaron. Recalcula el plan antes de auditarlo.',
      expected_plan_hash: expectedPlanHash,
      current_plan_hash: plan.plan_hash,
      current_plan: plan,
    });
  }
  const existing = await ManagedCampaignPublishingAudit.findOne({
    where: { managed_campaign_id: row.id, idempotency_key: idempotencyKey },
  });
  if (existing) {
    if (existing.plan_hash !== plan.plan_hash) {
      return res.status(409).json({
        success: false,
        error: 'idempotency_key_reused',
        message: 'La clave de idempotencia ya está asociada a otro plan de esta campaña.',
        existing_plan_hash: existing.plan_hash,
      });
    }
    return res.json({
      success: true,
      dry_run: true,
      idempotent: true,
      external_mutation_performed: false,
      execute_available: false,
      audit: publishingAuditDto(existing),
      plan,
    });
  }

  let audit;
  let created = true;
  try {
    audit = await ManagedCampaignPublishingAudit.create({
      id: crypto.randomUUID(),
      managed_campaign_id: row.id,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      campaign_version: Number(plan.campaign.version || 1),
      provider: plan.campaign.provider,
      family: plan.campaign.family,
      mode: 'dry_run',
      readiness_status: plan.readiness.ready ? 'ready' : 'blocked',
      blocker_count: plan.readiness.blockers.length,
      warning_count: plan.readiness.warnings.length,
      gate_evidence: plan.gate_evidence,
      plan_snapshot: plan,
      idempotency_key: idempotencyKey,
      requested_by_user_id: userId,
      provider_call_performed: false,
    });
  } catch (error) {
    const isUniqueCollision = error?.name === 'SequelizeUniqueConstraintError'
      || error?.original?.code === 'ER_DUP_ENTRY'
      || error?.parent?.code === 'ER_DUP_ENTRY';
    if (!isUniqueCollision) throw error;
    created = false;
    audit = await ManagedCampaignPublishingAudit.findOne({
      where: { managed_campaign_id: row.id, idempotency_key: idempotencyKey },
    });
    if (!audit || audit.plan_hash !== plan.plan_hash) {
      return res.status(409).json({ success: false, error: 'idempotency_key_reused' });
    }
  }

  return res.status(created ? 201 : 200).json({
    success: true,
    dry_run: true,
    idempotent: !created,
    external_mutation_performed: false,
    execute_available: false,
    audit: publishingAuditDto(audit),
    plan,
  });
});

exports.listPublishingAudits = asyncHandler(async (req, res) => {
  if (!assertOperator(req, res)) return;
  const campaign = await ManagedCampaign.findByPk(req.params.id, { attributes: ['id'], raw: true });
  if (!campaign) return res.status(404).json({ success: false, error: 'not_found' });
  const limit = Math.min(100, Math.max(1, positiveInt(req.query?.limit) || 25));
  const rows = await ManagedCampaignPublishingAudit.findAll({
    where: { managed_campaign_id: campaign.id },
    order: [['created_at', 'DESC']],
    limit,
  });
  res.set('Cache-Control', 'no-store');
  return res.json({
    success: true,
    dry_run_only: true,
    external_mutation_performed: false,
    items: rows.map((item) => publishingAuditDto(item)),
  });
});

exports.updateCoordination = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  let result;
  try {
    result = await updateManagedCampaignCoordination({
      campaignId: req.params.id,
      actorUserId: userId,
      allowedOperatorIds: operatorIds(),
      input: req.body,
      sequelize: db.sequelize,
      campaignModel: ManagedCampaign,
      auditModel: ManagedCampaignOperationAudit,
      userModel: Usuario,
    });
  } catch (error) {
    const status = error.httpStatus || 500;
    return res.status(status).json({
      success: false,
      error: error.code || 'coordination_update_failed',
      message: status >= 500
        ? 'No se pudo guardar la coordinación de la campaña.'
        : error.message,
      ...(error.currentVersion !== undefined ? { current_version: error.currentVersion } : {}),
    });
  }
  const row = (await listCampaignRows({ id: req.params.id }))[0];
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  return res.json({
    success: true,
    changed: result.changed,
    audit_id: result.audit?.id || null,
    campaign: campaignAdminDto(row),
  });
});

exports.listCoordinationAudits = asyncHandler(async (req, res) => {
  const userId = await requireActiveOperatorRequest(req, res);
  if (!userId) return;
  const campaign = await ManagedCampaign.findByPk(req.params.id, { attributes: ['id'], raw: true });
  if (!campaign) return res.status(404).json({ success: false, error: 'not_found' });
  const limit = Math.min(100, Math.max(1, positiveInt(req.query?.limit) || 30));
  const rows = await ManagedCampaignOperationAudit.findAll({
    where: { managed_campaign_id: campaign.id },
    include: [{
      model: Usuario,
      as: 'actor',
      attributes: ['id_usuario', 'nombre', 'apellidos'],
      required: false,
    }],
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
  });
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, items: rows.map(operationAuditDto) });
});

exports.createCampaign = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const requestedFields = new Set(Object.keys(safeObject(req.body)));
  if (COORDINATION_FIELDS.some((field) => requestedFields.has(field))) {
    return res.status(400).json({
      success: false,
      error: 'coordination_requires_dedicated_endpoint',
      message: 'Crea primero la campaña y usa después el endpoint auditado de coordinación.',
    });
  }
  const clinicId = positiveInt(req.body?.clinica_id);
  const provider = cleanString(req.body?.provider, 32);
  const family = cleanString(req.body?.family, 64);
  const name = cleanString(req.body?.name, 255);
  if (!clinicId || !provider || !PROVIDERS.has(provider) || !family || !FAMILIES.has(family) || !name) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'clinica_id, name, provider y family son obligatorios' });
  }
  if ((provider === 'google_ads') !== family.startsWith('google_')) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'La familia no corresponde al proveedor' });
  }
  const clinic = await Clinica.findByPk(clinicId, { attributes: ['id_clinica', 'grupoClinicaId'], raw: true });
  if (!clinic) return res.status(404).json({ success: false, error: 'clinic_not_found' });

  const budget = safeObject(req.body?.budget_config);
  const currency = (cleanString(budget.currency, 3) || 'EUR').toUpperCase();
  const commission = commissionFor(0, req.body?.commission_type, req.body?.commission_value);
  const campaignId = crypto.randomUUID();
  const fundingId = crypto.randomUUID();

  await db.sequelize.transaction(async (transaction) => {
    await ManagedCampaign.create({
      id: campaignId,
      strategy_campaign_id: positiveInt(req.body?.strategy_campaign_id),
      campaign_request_id: positiveInt(req.body?.campaign_request_id),
      objective_id: cleanString(req.body?.objective_id, 64) || 'new_patients',
      clinica_id: clinicId,
      grupo_clinica_id: clinic.grupoClinicaId || null,
      management_mode: 'autopilot',
      legacy_mode: cleanString(req.body?.legacy_mode, 32),
      operation_mode: req.body?.operation_mode === 'managed' ? 'managed' : 'observe',
      provider,
      family,
      status: 'draft',
      name,
      target_config: safeObject(req.body?.target_config),
      budget_config: { amount: money(budget.amount), currency, period: cleanString(budget.period, 16) || 'monthly' },
      schedule_config: safeObject(req.body?.schedule_config),
      destination_config: safeObject(req.body?.destination_config),
      audience_config: safeObject(req.body?.audience_config, { eligibility_status: 'warning' }),
      creative_config: safeObject(req.body?.creative_config),
      tracking_plan: safeObject(req.body?.tracking_plan, { status: 'pending' }),
      platform_refs: safeObject(req.body?.platform_refs),
      review_config: safeObject(req.body?.review_config, { client_approval_required: true, admin_approval_required: true }),
      policy_readiness: safeObject(req.body?.policy_readiness, { status: 'warning', reasons: ['pending_review'] }),
      created_by_user_id: userId,
      updated_by_user_id: userId,
    }, { transaction });
    await ManagedCampaignFundingAccount.create({
      id: fundingId,
      managed_campaign_id: campaignId,
      clinica_id: clinicId,
      grupo_clinica_id: clinic.grupoClinicaId || null,
      currency,
      commission_type: commission.type,
      commission_value: commission.value,
    }, { transaction });
  });

  const row = (await listCampaignRows({ id: campaignId }))[0];
  return res.status(201).json({ success: true, campaign: campaignAdminDto(row) });
});

exports.updateCampaign = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const requestedFields = new Set(Object.keys(safeObject(req.body)));
  if (COORDINATION_FIELDS.some((field) => requestedFields.has(field))) {
    return res.status(400).json({
      success: false,
      error: 'coordination_requires_dedicated_endpoint',
      message: 'Responsable, siguiente acción y bloqueo solo se editan en el endpoint auditado de coordinación.',
    });
  }
  const row = await ManagedCampaign.findByPk(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  if (['approved_to_launch', 'launching', 'active', 'completed', 'cancelled'].includes(row.status)) {
    return res.status(409).json({ success: false, error: 'immutable_live_spec', message: 'Pausa o crea una nueva versión antes de cambiar una campaña viva.' });
  }
  if (row.status === 'pending_client_review' && requestedFields.size > 0) {
    return res.status(409).json({
      success: false,
      error: 'proposal_locked_for_client_review',
      message: 'La propuesta está bloqueada mientras el cliente la revisa. Solicita cambios antes de editarla.',
    });
  }
  const clientMaterialFields = new Set([
    'name', 'provider', 'family', 'target_config', 'budget_config', 'schedule_config',
    'destination_config', 'audience_config', 'creative_config', 'review_config',
  ]);
  if (row.status === 'pending_admin_review'
    && Array.from(requestedFields).some((field) => clientMaterialFields.has(field))) {
    return res.status(409).json({
      success: false,
      error: 'client_reapproval_required',
      message: 'Pasa la campaña a Cambios solicitados antes de modificar contenido aprobado por el cliente.',
    });
  }
  if (['paused', 'blocked'].includes(row.status)
    && Array.from(requestedFields).some((field) => clientMaterialFields.has(field))) {
    return res.status(409).json({
      success: false,
      error: 'managed_revision_required',
      message: 'Devuelve la campaña a borrador o crea una nueva revisión antes de modificar contenido pausado o bloqueado.',
    });
  }
  const patch = {};
  const requestedProvider = cleanString(req.body?.provider, 32);
  const requestedFamily = cleanString(req.body?.family, 64);
  const nextProvider = requestedProvider || row.provider;
  const nextFamily = requestedFamily || row.family;
  if ((requestedProvider && !PROVIDERS.has(requestedProvider))
    || (requestedFamily && !FAMILIES.has(requestedFamily))
    || ((nextProvider === 'google_ads') !== String(nextFamily || '').startsWith('google_'))) {
    return res.status(400).json({ success: false, error: 'provider_family_mismatch' });
  }
  if (requestedProvider) patch.provider = requestedProvider;
  if (requestedFamily) patch.family = requestedFamily;
  for (const field of ['target_config', 'budget_config', 'schedule_config', 'destination_config', 'audience_config', 'creative_config', 'tracking_plan', 'platform_refs', 'review_config', 'policy_readiness']) {
    if (req.body?.[field] !== undefined) patch[field] = safeObject(req.body[field]);
  }
  if (patch.review_config) {
    patch.review_config = protectedReviewConfigPatch(row.review_config, patch.review_config);
  }
  if (patch.platform_refs) {
    patch.platform_refs = protectedPlatformRefsPatch(row.platform_refs, patch.platform_refs);
  }
  const destination = safeObject(patch.destination_config, safeObject(row.destination_config));
  const creative = safeObject(patch.creative_config, safeObject(row.creative_config));
  const destinationUrls = [
    destination.final_url,
    destination.effective_url,
    destination.landing_url,
    destination.url,
    ...(Array.isArray(destination.final_urls) ? destination.final_urls : []),
    ...(Array.isArray(destination.urls) ? destination.urls : []),
  ].filter((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  const urlCandidates = [
    ...destinationUrls.map((candidate) => ({ candidate, isPreview: false })),
    ...(creative.client_preview_url
      ? [{ candidate: creative.client_preview_url, isPreview: true }]
      : []),
  ];
  for (const { candidate, isPreview } of urlCandidates) {
    if (!safeHttpUrl(candidate, { requireHttps: isPreview })) {
      return res.status(400).json({
        success: false,
        error: 'invalid_http_url',
        message: isPreview
          ? 'La vista previa debe usar una URL https pública y sin credenciales.'
          : 'Los destinos deben usar una URL http(s) pública y sin credenciales.',
      });
    }
  }
  if (cleanString(req.body?.name, 255)) patch.name = cleanString(req.body.name, 255);
  if (!Object.keys(patch).length) {
    return res.status(400).json({
      success: false,
      error: 'campaign_update_fields_required',
      message: 'No hay campos editables para guardar.',
    });
  }
  patch.updated_by_user_id = userId;
  patch.version = Number(row.version || 1) + 1;
  const [updatedCount] = await ManagedCampaign.update(patch, {
    where: { id: row.id, status: row.status, version: row.version },
  });
  if (!updatedCount) {
    return res.status(409).json({
      success: false,
      error: 'update_conflict',
      message: 'La campaña cambió mientras editabas. Recarga antes de volver a guardar.',
    });
  }
  const updated = (await listCampaignRows({ id: row.id }))[0];
  return res.json({ success: true, campaign: campaignAdminDto(updated) });
});

exports.transitionCampaign = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const nextStatus = cleanString(req.body?.status, 64);
  const row = await ManagedCampaign.findByPk(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  if (!nextStatus || !MANAGED_STATUSES.has(nextStatus) || !STATUS_TRANSITIONS[row.status]?.has(nextStatus)) {
    return res.status(409).json({ success: false, error: 'invalid_transition', message: `${row.status} → ${nextStatus || '?'} no está permitido` });
  }
  if (nextStatus === 'pending_client_review') {
    const proposal = proposalReadiness(row);
    if (!proposal.ready) {
      return res.status(409).json({ success: false, error: 'proposal_gate_failed', reasons: proposal.blockers });
    }
  }
  if (nextStatus === 'pending_admin_review') {
    const review = safeObject(row.review_config);
    if (review.client_approval_required === true && !review.client_approved_at) {
      return res.status(409).json({
        success: false,
        error: 'client_approval_required',
        reasons: ['El cliente debe aprobar la propuesta antes de la revisión administrativa'],
      });
    }
  }
  if (['approved_to_launch', 'launching', 'active'].includes(nextStatus)) {
    const reasons = await managedLaunchGateReasons(row, userId);
    if (reasons.length) {
      return res.status(409).json({ success: false, error: 'launch_gate_failed', reasons });
    }
  }
  const currentReview = safeObject(row.review_config);
  const reviewPatch = nextStatus === 'pending_client_review'
    ? {
        ...currentReview,
        proposal_revision: Math.max(0, Math.trunc(Number(currentReview.proposal_revision) || 0)) + 1,
        client_approved_at: null,
        client_approved_by_user_id: null,
        client_next_action: 'Revisar y aprobar la propuesta preparada por ClinicaClick',
      }
    : nextStatus === 'changes_requested'
      ? {
          ...currentReview,
          client_approved_at: null,
          client_approved_by_user_id: null,
          client_next_action: 'El equipo de ClinicaClick está preparando una revisión de la propuesta',
        }
      : currentReview;
  const clearsAdminApproval = ['draft', 'pending_client_review', 'pending_admin_review', 'changes_requested', 'blocked'].includes(nextStatus);
  const [updated] = await ManagedCampaign.update({
    status: nextStatus,
    review_config: reviewPatch,
    approved_by_user_id: nextStatus === 'approved_to_launch' ? userId : (clearsAdminApproval ? null : row.approved_by_user_id),
    approved_at: nextStatus === 'approved_to_launch' ? new Date() : (clearsAdminApproval ? null : row.approved_at),
    updated_by_user_id: userId,
    version: Number(row.version || 1) + 1,
  }, {
    where: { id: row.id, status: row.status, version: row.version },
  });
  if (!updated) {
    return res.status(409).json({ success: false, error: 'transition_conflict', message: 'El estado cambió mientras se procesaba la transición.' });
  }
  // strategy_campaign_id/campaign_request_id identify the immutable Connect-only
  // benchmark. ManagedCampaign is the lifecycle source of truth: changing a
  // pilot must never pause, complete or rewrite the strategy it was compared to.
  return res.json({ success: true, campaign: campaignAdminDto((await listCampaignRows({ id: row.id }))[0]) });
});

exports.activateManagement = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const row = await ManagedCampaign.findByPk(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  const review = safeObject(row.review_config);
  if (row.status !== 'pending_admin_review'
    || (review.client_approval_required === true && !review.client_approved_at)) {
    return res.status(409).json({
      success: false,
      error: 'management_activation_state_invalid',
      message: 'Activa la gestión solo después de que el cliente apruebe la propuesta y pase a revisión interna.',
    });
  }
  const funding = await ManagedCampaignFundingAccount.findOne({ where: { managed_campaign_id: row.id } });
  const topups = funding
    ? await ManagedCampaignLedgerEntry.findAll({
        where: { funding_account_id: funding.id, entry_type: 'topup' },
        attributes: ['metadata'],
        raw: true,
      })
    : [];
  const hasVerifiedPrepayment = hasVerifiedPrepaymentEntries(topups);
  if (!funding || money(funding.available_amount) <= 0 || !hasVerifiedPrepayment) {
    return res.status(409).json({
      success: false,
      error: 'prepayment_required',
      message: 'Registra como verificado el cobro por adelantado antes de activar Piloto automático.',
    });
  }
  const [updated] = await ManagedCampaign.update({
    operation_mode: 'managed',
    updated_by_user_id: userId,
    version: Number(row.version || 1) + 1,
  }, {
    where: { id: row.id, status: 'pending_admin_review', version: row.version },
  });
  if (!updated) {
    return res.status(409).json({
      success: false,
      error: 'management_activation_conflict',
      message: 'La campaña cambió mientras se activaba la gestión. Recarga antes de reintentarlo.',
    });
  }
  return res.json({ success: true, campaign: campaignAdminDto((await listCampaignRows({ id: row.id }))[0]) });
});

exports.recordTopup = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const amount = money(req.body?.amount);
  const externalRef = cleanString(req.body?.external_ref, 191);
  const paymentVerified = req.body?.payment_verified === true;
  if (amount <= 0 || !externalRef || !paymentVerified) {
    return res.status(400).json({
      success: false,
      error: 'validation_error',
      message: 'amount, external_ref y payment_verified=true son obligatorios',
    });
  }
  let fundingId = null;
  let idempotentEntry = null;

  try {
    await db.sequelize.transaction(async (transaction) => {
      const funding = await ManagedCampaignFundingAccount.findOne({
        where: { managed_campaign_id: req.params.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!funding) {
        const error = new Error('No existe una cuenta de financiación para la campaña');
        error.httpStatus = 404;
        error.code = 'funding_not_found';
        throw error;
      }
      fundingId = funding.id;

      const existing = await ManagedCampaignLedgerEntry.findOne({
        where: { funding_account_id: funding.id, external_ref: externalRef, entry_type: 'topup' },
        transaction,
      });
      if (existing) {
        if (safeObject(existing.metadata).payment_verified !== true) {
          const error = new Error('La referencia ya existe pero no consta como cobro verificado.');
          error.httpStatus = 409;
          error.code = 'topup_reference_unverified';
          throw error;
        }
        idempotentEntry = existing.get({ plain: true });
        return;
      }

      const nextType = ['fixed', 'percentage'].includes(req.body?.commission_type)
        ? req.body.commission_type
        : funding.commission_type;
      const nextValue = req.body?.commission_value !== undefined
        ? Math.max(0, Number(req.body.commission_value) || 0)
        : Number(funding.commission_value || 0);
      const commission = commissionFor(amount, nextType, nextValue);
      const net = money(amount - commission.amount);
      const now = new Date();

      await ManagedCampaignLedgerEntry.create({
        id: crypto.randomUUID(), funding_account_id: funding.id, entry_type: 'topup', direction: 'credit', amount,
        currency: funding.currency, occurred_at: now, external_ref: externalRef,
        metadata: {
          source: cleanString(req.body?.source, 64) || 'manual',
          bank_transaction_id: cleanString(req.body?.bank_transaction_id, 36),
          payment_verified: true,
          payment_verified_at: now.toISOString(),
          payment_verified_by_user_id: userId,
        },
        created_by_user_id: userId,
      }, { transaction });
      if (commission.amount > 0) {
        await ManagedCampaignLedgerEntry.create({
          id: crypto.randomUUID(), funding_account_id: funding.id, entry_type: 'commission', direction: 'debit', amount: commission.amount,
          currency: funding.currency, occurred_at: now, external_ref: `${externalRef}:commission`,
          metadata: { hidden_from_client: true, commission_type: commission.type, commission_value: commission.value },
          created_by_user_id: userId,
        }, { transaction });
      }
      const gross = money(money(funding.client_gross_funded) + amount);
      const totalCommission = money(money(funding.commission_amount) + commission.amount);
      const mediaBudget = money(money(funding.media_budget_net) + net);
      const available = money(mediaBudget - money(funding.media_spend) - money(funding.reserved_amount));
      await funding.update({
        client_gross_funded: gross,
        commission_type: commission.type,
        commission_value: commission.value,
        commission_amount: totalCommission,
        media_budget_net: mediaBudget,
        available_amount: available,
        status: available > 0 ? 'funded' : 'depleted',
        terms_version: Number(funding.terms_version || 1) + 1,
      }, { transaction });
    });
  } catch (error) {
    if (error?.name === 'SequelizeUniqueConstraintError' && fundingId) {
      const existing = await ManagedCampaignLedgerEntry.findOne({
        where: { funding_account_id: fundingId, external_ref: externalRef, entry_type: 'topup' },
        raw: true,
      });
      if (existing && safeObject(existing.metadata).payment_verified === true) {
        const funding = await ManagedCampaignFundingAccount.findByPk(fundingId);
        return res.json({ success: true, idempotent: true, funding: fundingAdminDto(funding), ledger_entry: existing });
      }
    }
    if (error?.httpStatus) {
      return res.status(error.httpStatus).json({
        success: false,
        error: error.code || 'topup_failed',
        message: error.message,
      });
    }
    throw error;
  }

  const funding = await ManagedCampaignFundingAccount.findByPk(fundingId);
  if (idempotentEntry) {
    return res.json({ success: true, idempotent: true, funding: fundingAdminDto(funding), ledger_entry: idempotentEntry });
  }
  return res.status(201).json({ success: true, funding: fundingAdminDto(funding), client_view: fundingPublicDto(funding) });
});

exports.recordSpend = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const campaign = await ManagedCampaign.findByPk(req.params.id);
  if (!campaign) return res.status(404).json({ success: false, error: 'not_found' });
  const provider = cleanString(req.body?.provider, 32) || campaign.provider;
  const customerId = cleanCustomerId(req.body?.customer_id);
  const platformCampaignId = cleanString(req.body?.platform_campaign_id, 128);
  const spendDate = cleanString(req.body?.spend_date, 10);
  const amount = money(req.body?.amount);
  if (!PROVIDERS.has(provider) || !customerId || !platformCampaignId || !/^\d{4}-\d{2}-\d{2}$/.test(spendDate || '') || amount < 0) {
    return res.status(400).json({ success: false, error: 'validation_error' });
  }
  const where = { managed_campaign_id: campaign.id, provider, customer_id: customerId, platform_campaign_id: platformCampaignId, spend_date: spendDate };
  let funding = null;

  try {
    await db.sequelize.transaction(async (transaction) => {
      // The funding row is the per-campaign serialization point. Lock it before
      // reading the daily snapshot so concurrent retries cannot derive the same
      // delta and duplicate ledger movements.
      funding = await ManagedCampaignFundingAccount.findOne({
        where: { managed_campaign_id: campaign.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!funding) {
        const error = new Error('No existe una cuenta de financiación para la campaña');
        error.httpStatus = 404;
        error.code = 'funding_not_found';
        throw error;
      }

      const previous = await ManagedCampaignSpendSnapshot.findOne({
        where,
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const oldAmount = money(previous?.spend_amount);
      const capturedAt = new Date();
      if (previous) {
        await previous.update({
          spend_amount: amount,
          captured_at: capturedAt,
          source: cleanString(req.body?.source, 64) || previous.source,
        }, { transaction });
      } else {
        await ManagedCampaignSpendSnapshot.create({
          ...where,
          spend_amount: amount,
          currency: cleanString(req.body?.currency, 3) || 'EUR',
          source: cleanString(req.body?.source, 64) || 'provider_sync',
          captured_at: capturedAt,
        }, { transaction });
      }

      const total = await ManagedCampaignSpendSnapshot.sum('spend_amount', {
        where: { managed_campaign_id: campaign.id },
        transaction,
      });
      const nextSpend = money(total);
      const available = money(money(funding.media_budget_net) - nextSpend - money(funding.reserved_amount));
      await funding.update({
        media_spend: nextSpend,
        available_amount: Math.max(0, available),
        status: available <= 0 ? 'depleted' : (available <= money(funding.media_budget_net) * 0.2 ? 'low_balance' : 'funded'),
      }, { transaction });
      const delta = money(amount - oldAmount);
      if (delta !== 0) {
        await ManagedCampaignLedgerEntry.create({
          id: crypto.randomUUID(), funding_account_id: funding.id,
          entry_type: delta > 0 ? 'media_spend' : 'adjustment', direction: delta > 0 ? 'debit' : 'credit',
          amount: Math.abs(delta), currency: funding.currency, occurred_at: capturedAt,
          external_ref: `spend:${provider}:${spendDate}:${crypto.randomUUID()}`,
          metadata: { provider, customer_id: customerId, platform_campaign_id: platformCampaignId, spend_date: spendDate },
          created_by_user_id: userId,
        }, { transaction });
      }
    });
  } catch (error) {
    if (error?.httpStatus) {
      return res.status(error.httpStatus).json({
        success: false,
        error: error.code || 'spend_record_failed',
        message: error.message,
      });
    }
    throw error;
  }

  return res.json({ success: true, spend_date: spendDate, amount, funding: fundingAdminDto(funding) });
});

exports.getMatchingOptions = asyncHandler(async (req, res) => {
  if (!assertOperator(req, res)) return;
  const groups = await listAssociationOptions();
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, groups });
});

exports.listMatchingProposals = asyncHandler(async (req, res) => {
  if (!assertOperator(req, res)) return;
  const groupId = positiveInt(req.query?.group_id);
  const provider = cleanString(req.query?.provider, 32) || 'google_ads';
  const customerId = cleanCustomerId(req.query?.customer_id);
  if (!groupId || !PROVIDERS.has(provider) || !customerId) {
    return res.status(400).json({ success: false, error: 'group_id_provider_customer_required' });
  }
  if (!(await requireAssociationAccountScope(res, { groupId, provider, customerId }))) return;
  const clinics = await Clinica.findAll({
    where: { grupoClinicaId: groupId },
    attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId', 'estado_clinica'],
    raw: true,
    order: [['nombre_clinica', 'ASC']],
  });
  const eligibleClinics = clinics.filter((clinic) => isActiveClinic(clinic)
    && !/\btest\b/i.test(String(clinic.nombre_clinica || '')));
  const groupClinicIds = new Set(clinics.map((clinic) => Number(clinic.id_clinica)));
  const campaigns = await campaignInventoryRows(customerId, provider);
  const assignments = await ExternalCampaignAssignment.findAll({
    where: { provider, customer_id: customerId, status: { [Op.in]: ['active', 'archived'] } },
    raw: true,
  });
  const assignmentByCampaign = new Map(assignments.map((item) => [String(item.campaign_id), item]));

  const proposals = campaigns.map((campaign) => {
    const candidates = eligibleClinics
      .map((clinic) => ({ clinic, ...scoreClinicMatch(campaign.campaign_name, clinic) }))
      .sort((a, b) => b.score - a.score);
    const best = candidates[0] || null;
    const second = candidates[1] || null;
    const margin = best ? best.score - (second?.score || 0) : 0;
    const reviewedAssignment = assignmentByCampaign.get(String(campaign.campaign_id)) || null;
    const assignmentInScope = assignmentBelongsToGroup(
      reviewedAssignment,
      groupId,
      groupClinicIds
    );
    const scopeConflict = !!reviewedAssignment && !assignmentInScope;
    const existing = assignmentInScope && reviewedAssignment?.status === 'active' ? reviewedAssignment : null;
    const tombstoned = assignmentInScope && reviewedAssignment?.status === 'archived';
    return {
      provider,
      customer_id: customerId,
      inventory_id: campaign.id || null,
      campaign_id: String(campaign.campaign_id),
      campaign_name: campaign.campaign_name,
      status: campaign.status,
      channel_type: campaign.channel_type || null,
      latest_metrics: campaign.latest_metrics || null,
      last_seen_at: campaign.last_seen_at || null,
      source: campaign.source || null,
      existing_assignment: existing,
      assignment_scope_conflict: scopeConflict,
      suggested_clinic: !scopeConflict && !tombstoned && best && best.score >= 0.65 ? {
        id: best.clinic.id_clinica,
        name: best.clinic.nombre_clinica,
        score: Number(best.score.toFixed(4)),
        kind: best.kind,
        explanation: best.explanation,
      } : null,
      alternatives: scopeConflict || tombstoned ? [] : candidates.slice(1, 4).filter((item) => item.score >= 0.6).map((item) => ({
        id: item.clinic.id_clinica,
        name: item.clinic.nombre_clinica,
        score: Number(item.score.toFixed(4)),
      })),
      auto_eligible: !scopeConflict && !tombstoned && !!best && best.score >= 0.9 && margin >= 0.12,
      ambiguous: !scopeConflict && !tombstoned && !!best && best.score >= 0.65 && margin < 0.12,
      assignment_tombstone: tombstoned ? {
        reason: reviewedAssignment.archive_reason || null,
        archived_at: reviewedAssignment.archived_at || null,
      } : null,
    };
  });

  return res.json({
    success: true,
    scope: { group_id: groupId, provider, customer_id: customerId },
    clinics: eligibleClinics,
    summary: {
      campaigns: proposals.length,
      assigned: proposals.filter((item) => !!item.existing_assignment).length,
      proposed: proposals.filter((item) => !item.existing_assignment && !!item.suggested_clinic).length,
      auto_eligible: proposals.filter((item) => !item.existing_assignment && item.auto_eligible).length,
      ambiguous: proposals.filter((item) => item.ambiguous).length,
      unassigned: proposals.filter((item) => !item.assignment_scope_conflict && !item.existing_assignment && !item.suggested_clinic).length,
      scope_conflicts: proposals.filter((item) => item.assignment_scope_conflict).length,
    },
    proposals,
  });
});

exports.confirmMatching = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const groupId = positiveInt(req.body?.group_id);
  const provider = cleanString(req.body?.provider, 32) || 'google_ads';
  const customerId = cleanCustomerId(req.body?.customer_id);
  const items = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
  if (!groupId || !PROVIDERS.has(provider) || !customerId || !items.length) {
    return res.status(400).json({ success: false, error: 'assignments_required' });
  }
  if (!(await requireAssociationAccountScope(res, { groupId, provider, customerId }))) return;
  const inventory = await campaignInventoryRows(customerId, provider);
  const inventoryByCampaign = new Map(inventory.map((item) => [String(item.campaign_id), item]));
  const saved = [];
  try {
    await db.sequelize.transaction(async (transaction) => {
      const lockedClinics = await Clinica.findAll({
        where: { grupoClinicaId: groupId },
        attributes: ['id_clinica', 'nombre_clinica', 'estado_clinica'],
        raw: true,
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const groupClinicIds = new Set(lockedClinics.map((clinic) => Number(clinic.id_clinica)));
      const eligibleTargetClinicIds = new Set(lockedClinics
        .filter((clinic) => isActiveClinic(clinic)
          && !/\btest\b/i.test(String(clinic.nombre_clinica || '')))
        .map((clinic) => Number(clinic.id_clinica)));
      if (!eligibleTargetClinicIds.size) {
        const error = new Error('El grupo ya no contiene clínicas activas elegibles.');
        error.httpStatus = 409;
        error.code = 'matching_group_scope_changed';
        throw error;
      }
      const transactionScope = await findAssociationAccountScope({
        groupId,
        provider,
        accountId: customerId,
        transaction,
        lock: true,
      });
      if (!transactionScope) {
        const error = new Error('La autorización de la cuenta cambió antes de confirmar. Recarga las opciones.');
        error.httpStatus = 403;
        error.code = 'matching_account_scope_forbidden';
        throw error;
      }
      for (const item of items) {
        const campaignId = cleanString(item?.campaign_id, 128);
        const clinicId = positiveInt(item?.clinica_id);
        const source = inventoryByCampaign.get(String(campaignId));
        if (!campaignId || !clinicId || !eligibleTargetClinicIds.has(clinicId) || !source) {
          const error = new Error(`Asignación inválida para campaña ${campaignId || '?'}`);
          error.httpStatus = 400;
          error.code = 'matching_assignment_invalid';
          throw error;
        }
        const kind = MATCH_KINDS.has(item?.match_kind) ? item.match_kind : 'manual';
        const reviewedAt = new Date();
        const assignmentValues = {
          inventory_id: source.id || null,
          provider,
          customer_id: customerId,
          campaign_id: campaignId,
          campaign_name_snapshot: source.campaign_name || null,
          grupo_clinica_id: groupId,
          clinica_id: clinicId,
          match_kind: kind,
          match_confidence: item?.match_confidence !== undefined ? clamp(Number(item.match_confidence) || 0, 0, 1) : null,
          match_explanation: cleanString(item?.match_explanation, 512),
          status: 'active',
          ...assignmentReactivationAuditReset(),
          approved_by_user_id: userId,
          approved_at: reviewedAt,
        };
        const savedResult = await saveAssignmentWithinScope({
          assignmentModel: ExternalCampaignAssignment,
          values: assignmentValues,
          groupId,
          groupClinicIds,
          transaction,
          returnMetadata: true,
          prepareValues: (current, baseValues) => {
            const currentValues = current && typeof current.get === 'function'
              ? current.get({ plain: true })
              : current;
            if (currentValues?.campaign_request_id
              && Number(currentValues.clinica_id) !== Number(baseValues.clinica_id)) {
              const error = new Error('Desvincula primero el target de estrategia antes de mover la campaña a otra clínica.');
              error.httpStatus = 409;
              error.code = 'matching_target_clear_required';
              throw error;
            }
            const version = currentValues ? Math.max(1, Number(currentValues.version) || 1) + 1 : 1;
            return { ...baseValues, version };
          },
          isNoop: matchingConfirmationIsNoop,
        });
        const row = savedResult.row;
        if (savedResult.changed === false) {
          saved.push(row);
          continue;
        }
        const previous = savedResult.previous;
        const after = typeof row?.get === 'function' ? row.get({ plain: true }) : row;
        const fromVersion = previous ? Math.max(1, Number(previous.version) || 1) : 0;
        const toVersion = Math.max(1, Number(after?.version) || 1);
        const eventType = previous?.status === 'archived'
          ? AUDIT_EVENT_TYPES.REACTIVATED
          : AUDIT_EVENT_TYPES.CLINIC_ASSIGNED;
        await appendAssignmentAudit({
          auditModel: ExternalCampaignAssignmentAudit,
          assignmentId: after.id,
          eventType,
          actorUserId: userId,
          fromVersion,
          toVersion,
          changes: buildAssignmentChanges(previous || {}, after, ASSIGNMENT_REVIEW_FIELDS),
          transaction,
        });
        saved.push(row);
      }
    });
  } catch (error) {
    return res.status(error.httpStatus || 500).json({
      success: false,
      error: error.code || 'matching_confirmation_failed',
      message: error.message || 'No se pudieron confirmar las asociaciones'
    });
  }
  return res.json({ success: true, saved: saved.length });
});

exports.archiveMatching = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const groupId = positiveInt(req.body?.group_id);
  const provider = cleanString(req.body?.provider, 32);
  const customerId = cleanCustomerId(req.body?.customer_id);
  const campaignId = cleanString(req.body?.campaign_id, 128);
  const reason = cleanString(req.body?.reason, 1024);
  if (!groupId || !PROVIDERS.has(provider) || !customerId || !campaignId) {
    return res.status(400).json({ success: false, error: 'group_provider_customer_campaign_required' });
  }
  if (provider !== 'google_ads') {
    return res.status(409).json({
      success: false,
      error: 'archive_provider_not_supported',
      message: 'El tombstone de atribución automática está disponible solo para Google Ads por ahora.',
    });
  }
  if (!reason) {
    return res.status(400).json({ success: false, error: 'archive_reason_required' });
  }
  let result;
  try {
    result = await archiveMatchingAssignment({
      provider,
      customerId,
      campaignId,
      groupId,
      reason,
      userId,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'matching_archive_failed',
      message: error.message || 'No se pudo archivar la asociación',
    });
  }
  if (result.groupScopeChanged) {
    return res.status(409).json({
      success: false,
      error: 'matching_group_scope_changed',
      message: 'El grupo cambió antes de archivar. Recarga las opciones.',
    });
  }
  if (result.accountScopeForbidden) {
    return res.status(403).json({
      success: false,
      error: 'matching_account_scope_forbidden',
      message: 'La autorización de la cuenta cambió antes de archivar. Recarga las opciones.',
    });
  }
  if (result.notFound) {
    return res.status(404).json({ success: false, error: 'matching_assignment_not_found' });
  }
  if (result.scopeConflict) {
    return res.status(409).json({
      success: false,
      error: 'matching_assignment_scope_conflict',
      message: 'La asignación pertenece a otro grupo y no puede archivarse desde este scope.',
    });
  }
  return res.json({
    success: true,
    status: 'archived',
    idempotent: result.idempotent,
    archived_at: result.assignment.archived_at || null,
  });
});

function matchingAssignmentId(value) {
  const normalized = String(value || '').trim();
  return /^\d{1,20}$/.test(normalized) ? normalized : null;
}

async function loadMatchingReadScope(res, source = {}) {
  const groupId = positiveInt(source.group_id);
  const provider = cleanString(source.provider, 32);
  const customerId = cleanCustomerId(source.customer_id);
  if (!groupId || !PROVIDERS.has(provider) || !customerId) {
    res.status(400).json({ success: false, error: 'group_provider_customer_required' });
    return null;
  }
  if (!(await requireAssociationAccountScope(res, { groupId, provider, customerId }))) return null;
  const clinics = await Clinica.findAll({
    where: { grupoClinicaId: groupId },
    attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId', 'estado_clinica'],
    raw: true,
  });
  return {
    groupId,
    provider,
    customerId,
    clinics,
    groupClinicIds: new Set(clinics.map((clinic) => Number(clinic.id_clinica))),
  };
}

exports.listMatchingIssues = asyncHandler(async (req, res) => {
  if (!assertOperator(req, res)) return;
  const scope = await loadMatchingReadScope(res, req.query);
  if (!scope) return;
  const assignments = await ExternalCampaignAssignment.findAll({
    where: {
      provider: scope.provider,
      customer_id: scope.customerId,
      status: 'active',
    },
    attributes: [
      'id', 'inventory_id', 'provider', 'customer_id', 'campaign_id',
      'campaign_name_snapshot', 'grupo_clinica_id', 'clinica_id',
      'match_kind', 'match_confidence', 'match_explanation', 'status',
      'archive_reason', 'archived_at', 'strategy_campaign_id', 'campaign_request_id',
      'target_kind', 'target_treatment_id', 'target_confidence',
      'target_explanation', 'target_updated_by_user_id', 'target_updated_at', 'version',
    ],
    raw: true,
    order: [['updated_at', 'DESC'], ['id', 'DESC']],
  });
  const scopedAssignments = assignments.filter((assignment) => (
    assignmentBelongsToGroup(assignment, scope.groupId, scope.groupClinicIds)
  ));
  const clinicById = new Map(scope.clinics.map((clinic) => [Number(clinic.id_clinica), clinic]));
  const catalogByClinic = new Map();
  for (const clinicId of Array.from(new Set(scopedAssignments.map((row) => Number(row.clinica_id))))) {
    const clinic = clinicById.get(clinicId);
    if (!clinic || !isActiveClinic(clinic) || /\btest\b/i.test(String(clinic.nombre_clinica || ''))) {
      catalogByClinic.set(clinicId, []);
      continue;
    }
    catalogByClinic.set(clinicId, await listValidStrategyTargetsForClinic({
      clinic,
      requestModel: CampaignRequest,
      campaignModel: Campaign,
      treatmentModel: Tratamiento,
    }));
  }
  const reviewedAssignments = scopedAssignments.map((assignment) => {
    const targetOptions = catalogByClinic.get(Number(assignment.clinica_id)) || [];
    const issue = matchingIssueForAssignment(assignment, targetOptions);
    return {
      assignment: assignmentDto(assignment),
      issue: issue ? { code: issue.code, message: issue.message } : null,
      target_options: targetOptions,
    };
  });
  const issues = reviewedAssignments
    .filter((item) => !!item.issue)
    .map((item) => ({ ...item.issue, assignment: item.assignment, target_options: item.target_options }));
  res.set('Cache-Control', 'no-store');
  return res.json({
    success: true,
    scope: {
      group_id: scope.groupId,
      provider: scope.provider,
      account_id: scope.customerId,
      customer_id: scope.customerId,
    },
    summary: {
      active_assignments: scopedAssignments.length,
      issues: issues.length,
      reviewed_targets: scopedAssignments.length - issues.length,
    },
    assignments: reviewedAssignments,
    items: issues,
  });
});

exports.updateMatchingTarget = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const assignmentId = matchingAssignmentId(req.params.id);
  if (!assignmentId) return res.status(400).json({ success: false, error: 'matching_assignment_id_invalid' });
  try {
    const result = await updateExternalAssignmentTarget({
      assignmentId,
      actorUserId: userId,
      input: req.body,
      sequelize: db.sequelize,
      assignmentModel: ExternalCampaignAssignment,
      auditModel: ExternalCampaignAssignmentAudit,
      inventoryModel: ExternalCampaignInventory,
      clinicModel: Clinica,
      requestModel: CampaignRequest,
      campaignModel: Campaign,
      treatmentModel: Tratamiento,
      accountScopeResolver: findAssociationAccountScope,
    });
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      changed: result.changed,
      version: result.version,
      assignment: assignmentDto(result.assignment),
      audit: result.audit ? assignmentAuditDto(result.audit) : null,
    });
  } catch (error) {
    return res.status(error.httpStatus || 500).json({
      success: false,
      error: error.code || 'matching_target_update_failed',
      message: error.message || 'No se pudo actualizar el target.',
      ...(error.currentVersion ? { current_version: error.currentVersion } : {}),
    });
  }
});

exports.clearMatchingTarget = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const assignmentId = matchingAssignmentId(req.params.id);
  if (!assignmentId) return res.status(400).json({ success: false, error: 'matching_assignment_id_invalid' });
  try {
    const result = await clearExternalAssignmentTarget({
      assignmentId,
      actorUserId: userId,
      input: req.body,
      sequelize: db.sequelize,
      assignmentModel: ExternalCampaignAssignment,
      auditModel: ExternalCampaignAssignmentAudit,
      clinicModel: Clinica,
      requestModel: CampaignRequest,
      accountScopeResolver: findAssociationAccountScope,
    });
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      changed: result.changed,
      version: result.version,
      assignment: assignmentDto(result.assignment),
      audit: result.audit ? assignmentAuditDto(result.audit) : null,
    });
  } catch (error) {
    return res.status(error.httpStatus || 500).json({
      success: false,
      error: error.code || 'matching_target_clear_failed',
      message: error.message || 'No se pudo limpiar el target.',
      ...(error.currentVersion ? { current_version: error.currentVersion } : {}),
    });
  }
});

exports.listMatchingAssignmentAudits = asyncHandler(async (req, res) => {
  if (!assertOperator(req, res)) return;
  const assignmentId = matchingAssignmentId(req.params.id);
  if (!assignmentId) return res.status(400).json({ success: false, error: 'matching_assignment_id_invalid' });
  const scope = await loadMatchingReadScope(res, req.query);
  if (!scope) return;
  const assignment = await ExternalCampaignAssignment.findByPk(assignmentId, {
    attributes: [
      'id', 'provider', 'customer_id', 'campaign_id', 'campaign_name_snapshot',
      'grupo_clinica_id', 'clinica_id', 'match_kind', 'match_confidence',
      'match_explanation', 'status', 'archive_reason', 'archived_at',
      'strategy_campaign_id', 'campaign_request_id', 'target_kind',
      'target_treatment_id', 'target_confidence', 'target_explanation',
      'target_updated_by_user_id', 'target_updated_at', 'version',
    ],
    raw: true,
  });
  if (!assignment) return res.status(404).json({ success: false, error: 'matching_assignment_not_found' });
  if (assignment.provider !== scope.provider
    || cleanCustomerId(assignment.customer_id) !== scope.customerId
    || !assignmentBelongsToGroup(assignment, scope.groupId, scope.groupClinicIds)) {
    return res.status(409).json({ success: false, error: 'matching_assignment_scope_conflict' });
  }
  const requestedLimit = Number.parseInt(String(req.query?.limit || '50'), 10);
  const limit = Math.min(100, Math.max(1, Number.isInteger(requestedLimit) ? requestedLimit : 50));
  const audits = await ExternalCampaignAssignmentAudit.findAll({
    where: { assignment_id: assignmentId },
    include: [{
      model: Usuario,
      as: 'actor',
      attributes: ['id_usuario', 'nombre', 'apellidos'],
      required: false,
    }],
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
  });
  res.set('Cache-Control', 'no-store');
  return res.json({
    success: true,
    assignment: assignmentDto(assignment),
    items: audits.map(assignmentAuditDto),
  });
});

exports.listBankTransactions = asyncHandler(async (req, res) => {
  if (!assertOperator(req, res)) return;
  const status = cleanString(req.query?.status, 32);
  const where = status ? { status } : {};
  const rows = await ManagedCampaignBankTransaction.findAll({ where, order: [['booked_at', 'DESC']], raw: true });
  return res.json({ success: true, items: rows });
});

exports.createBankTransaction = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const provider = cleanString(req.body?.bank_provider, 64);
  const reference = cleanString(req.body?.bank_reference, 191);
  const amount = money(req.body?.amount);
  const bookedAt = new Date(req.body?.booked_at || '');
  if (!provider || !reference || !Number.isFinite(bookedAt.getTime()) || amount === 0) {
    return res.status(400).json({ success: false, error: 'validation_error' });
  }
  const [row, created] = await ManagedCampaignBankTransaction.findOrCreate({
    where: { bank_provider: provider, bank_reference: reference },
    defaults: {
      id: crypto.randomUUID(),
      bank_account_ref: cleanString(req.body?.bank_account_ref, 191),
      booked_at: bookedAt,
      value_date: cleanString(req.body?.value_date, 10),
      amount,
      currency: (cleanString(req.body?.currency, 3) || 'EUR').toUpperCase(),
      description: cleanString(req.body?.description, 1024),
      metadata: safeObject(req.body?.metadata),
      created_by_user_id: userId,
    },
  });
  return res.status(created ? 201 : 200).json({ success: true, idempotent: !created, item: row });
});

exports.getReconciliationProposals = asyncHandler(async (req, res) => {
  if (!assertOperator(req, res)) return;
  const transactions = await ManagedCampaignBankTransaction.findAll({
    where: { status: { [Op.in]: ['unmatched', 'partially_matched'] } },
    order: [['booked_at', 'DESC']],
    raw: true,
  });
  const campaigns = await listCampaignRows();
  const proposals = transactions.map((bank) => {
    const candidates = campaigns
      .filter((campaign) => campaign.funding && campaign.funding.currency === bank.currency)
      .map((campaign) => {
        const funding = campaign.funding;
        const expected = money(funding.client_gross_funded);
        const diff = Math.abs(Math.abs(money(bank.amount)) - expected);
        const amountScore = expected > 0 ? clamp(1 - diff / expected, 0, 1) : 0;
        const text = normalizeText(`${bank.description || ''} ${bank.bank_reference || ''}`);
        const clinicName = normalizeText(campaign.clinic?.nombre_clinica || '');
        const nameScore = clinicName && text.includes(clinicName) ? 1 : 0;
        return {
          managed_campaign_id: campaign.id,
          funding_account_id: funding.id,
          clinic_name: campaign.clinic?.nombre_clinica || null,
          campaign_name: campaign.name,
          expected_amount: expected,
          confidence: Number((amountScore * 0.75 + nameScore * 0.25).toFixed(4)),
        };
      })
      .filter((item) => item.confidence >= 0.5)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
    return { bank_transaction: bank, candidates };
  });
  return res.json({ success: true, proposals });
});

exports.confirmReconciliation = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const bankId = cleanString(req.body?.bank_transaction_id, 36);
  const fundingId = cleanString(req.body?.funding_account_id, 36);
  const amount = Math.abs(money(req.body?.amount));
  if (!bankId || !fundingId || amount <= 0) {
    return res.status(400).json({ success: false, error: 'invalid_reconciliation' });
  }
  const ledgerEntryId = cleanString(req.body?.ledger_entry_id, 36);
  let result;
  try {
    await db.sequelize.transaction(async (transaction) => {
      const bank = await ManagedCampaignBankTransaction.findByPk(bankId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
      });
      const funding = await ManagedCampaignFundingAccount.findByPk(fundingId, { transaction });
      if (!bank || !funding || bank.currency !== funding.currency) {
        const error = new Error('Movimiento y cuenta de financiación no válidos o con distinta moneda');
        error.httpStatus = 400;
        throw error;
      }

      const duplicate = await ManagedCampaignReconciliationMatch.findOne({
        where: {
          bank_transaction_id: bank.id,
          funding_account_id: funding.id,
          amount,
          status: 'confirmed',
          ...(ledgerEntryId ? { ledger_entry_id: ledgerEntryId } : {}),
        },
        transaction,
      });
      if (duplicate) {
        result = { match: duplicate, bank_status: bank.status, idempotent: true };
        return;
      }

      const confirmedBefore = money(await ManagedCampaignReconciliationMatch.sum('amount', {
        where: { bank_transaction_id: bank.id, status: 'confirmed' },
        transaction,
      }));
      const bankAmount = Math.abs(money(bank.amount));
      const remaining = money(Math.max(0, bankAmount - confirmedBefore));
      if (amount > remaining) {
        const error = new Error(`El importe supera el saldo pendiente de conciliar (${remaining.toFixed(2)} ${bank.currency})`);
        error.httpStatus = 409;
        error.code = 'reconciliation_overflow';
        throw error;
      }

      const match = await ManagedCampaignReconciliationMatch.create({
        id: crypto.randomUUID(),
        bank_transaction_id: bank.id,
        funding_account_id: funding.id,
        ledger_entry_id: ledgerEntryId,
        amount,
        confidence: req.body?.confidence !== undefined ? clamp(Number(req.body.confidence) || 0, 0, 1) : null,
        method: 'manual',
        status: 'confirmed',
        notes: cleanString(req.body?.notes, 1024),
        created_by_user_id: userId,
      }, { transaction });
      const confirmedAfter = money(confirmedBefore + amount);
      const bankStatus = confirmedAfter >= bankAmount ? 'matched' : 'partially_matched';
      await bank.update({ status: bankStatus }, { transaction });
      result = { match, bank_status: bankStatus, idempotent: false };
    });
  } catch (error) {
    return res.status(error.httpStatus || 500).json({
      success: false,
      error: error.code || 'reconciliation_failed',
      message: error.message || 'No se pudo confirmar la conciliación'
    });
  }
  return res.status(result.idempotent ? 200 : 201).json({ success: true, ...result });
});

exports.listExternalInventory = asyncHandler(async (req, res) => {
  if (!assertOperator(req, res)) return;
  const groupId = positiveInt(req.query?.group_id);
  const provider = cleanString(req.query?.provider, 32) || 'google_ads';
  const customerId = cleanCustomerId(req.query?.customer_id);
  if (!groupId || !PROVIDERS.has(provider) || !customerId) {
    return res.status(400).json({ success: false, error: 'group_provider_customer_required' });
  }
  if (!(await requireAssociationAccountScope(res, { groupId, provider, customerId }))) return;
  return res.json({ success: true, items: await campaignInventoryRows(customerId, provider) });
});

exports.upsertExternalInventory = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const groupId = positiveInt(req.body?.group_id);
  const provider = cleanString(req.body?.provider, 32);
  const customerId = cleanCustomerId(req.body?.customer_id);
  const campaigns = Array.isArray(req.body?.campaigns) ? req.body.campaigns : [];
  if (!groupId || !PROVIDERS.has(provider) || !customerId || !campaigns.length) {
    return res.status(400).json({ success: false, error: 'inventory_required' });
  }
  const rows = [];
  for (const item of campaigns) {
    const campaignId = cleanString(item?.campaign_id, 128);
    if (!campaignId) continue;
    rows.push({
      provider,
      customer_id: customerId,
      account_name: cleanString(req.body?.account_name, 255),
      campaign_id: campaignId,
      campaign_name: cleanString(item?.campaign_name, 512),
      status: cleanString(item?.status, 64),
      channel_type: cleanString(item?.channel_type, 64),
      source: cleanString(req.body?.source, 64) || 'provider_sync',
      latest_metrics: safeObject(item?.latest_metrics),
      destination_detection: safeObject(item?.destination_detection, null),
      last_seen_at: item?.last_seen_at ? new Date(item.last_seen_at) : new Date(),
    });
  }
  let saved;
  try {
    saved = await upsertInventoryWithinScope({
      groupId,
      provider,
      accountId: customerId,
      rows,
    });
  } catch (error) {
    return res.status(error.httpStatus || 500).json({
      success: false,
      error: error.code || 'inventory_upsert_failed',
      message: error.message || 'No se pudo guardar el inventario externo.',
    });
  }
  return res.json({ success: true, saved });
});

// Funciones puras expuestas únicamente para pruebas de regresión financiera.
exports.__test = {
  commissionFor,
  fundingPublicDto,
  fundingAdminDto,
  hasVerifiedPrepaymentEntries,
  money,
  publishingAuditDto,
  publishingGateEvidence,
  archiveMatchingAssignment,
  assignmentReactivationAuditReset,
  proposalReadiness,
  protectedReviewConfigPatch,
  protectedPlatformRefsPatch,
  managedLaunchGateReasons,
  managedCampaignDisplayName,
};

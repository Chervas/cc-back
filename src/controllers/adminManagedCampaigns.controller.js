'use strict';

const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const { Op, fn, col, literal } = require('sequelize');
const db = require('../../models');
const { ADMIN_USER_IDS } = require('../lib/role-helpers');

const {
  Clinica,
  ExternalCampaignInventory,
  ExternalCampaignAssignment,
  GoogleAdsInsightsDaily,
  ManagedCampaign,
  ManagedCampaignFundingAccount,
  ManagedCampaignLedgerEntry,
  ManagedCampaignSpendSnapshot,
  ManagedCampaignBankTransaction,
  ManagedCampaignReconciliationMatch,
  Campaign,
  CampaignRequest,
} = db;

const MANAGED_STATUSES = new Set([
  'draft', 'pending_client_review', 'pending_admin_review', 'changes_requested',
  'approved_to_launch', 'launching', 'active', 'paused', 'blocked', 'completed', 'cancelled',
]);
const PROVIDERS = new Set(['google_ads', 'meta_ads']);
const FAMILIES = new Set(['google_search', 'google_pmax', 'google_smart_observe', 'meta_reach', 'meta_instant_form']);
const MATCH_KINDS = new Set(['exact', 'alias', 'fuzzy', 'manual']);
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
  const configured = String(process.env.CAMPAIGN_OPERATOR_USER_IDS || '')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return new Set([...ADMIN_USER_IDS, ...configured]);
}

function assertOperator(req, res) {
  const userId = Number.parseInt(String(req.userData?.userId || ''), 10);
  if (!operatorIds().has(userId)) {
    res.status(403).json({ success: false, error: 'campaign_operator_only' });
    return null;
  }
  return userId;
}

exports.getAccess = asyncHandler(async (req, res) => {
  const userId = Number.parseInt(String(req.userData?.userId || ''), 10);
  res.set('Cache-Control', 'no-store');
  return res.json({
    success: true,
    allowed: Number.isInteger(userId) && operatorIds().has(userId),
  });
});

function cleanString(value, max = 1024) {
  if (value === undefined || value === null) return null;
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

function hasVerifiedPrepaymentEntries(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .some((entry) => safeObject(entry?.metadata).payment_verified === true);
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

function campaignAdminDto(row) {
  const plain = typeof row?.get === 'function' ? row.get({ plain: true }) : row;
  const funding = plain?.funding || null;
  return {
    ...plain,
    funding: fundingAdminDto(funding),
    client_finance_preview: fundingPublicDto(funding, plain?.budget_config?.leads || 0),
  };
}

async function listCampaignRows(where = {}) {
  return ManagedCampaign.findAll({
    where,
    include: [
      { model: Clinica, as: 'clinic', attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'], required: false },
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
      attention: campaigns.filter((row) => ['pending_admin_review', 'blocked', 'changes_requested'].includes(row.status)).length,
      active: campaigns.filter((row) => row.status === 'active').length,
      observe: campaigns.filter((row) => row.operation_mode === 'observe').length,
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

exports.createCampaign = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
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
      assigned_to_user_id: positiveInt(req.body?.assigned_to_user_id),
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
  const row = await ManagedCampaign.findByPk(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  if (['launching', 'active', 'completed'].includes(row.status)) {
    return res.status(409).json({ success: false, error: 'immutable_live_spec', message: 'Pausa o crea una nueva versión antes de cambiar una campaña viva.' });
  }
  const patch = {};
  for (const field of ['target_config', 'budget_config', 'schedule_config', 'destination_config', 'audience_config', 'creative_config', 'tracking_plan', 'platform_refs', 'review_config', 'policy_readiness']) {
    if (req.body?.[field] !== undefined) patch[field] = safeObject(req.body[field]);
  }
  if (cleanString(req.body?.name, 255)) patch.name = cleanString(req.body.name, 255);
  if (positiveInt(req.body?.assigned_to_user_id)) patch.assigned_to_user_id = positiveInt(req.body.assigned_to_user_id);
  patch.updated_by_user_id = userId;
  patch.version = Number(row.version || 1) + 1;
  await row.update(patch);
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
  if (['approved_to_launch', 'launching', 'active'].includes(nextStatus)) {
    const funding = await ManagedCampaignFundingAccount.findOne({ where: { managed_campaign_id: row.id }, raw: true });
    const policy = safeObject(row.policy_readiness);
    const tracking = safeObject(row.tracking_plan);
    const reasons = [];
    if (row.operation_mode !== 'managed') reasons.push('La campaña sigue en observación');
    if (!funding || money(funding.available_amount) <= 0) reasons.push('No hay saldo publicitario neto disponible');
    if (policy.status === 'blocked') reasons.push(...(Array.isArray(policy.reasons) ? policy.reasons : ['Política bloqueada']));
    if (!['ready', 'configured'].includes(String(tracking.status || '').toLowerCase()) && tracking.conversion_actions_ready !== true) {
      reasons.push('Tracking y conversiones pendientes');
    }
    if (reasons.length) {
      return res.status(409).json({ success: false, error: 'launch_gate_failed', reasons });
    }
  }
  await row.update({
    status: nextStatus,
    approved_by_user_id: nextStatus === 'approved_to_launch' ? userId : row.approved_by_user_id,
    approved_at: nextStatus === 'approved_to_launch' ? new Date() : row.approved_at,
    updated_by_user_id: userId,
    version: Number(row.version || 1) + 1,
  });
  if (row.strategy_campaign_id && Campaign && CampaignRequest) {
    const legacyStatus = nextStatus === 'active'
      ? 'active'
      : nextStatus === 'paused'
        ? 'paused'
        : ['completed', 'cancelled'].includes(nextStatus)
          ? 'completed'
          : 'pending_approval';
    const requestRows = await CampaignRequest.findAll({
      where: { campaign_id: row.strategy_campaign_id },
      attributes: ['id', 'solicitud'],
    });
    for (const requestRow of requestRows) {
      const payload = safeObject(requestRow.solicitud);
      if (payload.kind !== 'marketing_strategy') continue;
      await requestRow.update({
        estado: legacyStatus === 'active'
          ? 'activa'
          : legacyStatus === 'paused'
            ? 'pausada'
            : legacyStatus === 'completed'
              ? 'finalizada'
              : 'pendiente_aceptacion',
        solicitud: { ...payload, status: legacyStatus, managed_status: nextStatus }
      });
    }
    const legacyCampaignPatch = {
      activa: nextStatus === 'active',
      fecha_fin: ['completed', 'cancelled'].includes(nextStatus) ? new Date() : null,
    };
    if (nextStatus === 'active') legacyCampaignPatch.fecha_inicio = new Date();
    await Campaign.update(legacyCampaignPatch, { where: { id: row.strategy_campaign_id } });
  }
  return res.json({ success: true, campaign: campaignAdminDto((await listCampaignRows({ id: row.id }))[0]) });
});

exports.activateManagement = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const row = await ManagedCampaign.findByPk(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
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
  await row.update({ operation_mode: 'managed', updated_by_user_id: userId, version: Number(row.version || 1) + 1 });
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

exports.listMatchingProposals = asyncHandler(async (req, res) => {
  if (!assertOperator(req, res)) return;
  const groupId = positiveInt(req.query?.group_id);
  const provider = cleanString(req.query?.provider, 32) || 'google_ads';
  const customerId = cleanCustomerId(req.query?.customer_id);
  if (!groupId || !PROVIDERS.has(provider) || !customerId) {
    return res.status(400).json({ success: false, error: 'group_id_provider_customer_required' });
  }
  const clinics = await Clinica.findAll({
    where: { grupoClinicaId: groupId, estado_clinica: true },
    attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'],
    raw: true,
    order: [['nombre_clinica', 'ASC']],
  });
  const eligibleClinics = clinics.filter((clinic) => !/\btest\b/i.test(String(clinic.nombre_clinica || '')));
  const campaigns = await campaignInventoryRows(customerId, provider);
  const assignments = await ExternalCampaignAssignment.findAll({ where: { provider, customer_id: customerId, status: 'active' }, raw: true });
  const assignmentByCampaign = new Map(assignments.map((item) => [String(item.campaign_id), item]));

  const proposals = campaigns.map((campaign) => {
    const candidates = eligibleClinics
      .map((clinic) => ({ clinic, ...scoreClinicMatch(campaign.campaign_name, clinic) }))
      .sort((a, b) => b.score - a.score);
    const best = candidates[0] || null;
    const second = candidates[1] || null;
    const margin = best ? best.score - (second?.score || 0) : 0;
    const existing = assignmentByCampaign.get(String(campaign.campaign_id)) || null;
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
      suggested_clinic: best && best.score >= 0.65 ? {
        id: best.clinic.id_clinica,
        name: best.clinic.nombre_clinica,
        score: Number(best.score.toFixed(4)),
        kind: best.kind,
        explanation: best.explanation,
      } : null,
      alternatives: candidates.slice(1, 4).filter((item) => item.score >= 0.6).map((item) => ({
        id: item.clinic.id_clinica,
        name: item.clinic.nombre_clinica,
        score: Number(item.score.toFixed(4)),
      })),
      auto_eligible: !!best && best.score >= 0.9 && margin >= 0.12,
      ambiguous: !!best && best.score >= 0.65 && margin < 0.12,
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
      unassigned: proposals.filter((item) => !item.existing_assignment && !item.suggested_clinic).length,
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
  const validClinics = await Clinica.findAll({ where: { grupoClinicaId: groupId, estado_clinica: true }, attributes: ['id_clinica', 'nombre_clinica'], raw: true });
  const clinicIds = new Set(validClinics.filter((clinic) => !/\btest\b/i.test(String(clinic.nombre_clinica || ''))).map((clinic) => Number(clinic.id_clinica)));
  const inventory = await campaignInventoryRows(customerId, provider);
  const inventoryByCampaign = new Map(inventory.map((item) => [String(item.campaign_id), item]));
  const saved = [];
  try {
    await db.sequelize.transaction(async (transaction) => {
      for (const item of items) {
        const campaignId = cleanString(item?.campaign_id, 128);
        const clinicId = positiveInt(item?.clinica_id);
        const source = inventoryByCampaign.get(String(campaignId));
        if (!campaignId || !clinicId || !clinicIds.has(clinicId) || !source) {
          const error = new Error(`Asignación inválida para campaña ${campaignId || '?'}`);
          error.httpStatus = 400;
          throw error;
        }
        const kind = MATCH_KINDS.has(item?.match_kind) ? item.match_kind : 'manual';
        const [row] = await ExternalCampaignAssignment.upsert({
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
          approved_by_user_id: userId,
          approved_at: new Date(),
        }, { transaction });
        saved.push(row);
      }
    });
  } catch (error) {
    return res.status(error.httpStatus || 500).json({
      success: false,
      error: 'matching_confirmation_failed',
      message: error.message || 'No se pudieron confirmar las asociaciones'
    });
  }
  return res.json({ success: true, saved: saved.length });
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
  const provider = cleanString(req.query?.provider, 32) || 'google_ads';
  const customerId = cleanCustomerId(req.query?.customer_id);
  if (!PROVIDERS.has(provider) || !customerId) return res.status(400).json({ success: false, error: 'provider_customer_required' });
  return res.json({ success: true, items: await campaignInventoryRows(customerId, provider) });
});

exports.upsertExternalInventory = asyncHandler(async (req, res) => {
  const userId = assertOperator(req, res);
  if (!userId) return;
  const provider = cleanString(req.body?.provider, 32);
  const customerId = cleanCustomerId(req.body?.customer_id);
  const campaigns = Array.isArray(req.body?.campaigns) ? req.body.campaigns : [];
  if (!PROVIDERS.has(provider) || !customerId || !campaigns.length) {
    return res.status(400).json({ success: false, error: 'inventory_required' });
  }
  let saved = 0;
  for (const item of campaigns) {
    const campaignId = cleanString(item?.campaign_id, 128);
    if (!campaignId) continue;
    await ExternalCampaignInventory.upsert({
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
    saved += 1;
  }
  return res.json({ success: true, saved });
});

// Funciones puras expuestas únicamente para pruebas de regresión financiera.
exports.__test = { commissionFor, fundingPublicDto, fundingAdminDto, hasVerifiedPrepaymentEntries, money };

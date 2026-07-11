'use strict';

const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');

const {
  Clinica,
  CampaignRequest,
  ManagedCampaign,
  ManagedCampaignFundingAccount,
} = db;

function userId(req) {
  const value = Number.parseInt(String(req.userData?.userId || ''), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseClinicIds(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return Array.from(new Set(values.map(positiveInt).filter(Boolean)));
}

function clean(value, max = 255) {
  const result = String(value ?? '').trim();
  return result ? result.slice(0, max) : null;
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function safeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

async function requireScope(req, res, clinicIds, access = 'read') {
  const allowed = await hasMarketingClinicScopeAccess({ userId: userId(req), clinicIds, access });
  if (allowed) return true;
  res.status(403).json({ success: false, error: 'scope_forbidden' });
  return false;
}

function managedReferenceError(message) {
  const error = new Error(message);
  error.code = 'managed_reference_scope_mismatch';
  error.httpStatus = 403;
  return error;
}

function isNewPatientsMarketingStrategyRequest(row, clinicId) {
  const payload = safeObject(row?.solicitud);
  return positiveInt(row?.clinica_id) === positiveInt(clinicId)
    && payload.kind === 'marketing_strategy'
    && String(payload.objective_id || '').trim().toLowerCase() === 'new_patients';
}

async function validateAutopilotReferences({
  clinicId,
  strategyCampaignId = null,
  campaignRequestId = null,
  transaction = null,
  campaignRequestModel = CampaignRequest,
} = {}) {
  let normalizedStrategyId = positiveInt(strategyCampaignId);
  const normalizedRequestId = positiveInt(campaignRequestId);
  let requestRow = null;

  if (normalizedRequestId) {
    requestRow = await campaignRequestModel.findByPk(normalizedRequestId, {
      attributes: ['id', 'clinica_id', 'campaign_id', 'solicitud'],
      transaction,
    });
    if (!requestRow || !isNewPatientsMarketingStrategyRequest(requestRow, clinicId)) {
      throw managedReferenceError('La solicitud de campaña no pertenece a una estrategia de nuevos pacientes de esta clínica');
    }
    const requestStrategyId = positiveInt(requestRow.campaign_id);
    if (!requestStrategyId || (normalizedStrategyId && normalizedStrategyId !== requestStrategyId)) {
      throw managedReferenceError('La solicitud y la estrategia indicadas no corresponden entre sí');
    }
    normalizedStrategyId = normalizedStrategyId || requestStrategyId;
  }

  if (normalizedStrategyId) {
    const strategyRows = await campaignRequestModel.findAll({
      where: { campaign_id: normalizedStrategyId, clinica_id: clinicId },
      attributes: ['id', 'clinica_id', 'campaign_id', 'solicitud'],
      transaction,
    });
    if (!strategyRows.some((row) => isNewPatientsMarketingStrategyRequest(row, clinicId))) {
      throw managedReferenceError('La estrategia indicada no pertenece a nuevos pacientes de esta clínica');
    }
  }

  return {
    strategyCampaignId: normalizedStrategyId,
    campaignRequestId: normalizedRequestId,
  };
}

function publicFunding(funding, leads = 0) {
  if (!funding) return null;
  const gross = money(funding.client_gross_funded);
  const net = money(funding.media_budget_net);
  const platformSpend = money(funding.media_spend);
  const consumedRatio = net > 0 ? Math.min(1, Math.max(0, platformSpend / net)) : 0;
  const consumed = money(gross * consumedRatio);
  const leadCount = Math.max(0, Number(leads) || 0);
  return {
    currency: funding.currency,
    status: funding.status,
    total_paid: gross,
    total_consumed: consumed,
    available: money(Math.max(0, gross - consumed)),
    leads: leadCount,
    cpl: leadCount > 0 ? money(consumed / leadCount) : null,
  };
}

function publicCampaign(row) {
  const plain = typeof row?.get === 'function' ? row.get({ plain: true }) : row;
  const funding = plain?.funding || null;
  return {
    id: plain.id,
    objective_id: plain.objective_id,
    clinica_id: plain.clinica_id,
    management_mode: 'autopilot',
    operation_mode: plain.operation_mode,
    provider: plain.provider,
    family: plain.family,
    status: plain.status,
    name: plain.name,
    target: plain.target_config,
    budget: plain.budget_config,
    schedule: plain.schedule_config,
    destination: plain.destination_config,
    creative_summary: {
      assets_ready: plain.creative_config?.assets_ready === true,
      preview_url: plain.creative_config?.client_preview_url || null,
    },
    review: {
      client_approval_required: plain.review_config?.client_approval_required === true,
      client_approved_at: plain.review_config?.client_approved_at || null,
      next_action: plain.review_config?.client_next_action || null,
    },
    policy_readiness: plain.policy_readiness,
    finance: publicFunding(funding, plain?.budget_config?.leads || 0),
    updated_at: plain.updated_at,
  };
}

async function loadRows(where) {
  return ManagedCampaign.findAll({
    where,
    include: [{ model: ManagedCampaignFundingAccount, as: 'funding', required: false }],
    order: [['updated_at', 'DESC']],
  });
}

exports.listClientCampaigns = asyncHandler(async (req, res) => {
  const clinicIds = parseClinicIds(req.query?.clinic_id ?? req.query?.clinic_ids);
  if (!clinicIds.length) return res.status(400).json({ success: false, error: 'clinic_scope_required' });
  if (!(await requireScope(req, res, clinicIds, 'read'))) return;
  const rows = await loadRows({ clinica_id: { [Op.in]: clinicIds }, status: { [Op.ne]: 'cancelled' } });
  return res.json({ success: true, items: rows.map(publicCampaign) });
});

exports.getClientCampaign = asyncHandler(async (req, res) => {
  const row = (await loadRows({ id: req.params.id }))[0];
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  if (!(await requireScope(req, res, [row.clinica_id], 'read'))) return;
  return res.json({ success: true, campaign: publicCampaign(row) });
});

exports.requestAutopilot = asyncHandler(async (req, res) => {
  const actorId = userId(req);
  const clinicId = positiveInt(req.body?.clinica_id);
  if (!actorId || !clinicId) return res.status(400).json({ success: false, error: 'clinic_id_required' });
  if (!(await requireScope(req, res, [clinicId], 'write'))) return;
  const provider = req.body?.provider === 'meta_ads' ? 'meta_ads' : 'google_ads';
  const family = provider === 'meta_ads'
    ? (req.body?.family === 'meta_instant_form' ? 'meta_instant_form' : 'meta_reach')
    : (['google_search', 'google_pmax', 'google_smart_observe'].includes(req.body?.family) ? req.body.family : 'google_smart_observe');
  const id = crypto.randomUUID();
  const fundingId = crypto.randomUUID();
  const budget = safeObject(req.body?.budget);
  let existingId = null;
  let clinic = null;

  try {
    await db.sequelize.transaction(async (transaction) => {
      clinic = await Clinica.findByPk(clinicId, {
        attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!clinic) {
        const error = new Error('Clínica no encontrada');
        error.code = 'clinic_not_found';
        error.httpStatus = 404;
        throw error;
      }

      const existing = await ManagedCampaign.findOne({
        where: {
          clinica_id: clinicId,
          objective_id: 'new_patients',
          status: { [Op.notIn]: ['completed', 'cancelled'] },
        },
        transaction,
      });
      if (existing) {
        existingId = existing.id;
        return;
      }

      const references = await validateAutopilotReferences({
        clinicId,
        strategyCampaignId: req.body?.strategy_campaign_id,
        campaignRequestId: req.body?.campaign_request_id,
        transaction,
      });
      const name = clean(req.body?.name) || `Piloto automático · ${clinic.nombre_clinica}`;

      await ManagedCampaign.create({
        id,
        strategy_campaign_id: references.strategyCampaignId,
        campaign_request_id: references.campaignRequestId,
        objective_id: 'new_patients',
        clinica_id: clinicId,
        grupo_clinica_id: clinic.grupoClinicaId || null,
        management_mode: 'autopilot',
        legacy_mode: clean(req.body?.legacy_mode, 32),
        operation_mode: 'observe',
        provider,
        family,
        status: 'draft',
        name,
        target_config: safeObject(req.body?.target),
        budget_config: {
          amount: money(budget.amount),
          currency: (clean(budget.currency, 3) || 'EUR').toUpperCase(),
          period: clean(budget.period, 16) || 'monthly',
          leads: null,
        },
        schedule_config: safeObject(req.body?.schedule),
        destination_config: safeObject(req.body?.destination),
        audience_config: { eligibility_status: 'warning', reasons: ['pending_internal_review'] },
        creative_config: { assets_ready: false },
        tracking_plan: { status: 'pending', conversion_actions_ready: false },
        platform_refs: {},
        review_config: {
          client_approval_required: true,
          admin_approval_required: true,
          requested_at: new Date().toISOString(),
          client_next_action: 'Esperar la propuesta del equipo ClinicaClick',
        },
        policy_readiness: { status: 'warning', reasons: ['pending_internal_review'] },
        created_by_user_id: actorId,
        updated_by_user_id: actorId,
      }, { transaction });
      await ManagedCampaignFundingAccount.create({
        id: fundingId,
        managed_campaign_id: id,
        clinica_id: clinicId,
        grupo_clinica_id: clinic.grupoClinicaId || null,
        currency: (clean(budget.currency, 3) || 'EUR').toUpperCase(),
        status: 'unfunded',
        commission_type: 'percentage',
        commission_value: 0,
      }, { transaction });
    });
  } catch (error) {
    if (error?.httpStatus) {
      return res.status(error.httpStatus).json({
        success: false,
        error: error.code || 'autopilot_request_failed',
        message: error.message,
      });
    }
    throw error;
  }

  if (existingId) {
    const existingRow = (await loadRows({ id: existingId }))[0];
    return res.status(409).json({ success: false, error: 'autopilot_request_exists', campaign: publicCampaign(existingRow) });
  }

  return res.status(201).json({ success: true, campaign: publicCampaign((await loadRows({ id }))[0]) });
});

exports.approveClientProposal = asyncHandler(async (req, res) => {
  const actorId = userId(req);
  const row = await ManagedCampaign.findByPk(req.params.id);
  if (!actorId || !row) return res.status(404).json({ success: false, error: 'not_found' });
  if (!(await requireScope(req, res, [row.clinica_id], 'write'))) return;
  if (row.status !== 'pending_client_review') {
    return res.status(409).json({ success: false, error: 'proposal_not_waiting_client' });
  }
  const review = {
    ...safeObject(row.review_config),
    client_approved_at: new Date().toISOString(),
    client_approved_by_user_id: actorId,
    client_next_action: 'Pendiente de revisión y preparación técnica por ClinicaClick',
  };
  await row.update({ status: 'pending_admin_review', review_config: review, updated_by_user_id: actorId, version: Number(row.version || 1) + 1 });
  return res.json({ success: true, campaign: publicCampaign((await loadRows({ id: row.id }))[0]) });
});

exports.__test = {
  isNewPatientsMarketingStrategyRequest,
  money,
  publicCampaign,
  publicFunding,
  validateAutopilotReferences,
};

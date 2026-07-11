'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');

const {
  ManagedCampaign,
  ManagedCampaignFundingAccount,
} = db;

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function safeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function paidChannelAllocations(channels, totalBudget) {
  const paid = (Array.isArray(channels) ? channels : [])
    .filter((item) => item?.enabled !== false && ['google_ads', 'meta_ads'].includes(String(item?.channel || '').trim()))
    .map((item) => ({
      provider: String(item.channel),
      weight: Math.max(0, Number(item.percentage) || 0),
    }));
  const unique = Array.from(new Map(paid.map((item) => [item.provider, item])).values());
  const weightTotal = unique.reduce((sum, item) => sum + item.weight, 0);
  return unique.map((item) => ({
    provider: item.provider,
    amount: money(totalBudget * (weightTotal > 0 ? item.weight / weightTotal : 1 / unique.length)),
  }));
}

function familyForProvider(provider) {
  return provider === 'meta_ads' ? 'meta_reach' : 'google_search';
}

function managedSpec({ payload, provider, amount, totalBudget }) {
  return {
    target_config: {
      promotion_type: payload.promotion_type || 'treatment',
      treatments: Array.isArray(payload.treatments) ? payload.treatments : [],
      area_medica_id: payload.area_medica_id || null,
      area_medica_nombre: payload.area_medica_nombre || null,
      geo: safeObject(payload.geo),
    },
    budget_config: {
      amount: money(amount),
      client_requested_total: money(totalBudget),
      currency: 'EUR',
      period: 'monthly',
      requires_prepayment: true,
      leads: null,
    },
    schedule_config: {},
    destination_config: safeObject(payload.destination),
    audience_config: { eligibility_status: 'warning', reasons: ['pending_internal_review'] },
    creative_config: { assets_ready: false },
    tracking_plan: {
      status: 'pending',
      automatic_conversion_setup: true,
      conversion_actions_ready: false,
      provider,
      requested_measurement: safeObject(payload.measurement),
    },
    platform_refs: {},
    review_config: {
      client_approval_required: true,
      admin_approval_required: true,
      requested_at: new Date().toISOString(),
      client_next_action: 'Esperar la propuesta del equipo ClinicaClick',
    },
    policy_readiness: { status: 'warning', reasons: ['pending_internal_review'] },
  };
}

async function provisionManagedCampaignsFromStrategy({
  strategyCampaign,
  campaignRequest,
  clinicId,
  groupId,
  userId,
  payload,
  budgetMonthly,
  channels,
  transaction,
}) {
  const allocations = paidChannelAllocations(channels, money(budgetMonthly));
  if (!allocations.length) {
    const error = new Error('Piloto automático requiere Google Ads o Meta Ads como canal de pago');
    error.code = 'MANAGED_PAID_CHANNEL_REQUIRED';
    throw error;
  }

  const ids = [];
  for (const allocation of allocations) {
    const provider = allocation.provider;
    const existing = await ManagedCampaign.findOne({
      where: {
        strategy_campaign_id: strategyCampaign.id,
        clinica_id: clinicId,
        provider,
        status: { [Op.ne]: 'cancelled' },
      },
      transaction,
    });
    if (existing) {
      ids.push(existing.id);
      continue;
    }

    const id = crypto.randomUUID();
    const name = `${strategyCampaign.nombre} · ${provider === 'meta_ads' ? 'Meta Ads' : 'Google Ads'}`;
    const spec = managedSpec({ payload, provider, amount: allocation.amount, totalBudget: budgetMonthly });
    await ManagedCampaign.create({
      id,
      strategy_campaign_id: strategyCampaign.id,
      campaign_request_id: campaignRequest?.id || null,
      objective_id: 'new_patients',
      clinica_id: clinicId,
      grupo_clinica_id: groupId || null,
      management_mode: 'autopilot',
      legacy_mode: 'managed_service',
      operation_mode: 'observe',
      provider,
      family: familyForProvider(provider),
      status: 'draft',
      name,
      ...spec,
      created_by_user_id: userId,
      updated_by_user_id: userId,
    }, { transaction });
    await ManagedCampaignFundingAccount.create({
      id: crypto.randomUUID(),
      managed_campaign_id: id,
      clinica_id: clinicId,
      grupo_clinica_id: groupId || null,
      currency: 'EUR',
      status: 'unfunded',
      commission_type: 'percentage',
      commission_value: 0,
    }, { transaction });
    ids.push(id);
  }
  return ids;
}

module.exports = {
  paidChannelAllocations,
  provisionManagedCampaignsFromStrategy,
};

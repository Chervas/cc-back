'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { performanceFixture } = require('./campaign_workspace_performance.fixture');
const { collectOptimizationEvidence } = require('../../../services/campaignWorkspaceOptimizationEvidence.service');
const { resolveOptimizationAuthorization, LIMITS } = require('../../../services/campaignWorkspaceOptimizationAuthorization.service');

function fixture(provider = 'google_ads') {
  const performance = performanceFixture(provider);
  const { state, reference } = performance;
  const setting = { id: '11111111-1111-4111-8111-111111111111', version: 4, scope_type: 'clinic', scope_id: 1,
    accounts: [{ provider, account_id: '20', campaign_ids: ['30'], include_future: false }], activation: {
      schema_version: 2, mode: 'optimize', status: 'active', optimization: {
        schema_version: 1, id: '22222222-2222-4222-8222-222222222222', status: 'active', authorized_by_user_id: 7,
        authorized_at: '2026-09-11T10:00:00Z', authorization: { schema_version: 1, clinic_ids: [1],
          limits: { ...LIMITS, actions: ['pause_underperforming_ads'], monthly_limit_cents: null, currency: 'EUR' }, campaigns: [{
            ...reference, clinic_id: 1, connection_id: 5, grant_fingerprint: 'a'.repeat(64), login_customer_id: null,
            targets: [{ action: 'pause_underperforming_ads', entity: 'ad', id: '60', group_id: '50', field: 'status',
              resource: provider === 'google_ads' ? 'customers/20/adGroupAds/50~60' : '60' }],
          }] },
      },
    } };
  const campaign = { ...reference, id: `${provider}:20:30`, clinicId: 1, assigned: true, paused: false,
    destination: 'lead_form', urls: [], destinationCheckedAt: state.now.toISOString() };
  Object.assign(state, { setting, workspaceCampaign: campaign, permitted: true, ownership: true, reception: true, checks: 0, tokenChecks: 0,
    grant: { fingerprint: 'a'.repeat(64), connection: { id: 5, accessToken: 'fixture-only-not-a-credential' }, loginCustomerId: null },
    leads: [], auditRows: [], leadQueries: [], identityQueries: [] });
  for (let index = 1; index <= 24; index++) {
    const adId = index <= 12 ? '60' : '61'; const nativeId = String(1000 + index);
    const lead = { id: index, clinica_id: 1, source: provider, channel: 'paid',
      source_detail: 'leadgen_form:80', google_ads_customer_id: provider === 'google_ads' ? '20' : null,
      google_ads_campaign_id: provider === 'google_ads' ? '30' : null,
      external_source: provider === 'google_ads' ? 'google_lead_form' : 'meta_leadgen',
      external_id: provider === 'google_ads' ? createHash('sha256').update(nativeId).digest('hex') : nativeId,
      created_at: `${performance.dates[index]}T10:00:00Z` };
    state.leads.push(lead);
    state.auditRows.push({ lead_intake_id: index, native_lead_id: nativeId, identity: {
      version: 1, verified_by: provider === 'google_ads' ? 'google_ads_api' : 'meta_graph', provider,
      clinic_id: 1, account_id: '20', campaign_id: '30', ad_id: adId, adgroup_id: '50', page_id: '90', form_id: '80',
    } });
  }
  const models = { CampaignWorkspaceSetting: { findByPk: async () => structuredClone(setting) },
    LeadIntake: { findAll: async query => { state.leadQueries.push(query); return structuredClone(state.leads); } },
    LeadAttributionAudit: { findAll: async query => { state.identityQueries.push(query); return structuredClone(state.auditRows); } } };
  const deps = { models, now: () => new Date(state.now), clock: () => state.clock,
    env: { CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true', CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED: 'true' },
    hasAccess: async input => { assert.equal(input.userId, 7); assert.equal(input.access, 'write'); return state.permitted; },
    resolveAuthorization: input => resolveOptimizationAuthorization({ ...input, resolveContext: async () => {
      state.checks++;
      if (state.onContext) await state.onContext();
      return { setting: structuredClone(setting), reference, campaign: structuredClone(campaign), grant: structuredClone(state.grant), latest: state.latest };
    }, checkOwnership: async () => {
      if (!state.ownership) throw Object.assign(Error('owned by managed plan'), { code: 'workspace_optimization_managed_conflict' });
    } }),
    loadInventory: async () => ({ selectedClinics: [{ id_clinica: 1 }], groups: [] }),
    loadReception: async () => {
      if (state.onReception) await state.onReception();
      return new Map([[campaign.id, { reception: { checked: true, ready: state.reception, state: state.reception ? 'verified' : 'pending_confirmation' } }]]);
    },
    ensureToken: async () => { state.tokenChecks++; if (state.onToken) await state.onToken(); return { accessToken: state.grant.connection.accessToken }; },
    googleRequest: async (method, path, options) => {
      assert.equal(method, 'POST'); assert.equal(path, 'customers/20/googleAds:search'); assert.equal(options.singleAttempt, true);
      return { results: await performance.options.read({ query: options.data.query }) };
    }, metaRead: performance.options.read,
  };
  const input = { settingId: setting.id, mandateId: setting.activation.optimization.id, reference };
  return { state, deps, input, performance, run: () => collectOptimizationEvidence(input, deps) };
}

function qualifiedFixture(provider = 'google_ads') {
  const f = fixture(provider); const lead = f.state.leads[0]; const audit = f.state.auditRows[0];
  f.state.leads = []; f.state.auditRows = [];
  for (const [day, date] of f.performance.dates.entries()) for (const [index, ad] of ['60', '61'].entries()) {
    const id = day * 2 + index + 1; const nativeId = String(1000 + id);
    f.state.leads.push({ ...lead, id, created_at: `${date}T10:00:00Z`, external_id: provider === 'google_ads'
      ? createHash('sha256').update(nativeId).digest('hex') : nativeId });
    f.state.auditRows.push({ ...audit, lead_intake_id: id, native_lead_id: nativeId, identity: { ...audit.identity, ad_id: ad } });
  }
  return f;
}

module.exports = { fixture, qualifiedFixture };

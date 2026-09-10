'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { extractMetaWebAttribution } = require('../../lib/meta-web-attribution');
const { resolveMetaWebAdvertisingIdentity, sendCampaignMetaWebEvent } = require('../../services/campaignWorkspaceMetaWeb.service');
const { checkMetaSignalPreparation } = require('../../services/campaignWorkspaceMetaSignalPreparation.service');
const { loadSignalAuthorizationReview } = require('../../services/campaignWorkspaceSignalAuthorization.service');
const { sendWorkspaceMetaSignal } = require('../../services/metaWorkspaceSignalDelivery.service');
const { enqueueMetaLeadLifecycleSignal, runMetaLeadLifecycleSignalJob } = require('../../services/metaLeadLifecycleJob.service');
const { CRM_MILESTONE_SOURCE } = require('../../services/campaignWorkspaceSignalPolicy.service');
const { attachLeadAdvertisingIdentities, resolveMetaWebLeadIdentity, resolveNativeMetaLeadIdentity } = require('../../services/leadAdvertisingIdentity.service');
const { loadMetaSignalEvidence } = require('../../services/campaignWorkspaceSignalEvidence.service');
const { leadCampaign } = require('../../services/campaignWorkspaceReport.service');
const { activateWorkspaceMeasurement } = require('../../services/campaignWorkspaceActivation.service');

mock.method(require('../../../models').sequelize, 'query', async () => assert.fail('No real database access in this suite'));

function matches(row, where) {
  return Reflect.ownKeys(where || {}).every(key => {
    if (key === Op.or) return where[key].some(branch => matches(row, branch));
    const value = where[key];
    if (value && typeof value === 'object') {
      if (value[Op.in]) return value[Op.in].some(item => key === 'lead_intake_id'
        ? String(item) === String(row[key]) : item === row[key]);
      if (value[Op.between]) return +new Date(row[key]) >= +value[Op.between][0] && +new Date(row[key]) <= +value[Op.between][1];
      assert.fail('Unhandled query');
    }
    return row[key] === value;
  });
}

async function harness(group = false) {
  const state = { now: new Date('2026-09-10T22:00:00Z'), posts: [], deliveries: [], jobs: [], calls: [], audits: [],
    clinic: { id_clinica: 1, grupoClinicaId: group ? 8 : null, estado_clinica: true },
    record: { id: 10, assignment_scope: group ? 'group' : 'clinic', clinic_id: group ? null : 1, group_id: group ? 8 : null,
      domains: ['example.com'], hmac_key: 'private-install-key', config: { features: { consent_mode_enabled: true, chat_enabled: true },
        locations: group ? [{ id: 1 }] : [], meta_ads: { enabled: false, pixel_id: '999' } } },
    connection: { id: 7, accessToken: 'private-token', metaUserId: 'private-principal', expiresAt: '2027-01-01' },
    assets: [{ id: 3, metaAssetId: 'act_20', assetType: 'ad_account', isActive: true, metaConnectionId: 7,
      assignmentScope: group ? 'group' : 'clinic', clinicaId: group ? null : 1, grupoClinicaId: group ? 8 : null }],
    assignments: [{ id: 4, scopeKey: group ? 'group:8' : 'clinic:1', assignmentScope: group ? 'group' : 'clinic',
      metaConnectionId: 7, status: 'active', connectedAt: '2026-09-01T00:00:00Z' }],
    decisions: group ? [{ id: 6, provider: 'meta_ads', customer_id: '20', campaign_id: '30', clinica_id: 1, status: 'active' }] : [],
    inventory: [], social: [{ level: 'campaign', ad_account_id: '20', entity_id: '30' }],
    lead: { id: 100, clinica_id: 1, source: 'web', channel: 'paid', external_source: 'web', email: 'fixture@example.invalid',
      telefono: '34600000000', status_lead: 'cualificado', archived_at: null, consentimiento_canal: { ad_user_data: 'granted' } },
    appointments: [{ id_cita: 200, clinica_id: 1, lead_intake_id: 100, estado: 'pendiente', es_provisional: false }],
    setting: { id: 'setting', scope_type: group ? 'group' : 'clinic', scope_id: group ? 8 : 1, version: 1,
      accounts: [{ provider: 'meta_ads', account_id: '20', include_future: true, campaign_ids: [] }],
      preferences: { mode: 'measurement', signals: { enabled: true, events: ['lead', 'contact', 'qualified_lead', 'schedule'] } } },
  };
  const campaign = { id: 'meta_ads:20:30', provider: 'meta_ads', account_id: '20', campaign_id: '30', clinicId: 1, assigned: true, destination: 'web' };
  Object.defineProperty(state.setting, 'update', { value: async values => Object.assign(state.setting, values) });
  const all = (name, getter) => async ({ where } = {}) => { state.calls.push(name); return structuredClone(getter().filter(row => matches(row, where))); };
  const models = {
    sequelize: { transaction: async callback => callback({ LOCK: { UPDATE: 'UPDATE' } }) },
    Clinica: { findByPk: async id => id === 1 ? structuredClone(state.clinic) : null,
      findAll: all('clinics', () => [state.clinic]) },
    GrupoClinica: { findByPk: async id => id === 8 ? { id } : null },
    CampaignWorkspaceSetting: { findAll: all('settings', () => [state.setting]),
      findOne: async ({ where }) => matches(state.setting, where) ? state.setting : null,
      findByPk: async () => structuredClone(state.setting) },
    CampaignWorkspaceEvent: { create: async () => {} },
    IntakeConfig: { findOne: async ({ where }) => matches(state.record, where) ? { ...structuredClone(state.record),
      update: async patch => Object.assign(state.record, structuredClone(patch)) } : null,
      findAll: all('web_records', () => [state.record]) },
    ExternalCampaignInventory: { findAll: all('inventory', () => state.inventory) },
    SocialAdsEntity: { findAll: all('social', () => state.social) },
    ClinicMetaAsset: { findAll: all('assets', () => state.assets) },
    MetaConnectionAssignment: { findAll: all('assignments', () => state.assignments) },
    ExternalCampaignAssignment: { findAll: all('decisions', () => state.decisions) },
    MetaConnection: { findByPk: async id => id === 7 ? structuredClone(state.connection) : null },
    LeadIntake: { findByPk: async id => id === 100 ? structuredClone(state.lead) : null },
    LeadAttributionAudit: { findAll: all('audits', () => state.audits) },
    CitaPaciente: { findAll: all('appointments', () => state.appointments) },
    CampaignOptimizationPolicy: { findAll: async () => [] },
    MetaSignalDelivery: {
      findAll: async ({ where }) => state.deliveries.filter(row => matches(row, where)),
      findOne: async ({ where }) => state.deliveries.find(row => matches(row, where)) || null,
      create: async values => { const row = { ...values, created_at: state.now, update: async patch => Object.assign(row, patch) };
        state.deliveries.push(row); state.afterReserve?.(); return row; },
      update: async (values, { where }) => { const row = state.deliveries.find(item => matches(item, where));
        if (!row) return [0]; Object.assign(row, values); return [1]; },
    },
  };
  const scope = { clinicIds: [1], groupId: group ? 8 : null };
  const now = () => state.now;
  await checkMetaSignalPreparation({ models, scope, actorId: 2, hasAccess: async () => true, now,
    input: { account_id: '20', dataset_id: '50', expected_version: state.setting.version }, read: async path => {
      if (path === 'me/permissions') return { data: { data: [{ permission: 'ads_management', status: 'granted' }] } };
      if (path === 'act_20') return { data: { id: 'act_20', account_id: '20' } };
      return { data: { data: [{ id: '50', name: 'Test dataset' }] } };
    } });
  const review = await loadSignalAuthorizationReview({ models, scope, setting: state.setting, now: state.now });
  assert.equal(review.review.ready, true);
  // Exercise the real activator with isolated models and prepared receipt evidence, never the customer gate.
  await activateWorkspaceMeasurement({ models, scope, actorId: 2, now, deploymentReady: true, hasAccess: async () => true,
    input: { expected_version: state.setting.version, preparation_revision: 'a'.repeat(64), mode: 'measurement', signals: { enabled: true }, confirmed: true },
    loadPreparation: async () => ({ revision: 'a'.repeat(64), selectionConfirmed: true, receptionReady: true, signals: review.review,
      campaigns: [{ campaign, ready: true, configurationScope: { scope_type: state.setting.scope_type, scope_id: state.setting.scope_id } }] }),
    loadInventory: async () => ({ google: [], meta: state.assets, campaigns: [campaign], groups: group ? [8] : [] }) });
  const identify = (extra = {}) => resolveMetaWebAdvertisingIdentity({ models, clinicId: 1, recordId: 10,
    attribution: { account_id: '20', campaign_id: '30' }, eventSourceUrl: 'https://example.com/private-path?secret=value', ...extra });
  const identity = await identify(); assert.ok(identity);
  state.audits.push({ lead_intake_id: 100, identity });
  const transport = async (...args) => { state.posts.push(args); return { data: { events_received: 1 } }; };
  const send = (extra = {}) => sendCampaignMetaWebEvent({ clinicId: 1, eventName: 'Lead', eventId: 'lead-100', eventTime: +state.now / 1000,
    webPolicyRecord: state.record, webIdentity: identity, requirePersistedIdentity: true, leadId: 100,
    eventSourceUrl: 'https://example.com/private-path?secret=value', advertisingConsent: true,
    userData: { em: ['a'.repeat(64)], client_user_agent: 'QA', client_ip_address: '127.0.0.1' }, ...extra },
  { models, now, send: transport, existing: () => assert.fail('New mandates must never fall back to the old pixel') });
  const deps = { models, now, env: { CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true' },
    enqueue: async input => { let job = state.jobs.find(row => row.dedupeScope === input.dedupeScope); const created = !job;
      if (!job) { job = { ...structuredClone(input), id: state.jobs.length + 1, requested_by: null }; state.jobs.push(job); }
      return { created, job }; },
    send: (input, options) => sendWorkspaceMetaSignal(input, { ...options, models, now, send: transport }),
  };
  const enqueue = (extra = {}) => enqueueMetaLeadLifecycleSignal({ leadId: 100, clinicId: 1, eventName: 'qualified_lead',
    eventId: 'lead-100-qualified', occurredAt: state.now, crmEventSource: CRM_MILESTONE_SOURCE, ...extra }, deps);
  const run = (index = 0) => runMetaLeadLifecycleSignalJob(state.jobs[index].payload, state.jobs[index], deps);
  const health = extra => loadMetaSignalEvidence({ models, campaigns: [campaign], selectedClinics: [state.clinic], now: state.now, ...extra });
  return { state, models, identity, identify, send, enqueue, run, health, campaign };
}

test('Meta web attribution accepts named IDs, not names, placeholders, conflicts or raw proof claims', () => {
  assert.deepEqual(extractMetaWebAttribution({ landing_url: 'https://example.com/?cc_meta_account_id=20&cc_meta_campaign_id=30' }),
    { account_id: '20', campaign_id: '30' });
  assert.deepEqual(extractMetaWebAttribution({ attribution: { meta_ads_campaign_id: '30', ad_account_id: 'act_20' } }),
    { account_id: '20', campaign_id: '30' });
  for (const input of [null, {}, { utm_campaign: '30' }, { meta_ads_campaign_id: '{{campaign.id}}' },
    { meta_ads_campaign_id: '30', landing_url: 'https://example.com/?cc_meta_campaign_id=31' },
    { meta_ads_campaign_id: '30', ad_account_id: '../me' }, { advertising_identity: { campaign_id: '30' } }]) {
    assert.equal(extractMetaWebAttribution(input), null);
  }
});

test('Meta web capture, CRM milestones, delivery records and Health reuse the prepared destination', async () => {
  for (const group of [false, true]) {
    const h = await harness(group); const original = structuredClone(h.state.record);
    assert.equal((await h.send()).sent, true);
    assert.equal((await h.enqueue()).queued, true); assert.equal((await h.run()).status, 'completed');
    assert.equal((await h.enqueue({ eventName: 'schedule', eventId: 'appointment-200' })).queued, true);
    assert.equal((await h.run(1)).status, 'completed');
    assert.equal(h.state.posts.length, 3); assert.ok(h.state.posts.every(args => args[0] === '50'));
    assert.equal(h.state.posts[0][1].data[0].event_source_url, 'https://example.com/');
    assert.equal(h.state.posts[1][1].data[0].action_source, 'system_generated');
    assert.equal(h.state.posts[1][1].data[0].user_data.lead_id, undefined);
    assert.doesNotMatch(JSON.stringify(h.state.posts.map(args => args[1])), /private-path|secret=value|fixture@|34600000000|clinic_id|web_fingerprint/);
    assert.doesNotMatch(JSON.stringify(h.state.jobs), /fixture@|34600000000|private-token|user_data/);
    assert.deepEqual(h.state.record, original);
    assert.equal(h.state.deliveries[0].policy_refs.source, 'web');
    const evidence = (await h.health()).get(h.campaign.id);
    assert.equal(evidence.ready, true); assert.equal(evidence.received, 3);
    assert.match(evidence.detail, /No confirma su atribución/);
    assert.equal((await h.send()).reason, 'meta_event_already_received');
    assert.equal((await h.run()).status, 'completed'); assert.equal(h.state.posts.length, 3);
  }
});

test('server-written web attribution contributes to the existing report without impersonating a native form', async () => {
  const h = await harness(); const leads = [structuredClone(h.state.lead)];
  await attachLeadAdvertisingIdentities({ models: h.models, leads });
  assert.equal(leadCampaign(leads[0], [h.campaign]), h.campaign.id);
  assert.equal(await resolveNativeMetaLeadIdentity({ models: h.models, lead: h.state.lead }), null);
  h.state.audits.push({ lead_intake_id: 100, identity: { ...h.identity, campaign_id: '31' } });
  assert.equal(await resolveMetaWebLeadIdentity({ models: h.models, lead: h.state.lead }), null);
  await attachLeadAdvertisingIdentities({ models: h.models, leads });
  assert.equal(leads[0].advertising_identity_conflict, true); assert.equal(leadCampaign(leads[0], [h.campaign]), null);
});

test('a shared Meta account requires an explicit clinic decision and never uses its representative clinic', async () => {
  const h = await harness(true); h.state.decisions = [];
  assert.equal(await h.identify(), null); assert.equal((await h.send()).sent, false);
  h.state.decisions = [{ id: 9, provider: 'meta_ads', customer_id: '20', campaign_id: '30', clinica_id: 2, status: 'active' }];
  assert.equal(await h.identify(), null); assert.equal(h.state.posts.length, 0);
});

test('unknown campaigns and domains remain unbound, and failed web preparation cannot send signals', async () => {
  const h = await harness();
  assert.equal(await h.identify({ attribution: { account_id: '20', campaign_id: '999' } }), null);
  await assert.rejects(h.identify({ eventSourceUrl: 'https://other.example.com/' }), /workspace_meta_web_origin_required/);
  h.state.record.config.features.consent_mode_enabled = false;
  assert.equal((await h.send()).sent, false); assert.equal((await h.enqueue()).queued, false);
  assert.equal(h.state.posts.length, 0);
});

test('revocation after reservation cancels web delivery and CRM jobs without transport', async () => {
  for (const change of [h => { h.state.setting.activation.signals.enabled = false; },
    h => { h.state.lead.consentimiento_canal = { marketing: false }; },
    h => { h.state.connection.metaUserId = 'different-grant'; },
    h => { h.state.record.config.features.consent_mode_enabled = false; },
    h => { h.state.audits = []; }]) {
    const h = await harness(); h.state.afterReserve = () => change(h);
    assert.equal((await h.send()).sent, false); assert.equal(h.state.posts.length, 0);
    assert.equal(h.state.deliveries[0].status, 'skipped');
    const crm = await harness(); await crm.enqueue(); crm.state.afterReserve = () => change(crm);
    assert.equal((await crm.run()).status, 'failed'); assert.equal(crm.state.posts.length, 0);
  }
});

test('web events cannot authorize CRM appointments, native IDs or ViewContent through a campaign mandate', async () => {
  const h = await harness();
  for (const extra of [{ advertisingConsent: false }, { eventName: 'Schedule' }, { eventName: 'ViewContent' },
    { verifiedNativeLeadId: '777' }, { webIdentity: null }]) assert.equal((await h.send(extra)).sent, false);
  assert.equal(h.state.posts.length, 0); assert.equal(h.state.deliveries.length, 0);
});

test('report caches are per-query and cannot hide consent, ownership or grant changes', async () => {
  const h = await harness(); await h.send(); await h.enqueue(); await h.run();
  h.state.calls = []; h.state.connection.accessToken = 'rotated'; h.state.record.config.features.chat_enabled = false;
  assert.equal((await h.health()).get(h.campaign.id).received, 2);
  assert.equal(h.state.calls.filter(value => value === 'web_records').length, 1);
  assert.equal(h.state.calls.filter(value => value === 'inventory').length, 1);
  h.state.record.config.features.consent_mode_enabled = false;
  assert.equal((await h.health()).get(h.campaign.id).checked, false);
  assert.equal((await h.health({ selectedClinics: [] })).size, 0);
  assert.equal(h.state.posts.length, 2);
});

test('independent public web events resolve the same attribution without persisting or trusting browser proofs', async () => {
  const h = await harness();
  assert.equal((await h.send({ webIdentity: null, requirePersistedIdentity: false,
    attribution: { landing_url: 'https://example.com/?cc_meta_campaign_id=30' } })).sent, true);
  assert.equal((await h.send({ webIdentity: null, requirePersistedIdentity: false,
    attribution: { advertising_identity: h.identity }, eventId: 'forged' })).sent, false);
  assert.equal(h.state.audits.length, 1); assert.equal(h.state.posts.length, 1);
});

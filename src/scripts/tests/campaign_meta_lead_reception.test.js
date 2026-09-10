'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { webhookEvents, receptionRuntimeNamespace, enqueueMetaLeadNotifications, resolveMetaLeadClinic, retrieveMetaLead,
  persistMetaLead, runMetaLeadReceptionJob, contactFields } = require('../../services/metaLeadReception.service');

const event = { lead_id: '100', page_id: '200', form_id: '300', ad_id: '400' };
const identity = { account_id: '500', campaign_id: '600', ad_id: '400', adset_id: '700' };
const notification = (patch = {}) => ({ object: 'page', entry: [{ id: '200', changes: [{ field: 'leadgen', value: {
  leadgen_id: '100', page_id: '200', form_id: '300', ad_id: '400', ...patch,
} }] }] });
function harness(patch = {}) {
  const state = { leads: [], audits: [], notifications: [], graph: [], rollback: 0,
    page: { id: 10, metaAssetId: '200', metaConnectionId: 1, pageAccessToken: 'page-secret',
      assignmentScope: 'group', grupoClinicaId: 28, clinicaId: 99 },
    account: { id: 11, metaAssetId: 'act_500', metaConnectionId: 1, assignmentScope: 'group', grupoClinicaId: 28, clinicaId: 99 },
    decisions: [{ status: 'active', clinica_id: 5 }],
    clinics: [{ id_clinica: 5, grupoClinicaId: 28, estado_clinica: 1 }], settings: [],
    assignments: [{ scopeKey: 'group:28', metaConnectionId: 1 }],
    connection: { id: 1, accessToken: 'user-secret', expiresAt: '2099-01-01' },
    providerLead: { id: '100', ad_id: '400', campaign_id: '600', form_id: '300', created_time: '2026-09-10T10:00:00Z',
      field_data: [{ name: 'email', values: [' PERSON@example.com '] }, { name: 'full_name', values: ['Person'] }] }, ...patch };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    ClinicMetaAsset: { findOne: async () => state.page, findAll: async ({ where }) => where.assetType === 'facebook_page' ? [state.page, ...(state.otherPages || [])].filter(Boolean) : [state.account].filter(Boolean) },
    MetaConnectionAssignment: { findAll: async ({ where }) => state.assignments.filter(row => where.scopeKey[Op.in].includes(row.scopeKey)) },
    MetaConnection: { findByPk: async () => state.connection },
    ExternalCampaignAssignment: { findAll: async () => state.decisions },
    Clinica: { findByPk: async id => state.clinics.find(row => Number(row.id_clinica) === Number(id)) },
    CampaignWorkspaceSetting: { findAll: async () => state.settings },
    LeadIntake: { findOne: async ({ where }) => state.leads.find(row => row.external_source === where.external_source && row.external_id === where.external_id),
      create: async (input, options) => { assert.equal(options.transaction, transaction); const row = { id: state.leads.length + 1, ...input }; state.leads.push(row); return row; } },
    LeadAttributionAudit: { create: async (input, options) => { assert.equal(options.transaction, transaction); if (state.auditError) throw new Error('audit failed'); state.audits.push(input); } },
    sequelize: { transaction: async fn => { const snapshot = structuredClone({ leads: state.leads, audits: state.audits });
      try { return await fn(transaction); } catch (error) { Object.assign(state, snapshot); state.rollback++; throw error; } } },
  };
  const http = { get: async (url, options) => {
    state.graph.push({ url, options });
    if (state.graphError) throw state.graphError;
    return { data: url.endsWith('/100') ? state.providerLead : { id: '400', account_id: '500', campaign_id: '600', adset_id: '700', ...state.providerAd } };
  } };
  const notify = async input => { if (state.notifyError) throw new Error('notification failed'); state.notifications.push(input); };
  return { state, models, http, notify };
}

test('signed notification parsing retains only exact provider IDs, never contact data or caller runtime', () => {
  assert.deepEqual(webhookEvents(notification({ email: 'private', __runtime_namespace: 'staging' })), [event]);
  for (const patch of [{ leadgen_id: 100 }, { ad_id: '../me' }, { page_id: '201' }, { form_id: null }]) {
    assert.throws(() => webhookEvents(notification(patch)), /invalid_notification/);
  }
  assert.deepEqual(webhookEvents({ object: 'instagram', entry: [] }), []);
});
test('durable enqueue deduplicates lead IDs and has no external calls or personal data', async () => {
  const h = harness(); const queued = [];
  const result = await enqueueMetaLeadNotifications(notification(), { models: h.models, env: {}, enqueue: async job => queued.push(job) });
  assert.equal(result.queued, 1); assert.deepEqual(queued[0].payload, event);
  assert.equal(queued[0].dedupeScope, 'meta_leadgen:100'); assert.equal(h.state.graph.length, 0);
  await assert.rejects(enqueueMetaLeadNotifications(notification(), { models: h.models, enqueue: async () => { throw new Error('queue down'); } }), /queue down/);
  h.state.page = null;
  assert.equal((await enqueueMetaLeadNotifications(notification(), { models: h.models, enqueue: async () => assert.fail() })).queued, 0);
});
test('the gateway sends receipts to its configured business worker, never to a caller-selected namespace', async () => {
  assert.equal(receptionRuntimeNamespace({ RUNTIME_ROLE: 'gateway', JOB_RUNTIME_NAMESPACE: 'gateway' }), 'staging');
  assert.equal(receptionRuntimeNamespace({ RUNTIME_ROLE: 'gateway', META_LEAD_JOB_RUNTIME_NAMESPACE: 'prod' }), 'prod');
  assert.equal(receptionRuntimeNamespace({ RUNTIME_ROLE: 'api', JOB_RUNTIME_NAMESPACE: 'dev' }), 'dev');
  const h = harness(); const queued = [];
  await enqueueMetaLeadNotifications(notification({ __runtime_namespace: 'dev' }), { models: h.models,
    env: { RUNTIME_ROLE: 'gateway', AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE: 'prod' }, enqueue: async job => queued.push(job) });
  assert.equal(queued[0].payload.__runtime_namespace, 'prod');
});
test('page-specific token retrieves the lead and user-scoped token verifies account/campaign identity', async () => {
  const h = harness(); const result = await retrieveMetaLead({ ...h, event });
  assert.deepEqual(result.identity, identity); assert.equal(result.clinic.id_clinica, 5);
  assert.equal(h.state.graph[0].options.headers.Authorization, 'Bearer page-secret');
  assert.equal(h.state.graph[1].options.headers.Authorization, 'Bearer user-secret');
  assert.equal(h.state.graph[0].options.params.access_token, undefined);
  assert.equal(h.state.graph[0].options.maxRedirects, 0);
});
test('provider failure produces a retryable safe job result, no empty lead and no notification', async () => {
  const h = harness({ graphError: { response: { data: { error: { code: 190, message: 'secret contact' } } }, config: { access_token: 'secret' } } });
  const result = await runMetaLeadReceptionJob(event, null, h);
  assert.deepEqual(result, { status: 'failed', retryable: true, error_message: 'meta_lead_page_access_required' });
  assert.equal(h.state.leads.length, 0); assert.equal(h.state.notifications.length, 0);
});
test('unconfirmed group campaign never falls back to the representative clinic or a duplicate Campana', async () => {
  const h = harness({ decisions: [] });
  assert.equal((await runMetaLeadReceptionJob(event, null, h)).error_message, 'meta_lead_clinic_assignment_required');
  assert.equal(h.state.leads.length, 0);
});
test('archived, conflicting, foreign-group or inactive clinic assignments do not receive leads', async () => {
  for (const patch of [{ decisions: [{ status: 'archived', clinica_id: 5 }] },
    { decisions: [{ status: 'active', clinica_id: 5 }, { status: 'active', clinica_id: 6 }] },
    { clinics: [{ id_clinica: 5, grupoClinicaId: 29, estado_clinica: 1 }] },
    { clinics: [{ id_clinica: 5, grupoClinicaId: 28, estado_clinica: 0 }] }]) {
    const h = harness(patch); assert.equal((await runMetaLeadReceptionJob(event, null, h)).status, 'failed');
    assert.equal(h.state.leads.length, 0);
  }
});
test('account selection includes future campaigns only when explicitly enabled', async () => {
  const h = harness({ settings: [{ scope_type: 'group', accounts: [{ provider: 'meta_ads', account_id: '500', include_future: false, campaign_ids: [] }] }] });
  assert.equal((await runMetaLeadReceptionJob(event, null, h)).error_message, 'meta_lead_campaign_not_selected');
  h.state.settings[0].accounts[0].include_future = true;
  assert.equal((await runMetaLeadReceptionJob(event, null, h)).status, 'completed');
});
test('revoked scope authorization or expired user token prevents provider access', async () => {
  for (const patch of [{ assignments: [] }, { connection: { id: 1, expiresAt: '2020-01-01' } }]) {
    const h = harness(patch); assert.equal((await runMetaLeadReceptionJob(event, null, h)).status, 'failed');
    assert.equal(h.state.graph.length, 0);
  }
});
test('provider IDs must match signed notification and account lookup exactly', async () => {
  for (const patch of [{ id: '999' }, { form_id: '999' }, { ad_id: '999' }, { campaign_id: '999' }]) {
    const h = harness(); Object.assign(h.state.providerLead, patch);
    assert.equal((await runMetaLeadReceptionJob(event, null, h)).error_message, 'meta_lead_identity_mismatch');
    assert.equal(h.state.leads.length, 0);
  }
});
test('missing email and phone is pending instead of an empty successful lead', async () => {
  assert.throws(() => contactFields({ field_data: [{ name: 'full_name', values: ['Name only'] }] }), /contact_unavailable/);
  const h = harness(); h.state.providerLead.field_data = [];
  assert.equal((await runMetaLeadReceptionJob(event, null, h)).error_message, 'meta_lead_contact_unavailable');
  assert.equal(h.state.leads.length, 0);
});
test('lead and verified minimal attribution commit together, without custom health answers', async () => {
  const h = harness(); h.state.providerLead.field_data.push({ name: 'diagnosis', values: ['never copy'] });
  const result = await runMetaLeadReceptionJob(event, null, h);
  assert.equal(result.status, 'completed'); assert.equal(h.state.leads[0].clinica_id, 5);
  assert.equal(h.state.leads[0].email, 'person@example.com');
  assert.deepEqual(h.state.audits[0].attribution_steps.advertising_identity, { version: 1, verified_by: 'meta_graph',
    provider: 'meta_ads', clinic_id: 5, ...identity, page_id: '200', form_id: '300' });
  assert.ok(!JSON.stringify(h.state.audits).includes('never copy')); assert.equal(h.state.notifications.length, 1);
});
test('audit failure rolls back the lead and never notifies', async () => {
  const h = harness({ auditError: true });
  assert.equal((await runMetaLeadReceptionJob(event, null, h)).status, 'failed');
  assert.equal(h.state.rollback, 1); assert.equal(h.state.leads.length, 0); assert.equal(h.state.notifications.length, 0);
});
test('redelivery and an outbox failure retry use the original lead, not a second lead or global contact merge', async () => {
  const h = harness({ notifyError: true });
  assert.equal((await runMetaLeadReceptionJob(event, null, h)).status, 'failed');
  assert.equal(h.state.leads.length, 1); h.state.notifyError = false;
  const result = await runMetaLeadReceptionJob(event, null, h);
  assert.equal(result.duplicate, true); assert.equal(h.state.leads.length, 1); assert.equal(h.state.audits.length, 1);
});
test('a previously imported lead is neither moved nor notified in a different clinic', async () => {
  const h = harness({ leads: [{ id: 1, clinica_id: 6, external_source: 'meta_leadgen', external_id: '100' }] });
  assert.equal((await runMetaLeadReceptionJob(event, null, h)).error_message, 'meta_lead_existing_scope_mismatch');
  assert.equal(h.state.notifications.length, 0);
});
test('assignment revocation between provider retrieval and persistence is checked again in the transaction', async () => {
  const h = harness(); const retrieved = await retrieveMetaLead({ ...h, event });
  h.state.assignments = [];
  await assert.rejects(persistMetaLead({ models: h.models, event, retrieved }), /page_access_required/);
  assert.equal(h.state.leads.length, 0);
});
test('organic form without campaign identity cannot choose an arbitrary clinic from a shared page', async () => {
  const h = harness();
  await assert.rejects(resolveMetaLeadClinic({ models: h.models, event, identity: null, pageAssetId: 10, connectionId: 1 }), /clinic_assignment_required/);
});

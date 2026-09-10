'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { JOB_TYPE, ORIGIN, parseGoogleLead, receptionAccount, persistGoogleLead,
  enqueueGoogleLeadSyncs, runGoogleLeadSync } = require('../../services/googleLeadReception.service');

mock.method(require('../../../models').sequelize, 'query', async () => assert.fail('Native lead tests must not access the real database'));

const NOW = new Date('2026-09-10T12:00:00Z');
const input = { setting_id: 'setting-1', account_id: '1234567890' };
const job = { type: JOB_TYPE, origin: ORIGIN, requested_by: null };
function providerRow(patch = {}) {
  return { leadFormSubmissionData: { id: 'opaque-submission-id', resourceName: 'customers/1234567890/leadFormSubmissionData/opaque-submission-id',
    campaign: 'customers/1234567890/campaigns/200', asset: 'customers/1234567890/assets/300',
    adGroup: 'customers/1234567890/adGroups/400', adGroupAd: 'customers/1234567890/adGroupAds/400~500',
    submissionDateTime: '2026-09-10 13:00:00+02:00', gclid: 'click-opaque',
    leadFormSubmissionFields: [{ fieldType: 'FULL_NAME', fieldValue: 'Person' },
      { fieldType: 'EMAIL', fieldValue: ' PERSON@example.test ' }, { fieldType: 'PHONE_NUMBER', fieldValue: '+34600000000' },
      { fieldType: 'CUSTOM_HEALTH', fieldValue: 'must never persist' }], ...patch } };
}
function harness({ group = false } = {}) {
  const owner = group ? { scope_type: 'group', scope_id: 28 } : { scope_type: 'clinic', scope_id: 5 };
  const state = { setting: { id: 'setting-1', ...owner, accounts: [{ provider: 'google_ads', account_id: '1234567890',
    include_future: true, campaign_ids: [] }] },
  clinics: [{ id_clinica: 5, grupoClinicaId: 28, estado_clinica: 1 }],
  accounts: [{ id: 10, customerId: '1234567890', assignmentScope: group ? 'group' : 'clinic', clinicaId: group ? 99 : 5,
    grupoClinicaId: group ? 28 : null, googleConnectionId: 20, isActive: true }],
  assignments: [{ id: 30, scopeKey: group ? 'group:28' : 'clinic:5', googleConnectionId: 20, status: 'active', connectedAt: '2026-09-01' }],
  connection: { id: 20, googleUserId: 'user-1', accessToken: 'private-token', refreshToken: 'private-refresh',
    scopes: 'https://www.googleapis.com/auth/adwords', expiresAt: '2099-01-01' },
  decisions: group ? [{ status: 'active', clinica_id: 5 }] : [],
  rows: [providerRow()], queries: [], leads: [], audits: [], notifications: [], rollback: 0, updates: 0,
  env: { CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED: 'true' } };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    CampaignWorkspaceSetting: { findByPk: async () => structuredClone(state.setting),
      findAll: async ({ attributes }) => attributes ? [state.setting] : [state.setting, ...(state.otherSettings || [])] },
    Clinica: { findByPk: async id => state.clinics.find(row => row.id_clinica === Number(id)), findAll: async () => state.clinics },
    ClinicGoogleAdsAccount: { findAll: async () => state.accounts.filter(row => row.isActive) },
    GoogleConnectionAssignment: { findAll: async ({ where }) => state.assignments.filter(row => row.status === 'active' && where.scopeKey[Op.in].includes(row.scopeKey)) },
    GoogleConnection: { findByPk: async () => state.connection },
    ExternalCampaignAssignment: { findAll: async () => state.decisions },
    LeadIntake: { findOne: async ({ where, transaction: tx }) => {
      assert.equal(tx, transaction); return state.leads.find(row => row.external_source === where.external_source && row.external_id === where.external_id);
    }, create: async (value, options) => {
      assert.equal(options.transaction, transaction); const lead = { id: state.leads.length + 1, ...value }; state.leads.push(lead); return lead;
    } },
    LeadAttributionAudit: { create: async (value, options) => { assert.equal(options.transaction, transaction);
      if (state.auditFailure) throw new Error('database secret failure'); state.audits.push(value); } },
    sequelize: { transaction: async fn => {
      const snapshot = structuredClone({ leads: state.leads, audits: state.audits });
      try { return await fn(transaction); } catch (error) { Object.assign(state, snapshot); state.rollback++; throw error; }
    } },
  };
  const dependencies = { models, env: state.env, now: () => NOW,
    ensureToken: async connection => { if (state.onToken) state.onToken(); return { accessToken: connection.accessToken }; },
    search: async options => { state.queries.push(options); if (state.onSearch) state.onSearch();
      if (state.providerFailure) throw state.providerFailure; return state.rows; },
    notify: async options => { if (state.notifyFailure) throw new Error('private message'); state.notifications.push(options); } };
  return { state, models, dependencies, run: () => runGoogleLeadSync(input, job, dependencies) };
}

test('native Google fields preserve provider IDs and basic contact only', () => {
  const parsed = parseGoogleLead(providerRow(), input.account_id, NOW);
  assert.equal(parsed.contact.email, 'person@example.test'); assert.equal(parsed.contact.telefono, '34600000000');
  assert.equal(parsed.identity.form_id, '300'); assert.equal(parsed.identity.ad_id, '500');
  assert.equal(parsed.identity.adgroup_id, '400'); assert.equal(parsed.occurredAt.toISOString(), '2026-09-10T11:00:00.000Z');
  assert.equal(parsed.gclid, 'click-opaque'); assert.doesNotMatch(JSON.stringify(parsed), /must never persist|consent/);
});
test('snake-case API fields are supported without assuming webhook schema', () => {
  const camel = providerRow().leadFormSubmissionData;
  const row = { lead_form_submission_data: { id: camel.id, resource_name: camel.resourceName, campaign: camel.campaign, asset: camel.asset,
    submission_date_time: camel.submissionDateTime, lead_form_submission_fields: [{ field_type: 'EMAIL', field_value: 'a@example.test' }] } };
  assert.equal(parseGoogleLead(row, input.account_id, NOW).contact.email, 'a@example.test');
  assert.throws(() => parseGoogleLead({ user_column_data: [], google_key: 'secret' }, input.account_id, NOW), /identity_invalid/);
});
test('foreign resources, unsafe IDs, inconsistent ads, timezones and duplicate contact fields fail closed', () => {
  for (const patch of [{ id: 42 }, { asset: 'customers/999/assets/300' }, { campaign: 'customers/1234567890/campaigns/../200' },
    { adGroupAd: 'customers/1234567890/adGroupAds/401~500' }, { adGroup: 'customers/999/adGroups/400' },
    { resourceName: 'customers/999/leadFormSubmissionData/opaque-submission-id' }, { submissionDateTime: '2026-09-10 13:00:00' },
    { submissionDateTime: '2099-09-10 13:00:00+02:00' },
    { leadFormSubmissionFields: [{ fieldType: 'EMAIL', fieldValue: 'a@example.test' }, { fieldType: 'EMAIL', fieldValue: 'b@example.test' }] }]) {
    assert.throws(() => parseGoogleLead(providerRow(patch), input.account_id, NOW), /google_lead_/);
  }
});
test('gate and internal job identity prevent any lookup or provider request', async () => {
  const h = harness(); h.state.env.CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED = 'false';
  assert.equal((await h.run()).disabled, true); assert.equal(h.state.queries.length, 0);
  h.state.env.CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED = 'true';
  for (const patch of [{ requested_by: 1 }, { origin: 'user' }, { type: 'other' }]) {
    assert.equal((await runGoogleLeadSync(input, { ...job, ...patch }, h.dependencies)).error_message, 'google_lead_internal_job_required');
  }
  assert.equal(h.state.queries.length, 0);
});
test('API reception reuses the existing CRM with atomic minimal audit and no web or conversion setup', async () => {
  for (const group of [false, true]) {
    const h = harness({ group }); const result = await h.run();
    assert.equal(result.status, 'completed'); assert.equal(result.received, 1);
    assert.equal(h.state.leads[0].clinica_id, 5); assert.equal(h.state.leads[0].google_ads_campaign_id, '200');
    assert.equal(h.state.leads[0].consentimiento_canal, undefined);
    assert.equal(h.state.leads[0].created_at.toISOString(), '2026-09-10T11:00:00.000Z');
    assert.equal(h.state.audits[0].attribution_steps.advertising_identity.verified_by, 'google_ads_api');
    assert.equal(h.state.audits[0].attribution_steps.advertising_identity.ad_id, '500');
    assert.equal(h.state.notifications.length, 1);
    assert.match(h.state.queries[0].query, /FROM lead_form_submission_data/);
    assert.doesNotMatch(h.state.queries[0].query, /custom_lead_form_submission_fields/);
    assert.equal(h.state.queries[0].timeoutMs, 45000);
    assert.doesNotMatch(JSON.stringify(h.state.audits), /must never persist|private-token|private-refresh|PERSON@|34600000000/);
    assert.equal((await h.run()).duplicates, 1); assert.equal(h.state.leads.length, 1); assert.equal(h.state.audits.length, 1);
  }
});
test('an explicitly selected account can include future campaigns without creating a local campaign', async () => {
  const h = harness(); h.state.setting.accounts[0].include_future = false;
  assert.equal((await h.run()).excluded, 1); assert.equal(h.state.leads.length, 0);
  h.state.setting.accounts[0].campaign_ids = ['200'];
  assert.equal((await h.run()).received, 1);
});
test('a group representative clinic is never a recipient; unresolved campaigns remain retryable', async () => {
  const h = harness({ group: true }); h.state.decisions = [];
  const result = await h.run(); assert.equal(result.status, 'failed'); assert.equal(result.pending, 1); assert.equal(result.retryable, true);
  assert.equal(h.state.leads.length, 0);
  h.state.decisions = [{ status: 'active', clinica_id: 5 }];
  assert.equal((await h.run()).received, 1);
});
test('shared accounts, foreign clinics and narrower exclusions cannot leak leads across scopes', async () => {
  for (const patch of [h => h.state.accounts.push({ ...h.state.accounts[0], id: 11, clinicaId: 6 }),
    h => h.state.decisions = [{ status: 'active', clinica_id: 6 }],
    h => h.state.decisions = [{ status: 'archived', clinica_id: 5 }],
    h => h.state.otherSettings = [{ id: 'clinic-setting', scope_type: 'clinic', scope_id: 5, accounts: [] }]]) {
    const h = harness({ group: true }); patch(h);
    // The first case has two clinic owners instead of a group decision.
    if (h.state.accounts.length === 2) { h.state.accounts.forEach((row, index) => { row.assignmentScope = 'clinic'; row.clinicaId = index + 5; });
      h.state.assignments = [5, 6].map(id => ({ scopeKey: `clinic:${id}`, googleConnectionId: 20, status: 'active' })); h.state.decisions = []; }
    assert.equal((await h.run()).pending, 1); assert.equal(h.state.leads.length, 0);
  }
});
test('revoked accounts, grants and membership are checked before persistence after network I/O', async () => {
  for (const change of [h => h.state.accounts[0].isActive = false, h => h.state.assignments = [],
    h => h.state.connection.googleUserId = 'another-user', h => h.state.clinics[0].estado_clinica = 0,
    h => h.state.setting.accounts = [], h => h.state.setting.accounts[0].campaign_ids = ['201']]) {
    const h = harness(); h.state.onSearch = () => change(h);
    assert.equal((await h.run()).status, 'failed'); assert.equal(h.state.leads.length, 0); assert.equal(h.state.audits.length, 0);
  }
});
test('missing Ads scope fails before search; routine access token rotation does not change the grant', async () => {
  const denied = harness(); denied.state.connection.scopes = 'profile'; assert.equal((await denied.run()).status, 'failed');
  assert.equal(denied.state.queries.length, 0);
  const h = harness(); h.state.onToken = () => h.state.connection.accessToken = 'rotated-token';
  assert.equal((await h.run()).received, 1);
});
test('provider identity conflict is detected before any lead is written', async () => {
  const h = harness(); h.state.rows.push(providerRow({ asset: 'customers/1234567890/assets/301' }));
  assert.equal((await h.run()).error_message, 'google_lead_identity_invalid'); assert.equal(h.state.leads.length, 0);
});
test('incomplete contacts stay visible as pending without blocking unrelated or excluded campaigns', async () => {
  const h = harness();
  h.state.rows.push(providerRow({ id: 'incomplete-contact', resourceName: 'customers/1234567890/leadFormSubmissionData/incomplete-contact',
    campaign: 'customers/1234567890/campaigns/201', leadFormSubmissionFields: [null] }));
  let result = await h.run();
  assert.equal(result.received, 1); assert.equal(result.status, 'failed');
  assert.equal(result.invalid_contacts, 1); assert.equal(result.error_message, 'google_lead_contact_pending');
  assert.equal(result.retryable, false, 'unchanged bad contact must not exhaust retries for valid contacts');
  h.state.setting.accounts[0] = { provider: 'google_ads', account_id: input.account_id, include_future: false, campaign_ids: ['200'] };
  result = await h.run(); assert.equal(result.status, 'completed'); assert.equal(result.excluded, 1);
  assert.equal(result.duplicates, 1); assert.equal(result.invalid_contacts, 0);
  assert.equal(h.state.leads.length, 1);
});
test('ad resource can supply its group but cannot mask an invalid group resource', () => {
  assert.equal(parseGoogleLead(providerRow({ adGroup: undefined }), input.account_id, NOW).identity.adgroup_id, '400');
  assert.throws(() => parseGoogleLead(providerRow({ adGroup: 'customers/999/adGroups/400' }), input.account_id, NOW), /identity_invalid/);
});
test('provider failures and truncated responses never look like successful empty reception', async () => {
  for (const failure of ['network', 'limit']) {
    const h = harness();
    if (failure === 'network') h.state.providerFailure = new Error('private provider payload');
    else h.state.rows = Array(10001).fill(providerRow());
    const result = await h.run(); assert.equal(result.status, 'failed'); assert.equal(result.retryable, true);
    assert.equal(h.state.leads.length, 0); assert.doesNotMatch(JSON.stringify(result), /private provider/);
    assert.match(h.state.queries[0].query, /LIMIT 10001$/);
  }
});
test('audit failure rolls back the lead; retries cannot duplicate a committed reception when notification fails', async () => {
  const h = harness(); h.state.auditFailure = true;
  assert.equal((await h.run()).error_message, 'google_lead_sync_failed'); assert.equal(h.state.leads.length, 0);
  h.state.auditFailure = false; h.state.notifyFailure = true;
  assert.equal((await h.run()).status, 'failed'); assert.equal(h.state.leads.length, 1);
  h.state.notifyFailure = false; assert.equal((await h.run()).duplicates, 1); assert.equal(h.state.leads.length, 1);
});
test('opaque long IDs fit the existing CRM columns without truncation or cross-form replay', async () => {
  const h = harness(); const opaque = 'x'.repeat(400); h.state.rows = [providerRow({ id: opaque,
    resourceName: `customers/1234567890/leadFormSubmissionData/${opaque}` })];
  assert.equal((await h.run()).received, 1); assert.equal(h.state.leads[0].external_id.length, 64);
  assert.ok(h.state.leads[0].event_id.length < 128);
  h.state.rows[0].leadFormSubmissionData.asset = 'customers/1234567890/assets/301';
  assert.equal((await h.run()).error_message, 'google_lead_existing_scope_mismatch');
});
test('no source contact, provider payload, runtime selector or credential enters the sync queue', async () => {
  const h = harness(); const queued = [];
  const result = await enqueueGoogleLeadSyncs({ models: h.models, env: h.state.env, enqueue: async args => { queued.push(args); return { created: true }; } });
  assert.equal(result.queued, 1); assert.deepEqual(queued[0].payload, input); assert.equal(queued[0].origin, ORIGIN);
  assert.equal(queued[0].dedupeScope, `${JOB_TYPE}:setting-1:1234567890`);
  assert.equal((await enqueueGoogleLeadSyncs({ env: {} })).disabled, true);
});
test('direct persistence also rejects stale authorization and never silently moves an existing lead', async () => {
  const h = harness(); const context = await receptionAccount({ models: h.models, settingId: input.setting_id, accountId: input.account_id, now: NOW });
  const parsed = parseGoogleLead(providerRow(), input.account_id, NOW);
  await persistGoogleLead({ models: h.models, context, parsed, now: NOW });
  h.state.leads[0].clinica_id = 6;
  await assert.rejects(persistGoogleLead({ models: h.models, context, parsed, now: NOW }), /existing_scope_mismatch/);
});

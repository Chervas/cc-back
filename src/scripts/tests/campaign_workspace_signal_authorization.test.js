'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkGooglePreparation } = require('../../services/campaignWorkspaceGooglePreparation.service');
const { checkMetaSignalPreparation } = require('../../services/campaignWorkspaceMetaSignalPreparation.service');
const { buildClinicaclickManagedMapping } = require('../../services/googleAdsConversionPreparation.service');
const { loadSignalAuthorizationReview, verifySignalDestination } = require('../../services/campaignWorkspaceSignalAuthorization.service');
const { resolveWorkspaceSignalPolicy } = require('../../services/campaignWorkspaceSignalPolicy.service');
const { publicSettings } = require('../../services/campaignWorkspaceSettings.service');
const { maybeUploadGoogleConversion } = require('../../services/googleAdsConversionUpload.service');
const { sendWorkspaceMetaSignal } = require('../../services/metaWorkspaceSignalDelivery.service');

function harness() {
  const scope = { clinicIds: [1], groupId: null };
  const accounts = [{ provider: 'google_ads', account_id: '10', include_future: true, campaign_ids: [] },
    { provider: 'meta_ads', account_id: '20', include_future: true, campaign_ids: [] }];
  const state = { date: new Date('2026-09-10T21:00:00Z'), calls: [], audits: [], deliveries: [], uploads: [], attempts: [],
    clinic: { id_clinica: 1, grupoClinicaId: null, estado_clinica: true },
    setting: { id: 'setting', scope_type: 'clinic', scope_id: 1, version: 1, accounts,
      preferences: { mode: 'measurement', signals: { enabled: true, events: ['lead', 'schedule'] } }, signal_preparation: null },
    google: { id: 8, accessToken: 'private-google-token', googleUserId: 'private-google-principal',
      scopes: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/datamanager' },
    meta: { id: 7, accessToken: 'private-meta-token', metaUserId: 'private-meta-principal', expiresAt: '2027-01-01T00:00:00Z' },
    googleAssignment: { id: 9, assignmentScope: 'clinic', clinicaId: 1, scopeKey: 'clinic:1', status: 'active', googleConnectionId: 8, connectedAt: '2026-09-01T00:00:00Z' },
    metaAssignment: { id: 6, assignmentScope: 'clinic', clinicaId: 1, scopeKey: 'clinic:1', status: 'active', metaConnectionId: 7, connectedAt: '2026-09-01T00:00:00Z' },
  };
  state.setting.update = async values => Object.assign(state.setting, values);
  const record = { id: 1, assignment_scope: 'clinic', clinic_id: 1, config: { features: { consent_mode_enabled: true },
    meta_ads: { enabled: true, connection_id: 7, ad_account_id: '20', pixel_id: '301' },
    campaigns: { workspace_policy: { schema_version: 1, setting_id: 'setting', scope_type: 'clinic', scope_id: 1 } } } };
  const models = {
    sequelize: { transaction: async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
    Clinica: { findByPk: async () => state.clinic },
    CampaignWorkspaceSetting: { findOne: async () => state.setting, findByPk: async () => state.setting },
    CampaignWorkspaceEvent: { create: async row => state.audits.push(row) },
    ClinicGoogleAdsAccount: { findAll: async () => [{ id: 5, customerId: '10', assignmentScope: 'clinic', clinicaId: 1, googleConnectionId: 8 }] },
    ClinicMetaAsset: { findAll: async () => [{ id: 4, metaAssetId: '20', assignmentScope: 'clinic', clinicaId: 1, metaConnectionId: 7 }] },
    GoogleConnectionAssignment: { findAll: async () => state.googleAssignment.status === 'active' ? [state.googleAssignment] : [] },
    MetaConnectionAssignment: { findAll: async () => state.metaAssignment.status === 'active' ? [state.metaAssignment] : [],
      findOne: async () => state.metaAssignment.status === 'active' ? state.metaAssignment : null },
    GoogleConnection: { findByPk: async () => state.google }, MetaConnection: { findByPk: async () => state.meta },
    IntakeConfig: { findOne: async () => record },
    MetaSignalDelivery: {
      findOne: async ({ where }) => state.deliveries.find(row => row.dedupe_key === where.dedupe_key),
      create: async values => { if (state.onReserve) state.onReserve(); const row = { ...values, created_at: state.date }; state.deliveries.push(row); return row; },
      update: async (values, { where }) => { const row = state.deliveries.find(row => Object.keys(where).every(key => row[key] === where[key])); if (!row) return [0]; Object.assign(row, values); return [1]; },
    },
  };
  const now = () => state.date;
  const googleActions = ['lead', 'schedule'].map((event, index) => ({ id: String(101 + index), name: event === 'lead' ? 'Lead - ClinicaClick' : 'Schedule - ClinicaClick',
    resource_name: `customers/10/conversionActions/${101 + index}`, type: 'UPLOAD_CLICKS', status: 'ENABLED',
    category: event === 'lead' ? 'SUBMIT_LEAD_FORM' : 'BOOK_APPOINTMENT', counting_type: 'MANY_PER_CLICK', primary_for_goal: false }));
  const prepare = async () => {
    await checkGooglePreparation({ models, scope, actorId: 2, hasAccess: async () => true, now,
      input: { account_id: '10', expected_version: state.setting.version }, ensureToken: async () => ({ accessToken: 'fake' }),
      list: async () => ({ actions: googleActions, clinicaclick_mapping: buildClinicaclickManagedMapping(googleActions) }),
      upload: async args => { assert.equal(args.validateOnly, true); state.calls.push('google_validate'); return {}; } });
    await checkMetaSignalPreparation({ models, scope, actorId: 2, hasAccess: async () => true, now,
      input: { account_id: '20', dataset_id: '301', expected_version: state.setting.version }, read: async path => {
        state.calls.push(path);
        if (path === 'me/permissions') return { data: { data: [{ permission: 'ads_management', status: 'granted' }] } };
        if (path === 'act_20') return { data: { id: 'act_20', account_id: '20' } };
        return { data: { data: [{ id: '301', name: 'Destino Meta' }] } };
      } });
  };
  const review = () => loadSignalAuthorizationReview({ models, scope, setting: state.setting, now: state.date });
  const authorize = async () => {
    const result = await review(); assert.equal(result.review.ready, true);
    // Simulate the future explicit activation transaction, not an API or customer write.
    state.setting.activation = { schema_version: 2, mode: 'measurement', status: 'active', account_authorizations: structuredClone(accounts),
      signals: { enabled: true, events: ['lead', 'schedule'], authorization: result.authorization } };
    return result;
  };
  const policy = input => resolveWorkspaceSignalPolicy({ ...input, models, now: state.date, loadSetting: async () => state.setting });
  const decision = (provider = 'meta_ads', extra = {}) => policy({ records: [record], provider, accountId: provider === 'meta_ads' ? '20' : '10',
    campaignId: '40', eventName: 'Lead', clinicId: 1, destinationId: provider === 'meta_ads' ? '301' : 'customers/10/conversionActions/101', ...extra });
  const googleUpload = (extra = {}) => maybeUploadGoogleConversion({ cfgRecord: record,
    googleAdsConfig: { enabled: true, customer_id: '10', events: { lead: { enabled: true, conversion_action_id: '101' } } },
    eventName: 'Lead', eventId: 'lead-1', clinicId: 1, assignmentScope: 'clinic', consentModeEnabled: true,
    customData: { gclid: 'fake-click', campaign_id: '40' }, consent: { ad_user_data: 'granted' },
    dependencies: { resolveWorkspaceSignalPolicy: policy,
      auditModel: { findOne: async () => null, create: async values => {
        const row = { ...values, id: 1, update: async patch => Object.assign(row, patch) };
        state.attempts.push(row); state.onGoogleReserve?.(); return row;
      } },
      resolveRuntime: async () => { state.onRuntime?.(); return { connection: { id: 8 }, loginCustomerId: null, accessToken: 'fake' }; },
      uploadConversion: async args => { state.uploads.push(args); return { requestId: 'fake-request' }; },
    }, ...extra });
  const metaUpload = () => sendWorkspaceMetaSignal({ eventName: 'Lead', eventTime: +state.date / 1000, eventId: 'lead-1', clinicId: 1,
    campaignId: '40', adAccountId: '20', pixelId: '301', advertisingConsent: true, webPolicyRecord: record, signalPolicyRecord: record,
    eventSourceUrl: 'https://example.com/', userData: { em: ['a'.repeat(64)], client_user_agent: 'qa' } },
  { models, now, send: async () => { state.uploads.push('meta'); return { data: { events_received: 1 } }; } });
  return { state, scope, models, record, prepare, review, authorize, decision, googleUpload, metaUpload };
}

test('real preparation services feed a private destination contract and a token-free read-only review', async () => {
  const h = harness(); assert.equal((await h.review()).review.ready, false); await h.prepare();
  const count = h.state.calls.length; const result = await h.review();
  assert.equal(result.review.ready, true); assert.equal(h.state.calls.length, count);
  assert.equal(h.state.setting.activation, undefined);
  assert.deepEqual(result.authorization.clinic_ids, [1]); assert.equal(result.authorization.destinations.length, 2);
  assert.deepEqual(result.authorization.destinations[0].events.map(row => row.destination_id), ['101', '102']);
  assert.doesNotMatch(JSON.stringify(result), /private-|accessToken|refreshToken/);
  assert.doesNotMatch(JSON.stringify(result.review), /grant_fingerprint|connection_id|proof_run_id/);
});
test('every selected account and event must be checked; partial, stale, forged or failed proofs do not yield a mandate', async () => {
  for (const mutate of [s => { s.setting.signal_preparation.meta_ads['20'].state = 'failed'; },
    s => { s.setting.signal_preparation.google_ads['10'].events.pop(); },
    s => { s.setting.signal_preparation.google_ads['10'].events[0].action_fingerprint = null; },
    s => { s.setting.signal_preparation.google_ads['10'].events[0].error = 'warning'; },
    s => { s.setting.signal_preparation.google_ads['10'].checked_at = '2028-01-01'; },
    s => { s.setting.signal_preparation.meta_ads['20'].expires_at = '2028-01-01'; },
    s => { s.setting.signal_preparation.meta_ads['20'].fingerprint = 'a'.repeat(64); },
    s => { s.setting.signal_preparation.meta_ads['20'].status = 'checking'; },
    s => { s.date = new Date(+s.date + 86400000); }]) {
    const h = harness(); await h.prepare(); mutate(h.state); const result = await h.review();
    assert.equal(result.review.ready, false); assert.equal(result.authorization, null);
  }
});
test('configuration responses keep the destination mandate private without altering the saved authorization', async () => {
  const h = harness(); await h.prepare(); await h.authorize();
  const original = structuredClone(h.state.setting.activation);
  const response = publicSettings(h.state.setting, h.scope);
  assert.deepEqual(response.activation.signals, { enabled: true, events: ['lead', 'schedule'] });
  assert.doesNotMatch(JSON.stringify(response), /grant_fingerprint|connection_id|proof_run_id/);
  assert.equal(response.activation.signals.authorization, undefined);
  assert.deepEqual(h.state.setting.activation, original);
});
test('the policy reads settings from the supplied models and transaction without using a separate database', async () => {
  const h = harness(); await h.prepare(); await h.authorize();
  const transaction = { LOCK: { UPDATE: 'UPDATE' } }; const calls = [];
  h.models.CampaignWorkspaceSetting.findByPk = async (id, options) => { calls.push(options); return h.state.setting; };
  const result = await resolveWorkspaceSignalPolicy({ records: [h.record], models: h.models, transaction, now: h.state.date,
    provider: 'meta_ads', accountId: '20', clinicId: 1, campaignId: '40', eventName: 'Lead', destinationId: '301' });
  assert.equal(result.allowed, true); assert.equal(calls.length, 1); assert.equal(calls[0].transaction, transaction);
});
test('both provider policies require the exact authorized destination, clinic and current connection', async () => {
  const h = harness(); await h.prepare(); await h.authorize();
  for (const provider of ['google_ads', 'meta_ads']) {
    assert.equal((await h.decision(provider)).authorizationSchema, 2);
    assert.equal((await h.decision(provider, { destinationId: '999' })).allowed, false);
    assert.equal((await h.decision(provider, { clinicId: 2 })).allowed, false);
    assert.equal((await h.decision(provider, { connectionId: 99 })).allowed, false);
    assert.equal((await h.decision(provider, { eventName: 'Purchase' })).allowed, false);
  }
  assert.equal((await h.decision('google_ads', { destinationId: 'customers/99/conversionActions/101' })).reason, 'workspace_signal_destination_not_authorized');
});
test('draft edits and expiring checks never silently edit a separately authorized destination', async () => {
  const h = harness(); await h.prepare(); await h.authorize();
  h.state.setting.preferences.signals = { enabled: false, events: [] }; h.state.setting.signal_preparation = null;
  h.state.date = new Date(+h.state.date + 86400000 * 2);
  assert.equal((await h.decision()).allowed, true); assert.equal((await h.decision('google_ads')).allowed, true);
  h.state.setting.activation.signals.enabled = false; assert.equal((await h.decision()).reason, 'workspace_signals_disabled');
});
test('grant replacement and deselection revoke runtime permission without relying on provider errors', async () => {
  for (const provider of ['google_ads', 'meta_ads']) {
    const h = harness(); await h.prepare(); await h.authorize();
    h.state[provider === 'google_ads' ? 'googleAssignment' : 'metaAssignment'].connectedAt = '2026-09-10T20:00:00Z';
    assert.equal((await h.decision(provider)).allowed, false);
  }
  const h = harness(); await h.prepare(); await h.authorize(); h.state.setting.accounts = [];
  assert.equal((await h.decision()).reason, 'workspace_account_not_authorized');
});
test('an inactive clinic cannot use a previously authorized destination', async () => {
  const h = harness(); await h.prepare(); await h.authorize(); h.state.clinic.estado_clinica = false;
  assert.equal((await h.decision()).reason, 'workspace_signal_clinic_inactive');
  assert.equal((await h.decision('google_ads')).reason, 'workspace_signal_clinic_inactive');
});
test('invalid or missing mandates cannot fall back to an account-only permission', async () => {
  for (const mutate of [a => { a.schema_version = 3; }, a => { a.clinic_ids.push(1); }, a => { a.destinations.push(a.destinations[1]); },
    a => { a.destinations[1].events.pop(); }, a => { a.destinations[1].grant_fingerprint = 'invalid'; }]) {
    const h = harness(); await h.prepare(); await h.authorize(); mutate(h.state.setting.activation.signals.authorization);
    assert.equal((await h.decision()).allowed, false);
  }
  const h = harness(); await h.prepare(); await h.authorize(); delete h.state.setting.activation.signals.authorization;
  assert.equal((await h.decision()).reason, 'workspace_signal_authorization_required');
  await assert.rejects(verifySignalDestination({ setting: h.state.setting, provider: 'google_ads', accountId: '.*' }), /workspace_signal_account_invalid/);
});
test('Google emitter consumes the destination-bound mandate and checks again after resolving OAuth runtime', async () => {
  const h = harness(); await h.prepare(); await h.authorize();
  assert.equal((await h.googleUpload()).sent, true); assert.equal(h.state.uploads.length, 1);
  assert.equal(h.state.uploads[0].conversionAction, 'customers/10/conversionActions/101');
  const revoked = harness(); await revoked.prepare(); await revoked.authorize();
  revoked.state.onRuntime = () => { revoked.state.google.googleUserId = 'replacement'; };
  const result = await revoked.googleUpload(); assert.equal(result.sent, false); assert.equal(revoked.state.uploads.length, 0);
  assert.equal(result.reason, 'workspace_signal_connection_changed');
});
test('Meta emitter consumes the same mandate contract and rejects a grant changed after reserving delivery', async () => {
  const h = harness(); await h.prepare(); await h.authorize(); assert.equal((await h.metaUpload()).sent, true);
  assert.equal(h.state.uploads.length, 1);
  const revoked = harness(); await revoked.prepare(); await revoked.authorize();
  revoked.state.onReserve = () => { revoked.state.meta.metaUserId = 'replacement'; };
  assert.equal((await revoked.metaUpload()).sent, false); assert.equal(revoked.state.uploads.length, 0);
  assert.equal(revoked.state.deliveries[0].status, 'skipped');
});
test('Google rechecks permission after audit reservation and records a terminal skip without sending', async () => {
  for (const mutate of [s => { s.google.googleUserId = 'replacement'; },
    s => { s.setting.activation.signals.enabled = false; }]) {
    const h = harness(); await h.prepare(); await h.authorize();
    h.state.onGoogleReserve = () => mutate(h.state);
    const result = await h.googleUpload();
    assert.equal(result.sent, false); assert.equal(h.state.uploads.length, 0);
    assert.equal(h.state.attempts[0].status, 'skipped');
    assert.equal(h.state.attempts[0].reason, result.reason);
    assert.ok(h.state.attempts[0].completedAt);
  }
});

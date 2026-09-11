'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { checkGooglePreparation } = require('../../services/campaignWorkspaceGooglePreparation.service');
const { checkMetaSignalPreparation } = require('../../services/campaignWorkspaceMetaSignalPreparation.service');
const { buildClinicaclickManagedMapping } = require('../../services/googleAdsConversionPreparation.service');
const { loadSignalAuthorizationReview, verifySignalDestination } = require('../../services/campaignWorkspaceSignalAuthorization.service');
const { resolveWorkspaceSignalPolicy } = require('../../services/campaignWorkspaceSignalPolicy.service');
const { publicSettings } = require('../../services/campaignWorkspaceSettings.service');
const { resolveWorkspaceSignalRoute } = require('../../services/campaignWorkspaceSignalRouting.service');
const { maybeUploadGoogleConversion } = require('../../services/googleAdsConversionUpload.service');
const { sendWorkspaceMetaSignal } = require('../../services/metaWorkspaceSignalDelivery.service');
const { maybeUploadCampaignGoogleConversion } = require('../../services/campaignWorkspaceGoogleConversion.service');
const { loadGoogleSignalEvidence } = require('../../services/campaignWorkspaceGoogleSignalEvidence.service');
const { maybeUploadLeadLifecycleConversion } = require('../../services/googleLeadLifecycleConversion.service');
const { reconcileGoogleDataManagerDiagnostics } = require('../../services/googleDataManagerDiagnostics.service');
const { activateWorkspace } = require('../../services/campaignWorkspaceActivation.service');

mock.method(require('../../../models').sequelize, 'query', async () => assert.fail('This suite must not access the real database'));

function harness() {
  const scope = { clinicIds: [1], groupId: null };
  const accounts = [{ provider: 'google_ads', account_id: '10', include_future: true, campaign_ids: [] },
    { provider: 'meta_ads', account_id: '20', include_future: true, campaign_ids: [] }];
  const state = { date: new Date('2026-09-10T21:00:00Z'), calls: [], audits: [], deliveries: [], uploads: [], attempts: [],
    clinic: { id_clinica: 1, grupoClinicaId: null, estado_clinica: true },
    setting: { id: 'setting', scope_type: 'clinic', scope_id: 1, version: 1, accounts,
      preferences: { mode: 'measurement', signals: { enabled: true, events: ['lead', 'schedule'] } }, signal_preparation: null },
    google: { id: 8, accessToken: 'private-google-token', googleUserId: 'private-google-principal',
      scopes: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/datamanager', expiresAt: '2027-01-01T00:00:00Z' },
    meta: { id: 7, accessToken: 'private-meta-token', metaUserId: 'private-meta-principal', expiresAt: '2027-01-01T00:00:00Z' },
    googleAssignment: { id: 9, assignmentScope: 'clinic', clinicaId: 1, scopeKey: 'clinic:1', status: 'active', googleConnectionId: 8, connectedAt: '2026-09-01T00:00:00Z' },
    metaAssignment: { id: 6, assignmentScope: 'clinic', clinicaId: 1, scopeKey: 'clinic:1', status: 'active', metaConnectionId: 7, connectedAt: '2026-09-01T00:00:00Z' },
  };
  state.setting.update = async values => Object.assign(state.setting, values);
  const record = { id: 1, assignment_scope: 'clinic', clinic_id: 1, config: { features: { consent_mode_enabled: true },
    meta_ads: { enabled: true, connection_id: 7, ad_account_id: '20', pixel_id: '301' },
    campaigns: { workspace_policy: { schema_version: 1, setting_id: 'setting', scope_type: 'clinic', scope_id: 1 } } } };
  Object.defineProperty(record, 'update', { value: async patch => Object.assign(record, patch) });
  const models = {
    sequelize: { transaction: async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
    Clinica: { findByPk: async () => state.clinic },
    CampaignWorkspaceSetting: { findAll: async () => [state.setting], findOne: async () => state.setting, findByPk: async () => state.setting },
    CampaignWorkspaceEvent: { create: async row => state.audits.push(row) },
    ClinicGoogleAdsAccount: { findAll: async () => [{ id: 5, customerId: '10', assignmentScope: 'clinic', clinicaId: 1, googleConnectionId: 8 }] },
    ClinicMetaAsset: { findAll: async () => [{ id: 4, metaAssetId: '20', assignmentScope: 'clinic', clinicaId: 1, metaConnectionId: 7 }] },
    GoogleConnectionAssignment: { findAll: async () => state.googleAssignment.status === 'active' ? [state.googleAssignment] : [] },
    MetaConnectionAssignment: { findAll: async () => state.metaAssignment.status === 'active' ? [state.metaAssignment] : [],
      findOne: async () => state.metaAssignment.status === 'active' ? state.metaAssignment : null },
    GoogleConnection: { findByPk: async () => state.google }, MetaConnection: { findByPk: async () => state.meta },
    IntakeConfig: { findOne: async () => record, findAll: async () => [record] },
    CampaignOptimizationPolicy: { findAll: async () => [] },
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
    const campaigns = accounts.map(account => ({ id: `${account.provider}:${account.account_id}:40`, provider: account.provider,
      account_id: account.account_id, campaign_id: '40', clinicId: 1, assigned: true, destination: 'web' }));
    // The real command consumes prepared evidence inside isolated models; no customer is activated.
    await activateWorkspace({ models, scope, actorId: 2, now, hasAccess: async () => true, deploymentReady: true,
      input: { expected_version: state.setting.version, preparation_revision: 'a'.repeat(64), mode: 'measurement', signals: { enabled: true }, confirmed: true },
      loadPreparation: async () => ({ revision: 'a'.repeat(64), selectionConfirmed: true, receptionReady: true, signals: result.review,
        campaigns: campaigns.map(campaign => ({ campaign, ready: true, configurationScope: null })) }),
      loadInventory: async () => ({ campaigns, google: [{ customerId: '10' }], meta: [{ metaAssetId: '20' }], groups: scope.groupId ? [scope.groupId] : [] }) });
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
  models.GoogleAdsConversionUploadAttempt = {
    findAll: async () => state.attempts,
    findOne: async ({ where }) => state.attempts.find(row => row.dedupeKey === where.dedupeKey),
    create: async values => {
      const row = { ...values, id: state.attempts.length + 1, attemptedAt: state.date, update: async patch => Object.assign(row, patch) };
      state.attempts.push(row); state.onGoogleReserve?.(); return row;
    },
  };
  const workspaceDependencies = { models, now,
    ensureToken: async connection => { state.onRuntime?.(); return { accessToken: connection.accessToken }; },
    uploadConversion: async args => { state.uploads.push(args); return { requestId: 'workspace-google-receipt' }; },
  };
  const workspaceGoogleUpload = (extra = {}) => maybeUploadCampaignGoogleConversion({ cfgRecord: record, clinicId: 1,
    eventName: 'Lead', eventId: 'lead-web', customData: { customer_id: '10', campaign_id: '40', gclid: 'test-click' },
    consent: { ad_user_data: 'granted', ad_personalization: 'denied' }, dependencies: workspaceDependencies, ...extra });
  const googleHealth = (extra = {}) => loadGoogleSignalEvidence({ models, selectedClinics: [state.clinic], now: state.date,
    campaigns: [{ id: 'google_ads:10:40', provider: 'google_ads', account_id: '10', campaign_id: '40', assigned: true, clinicId: 1 }], ...extra });
  return { state, scope, models, record, prepare, review, authorize, decision, googleUpload, metaUpload,
    workspaceGoogleUpload, workspaceDependencies, googleHealth };
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
test('the route resolves the prepared Google and Meta destinations without using website settings or remote APIs', async () => {
  const h = harness(); await h.prepare(); await h.authorize(); const count = h.state.calls.length;
  h.models.IntakeConfig = { findOne: () => assert.fail('no website lookup'), findAll: () => assert.fail('no website lookup') };
  for (const provider of ['google_ads', 'meta_ads']) {
    const result = await resolveWorkspaceSignalRoute({ models: h.models, clinicId: 1, provider,
      accountId: provider === 'google_ads' ? '10' : '20', campaignId: '40', eventName: 'Lead', now: h.state.date });
    assert.equal(result.destinationId, provider === 'google_ads' ? '101' : '301');
    assert.equal(result.authorization.authorizationSchema, 2); assert.equal(result.authorization.policyRefs.length, 1);
    assert.equal(result.connectionId, provider === 'google_ads' ? 8 : 7); assert.match(result.destinationKey, /^[a-f0-9]{64}$/);
  }
  assert.equal(h.state.calls.length, count); assert.equal(h.state.uploads.length, 0);
});
test('a revoked or incomplete v2 route cannot fall back to an old web target', async () => {
  for (const mutate of [s => { s.setting.accounts = []; }, s => { s.setting.activation.signals.enabled = false; },
    s => { s.setting.activation.signals.authorization = null; }, s => { s.setting.activation.schema_version = 3; },
    s => { s.meta.metaUserId = 'replacement'; }]) {
    const h = harness(); await h.prepare(); await h.authorize(); mutate(h.state);
    await assert.rejects(resolveWorkspaceSignalRoute({ models: h.models, clinicId: 1, provider: 'meta_ads', accountId: '20',
      campaignId: '40', eventName: 'Lead', now: h.state.date }), /workspace_/);
  }
});
test('clinic and group mandates intersect; conflicting destinations or a mixed schema require review', async () => {
  const clinic = harness(); clinic.state.clinic.grupoClinicaId = 8;
  await clinic.prepare(); await clinic.authorize();
  const group = harness(); group.scope.groupId = 8; group.state.clinic.grupoClinicaId = 8;
  Object.assign(group.state.setting, { id: 'group-setting', scope_type: 'group', scope_id: 8 });
  for (const h of [clinic, group]) {
    h.models.GrupoClinica = { findByPk: async () => ({ id: 8 }) };
    h.models.Clinica.findAll = async () => [h.state.clinic];
  }
  await group.prepare(); await group.authorize();
  clinic.models.CampaignWorkspaceSetting.findAll = async () => [clinic.state.setting, group.state.setting];
  clinic.models.CampaignWorkspaceSetting.findOne = async ({ where }) => where.scope_type === 'group' ? group.state.setting : clinic.state.setting;
  const route = () => resolveWorkspaceSignalRoute({ models: clinic.models, clinicId: 1, provider: 'meta_ads', accountId: '20',
    campaignId: '40', eventName: 'Lead', now: clinic.state.date });
  assert.equal((await route()).authorization.policyRefs.length, 2);
  group.state.setting.activation.signals.authorization.destinations[1].events[0].destination_id = '999';
  await assert.rejects(route(), /workspace_signal_routes_conflict/);
  group.state.setting.activation.schema_version = 1;
  await assert.rejects(route(), /workspace_signal_scope_migration_required/);
});

test('prepared Google web routing uses the mandate without an advertising config or changing widgets', async () => {
  const h = harness(); await h.prepare(); await h.authorize();
  h.record.config = { features: { consent_mode_enabled: true, tel_modal_enabled: true }, widget: { title: 'Existing widget' } };
  const before = structuredClone(h.record);
  const result = await h.workspaceGoogleUpload();
  assert.equal(result.sent, true); assert.equal(result.destination_count, 1);
  assert.equal(h.state.uploads[0].conversionAction, 'customers/10/conversionActions/101');
  assert.equal(h.state.uploads[0].accessToken, 'private-google-token');
  assert.equal(h.state.uploads[0].email, undefined); assert.equal(h.state.uploads[0].phone, undefined);
  assert.deepEqual(h.record, before);
  const proof = h.state.attempts[0].requestMetadata.workspace_delivery;
  assert.equal(proof.schema_version, 2); assert.doesNotMatch(JSON.stringify(proof), /private-|accessToken|refreshToken|widget/);
  const health = (await h.googleHealth()).get('google_ads:10:40');
  assert.equal(health.checked, true); assert.equal(health.processing, 1); assert.equal(health.ready, false);
  assert.match(health.detail, /No confirma su atribución/);
  const duplicate = await h.workspaceGoogleUpload();
  assert.equal(duplicate.reason, 'duplicate_already_accepted'); assert.equal(h.state.uploads.length, 1);
});

test('Google workspace routing never fans out to old web destinations or accepts a browser action override', async () => {
  const h = harness(); await h.prepare(); await h.authorize();
  h.record.config.google_ads = { enabled: true, customer_id: '999', conversion_action_id: '666',
    destinations: [{ customer_id: '999', conversion_action_id: '666' }] };
  assert.equal((await h.workspaceGoogleUpload()).sent, true);
  assert.equal(h.state.uploads.length, 1); assert.equal(h.state.uploads[0].customerId, '10');
  const denied = await h.workspaceGoogleUpload({ eventId: 'override', customData: { customer_id: '10', campaign_id: '40',
    gclid: 'click-2', conversion_action_id: '666' } });
  assert.equal(denied.reason, 'request_target_override_not_allowed'); assert.equal(h.state.uploads.length, 1);
  const foreign = await h.workspaceGoogleUpload({ customData: { customer_id: '999', campaign_id: '40', gclid: 'click-2' } });
  assert.equal(foreign.reason, 'workspace_account_not_authorized'); assert.equal(h.state.uploads.length, 1);
});

test('Google workspace routing rechecks consent, membership and the grant after reserving an upload', async () => {
  for (const mutate of [h => { h.state.setting.activation.signals.enabled = false; },
    h => { h.record.config.features.consent_mode_enabled = false; },
    h => { h.record.id = 999; }, h => { h.state.google.googleUserId = 'different-grant'; },
    h => { h.state.clinic.estado_clinica = false; },
    h => { h.record.config.google_ads = { user_data_enabled: true }; }]) {
    const h = harness(); await h.prepare(); await h.authorize(); h.state.onGoogleReserve = () => mutate(h);
    const result = await h.workspaceGoogleUpload();
    assert.equal(result.sent, false); assert.match(result.reason, /^workspace_/);
    assert.equal(h.state.uploads.length, 0); assert.equal(h.state.attempts[0].status, 'skipped');
  }
});

test('Google workspace mandates never replace visitor consent or verified CRM milestones', async () => {
  const h = harness(); await h.prepare(); await h.authorize();
  for (const consent of [null, { analytics: true }, { ad_user_data: 'denied' }, { ad_user_data: 'granted', marketing: false }]) {
    assert.equal((await h.workspaceGoogleUpload({ consent })).reason, 'consent_not_granted');
  }
  const publicAppointment = await h.workspaceGoogleUpload({ eventName: 'Schedule', eventId: 'appointment',
    customData: { customer_id: '10', campaign_id: '40', gclid: 'test-click', crmEventSource: 'campaign_crm_milestone' } });
  assert.equal(publicAppointment.reason, 'workspace_crm_milestone_required'); assert.equal(h.state.uploads.length, 0);
});

test('the existing CRM lifecycle reaches the prepared Google destination without web advertising settings', async () => {
  const h = harness(); await h.prepare(); await h.authorize(); delete h.record.config.google_ads;
  h.models.Clinica.findOne = async () => h.state.clinic;
  const result = await maybeUploadLeadLifecycleConversion({
    lead: { id: 1, clinica_id: 1, google_ads_customer_id: '10', google_ads_campaign_id: '40', gclid: 'test-click',
      consentimiento_canal: { ad_user_data: 'granted', ad_personalization: 'denied' } },
    eventName: 'Schedule', eventId: 'appointment-1', occurredAt: h.state.date,
    dependencies: { ...h.models, maybeUploadGoogleConversion: input => maybeUploadCampaignGoogleConversion({ ...input, dependencies: h.workspaceDependencies }) },
  });
  assert.equal(result.sent, true); assert.equal(h.state.uploads[0].conversionAction, 'customers/10/conversionActions/102');
  assert.equal((await h.googleHealth()).get('google_ads:10:40').processing, 1);
});

test('Google report checks v2 receipts against current web and campaign permission, not a credential refresh', async () => {
  const h = harness(); await h.prepare(); await h.authorize(); await h.workspaceGoogleUpload();
  h.state.google.accessToken = 'rotated'; h.record.config.widget = { title: 'Changed appearance' };
  h.workspaceDependencies.ensureToken = () => assert.fail('Health cannot refresh tokens');
  assert.equal((await h.googleHealth()).get('google_ads:10:40').checked, true);
  const calls = h.state.calls.length; const writes = h.state.attempts.length;
  h.state.setting.activation.signals.enabled = false;
  assert.equal((await h.googleHealth()).get('google_ads:10:40').checked, false);
  assert.equal(h.state.calls.length, calls); assert.equal(h.state.attempts.length, writes);
  assert.equal((await h.googleHealth({ selectedClinics: [] })).size, 0);
});

test('Google workspace permits the sole selected account but does not infer one of several accounts', async () => {
  const h = harness(); await h.prepare(); await h.authorize();
  assert.equal((await h.workspaceGoogleUpload({ customData: { gclid: 'click-no-account', campaign_id: '40' } })).sent, true);
  const second = { provider: 'google_ads', account_id: '11', include_future: true, campaign_ids: [] };
  h.state.setting.accounts.push(second); h.state.setting.activation.account_authorizations.push(second);
  const result = await h.workspaceGoogleUpload({ eventId: 'ambiguous', customData: { gclid: 'click-no-account', campaign_id: '40' } });
  assert.equal(result.reason, 'workspace_signal_account_ambiguous'); assert.equal(h.state.uploads.length, 1);
});

test('Google v2 receipts move from processing to processed through the existing Diagnostics job', async () => {
  const h = harness(); await h.prepare(); await h.authorize(); await h.workspaceGoogleUpload();
  h.state.date = new Date(+h.state.date + 3600000);
  const result = await reconcileGoogleDataManagerDiagnostics({ attemptModel: h.models.GoogleAdsConversionUploadAttempt,
    connectionModel: h.models.GoogleConnection, now: h.state.date, ensureAccessToken: async () => ({ accessToken: 'test' }),
    retrieveStatus: async ({ requestId }) => {
      assert.equal(requestId, 'workspace-google-receipt');
      return { requestStatusPerDestination: [{ destination: { operatingAccount: { accountId: '10' }, productDestinationId: '101' },
        requestStatus: 'SUCCESS', eventsIngestionStatus: { recordCount: '1' } }] };
    } });
  assert.equal(result.succeeded, 1);
  const health = (await h.googleHealth()).get('google_ads:10:40');
  assert.equal(health.ready, true); assert.equal(health.processed, 1); assert.equal(health.processing, 0);
  h.state.attempts[0].conversionAction = 'customers/10/conversionActions/999';
  assert.equal((await h.googleHealth()).get('google_ads:10:40').checked, false);
});

test('Google group web routing requires explicit location membership and the effective installation', async () => {
  const h = harness(); h.scope.groupId = 8; h.state.clinic.grupoClinicaId = 8;
  Object.assign(h.state.setting, { scope_type: 'group', scope_id: 8 });
  h.models.GrupoClinica = { findByPk: async () => ({ id: 8 }) };
  h.models.Clinica.findAll = async () => [h.state.clinic];
  Object.assign(h.record, { assignment_scope: 'group', group_id: 8, clinic_id: null });
  h.record.config = { features: { consent_mode_enabled: true }, locations: [{ id: 1 }] };
  h.models.IntakeConfig.findOne = async ({ where }) => where.assignment_scope === 'group' ? h.record : null;
  await h.prepare(); await h.authorize();
  assert.equal((await h.workspaceGoogleUpload()).sent, true);
  assert.equal((await h.googleHealth()).get('google_ads:10:40').processing, 1);
  const missingClinic = await h.workspaceGoogleUpload({ clinicId: null });
  assert.equal(missingClinic.reason, 'workspace_clinic_required');
  h.record.config.locations = [{ id: 2 }];
  assert.equal((await h.workspaceGoogleUpload({ eventId: 'other-location' })).reason, 'workspace_signal_web_scope_changed');
  assert.equal((await h.googleHealth()).get('google_ads:10:40').checked, false);
  assert.equal(h.state.uploads.length, 1);
});

test('Google delivery cannot continue when token resolution changes the grant or the mandate is malformed', async () => {
  const h = harness(); await h.prepare(); await h.authorize();
  h.state.onRuntime = () => { h.state.googleAssignment.connectedAt = '2026-09-10T20:00:00Z'; };
  assert.equal((await h.workspaceGoogleUpload()).sent, false); assert.equal(h.state.uploads.length, 0);
  for (const mutate of [s => { s.setting.activation.schema_version = 3; },
    s => { s.setting.activation.signals.authorization = null; },
    s => { s.google.expiresAt = '2020-01-01'; },
    s => { s.google.scopes = 'https://www.googleapis.com/auth/adwords'; }]) {
    const f = harness(); await f.prepare(); await f.authorize(); mutate(f.state);
    assert.equal((await f.workspaceGoogleUpload()).sent, false); assert.equal(f.state.uploads.length, 0);
  }
});

test('revoking a nested enhanced-conversion authorization during reservation invalidates the policy snapshot', async () => {
  const h = harness(); await h.prepare(); await h.authorize();
  h.record.config.google_ads = { enhanced_conversions: { enabled: true, allowlist: [{ enabled: true }] } };
  h.state.onGoogleReserve = () => { h.record.config.google_ads.enhanced_conversions.allowlist[0].enabled = false; };
  const result = await h.workspaceGoogleUpload();
  assert.equal(result.sent, false); assert.equal(result.reason, 'workspace_signal_connection_changed');
  assert.equal(h.state.uploads.length, 0);
});

test('Google Health shares scope and grant reads within a request but checks each campaign separately', async () => {
  const h = harness(); await h.prepare(); await h.authorize(); await h.workspaceGoogleUpload();
  await h.workspaceGoogleUpload({ eventId: 'lead-41', customData: { customer_id: '10', campaign_id: '41', gclid: 'click-41' } });
  let scopeReads = 0; let grantReads = 0; let configReads = 0;
  const findScopes = h.models.CampaignWorkspaceSetting.findAll;
  const findMappings = h.models.ClinicGoogleAdsAccount.findAll;
  const findConfigs = h.models.IntakeConfig.findAll;
  h.models.CampaignWorkspaceSetting.findAll = args => { scopeReads++; return findScopes(args); };
  h.models.ClinicGoogleAdsAccount.findAll = args => { grantReads++; return findMappings(args); };
  h.models.IntakeConfig.findAll = args => { configReads++; return findConfigs(args); };
  h.models.IntakeConfig.findOne = () => assert.fail('Health must use bulk-loaded installation records');
  const campaigns = ['40', '41'].map(id => ({ id: `google_ads:10:${id}`, provider: 'google_ads', account_id: '10', campaign_id: id, assigned: true, clinicId: 1 }));
  assert.equal((await h.googleHealth({ campaigns })).get('google_ads:10:41').processing, 1);
  assert.equal(scopeReads, 1); assert.equal(grantReads, 1); assert.equal(configReads, 1);
  h.state.setting.accounts[0] = { ...h.state.setting.accounts[0], include_future: false, campaign_ids: ['40'] };
  const after = await h.googleHealth({ campaigns });
  assert.equal(after.get('google_ads:10:40').processing, 1); assert.equal(after.get('google_ads:10:41').checked, false);
  assert.equal(scopeReads, 2); assert.equal(grantReads, 2); assert.equal(configReads, 2);
});

test('scopes without a new mandate preserve the existing Google upload behavior', async () => {
  const h = harness(); h.state.setting.activation = null;
  h.record.config = { features: { consent_mode_enabled: true }, google_ads: { enabled: true, customer_id: '10',
    events: { lead: { enabled: true, conversion_action_id: '500' } } } };
  h.workspaceDependencies.resolveRuntime = async () => ({ connection: h.state.google, accessToken: 'legacy-scoped-token' });
  const result = await h.workspaceGoogleUpload();
  assert.equal(result.sent, true); assert.equal(h.state.uploads[0].conversionAction, 'customers/10/conversionActions/500');
  assert.equal(h.state.attempts[0].requestMetadata.workspace_delivery, undefined);
});

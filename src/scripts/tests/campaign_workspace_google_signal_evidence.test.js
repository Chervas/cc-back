'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { googleDeliveryContext } = require('../../services/googleWorkspaceDeliveryContext.service');
const { loadGoogleSignalEvidence, googleDeliveryEvidence, MAX_ROWS } = require('../../services/campaignWorkspaceGoogleSignalEvidence.service');
const { maybeUploadGoogleConversion } = require('../../services/googleAdsConversionUpload.service');
const { resolveWorkspaceSignalPolicy } = require('../../services/campaignWorkspaceSignalPolicy.service');
const { buildWorkspaceHealth } = require('../../services/campaignWorkspaceHealth.service');
const { reconcileGoogleDataManagerDiagnostics } = require('../../services/googleDataManagerDiagnostics.service');

function harness() {
  const now = new Date('2026-09-10T20:00:00Z');
  const account = { id: 3, assignmentScope: 'clinic', clinicaId: 1, grupoClinicaId: null, googleConnectionId: 2,
    customerId: '123', isActive: true, loginCustomerId: null };
  const connection = { id: 2, googleUserId: 'private-google-identity', scopes: 'https://www.googleapis.com/auth/datamanager',
    accessToken: 'private-token', refreshToken: 'private-refresh', expiresAt: new Date(+now + 3600000) };
  const selected = { provider: 'google_ads', account_id: '123', include_future: false, campaign_ids: ['7'] };
  const setting = { id: 'setting', scope_type: 'clinic', scope_id: 1, version: 4, accounts: [selected], activation: {
    schema_version: 1, mode: 'measurement', status: 'active', signals: { enabled: true, events: ['lead', 'schedule'] }, account_authorizations: [selected],
  } };
  const record = { id: 10, assignment_scope: 'clinic', clinic_id: 1, config: { features: { consent_mode_enabled: true },
    google_ads: { enabled: true, customer_id: '123', events: { lead: { enabled: true, conversion_action_id: '900' } } },
    campaigns: { workspace_policy: { schema_version: 1, setting_id: 'setting', scope_type: 'clinic', scope_id: 1 } },
  } };
  const runtime = { account, connection, connectionSource: 'mapping_clinic', loginCustomerId: null };
  const policy = { applicable: true, allowed: true, policyRefs: [{ setting_id: 'setting', scope_type: 'clinic', scope_id: 1, version: 4 }] };
  const proof = () => googleDeliveryContext({ cfgRecord: record, runtime, policy, campaignId: '7' });
  const row = { clinicaId: 1, grupoClinicaId: null, intakeConfigId: 10, assignmentScope: 'clinic', customerId: '123',
    googleConnectionId: 2, connectionSource: 'mapping_clinic', loginCustomerId: null, eventName: 'lead',
    destinationKey: 'legacy_123', conversionAction: 'customers/123/conversionActions/900', status: 'succeeded', providerRequestId: 'request-1',
    attemptedAt: new Date(+now - 3600000), completedAt: new Date(+now - 1000), requestMetadata: { workspace_delivery: proof() },
    responseMetadata: { destinations: [{ status: 'SUCCESS', customer_id: '123', conversion_action_id: '900', record_count: 1, errors: [], warnings: [] }] },
  };
  const state = { rows: [row], records: [record], selectedClinics: [{ id_clinica: 1, grupoClinicaId: null }], account, connection, setting,
    assignment: { id: 6, scopeKey: 'clinic:1', assignmentScope: 'clinic', clinicaId: 1, googleConnectionId: 2,
      status: 'active', connectedAt: new Date(+now - 86400000) }, queries: [], uploads: [], writes: [] };
  const models = {
    GoogleAdsConversionUploadAttempt: { findAll: async query => { state.queries.push(['attempts', query]); return state.rows; } },
    IntakeConfig: { findAll: async query => { state.queries.push(['config', query]); return state.records; } },
    ClinicGoogleAdsAccount: { findAll: async query => { state.queries.push(['mapping', query]); return state.account ? [state.account] : []; } },
    GoogleConnection: { findByPk: async () => state.connection },
    GoogleConnectionAssignment: { findOne: async ({ where }) => {
      const match = state.assignment;
      return match && match.scopeKey === where.scopeKey && match.googleConnectionId === where.googleConnectionId && match.status === where.status ? match : null;
    } }, CampaignWorkspaceSetting: { findByPk: async () => state.setting },
  };
  const campaign = { id: 'google_ads:123:7', provider: 'google_ads', account_id: '123', campaign_id: '7', assigned: true, clinicId: 1 };
  const run = extra => loadGoogleSignalEvidence({ models, campaigns: [campaign], selectedClinics: state.selectedClinics, now, ...extra });
  return { state, record, row, runtime, policy, proof, models, campaign, run, now };
}

test('Google delivery context is server-built, stable and contains no credentials or contacts', () => {
  const h = harness(); const proof = h.proof();
  assert.equal(proof.schema_version, 1); assert.equal(proof.campaign_id, '7'); assert.match(proof.fingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(proof), /private-|email|token|user_data|currency|value/);
  h.record.config = Object.fromEntries(Object.entries(h.record.config).reverse());
  h.runtime.connection.accessToken = 'rotated'; h.runtime.connection.refreshToken = 'rotated';
  assert.deepEqual(h.proof(), proof);
  h.policy.policyRefs[0].version++; assert.notEqual(h.proof().fingerprint, proof.fingerprint);
});
test('incomplete or legacy context cannot mint campaign evidence', () => {
  const h = harness();
  for (const patch of [{ policy: {} }, { policy: { applicable: true, allowed: true, policyRefs: [null] } },
    { cfgRecord: null }, { runtime: {} }, { campaignId: '7/private' }]) {
    assert.equal(googleDeliveryContext({ cfgRecord: h.record, runtime: h.runtime, policy: h.policy, campaignId: '7', ...patch }), null);
  }
});
test('the actual uploader records context without sending that metadata to Google', async () => {
  const h = harness(); const audits = [];
  await maybeUploadGoogleConversion({ cfgRecord: h.record, eventName: 'lead', eventId: 'private-event', clinicId: 1,
    assignmentScope: 'clinic', customData: { gclid: 'test-click', campaign_id: '7', workspace_delivery: { fingerprint: 'forged' } },
    consent: { ad_user_data: 'granted' }, dependencies: {
      auditModel: { findOne: async () => null, create: async values => {
        const row = { ...values, id: 1, update: async patch => Object.assign(row, patch) }; audits.push(row); return row;
      } }, resolveRuntime: async () => h.runtime,
      resolveWorkspaceSignalPolicy: input => resolveWorkspaceSignalPolicy({ ...input, loadSetting: async () => h.state.setting }),
      uploadConversion: async payload => { h.state.uploads.push(payload); return { requestId: 'test' }; },
    } });
  assert.deepEqual(audits[0].requestMetadata.workspace_delivery, h.proof());
  assert.equal(h.state.uploads.length, 1); assert.doesNotMatch(JSON.stringify(h.state.uploads[0]), /workspace_delivery|fingerprint|policyRefs/);
});
test('uploader, persisted diagnostics and Health share the same delivery contract end to end', async () => {
  const h = harness(); const audits = [];
  const auditModel = { findOne: async () => null, findAll: async () => audits,
    create: async values => { const row = { ...values, id: 1, attemptedAt: new Date(+h.now - 3600000),
      update: async patch => Object.assign(row, patch) }; audits.push(row); return row; } };
  await maybeUploadGoogleConversion({ cfgRecord: h.record, eventName: 'lead', eventId: 'pipeline-1', clinicId: 1,
    assignmentScope: 'clinic', customData: { gclid: 'test-click', campaign_id: '7' }, consent: { ad_user_data: 'granted' },
    dependencies: { auditModel, resolveRuntime: async () => h.runtime,
      resolveWorkspaceSignalPolicy: input => resolveWorkspaceSignalPolicy({ ...input, loadSetting: async () => h.state.setting }),
      uploadConversion: async () => ({ requestId: 'pipeline-request' }),
    } });
  h.state.rows = audits;
  assert.equal((await h.run()).get(h.campaign.id).processing, 1);
  const result = await reconcileGoogleDataManagerDiagnostics({ attemptModel: auditModel,
    connectionModel: h.models.GoogleConnection, now: h.now, ensureAccessToken: async () => ({ accessToken: 'test-only' }),
    retrieveStatus: async ({ requestId }) => {
      assert.equal(requestId, 'pipeline-request');
      return { requestStatusPerDestination: [{ destination: { operatingAccount: { accountId: '123' }, productDestinationId: '900' },
        requestStatus: 'SUCCESS', eventsIngestionStatus: { recordCount: '1' } }] };
    } });
  assert.equal(result.succeeded, 1); assert.equal(audits[0].responseMetadata.destinations[0].record_count, 1);
  const evidence = (await h.run()).get(h.campaign.id);
  assert.equal(evidence.ready, true); assert.equal(evidence.processed, 1); assert.equal(evidence.processing, 0);
  h.state.setting.activation.signals.enabled = false;
  assert.notEqual((await h.run()).get(h.campaign.id)?.ready, true);
});
test('a current receipt uses the existing scoped runtime and remains distinct from attribution', async () => {
  const h = harness(); const result = (await h.run()).get(h.campaign.id);
  assert.equal(result.ready, true); assert.equal(result.processed, 1); assert.equal(result.received, 1);
  assert.match(result.detail, /No confirma su atribución/);
  const query = h.state.queries.find(([kind]) => kind === 'attempts')[1];
  assert.deepEqual(query.where[Op.or], [{ clinicaId: 1, customerId: '123' }]); assert.equal(query.limit, MAX_ROWS + 1);
  assert.ok(query.where.attemptedAt[Op.between]);
  assert.doesNotMatch(JSON.stringify(query.attributes), /clickId|lastErrorMessage|history|eventId/);
});
test('accepted means processing, not successfully processed; warnings never produce OK', () => {
  const h = harness();
  const accepted = googleDeliveryEvidence([{ ...h.row, status: 'accepted', completedAt: null }], h.now);
  assert.equal(accepted.ready, false); assert.equal(accepted.received, 1); assert.equal(accepted.processing, 1); assert.equal(accepted.processed, 0);
  assert.match(accepted.detail, /1 recibido, pendiente de procesamiento/);
  for (const status of ['pending', 'failed', 'skipped', 'partial_success']) {
    assert.equal(googleDeliveryEvidence([{ ...h.row, status }], h.now).ready, false);
  }
  h.row.responseMetadata.destinations[0].warnings.push({ reason: 'warning' });
  assert.equal(googleDeliveryEvidence([h.row], h.now).warnings, 1);
  assert.equal(googleDeliveryEvidence([h.row], h.now).ready, false);
});
test('a generic or mismatched diagnostic, missing request ID or invalid completion is not proof', () => {
  const h = harness();
  for (const patch of [{ responseMetadata: null }, { status: 'invented' }, { providerRequestId: null }, { completedAt: null },
    { completedAt: '2099-01-01' }, { completedAt: '2020-01-01' },
    { responseMetadata: { destinations: [{ ...h.row.responseMetadata.destinations[0], customer_id: '999' }] } },
    { responseMetadata: { destinations: [{ ...h.row.responseMetadata.destinations[0], record_count: 0 }] } },
    { responseMetadata: { destinations: [{ ...h.row.responseMetadata.destinations[0], conversion_action_id: '901' }] } }]) {
    assert.equal(googleDeliveryEvidence([{ ...h.row, ...patch }], h.now).checked, false);
  }
});
test('old, truncated, legacy and empty histories never turn the block green', async () => {
  for (const rows of [[], Array.from({ length: MAX_ROWS + 1 }, () => ({}))]) {
    const h = harness(); h.state.rows = rows; assert.equal((await h.run()).size, 0);
  }
  for (const patch of [{ requestMetadata: {} }, { attemptedAt: '2026-09-08T00:00:00Z' }, { attemptedAt: '2099-01-01' }]) {
    const h = harness(); Object.assign(h.row, patch); assert.equal((await h.run()).size, 0);
  }
});
test('other clinics, accounts, campaigns, actions, grants or configurations cannot lend evidence', async () => {
  for (const patch of [{ clinicaId: 2 }, { grupoClinicaId: 28 }, { customerId: '999' }, { intakeConfigId: 11 }, { assignmentScope: 'group' },
    { googleConnectionId: 8 }, { connectionSource: 'mapping_group' }, { loginCustomerId: '999' }, { eventName: 'purchase' },
    { destinationKey: 'other' }, { conversionAction: 'customers/123/conversionActions/901' },
    { requestMetadata: { workspace_delivery: { schema_version: 1, campaign_id: '8', fingerprint: 'x' } } }]) {
    const h = harness(); Object.assign(h.row, patch); assert.notEqual((await h.run()).get(h.campaign.id)?.ready, true);
  }
});
test('current revocation, reconnection or configuration changes invalidate earlier receipts', async () => {
  for (const mutate of [h => { h.state.setting.version++; }, h => { h.state.setting.activation.signals.enabled = false; },
    h => { h.state.assignment.status = 'revoked'; }, h => { h.state.assignment.connectedAt = h.now; },
    h => { h.state.assignment.connectedAt = null; }, h => { h.state.connection.scopes = ''; },
    h => { h.state.connection.googleUserId = 'changed'; }, h => { h.state.account.id++; },
    h => { h.record.config.features.consent_mode_enabled = false; }, h => { h.record.config.google_ads.events.lead.enabled = false; },
    h => { h.record.config.google_ads.events.lead.conversion_action_id = '901'; }, h => { h.state.account = null; }]) {
    const h = harness(); mutate(h); assert.notEqual((await h.run()).get(h.campaign.id)?.ready, true);
  }
});
test('a report read never refreshes Google tokens or writes diagnostics', async () => {
  const h = harness(); h.state.connection.expiresAt = '2020-01-01';
  h.state.connection.update = () => { throw new Error('GET must not write'); };
  assert.equal((await h.run()).get(h.campaign.id).ready, true);
  h.state.connection.refreshToken = null; assert.notEqual((await h.run()).get(h.campaign.id)?.ready, true);
});
test('a group advertiser is only used by an explicitly covered clinic', async () => {
  const h = harness();
  h.state.selectedClinics[0].grupoClinicaId = 28;
  Object.assign(h.record, { assignment_scope: 'group', clinic_id: null, group_id: 28 });
  h.record.config.locations = [{ id: 1 }];
  Object.assign(h.record.config.campaigns.workspace_policy, { scope_type: 'group', scope_id: 28 });
  Object.assign(h.state.setting, { scope_type: 'group', scope_id: 28 });
  Object.assign(h.policy.policyRefs[0], { scope_type: 'group', scope_id: 28 });
  Object.assign(h.runtime.account, { assignmentScope: 'group', clinicaId: null, grupoClinicaId: 28 });
  h.runtime.connectionSource = 'mapping_group';
  Object.assign(h.state.assignment, { scopeKey: 'group:28', assignmentScope: 'group', clinicaId: null, grupoClinicaId: 28 });
  Object.assign(h.row, { assignmentScope: 'group', grupoClinicaId: 28, connectionSource: 'mapping_group' });
  h.row.requestMetadata.workspace_delivery = h.proof();
  assert.equal((await h.run()).get(h.campaign.id).ready, true);
  h.record.config.locations = [{ id: 2 }]; assert.equal((await h.run()).size, 0);
});
test('Meta and unassigned inventory never cause a Google history query', async () => {
  const h = harness();
  assert.equal((await h.run({ campaigns: [{ ...h.campaign, provider: 'meta_ads' }, { ...h.campaign, assigned: false }] })).size, 0);
  assert.equal(h.state.queries.length, 0);
});
test('separate web and advertiser policies both bind inherited Google receipts', async () => {
  const h = harness(); h.state.selectedClinics[0].grupoClinicaId = 28;
  const advertiser = { id: 11, assignment_scope: 'group', group_id: 28, config: { google_ads: h.record.config.google_ads,
    campaigns: { workspace_policy: { schema_version: 1, setting_id: 'group-setting', scope_type: 'group', scope_id: 28 } } } };
  delete h.record.config.google_ads;
  const groupSetting = structuredClone(h.state.setting);
  Object.assign(groupSetting, { id: 'group-setting', scope_type: 'group', scope_id: 28 });
  h.models.CampaignWorkspaceSetting.findByPk = async id => id === 'group-setting' ? groupSetting : h.state.setting;
  h.state.records.push(advertiser);
  Object.assign(h.runtime.account, { assignmentScope: 'group', clinicaId: null, grupoClinicaId: 28 });
  h.runtime.connectionSource = 'mapping_group';
  Object.assign(h.state.assignment, { scopeKey: 'group:28', assignmentScope: 'group', clinicaId: null, grupoClinicaId: 28 });
  h.policy.policyRefs.push({ setting_id: 'group-setting', scope_type: 'group', scope_id: 28, version: 4 });
  Object.assign(h.row, { grupoClinicaId: 28, connectionSource: 'mapping_group' });
  h.row.requestMetadata.workspace_delivery = googleDeliveryContext({ cfgRecord: h.record, signalPolicyRecord: advertiser,
    runtime: h.runtime, policy: h.policy, campaignId: '7' });
  assert.equal((await h.run()).get(h.campaign.id).ready, true);
  groupSetting.version++; assert.notEqual((await h.run()).get(h.campaign.id)?.ready, true);
  groupSetting.version--; h.state.setting.version++; assert.notEqual((await h.run()).get(h.campaign.id)?.ready, true);
});
test('current Google action selection keeps multiple destinations separate', async () => {
  const h = harness();
  h.record.config.google_ads.events.lead.destinations = [
    { key: 'first', customer_id: '123', conversion_action_id: '900', campaign_ids: ['7'] },
    { key: 'second', customer_id: '123', conversion_action_id: '901', campaign_ids: ['8'] },
  ];
  h.row.destinationKey = 'first'; h.row.requestMetadata.workspace_delivery = h.proof();
  assert.equal((await h.run()).get(h.campaign.id).ready, true);
  h.row.destinationKey = 'second'; h.row.conversionAction = 'customers/123/conversionActions/901';
  assert.notEqual((await h.run()).get(h.campaign.id)?.ready, true);
});
test('database failures remain failures, not a healthy or empty response', async () => {
  const h = harness(); h.models.GoogleConnection.findByPk = async () => { throw new Error('database unavailable'); };
  await assert.rejects(h.run(), /database unavailable/);
});
test('health aggregates both providers once and retains incomplete campaign coverage', async () => {
  const h = harness(); const google = (await h.run()).get(h.campaign.id);
  const campaigns = [h.campaign, { ...h.campaign, id: 'meta_ads:123:7', provider: 'meta_ads' }, { ...h.campaign, id: 'google_ads:123:8', campaign_id: '8' }];
  const report = buildWorkspaceHealth({ period: { end: '2026-09-09' }, rows: campaigns.map(campaign => ({ campaign,
    coverage: {}, ads: [], performance: 'insufficient' })) }, new Map([
    [h.campaign.id, { signals: google }], ['meta_ads:123:7', { signals: { checked: true, ready: true, received: 3 } }],
  ]), h.now);
  const block = report.healthBlocks.find(row => row.id === 'signals');
  assert.equal(block.status, 'Datos parciales');
  for (const [label, value] of [['Cobertura', '2 de 3'], ['Recibidos por Google', '1'], ['Recibidos por Meta', '3'], ['Procesados sin avisos por Google', '1']]) {
    assert.equal(block.checks.find(row => row.label === label).value, value);
  }
});

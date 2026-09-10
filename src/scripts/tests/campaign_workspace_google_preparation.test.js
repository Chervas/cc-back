'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const { checkGooglePreparation, loadGooglePreparation, checkInput, CHECK_LEASE_MS, TTL_MS } = require('../../services/campaignWorkspaceGooglePreparation.service');
const { buildClinicaclickManagedMapping, successfulValidationResponse } = require('../../services/googleAdsConversionPreparation.service');
const { uploadConversionEvent } = require('../../services/googleDataManagerConversion.service');
const migration = require('../../../migrations/20260910200000-add-campaign-workspace-signal-preparation');
const { createWorkspaceConfigurationHandlers } = require('../../controllers/campaignWorkspace.controller');

const action = { id: '31', name: 'Lead - ClinicaClick', resource_name: 'customers/20/conversionActions/31',
  category: 'SUBMIT_LEAD_FORM', type: 'UPLOAD_CLICKS', status: 'ENABLED', counting_type: 'MANY_PER_CLICK', primary_for_goal: false };
function harness() {
  const scope = { clinicIds: [1], groupId: null };
  const state = { date: new Date('2026-09-10T20:00:00Z'), allowed: true, calls: [], audits: [],
    clinics: [{ id_clinica: 1, grupoClinicaId: 8 }],
    setting: { id: 'setting', version: 1, accounts: [{ provider: 'google_ads', account_id: '20', campaign_ids: [], include_future: true }],
      preferences: { mode: 'measurement', signals: { enabled: true, events: ['lead'] } }, activation: null, signal_preparation: null },
    mappings: [{ id: 3, customerId: '20', isActive: true, assignmentScope: 'clinic', clinicaId: 1, googleConnectionId: 4, loginCustomerId: '10' }],
    assignments: [{ id: 5, status: 'active', scopeKey: 'clinic:1', googleConnectionId: 4, connectedAt: '2026-09-01T00:00:00Z' }],
    connection: { id: 4, googleUserId: 'principal', accessToken: 'fake-token', refreshToken: 'fake-refresh',
      scopes: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/datamanager' },
    actions: [structuredClone(action)], response: {},
  };
  state.setting.update = async values => { Object.assign(state.setting, values); return state.setting; };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = { sequelize: { transaction: async fn => fn(transaction) },
    Clinica: { findByPk: async () => state.clinics[0], findAll: async () => state.clinics },
    GrupoClinica: { findByPk: async () => ({ id_grupo: 8 }) },
    CampaignWorkspaceSetting: { findOne: async () => state.setting },
    CampaignWorkspaceEvent: { create: async (row, options) => { assert.equal(options.transaction, transaction); state.audits.push(row); } },
    ClinicGoogleAdsAccount: { findAll: async () => state.mappings.filter(row => row.isActive) },
    GoogleConnectionAssignment: { findAll: async () => state.assignments.filter(row => row.status === 'active') },
    GoogleConnection: { findByPk: async () => state.connection },
  };
  const dependencies = { models, scope, actorId: 7, now: () => state.date, hasAccess: async () => state.allowed,
    ensureToken: async (_, options) => { assert.equal(options.requiredScopes.length, 2); return { accessToken: 'fake-token' }; },
    list: async () => { state.calls.push('list'); return { actions: state.actions, clinicaclick_mapping: buildClinicaclickManagedMapping(state.actions) }; },
    upload: async input => { state.calls.push(input); if (state.onUpload) await state.onUpload(); return state.response; },
  };
  return { state, models, scope, run: (extra = {}, input = { account_id: '20', expected_version: state.setting.version }) => checkGooglePreparation({ ...dependencies, ...extra, input }),
    read: () => loadGooglePreparation({ models, scope, input: { account_id: '20' }, now: () => state.date }) };
}

test('validation responses reject warnings, errors and unrecognized bodies without requiring an ingestion id', () => {
  for (const response of [{}, { requestId: 'request' }, { fieldWarnings: [] }]) assert.equal(successfulValidationResponse(response), true);
  for (const response of [undefined, null, [], '<html>', { requestId: 0 }, { fieldWarnings: [{}] }, { fieldWarnings: null },
    { error: {} }, { unexpected: true }]) assert.equal(successfulValidationResponse(response), false);
});
test('Data Manager validateOnly does not coerce a non-JSON success into a valid empty response', async () => {
  for (const data of [null, undefined, 'html', []]) {
    await assert.rejects(uploadConversionEvent({ accessToken: 'fake', quotaProjectId: 'project', customerId: '20',
      conversionAction: action.resource_name, conversionDateTime: new Date(), gclid: 'GCLID_1', eventName: 'lead', validateOnly: true,
      request: { post: async () => ({ data }) } }), /validacion no reconocida/);
  }
});
test('clients cannot submit event lists, forged readiness, scope or permission flags', () => {
  for (const value of [null, [], { account_id: '20', expected_version: 0 }, { account_id: 20, expected_version: 1 },
    { account_id: '20', expected_version: 1, events: ['purchase'] }, { account_id: '20', expected_version: 1, validated: true }]) {
    assert.throws(() => checkInput(value, true), /invalid_google_preparation/);
  }
});
test('the scoped check survives reopen, audits both transitions and never grants delivery permission', async () => {
  const h = harness(); const result = await h.run();
  assert.equal(result.configuration.version, 3); assert.equal(result.preparation.events[0].state, 'verified');
  assert.deepEqual((await h.read()).preparation, result.preparation);
  assert.equal(h.state.setting.activation, null); assert.equal(h.state.calls.length, 2);
  const upload = h.state.calls[1];
  assert.equal(upload.validateOnly, true); assert.equal(upload.gclid, 'GCLID_1'); assert.equal(upload.eventName, 'lead');
  assert.equal(upload.customerId, '20'); assert.equal(upload.loginCustomerId, '10'); assert.ok(upload.timeoutMs <= 8000);
  for (const key of ['email', 'phone', 'userData', 'consent', 'patientId']) assert.equal(upload[key], undefined);
  assert.deepEqual(h.state.audits.map(row => row.event_type), ['google_check_started', 'google_check_completed']);
  assert.doesNotMatch(JSON.stringify([result, h.state.audits]), /fake-token|fake-refresh|principal/);
});
test('an in-progress or interrupted recheck cannot expose an earlier green check', async () => {
  const h = harness(); await h.run();
  h.state.onUpload = async () => {
    assert.equal((await h.read()).preparation.status, 'checking');
    assert.equal((await h.read()).preparation.events.length, 0);
    await assert.rejects(h.run(), /workspace_google_check_busy/);
  };
  await h.run();
  h.state.setting.signal_preparation.google_ads['20'] = { ...h.state.setting.signal_preparation.google_ads['20'],
    status: 'checking', started_at: h.state.date.toISOString() };
  h.state.date = new Date(+h.state.date + CHECK_LEASE_MS);
  assert.equal((await h.read()).preparation.status, 'stale');
  h.state.onUpload = null; assert.equal((await h.run()).preparation.status, 'checked');
});
test('failed or warning-bearing rechecks replace previous success, not just the error message', async () => {
  for (const response of [{ fieldWarnings: [{ field: 'gclid' }] }, { error: {} }, null]) {
    const h = harness(); await h.run(); h.state.response = response;
    const result = await h.run(); assert.equal(result.preparation.events[0].state, 'failed');
    assert.equal((await h.read()).preparation.events[0].state, 'failed');
  }
});
test('expiry and configuration/grant changes invalidate proof; routine token rotation does not', async () => {
  const h = harness(); await h.run();
  h.state.connection.accessToken = 'rotated'; h.state.connection.expiresAt = new Date();
  assert.equal((await h.read()).preparation.status, 'checked');
  h.state.assignments[0].connectedAt = '2026-09-10T21:00:00Z';
  assert.equal((await h.read()).preparation.status, 'stale');
  await h.run(); h.state.setting.accounts[0].include_future = false;
  assert.equal((await h.read()).preparation.status, 'stale');
  await h.run(); h.state.date = new Date(+h.state.date + TTL_MS);
  assert.equal((await h.read()).preparation.status, 'stale');
});
test('only the saved CRM events are inspected and incompatible actions never reach Data Manager', async () => {
  for (const actions of [[], [action, { ...action, id: '32' }], [{ ...action, primary_for_goal: true }],
    [{ ...action, type: 'WEBPAGE' }], [{ ...action, resource_name: 'customers/99/conversionActions/31' }]]) {
    const h = harness(); h.state.actions = actions;
    const result = await h.run(); assert.notEqual(result.preparation.events[0].state, 'verified');
    assert.deepEqual(h.state.calls, ['list']);
  }
  const h = harness(); h.state.setting.preferences.signals.events = ['purchase'];
  await assert.rejects(h.run(), /workspace_signal_preferences_required/); assert.equal(h.state.calls.length, 0);
});
test('stale versions, deselection, revoked assignments and ambiguous grants fail before any provider request', async () => {
  const h = harness(); await assert.rejects(h.run({}, { account_id: '20', expected_version: 9 }), /workspace_version_conflict/);
  h.state.assignments[0].status = 'revoked'; await assert.rejects(h.run(), /workspace_google_permissions_required/);
  h.state.assignments[0].status = 'active'; h.state.mappings.push({ ...h.state.mappings[0], id: 9, loginCustomerId: '11' });
  await assert.rejects(h.run(), /workspace_google_connection_ambiguous/);
  h.state.setting.accounts = []; await assert.rejects(h.run(), /workspace_account_not_selected/);
  assert.equal(h.state.calls.length, 0); assert.equal(h.state.audits.length, 0);
});
test('role, group membership, selection or connection changes during remote work reject the late result', async () => {
  for (const mutate of [state => { state.allowed = false; }, state => { state.clinics.push({ id_clinica: 2, grupoClinicaId: 8 }); },
    state => { state.setting.accounts[0].campaign_ids.push('44'); }, state => { state.assignments[0].status = 'revoked'; },
    state => { state.setting.signal_preparation = null; }]) {
    const h = harness(); h.scope.groupId = 8; h.state.onUpload = () => mutate(h.state);
    await assert.rejects(h.run(), /marketing_scope_forbidden|workspace_scope_changed|workspace_google_check_conflict|workspace_google_permissions_required/);
    assert.equal(h.state.audits.length, 1);
  }
});
test('provider failures are stored without raw payloads or patient/contact information', async () => {
  const h = harness(); const result = await h.run({ list: async () => { throw Object.assign(new Error('sensitive provider response'), { response: { status: 403 } }); } });
  assert.equal(result.preparation.events[0].error, 'workspace_google_permissions_required');
  assert.doesNotMatch(JSON.stringify(h.state.setting.signal_preparation), /sensitive/);
});
test('read and check endpoints enforce distinct read/write scope permissions and never cache private proofs', async () => {
  for (const name of ['googlePreparation', 'checkGoogle']) {
    const accesses = []; let called = false;
    const handlers = createWorkspaceConfigurationHandlers({ models: {}, resolveScope: async () => ({ isValid: true, clinicIds: [1] }),
      hasAccess: async args => { accesses.push(args.access); return true; },
      googlePreparation: async () => { called = true; return { success: true }; },
      checkGoogle: async args => { called = true; assert.equal(typeof args.hasAccess, 'function'); return { success: true }; } });
    const res = { set: (key, value) => { assert.equal(key, 'Cache-Control'); assert.equal(value, 'private, no-store'); }, json: value => value };
    await handlers[name]({ userData: { userId: 7 }, query: { scope: '1', account_id: '20' }, body: {} }, res);
    assert.equal(called, true); assert.deepEqual(accesses, [name === 'checkGoogle' ? 'write' : 'read']);
  }
});
test('the proof column is additive, idempotent and cannot be dropped while populated', async () => {
  const columns = {}; let calls = 0;
  const qi = { describeTable: async () => columns, addColumn: async (_, name) => { calls++; columns[name] = { type: 'JSON', allowNull: true }; },
    sequelize: { query: async () => [[{ count: 1 }]] }, removeColumn: async () => assert.fail('cannot lose evidence') };
  await migration.up(qi, Sequelize); await migration.up(qi, Sequelize); assert.equal(calls, 1);
  await assert.rejects(migration.down(qi), /explicit archival/);
  columns.signal_preparation.type = 'TEXT'; await assert.rejects(migration.up(qi, Sequelize), /incompatible/);
});

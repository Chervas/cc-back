'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkInput, TTL_MS, CHECK_LEASE_MS, loadMetaSignalPreparation, checkMetaSignalPreparation } = require('../../services/campaignWorkspaceMetaSignalPreparation.service');
const { createWorkspaceConfigurationHandlers } = require('../../controllers/campaignWorkspace.controller');

function harness() {
  const scope = { clinicIds: [1], groupId: null };
  const state = { date: new Date('2026-09-10T20:00:00Z'), allowed: true, calls: [], audits: [],
    clinics: [{ id_clinica: 1, grupoClinicaId: 8 }],
    setting: { id: 'setting', version: 1, accounts: [{ provider: 'meta_ads', account_id: '20', campaign_ids: [], include_future: true }],
      preferences: { mode: 'measurement', signals: { enabled: true, events: ['lead', 'schedule'] } }, activation: null, signal_preparation: null },
    mappings: [{ id: 3, metaAssetId: 'act_20', assetType: 'ad_account', isActive: true, assignmentScope: 'clinic', clinicaId: 1, metaConnectionId: 4 }],
    assignments: [{ id: 5, status: 'active', scopeKey: 'clinic:1', metaConnectionId: 4, connectedAt: '2026-09-01T00:00:00Z' }],
    connection: { id: 4, metaUserId: 'private-principal', accessToken: 'private-token', expiresAt: '2026-10-01T00:00:00Z' },
    datasets: [{ id: '30', name: 'Destino de la cuenta' }], permissions: [{ permission: 'ads_management', status: 'granted' }],
  };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  state.setting.update = async (values, options) => { assert.equal(options.transaction, transaction); Object.assign(state.setting, values); };
  const models = { sequelize: { transaction: async fn => {
    const { update, ...values } = state.setting; const before = structuredClone(values); const audits = state.audits.length;
    try { return await fn(transaction); } catch (error) { Object.assign(state.setting, before); state.audits.length = audits; throw error; }
  } },
  Clinica: { findByPk: async () => state.clinics[0], findAll: async () => state.clinics },
  GrupoClinica: { findByPk: async () => ({ id: 8 }) },
  CampaignWorkspaceSetting: { findOne: async () => state.setting },
  CampaignWorkspaceEvent: { create: async (row, options) => {
    assert.equal(options.transaction, transaction); if (state.auditFailure === row.event_type) throw new Error('audit_failed'); state.audits.push(row);
  } },
  ClinicMetaAsset: { findAll: async () => state.mappings.filter(row => row.isActive) },
  MetaConnectionAssignment: { findAll: async () => state.assignments.filter(row => row.status === 'active') },
  MetaConnection: { findByPk: async () => state.connection },
  };
  const read = async (path, options) => {
    state.calls.push(path);
    assert.equal(options.accessToken, state.connection.accessToken);
    assert.equal(options.maxRetries, 0); assert.ok(options.timeout <= 8000); assert.equal(options.sensitivePayload, true);
    if (state.onRead) { const result = await state.onRead(path, options); if (result) return result; }
    if (path === 'me/permissions') return { data: { data: state.permissions } };
    if (path === 'act_20') return { data: { id: 'act_20', account_id: '20' } };
    assert.equal(path, 'act_20/adspixels'); return { data: { data: state.datasets } };
  };
  const deps = { models, scope, actorId: 7, hasAccess: async () => state.allowed, now: () => state.date, read };
  return { state, scope, models,
    run: (input = { account_id: '20', dataset_id: '30', expected_version: state.setting.version }) => checkMetaSignalPreparation({ ...deps, input }),
    load: () => loadMetaSignalPreparation({ ...deps, input: { account_id: '20' } }),
  };
}

test('client input cannot supply events, permissions, alternate scopes or provider URLs', () => {
  for (const input of [null, [], {}, { account_id: 20 }, { account_id: 'act_20' }, { account_id: 'https://invalid' },
    { account_id: '20', dataset_id: '30', expected_version: 0 }, { account_id: '20', dataset_id: '30', expected_version: 1, events: ['purchase'] },
    { account_id: '20', dataset_id: '30', expected_version: 1, authorized: true }]) assert.throws(() => checkInput(input, true));
  assert.throws(() => checkInput({ account_id: '20', dataset_id: '30' }));
});

test('native-independent destination check persists and reopens, without installing a web or authorizing events', async () => {
  const h = harness(); const initial = await h.load();
  assert.equal(initial.preparation.status, 'unchecked'); assert.equal(h.state.setting.version, 1);
  const result = await h.run(); assert.equal(result.configuration.version, 3);
  assert.equal(result.preparation.state, 'access_verified'); assert.equal(result.preparation.dataset_id, '30');
  assert.deepEqual(result.preparation.events, ['lead', 'schedule']);
  assert.deepEqual((await h.load()).preparation, result.preparation); assert.equal(h.state.setting.activation, null);
  assert.deepEqual([...new Set(h.state.calls)], ['me/permissions', 'act_20', 'act_20/adspixels']);
  assert.deepEqual(h.state.audits.map(row => row.event_type), ['meta_signal_check_started', 'meta_signal_check_completed']);
  assert.ok(h.state.audits.every(row => row.changes.provider_mutation === false));
  assert.doesNotMatch(JSON.stringify([result, h.state.audits]), /private-token|private-principal|fingerprint/);
});

test('an in-flight or interrupted recheck invalidates the old green proof', async () => {
  const h = harness(); await h.run(); let inspected = false;
  h.state.onRead = async path => {
    if (path !== 'act_20/adspixels' || inspected) return; inspected = true;
    const proof = (await h.load()).preparation;
    assert.equal(proof.status, 'checking'); assert.equal(proof.state, null);
    await assert.rejects(h.run(), /workspace_meta_check_busy/);
  };
  await h.run(); h.state.onRead = null;
  Object.assign(h.state.setting.signal_preparation.meta_ads['20'], { status: 'checking', started_at: h.state.date.toISOString() });
  h.state.date = new Date(+h.state.date + CHECK_LEASE_MS);
  assert.equal((await h.load()).preparation.status, 'stale'); assert.equal((await h.run()).preparation.state, 'access_verified');
});

test('failed rechecks replace previous proof and sanitize provider errors', async () => {
  for (const [failure, expected] of [[{ response: { status: 403 } }, 'workspace_meta_permissions_required'],
    [{ code: 'META_RATE_LIMIT_LOCAL' }, 'workspace_meta_rate_limited'], [{ response: { status: 429 } }, 'workspace_meta_rate_limited'],
    [{ response: { data: { error: { code: 190 } } } }, 'workspace_meta_permissions_required'], [{}, 'workspace_meta_unavailable']]) {
    const h = harness(); await h.run();
    h.state.onRead = () => { throw Object.assign(new Error('private-patient-token-payload'), failure); };
    const result = await h.run(); assert.equal(result.preparation.state, 'failed'); assert.equal(result.preparation.error, expected);
    assert.doesNotMatch(JSON.stringify(h.state.setting.signal_preparation), /private-patient-token-payload/);
    h.state.onRead = null; assert.equal((await h.load()).preparation.state, 'failed');
  }
});

test('only datasets returned by the selected account are accepted; disappearance never stays green', async () => {
  const h = harness(); await h.run(); h.state.datasets = [{ id: '31', name: 'Otro destino' }];
  assert.equal((await h.load()).preparation.status, 'stale');
  const result = await h.run(); assert.equal(result.preparation.error, 'workspace_meta_dataset_not_available');
  h.state.onRead = path => path === 'act_20' ? { data: { id: 'act_21', account_id: '21' } } : null;
  assert.equal((await h.run()).preparation.error, 'workspace_meta_permissions_required');
});

test('permissions and inventory must be complete, unambiguous and structurally valid', async () => {
  for (const permissions of [[], [{ permission: 'ads_read', status: 'granted' }], [{ permission: 'ads_management', status: 'declined' }],
    [{ permission: 'ads_management', status: 'granted' }, { permission: 'ads_management', status: 'declined' }]]) {
    const h = harness(); h.state.permissions = permissions;
    assert.equal((await h.run()).preparation.error, 'workspace_meta_permissions_required');
    assert.deepEqual(h.state.calls, ['me/permissions']);
  }
  for (const datasets of [[{ id: 30, name: 'Invalid' }], [{ id: '30', name: 'a'.repeat(256) }], [{ id: '30' }],
    [{ id: '30', name: 'a' }, { id: '30', name: 'b' }]]) {
    const h = harness(); h.state.datasets = datasets;
    assert.equal((await h.run()).preparation.error, 'workspace_meta_inventory_incomplete');
  }
});

test('pagination is bounded and never follows credential-bearing next URLs', async () => {
  const h = harness();
  h.state.onRead = (path, options) => path.endsWith('/adspixels') && !options.params.after
    ? { data: { data: [{ id: '31', name: 'Primero' }], paging: { next: 'https://untrusted.example/steal', cursors: { after: 'cursor-1' } } } } : null;
  assert.equal((await h.run()).preparation.state, 'access_verified'); assert.equal(h.state.calls.length, 4);
  h.state.onRead = path => path.endsWith('/adspixels')
    ? { data: { data: h.state.datasets, paging: { next: 'https://untrusted.example/steal', cursors: { after: 'repeated' } } } } : null;
  assert.equal((await h.run()).preparation.error, 'workspace_meta_inventory_incomplete');
  assert.ok(h.state.calls.every(path => !path.startsWith('http')));
  let cursor = 0; h.state.onRead = path => path.endsWith('/adspixels')
    ? { data: { data: h.state.datasets, paging: { next: 'next', cursors: { after: String(++cursor) } } } } : null;
  assert.equal((await h.run()).preparation.error, 'workspace_meta_inventory_incomplete'); assert.equal(cursor, 5);
});

test('expired, future, corrupt or configuration-mismatched checks are never presented as verified', async () => {
  for (const mutate of [h => { h.state.date = new Date(+h.state.date + TTL_MS); },
    h => { h.state.setting.preferences.signals.events = ['lead']; }, h => { h.state.setting.accounts[0].include_future = false; },
    h => { h.state.assignments[0].connectedAt = '2026-09-10T19:00:00Z'; },
    h => { h.state.setting.signal_preparation.meta_ads['20'].checked_at = '2026-09-11T00:00:00Z'; },
    h => { h.state.setting.signal_preparation.meta_ads['20'].state = 'success'; },
    h => { h.state.setting.signal_preparation.meta_ads['20'].expires_at = '2028-01-01T00:00:00Z'; }]) {
    const h = harness(); await h.run(); mutate(h); assert.equal((await h.load()).preparation.status, 'stale');
  }
  const h = harness(); await h.run(); h.state.connection.accessToken = 'rotated';
  assert.equal((await h.load()).preparation.status, 'checked');
});

test('selection, local grant and expiry errors fail before provider reads or audit writes', async () => {
  for (const mutate of [h => { h.state.setting.accounts = []; }, h => { h.state.assignments[0].status = 'revoked'; },
    h => { h.state.connection.expiresAt = h.state.date; }, h => { h.state.connection.expiresAt = 'invalid'; },
    h => { h.state.assignments[0].connectedAt = null; }, h => { h.state.connection.id = 9; },
    h => { h.state.setting.preferences.signals.events = ['purchase']; }, h => { h.state.allowed = false; }]) {
    const h = harness(); mutate(h); await assert.rejects(h.run());
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.audits.length, 0);
  }
  const h = harness(); await assert.rejects(h.run({ account_id: '20', dataset_id: '30', expected_version: 9 }), /workspace_version_conflict/);
  h.state.mappings.push({ ...h.state.mappings[0], id: 7, metaConnectionId: 9 });
  h.state.assignments.push({ ...h.state.assignments[0], id: 8, metaConnectionId: 9 });
  await assert.rejects(h.run(), /workspace_meta_connection_ambiguous/); assert.equal(h.state.calls.length, 0);
});

test('late results are rejected after ACL, group membership, selection, grant or proof changes', async () => {
  for (const mutate of [s => { s.allowed = false; }, s => { s.clinics.push({ id_clinica: 2, grupoClinicaId: 8 }); },
    s => { s.setting.accounts[0].campaign_ids.push('44'); }, s => { s.assignments[0].status = 'revoked'; },
    s => { s.setting.signal_preparation = null; }]) {
    const h = harness(); h.scope.groupId = 8; h.state.onRead = path => { if (path.endsWith('/adspixels')) mutate(h.state); };
    await assert.rejects(h.run(), /marketing_scope_forbidden|workspace_scope_changed|workspace_meta_check_conflict|workspace_meta_permissions_required/);
    assert.equal(h.state.audits.length, 1);
  }
  const h = harness(); h.state.onRead = () => { h.state.allowed = false; };
  await assert.rejects(h.load(), /marketing_scope_forbidden/); assert.equal(h.state.audits.length, 0);
});

test('proof and audit writes share a transaction and preserve other provider preparations', async () => {
  const h = harness(); h.state.setting.signal_preparation = { google_ads: { 40: { existing: true } }, meta_ads: { 21: { existing: true } } };
  h.state.auditFailure = 'meta_signal_check_started'; await assert.rejects(h.run(), /audit_failed/);
  assert.equal(h.state.setting.version, 1); assert.equal(h.state.calls.length, 0);
  h.state.auditFailure = 'meta_signal_check_completed'; await assert.rejects(h.run(), /audit_failed/);
  assert.equal(h.state.setting.version, 2); assert.equal(h.state.setting.signal_preparation.meta_ads['20'].status, 'checking');
  assert.deepEqual(h.state.setting.signal_preparation.google_ads, { 40: { existing: true } });
  assert.deepEqual(h.state.setting.signal_preparation.meta_ads['21'], { existing: true });
});

test('read and check endpoints enforce distinct ACLs and never cache private configuration', async () => {
  for (const name of ['metaSignals', 'checkMetaSignals']) {
    const accesses = []; let called = false;
    const endpoint = async args => { called = true; assert.equal(typeof args.hasAccess, 'function'); return { success: true }; };
    const handlers = createWorkspaceConfigurationHandlers({ models: {}, resolveScope: async () => ({ isValid: true, clinicIds: [1] }),
      hasAccess: async args => { accesses.push(args.access); return true; }, metaSignals: endpoint, checkMetaSignals: endpoint });
    const res = { set: (key, value) => { assert.equal(key, 'Cache-Control'); assert.equal(value, 'private, no-store'); }, json: value => value };
    await handlers[name]({ userData: { userId: 7 }, query: { scope: '1', account_id: '20' }, body: {} }, res);
    assert.equal(called, true); assert.deepEqual(accesses, [name === 'metaSignals' ? 'read' : 'write']);
  }
});

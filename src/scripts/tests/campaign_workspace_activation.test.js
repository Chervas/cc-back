'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activateWorkspace } = require('../../services/campaignWorkspaceActivation.service');
const { normalizeCampaignConfig } = require('../../services/campaignMode.service');

function fixture() {
  const calls = []; const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const account = { provider: 'google_ads', account_id: '123', include_future: true, campaign_ids: ['7'] };
  const setting = { id: 'workspace-1', version: 2, accounts: [account], activation: null,
    preferences: { schema_version: 1, mode: 'measurement', signals: { enabled: false, events: [] }, optimization: null },
    update: async (patch, options) => { assert.equal(options.transaction, transaction); calls.push('settings'); Object.assign(setting, patch); return setting; } };
  const record = { id: 5, config: { features: { form_intercept_enabled: true }, texts: { privacy_url: '/privacidad' },
    campaigns: { last_onboarding_id: 9 }, google_ads: { enabled: true, customer_id: '123' }, meta_ads: { enabled: false } },
    update: async (patch, options) => { assert.equal(options.transaction, transaction); calls.push('intake'); Object.assign(record, patch); return record; } };
  const preparation = { revision: 'a'.repeat(64), selectionConfirmed: true, receptionReady: true, existing: null,
    campaigns: [{ campaign: { assigned: true }, configurationScope: { scope_type: 'clinic', scope_id: 1 } }] };
  const state = { policies: [], failAudit: false };
  const models = {
    sequelize: { transaction: async fn => {
      const oldSetting = structuredClone({ version: setting.version, activation: setting.activation });
      const oldConfig = structuredClone(record.config);
      try { return await fn(transaction); }
      catch (error) { Object.assign(setting, oldSetting); record.config = oldConfig; throw error; }
    } },
    Clinica: { findByPk: async (_id, options) => { assert.equal(options.lock, 'UPDATE'); calls.push('owner'); return { id_clinica: 1, estado_clinica: true }; } },
    CampaignWorkspaceSetting: { findOne: async () => setting },
    IntakeConfig: { findOne: async () => record },
    CampaignOptimizationPolicy: { findAll: async () => state.policies },
    CampaignWorkspaceEvent: { create: async (event, options) => { assert.equal(options.transaction, transaction); if (state.failAudit) throw new Error('audit_unavailable'); calls.push(event); } },
  };
  const input = { expected_version: 2, preparation_revision: preparation.revision, mode: 'measurement', signals: { enabled: false }, confirmed: true };
  const options = { models, scope: { clinicIds: [1] }, actorId: 7, input, deploymentReady: true,
    hasAccess: async () => true,
    loadPreparation: async options => { assert.equal(options.transaction, transaction); return preparation; },
    loadInventory: async () => ({ google: [{ customerId: '123' }], meta: [], campaigns: [{ provider: 'google_ads', account_id: '123', campaign_id: '7' }] }),
    now: () => new Date('2026-09-10T15:00:00Z') };
  return { options, input, setting, record, preparation, state, calls, run: extra => activateWorkspace({ ...options, ...extra }) };
}

test('activation atomically binds the scope policy, canonical measurement mode and audit without enabling signals', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.configuration.version, 3);
  assert.equal(f.record.config.features.form_intercept_enabled, true);
  assert.equal(f.record.config.texts.privacy_url, '/privacidad');
  assert.equal(f.record.config.campaigns.last_onboarding_id, 9);
  assert.equal(f.record.config.google_ads.enabled, true); assert.equal(f.record.config.google_ads.customer_id, '123');
  assert.equal(f.record.config.meta_ads.enabled, false);
  assert.deepEqual(f.record.config.campaigns.workspace_policy, { schema_version: 1, setting_id: 'workspace-1', scope_type: 'clinic', scope_id: 1 });
  assert.equal(f.setting.activation.status, 'active'); assert.equal(f.setting.activation.signals.enabled, false);
  assert.equal(f.setting.activation.schema_version, 2);
  assert.deepEqual(f.setting.activation.account_authorizations, f.setting.accounts);
  assert.equal(f.calls.at(-1).event_type, 'measurement_activated'); assert.equal(f.calls.at(-1).actor_user_id, 7);
  assert.equal(normalizeCampaignConfig(f.record.config.campaigns).mode_contract.consented_conversion_uploads, false);
});
test('independent website provider settings survive a CRM-only authorization change', async () => {
  const f = fixture(); f.record.config.meta_ads = { enabled: true, pixel_id: '456', connection_id: 3 };
  const original = structuredClone(f.record.config.meta_ads);
  await f.run(); assert.deepEqual(f.record.config.meta_ads, original);
  assert.equal(f.setting.activation.signals.enabled, false);
});
test('deployment compatibility is required before touching a client configuration', async () => {
  const f = fixture(); await assert.rejects(f.run({ deploymentReady: false }), /workspace_activation_deployment_pending/);
  assert.deepEqual(f.calls, []);
});
test('an authorized account selection never substitutes for explicit activation confirmation', async () => {
  for (const patch of [{ confirmed: false }, { mode: 'unknown' }, { mutate_budget: true }, { expected_version: 0 }]) {
    const f = fixture(); await assert.rejects(f.run({ input: { ...f.input, ...patch } }), /invalid_workspace_activation/);
    assert.deepEqual(f.calls, []);
  }
});
test('optimization has an independent deployment gate before touching settings', async () => {
  const f = fixture(); f.input.mode = 'optimize';
  await assert.rejects(f.run({ optimizationDeploymentReady: false }), /workspace_optimization_deployment_pending/);
  assert.deepEqual(f.calls, []);
});
test('signals cannot be activated without current provider proofs', async () => {
  const f = fixture(); f.input.signals.enabled = true;
  f.setting.preferences.signals = { enabled: true, events: ['lead'] };
  await assert.rejects(f.run({ loadSignalReview: async () => ({ review: { ready: false }, authorization: null }) }), /workspace_signal_preparation_required/);
  assert.deepEqual(f.calls, ['owner']);
});
test('a saved request for optimization or signals cannot silently become measurement without signals', async () => {
  for (const preferences of [{ mode: 'optimize', signals: { enabled: false } }, { mode: 'measurement', signals: { enabled: true } }]) {
    const f = fixture(); f.setting.preferences = preferences;
    await assert.rejects(f.run(), /workspace_preferences_mismatch/);
    assert.deepEqual(f.calls, ['owner']); assert.equal(f.setting.activation, null);
  }
});
test('stale version and stale review evidence fail before any write', async () => {
  const f = fixture(); f.input.expected_version = 1;
  await assert.rejects(f.run(), /workspace_version_conflict/); assert.deepEqual(f.calls, ['owner']);
  f.input.expected_version = 2; f.input.preparation_revision = 'b'.repeat(64);
  await assert.rejects(f.run(), /workspace_preparation_changed/); assert.equal(f.setting.activation, null);
});
test('receiving no form or having no confirmed selection cannot turn measurement green', async () => {
  for (const field of ['receptionReady', 'selectionConfirmed']) {
    const f = fixture(); f.preparation[field] = false;
    await assert.rejects(f.run(), /workspace_reception_pending/); assert.deepEqual(f.calls, ['owner']);
  }
});
test('a clinic cannot migrate a shared group web policy through its own configuration', async () => {
  const f = fixture(); f.preparation.campaigns[0].configurationScope = { scope_type: 'group', scope_id: 28 };
  await assert.rejects(f.run(), /workspace_shared_web_scope_required/); assert.deepEqual(f.calls, ['owner']);
});
test('existing optimization and managed modes are never silently downgraded', async () => {
  const f = fixture(); f.preparation.existing = { mode: 'guided_improvement' };
  await assert.rejects(f.run(), /workspace_mode_transition_required/); assert.deepEqual(f.calls, ['owner']);
});
test('an active or paused optimization policy blocks migration even without a mode snapshot', async () => {
  const f = fixture(); f.state.policies = [{ id: 5 }];
  await assert.rejects(f.run(), /workspace_active_optimization_policy/); assert.deepEqual(f.calls, ['owner']);
});
test('audit failure rolls back both the settings and canonical intake configuration', async () => {
  const f = fixture(); f.state.failAudit = true;
  await assert.rejects(f.run(), /audit_unavailable/);
  assert.equal(f.setting.version, 2); assert.equal(f.setting.activation, null); assert.equal(f.record.config.google_ads.enabled, true);
  assert.equal(f.record.config.campaigns.workspace_policy, undefined);
});

function signalFixture() {
  const f = fixture();
  f.input.signals.enabled = true;
  f.setting.preferences.signals = { enabled: true, events: ['lead', 'schedule'] };
  f.preparation.signals = { enabled: true, ready: true };
  Object.assign(f.preparation.campaigns[0].campaign, { provider: 'google_ads', account_id: '123', campaign_id: '7', clinicId: 1 });
  const authorization = { schema_version: 1, clinic_ids: [1], destinations: [{ provider: 'google_ads', account_id: '123',
    grant_fingerprint: 'private-grant', events: [{ event: 'lead', destination_id: '10' }, { event: 'schedule', destination_id: '11' }] }] };
  f.options.loadSignalReview = async args => {
    assert.ok(args.transaction); assert.equal(args.setting, f.setting);
    return { review: { ready: true }, authorization };
  };
  f.options.resolveRoute = async args => {
    assert.ok(args.transaction); assert.equal(f.setting.activation.schema_version, 2);
    assert.ok(['lead', 'schedule'].includes(args.eventName)); return { destinationId: '10' };
  };
  return { ...f, authorization };
}

test('the atomic mandate snapshots only server-checked destinations and selected events', async () => {
  const f = signalFixture(); const result = await f.run();
  assert.deepEqual(f.setting.activation.signals.authorization, f.authorization);
  assert.deepEqual(f.setting.activation.signals.events, ['lead', 'schedule']);
  assert.notEqual(f.setting.activation.signals.authorization, f.authorization);
  assert.doesNotMatch(JSON.stringify(result), /private-grant|grant_fingerprint|destination_id/);
  assert.equal(f.record.config.campaigns.mode_contract.consented_conversion_uploads, true);
  assert.equal(f.calls.at(-1).event_type, 'measurement_activated');
});

test('a native-only scope stores its mandate without creating a website', async () => {
  const f = signalFixture(); f.options.models.IntakeConfig = { findOne: async () => null,
    create: async () => assert.fail('Native reception must not create a website') };
  f.preparation.campaigns[0].configurationScope = null;
  await f.run(); assert.equal(f.setting.activation.schema_version, 2); assert.equal(f.setting.activation.signals.enabled, true);
  assert.equal(f.calls.includes('intake'), false);
});

test('effective scope conflicts and last-moment permission loss roll back mandate and mode together', async () => {
  for (const kind of ['route', 'permission', 'audit']) {
    const f = signalFixture();
    if (kind === 'route') f.options.resolveRoute = async () => { throw Object.assign(new Error('conflict'), { code: 'workspace_signal_routes_conflict' }); };
    if (kind === 'permission') { let reads = 0; f.options.hasAccess = async () => ++reads < 3; }
    if (kind === 'audit') f.state.failAudit = true;
    await assert.rejects(f.run());
    assert.equal(f.setting.activation, null); assert.equal(f.setting.version, 2);
    assert.equal(f.record.config.campaigns.workspace_policy, undefined);
  }
});

test('a changed group membership, inactive clinic or revoked write permission cannot be activated', async () => {
  for (const kind of ['members', 'inactive', 'permission']) {
    const f = fixture();
    if (kind === 'members') {
      f.options.scope = { clinicIds: [1], groupId: 28 };
      f.options.models.GrupoClinica = { findByPk: async () => ({ id: 28 }) };
      f.options.models.Clinica.findAll = async () => [{ id_clinica: 1, estado_clinica: true }, { id_clinica: 2, estado_clinica: true }];
    }
    if (kind === 'inactive') f.options.models.Clinica.findByPk = async () => ({ id_clinica: 1, estado_clinica: false });
    if (kind === 'permission') f.options.hasAccess = async () => false;
    await assert.rejects(f.run(), error => ['workspace_scope_changed', 'marketing_scope_forbidden'].includes(error.code));
    assert.equal(f.setting.activation, null); assert.equal(f.calls.includes('settings'), false);
  }
});

test('activation does not accept destinations, event lists or grant fingerprints from the browser', async () => {
  for (const signals of [{ enabled: true, events: ['lead'] }, { enabled: true, authorization: {} }]) {
    const f = signalFixture(); f.input.signals = signals;
    await assert.rejects(f.run(), /invalid_workspace_activation/); assert.deepEqual(f.calls, []);
  }
});

function optimizationFixture() {
  const f = signalFixture();
  f.input.mode = 'optimize'; f.setting.preferences.mode = 'optimize';
  f.setting.preferences.optimization = { actions: ['adjust_bids'], budget_changes: false, monthly_limit_cents: null, max_budget_change_pct: 10 };
  const authorization = { schema_version: 1, clinic_ids: [1], limits: { actions: ['adjust_bids'], max_bid_change_pct: 10, monthly_limit_cents: null },
    campaigns: [{ provider: 'google_ads', account_id: '123', campaign_id: '7', clinic_id: 1, grant_fingerprint: 'private-optimization-grant', targets: [] }] };
  const review = { enabled: true, ready: true, campaigns: [{ campaign_key: '7', status: 'ready' }], limits: authorization.limits };
  f.preparation.optimization = review;
  f.options.optimizationDeploymentReady = true;
  f.options.loadOptimizationReview = async args => { assert.ok(args.transaction); assert.equal(args.setting, f.setting); return { review, authorization }; };
  f.options.checkOptimizationOverlap = async args => { assert.ok(args.transaction); assert.deepEqual(args.authorization, authorization); };
  return { ...f, optimizationAuthorization: authorization };
}

test('Optimiza stores a separate scoped mandate and preserves the checked CRM signal authorization', async () => {
  const f = optimizationFixture(); const result = await f.run();
  assert.equal(f.setting.activation.mode, 'optimize'); assert.equal(f.setting.activation.optimization.status, 'active');
  assert.deepEqual(f.setting.activation.optimization.authorization, f.optimizationAuthorization);
  assert.deepEqual(f.setting.activation.signals.authorization, f.authorization);
  assert.equal(f.record.config.campaigns.active_mode, 'connect_only');
  assert.equal(f.record.config.campaigns.mode_contract.mutate_bids, false);
  assert.equal(f.calls.at(-1).event_type, 'optimization_activated');
  assert.doesNotMatch(JSON.stringify(result), /private-optimization-grant|grant_fingerprint|targets/);
  assert.equal(result.configuration.activation.optimization.campaigns, 1);
});
test('Optimiza refuses expired reviews, overlapping owners and audit failures without changing current service', async () => {
  for (const mutate of [f => { f.options.loadOptimizationReview = async () => ({ review: { ready: false }, authorization: null }); },
    f => { f.options.checkOptimizationOverlap = async () => { throw Object.assign(new Error('workspace_optimization_conflict'), { code: 'workspace_optimization_conflict' }); }; },
    f => { f.state.failAudit = true; }]) {
    const f = optimizationFixture(); mutate(f); await assert.rejects(f.run());
    assert.equal(f.setting.activation, null); assert.equal(f.setting.version, 2);
    assert.equal(f.record.config.campaigns.workspace_policy, undefined);
  }
});
test('confirming measurement removes only the new optimization mandate; it does not relabel the old guided contract', async () => {
  const f = optimizationFixture(); await f.run(); f.input.expected_version = f.setting.version;
  f.input.mode = 'measurement'; f.setting.preferences.mode = 'measurement'; f.setting.preferences.optimization = null;
  f.preparation.existing = { mode: 'guided_improvement' };
  await f.run(); assert.equal(f.setting.activation.mode, 'measurement'); assert.equal(f.setting.activation.optimization, undefined);
  assert.deepEqual(f.setting.activation.signals.authorization, f.authorization);
});

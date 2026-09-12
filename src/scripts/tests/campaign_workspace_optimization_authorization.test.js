'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { digest, ACTIONS } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const { LIMITS, loadOptimizationAuthorizationReview, createOptimizationMandate, resolveOptimizationAuthorization,
  assertNoOptimizationOverlap, pauseWorkspaceOptimization } = require('../../services/campaignWorkspaceOptimizationAuthorization.service');
const { publicSettings } = require('../../services/campaignWorkspaceSettings.service');
const { publicOptimizationProof } = require('../../services/campaignWorkspaceOptimizationPreparation.service');

function fixture(provider = 'google_ads') {
  const now = new Date('2026-09-11T12:00:00Z');
  const reference = { provider, account_id: '20', campaign_id: '30' };
  const campaign = { ...reference, id: JSON.stringify(reference), name: 'Campaign', assigned: true, paused: false, clinicId: 1 };
  const scope = { groupId: 10, clinicIds: [1, 2] };
  const setting = { id: 'setting-1', scope_type: 'group', scope_id: 10, version: 4,
    accounts: [{ provider, account_id: '20', include_future: true, campaign_ids: [] }],
    preferences: { mode: 'optimize', signals: { enabled: false, events: [] }, optimization: { actions: ['pause_underperforming_ads', 'adjust_bids'],
      budget_changes: false, monthly_limit_cents: null, max_budget_change_pct: 10 } },
    activation: null };
  const targets = provider === 'google_ads' ? [
    { action: 'pause_underperforming_ads', entity: 'ad', id: '60', group_id: '50', resource: 'customers/20/adGroupAds/50~60', field: 'status', value: 'ENABLED' },
    { action: 'adjust_bids', entity: 'ad_group', id: '50', resource: 'customers/20/adGroups/50', field: 'cpc_bid_micros', value: '500000', unit: 'micros', strategy: 'MANUAL_CPC' },
  ] : [
    { action: 'pause_underperforming_ads', entity: 'ad', id: '60', group_id: '50', resource: '60', field: 'status', value: 'ACTIVE' },
    { action: 'adjust_bids', entity: 'ad_set', id: '50', resource: '50', field: 'bid_amount', value: '100', unit: 'minor', strategy: 'LOWEST_COST_WITH_BID_CAP' },
  ];
  const inspection = { schema_version: 1, reference, currency: 'EUR', targets,
    actions: ACTIONS.map(action => ({ action, targets: targets.filter(target => target.action === action).length, reasons: [] })) };
  inspection.fingerprint = digest([reference, 'EUR', inspection.targets, inspection.actions]);
  const state = { contexts: 0, permitted: true, grant: 'a'.repeat(64), failAudit: false, events: [], owners: [{ id: 1 }], otherSettings: [],
    clinics: [{ id_clinica: 1 }, { id_clinica: 2 }], locks: [] };
  const context = { reference, campaign, setting, fingerprint: 'b'.repeat(64),
    grant: { fingerprint: state.grant, connection: { id: 5 }, loginCustomerId: null }, latest: {
      schema_version: 1, fingerprint: 'b'.repeat(64), run_id: '11111111-1111-1111-1111-111111111111', status: 'checked',
      checked_at: now.toISOString(), expires_at: new Date(+now + 86400000).toISOString(), error: null, inspection,
    } };
  const resolveContext = async input => { state.contexts++; context.grant.fingerprint = state.grant;
    if (state.resolve) await state.resolve(input); return context; };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    sequelize: { transaction: async run => {
      const before = structuredClone({ activation: setting.activation, version: setting.version, events: state.events });
      try { return await run(transaction); } catch (error) { setting.activation = before.activation; setting.version = before.version; state.events = before.events; throw error; }
    } },
    GrupoClinica: { findByPk: async () => ({ id_grupo: 10 }) },
    Clinica: { findAll: async () => state.clinics },
    CampaignWorkspaceSetting: { findOne: async () => setting, findAll: async input => { assert.equal(input.lock, 'UPDATE'); return state.otherSettings; } },
    ClinicGoogleAdsAccount: { findAll: async input => { assert.equal(input.lock, 'UPDATE'); state.locks.push('google'); return state.owners; } },
    ClinicMetaAsset: { findAll: async input => { assert.equal(input.lock, 'UPDATE'); state.locks.push('meta'); return state.owners; } },
    CampaignWorkspaceEvent: { create: async (event, input) => { assert.equal(input.transaction, transaction); if (state.failAudit) throw new Error('audit_failed'); state.events.push(event); } },
  };
  setting.update = async (patch, input) => { assert.equal(input.transaction, transaction); Object.assign(setting, patch); return setting; };
  const options = { models, scope, setting, campaigns: [campaign], resolveContext, now };
  const review = extra => loadOptimizationAuthorizationReview({ ...options, ...extra });
  const activate = async () => {
    const result = await review(); assert.ok(result.authorization);
    setting.activation = { schema_version: 2, mode: 'optimize', status: 'active', account_authorizations: structuredClone(setting.accounts),
      signals: { enabled: true, events: ['lead'], authorization: { preserved: true } },
      optimization: createOptimizationMandate({ authorization: result.authorization, actorId: 7, now }) };
    return result;
  };
  const executeContext = extra => resolveOptimizationAuthorization({ models, scope, setting, campaign, action: 'adjust_bids',
    now, hasAccess: async input => { assert.equal(input.userId, 7); return state.permitted; }, resolveContext, checkOwnership: async () => {}, ...extra });
  const pause = extra => pauseWorkspaceOptimization({ models, scope, actorId: 7,
    input: { expected_version: setting.version, confirmed: true }, hasAccess: async () => state.permitted, now: () => now, ...extra });
  return { state, setting, scope, campaign, context, inspection, transaction, models, review, activate, executeContext, pause };
}

test('Google and Meta review the exact resources under a separate mandate without authorizing imports or signals', async () => {
  for (const provider of ['google_ads', 'meta_ads']) {
    const f = fixture(provider); const result = await f.review();
    assert.equal(result.review.ready, true); assert.equal(result.review.campaigns[0].status, 'ready');
    assert.deepEqual(result.authorization.limits, { ...LIMITS, actions: ['pause_underperforming_ads', 'adjust_bids'], monthly_limit_cents: null, currency: 'EUR' });
    assert.equal(result.authorization.campaigns[0].targets.length, 2);
    assert.equal(result.authorization.campaigns[0].targets[1].value, undefined);
    assert.equal(f.setting.activation, null); assert.equal(f.state.events.length, 0);
  }
});
test('disabled optimization performs no context reads', async () => {
  const f = fixture(); f.setting.preferences.mode = 'measurement'; const result = await f.review();
  assert.equal(result.review.enabled, false); assert.equal(f.state.contexts, 0);
});

function refreshInspection(f) {
  f.inspection.actions = ACTIONS.map(action => ({ action, targets: f.inspection.targets.filter(target => target.action === action).length, reasons: [] }));
  f.inspection.fingerprint = digest([f.inspection.reference, f.inspection.currency, f.inspection.targets, f.inspection.actions]);
}

test('Google exclusions cannot be presented as executable or create a mandate without a relevance policy', async () => {
  const f = fixture(); f.setting.preferences.optimization.actions = ['negative_keywords'];
  f.inspection.targets.push({ action: 'negative_keywords', entity: 'campaign', id: '30', resource: 'customers/20/campaigns/30', field: 'keyword', match_type: 'EXACT' });
  refreshInspection(f); const original = structuredClone(f.context.latest);
  const proof = publicOptimizationProof(f.context, new Date('2026-09-11T12:00:00Z'));
  assert.equal(proof.compatible, false);
  assert.deepEqual(proof.actions.find(row => row.action === 'negative_keywords'), {
    action: 'negative_keywords', targets: 0, reasons: ['search_relevance_required'], requested: true,
  });
  const result = await f.review(); assert.equal(result.review.ready, false); assert.equal(result.authorization, null);
  assert.deepEqual(f.context.latest, original); assert.equal(f.state.events.length, 0);
});

test('Meta target cost and ROAS are unavailable until their own decision policy exists', async () => {
  for (const strategy of ['COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS']) {
    const f = fixture('meta_ads'); f.setting.preferences.optimization.actions = ['adjust_bids'];
    const target = f.inspection.targets[1]; target.strategy = strategy;
    if (strategy === 'LOWEST_COST_WITH_MIN_ROAS') { target.field = 'bid_constraints.roas_average_floor'; target.unit = 'roas_10000'; }
    refreshInspection(f); const original = structuredClone(f.context.latest);
    const result = await f.review(); assert.equal(result.review.ready, false); assert.equal(result.authorization, null);
    assert.equal(result.review.campaigns[0].actions[0].targets, 0);
    assert.deepEqual(result.review.campaigns[0].actions[0].reasons, ['bid_policy_not_available']);
    assert.deepEqual(f.context.latest, original);
  }
});

test('mixed Meta strategies authorize only implemented targets and retain the explanation for the rest', async () => {
  const f = fixture('meta_ads'); f.inspection.targets.push({ ...f.inspection.targets[1], id: '51', resource: '51', strategy: 'COST_CAP' });
  refreshInspection(f); const result = await f.review();
  assert.equal(result.review.ready, true); assert.equal(result.authorization.campaigns[0].targets.length, 2);
  assert.ok(result.authorization.campaigns[0].targets.every(target => target.strategy !== 'COST_CAP'));
  const action = result.review.campaigns[0].actions.find(row => row.action === 'adjust_bids');
  assert.equal(action.targets, 1); assert.deepEqual(action.reasons, ['bid_policy_not_available']);
});

test('an invalid stored inspection is not a green preparation result', () => {
  for (const mutate of [f => { f.inspection.fingerprint = 'bad'; }, f => { f.inspection.actions[1].targets = 99; },
    f => { f.inspection.targets = null; }]) {
    const f = fixture(); mutate(f);
    const proof = publicOptimizationProof(f.context, new Date('2026-09-11T12:00:00Z'));
    assert.equal(proof.compatible, false); assert.equal(proof.status, 'stale');
  }
});
test('a group mandate respects clinic exclusions on apply and read-only recovery, with the clinic selection locked', async () => {
  const f = fixture(); await f.activate();
  const queries = []; let local = null;
  f.models.CampaignWorkspaceSetting.findOne = async query => { queries.push(query); return local; };
  await f.executeContext({ transaction: f.transaction });
  assert.deepEqual(queries[0].where, { scope_type: 'clinic', scope_id: 1 });
  assert.equal(queries[0].lock, 'UPDATE'); assert.equal(queries[0].transaction, f.transaction);
  local = { accounts: [] };
  for (const readOnly of [false, true]) await assert.rejects(f.executeContext({ readOnly }), /workspace_optimization_campaign_not_authorized/);
  local = { accounts: [{ provider: 'google_ads', account_id: '20', include_future: false, campaign_ids: ['31'] }] };
  await assert.rejects(f.executeContext(), /workspace_optimization_campaign_not_authorized/);
  local.accounts[0].campaign_ids = ['30']; await f.executeContext();
});
test('paused and unassigned campaigns are not authorized even with automatic import selected', async () => {
  const f = fixture(); const result = await f.review({ campaigns: [f.campaign,
    { ...f.campaign, id: 'paused', campaign_id: '31', paused: true }, { ...f.campaign, id: 'unassigned', campaign_id: '32', assigned: false }] });
  assert.equal(result.review.ready, true); assert.equal(result.authorization.campaigns.length, 1);
  assert.deepEqual(result.review.campaigns.map(row => row.status), ['ready', 'not_applicable', 'unassigned']);
  const empty = await f.review({ campaigns: [{ ...f.campaign, paused: true }] }); assert.equal(empty.review.ready, false);
});
test('missing, expired, failed and corrupt proofs cannot produce an advertising mandate', async () => {
  for (const mutate of [f => { f.context.latest = null; }, f => { f.context.latest.expires_at = f.context.latest.checked_at; },
    f => { f.context.latest.error = 'workspace_optimization_permissions_required'; }, f => { f.inspection.fingerprint = 'bad'; },
    f => { f.context.latest.run_id = null; }, f => { f.inspection.actions[1].targets = 0; },
    f => { f.inspection.targets[1].resource = 'customers/999/adGroups/50';
      f.inspection.fingerprint = digest([f.inspection.reference, f.inspection.currency, f.inspection.targets, f.inspection.actions]); }]) {
    const f = fixture(); mutate(f); const result = await f.review(); assert.equal(result.review.ready, false); assert.equal(result.authorization, null);
  }
});
test('unsupported selections, configuration changes, duplicates and provider failures never broaden review', async () => {
  const f = fixture(); f.setting.preferences.optimization.actions = ['negative_keywords'];
  assert.equal((await f.review()).review.ready, false);
  f.setting.preferences.optimization.actions = ['adjust_bids']; f.state.resolve = () => { throw new Error('private-token patient@example.test'); };
  const failed = await f.review(); assert.equal(failed.review.campaigns[0].error, 'workspace_optimization_unavailable');
  assert.doesNotMatch(JSON.stringify(failed.review), /patient|private-token/);
  await assert.rejects(f.review({ campaigns: [f.campaign, f.campaign] }), /workspace_optimization_incomplete/);
});
test('unknown bid strategies cannot authorize a campaign with missing or inherited fields', async () => {
  for (const strategy of ['UNKNOWN', 'toString', '__proto__', undefined]) {
    const f = fixture();
    f.inspection.targets[1] = { action: 'adjust_bids', entity: 'campaign', id: '30', resource: 'customers/20/campaigns/30', strategy };
    f.inspection.fingerprint = digest([f.inspection.reference, f.inspection.currency, f.inspection.targets, f.inspection.actions]);
    assert.equal((await f.review()).authorization, null);
  }
});
test('runtime rechecks the active mandate and grant, independently of a preferences draft', async () => {
  for (const provider of ['google_ads', 'meta_ads']) {
    const f = fixture(provider); await f.activate(); f.setting.preferences = { mode: 'measurement', optimization: null };
    f.state.resolve = input => assert.equal(input.requirePreferences, false);
    const authorized = await f.executeContext(); assert.equal(authorized.entry.clinic_id, 1);
    assert.equal(authorized.mandate.status, 'active');
    f.state.grant = 'c'.repeat(64); await assert.rejects(f.executeContext(), /workspace_optimization_connection_changed/);
  }
});
test('runtime rejects new campaigns, actions, changed clinics, revoked permissions and altered limits', async () => {
  for (const mutate of [f => { f.campaign.campaign_id = '99'; }, f => { f.state.permitted = false; },
    f => { f.setting.activation.optimization.authorization.limits.max_bid_change_pct = 100; },
    f => { f.campaign.clinicId = 2; }, f => { f.setting.activation.optimization.status = 'paused'; },
    f => { f.setting.accounts = []; }]) {
    const f = fixture(); await f.activate(); mutate(f); await assert.rejects(f.executeContext());
  }
  const f = fixture(); await f.activate(); await assert.rejects(f.executeContext({ action: 'adjust_budget' }), /workspace_optimization_action_not_authorized/);
  f.state.resolve = () => { f.state.permitted = false; }; await assert.rejects(f.executeContext(), /workspace_optimization_permissions_required/);
});
test('worker authorization locks current memberships during transactional permission checks', async () => {
  const f = fixture(); await f.activate(); let reads = 0;
  f.models.UsuarioClinica = { findAll: async input => {
    assert.equal(input.transaction, f.transaction); assert.equal(input.lock, 'UPDATE'); reads++; return [{ id_clinica: 1 }, { id_clinica: 2 }];
  } };
  await f.executeContext({ transaction: f.transaction, hasAccess: async input => {
    assert.ok(input.membershipModel); return (await input.membershipModel.findAll({ attributes: ['id_clinica'] })).length === 2;
  } });
  assert.equal(reads, 2);
});
test('read-only recovery permits a paused mandate but still requires the current actor and grant', async () => {
  const f = fixture(); await f.activate(); let ownershipChecks = 0;
  const checkOwnership = async () => { ownershipChecks++; };
  await f.executeContext({ checkOwnership }); assert.equal(ownershipChecks, 1);
  f.setting.activation.optimization.status = 'paused';
  await f.executeContext({ readOnly: true, checkOwnership }); assert.equal(ownershipChecks, 1);
  await assert.rejects(f.executeContext({ checkOwnership }));
  f.state.grant = 'c'.repeat(64);
  await assert.rejects(f.executeContext({ readOnly: true }), /workspace_optimization_connection_changed/);
  f.state.grant = 'a'.repeat(64); f.state.permitted = false;
  await assert.rejects(f.executeContext({ readOnly: true }), /workspace_optimization_permissions_required/);
});
test('only one workspace can authorize advertising changes to the same campaign', async () => {
  for (const provider of ['google_ads', 'meta_ads']) {
    const f = fixture(provider); const { authorization } = await f.activate();
    const run = () => assertNoOptimizationOverlap({ models: f.models, setting: f.setting, authorization, transaction: f.transaction });
    await run(); assert.equal(f.state.locks.length, 1);
    f.state.otherSettings = [{ activation: structuredClone(f.setting.activation) }]; await assert.rejects(run(), /workspace_optimization_conflict/);
    f.state.otherSettings[0].activation.optimization.authorization.campaigns[0].campaign_id = '99'; await run();
    f.state.owners = []; await assert.rejects(run(), /workspace_optimization_permissions_required/);
  }
});
test('pausing is scoped, auditable and idempotent; reception, signals and preferences are unchanged', async () => {
  const f = fixture(); await f.activate(); const before = JSON.stringify([f.setting.accounts, f.setting.preferences, f.setting.activation.signals]);
  const result = await f.pause(); assert.equal(result.changed, true); assert.equal(result.configuration.activation.optimization.status, 'paused');
  assert.equal(f.setting.activation.status, 'active'); assert.equal(f.setting.version, 5); assert.equal(f.state.events.length, 1);
  assert.equal(JSON.stringify([f.setting.accounts, f.setting.preferences, f.setting.activation.signals]), before);
  assert.equal((await f.pause()).changed, false); assert.equal(f.state.events.length, 1);
  assert.doesNotMatch(JSON.stringify(publicSettings(f.setting, f.scope)), /grant_fingerprint|proof_run_id|customers\/20|preserved/);
});
test('pause rejects stale versions and scope/permission changes, rolls back audit errors and ignores no deployment gate', async () => {
  for (const mutate of [f => { f.state.permitted = false; }, f => { f.state.clinics.pop(); }, f => { f.state.failAudit = true; }]) {
    const f = fixture(); await f.activate(); mutate(f); await assert.rejects(f.pause());
    assert.equal(f.setting.activation.optimization.status, 'active'); assert.equal(f.setting.version, 4); assert.equal(f.state.events.length, 0);
  }
  const f = fixture(); await f.activate();
  await assert.rejects(f.pause({ input: { expected_version: 1, confirmed: true } }), /workspace_version_conflict/);
  await assert.rejects(f.pause({ input: { expected_version: 4, confirmed: true, signals: false } }), /invalid_workspace_optimization_pause/);
});

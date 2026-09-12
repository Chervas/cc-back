'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadOptimizationPreparation, checkOptimizationPreparation } = require('../../services/campaignWorkspaceOptimizationPreparation.service');
const { ACTIONS, digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');

function fixture(provider = 'google_ads') {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const reference = { provider, account_id: '20', campaign_id: '30' };
  const state = { now: new Date('2026-09-11T10:00:00Z'), permitted: true, reads: 0, oauth: 0, events: [], rollbacks: 0,
    grant: 'grant-1', failAudit: false, permissionChecks: [], signalEvents: [],
    clinics: [{ id_clinica: 1, estado_clinica: 1 }, { id_clinica: 2, estado_clinica: 1 }] };
  const setting = { id: 'setting-1', version: 1, scope_type: 'group', scope_id: 10,
    accounts: [{ provider, account_id: '20', include_future: true, campaign_ids: [] }],
    preferences: { mode: 'optimize', signals: { enabled: false, events: [] }, optimization: { actions: ['adjust_bids'], budget_changes: false, monthly_limit_cents: null } },
    activation: { mode: 'measurement', signals: { enabled: false } },
    update: async values => { Object.assign(setting, values); return setting; } };
  const campaign = { ...reference, id: `${provider}:20:30`, assigned: true, clinicId: 1 };
  const context = async () => ({ campaign, setting, connection: { id: 9, accessToken: 'private-token' },
    account: { fingerprint: state.grant, connection: { id: 9, accessToken: 'private-token' }, loginCustomerId: '100' } });
  const models = {
    sequelize: { transaction: async run => {
      const before = structuredClone({ events: state.events, version: setting.version });
      try { return await run(transaction); } catch (error) { state.events = before.events; setting.version = before.version; state.rollbacks++; throw error; }
    } },
    GrupoClinica: { findByPk: async () => ({ id_grupo: 10 }) },
    Clinica: { findByPk: async id => state.clinics.find(row => row.id_clinica === id), findAll: async () => state.clinics },
    CampaignWorkspaceSetting: { findOne: async () => setting },
    CampaignWorkspaceEvent: { findOne: async options => {
      assert.equal(options.where.setting_id, setting.id); assert.equal(options.where.event_type, 'optimization_check');
      return [...state.events].reverse().find(row => row.changes.reference.provider === options.where['changes.reference.provider']
        && row.changes.reference.account_id === options.where['changes.reference.account_id']
        && row.changes.reference.campaign_id === options.where['changes.reference.campaign_id']);
    }, create: async (row, options) => {
      assert.equal(options.transaction, transaction); if (state.failAudit) throw new Error('audit_failed');
      assert.ok(!state.events.some(event => event.version === row.version)); state.events.push(structuredClone(row)); return row;
    } },
  };
  const inspect = async input => {
    state.reads++; assert.deepEqual(input.reference, reference);
    if (state.inspect) await state.inspect();
    const target = provider === 'google_ads'
      ? { action: 'adjust_bids', entity: 'ad_group', id: '50', resource: 'customers/20/adGroups/50', field: 'cpc_bid_micros', unit: 'micros', strategy: 'MANUAL_CPC', value: '300000' }
      : { action: 'adjust_bids', entity: 'ad_set', id: '50', resource: '50', field: 'bid_amount', unit: 'minor', strategy: 'LOWEST_COST_WITH_BID_CAP', value: '30' };
    const inspection = { schema_version: 1, reference, currency: 'EUR', targets: [target],
      actions: ACTIONS.map(action => ({ action, targets: Number(action === 'adjust_bids'), reasons: [] })) };
    inspection.fingerprint = digest([reference, inspection.currency, inspection.targets, inspection.actions]);
    return inspection;
  };
  const options = { models, scope: { groupId: 10, clinicIds: [1, 2] }, actorId: 7,
    hasAccess: async input => { state.permissionChecks.push(input); return state.permitted; },
    googleContext: context, metaContext: context,
    metaGrant: async input => { state.signalEvents.push(input.signalEvents); return { grantFingerprint: state.grant, connection: { id: 9, accessToken: 'private-token' } }; },
    ensureToken: async () => { state.oauth++; return { accessToken: 'private-token' }; },
    inspectGoogle: inspect, inspectMeta: inspect, now: () => state.now };
  return { state, setting, campaign, options, read: () => loadOptimizationPreparation({ ...options, input: reference }),
    check: extra => checkOptimizationPreparation({ ...options, input: { ...reference, expected_version: setting.version }, ...extra }) };
}

test('cached optimization GET performs no OAuth/provider requests or writes', async () => {
  const f = fixture(); const result = await f.read();
  assert.equal(result.preparation.status, 'unchecked'); assert.equal(result.preparation.authorized, false);
  assert.equal(f.state.reads, 0); assert.equal(f.state.oauth, 0); assert.equal(f.state.events.length, 0);
});
test('Google and Meta checks persist auditable proofs, never preferences, activation or CRM signal authorizations', async () => {
  for (const provider of ['google_ads', 'meta_ads']) {
    const f = fixture(provider); const before = JSON.stringify([f.setting.activation, f.setting.preferences, f.setting.accounts]);
    const result = await f.check();
    assert.equal(result.preparation.status, 'checked'); assert.equal(result.preparation.compatible, true); assert.equal(result.preparation.authorized, false);
    assert.equal(f.state.events.length, 2); assert.equal(f.setting.version, 3);
    assert.ok(f.state.events.every(row => row.changes.provider_mutation === false));
    assert.equal(JSON.stringify([f.setting.activation, f.setting.preferences, f.setting.accounts]), before);
    assert.doesNotMatch(JSON.stringify(result), /private-resource|private-token|private-fingerprint|grant-1/);
    assert.equal(result.preparation.actions.find(row => row.action === 'adjust_budget').requested, false);
    await f.read(); await f.read(); assert.equal(f.state.reads, 1); assert.equal(f.state.events.length, 2);
    assert.equal(f.state.oauth, provider === 'google_ads' ? 1 : 0);
  }
});
test('persistent proofs expire after 24 hours and changes in grants, selection or limits invalidate them', async () => {
  for (const mutate of [f => { f.state.now = new Date(+f.state.now + 86400000); }, f => { f.state.grant = 'grant-2'; },
    f => { f.setting.accounts[0].campaign_ids = ['99']; }, f => { f.setting.preferences.optimization.actions = ['negative_keywords']; }]) {
    const f = fixture(); await f.check(); mutate(f); assert.equal((await f.read()).preparation.status, 'stale');
  }
});
test('a failed fresh check withdraws a previous compatible proof and sanitizes provider errors', async () => {
  const f = fixture(); await f.check(); f.state.inspect = () => { throw Object.assign(new Error('patient@example.test private-token'), { response: { status: 429 } }); };
  const result = await f.check(); assert.equal(result.preparation.status, 'failed'); assert.equal(result.preparation.compatible, false);
  assert.equal(result.preparation.error, 'workspace_optimization_rate_limited'); assert.equal(result.preparation.actions.length, 0);
  assert.doesNotMatch(JSON.stringify(f.state.events), /patient@example|private-token/);
});
test('a second check cannot steal a live lease and stale versions fail before provider I/O', async () => {
  const f = fixture(); let started; const ready = new Promise(resolve => { started = resolve; }); let release;
  f.state.inspect = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const pending = f.check(); await ready;
  await assert.rejects(f.check(), { code: 'workspace_optimization_busy' });
  release(); await pending;
  await assert.rejects(f.check({ input: { provider: 'google_ads', account_id: '20', campaign_id: '30', expected_version: 1 } }), { code: 'workspace_version_conflict' });
  assert.equal(f.state.reads, 1);
});
test('a revoked grant, permission or assignment during I/O cannot become a valid proof', async () => {
  for (const mutate of [f => { f.state.grant = 'changed'; }, f => { f.state.permitted = false; },
    f => { f.campaign.clinicId = 999; }, f => { f.state.clinics.pop(); }]) {
    const f = fixture(); f.state.inspect = () => mutate(f); await assert.rejects(f.check());
    assert.equal(f.state.events.at(-1).changes.status, 'checking');
  }
});
test('permissions, inactive membership, mode selection and reviewed clinic are required before checking', async () => {
  for (const mutate of [f => { f.state.permitted = false; }, f => { f.state.clinics[1].estado_clinica = false; },
    f => { f.setting.preferences.mode = 'measurement'; }, f => { f.campaign.assigned = false; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.check()); assert.equal(f.state.reads, 0); assert.equal(f.state.events.length, 0);
  }
});
test('audit failures roll back the setting version and do not perform the provider check', async () => {
  const f = fixture(); f.state.failAudit = true; await assert.rejects(f.check(), /audit_failed/);
  assert.equal(f.setting.version, 1); assert.equal(f.state.events.length, 0); assert.equal(f.state.reads, 0);
});
test('single-clinic optimization works without enabling CRM signals, and does not create a native-only web config', async () => {
  const f = fixture('meta_ads'); f.options.scope = { clinicIds: [1] };
  const result = await f.check(); assert.equal(result.preparation.status, 'checked');
  assert.equal(f.setting.preferences.signals.enabled, false); assert.ok(!f.options.models.IntakeConfig);
});

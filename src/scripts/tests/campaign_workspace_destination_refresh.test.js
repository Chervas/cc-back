'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { DISPATCH_TYPE, JOB_TYPE, ORIGIN, PAGE_SIZE, enqueueDestinationRefreshes, runDestinationRefresh } = require('../../services/campaignWorkspaceDestinationRefresh.service');

const NOW = new Date('2026-09-11T01:15:00.000Z');
const uid = index => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
const account = (provider = 'google_ads', account_id = '20') => ({ provider, account_id, include_future: true, campaign_ids: [] });
const flags = () => ({ CAMPAIGN_WORKSPACE_DESTINATION_REFRESH_ENABLED: 'true', CAMPAIGN_WORKSPACE_META_DESTINATION_REFRESH_ENABLED: 'true' });
const job = () => ({ type: JOB_TYPE, origin: ORIGIN, requested_by: null });
const payload = (provider = 'google_ads') => ({ schema_version: 1, setting_id: uid(1), provider, account_id: '20', cycle_at: NOW.toISOString() });
const denied = code => Object.assign(new Error('private-provider-body'), { code });

function harness(provider = 'google_ads') {
  const state = { setting: { id: uid(1), scope_type: 'clinic', scope_id: 1, version: 1, updated_by_user_id: 7, accounts: [account(provider)] },
    members: [{ id_clinica: 1, estado_clinica: true }], clinicSettings: [], user: { id_usuario: 7, estado_cuenta: 'activo' }, access: true,
    env: flags(), campaigns: ['30', '31', '32'].map(campaign_id => ({ provider, account_id: '20', campaign_id,
      status: 'ENABLED', assigned: true, clinicId: 1 })), proofs: new Map(), queued: [], refreshed: [], calls: [], now: NOW };
  const models = {
    CampaignWorkspaceSetting: { findByPk: async () => structuredClone(state.setting), findAll: async () => state.clinicSettings,
      findOne: async options => state.clinicSettings.find(row => row.scope_id === options.where.scope_id) || null },
    Usuario: { findByPk: async userId => { assert.equal(userId, 7); return state.user; } },
    Clinica: { findByPk: async () => state.members[0] || null, findAll: async () => state.members },
  };
  const context = async ({ reference }) => {
    state.calls.push(reference); if (state.contextError) throw state.contextError;
    const proof = state.proofs.get(reference.campaign_id);
    return { revision: 'a'.repeat(64), detection: proof, cached: { destination_detection: proof }, account: { fingerprint: 'authorized' } };
  };
  const refresh = async options => {
    state.refreshed.push(options.input.campaign_id);
    assert.equal(options.input.revision, 'a'.repeat(64)); assert.equal(options.actorId, 7);
    await options.authorize();
    if (state.duringRead) state.duringRead();
    await options.authorize();
    if (state.refreshError) throw state.refreshError;
    state.proofs.set(options.input.campaign_id, state.refreshProof || { source: provider === 'google_ads' ? 'workspace_google_ads' : 'workspace_meta_graph',
      status: 'checked', checked_at: state.now.toISOString(), complete: true, access_fingerprint: 'authorized' });
  };
  const deps = { models, env: state.env, now: () => state.now,
    hasAccess: async options => { assert.equal(options.access, 'write'); assert.equal(options.userId, 7); return state.access; },
    loadInventory: async options => {
      assert.deepEqual(options.accountReference, { provider, account_id: '20' }); return { campaigns: state.campaigns };
    },
    googleContext: context, metaContext: context, refreshGoogle: refresh, refreshMeta: refresh,
    enqueue: async request => { state.queued.push(request); if (state.enqueueError) throw state.enqueueError; return { created: true }; },
  };
  return { state, deps, run: (input = payload(provider), request = job()) => runDestinationRefresh(input, request, deps) };
}

test('closed gates do not read the database, enqueue work or touch a provider', async () => {
  const unavailable = new Proxy({}, { get: () => { throw new Error('unreachable'); } });
  assert.equal((await enqueueDestinationRefreshes({}, { env: {}, models: unavailable })).disabled, true);
  assert.equal((await runDestinationRefresh(payload(), job(), { env: {}, models: unavailable })).disabled, true);
  const h = harness('meta_ads'); delete h.state.env.CAMPAIGN_WORKSPACE_META_DESTINATION_REFRESH_ENABLED;
  assert.equal((await h.run()).disabled, true); assert.equal(h.state.calls.length, 0);
});

test('the dispatcher pages all settings by immutable ID and continues without tokens or provider calls', async () => {
  const settings = Array.from({ length: PAGE_SIZE * 2 + 3 }, (_, index) => ({ id: uid(index + 1), accounts: [account(), account(), account('meta_ads')] }));
  const queued = []; const queries = []; let created = 0; const continuations = [{}];
  const deps = { env: flags(), now: () => NOW,
    models: { CampaignWorkspaceSetting: { findAll: async options => {
      queries.push(options); return settings.filter(row => !options.where.id || row.id > options.where.id[Op.gt]).slice(0, options.limit);
    } } }, enqueue: async item => { queued.push(item); if (item.type === DISPATCH_TYPE) continuations.push(item.payload); return { created: true }; } };
  while (continuations.length) {
    const result = await enqueueDestinationRefreshes(continuations.shift(), deps);
    assert.equal(result.status, 'completed'); created += result.queued;
  }
  assert.equal(created, settings.length * 2); assert.equal(queries.length, 3);
  assert.ok(queries.every(query => query.limit === PAGE_SIZE + 1 && query.order[0][0] === 'id'));
  for (const request of queued.filter(row => row.type === JOB_TYPE)) {
    assert.deepEqual(Object.keys(request.payload).sort(), ['account_id', 'cycle_at', 'provider', 'schema_version', 'setting_id']);
    assert.equal(request.origin, ORIGIN); assert.equal(request.maxAttempts, 3); assert.equal(request.requested_by, undefined);
  }
});

test('the dispatcher can refresh Google while Meta remains independently blocked', async () => {
  const queued = [];
  const result = await enqueueDestinationRefreshes({}, { now: () => NOW, env: { CAMPAIGN_WORKSPACE_DESTINATION_REFRESH_ENABLED: 'true' },
    models: { CampaignWorkspaceSetting: { findAll: async () => [{ id: uid(1), accounts: [account(), account('meta_ads'), account('unknown')] }] } },
    enqueue: async request => { queued.push(request); return { created: false }; } });
  assert.equal(result.queued, 0); assert.equal(result.duplicates, 1); assert.equal(queued[0].payload.provider, 'google_ads');
});

test('a partially enqueued dispatcher retry retains the persisted root timestamp and dedupe scopes', async () => {
  const requests = []; let shouldFail = true;
  const deps = { jobRequestId: 12, env: flags(), now: () => new Date(+NOW + 10000),
    models: { JobRequest: { findByPk: async id => { assert.equal(id, 12); return { created_at: NOW }; } },
      CampaignWorkspaceSetting: { findAll: async () => [{ id: uid(1), accounts: [account(), account('meta_ads')] }] } },
    enqueue: async request => { requests.push(request); if (requests.length === 2 && shouldFail) throw new Error('queue unavailable'); return { created: true }; } };
  assert.equal((await enqueueDestinationRefreshes({}, deps)).retryable, true);
  shouldFail = false;
  assert.equal((await enqueueDestinationRefreshes({}, deps)).status, 'completed');
  assert.equal(requests[0].dedupeScope, requests[2].dedupeScope);
  assert.equal(requests[0].payload.cycle_at, NOW.toISOString());
});

for (const provider of ['google_ads', 'meta_ads']) {
  test(`${provider}: walks every included campaign, not only the first table page, with durable cursors`, async () => {
    const h = harness(provider);
    h.state.campaigns = Array.from({ length: 37 }, (_, index) => ({ ...h.state.campaigns[0], campaign_id: String(30 + index) }));
    let input = payload(provider);
    for (let index = 0; index < h.state.campaigns.length; index++) {
      const result = await h.run(input);
      assert.equal(result.status, 'completed'); assert.equal(result.checked, 1);
      assert.equal(result.continued, index < 36);
      input = h.state.queued.at(-1)?.payload;
    }
    assert.equal(h.state.refreshed.length, 37); assert.equal(new Set(h.state.refreshed).size, 37);
    assert.equal(h.state.queued.length, 36);
    assert.ok(h.state.queued.every(row => row.type === JOB_TYPE && row.origin === ORIGIN && row.payload.cycle_at === NOW.toISOString()));
  });

  test(`${provider}: explicit selections exclude future campaigns, unassigned and archived campaigns`, async () => {
    const h = harness(provider); h.state.setting.accounts[0] = { ...account(provider), include_future: false, campaign_ids: ['30', '31', '32', '33'] };
    h.state.campaigns[0].assigned = false; h.state.campaigns[1].status = 'ARCHIVED';
    h.state.campaigns.push({ ...h.state.campaigns[2], campaign_id: '34' });
    const result = await h.run();
    assert.equal(result.pending_assignment, 1); assert.equal(result.continued, false); assert.deepEqual(h.state.refreshed, ['32']);
  });

  test(`${provider}: include_future discovers a newly cached campaign without a manual reconciliation`, async () => {
    const h = harness(provider); h.state.campaigns = [h.state.campaigns[0]];
    await h.run(); h.state.campaigns.push({ ...h.state.campaigns[0], campaign_id: '41' });
    h.state.now = new Date(+NOW + 86400000);
    await h.run({ ...payload(provider), cycle_at: h.state.now.toISOString() });
    await h.run(h.state.queued.at(-1).payload);
    assert.deepEqual(h.state.refreshed, ['30', '30', '41']);
  });

  test(`${provider}: retry after a cache commit and queue error does not repeat provider reads`, async () => {
    const h = harness(provider); h.state.enqueueError = new Error('queue error');
    assert.equal((await h.run()).retryable, true);
    h.state.enqueueError = null;
    const second = await h.run();
    assert.equal(second.status, 'completed'); assert.equal(second.cached, 1); assert.deepEqual(h.state.refreshed, ['30']);
  });

  test(`${provider}: rejects private job payload fields, invalid identities, foreign origins and stale cycles`, async () => {
    const h = harness(provider);
    for (const patch of [{ token: 'never-persist-this' }, { actor_id: 1 }, { account_id: '../me' }, { after_campaign_id: 30 },
      { cycle_at: 'yesterday' }, { cycle_at: new Date(+NOW + 1).toISOString() }, { cycle_at: new Date(+NOW - 86400000).toISOString() }, { setting_id: 'invalid' }]) {
      const result = await h.run({ ...payload(provider), ...patch });
      assert.equal(result.status, 'failed'); assert.equal(result.retryable, false);
    }
    for (const request of [null, { ...job(), origin: 'manual' }, { ...job(), requested_by: 7 }, { ...job(), type: 'another' }]) {
      assert.equal((await h.run(payload(provider), request)).error_message, 'workspace_destination_job_invalid');
    }
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.queued.length, 0);
  });

  test(`${provider}: no fallback to a privileged user or another account after permission or scope revocation`, async () => {
    for (const mutate of [h => { h.state.user = null; }, h => { h.state.user.estado_cuenta = 'bloqueado'; },
      h => { h.state.access = false; }, h => { h.state.setting.accounts = []; }, h => { h.state.setting = null; },
      h => { h.state.members[0].estado_clinica = false; }, h => { h.state.members = []; }]) {
      const h = harness(provider); mutate(h);
      const result = await h.run(); assert.equal(result.status, 'failed'); assert.equal(result.retryable, false);
      assert.equal(h.state.calls.length, 0); assert.equal(h.state.refreshed.length, 0);
    }
  });

  test(`${provider}: group scope includes every current member and is checked again during I/O`, async () => {
    const h = harness(provider); h.state.setting.scope_type = 'group';
    h.state.members.push({ id_clinica: 2, estado_clinica: true });
    h.state.duringRead = () => h.state.members.push({ id_clinica: 3, estado_clinica: true });
    const result = await h.run();
    assert.equal(result.error_message, 'workspace_destination_scope_changed'); assert.equal(h.state.proofs.size, 0); assert.equal(h.state.queued.length, 0);
  });

  test(`${provider}: configuration, actor permissions and runtime gates are rechecked before committing`, async () => {
    for (const mutate of [h => { h.state.setting.version++; }, h => { h.state.setting.accounts = []; },
      h => { h.state.access = false; }, h => { h.state.user.estado_cuenta = 'bloqueado'; },
      h => { h.state.env.CAMPAIGN_WORKSPACE_DESTINATION_REFRESH_ENABLED = 'false'; }]) {
      const h = harness(provider); h.state.duringRead = () => mutate(h);
      const result = await h.run(); assert.equal(result.status, 'failed'); assert.equal(result.retryable, false);
      assert.equal(h.state.proofs.size, 0); assert.equal(h.state.queued.length, 0);
    }
  });

  test(`${provider}: a clinic exclusion overrides a group selection, also when changed during a check`, async () => {
    const h = harness(provider); h.state.setting.scope_type = 'group';
    h.state.clinicSettings = [{ scope_id: 1, accounts: [] }];
    assert.equal((await h.run()).checked, 0); assert.equal(h.state.refreshed.length, 0);
    h.state.clinicSettings = [];
    h.state.duringRead = () => { h.state.clinicSettings = [{ scope_id: 1, accounts: [] }]; };
    assert.equal((await h.run()).error_message, 'workspace_destination_account_not_selected');
    assert.equal(h.state.proofs.size, 0); assert.equal(h.state.queued.length, 0);
  });

  test(`${provider}: a persisted permission rejection stops the account until an explicit check`, async () => {
    const h = harness(provider); const error = `workspace_${provider === 'google_ads' ? 'google' : 'meta'}_permissions_required`;
    h.state.proofs.set('30', { status: 'failed', error, check_status: 'failed', check_error: error });
    const result = await h.run(); assert.equal(result.error_message, error); assert.equal(result.retryable, false);
    assert.equal(h.state.refreshed.length, 0); assert.equal(h.state.queued.length, 0);
  });

  test(`${provider}: provider errors are sanitized; auth is terminal, throttling has bounded retries`, async () => {
    for (const suffix of ['permissions_required', 'rate_limited', 'unavailable']) {
      const h = harness(provider); const code = `workspace_${provider === 'google_ads' ? 'google' : 'meta'}_${suffix}`;
      if (provider === 'google_ads') h.state.refreshProof = { status: 'failed', error: code };
      else h.state.refreshError = denied(code);
      const result = await h.run();
      assert.equal(result.error_message, code); assert.equal(result.retryable, suffix !== 'permissions_required');
      assert.ok(!JSON.stringify(result).includes('private-provider-body')); assert.equal(h.state.queued.length, 0);
    }
  });
}

test('the Google cache must belong to the current grant before suppressing a repeated check', async () => {
  const h = harness(); h.state.proofs.set('30', { status: 'checked', complete: true, checked_at: NOW.toISOString(), access_fingerprint: 'old-grant' });
  assert.equal((await h.run()).checked, 1); assert.deepEqual(h.state.refreshed, ['30']);
});

test('a recent legacy timestamp is not a completed workspace destination check', async () => {
  for (const provider of ['google_ads', 'meta_ads']) {
    const h = harness(provider); h.state.proofs.set('30', { source: 'legacy_observed_urls', status: 'checked',
      checked_at: NOW.toISOString(), complete: true, access_fingerprint: 'authorized' });
    assert.equal((await h.run()).checked, 1); assert.deepEqual(h.state.refreshed, ['30']);
  }
});

test('a missing destination or incomplete response is cached without pretending reception is ready', async () => {
  const h = harness(); h.state.refreshProof = { status: 'checked', complete: false, kind: 'unknown', checked_at: NOW.toISOString(), access_fingerprint: 'authorized' };
  assert.equal((await h.run()).status, 'completed'); assert.equal(h.state.proofs.get('30').complete, false);
  assert.equal(h.state.queued.length, 1);
});

test('an unexpected exception cannot leak credentials in a job result or use a different token', async () => {
  const h = harness('meta_ads'); h.state.refreshError = new Error('access_token=private-content');
  const result = await h.run(); assert.equal(result.error_message, 'workspace_destination_refresh_failed');
  assert.ok(!JSON.stringify(result).includes('private-content')); assert.equal(h.state.refreshed.length, 1); assert.equal(h.state.queued.length, 0);
});

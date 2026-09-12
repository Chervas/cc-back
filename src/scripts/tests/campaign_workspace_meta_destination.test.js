'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { campaignReference, creativeDestinations, detectDestinations, graphList, revision, refreshMetaCampaignDestinations } = require('../../services/campaignWorkspaceMetaDestination.service');

const now = new Date('2026-09-10T15:00:00Z');
const ad = (id = '10', patch = {}) => ({ id, account_id: '20', campaign_id: '30', effective_status: 'ACTIVE',
  creative: { object_story_spec: { page_id: '40', link_data: { link: 'https://clinic.example',
    call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: '50', link: 'https://clinic.example/privacy' } } } } }, ...patch });

test('Meta preparation only accepts exact provider IDs and a cache revision, never browser ownership or tokens', () => {
  const input = { account_id: '20', campaign_id: '30', revision: revision(null) };
  assert.equal(campaignReference(input, true).provider, 'meta_ads');
  for (const patch of [{ account_id: 'act_20' }, { campaign_id: '../me' }, { actorId: 3 }, { token: 'private' }, { campaign_id: 30 }, { revision: null }]) {
    assert.throws(() => campaignReference({ ...input, ...patch }, true), /invalid_meta_preparation/);
  }
});
test('a native CTA website link is not classified as a second reception destination', () => {
  const result = creativeDestinations(ad());
  assert.deepEqual(result.forms, [{ form_id: '50', page_id: '40', ad_ids: ['10'] }]);
  assert.deepEqual(result.urls, []);
});
test('video, template and carousel CTA form references are detected and deduplicated across ads', () => {
  for (const block of ['video_data', 'template_data']) {
    assert.equal(creativeDestinations(ad('10', { creative: { object_story_spec: { page_id: '40', [block]: {
      call_to_action: { value: { lead_gen_form_id: '50' } },
    } } } })).forms[0].form_id, '50');
  }
  const result = detectDestinations([ad(), ad('11')], true, now);
  assert.equal(result.kind, 'lead_form'); assert.deepEqual(result.forms[0].ad_ids, ['10', '11']);
});
test('every ad matters: mixed, unknown, missing, or incompletely paginated creatives never become fully prepared', () => {
  const web = ad('11', { creative: { link_url: 'https://clinic.example/landing' } });
  assert.equal(detectDestinations([ad(), web], true, now).kind, 'mixed');
  assert.equal(detectDestinations([ad(), ad('11', { creative: {} })], true, now).complete, false);
  assert.equal(detectDestinations([ad()], false, now).kind, 'unknown');
  assert.equal(detectDestinations([], true, now).complete, false);
});
test('dynamic website URLs are all retained but credentials, internal Meta destinations and calls are not treated as forms', () => {
  const result = creativeDestinations(ad('1', { creative: { call_to_action_type: 'MAKE_AN_APPOINTMENT',
    asset_feed_spec: { link_urls: [{ website_url: 'https://a.example/' }, { website_url: 'https://b.example/' }] } } }));
  assert.deepEqual(result.urls, ['https://a.example/', 'https://b.example/']); assert.equal(result.known, true);
  for (const link_url of ['javascript:alert(1)', 'https://user:secret@example.org', 'https://wa.me/123', '//example.org']) {
    assert.equal(creativeDestinations(ad('1', { creative: { link_url } })).known, false);
  }
  assert.equal(creativeDestinations(ad('1', { creative: { call_to_action_type: 'CALL_NOW', link_url: 'https://a.example/' } })).known, false);
});
test('paging uses opaque cursors on the authorized endpoint, never next URLs; repeated and missing cursors are incomplete', async () => {
  const calls = [];
  const result = await graphList('30/ads', 'id', 'private', async (path, options) => {
    calls.push({ path, options }); return calls.length === 1
      ? { data: { data: [ad()], paging: { next: 'https://evil.example/?access_token=steal', cursors: { after: 'opaque' } } } }
      : { data: { data: [ad('11')] } };
  });
  assert.equal(result.rows.length, 2); assert.equal(result.complete, true);
  assert.ok(calls.every(call => call.path === '30/ads')); assert.equal(calls[1].options.params.after, 'opaque');
  for (const cursors of [undefined, { after: 'repeat' }]) {
    const partial = await graphList('30/ads', 'id', 'private', async () => ({ data: { data: [], paging: { next: 'next', cursors } } }));
    assert.equal(partial.complete, false);
  }
});

function harness() {
  const campaign = { id: 'meta_ads:20:30', provider: 'meta_ads', account_id: '20', campaign_id: '30', clinicId: 1,
    assigned: true, name: 'Campaign', accountName: 'Account', status: 'ACTIVE', lastSeenAt: now };
  const state = { campaigns: [campaign], setting: null, cached: null, writes: [], calls: [], assignments: [{ scopeKey: 'clinic:1', metaConnectionId: 7 }],
    connection: { id: 7, accessToken: 'private-token', expiresAt: '2099-01-01' }, graphRows: [ad()], beforeTransaction: null,
    transactions: 0, now };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    Clinica: { findByPk: async () => ({ id_clinica: 1 }) },
    CampaignWorkspaceSetting: { findOne: async () => structuredClone(state.setting) },
    ClinicMetaAsset: { findAll: async () => [{ assignmentScope: 'clinic', clinicaId: 1, metaConnectionId: 7 }] },
    MetaConnectionAssignment: { findAll: async () => state.assignments },
    MetaConnection: { findByPk: async () => structuredClone(state.connection) },
    ExternalCampaignInventory: { findAll: async () => state.cached ? [state.cached] : [],
      create: async (value, options) => { assert.equal(options.transaction, transaction); state.writes.push(value); state.cached = { id: 1, ...value }; },
      update: async (value, options) => { assert.equal(options.transaction, transaction); state.writes.push(value); state.cached = { ...state.cached, ...value }; } },
    sequelize: { transaction: async fn => { state.beforeTransaction?.(++state.transactions); return fn(transaction); } },
  };
  const loadInventory = async () => ({ campaigns: state.campaigns, selectedClinics: [{ id_clinica: 1, estado_clinica: 1 }] });
  const read = async (path, options) => {
    state.calls.push({ path, options });
    await state.beforeRead?.(path);
    if (state.graphError) throw state.graphError;
    if (path !== '30/ads' && state.formError) throw state.formError;
    return path === '30/ads' ? { data: { data: state.graphRows } }
      : { data: { id: '50', page_id: '40', name: 'First visit', status: 'ACTIVE', ...state.form } };
  };
  return { state, models, loadInventory, read, run: (options = {}) => refreshMetaCampaignDestinations({ models, scope: { clinicIds: [1] },
    input: { account_id: '20', campaign_id: '30', revision: revision(state.cached?.destination_detection) }, loadInventory, now: () => state.now, read, ...options }) };
}
test('nightly Meta worker invokes the real scoped detector, saves the cache and makes no publication or lead request', async () => {
  const { JOB_TYPE, ORIGIN, runDestinationRefresh } = require('../../services/campaignWorkspaceDestinationRefresh.service');
  const h = harness();
  h.state.setting = { id: '11111111-1111-4111-8111-111111111111', version: 1, scope_type: 'clinic', scope_id: 1,
    updated_by_user_id: 7, accounts: [{ provider: 'meta_ads', account_id: '20', include_future: true, campaign_ids: [] }] };
  h.models.CampaignWorkspaceSetting.findByPk = async () => structuredClone(h.state.setting);
  h.models.Usuario = { findByPk: async () => ({ id_usuario: 7, estado_cuenta: 'activo' }) };
  h.models.Clinica.findByPk = async () => ({ id_clinica: 1, estado_clinica: true });
  const deps = { models: h.models, loadInventory: h.loadInventory, hasAccess: async () => true, now: () => now,
    env: { CAMPAIGN_WORKSPACE_DESTINATION_REFRESH_ENABLED: 'true', CAMPAIGN_WORKSPACE_META_DESTINATION_REFRESH_ENABLED: 'true' },
    refreshMeta: args => refreshMetaCampaignDestinations({ ...args, read: h.read }),
    enqueue: async () => { throw new Error('only_one_campaign'); } };
  const payload = { schema_version: 1, setting_id: h.state.setting.id, provider: 'meta_ads', account_id: '20', cycle_at: now.toISOString() };
  const request = { type: JOB_TYPE, origin: ORIGIN, requested_by: null };
  const result = await runDestinationRefresh(payload, request, deps);
  assert.equal(result.status, 'completed'); assert.equal(result.checked, 1);
  assert.equal(h.state.cached.destination_detection.complete, true);
  assert.deepEqual(h.state.calls.map(row => row.path), ['30/ads', '50']);
  assert.equal((await runDestinationRefresh(payload, request, deps)).cached, 1);
  assert.equal(h.state.calls.length, 2);
  h.state.graphError = { response: { status: 401, data: { error: { code: 190 } } } };
  const nextCycle = { ...payload, cycle_at: new Date(+now + 86400000).toISOString() };
  deps.now = () => new Date(nextCycle.cycle_at);
  assert.equal((await runDestinationRefresh(nextCycle, request, deps)).retryable, false);
  assert.equal(h.state.cached.destination_detection.complete, false);
  assert.equal((await runDestinationRefresh(nextCycle, request, deps)).retryable, false);
  assert.equal(h.state.calls.length, 3, 'a rejected credential is not retried by the nightly worker');
});
test('a background check revalidates its workspace actor before I/O and before the cache commit', async () => {
  for (const deniedAt of [1, 2]) {
    const h = harness(); let checks = 0;
    await assert.rejects(h.run({ authorize: async ({ transaction }) => {
      assert.ok(transaction); if (++checks === deniedAt) throw new Error('actor_revoked');
    } }), /actor_revoked/);
    assert.equal(h.state.writes.length, deniedAt === 1 ? 0 : 1);
    assert.equal(h.state.calls.length, deniedAt === 1 ? 0 : 2);
  }
});
test('a scoped check persists only destination metadata, with no asset, subscription, signal or advertising mutation', async () => {
  const h = harness(); await h.run();
  assert.equal(h.state.writes.length, 2); const detection = h.state.writes.at(-1).destination_detection;
  assert.equal(h.state.writes[0].destination_detection.complete, false);
  assert.equal(h.state.writes[0].destination_detection.check_status, 'checking');
  assert.equal(detection.kind, 'lead_form'); assert.equal(detection.forms[0].name, 'First visit');
  assert.ok(!JSON.stringify(h.state.writes).includes('private-token'));
  assert.ok(h.state.calls.every(call => !/leads|subscribed_apps/.test(call.path)));
  assert.ok(h.state.calls.every(call => call.options.maxRetries === 0 && call.options.timeout <= 10000));
});
test('unknown, unassigned, excluded and unauthorized campaigns cannot trigger provider queries', async () => {
  for (const mutate of [h => { h.state.campaigns = []; }, h => { h.state.campaigns[0].assigned = false; },
    h => { h.state.setting = { accounts: [] }; }, h => { h.state.assignments = []; },
    h => { h.state.connection.expiresAt = '2020-01-01'; }, h => { h.state.connection.expiresAt = 'invalid'; },
    h => { h.state.connection.expiresAt = null; }]) {
    const h = harness(); mutate(h); await assert.rejects(h.run()); assert.equal(h.state.calls.length, 0); assert.equal(h.state.writes.length, 0);
  }
});
test('a scope revocation or cache edit during provider IO cannot be committed', async () => {
  for (const mutate of [h => { h.state.assignments = []; }, h => { h.state.cached = { id: 1, destination_detection: { changed: true } }; },
    h => { h.state.setting = { accounts: [] }; }, h => { h.state.connection.accessToken = 'replaced-private-token'; }]) {
    const h = harness(); h.state.beforeTransaction = count => { if (count === 2) mutate(h); };
    await assert.rejects(h.run()); assert.equal(h.state.writes.length, 1);
    assert.equal(h.state.writes[0].destination_detection.complete, false);
  }
});
test('provider identities are checked against the chosen account and campaign, including forms and conflicting duplicates', async () => {
  for (const patch of [{ account_id: '999' }, { campaign_id: '999' }, { id: 10 }]) {
    const h = harness(); h.state.graphRows = [ad('10', patch)];
    await assert.rejects(h.run(), /identity_mismatch/); assert.equal(h.state.cached.destination_detection.complete, false);
  }
  const h = harness(); h.state.form = { page_id: '999' };
  await assert.rejects(h.run(), /identity_mismatch/);
  const duplicate = harness(); duplicate.state.graphRows = [ad(), ad('10', { creative: {} })];
  await assert.rejects(duplicate.run(), /identity_mismatch/);
});
test('permission and rate-limit errors preserve historical destinations but invalidate the previous successful proof', async () => {
  for (const code of [190, 4, 500]) {
    const h = harness(); await h.run(); const before = structuredClone(h.state.cached.destination_detection);
    h.state.graphError = { response: { data: { error: { code, message: 'private-contact' } } }, config: { token: 'private-token' } };
    await assert.rejects(h.run(), error => { assert.equal(error.status, 409); assert.ok(!JSON.stringify(error).includes('private')); return true; });
    const after = h.state.cached.destination_detection;
    assert.equal(after.complete, false); assert.equal(after.check_status, 'failed');
    assert.deepEqual(after.forms, before.forms); assert.deepEqual(after.urls, before.urls);
    assert.equal(after.checked_at, before.checked_at);
    assert.ok(!JSON.stringify(after).includes('private'));
  }
});
test('partial form metadata is not advertised as a proven permission to retrieve leads', async () => {
  const h = harness(); h.state.form = { name: null };
  await h.run();
  const form = h.state.writes.at(-1).destination_detection.forms[0];
  assert.equal(form.metadata_accessible, true); assert.equal(form.leads_accessible, undefined);
});

test('a check invalidates a cached success before the first provider call and prevents concurrent reads', async () => {
  const h = harness(); await h.run(); h.state.calls = [];
  h.state.beforeRead = async path => {
    if (path !== '30/ads') return;
    assert.equal(h.state.cached.destination_detection.complete, false);
    assert.equal(h.state.cached.destination_detection.check_status, 'checking');
    await assert.rejects(h.run(), /workspace_meta_check_busy/);
  };
  await h.run(); assert.equal(h.state.calls.length, 2);
  assert.equal(h.state.cached.destination_detection.complete, true);
  assert.equal(h.state.cached.destination_detection.check_status, undefined);
});

test('an invalid session encountered in form metadata stops the check, without trying another form or token', async () => {
  const h = harness(); h.state.graphRows = [ad(), ad('11', { creative: { call_to_action: { value: { lead_gen_form_id: '51' } } } })];
  h.state.formError = { response: { status: 401, data: { error: { code: 190, error_subcode: 460 } } } };
  await assert.rejects(h.run(), error => error.code === 'workspace_meta_permissions_required');
  assert.deepEqual(h.state.calls.map(call => call.path), ['30/ads', '50']);
  assert.equal(h.state.cached.destination_detection.check_error, 'workspace_meta_permissions_required');
});

test('an expired check can be replaced, but its delayed response cannot overwrite the newer proof', async () => {
  const h = harness(); let entered; let release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  h.state.beforeRead = async () => { h.state.beforeRead = null; entered(); await blocked; };
  const first = h.run(); await waiting;
  h.state.now = new Date(+now + 121000);
  await h.run(); const newer = structuredClone(h.state.cached.destination_detection);
  release(); await assert.rejects(first, /workspace_meta_check_conflict/);
  assert.deepEqual(h.state.cached.destination_detection, newer);
  assert.equal(newer.complete, true);
});

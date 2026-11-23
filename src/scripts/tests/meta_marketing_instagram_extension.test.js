'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const C = require('../../services/metaMarketingEnrollment.contract');
const F = require('../../services/metaMarketingEffectiveCredential.service');
const I = require('../../../services/integrations-broker/src/meta-marketing-instagram-extension-contract');
const { configuration, availableFor } = require('../../services/metaMarketingInstagramExtension.service');

function fixture({ sessionMs = 3600000, tokenMs = null, dataAccessMs = 86400000 } = {}) {
  const clock = +new Date('2030-01-01T12:00:00Z');
  const now = () => new Date(clock);
  const digest = 'a'.repeat(64);
  const input = { scopeKey: 'clinic:77', actorId: 2, sessionRef: randomUUID(), sessionExpiresAt: new Date(clock + sessionMs) };
  const scopes = ['ads_read','pages_read_engagement','public_profile'];
  const flow = { flow_id: randomUUID(), app_id: '101', scopes: JSON.stringify(scopes),
    redirect_uri: 'https://auth.example.invalid/oauth/meta/marketing/callback', expires_at: new Date(clock - 600000) };
  flow.candidate_metadata = JSON.stringify({ versionId: flow.flow_id, digest, appId: flow.app_id, subjectId: '201',
    tokenType: 'USER', scopes, expiresAt: tokenMs === null ? null : clock + tokenMs,
    dataAccessExpiresAt: dataAccessMs === null ? null : clock + dataAccessMs, granularScopes: [] });
  const selected = C.assets([{ assetRef: 'meta-ad_account:301', kind: 'ad_account', id: '301', parentPageId: null },
    { assetRef: 'meta-facebook_page:401', kind: 'facebook_page', id: '401', parentPageId: null }]);
  const enrollment = { enrollment_id: randomUUID(), flow_id: flow.flow_id, session_ref: randomUUID(), prepare_request_id: randomUUID(),
    activate_request_id: randomUUID(), revoke_request_id: randomUUID(), scope_digest: digest, flow_digest: digest, candidate_digest: digest,
    assignment_digest: digest, scope_key: input.scopeKey, actor_user_id: input.actorId, meta_connection_id: 99,
    connection_ref: 'fictitious-connection', meta_user_id: '201', app_id: flow.app_id, clinic_ids: '[77]', assets: JSON.stringify(selected),
    mapping_ids: '[31,32]', session_expires_at: input.sessionExpiresAt, requested_at: now(), updated_at: now(), next_attempt_at: now(),
    prepared_at: now(), activated_at: now(), revoked_at: null, attempts: 0, selection_digest: digest, last_error: null,
    lease_token: null, lease_until: null, state: 'active' };
  const data = { row: null, status: null, calls: [], live: true, legacyMapping: null, loseConfirmResponse: false, providerRejected: false };
  function renewCredential() {
    const renewalId = randomUUID();
    const candidate = { ...JSON.parse(flow.candidate_metadata), versionId: renewalId, digest: 'c'.repeat(64) };
    const receipt = JSON.stringify({ status: 'active', activationApplied: true, renewalId, enrollmentId: enrollment.enrollment_id,
      effectiveCredential: { epoch: 1, versionId: renewalId, digest: candidate.digest, metadata: F.split(candidate) } });
    const metadata = JSON.stringify(candidate);
    data.renewal = { ...enrollment, state: 'active', renewal_id: renewalId, expected_epoch: 0, candidate_metadata: metadata, owner_receipt: receipt };
    data.credential = { enrollment_id: enrollment.enrollment_id, epoch: 1, renewal_id: renewalId, version_id: renewalId,
      candidate_digest: candidate.digest, candidate_metadata: metadata, owner_receipt_digest: C.hash(receipt) };
  }
  const transaction = { LOCK: { UPDATE: true } };
  function journal() {
    return { ...structuredClone(data.row), get() { return structuredClone(data.row); }, async update(patch) {
      Object.assign(data.row, patch);
      Object.assign(this, patch);
    } };
  }
  const models = {
    MetaMarketingInstagramExtension: {
      async findOne({ where }) {
        return data.row && Object.entries(where).every(([field, value]) => data.row[field] === value) ? journal() : null;
      },
      async create(row) { data.row = structuredClone(row); return journal(); },
    },
    MetaMarketingEnrollmentRequest: { async findByPk() { return enrollment; } },
    MetaMarketingOAuthRequest: { async findByPk() { return flow; } },
    MetaMarketingEffectiveCredential: { async findByPk() { return data.credential; } },
    MetaMarketingCredentialRenewal: { async findByPk() { return data.renewal; } },
    ClinicMetaAsset: { async findOne() { return data.legacyMapping; } },
  };
  const source = path.resolve(__dirname, '../../services/metaMarketingInstagramExtension.service.js');
  const loaded = new Module(source, module);
  loaded.filename = source;
  loaded.paths = Module._nodeModulePaths(path.dirname(source));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => ({
    './metaMarketingOAuthScope.service': { createScope: () => ({ authorize() {} }) },
    './metaMarketingTransactionOrder.service': { createOrder: () => ({
      async scope(actor, options, work) {
        if (!data.live) C.fail('meta_instagram_session_required', 401);
        assert.equal(actor.scopeKey, input.scopeKey);
        assert.equal(options.active, true);
        return work({ transaction, enrollment });
      },
    }) },
    './metaMarketingEnrollmentBinding.service': { createBindings: () => ({ async committed() { return { digest }; } }) },
  })[name] || originalRequire(name);
  loaded._compile(fs.readFileSync(source, 'utf8'), source);
  const profile = { id: '501', assetRef: 'meta-instagram_business:501', kind: 'instagram_business', name: 'Navae ficticia', username: 'navae_test' };
  const candidate = { profile, digest: 'b'.repeat(64), expiresAt: clock + 86400000 };
  const client = {
    async execute({ operation, payload, requestId, tenantRef, connectionRef, assetRef }) {
      assert.equal(tenantRef, input.scopeKey);
      assert.equal(connectionRef, enrollment.connection_ref);
      assert.equal(assetRef, 'meta-enroll:' + input.scopeKey);
      const name = Object.keys(I.OPERATIONS).find(key => I.OPERATIONS[key] === operation);
      I.validators[name](payload);
      data.calls.push(name);
      if (name === 'status' && data.statusError) {
        data.onStatusError?.();
        throw Object.assign(Error('fictitious provider status'), { code: data.statusError });
      }
      let result;
      if (name === 'begin') {
        assert.equal(payload.parentPageId, '401');
        assert.equal(payload.assetSetDigest, F.assetSetDigest(selected));
        assert(!JSON.stringify(data.row).includes(payload.state));
        const query = new URLSearchParams({ client_id: flow.app_id, redirect_uri: flow.redirect_uri, response_type: 'code',
          scope: [...scopes, 'instagram_basic'].sort().join(','), state: payload.state });
        result = { flowId: requestId, status: 'awaiting', expiresAt: payload.expiresAt,
          authUrl: 'https://www.facebook.com/v24.0/dialog/oauth?' + query };
        data.status = 'awaiting';
      } else {
        const status = { finish: 'staged', confirm: 'active', abort: 'aborted' }[name];
        if (name === 'finish' && data.providerRejected) throw Object.assign(Error('provider'), { code: 'oauth_credentials_incomplete' });
        if (status) data.status = status;
        if (name === 'confirm' && data.loseConfirmResponse) throw Error('fixture: lost confirmation response');
        result = { flowId: payload.flowId, status: data.status, candidate: ['staged','active'].includes(data.status) ? candidate : null };
      }
      return { requestId, replayed: false, data: result };
    },
  };
  const service = loaded.exports.createService({ models, sessions: {}, client, now, returnOrigin: 'https://app.example.invalid',
    settings: () => ({ scopeKey: input.scopeKey, parentPageId: '401' }) });
  const unchanged = JSON.stringify({ flow, enrollment });
  return { service, data, input, candidate, renewCredential, authUrl: loaded.exports.authUrl, receipt: loaded.exports.receipt, flow, now,
    unchanged: () => assert.equal(JSON.stringify({ flow, enrollment }), unchanged) };
}

test('second consent for Instagram is staged, session-bound and confirmed explicitly without changing Ads/Page', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.overview({ ...f.input, scopeKey: 'clinic:76' }), { enabled: false });
  assert.equal((await f.service.overview(f.input)).status, 'none');
  const begin = await f.service.begin(f.input);
  const state = new URL(begin.authUrl).searchParams.get('state');
  await assert.rejects(f.service.confirm(f.input, begin.flowId, { instagramId: '501', candidateDigest: f.candidate.digest }), { httpStatus: 409 });
  const result = await f.service.callback({ state, code: 'FICTITIOUS_CODE' });
  assert.deepEqual(result, { returnOrigin: 'https://app.example.invalid', requestId: begin.flowId, instagramExtension: true });
  assert.equal((await f.service.overview(f.input)).status, 'staged');
  await assert.rejects(f.service.confirm({ ...f.input, sessionRef: randomUUID() }, begin.flowId,
    { instagramId: '501', candidateDigest: f.candidate.digest }), { httpStatus: 403 });
  f.data.loseConfirmResponse = true;
  await assert.rejects(f.service.confirm(f.input, begin.flowId,
    { instagramId: '501', candidateDigest: f.candidate.digest }), { httpStatus: 503 });
  const active = await f.service.overview(f.input);
  assert.equal(active.status, 'active');
  assert.deepEqual(active.candidate, f.candidate);
  assert.equal(f.data.row.status, 'active');
  assert.equal(f.data.calls.filter(name => name === 'confirm').length, 1);
  assert(!JSON.stringify(f.data.row).includes('FICTITIOUS_CODE'));
  f.renewCredential();
  assert.equal((await f.service.overview(f.input)).status, 'active');
  f.unchanged();
});

test('extension starts after the original OAuth window and respects the current session, token and data-access deadlines', async () => {
  for (const [limits, expectedMs] of [
    [{}, 600000],
    [{ sessionMs: 90000 }, 90000],
    [{ tokenMs: 120000, dataAccessMs: null }, 120000],
    [{ tokenMs: 150000, dataAccessMs: 60000 }, 60000],
    [{ dataAccessMs: null }, 600000],
  ]) {
    const f = fixture(limits);
    assert(+f.flow.expires_at < +f.now());
    assert.equal((await f.service.begin(f.input)).status, 'awaiting');
    assert.equal(+f.data.row.expires_at, +f.now() + expectedMs);
    f.unchanged();
  }
});

test('an expired current Meta credential is a conflict and an expired CRM session is unauthorized', async () => {
  for (const [limits, error] of [
    [{ tokenMs: 0 }, { code: 'meta_instagram_expired', httpStatus: 409 }],
    [{ dataAccessMs: 0 }, { code: 'meta_instagram_expired', httpStatus: 409 }],
    [{ sessionMs: 0 }, { code: 'meta_instagram_session_required', httpStatus: 401 }],
  ]) {
    const f = fixture(limits);
    await assert.rejects(f.service.begin(f.input), error);
    assert.equal(f.data.row, null);
    assert.deepEqual(f.data.calls, []);
  }
});

test('denial, inactive CRM session and prior legacy claims do not replace any connections', async () => {
  const f = fixture();
  const begin = await f.service.begin(f.input);
  const state = new URL(begin.authUrl).searchParams.get('state');
  f.data.live = false;
  await assert.rejects(f.service.callback({ state, code: 'FICTITIOUS_CODE' }), { httpStatus: 401 });
  f.data.live = true;
  await f.service.callback({ state, code: 'FICTITIOUS_CODE' });
  f.data.legacyMapping = { id: 17 };
  assert.equal((await f.service.overview(f.input)).status, 'requires_cleanup');
  await assert.rejects(f.service.confirm(f.input, begin.flowId,
    { instagramId: '501', candidateDigest: f.candidate.digest }), { httpStatus: 409 });
  assert.equal((await f.service.cancel(f.input, begin.flowId)).status, 'none');
  assert.equal(f.data.row.cancelled_by, f.input.actorId);
  assert(!f.data.calls.includes('confirm'));
  f.unchanged();

  const retry = await f.service.begin(f.input);
  const retryState = new URL(retry.authUrl).searchParams.get('state');
  await f.service.callback({ state: retryState, denied: true });
  assert.equal((await f.service.overview(f.input)).status, 'none');
  f.unchanged();
});

test('a response cannot supply another OAuth recipient, a linked picture from another domain, or an unrecorded confirmation', async () => {
  const f = fixture();
  const begin = await f.service.begin(f.input);
  const state = new URL(begin.authUrl).searchParams.get('state');
  assert.throws(() => f.authUrl(begin.authUrl.replace('www.facebook.com', 'facebook.example'), f.flow, state));
  assert.throws(() => f.authUrl(begin.authUrl + '&next=https://fake.invalid', f.flow, state));
  assert.throws(() => f.receipt({ flowId: begin.flowId, status: 'staged',
    candidate: { ...f.candidate, profile: { ...f.candidate.profile, avatarUrl: 'https://fbcdn.net.invalid/avatar.png' } } },
  { flow_id: begin.flowId }, f.now()));
  await f.service.callback({ state, code: 'FICTITIOUS_CODE' });
  f.data.status = 'active';
  await assert.rejects(f.service.overview(f.input), { httpStatus: 409 });
  assert.equal(f.data.row.status, 'processing');
});

test('availability requires an enabled direct clinic with its approved Facebook parent and a USER grant', () => {
  const env = { META_MARKETING_INSTAGRAM_EXTENSION_SCOPE: 'clinic:77', META_MARKETING_INSTAGRAM_EXTENSION_PAGE: '401' };
  const row = { state: 'active', scope_key: 'clinic:77', clinicIds: [77],
    selected: [{ kind: 'facebook_page', id: '401' }] };
  const settings = () => configuration(env);
  assert.equal(availableFor(row, null, settings), false);
  env.META_MARKETING_INSTAGRAM_EXTENSION_ENABLED = 'true';
  assert.equal(availableFor(row, null, settings), true);
  assert.equal(availableFor({ ...row, scope_key: 'group:9' }, null, settings), false);
  assert.equal(availableFor(row, {}, settings), false);
  assert.equal(availableFor({ ...row, selected: [...row.selected, { kind: 'instagram_business', parentPageId: '401' }] }, null, settings), false);
  env.META_MARKETING_INSTAGRAM_EXTENSION_PAGE = '402';
  assert.equal(availableFor(row, null, settings), false);
});

async function authorizedInstagram(f, confirm = true) {
  const attempt = await f.service.begin(f.input);
  const state = new URL(attempt.authUrl).searchParams.get('state');
  await f.service.callback({ state, code: 'FICTITIOUS_CODE' });
  if (confirm) await f.service.confirm(f.input, attempt.flowId, { instagramId: '501', candidateDigest: f.candidate.digest });
}

test('explicit rate limiting projects only the locally confirmed Instagram and the current enrollment proof', async () => {
  const f = fixture();
  await authorizedInstagram(f);
  f.data.statusError = 'rate_limited';
  const before = structuredClone(f.data.row);
  const otherManager = { ...f.input, actorId: 5, sessionRef: randomUUID() };
  await assert.rejects(f.service.overview(otherManager), error => {
    assert.equal(error.code, 'meta_instagram_rate_limited');
    assert.equal(error.httpStatus, 429);
    assert.deepEqual(error.savedAssignment, {
      scopeKey: 'clinic:77', enrollmentId: before.enrollment_id, epoch: 0, versionId: f.flow.flow_id,
      assetRef: 'meta-instagram_business:501', id: '501', kind: 'instagram_business',
    });
    return true;
  });
  assert.deepEqual(f.data.row, before);
  assert.equal(f.data.calls.filter(call => call === 'status').length, 1);
  f.unchanged();
});

test('drafts, invalid durable confirmation and changed session, credential or claim cannot supply saved inventory', async () => {
  const f = fixture();
  await authorizedInstagram(f, false);
  f.data.statusError = 'rate_limited';
  await assert.rejects(f.service.overview(f.input), error => error.httpStatus === 429 && !error.savedAssignment);
  const mutations = [
    [f => { f.data.row.confirmed_at = null; }, 429],
    [f => { f.data.row.status = 'cancel_pending'; }, 429],
    [f => { f.data.row.selected_instagram_id = '999'; }, 429],
    [f => { f.renewCredential(); }, 429],
    [f => { f.data.live = false; }, 401],
    [f => { f.data.legacyMapping = { id: 17 }; }, 409],
  ];
  for (const [change, status] of mutations) {
    const active = fixture();
    await authorizedInstagram(active);
    active.data.statusError = 'rate_limited';
    active.data.onStatusError = () => change(active);
    await assert.rejects(active.service.overview(active.input), error => error.httpStatus === status && !error.savedAssignment);
    assert.equal(active.data.calls.filter(call => call === 'status').length, 1);
    active.unchanged();
  }
});

test('generic provider failures and definite loss never turn the stored extension into a display fallback', async () => {
  const f = fixture();
  await authorizedInstagram(f);
  f.data.statusError = 'provider_unavailable';
  await assert.rejects(f.service.overview(f.input), error => error.httpStatus === 503 && !error.savedAssignment);
  f.data.statusError = 'credential_revoked';
  const revoked = await f.service.overview(f.input);
  assert.equal(revoked.status, 'requires_cleanup');
  assert.equal(revoked.candidate, null);
});

test('the HTTP router preserves 429 and projects the saved reference only on overview', async () => {
  const { createRouter } = require('../../routes/metaMarketingInstagramExtension.routes');
  const f = fixture();
  await authorizedInstagram(f);
  f.data.statusError = 'rate_limited';
  const withheld = Object.assign(Error('fixture denied write'), { code: 'meta_instagram_rate_limited', httpStatus: 429, savedAssignment: { private: true } });
  const router = createRouter({ service: { ...f.service, begin: async () => { throw withheld; } }, sessions: { verify: async () => ({
    userId: f.input.actorId, jti: f.input.sessionRef, sessionVersion: 1, exp: +f.input.sessionExpiresAt / 1000,
  }) } });
  const read = async method => {
    let value, status = 200;
    const res = { headers: {}, set(key, value) { this.headers[key] = value; }, status(code) { status = code; return this; }, json(body) { value = body; } };
    await router.stack.find(layer => layer.route?.path === '/instagram-extension' && layer.route.methods[method]).route.stack[0].handle({
      headers: { authorization: 'Bearer FICTITIOUS_SESSION' }, query: { clinic_id: '77' }, params: {},
    }, res);
    assert.equal(status, 429);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    return value;
  };
  const get = await read('get');
  assert.deepEqual(Object.keys(get).sort(), ['error', 'savedAssignment', 'success']);
  assert.deepEqual(Object.keys(get.savedAssignment).sort(), ['assetRef', 'enrollmentId', 'epoch', 'id', 'kind', 'scopeKey', 'versionId']);
  assert.deepEqual(await read('post'), { success: false, error: 'meta_instagram_rate_limited' });
});

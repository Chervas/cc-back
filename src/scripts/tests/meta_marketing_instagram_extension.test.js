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

function fixture() {
  const clock = +new Date('2030-01-01T12:00:00Z');
  const now = () => new Date(clock);
  const digest = 'a'.repeat(64);
  const input = { scopeKey: 'clinic:77', actorId: 2, sessionRef: randomUUID(), sessionExpiresAt: new Date(clock + 3600000) };
  const scopes = ['ads_read','pages_read_engagement','public_profile'];
  const flow = { flow_id: randomUUID(), app_id: '101', scopes: JSON.stringify(scopes),
    redirect_uri: 'https://auth.example.invalid/oauth/meta/marketing/callback', expires_at: new Date(clock + 86400000) };
  const selected = C.assets([{ assetRef: 'meta-ad_account:301', kind: 'ad_account', id: '301', parentPageId: null },
    { assetRef: 'meta-facebook_page:401', kind: 'facebook_page', id: '401', parentPageId: null }]);
  const enrollment = { enrollment_id: randomUUID(), flow_id: flow.flow_id, session_ref: randomUUID(), prepare_request_id: randomUUID(),
    activate_request_id: randomUUID(), revoke_request_id: randomUUID(), scope_digest: digest, flow_digest: digest, candidate_digest: digest,
    assignment_digest: digest, scope_key: input.scopeKey, actor_user_id: input.actorId, meta_connection_id: 99,
    connection_ref: 'fictitious-connection', meta_user_id: '201', app_id: flow.app_id, clinic_ids: '[77]', assets: JSON.stringify(selected),
    mapping_ids: '[31,32]', session_expires_at: input.sessionExpiresAt, requested_at: now(), updated_at: now(), next_attempt_at: now(),
    prepared_at: now(), activated_at: now(), revoked_at: null, attempts: 0, selection_digest: digest, last_error: null,
    lease_token: null, lease_until: null, state: 'active' };
  const effective = { epoch: 0, versionId: flow.flow_id, digest, metadata: { tokenType: 'USER' } };
  const data = { row: null, status: null, calls: [], live: true, legacyMapping: null, loseConfirmResponse: false, providerRejected: false };
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
    './metaMarketingEffectiveCredential.service': { ...F, createEffectiveCredentials: () => ({ async resolve() { return effective; } }) },
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
  return { service, data, input, candidate, effective, authUrl: loaded.exports.authUrl, receipt: loaded.exports.receipt, flow, now,
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
  f.effective.epoch = 1;
  assert.equal((await f.service.overview(f.input)).status, 'active');
  f.unchanged();
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

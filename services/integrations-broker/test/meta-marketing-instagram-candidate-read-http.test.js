'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createMetaMarketingInstagramCandidateReadHttp } = require('../src/meta-marketing-instagram-candidate-read-http');
const { assetSetDigest } = require('../src/meta-marketing-credential-renewal-contract');

const NOW = Date.UTC(2030, 0, 1);
const EXPIRES = NOW + 600_000;
const ENROLLMENT = '14c5f266-5f17-4513-89cf-2a2d22f52f44';
const CANDIDATE_TOKEN = 'FICTITIOUS_CANDIDATE_META_TOKEN';
const APP_SECRET = 'f'.repeat(32);
const AVATAR = 'https://media.cdninstagram.com/account/photo.jpg?oh=fictitious';
const oldScopes = ['ads_read', 'pages_read_engagement', 'pages_show_list', 'public_profile'];
const candidateScopes = [...oldScopes, 'instagram_basic'].sort();
const selected = [
  { assetRef: 'meta-ad_account:301', kind: 'ad_account', id: '301', parentPageId: null },
  { assetRef: 'meta-facebook_page:401', kind: 'facebook_page', id: '401', parentPageId: null },
];

function setup(transform = (_, response) => response) {
  const calls = [];
  const base = {
    provider: 'meta_marketing_onboarding',
    connectionRef: 'clinic:71:fixture', secretArn: 'fixture-current', clientSecretArn: 'fixture-application',
    expiresAt: EXPIRES,
    metaMarketingOAuth: {
      appId: '101', appVersionId: 'a'.repeat(32), slotVersionId: 'b'.repeat(32),
      redirectUri: 'https://fixture.invalid/oauth/meta/marketing/callback', scopeKey: 'clinic:71',
      clinicIds: [71], scopes: oldScopes,
    },
  };
  const authority = {
    row: { state: 'active', id: ENROLLMENT, tenant: 'clinic:71', scope: 'meta-enroll:clinic:71', connection: base.connectionRef },
    binding: base,
    assets: structuredClone(selected),
    credential: {
      epoch: 0, versionId: '420baa35-0370-4ab7-ac46-42569f6f1a6c', digest: 'e'.repeat(64),
      metadata: { appId: '101', subjectId: '201', tokenType: 'USER', scopes: oldScopes,
        expiresAt: EXPIRES, dataAccessExpiresAt: EXPIRES, granularScopes: [] },
    },
  };
  const binding = { ...base, secretArn: 'fixture-candidate',
    metaMarketingOAuth: { ...base.metaMarketingOAuth, slotVersionId: 'c'.repeat(32), scopes: candidateScopes } };
  const input = {
    binding,
    metadata: { ...authority.credential.metadata, scopes: candidateScopes,
      granularScopes: [{ scope: 'instagram_basic', targetIds: ['401'] }] },
    token: Buffer.from(CANDIDATE_TOKEN), appSecret: Buffer.from(APP_SECRET),
    enrollmentId: ENROLLMENT, clinicId: 71, parentPageId: '401', expectedAssetSetDigest: assetSetDigest(selected),
    signal: new AbortController().signal, authorize: () => authority,
  };
  const pacing = {
    keys: [],
    async run(key, _options, read) { this.keys.push(key); return read(); },
    observe() {},
  };
  const request = (options, callback) => {
    assert.equal(options.hostname, 'graph.facebook.com');
    assert.equal(options.method, 'GET');
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      const url = new URL(options.path, 'https://graph.facebook.com');
      const id = url.pathname.split('/').at(-1);
      const fields = url.searchParams.get('fields');
      const edge = id === 'debug_token' ? 'inspect' : fields === 'id,instagram_business_account' ? 'parent' : 'profile';
      calls.push({ id, edge, fields, proof: url.searchParams.get('appsecret_proof') ?? undefined });
      queueMicrotask(() => {
        const values = {
          inspect: { data: { app_id: '101', user_id: '201', type: 'USER', is_valid: true,
            scopes: [...candidateScopes], granular_scopes: [{ scope: 'instagram_basic', target_ids: ['401'] }],
            expires_at: EXPIRES / 1000, data_access_expires_at: EXPIRES / 1000 } },
          parent: { id: '401', instagram_business_account: { id: '501' } },
          profile: { id: '501', name: 'Fixture Clinic', username: 'fixture_clinic', profile_picture_url: AVATAR },
        };
        const result = transform(edge, { status: 200, body: values[edge] }, calls, authority);
        const res = new PassThrough();
        res.statusCode = result.status;
        res.headers = { 'content-type': 'application/json' };
        callback(res);
        res.end(JSON.stringify(result.body));
      });
    };
    return req;
  };
  const read = createMetaMarketingInstagramCandidateReadHttp({ request, now: () => NOW, pacer: pacing });
  return { read, input, authority, calls, pacing };
}

test('reads only the pinned page and linked professional Instagram through the shared pacer', async () => {
  const { read, input, authority, calls, pacing } = setup();
  const before = structuredClone(authority);
  const result = await read(input);
  const asset = { assetRef: 'meta-instagram_business:501', kind: 'instagram_business', id: '501', parentPageId: '401' };
  assert.deepEqual(result.asset, asset);
  assert.deepEqual(result.selected, [...selected, asset]);
  assert.equal(result.assetSetDigest, assetSetDigest(result.selected));
  assert.deepEqual(result.profile, { assetRef: asset.assetRef, kind: asset.kind, id: asset.id,
    name: 'Fixture Clinic', username: 'fixture_clinic', avatarUrl: AVATAR });
  assert.deepEqual(authority, before);
  assert.deepEqual(calls.map(({ edge, id }) => [edge, id]), [
    ['inspect', 'debug_token'], ['parent', '401'], ['profile', '501'], ['inspect', 'debug_token'],
  ]);
  assert.deepEqual(pacing.keys, Array(4).fill('meta-ads-app:101'));
  assert.equal(calls[2].fields, 'id,name,username,profile_picture_url');
  assert.match(calls[2].proof, /^[a-f0-9]{64}$/);
  const output = JSON.stringify(result);
  for (const secret of [CANDIDATE_TOKEN, APP_SECRET, calls[2].proof]) assert(!output.includes(secret));
});

test('a group read binds the owner tenant, group, full membership and selected parent page', async () => {
  function groupFixture() {
    const f = setup();
    for (const binding of [f.authority.binding, f.input.binding]) {
      Object.assign(binding.metaMarketingOAuth, { scopeKey: 'group:29', clinicIds: [71, 72] });
    }
    f.authority.row.scope = 'meta-enroll:group:29';
    f.input.scopeKey = 'group:29';
    return f;
  }
  const valid = groupFixture();
  assert.equal((await valid.read(valid.input)).profile.username, 'fixture_clinic');
  for (const change of [
    f => { f.input.scopeKey = 'group:30'; },
    f => { f.input.binding.metaMarketingOAuth.clinicIds = [71, 73]; },
    f => { f.input.clinicId = 72; },
    f => { f.input.parentPageId = '999'; },
  ]) {
    const f = groupFixture();
    change(f);
    await assert.rejects(f.read(f.input), { code: 'scope_denied' });
    assert.deepEqual(f.calls, []);
  }
});

test('rejects a foreign clinic or parent, a changed selection, and reuse of the active slot before a provider read', async () => {
  for (const change of [
    input => { input.clinicId = 72; }, input => { input.parentPageId = '402'; },
    input => { input.expectedAssetSetDigest = 'a'.repeat(64); },
    (input, authority) => { input.binding = { ...input.binding, secretArn: authority.binding.secretArn }; },
    (input, authority) => { authority.row.id = '420baa35-0370-4ab7-ac46-42569f6f1a6c'; },
    (input, authority) => { authority.credential.metadata.subjectId = '299'; },
    input => {
      const scopes = candidateScopes.filter(scope => scope !== 'ads_read');
      input.binding = { ...input.binding, metaMarketingOAuth: { ...input.binding.metaMarketingOAuth, scopes } };
      input.metadata = { ...input.metadata, scopes };
    },
  ]) {
    const { read, input, authority, calls } = setup();
    change(input, authority);
    await assert.rejects(read(input), { code: 'scope_denied' });
    assert.equal(calls.length, 0);
  }
});

test('fails closed if Instagram consent or its granular page target is absent', async () => {
  const { read, input, calls } = setup((edge, response) => {
    if (edge === 'inspect') response.body.data.scopes = oldScopes;
    return response;
  });
  await assert.rejects(read(input), { code: 'oauth_credentials_incomplete' });
  assert.deepEqual(calls.map(call => call.edge), ['inspect']);

  const denied = setup();
  denied.input.metadata.granularScopes = [{ scope: 'instagram_basic', targetIds: ['402'] }];
  await assert.rejects(denied.read(denied.input), { code: 'scope_denied' });
  assert.equal(denied.calls.length, 0);
});

test('provider denial and a different parent produce no candidate or foreign profile read', async () => {
  const denied = setup((edge, response) => edge === 'parent'
    ? { status: 403, body: { error: { code: 10, message: 'FICTITIOUS_ACCESS_DENIAL' } } } : response);
  await assert.rejects(denied.read(denied.input), error => error.code === 'provider_unauthorized'
    && !String(error).includes('FICTITIOUS_ACCESS_DENIAL'));
  assert.deepEqual(denied.calls.map(call => call.edge), ['inspect', 'parent']);

  const foreign = setup((edge, response) => {
    if (edge === 'parent') response.body.id = '402';
    return response;
  });
  await assert.rejects(foreign.read(foreign.input), { code: 'scope_denied' });
  assert.deepEqual(foreign.calls.map(call => call.edge), ['inspect', 'parent']);
});

test('rechecks the clinic authority and provider grant before releasing the candidate', async () => {
  const changed = setup((edge, response, _calls, authority) => {
    if (edge === 'parent') authority.credential.epoch++;
    return response;
  });
  await assert.rejects(changed.read(changed.input), { code: 'scope_denied' });
  assert.deepEqual(changed.calls.map(call => call.edge), ['inspect', 'parent']);

  const revoked = setup((edge, response, calls) => {
    if (edge === 'inspect' && calls.length === 4) response.body.data.is_valid = false;
    return response;
  });
  await assert.rejects(revoked.read(revoked.input), { code: 'credential_revoked' });
});

test('uses icon fallback for absent or untrusted photos and rejects credentials echoed into visible data', async () => {
  for (const image of [undefined, 'https://foreign.invalid/photo.jpg', AVATAR + '&access_token=fictitious']) {
    const fixture = setup((edge, response) => {
      if (edge === 'profile') response.body.profile_picture_url = image;
      return response;
    });
    assert(!Object.hasOwn((await fixture.read(fixture.input)).profile, 'avatarUrl'));
  }
  const echo = setup((edge, response) => {
    if (edge === 'profile') response.body.name = CANDIDATE_TOKEN;
    return response;
  });
  await assert.rejects(echo.read(echo.input), { code: 'provider_failed' });

  const encoded = '%' + CANDIDATE_TOKEN.charCodeAt(0).toString(16) + CANDIDATE_TOKEN.slice(1);
  const nested = encoded.replace('%', '%25252525');
  const encodedEcho = setup((edge, response) => {
    if (edge === 'profile') {
      response.body.name = 'Fixture 100%';
      response.body.profile_picture_url += '&oh=' + nested;
    }
    return response;
  });
  await assert.rejects(encodedEcho.read(encodedEcho.input), { code: 'provider_failed' });
});

test('omits the proposal if the exact page has no linked professional account', async () => {
  const { read, input, calls } = setup((edge, response) => {
    if (edge === 'parent') delete response.body.instagram_business_account;
    return response;
  });
  assert.equal(await read(input), null);
  assert.deepEqual(calls.map(call => call.edge), ['inspect', 'parent', 'inspect']);
});

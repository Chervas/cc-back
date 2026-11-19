'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, generateKeyPairSync } = require('node:crypto');
const { fixture: apiFixture } = require('./fixtures/business_profile_first_profile.fixture');
const { fixture: ownerFixture } = require('../../../services/integrations-broker/test/helpers');
const { Broker } = require('../../../services/integrations-broker/src/broker');
const { signRequest } = require('../../../services/integrations-broker/src/auth');
const { cursorCodec } = require('../../../services/integrations-broker/src/provider-cursor');
const { createBusinessProfileEnrollment } = require('../../../services/integrations-broker/src/google-business-profile-enrollment');
const E = require('../../../services/integrations-broker/src/google-business-profile-enrollment-contract');
const R = require('../../../services/integrations-broker/src/google-business-profile-contract');

function fixture(t, { ownerClinic = 123, subject = '113861427645841982815' } = {}) {
  const f = ownerFixture(t), state = { secretReads: 0, providerCalls: [] };
  const roles = {};
  for (const id of ['read', 'control']) {
    const keys = generateKeyPairSync('ed25519'); roles[id] = id + ':test';
    f.policy.principals.push({ id: roles[id], keyId: id + '-key', enabled: true,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), maxPerMinute: 100 });
  }
  const binding = { connectionRef: 'connection:test', provider: R.PROVIDER, initialState: 'active',
    oauth: { subject: '113861427645841982815', redirectUri: 'https://example.invalid/oauth/google/callback',
      scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/business.manage'] },
    googleBusinessProfileEnrollmentScopes: [{ assetRef: 'gbp-enroll:clinic:' + ownerClinic, tenantRef: 'clinic:' + ownerClinic,
      accountIds: ['100'], locationIds: ['300'], bootstrapPreviousAssetRef: null,
      readPrincipalId: roles.read, controlPrincipalId: roles.control, readOperations: [...R.OPERATIONS], maxAssets: 1 }] };
  f.policy.connections = [binding];
  f.policy.grants = [{ principalId: 'api:test', tenantRef: 'clinic:' + ownerClinic, connectionRef: binding.connectionRef,
    assetRef: 'gbp-enroll:clinic:' + ownerClinic, operations: [E.OPERATIONS.discover] }];
  const http = async request => {
    state.providerCalls.push({ hostname: request.hostname, path: request.path });
    assert.equal(request.token.toString(), 'FICTITIOUS_FIRST_PROFILE_TOKEN');
    if (request.hostname === 'www.googleapis.com') return { id: subject };
    if (request.hostname === 'mybusinessaccountmanagement.googleapis.com') return { name: 'accounts/100', accountName: 'FICTITIOUS_ACCOUNT' };
    assert.equal(request.hostname, 'mybusinessbusinessinformation.googleapis.com');
    assert(request.path.startsWith('/v1/accounts/100/locations?'));
    return { locations: ['300', '400'].map(id => ({ name: 'locations/' + id, title: 'FICTITIOUS_' + id })) };
  };
  const engine = createBusinessProfileEnrollment({ store: f.store, http, cursor: cursorCodec(randomBytes(32)) });
  const broker = new Broker({ store: f.store, policy: f.policy, operations: engine.operations, gbpEnrollment: engine,
    secrets: { async withSecret(_binding, work) {
      state.secretReads++; const value = Buffer.from('FICTITIOUS_FIRST_PROFILE_TOKEN');
      try { return await work(value); } finally { value.fill(0); }
    } } });
  const transport = { execute(command) {
    const signed = signRequest(command, { keyId: 'qa-key', privateKey: f.keys.privateKey, audience: f.policy.audience });
    return broker.execute(signed.raw, signed.headers);
  } };
  return { ...f, state, transport };
}

test('first-profile API and real Owner return only exact preauthorized location, without creating an enrollment or local grant', async t => {
  const owner = fixture(t), api = apiFixture({ transport: owner.transport }), before = structuredClone(api.state);
  const result = await api.service.candidates(api.input);
  assert.deepEqual(result.accounts[0].locations.map(row => row.locationId), ['locations/300']);
  assert(!JSON.stringify(result).includes('FICTITIOUS_FIRST_PROFILE_TOKEN'));
  assert.equal(result.canPrepare, false); assert.deepEqual(api.state, before);
  assert.equal(owner.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_enrollments').get().n, 0);
  assert.equal(owner.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_scope_heads').get().n, 0);
  assert.equal(owner.state.secretReads, 1); assert.equal(owner.state.providerCalls.length, 3);
});
test('another Owner clinic cannot authorize the API tenant and denies before reading its secret', async t => {
  const owner = fixture(t, { ownerClinic: 124 }), api = apiFixture({ transport: owner.transport });
  await assert.rejects(api.service.candidates(api.input), { code: 'scope_denied' });
  assert.equal(owner.state.secretReads, 0); assert.equal(owner.state.providerCalls.length, 0);
  assert.equal(api.state.BusinessProfileAssociationScope.length, 0);
});
test('real Owner rejects mismatched Google subject and omits a previously retired location', async t => {
  const wrong = fixture(t, { subject: 'other-subject' }), wrongApi = apiFixture({ transport: wrong.transport });
  await assert.rejects(wrongApi.service.candidates(wrongApi.input), { code: 'oauth_identity_mismatch' });
  assert.equal(wrong.state.providerCalls.length, 1);
  const owner = fixture(t), api = apiFixture({ transport: owner.transport });
  owner.store.db.prepare('INSERT INTO google_business_profile_retirements(tenant,connection,asset,location,enrollment_id,retired_at) VALUES (?,?,?,?,?,?)')
    .run('clinic:999', 'connection:other', 'gbp:777:300', '300', 'fictitious-retirement', Date.now());
  assert.deepEqual((await api.service.candidates(api.input)).accounts, []);
  assert.equal(owner.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_retirements').get().n, 1);
  assert.equal(api.state.BusinessProfileAssociationScope.length, 0);
});

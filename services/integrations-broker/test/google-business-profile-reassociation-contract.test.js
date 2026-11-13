'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { canonical } = require('../src/canonical');
const { validatePolicy: validatePolicyShape } = require('../src/policy');
const C = require('../src/google-business-profile-enrollment-contract');
const R = require('../src/google-business-profile-contract');
const V = require('./fixtures/google-business-profile-reassociation');
const invalid = { code: 'invalid_request' };

function policyFixture() {
  const { proof, request } = V.fixture();
  const principals = ['read', 'control', 'enroll'].map(role => ({
    id: role + ':fixture-gbp', keyId: role + '-fixture-gbp', enabled: true, maxPerMinute: 20,
    publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }),
  }));
  const scope = {
    assetRef: request.assetRef, tenantRef: request.tenantRef,
    accountIds: [request.payload.accountId], locationIds: [request.payload.locationId],
    bootstrapPreviousAssetRef: null, readPrincipalId: principals[0].id, controlPrincipalId: principals[1].id,
    readOperations: [...R.OPERATIONS], maxAssets: 2, reassociationSources: [proof],
  };
  const binding = {
    connectionRef: request.connectionRef, provider: R.PROVIDER, initialState: 'active',
    secretArn: 'arn:aws:secretsmanager:eu-west-3:000000000000:secret:fictitious-gbp-refresh-abcdef',
    clientSecretArn: 'arn:aws:secretsmanager:eu-west-3:000000000000:secret:fictitious-gbp-client-abcdef',
    oauth: { subject: '990000000000000000003', redirectUri: 'https://example.invalid/oauth/google/callback',
      scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/business.manage'] },
    googleBusinessProfileEnrollmentScopes: [scope],
  };
  const grants = [
    { principalId: principals[2].id, tenantRef: scope.tenantRef, connectionRef: binding.connectionRef,
      assetRef: scope.assetRef, operations: [C.OPERATIONS.discover, C.OPERATIONS.prepare, C.OPERATIONS.activate, C.OPERATIONS.status] },
    { principalId: principals[1].id, tenantRef: scope.tenantRef, connectionRef: binding.connectionRef,
      assetRef: scope.assetRef, operations: [C.OPERATIONS.retire, C.OPERATIONS.abort] },
  ];
  const policy = { audience: 'broker:fixture-gbp', version: 'fictitious-gbp-v1', maxBacklog: 20,
    principals, connections: [binding], grants };
  return { policy, binding, scope, proof };
}
const validatePolicy = policy => { validatePolicyShape(policy); C.validatePolicy(policy); };

test('fictitious source retirement and new clinic intent share pinned canonical vectors', () => {
  const { retirement, proof, request } = V.fixture();
  assert.equal(retirement.retired_at, 1700000000123);
  assert.notEqual(proof.sourceTenantRef, request.tenantRef);
  assert.equal(proof.sourceConnectionRef, request.connectionRef);
  assert.equal(request.payload.previousAssetRef, null);
  assert.equal(canonical(retirement), V.RETIREMENT_CANONICAL_JSON);
  assert.equal(canonical(proof), V.PROOF_CANONICAL_JSON);
  assert.equal(C.retirementDigest(retirement), V.RETIREMENT_DIGEST);
  assert.equal(createHash('sha256').update(V.REASSOCIATION_CANONICAL_JSON).digest('hex'), V.REASSOCIATION_DIGEST);
  assert.equal(C.reassociationDigest(proof, request), V.REASSOCIATION_DIGEST);
  const reordered = Object.fromEntries(Object.entries(proof).reverse());
  assert.equal(C.reassociationDigest(reordered, request), V.REASSOCIATION_DIGEST);
  assert.equal(C.retirementDigest(Object.fromEntries(Object.entries(retirement).reverse())), V.RETIREMENT_DIGEST);
  retirement.retired_at++;
  assert.equal(V.fixture().retirement.retired_at, V.EPOCH_MS, 'imports return independent mutable fixtures');
});

test('retirement and reassociation digests bind each source and target identity field', () => {
  const sourceChanges = {
    tenant: 'clinic:91002', connection: 'connection:fixture-gbp-other',
    asset: 'gbp:990000000000000000001:990000000000000000004', location: '990000000000000000004',
    enrollment_id: '10000000-0000-4000-8000-000000000005', retired_at: V.EPOCH_MS + 1,
  };
  for (const [field, value] of Object.entries(sourceChanges)) {
    const { retirement } = V.fixture(); retirement[field] = value;
    assert.notEqual(C.retirementDigest(retirement), V.RETIREMENT_DIGEST, field);
  }
  const proofChanges = {
    descriptorId: '20000000-0000-4000-8000-000000000005', sourceTenantRef: 'clinic:91002',
    sourceConnectionRef: 'connection:fixture-gbp-other', sourceScopeRef: 'gbp-enroll:clinic:91002',
    sourceAssetRef: 'gbp:990000000000000000001:990000000000000000004',
    retirementEnrollmentId: '10000000-0000-4000-8000-000000000005', retirementDigest: 'a'.repeat(64),
  };
  for (const [field, value] of Object.entries(proofChanges)) {
    const { proof, request } = V.fixture(); proof[field] = value;
    assert.notEqual(C.reassociationDigest(proof, request), V.REASSOCIATION_DIGEST, field);
  }
  const targetChanges = {
    tenantRef: 'clinic:91071', connectionRef: 'connection:fixture-gbp-other', assetRef: 'gbp-enroll:clinic:91071',
  };
  const payloadChanges = {
    enrollmentId: '30000000-0000-4000-8000-000000000005', accountId: '990000000000000000005',
    locationId: '990000000000000000004', previousAssetRef: 'gbp:990000000000000000001:990000000000000000004',
    clinicCount: 2, clinicSetDigest: 'b'.repeat(64),
  };
  for (const [field, value] of Object.entries(targetChanges)) {
    const { proof, request } = V.fixture(); request[field] = value;
    assert.notEqual(C.reassociationDigest(proof, request), V.REASSOCIATION_DIGEST, field);
  }
  for (const [field, value] of Object.entries(payloadChanges)) {
    const { proof, request } = V.fixture(); request.payload[field] = value;
    assert.notEqual(C.reassociationDigest(proof, request), V.REASSOCIATION_DIGEST, field);
  }
});

test('command validators preserve legacy payloads and accept only the exact seven-field proof', () => {
  for (const command of ['prepare', 'activate', 'retire', 'abort']) {
    const original = V.fixture().request.payload;
    assert.equal(C.validators[command](original), original);
    const legacy = structuredClone(original); delete legacy.reassociation;
    assert.equal(C.validators[command](legacy), legacy);
    for (const field of Object.keys(original.reassociation)) {
      for (const replacement of [null, undefined]) {
        const payload = structuredClone(original);
        if (replacement === undefined) delete payload.reassociation[field]; else payload.reassociation[field] = replacement;
        assert.throws(() => C.validators[command](payload), invalid, command + ':' + field);
      }
    }
    for (const mutate of [
      p => { p.reassociation = null; }, p => { p.reassociation = []; },
      p => { p.reassociation.extra = 'unknown'; }, p => { p.extra = true; },
      p => { p.reassociation.descriptorId = '20000000-0000-3000-8000-000000000002'; },
      p => { p.reassociation.sourceTenantRef = 'group:91001'; },
      p => { p.reassociation.sourceScopeRef = 'gbp-enroll:group:91001'; },
      p => { p.reassociation.sourceAssetRef = 'gbp:invalid'; },
      p => { p.reassociation.retirementDigest = 'A'.repeat(64); },
    ]) {
      const payload = structuredClone(original); mutate(payload);
      assert.throws(() => C.validators[command](payload), invalid, command);
    }
  }
  assert.throws(() => C.validators.discover({ pageToken: null, reassociation: V.fixture().proof }), invalid);
  assert.throws(() => C.validators.status({ enrollmentId: V.fixture().request.payload.enrollmentId, reassociation: V.fixture().proof }), invalid);
});

test('full policy validation keeps reassociation optional and rejects malformed capabilities', () => {
  const valid = policyFixture(); validatePolicy(valid.policy);
  delete valid.scope.reassociationSources; validatePolicy(valid.policy);
  for (const value of [null, [], [null], [{ ...V.fixture().proof, unknown: true }],
    Array.from({ length: 21 }, () => V.fixture().proof)]) {
    const f = policyFixture(); f.scope.reassociationSources = value;
    assert.throws(() => validatePolicy(f.policy), invalid);
  }
});

test('policy capability cannot name another connection, source clinic, destination class or unallowlisted physical identity', () => {
  for (const mutate of [
    f => { f.proof.sourceConnectionRef = 'connection:fixture-gbp-other'; },
    f => { f.proof.sourceTenantRef = f.scope.tenantRef; f.proof.sourceScopeRef = f.scope.assetRef; },
    f => { f.proof.sourceScopeRef = 'gbp-enroll:clinic:91002'; },
    f => { f.scope.bootstrapPreviousAssetRef = f.proof.sourceAssetRef; },
    f => { f.scope.accountIds = ['990000000000000000004']; },
    f => { f.scope.locationIds = ['990000000000000000004']; },
    f => {
      const previous = f.scope.assetRef; f.scope.assetRef = 'gbp-enroll:group:91070';
      for (const grant of f.policy.grants) if (grant.assetRef === previous) grant.assetRef = f.scope.assetRef;
    },
    f => { f.scope.reassociationSources.push(structuredClone(f.proof)); },
    f => {
      const next = structuredClone(f.scope); next.tenantRef = 'clinic:91071'; next.assetRef = 'gbp-enroll:clinic:91071';
      f.binding.googleBusinessProfileEnrollmentScopes.push(next);
      f.policy.grants.push(...f.policy.grants.map(g => ({ ...g, tenantRef: next.tenantRef, assetRef: next.assetRef })));
    },
  ]) {
    const f = policyFixture(); mutate(f);
    assert.throws(() => validatePolicy(f.policy), invalid);
  }
});

test('optional reassociation policy never changes the legacy scope digest', () => {
  const f = policyFixture(); delete f.scope.reassociationSources;
  const before = structuredClone(f.scope);
  const golden = '409d43606c40628cb049aa529d0165462c790e439d0834f3a71e15441dc5f0b0';
  assert.equal(C.digestFor(f.binding, f.scope), golden);
  assert.deepEqual(f.scope, before);
  f.scope.reassociationSources = [V.fixture().proof]; validatePolicy(f.policy);
  assert.equal(C.digestFor(f.binding, f.scope), golden);
  f.scope.reassociationSources[0].descriptorId = '20000000-0000-4000-8000-000000000005';
  f.scope.readOperations.reverse();
  assert.equal(C.digestFor(f.binding, f.scope), golden);
});

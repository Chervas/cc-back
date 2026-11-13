'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, generateKeyPairSync } = require('node:crypto');
const { fixture } = require('./helpers');
const { Broker } = require('../src/broker');
const { BrokerStore } = require('../src/store');
const { signRequest } = require('../src/auth');
const { cursorCodec } = require('../src/provider-cursor');
const { createGoogleBusinessProfileOperations } = require('../src/google-business-profile');
const { createBusinessProfileEnrollment } = require('../src/google-business-profile-enrollment');
const { DDL, TABLES, processIdentity } = require('../src/google-business-profile-reassociation');
const C = require('../src/google-business-profile-enrollment-contract');
const R = require('../src/google-business-profile-contract');
const W = require('../src/google-business-profile-write-contract');
const O = require('../src/google-oauth-contract');
const { validateConfig } = require('../src/google-main');
const V = require('./fixtures/google-business-profile-reassociation');

const ACCOUNT = '990000000000000000001';
const OLD = '990000000000000000002';
const SUCCESSOR = '990000000000000000004';
const AJURI = '990000000000000000016';
const SOURCE_TENANT = 'clinic:91001';
const SOURCE_SCOPE = 'gbp-enroll:clinic:91001';
const TARGET_TENANT = 'clinic:91070';
const TARGET_SCOPE = 'gbp-enroll:clinic:91070';
const AJURI_TENANT = 'clinic:91016';
const ACCESS = 'FICTITIOUS_GBP_REASSOCIATION_TOKEN';
const asset = location => `gbp:${ACCOUNT}:${location}`;
const location = id => ({ name: 'locations/' + id, title: 'FICTITIOUS_LOCATION_' + id,
  storefrontAddress: { addressLines: ['FICTITIOUS_ADDRESS'], locality: 'FICTITIOUS_CITY' } });

// Creates source retirement with the ordinary signed prepare/activate/retire
// flow. All provider responses are fake; only the temporary SQLite is real.
async function reassociationFixture(t, { installSchema = true } = {}) {
  const f = fixture(t); const at = V.EPOCH_MS; const vector = V.fixture();
  if (installSchema) for (const ddl of DDL) f.store.db.exec(ddl);
  const roles = { read: { id: 'api:test', keyId: 'qa-key', keys: f.keys } };
  for (const name of ['control', 'oauth', 'enroll', 'write']) {
    const keys = generateKeyPairSync('ed25519'); roles[name] = { id: name + ':test', keyId: name + '-key', keys };
    f.policy.principals.push({ id: roles[name].id, keyId: roles[name].keyId, enabled: true,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), maxPerMinute: 600 });
  }
  f.policy.maxBacklog = 10000;
  const scope = (tenant, bootstrap, ids) => ({ assetRef: 'gbp-enroll:' + tenant, tenantRef: tenant,
    accountIds: [ACCOUNT], locationIds: ids, bootstrapPreviousAssetRef: bootstrap,
    readPrincipalId: roles.read.id, controlPrincipalId: roles.control.id, readOperations: [...R.OPERATIONS], maxAssets: 10 });
  const targetScope = { ...scope(TARGET_TENANT, null, [OLD]), reassociationSources: [structuredClone(vector.proof)] };
  const binding = {
    connectionRef: vector.request.connectionRef, provider: R.PROVIDER, initialState: 'active',
    secretArn: 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-refresh-abcdef',
    clientSecretArn: 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-client-abcdef',
    oauth: { subject: '990000000000000000003', redirectUri: 'https://example.invalid/oauth/google/callback',
      scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/business.manage'] },
    googleBusinessProfileEnrollmentScopes: [scope(SOURCE_TENANT, asset(OLD), [SUCCESSOR]), targetScope],
    googleBusinessProfileWrites: { locations: [
      { assetRef: asset(OLD), tenantRef: SOURCE_TENANT, allowReviewReplies: false, allowPhotos: false, allowSpecialHours: true },
      { assetRef: asset(AJURI), tenantRef: AJURI_TENANT, allowReviewReplies: false, allowPhotos: false, allowSpecialHours: true },
    ] },
  };
  const grant = (role, tenantRef, assetRef, operations) => ({ principalId: roles[role].id, tenantRef,
    connectionRef: binding.connectionRef, assetRef, operations });
  f.policy.connections = [binding];
  f.policy.grants = [
    grant('read', SOURCE_TENANT, asset(OLD), [...R.OPERATIONS]),
    grant('write', SOURCE_TENANT, asset(OLD), [W.OPERATIONS.hours]),
    grant('control', SOURCE_TENANT, asset(OLD), [R.REVOKE_OPERATION]),
    grant('oauth', SOURCE_TENANT, asset(OLD), Object.values(O.OPERATIONS)),
    grant('read', AJURI_TENANT, asset(AJURI), [...R.OPERATIONS]),
    grant('write', AJURI_TENANT, asset(AJURI), [W.OPERATIONS.hours]),
    ...[SOURCE_TENANT, TARGET_TENANT].flatMap(tenant => [
      grant('enroll', tenant, 'gbp-enroll:' + tenant, [C.OPERATIONS.discover, C.OPERATIONS.prepare, C.OPERATIONS.activate, C.OPERATIONS.status]),
      grant('control', tenant, 'gbp-enroll:' + tenant, [C.OPERATIONS.retire, C.OPERATIONS.abort]),
    ]),
  ];
  const config = { cohort: W.COHORT, enabled: true, listenAddress: '127.0.0.1', port: 8456,
    policy: f.policy, stateFile: '/tmp/fictitious/state.sqlite', cursorKeyFile: '/tmp/fictitious/cursor',
    tlsCertFile: '/tmp/fictitious/cert', tlsKeyFile: '/tmp/fictitious/key' };
  validateConfig(config);
  const state = { calls: [], secretReads: 0, writes: 0, onPage: null, onResource: null, locations: [OLD, SUCCESSOR, AJURI] };
  const http = async request => {
    state.calls.push({ hostname: request.hostname, path: request.path });
    assert.equal(request.token.toString(), ACCESS);
    if (request.hostname === 'www.googleapis.com') return { id: binding.oauth.subject };
    if (request.hostname === 'mybusinessaccountmanagement.googleapis.com') return { name: 'accounts/' + ACCOUNT, accountName: 'FICTITIOUS_ACCOUNT' };
    if (request.path.startsWith(`/v1/accounts/${ACCOUNT}/locations?`)) {
      await state.onPage?.(request);
      return { locations: state.locations.map(location) };
    }
    const match = /^\/v1\/locations\/([1-9]\d*)\?/.exec(request.path);
    if (match) { await state.onResource?.(request); return location(match[1]); }
    assert.fail('Unexpected fake provider request: ' + request.path);
  };
  const codec = cursorCodec(randomBytes(32), () => at);
  function make(store = f.store, policy = f.policy) {
    const engine = createBusinessProfileEnrollment({ store, http, cursor: codec, now: () => at });
    const operations = { ...createGoogleBusinessProfileOperations({ http, cursor: codec }), ...engine.operations,
      [O.OPERATIONS.status]: { provider: R.PROVIDER, control: 'google_oauth', validate: O.validators.status,
        execute: async () => ({ data: { preserved: true } }) },
      [W.OPERATIONS.hours]: { provider: R.PROVIDER, validate: value => W.validate('hours', value),
        execute: async () => { state.writes++; return { preserved: true }; }, project: value => value },
    };
    const secrets = { invalidate() {}, async withSecret(_binding, work) {
      state.secretReads++; const token = Buffer.from(ACCESS);
      try { return await work(token); } finally { token.fill(0); }
    } };
    return { broker: new Broker({ store, policy, secrets, operations, gbpEnrollment: engine,
      now: () => at, timeoutMs: 10000 }), engine };
  }
  const { broker, engine } = make();
  const execute = (name, payload, changes = {}, instance = broker, role = 'enroll') => {
    const command = { requestId: randomUUID(), connectionRef: binding.connectionRef, tenantRef: TARGET_TENANT,
      assetRef: TARGET_SCOPE, operation: C.OPERATIONS[name] || name, payload, ...changes };
    const signed = signRequest(command, { keyId: roles[role].keyId, privateKey: roles[role].keys.privateKey,
      audience: f.policy.audience, now: at });
    return instance.execute(signed.raw, signed.headers);
  };
  const control = (name, payload, changes = {}, instance = broker) => execute(name, payload, changes, instance, 'control');
  const read = (tenant, id, instance = broker) => execute(R.PREFIX + 'details.read.v1', {},
    { tenantRef: tenant, assetRef: asset(id) }, instance, 'read');
  const source = { enrollmentId: vector.proof.retirementEnrollmentId, accountId: ACCOUNT, locationId: SUCCESSOR,
    previousAssetRef: asset(OLD), clinicCount: 1, clinicSetDigest: 'a'.repeat(64) };
  const sourceChanges = { tenantRef: SOURCE_TENANT, assetRef: SOURCE_SCOPE };
  await execute('prepare', source, sourceChanges);
  await execute('activate', source, sourceChanges);
  await control('retire', source, sourceChanges);
  const retired = f.store.db.prepare('SELECT * FROM google_business_profile_retirements WHERE tenant=?').get(SOURCE_TENANT);
  assert.equal(C.retirementDigest(retired), V.RETIREMENT_DIGEST, 'proof names an actual ordinary-flow retirement');
  const target = () => structuredClone(vector.request.payload);
  const anchors = () => JSON.stringify({
    retirements: f.store.db.prepare('SELECT * FROM google_business_profile_retirements ORDER BY tenant,connection,asset').all(),
    source: f.store.db.prepare('SELECT * FROM google_business_profile_enrollments WHERE tenant=? ORDER BY id').all(SOURCE_TENANT),
    heads: f.store.db.prepare('SELECT * FROM google_business_profile_scope_heads WHERE tenant=? ORDER BY scope').all(SOURCE_TENANT),
    connection: f.store.db.prepare('SELECT * FROM connections ORDER BY ref').all(), grants: f.policy.grants,
  });
  const baseline = anchors();
  const second = (policy = f.policy) => {
    const store = new BrokerStore(f.filename); t.after(() => store.close());
    return { store, ...make(store, policy) };
  };
  return { ...f, binding, targetScope, config, roles, state, broker, engine, make, execute, control, read,
    target, source, retired, anchors, baseline, second, proof: vector.proof,
    async prepareAndActivate(p = target(), instance = broker) {
      await execute('prepare', p, {}, instance); await execute('activate', p, {}, instance); return p;
    },
  };
}

function pause() {
  let release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  return { reached, release, enter: () => { entered(); return blocked; } };
}
const rejected = codes => error => { assert(codes.includes(error.code), 'Unexpected rejection: ' + error.code); return true; };
const admissionDenied = rejected(['scope_denied', 'asset_revoked', 'idempotency_conflict']);
const commandState = (f, requestId) => f.store.db.prepare('SELECT * FROM commands WHERE principal=? AND id=?').get(f.roles.enroll.id, requestId);

async function multiHandoffFixture(t, { passive = false, occupiedTarget = false } = {}) {
  const f = await reassociationFixture(t);
  const replacement70 = '990000000000000000070'; const current71 = '990000000000000000071';
  const tenant71 = 'clinic:91071'; const scope71 = 'gbp-enroll:clinic:91071';
  f.state.locations.push(replacement70, current71);
  const policy = structuredClone(f.policy); const binding = policy.connections[0];
  binding.googleBusinessProfileEnrollmentScopes[1].locationIds.push(replacement70);
  const targetScope = { assetRef: scope71, tenantRef: tenant71, accountIds: [ACCOUNT],
    locationIds: [OLD, current71], bootstrapPreviousAssetRef: null,
    readPrincipalId: f.roles.read.id, controlPrincipalId: f.roles.control.id,
    readOperations: [...R.OPERATIONS], maxAssets: 10 };
  binding.googleBusinessProfileEnrollmentScopes.push(targetScope);
  policy.grants.push(...policy.grants.filter(g => g.assetRef === TARGET_SCOPE)
    .map(g => ({ ...g, tenantRef: tenant71, assetRef: scope71 })));
  const before = f.make(f.store, policy).broker;
  let passiveIntent = null; let passiveRequestId = null;
  if (passive) {
    passiveIntent = f.target(); passiveRequestId = randomUUID();
    if (passive === 'prepared') {
      await f.execute('prepare', passiveIntent, { requestId: passiveRequestId }, before);
      assert.equal((await f.control('abort', passiveIntent, {}, before)).data.reassociationCleanupPending, false);
    } else {
      const gate = pause(); f.state.onPage = gate.enter;
      const pending = f.execute('prepare', passiveIntent, { requestId: passiveRequestId }, before)
        .then(value => ({ value }), error => ({ error }));
      await gate.reached;
      assert.equal((await f.control('abort', passiveIntent, {}, before)).data.reassociationCleanupPending, true);
      gate.release(); assert.equal((await pending).error?.code, 'asset_revoked'); f.state.onPage = null;
      assert.equal((await f.execute('status', { enrollmentId: passiveIntent.enrollmentId }, {}, before)).data.reassociationCleanupPending, false);
    }
  }
  const first = { ...f.target(), ...(passive ? { enrollmentId: randomUUID() } : {}) };
  await f.execute('prepare', first, {}, before); await f.execute('activate', first, {}, before); await f.control('retire', first, {}, before);
  const replacement = { enrollmentId: randomUUID(), accountId: ACCOUNT, locationId: replacement70,
    previousAssetRef: asset(OLD), clinicCount: 1, clinicSetDigest: first.clinicSetDigest };
  await f.execute('prepare', replacement, {}, before); await f.execute('activate', replacement, {}, before); await f.control('retire', replacement, {}, before);
  assert.equal(f.store.db.prepare('SELECT state FROM google_business_profile_enrollments WHERE id=?').get(first.enrollmentId).state, 'retired');
  const changes71 = { tenantRef: tenant71, assetRef: scope71 };
  if (occupiedTarget) {
    const existing = { enrollmentId: randomUUID(), accountId: ACCOUNT, locationId: current71,
      previousAssetRef: null, clinicCount: 1, clinicSetDigest: 'c'.repeat(64) };
    await f.execute('prepare', existing, changes71, before); await f.execute('activate', existing, changes71, before); await f.control('retire', existing, changes71, before);
  }
  const retirement = f.store.db.prepare('SELECT * FROM google_business_profile_retirements WHERE tenant=? AND asset=?').get(TARGET_TENANT, asset(OLD));
  const proof = { descriptorId: randomUUID(), sourceTenantRef: TARGET_TENANT, sourceConnectionRef: binding.connectionRef,
    sourceScopeRef: TARGET_SCOPE, sourceAssetRef: asset(OLD), retirementEnrollmentId: replacement.enrollmentId,
    retirementDigest: C.retirementDigest(retirement) };
  delete binding.googleBusinessProfileEnrollmentScopes[1].reassociationSources;
  targetScope.reassociationSources = [proof];
  const current = f.make(f.store, policy).broker;
  const next = { enrollmentId: randomUUID(), accountId: ACCOUNT, locationId: OLD,
    previousAssetRef: occupiedTarget ? asset(current71) : null, clinicCount: 1, clinicSetDigest: 'c'.repeat(64),
    reassociation: structuredClone(proof) };
  const sourceBaseline = JSON.stringify({
    enrollments: f.store.db.prepare('SELECT * FROM google_business_profile_enrollments WHERE tenant IN (?,?) ORDER BY id').all(SOURCE_TENANT, TARGET_TENANT),
    heads: f.store.db.prepare('SELECT * FROM google_business_profile_scope_heads WHERE tenant IN (?,?) ORDER BY tenant,scope').all(SOURCE_TENANT, TARGET_TENANT),
    ledger: f.store.db.prepare('SELECT * FROM google_business_profile_reassociations ORDER BY enrollment_id').all(),
    retirement: f.store.db.prepare('SELECT * FROM google_business_profile_retirements ORDER BY tenant,asset').all(),
  });
  return { ...f, policy, current, first, replacement, proof, next, tenant71, scope71, changes71,
    passiveIntent, passiveRequestId, replacement70, current71, sourceBaseline,
    sourceRows() { return JSON.stringify({
      enrollments: f.store.db.prepare('SELECT * FROM google_business_profile_enrollments WHERE tenant IN (?,?) ORDER BY id').all(SOURCE_TENANT, TARGET_TENANT),
      heads: f.store.db.prepare('SELECT * FROM google_business_profile_scope_heads WHERE tenant IN (?,?) ORDER BY tenant,scope').all(SOURCE_TENANT, TARGET_TENANT),
      ledger: f.store.db.prepare('SELECT * FROM google_business_profile_reassociations WHERE target_tenant<>? ORDER BY enrollment_id').all(tenant71),
      retirement: f.store.db.prepare('SELECT * FROM google_business_profile_retirements WHERE tenant<>? ORDER BY tenant,asset').all(tenant71),
    }); },
    async finish(instance = current) {
      await f.execute('prepare', next, changes71, instance); await f.execute('activate', next, changes71, instance); await f.control('retire', next, changes71, instance);
    },
  };
}

test('explicit reassociation survives SQLite restart while old grants stay unreadable and Ajuri stays unchanged', async t => {
  const f = await reassociationFixture(t); const p = f.target();
  const inventory = await f.execute('discover', { pageToken: null });
  assert.deepEqual(inventory.data.locations.map(row => row.locationId), [OLD]);
  assert.deepEqual(inventory.data.locations[0].reassociation, f.proof);
  await assert.rejects(f.read(TARGET_TENANT, OLD), admissionDenied);
  const prepared = await f.execute('prepare', p);
  assert.deepEqual(prepared.data.reassociation, { ...f.proof, proofDigest: V.REASSOCIATION_DIGEST });
  assert.equal(prepared.data.reassociationCleanupPending, false);
  await assert.rejects(f.read(TARGET_TENANT, OLD), { code: 'scope_denied' });
  const discovery = await f.execute(R.PREFIX + 'discovery.read.v1', {}, { assetRef: asset(OLD) }, f.broker, 'read');
  assert.equal(discovery.data.location.name, 'locations/' + OLD);
  await f.execute('activate', p); await f.control('retire', p);
  const reopened = f.second();
  assert.equal((await f.read(TARGET_TENANT, OLD, reopened.broker)).data.name, 'locations/' + OLD);
  const status = await f.execute('status', { enrollmentId: p.enrollmentId }, {}, reopened.broker);
  assert.equal(status.data.previousAssetRetired, true);
  assert.deepEqual(status.data.reassociation, { ...f.proof, proofDigest: V.REASSOCIATION_DIGEST });
  assert.equal(status.data.reassociationCleanupPending, false);
  await assert.rejects(f.read(SOURCE_TENANT, OLD, reopened.broker), { code: 'asset_revoked' });
  await assert.rejects(f.execute(W.OPERATIONS.hours, { operationId: randomUUID(), periods: [] },
    { tenantRef: SOURCE_TENANT, assetRef: asset(OLD) }, reopened.broker, 'write'), { code: 'asset_revoked' });
  assert.equal(f.state.writes, 0);
  assert.equal((await f.read(AJURI_TENANT, AJURI, reopened.broker)).data.name, 'locations/' + AJURI);
  assert.equal((await f.execute(W.OPERATIONS.hours, { operationId: randomUUID(), periods: [] },
    { tenantRef: AJURI_TENANT, assetRef: asset(AJURI) }, reopened.broker, 'write')).data.preserved, true);
  assert.equal(f.anchors(), f.baseline);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociations').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations').get().n, 0);
});

test('absent migration is closed and the engine never installs reassociation schema', async t => {
  const f = await reassociationFixture(t, { installSchema: false });
  await assert.rejects(f.execute('prepare', f.target()), admissionDenied);
  for (const name of TABLES) assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(name).n, 0);
  assert.equal(f.anchors(), f.baseline);
});

test('missing or altered proof and policy capability cannot admit a retired physical location', async t => {
  for (const kind of ['missing', 'descriptor', 'retirementDigest', 'retirementEnrollment', 'sourceTenant', 'sourceAsset', 'capability']) {
    await t.test(kind, async t => {
      const f = await reassociationFixture(t); const p = f.target(); let instance = f.broker;
      if (kind === 'missing') delete p.reassociation;
      if (kind === 'descriptor') p.reassociation.descriptorId = randomUUID();
      if (kind === 'retirementDigest') p.reassociation.retirementDigest = 'b'.repeat(64);
      if (kind === 'retirementEnrollment') p.reassociation.retirementEnrollmentId = randomUUID();
      if (kind === 'sourceTenant') p.reassociation.sourceTenantRef = 'clinic:91002';
      if (kind === 'sourceAsset') p.reassociation.sourceAssetRef = 'gbp:990000000000000000005:' + OLD;
      if (kind === 'capability') {
        const policy = structuredClone(f.policy); delete policy.connections[0].googleBusinessProfileEnrollmentScopes[1].reassociationSources;
        instance = f.make(f.store, policy).broker;
      }
      const calls = f.state.calls.length;
      await assert.rejects(f.execute('prepare', p, {}, instance), admissionDenied);
      assert.equal(f.state.calls.length, calls);
      assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociations').get().n, 0);
      assert.equal(f.anchors(), f.baseline);
    });
  }
});

test('missing or altered persisted lineage never enables activation or new reads', async t => {
  for (const kind of ['missing', 'digest', 'source', 'target']) await t.test(kind, async t => {
    const f = await reassociationFixture(t); const p = f.target(); await f.execute('prepare', p);
    if (kind === 'missing') f.store.db.prepare('DELETE FROM google_business_profile_reassociations WHERE enrollment_id=?').run(p.enrollmentId);
    if (kind === 'digest') f.store.db.prepare('UPDATE google_business_profile_reassociations SET proof_digest=? WHERE enrollment_id=?').run('b'.repeat(64), p.enrollmentId);
    if (kind === 'source') f.store.db.prepare('UPDATE google_business_profile_reassociations SET source_tenant=? WHERE enrollment_id=?').run('clinic:91002', p.enrollmentId);
    if (kind === 'target') f.store.db.prepare('UPDATE google_business_profile_reassociations SET target_tenant=? WHERE enrollment_id=?').run('clinic:91071', p.enrollmentId);
    await assert.rejects(f.execute('activate', p), admissionDenied);
    await assert.rejects(f.read(TARGET_TENANT, OLD), admissionDenied);
    assert.equal((await f.execute('status', { enrollmentId: p.enrollmentId })).data.accessBlocked, true);
  });
});

test('physical revocation is never excepted before admission, during provider I/O or during a new read', async t => {
  await t.test('before admission with an alternate account and tenant', async t => {
    const f = await reassociationFixture(t);
    f.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:91999', f.binding.connectionRef,
      'gbp:990000000000000000005:' + OLD, randomUUID(), V.EPOCH_MS + 1);
    await assert.rejects(f.execute('prepare', f.target()), { code: 'asset_revoked' });
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociations').get().n, 0);
  });
  await t.test('during preparation from a separate SQLite handle', async t => {
    const f = await reassociationFixture(t); const other = f.second();
    f.state.onPage = () => other.store.db.prepare('INSERT OR IGNORE INTO asset_revocations VALUES (?,?,?,?,?)')
      .run(SOURCE_TENANT, f.binding.connectionRef, asset(OLD), randomUUID(), V.EPOCH_MS + 1);
    await assert.rejects(f.execute('prepare', f.target()), { code: 'asset_revoked' });
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociations').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_enrollments WHERE tenant=?').get(TARGET_TENANT).n, 0);
  });
  await t.test('normal native target revocation rejects a response already in flight', async t => {
    const f = await reassociationFixture(t); await f.prepareAndActivate(); const other = f.second(); const gate = pause();
    f.state.onResource = gate.enter;
    const pending = f.read(TARGET_TENANT, OLD).then(value => ({ value }), error => ({ error }));
    await gate.reached;
    await f.control(R.REVOKE_OPERATION, {}, { tenantRef: TARGET_TENANT, assetRef: asset(OLD) }, other.broker);
    gate.release(); assert.equal((await pending).error?.code, 'asset_revoked');
    f.state.onResource = null;
    await assert.rejects(f.read(TARGET_TENANT, OLD), { code: 'asset_revoked' });
    assert.equal((await f.execute('status', { enrollmentId: f.target().enrollmentId })).data.accessBlocked, true);
    assert.equal((await f.read(AJURI_TENANT, AJURI)).data.name, 'locations/' + AJURI);
  });
});

test('policy, source retirement and persisted lineage are rechecked after activation provider I/O', async t => {
  for (const kind of ['capability', 'retirement', 'ledger']) await t.test(kind, async t => {
    const f = await reassociationFixture(t); const p = f.target(); await f.execute('prepare', p);
    const other = f.second();
    f.state.onPage = () => {
      if (kind === 'capability') delete f.broker.policy.connections[0].googleBusinessProfileEnrollmentScopes[1].reassociationSources;
      if (kind === 'retirement') other.store.db.prepare('UPDATE google_business_profile_retirements SET retired_at=retired_at+1 WHERE tenant=?').run(SOURCE_TENANT);
      if (kind === 'ledger') other.store.db.prepare('UPDATE google_business_profile_reassociations SET proof_digest=? WHERE enrollment_id=?').run('b'.repeat(64), p.enrollmentId);
    };
    await assert.rejects(f.execute('activate', p), admissionDenied); f.state.onPage = null;
    assert.equal(f.store.db.prepare('SELECT state FROM google_business_profile_enrollments WHERE id=?').get(p.enrollmentId).state, 'prepared');
    await assert.rejects(f.read(TARGET_TENANT, OLD), admissionDenied);
    assert.equal((await f.execute('status', { enrollmentId: p.enrollmentId })).data.accessBlocked, true);
  });
});

test('an additional future retirement cannot inherit the original source exception', async t => {
  const f = await reassociationFixture(t); const p = await f.prepareAndActivate();
  f.store.db.prepare('INSERT INTO google_business_profile_retirements VALUES (?,?,?,?,?,?)')
    .run(TARGET_TENANT, f.binding.connectionRef, asset(OLD), OLD, randomUUID(), V.EPOCH_MS + 1);
  await assert.rejects(f.read(TARGET_TENANT, OLD), { code: 'asset_revoked' });
  assert.equal((await f.execute('status', { enrollmentId: p.enrollmentId })).data.accessBlocked, true);
});

test('quiescent cancellation preserves the old attempt and permits only an explicit new enrollment UUID', async t => {
  const f = await reassociationFixture(t); const first = f.target(); await f.execute('prepare', first);
  const cancelled = await f.control('abort', first);
  assert.equal(cancelled.data.state, 'cancelled'); assert.equal(cancelled.data.reassociationCleanupPending, false);
  await assert.rejects(f.execute('activate', first), { code: 'asset_revoked' });
  const next = { ...f.target(), enrollmentId: randomUUID() }; await f.prepareAndActivate(next);
  assert.equal((await f.read(TARGET_TENANT, OLD)).data.name, 'locations/' + OLD);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociations').get().n, 2);
  assert.equal(f.store.db.prepare('SELECT state FROM google_business_profile_enrollments WHERE id=?').get(first.enrollmentId).state, 'cancelled');
  assert.equal(f.anchors(), f.baseline);
});

test('two stores cannot dispatch competing enrollment UUIDs against the same descriptor', async t => {
  const f = await reassociationFixture(t); const other = f.second(); const gate = pause(); f.state.onPage = gate.enter;
  const first = f.target(); const pending = f.execute('prepare', first).then(value => ({ value }), error => ({ error }));
  await gate.reached;
  await assert.rejects(f.execute('prepare', { ...f.target(), enrollmentId: randomUUID() }, {}, other.broker), { code: 'idempotency_conflict' });
  gate.release(); assert.equal((await pending).value?.data.state, 'prepared'); f.state.onPage = null;
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociations').get().n, 1);
});

test('abort during another store I/O requires fresh status after unknown command quiescence before descriptor retry', async t => {
  const f = await reassociationFixture(t); const other = f.second(); const gate = pause(); f.state.onPage = gate.enter;
  const first = f.target(); const requestId = randomUUID();
  const pending = f.execute('prepare', first, { requestId }).then(value => ({ value }), error => ({ error }));
  await gate.reached;
  const metadata = f.store.db.prepare('SELECT * FROM google_business_profile_reassociation_commands WHERE principal=? AND request_id=?').get(f.roles.enroll.id, requestId);
  assert.equal(metadata.enrollment_id, first.enrollmentId); assert.equal(metadata.descriptor_id, f.proof.descriptorId);
  assert.equal(metadata.proof_digest, V.REASSOCIATION_DIGEST);
  const owner = processIdentity(); assert.equal(metadata.owner_pid, owner.pid);
  assert.equal(metadata.owner_start_ticks, owner.startTicks); assert.equal(metadata.owner_boot_id, owner.bootId);
  assert.equal(commandState(f, requestId).state, 'started');
  const cancelled = await f.control('abort', first, {}, other.broker);
  assert.equal(cancelled.data.reassociationCleanupPending, true);
  const staleStatusId = randomUUID();
  assert.equal((await f.execute('status', { enrollmentId: first.enrollmentId }, { requestId: staleStatusId }, other.broker)).data.reassociationCleanupPending, true);
  await assert.rejects(f.execute('prepare', { ...f.target(), enrollmentId: randomUUID() }, {}, other.broker), { code: 'idempotency_conflict' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociation_closeouts').get().n, 0);
  gate.release(); assert.equal((await pending).error?.code, 'asset_revoked'); f.state.onPage = null;
  const historical = commandState(f, requestId); assert.equal(historical.state, 'unknown');
  assert.equal((await f.execute('status', { enrollmentId: first.enrollmentId }, { requestId: staleStatusId }, other.broker)).data.reassociationCleanupPending, true);
  const closeoutRequestId = randomUUID();
  const fresh = await f.execute('status', { enrollmentId: first.enrollmentId }, { requestId: closeoutRequestId }, other.broker);
  assert.equal(fresh.data.reassociationCleanupPending, false);
  const closeout = f.store.db.prepare('SELECT * FROM google_business_profile_reassociation_closeouts').get();
  assert.equal(closeout.principal, metadata.principal); assert.equal(closeout.request_id, requestId);
  assert.equal(closeout.enrollment_id, first.enrollmentId); assert.equal(closeout.closed_by_request_id, closeoutRequestId);
  assert.equal(closeout.outcome, 'cancelled_quiescent'); assert.deepEqual(commandState(f, requestId), historical);
  const next = { ...f.target(), enrollmentId: randomUUID() }; await f.prepareAndActivate(next, other.broker);
  await assert.rejects(f.execute('activate', first), { code: 'asset_revoked' });
});

test('changing a descriptor cannot bypass the same physical location inflight or unknown cancellation fence', async t => {
  const f = await reassociationFixture(t); const original = f.target(); const oldRequestId = randomUUID();
  const other = f.second(); const gate = pause(); f.state.onPage = gate.enter;
  const pending = f.execute('prepare', original, { requestId: oldRequestId }).then(value => ({ value }), error => ({ error }));
  await gate.reached;
  assert.equal((await f.control('abort', original, {}, other.broker)).data.reassociationCleanupPending, true);
  const policy = structuredClone(f.policy); const descriptorId = randomUUID();
  policy.connections[0].googleBusinessProfileEnrollmentScopes[1].reassociationSources[0].descriptorId = descriptorId;
  const changed = f.second(policy);
  const next = { ...f.target(), enrollmentId: randomUUID(), reassociation: { ...f.proof, descriptorId } };
  assert.equal(commandState(f, oldRequestId).state, 'started');
  await assert.rejects(f.execute('prepare', next, {}, changed.broker), { code: 'idempotency_conflict' });
  gate.release(); assert.equal((await pending).error?.code, 'asset_revoked'); f.state.onPage = null;
  const historical = commandState(f, oldRequestId); assert.equal(historical.state, 'unknown');
  await assert.rejects(f.execute('prepare', next, {}, changed.broker), { code: 'idempotency_conflict' });
  const status = await f.execute('status', { enrollmentId: original.enrollmentId }, {}, changed.broker);
  assert.equal(status.data.reassociationCleanupPending, false);
  assert.deepEqual(commandState(f, oldRequestId), historical);
  assert.equal((await f.execute('prepare', next, {}, changed.broker)).data.state, 'prepared');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociations').get().n, 2);
});

test('a dispatched command without ledger can only be cancelled with its exact proof after policy capability removal', async t => {
  for (const kind of ['exact', 'descriptor', 'digest', 'enrollment']) await t.test(kind, async t => {
    const f = await reassociationFixture(t); const first = f.target(); const requestId = randomUUID();
    f.state.onPage = () => { throw Error('FICTITIOUS_PROVIDER_INTERRUPTION'); };
    await assert.rejects(f.execute('prepare', first, { requestId }), { code: 'provider_failed' }); f.state.onPage = null;
    assert.equal(commandState(f, requestId).state, 'unknown');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociations').get().n, 0);
    const policy = structuredClone(f.policy); delete policy.connections[0].googleBusinessProfileEnrollmentScopes[1].reassociationSources;
    const other = f.second(policy); const cancelledIntent = structuredClone(first);
    if (kind === 'descriptor') cancelledIntent.reassociation.descriptorId = randomUUID();
    if (kind === 'digest') cancelledIntent.reassociation.retirementDigest = 'b'.repeat(64);
    if (kind === 'enrollment') cancelledIntent.enrollmentId = randomUUID();
    if (kind === 'exact') {
      const result = await f.control('abort', cancelledIntent, {}, other.broker);
      assert.equal(result.data.state, 'cancelled'); assert.equal(result.data.accessBlocked, true);
      assert.equal(result.data.reassociationCleanupPending, false);
      assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociation_closeouts').get().n, 1);
    } else {
      await assert.rejects(f.control('abort', cancelledIntent, {}, other.broker), admissionDenied);
      assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociations').get().n, 0);
      assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociation_closeouts').get().n, 0);
    }
    await assert.rejects(f.read(TARGET_TENANT, OLD, other.broker), admissionDenied);
    await assert.rejects(f.execute('prepare', { ...f.target(), enrollmentId: randomUUID() }, {}, other.broker), admissionDenied);
    assert.equal(commandState(f, requestId).state, 'unknown');
  });
});

test('orphaned dispatch correlation remains pending even when its recorded process owner is dead', async t => {
  const f = await reassociationFixture(t); const first = f.target(); const requestId = randomUUID();
  f.state.onPage = () => { throw Error('FICTITIOUS_PROVIDER_INTERRUPTION'); };
  await assert.rejects(f.execute('prepare', first, { requestId }), { code: 'provider_failed' }); f.state.onPage = null;
  f.store.db.prepare('DELETE FROM commands WHERE principal=? AND id=?').run(f.roles.enroll.id, requestId);
  f.store.db.prepare('UPDATE google_business_profile_reassociation_commands SET owner_boot_id=? WHERE request_id=?')
    .run('FICTITIOUS_PREVIOUS_BOOT', requestId);
  const result = await f.control('abort', first);
  assert.equal(result.data.reassociationCleanupPending, true);
  assert.equal((await f.execute('status', { enrollmentId: first.enrollmentId })).data.reassociationCleanupPending, true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociation_closeouts').get().n, 0);
  await assert.rejects(f.execute('prepare', { ...f.target(), enrollmentId: randomUUID() }), { code: 'idempotency_conflict' });
  assert.equal(commandState(f, requestId), undefined);
});

test('cancelled closeout distinguishes a live started owner, another live PID and PID/boot reuse', async t => {
  for (const mode of ['started', 'foreign-live', 'pid-reused', 'boot-reused']) await t.test(mode, async t => {
    const f = await reassociationFixture(t); const first = f.target(); const requestId = randomUUID();
    f.state.onPage = () => { throw Error('FICTITIOUS_PROVIDER_INTERRUPTION'); };
    await assert.rejects(f.execute('prepare', first, { requestId }), { code: 'provider_failed' }); f.state.onPage = null;
    const metadata = f.store.db.prepare('SELECT * FROM google_business_profile_reassociation_commands WHERE request_id=?').get(requestId);
    if (mode === 'started') f.store.db.prepare("UPDATE commands SET state='started' WHERE principal=? AND id=?").run(metadata.principal, requestId);
    if (mode === 'foreign-live') {
      const owner = processIdentity(process.ppid);
      f.store.db.prepare('UPDATE google_business_profile_reassociation_commands SET owner_pid=?,owner_start_ticks=?,owner_boot_id=? WHERE request_id=?')
        .run(owner.pid, owner.startTicks, owner.bootId, requestId);
    }
    if (mode === 'pid-reused') f.store.db.prepare('UPDATE google_business_profile_reassociation_commands SET owner_start_ticks=? WHERE request_id=?').run(metadata.owner_start_ticks + '1', requestId);
    if (mode === 'boot-reused') f.store.db.prepare('UPDATE google_business_profile_reassociation_commands SET owner_boot_id=? WHERE request_id=?').run('FICTITIOUS_PREVIOUS_BOOT', requestId);
    const before = commandState(f, requestId); const result = await f.control('abort', first);
    const dead = mode === 'pid-reused' || mode === 'boot-reused';
    assert.equal(result.data.reassociationCleanupPending, !dead);
    assert.deepEqual(commandState(f, requestId), before, 'closeout never rewrites the native command');
    const closeout = f.store.db.prepare('SELECT * FROM google_business_profile_reassociation_closeouts WHERE request_id=?').get(requestId);
    if (dead) assert.equal(closeout.outcome, 'cancelled_dead_owner'); else assert.equal(closeout, undefined);
    if (!dead) {
      await assert.rejects(f.execute('prepare', { ...f.target(), enrollmentId: randomUUID() }), { code: 'idempotency_conflict' });
      f.store.db.prepare("UPDATE commands SET state='unknown' WHERE principal=? AND id=?").run(metadata.principal, requestId);
      f.store.db.prepare('UPDATE google_business_profile_reassociation_commands SET owner_pid=?,owner_start_ticks=?,owner_boot_id=? WHERE request_id=?')
        .run(metadata.owner_pid, metadata.owner_start_ticks, metadata.owner_boot_id, requestId);
      assert.equal((await f.execute('status', { enrollmentId: first.enrollmentId })).data.reassociationCleanupPending, false);
    }
  });
});

test('two distinct-tenant handoffs derive ancestor history without its old capability and survive SQLite restart', async t => {
  const f = await multiHandoffFixture(t);
  assert.equal(f.policy.connections[0].googleBusinessProfileEnrollmentScopes[1].reassociationSources, undefined);
  const inventory = await f.execute('discover', { pageToken: null }, f.changes71, f.current);
  assert.deepEqual(inventory.data.locations.filter(row => row.locationId === OLD).map(row => row.reassociation), [f.proof]);
  await f.finish(); const reopened = f.second(f.policy);
  const status = await f.execute('status', { enrollmentId: f.next.enrollmentId }, f.changes71, reopened.broker);
  assert.equal(status.data.accessBlocked, false); assert.equal(status.data.reassociationCleanupPending, false);
  const request = { tenantRef: f.tenant71, connectionRef: f.binding.connectionRef, assetRef: f.scope71, payload: f.next };
  assert.deepEqual(status.data.reassociation, { ...f.proof, proofDigest: C.reassociationDigest(f.proof, request) });
  assert.equal((await f.read(f.tenant71, OLD, reopened.broker)).data.name, 'locations/' + OLD);
  for (const tenant of [SOURCE_TENANT, TARGET_TENANT]) {
    await assert.rejects(f.read(tenant, OLD, reopened.broker), admissionDenied);
    await assert.rejects(f.execute(W.OPERATIONS.hours, { operationId: randomUUID(), periods: [] },
      { tenantRef: tenant, assetRef: asset(OLD) }, reopened.broker, 'write'), admissionDenied);
  }
  assert.equal(f.state.writes, 0); assert.equal((await f.read(AJURI_TENANT, AJURI, reopened.broker)).data.name, 'locations/' + AJURI);
  assert.equal((await f.read(TARGET_TENANT, f.replacement70, reopened.broker)).data.name, 'locations/' + f.replacement70);
  assert.equal(f.sourceRows(), f.sourceBaseline);
});

test('multihop activation rejects a missing or altered ancestor ledger and an unrelated retirement or revocation', async t => {
  for (const kind of ['missing-ledger', 'digest', 'source', 'retirement', 'revocation']) await t.test(kind, async t => {
    const f = await multiHandoffFixture(t);
    if (kind === 'missing-ledger') f.store.db.prepare('DELETE FROM google_business_profile_reassociations WHERE enrollment_id=?').run(f.first.enrollmentId);
    if (kind === 'digest') f.store.db.prepare('UPDATE google_business_profile_reassociations SET proof_digest=? WHERE enrollment_id=?').run('b'.repeat(64), f.first.enrollmentId);
    if (kind === 'source') f.store.db.prepare('UPDATE google_business_profile_reassociations SET source_scope=? WHERE enrollment_id=?').run('gbp-enroll:clinic:91999', f.first.enrollmentId);
    if (kind === 'retirement') f.store.db.prepare('INSERT INTO google_business_profile_retirements VALUES (?,?,?,?,?,?)')
      .run('clinic:91999', f.binding.connectionRef, asset(OLD), OLD, randomUUID(), V.EPOCH_MS + 1);
    if (kind === 'revocation') f.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)')
      .run(SOURCE_TENANT, f.binding.connectionRef, asset(OLD), randomUUID(), V.EPOCH_MS + 1);
    const calls = f.state.calls.length;
    await assert.rejects(f.execute('prepare', f.next, f.changes71, f.current), admissionDenied);
    assert.equal(f.state.calls.length, calls);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_enrollments WHERE id=?').get(f.next.enrollmentId).n, 0);
  });
});

test('multihop cannot target a clinic already present in its historical ancestry', async t => {
  const f = await multiHandoffFixture(t); const policy = structuredClone(f.policy);
  const root = policy.connections[0].googleBusinessProfileEnrollmentScopes[0];
  root.locationIds.push(OLD); root.reassociationSources = [structuredClone(f.proof)];
  const current = f.make(f.store, policy).broker;
  const request = { ...f.next, enrollmentId: randomUUID(), previousAssetRef: asset(SUCCESSOR) };
  await assert.rejects(f.execute('prepare', request, { tenantRef: SOURCE_TENANT, assetRef: SOURCE_SCOPE }, current), admissionDenied);
});

test('multihop admits only correctly bound closed passive attempts from its proven prefix', async t => {
  await t.test('cancel then explicit retry in clinic70 remains valid history for clinic71', async t => {
    const f = await multiHandoffFixture(t, { passive: true }); await f.finish();
    assert.equal((await f.read(f.tenant71, OLD, f.current)).data.name, 'locations/' + OLD);
    assert.equal(commandState(f, f.passiveRequestId).state, 'unknown');
    assert.equal(f.store.db.prepare('SELECT state FROM google_business_profile_enrollments WHERE id=?').get(f.passiveIntent.enrollmentId).state, 'cancelled');
  });
  await t.test('a verified prepared then cancelled ancestor-prefix attempt remains historical only', async t => {
    const f = await multiHandoffFixture(t, { passive: 'prepared' }); await f.finish();
    assert.equal((await f.read(f.tenant71, OLD, f.current)).data.name, 'locations/' + OLD);
    assert.equal(commandState(f, f.passiveRequestId).state, 'completed');
    assert.equal(f.store.db.prepare('SELECT verified FROM google_business_profile_enrollments WHERE id=?').get(f.passiveIntent.enrollmentId).verified, 1);
  });
  await t.test('passive prefix digest altered', async t => {
    const f = await multiHandoffFixture(t, { passive: true });
    f.store.db.prepare('UPDATE google_business_profile_reassociations SET proof_digest=? WHERE enrollment_id=?').run('b'.repeat(64), f.passiveIntent.enrollmentId);
    await assert.rejects(f.execute('prepare', f.next, f.changes71, f.current), admissionDenied);
  });
  await t.test('missing passive closeout blocks until its original intent is freshly reconciled', async t => {
    const f = await multiHandoffFixture(t, { passive: true });
    f.store.db.prepare('DELETE FROM google_business_profile_reassociation_closeouts WHERE request_id=?').run(f.passiveRequestId);
    await assert.rejects(f.execute('prepare', f.next, f.changes71, f.current), { code: 'idempotency_conflict' });
    const status = await f.execute('status', { enrollmentId: f.passiveIntent.enrollmentId }, {}, f.current);
    assert.equal(status.data.reassociationCleanupPending, false);
    await f.finish();
  });
});

test('multihop destination with an existing C requires that exact current predecessor', async t => {
  const f = await multiHandoffFixture(t, { occupiedTarget: true });
  for (const previousAssetRef of [null, asset(f.replacement70)]) {
    await assert.rejects(f.execute('prepare', { ...f.next, enrollmentId: randomUUID(), previousAssetRef }, f.changes71, f.current), admissionDenied);
  }
  await f.finish(); const reopened = f.second(f.policy);
  assert.equal((await f.read(f.tenant71, OLD, reopened.broker)).data.name, 'locations/' + OLD);
  await assert.rejects(f.read(f.tenant71, f.current71, reopened.broker), admissionDenied);
  assert.equal((await f.execute('status', { enrollmentId: f.next.enrollmentId }, f.changes71, reopened.broker)).data.previousAssetRef, asset(f.current71));
  assert.equal(f.sourceRows(), f.sourceBaseline);
});

test('a recalculated valid ancestor proof digest cannot conceal an enrollment ancestry cycle', async t => {
  const f = await multiHandoffFixture(t); await f.finish();
  const replacement = { enrollmentId: randomUUID(), accountId: ACCOUNT, locationId: f.current71,
    previousAssetRef: asset(OLD), clinicCount: 1, clinicSetDigest: f.next.clinicSetDigest };
  await f.execute('prepare', replacement, f.changes71, f.current);
  await f.execute('activate', replacement, f.changes71, f.current);
  await f.control('retire', replacement, f.changes71, f.current);
  const retirement = f.store.db.prepare('SELECT * FROM google_business_profile_retirements WHERE tenant=? AND asset=?').get(f.tenant71, asset(OLD));
  const loopProof = { descriptorId: randomUUID(), sourceTenantRef: f.tenant71,
    sourceConnectionRef: f.binding.connectionRef, sourceScopeRef: f.scope71, sourceAssetRef: asset(OLD),
    retirementEnrollmentId: replacement.enrollmentId, retirementDigest: C.retirementDigest(retirement) };
  const ancestor = f.store.db.prepare('SELECT * FROM google_business_profile_enrollments WHERE id=?').get(f.first.enrollmentId);
  const targetRequest = { tenantRef: ancestor.tenant, connectionRef: ancestor.connection, assetRef: ancestor.scope,
    payload: { enrollmentId: ancestor.id, accountId: ancestor.account, locationId: ancestor.location,
      previousAssetRef: ancestor.previous_asset, clinicCount: ancestor.clinic_count, clinicSetDigest: ancestor.clinic_digest } };
  const loopDigest = C.reassociationDigest(loopProof, targetRequest);
  f.store.db.prepare(`UPDATE google_business_profile_reassociations SET descriptor_id=?,source_tenant=?,source_scope=?,
    retirement_enrollment_id=?,retirement_digest=?,proof_digest=? WHERE enrollment_id=?`)
    .run(loopProof.descriptorId, loopProof.sourceTenantRef, loopProof.sourceScopeRef,
      loopProof.retirementEnrollmentId, loopProof.retirementDigest, loopDigest, ancestor.id);
  assert.equal(f.store.db.prepare('SELECT proof_digest FROM google_business_profile_reassociations WHERE enrollment_id=?').get(ancestor.id).proof_digest,
    C.reassociationDigest(loopProof, targetRequest), 'the corrupted ancestry still has a structurally valid recomputed digest');
  const policy = structuredClone(f.policy); const binding = policy.connections[0];
  delete binding.googleBusinessProfileEnrollmentScopes[2].reassociationSources;
  const tenant72 = 'clinic:91072'; const scope72 = 'gbp-enroll:clinic:91072';
  const immediate = { ...loopProof, descriptorId: randomUUID() };
  const scope = { ...structuredClone(binding.googleBusinessProfileEnrollmentScopes[2]),
    tenantRef: tenant72, assetRef: scope72, locationIds: [OLD], reassociationSources: [immediate] };
  binding.googleBusinessProfileEnrollmentScopes.push(scope);
  policy.grants.push(...policy.grants.filter(g => g.assetRef === f.scope71).map(g => ({ ...g, tenantRef: tenant72, assetRef: scope72 })));
  const current = f.make(f.store, policy).broker;
  const next = { ...f.next, enrollmentId: randomUUID(), reassociation: immediate };
  const calls = f.state.calls.length;
  await assert.rejects(f.execute('prepare', next, { tenantRef: tenant72, assetRef: scope72 }, current), admissionDenied);
  assert.equal(f.state.calls.length, calls);
});

test('twenty native distinct-tenant handoff proofs are admissible and a twenty-first is closed', async t => {
  const f = await reassociationFixture(t); const policy = structuredClone(f.policy); const binding = policy.connections[0];
  const enrollmentGrants = policy.grants.filter(g => g.assetRef === TARGET_SCOPE).map(g => structuredClone(g));
  let immediate = structuredClone(f.proof); let accepted = 0;
  for (let depth = 1; depth <= 21; depth++) {
    const tenant = 'clinic:' + (91069 + depth); const scopeRef = 'gbp-enroll:' + tenant;
    const replacementId = '990000000000000001' + String(depth).padStart(3, '0');
    f.state.locations.push(replacementId);
    let scope = binding.googleBusinessProfileEnrollmentScopes.find(s => s.assetRef === scopeRef);
    if (!scope) {
      scope = { assetRef: scopeRef, tenantRef: tenant, accountIds: [ACCOUNT], locationIds: [OLD, replacementId],
        bootstrapPreviousAssetRef: null, readPrincipalId: f.roles.read.id, controlPrincipalId: f.roles.control.id,
        readOperations: [...R.OPERATIONS], maxAssets: 10 };
      binding.googleBusinessProfileEnrollmentScopes.push(scope);
      policy.grants.push(...enrollmentGrants.map(g => ({ ...g, tenantRef: tenant, assetRef: scopeRef })));
    }
    scope.locationIds = [OLD, replacementId]; scope.reassociationSources = [structuredClone(immediate)];
    const current = f.make(f.store, policy).broker; const changes = { tenantRef: tenant, assetRef: scopeRef };
    const intent = { enrollmentId: randomUUID(), accountId: ACCOUNT, locationId: OLD,
      previousAssetRef: null, clinicCount: 1, clinicSetDigest: 'd'.repeat(64), reassociation: structuredClone(immediate) };
    if (depth === 21) {
      const calls = f.state.calls.length;
      await assert.rejects(f.execute('prepare', intent, changes, current), admissionDenied);
      assert.equal(f.state.calls.length, calls); break;
    }
    await f.execute('prepare', intent, changes, current); await f.execute('activate', intent, changes, current); await f.control('retire', intent, changes, current);
    accepted++;
    if (depth === 20) assert.equal((await f.read(tenant, OLD, current)).data.name, 'locations/' + OLD);
    const replacement = { enrollmentId: randomUUID(), accountId: ACCOUNT, locationId: replacementId,
      previousAssetRef: asset(OLD), clinicCount: 1, clinicSetDigest: intent.clinicSetDigest };
    await f.execute('prepare', replacement, changes, current); await f.execute('activate', replacement, changes, current); await f.control('retire', replacement, changes, current);
    const retirement = f.store.db.prepare('SELECT * FROM google_business_profile_retirements WHERE tenant=? AND asset=?').get(tenant, asset(OLD));
    immediate = { descriptorId: randomUUID(), sourceTenantRef: tenant, sourceConnectionRef: binding.connectionRef,
      sourceScopeRef: scopeRef, sourceAssetRef: asset(OLD), retirementEnrollmentId: replacement.enrollmentId,
      retirementDigest: C.retirementDigest(retirement) };
    delete scope.reassociationSources;
  }
  assert.equal(accepted, 20);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_reassociations').get().n, 20);
  assert.equal((await f.read(AJURI_TENANT, AJURI, f.make(f.store, policy).broker)).data.name, 'locations/' + AJURI);
});

'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { randomBytes, randomUUID, generateKeyPairSync } = require('node:crypto');
const { adsFixture, CUSTOMER, MANAGER, ASSET, ACCESS, DEVELOPER } = require('./google-ads-fixture.cjs');
const { createGoogleAdsEnrollment } = require('../src/google-ads-enrollment');
const { cursorCodec } = require('../src/provider-cursor'); const { Broker } = require('../src/broker');
const { BrokerStore } = require('../src/store'); const { signRequest } = require('../src/auth');
const contract = require('../src/google-ads-enrollment-contract'); const ads = require('../src/google-ads-contract');
const { validateConfig } = require('../src/google-main');
const NEW = '2222222222'; const SCOPE = 'ads-enroll:group:5';
function candidate(id = NEW) {
  return { customerClient: { id, clientCustomer: 'customers/' + id, level: '1',
    manager: false, descriptiveName: 'FICTITIOUS_ACCOUNT', currencyCode: 'EUR', timeZone: 'Europe/Madrid', status: 'ENABLED' } };
}
function enrollmentFixture(t) {
  const f = adsFixture(t); const keys = generateKeyPairSync('ed25519');
  f.policy.principals.push({ ...f.policy.principals[0], id: 'enroll:test', keyId: 'enroll-key',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) });
  f.binding.googleAdsEnrollmentScopes = [{ assetRef: SCOPE, tenantRef: 'clinic:123', rootCustomerId: MANAGER,
    loginCustomerId: null, readPrincipalId: 'api:test', controlPrincipalId: 'control:test',
    readOperations: [...ads.OPERATIONS], maxAssets: 20 }];
  f.policy.grants.push({ principalId: 'enroll:test', tenantRef: 'clinic:123', connectionRef: f.binding.connectionRef,
    assetRef: SCOPE, operations: Object.values(contract.OPERATIONS) });
  f.policy.grants.push({ ...f.policy.grants.at(-1), principalId: 'control:test', operations: [ads.REVOKE_OPERATION, contract.REVOKE_OPERATION] });
  const config = { cohort: 'google-ads-read-v1', enabled: true, listenAddress: '127.0.0.1', port: 3443,
    policy: f.policy, stateFile: '/tmp/fictitious/state.sqlite', cursorKeyFile: '/tmp/fictitious/cursor', tlsCertFile: '/tmp/fictitious/cert', tlsKeyFile: '/tmp/fictitious/key' };
  validateConfig(config);
  let at = Date.now(); const cursor = cursorCodec(randomBytes(32), () => at); const engines = [];
  function make(store = f.store, policy = f.policy, timeoutMs = 1000) {
    const engine = createGoogleAdsEnrollment({ store, http: f.http, cursor, now: () => at,
      withDeveloperSecret: async (_binding, work) => {
        const value = Buffer.from(f.state.developer); try { return await work(value); } finally { value.fill(0); }
      } }); engines.push(engine);
    const broker = new Broker({ store, policy, secrets: f.secrets, adsEnrollment: engine,
      operations: { ...f.engine.operations, ...engine.operations }, now: () => at, timeoutMs });
    return { broker, engine };
  }
  const { broker, engine } = make();
  const intent = () => ({ enrollmentId: randomUUID(), customerId: NEW, clinicCount: 2, clinicSetDigest: 'a'.repeat(64) });
  function execute(name, payload, changes = {}, instance = broker, role = 'enroll') {
    const value = { requestId: randomUUID(), connectionRef: f.binding.connectionRef, tenantRef: 'clinic:123',
      operation: contract.OPERATIONS[name] || name, assetRef: SCOPE, payload, ...changes };
    const signer = role === 'read' ? { keyId: 'qa-key', privateKey: f.keys.privateKey }
      : role === 'control' ? { keyId: 'control-key', privateKey: f.control.privateKey } : { keyId: 'enroll-key', privateKey: keys.privateKey };
    const signed = signRequest(value, { ...signer, audience: f.policy.audience, now: at });
    return instance.execute(signed.raw, signed.headers);
  }
  const read = (family = 'account', target = NEW, instance = broker) => execute(ads.PREFIX + family + '.read.v1', {}, { assetRef: 'ads:' + target }, instance, 'read');
  const revoke = (target = NEW, instance = broker) => execute(ads.REVOKE_OPERATION, {}, { assetRef: target.startsWith('ads-enroll:') ? target : 'ads:' + target }, instance, 'control');
  const initialResponse = { results: [candidate()] }; f.state.response = initialResponse;
  t.after(() => engines.forEach(e => e.close()));
  return { ...f, enrollmentKeys: keys, config, broker, engine, make, intent, execute, read, revoke, initialResponse, advance: ms => { at += ms; } };
}
test('enrollment discovers unregistered children from a pinned root without exporting secrets or provider payloads', async t => {
  const f = enrollmentFixture(t); f.state.response.results[0].customerClient.ignored = ACCESS;
  const result = await f.execute('discover', { pageToken: null });
  assert.deepEqual(result.data.accounts, [{ id: NEW, manager: false, currencyCode: 'EUR', timeZone: 'Europe/Madrid',
    descriptiveName: 'FICTITIOUS_ACCOUNT', status: 'ENABLED' }]);
  assert.equal(f.state.calls[0].path, `/v24/customers/${MANAGER}/googleAds:search`);
  assert.equal(f.state.calls[0].loginCustomerId, null);
  assert.equal(f.state.calls[0].json.query, contract.query());
  assert.doesNotMatch(JSON.stringify(result), /FICTITIOUS_ADS|ignored/);
  assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all()), /FICTITIOUS_ACCOUNT/);
});
test('prepared grants allow discovery only; activation atomically enables the existing typed reader and survives restart', async t => {
  const f = enrollmentFixture(t); const p = f.intent();
  await assert.rejects(f.read(), { code: 'scope_denied' });
  const prepared = await f.execute('prepare', p); assert.equal(prepared.data.state, 'prepared');
  await assert.rejects(f.read(), { code: 'scope_denied' });
  f.state.response = { results: [{ customer: { id: NEW, manager: false, currencyCode: 'EUR', timeZone: 'Europe/Madrid', status: 'ENABLED' } }] };
  assert.equal((await f.read('discovery')).data.results[0].customer.id, NEW);
  assert.equal(f.state.calls.at(-1).loginCustomerId, MANAGER);
  f.state.response = f.initialResponse;
  assert.equal((await f.execute('activate', p)).data.state, 'active');
  assert.equal(f.broker.policy.connections[0].googleAdsAccounts.length, 1, 'static policy is immutable');
  const second = new BrokerStore(f.filename); t.after(() => second.close()); const restarted = f.make(second);
  f.state.response = { results: [{ customer: { id: NEW, currencyCode: 'EUR', timeZone: 'Europe/Madrid' } }] };
  assert.equal((await f.read('account', NEW, restarted.broker)).data.results[0].customer.id, NEW);
  const row = second.db.prepare('SELECT * FROM google_ads_enrollments').get(); assert.equal(row.state, 'active');
  assert.doesNotMatch(JSON.stringify(row), /FICTITIOUS_ACCOUNT|FICTITIOUS_ADS/);
});
test('replaying an acknowledged preparation is idempotent; revocation wins over historical successful receipts', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); const requestId = randomUUID();
  await f.execute('prepare', p, { requestId }); const calls = f.state.calls.length;
  assert.equal((await f.execute('prepare', p, { requestId })).replayed, true);
  assert.equal(f.state.calls.length, calls);
  await f.revoke();
  await assert.rejects(f.execute('prepare', p, { requestId }), { code: 'asset_revoked' });
  await assert.rejects(f.execute('activate', p), { code: 'asset_revoked' });
  const status = await f.execute('status', { enrollmentId: p.enrollmentId });
  assert.equal(status.data.state, 'revoked'); assert.equal(status.data.accessBlocked, true);
  const second = new BrokerStore(f.filename); t.after(() => second.close()); const restarted = f.make(second);
  await assert.rejects(f.execute('prepare', f.intent(), {}, restarted.broker), { code: 'asset_revoked' });
});
test('retiring an ordinary account does not retire the independent enrollment scope; scope revocation closes dynamic reads', async t => {
  const f = enrollmentFixture(t); const p = f.intent();
  await f.revoke(CUSTOMER); await f.execute('prepare', p); await f.execute('activate', p);
  await f.revoke(SCOPE);
  await assert.rejects(f.read(), { code: 'asset_revoked' });
  await assert.rejects(f.execute('discover', { pageToken: null }), { code: 'asset_revoked' });
  await f.revoke(); // Removing children remains possible while the scope is blocked.
  assert.equal((await f.execute('status', { enrollmentId: p.enrollmentId })).data.state, 'revoked');
});
test('ownership, previous revocations, static assignments and intent identity reject before provider access', async t => {
  const f = enrollmentFixture(t); const p = f.intent();
  await assert.rejects(f.execute('prepare', { ...p, customerId: CUSTOMER }), { code: 'scope_denied' });
  await assert.rejects(f.execute('activate', p), { code: 'scope_denied' });
  await assert.rejects(f.execute('prepare', p, { tenantRef: 'clinic:999' }), { code: 'scope_denied' });
  await assert.rejects(f.execute('prepare', { ...p, loginCustomerId: MANAGER }), { code: 'invalid_request' });
  await assert.rejects(f.execute('prepare', p, {}, f.broker, 'read'), { code: 'scope_denied' });
  assert.equal(f.state.sdk.length, 0);
  await f.execute('prepare', p); const calls = f.state.calls.length;
  await assert.rejects(f.execute('prepare', f.intent()), { code: 'scope_denied' });
  await assert.rejects(f.execute('activate', { ...p, clinicSetDigest: 'b'.repeat(64) }), { code: 'idempotency_conflict' });
  await assert.rejects(f.execute('activate', { ...p, clinicCount: 1 }), { code: 'idempotency_conflict' });
  assert.equal(f.state.calls.length, calls);
  f.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:999', 'connection:other', 'ads:3333333333', randomUUID(), Date.now());
  await assert.rejects(f.execute('prepare', { ...f.intent(), customerId: '3333333333' }), { code: 'asset_revoked' });
});
test('enrollment policy requires distinct cryptographic roles, explicit scopes and closed operations', t => {
  const f = enrollmentFixture(t);
  for (const mutate of [p => { p.principals[2].publicKey = p.principals[0].publicKey; },
    p => { p.connections[0].googleAdsEnrollmentScopes[0].readPrincipalId = 'missing'; },
    p => { p.connections[0].googleAdsEnrollmentScopes[0].readOperations = [ads.REVOKE_OPERATION]; },
    p => { p.grants.at(-2).assetRef = ASSET; },
    p => { p.grants.at(-2).operations.push(ads.OPERATIONS[0]); },
    p => { p.connections[0].googleAdsEnrollmentScopes.push(p.connections[0].googleAdsEnrollmentScopes[0]); },
    p => { p.connections[0].googleAdsEnrollmentScopes[0].rootCustomerId = '0000000000'; }]) {
    const config = structuredClone(f.config); mutate(config.policy); assert.throws(() => validateConfig(config));
  }
  const empty = structuredClone(f.config); delete empty.policy.connections[0].googleAdsAccounts;
  empty.policy.grants = empty.policy.grants.filter(g => g.assetRef === SCOPE); assert.equal(validateConfig(empty), empty);
});
test('discovery paginates the bounded snapshot, validates all rows first and filters newly registered/revoked assets', async t => {
  const f = enrollmentFixture(t); f.state.response = { results: Array.from({ length: 301 }, (_, i) => candidate(String(2000000000 + i))) };
  const first = await f.execute('discover', { pageToken: null }); assert.equal(first.data.accounts.length, 250);
  f.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:999', 'connection:other', 'ads:2000000250', randomUUID(), Date.now());
  const last = await f.execute('discover', { pageToken: first.data.nextPageToken });
  assert.equal(last.data.accounts.length, 50); assert.equal(last.data.nextPageToken, null); assert.equal(f.state.calls.length, 1);
  f.state.developer = 'FICTITIOUS_ADS_ROTATED_DEVELOPER';
  await assert.rejects(f.execute('discover', { pageToken: first.data.nextPageToken }), { code: 'invalid_request' });
  f.state.developer = DEVELOPER; f.advance(600001);
  await assert.rejects(f.execute('discover', { pageToken: first.data.nextPageToken }), { code: 'invalid_request' });
});
test('oversized, malformed, manager, out-of-scope or partial provider responses cannot create registrations', async t => {
  const f = enrollmentFixture(t);
  for (const value of [{ results: Array.from({ length: 1001 }, (_, i) => candidate(String(2000000000 + i))) },
    { results: [candidate()], nextPageToken: 'raw-provider-cursor' }, { results: [candidate(), candidate()] },
    { results: [{ customerClient: { ...candidate().customerClient, manager: true } }] },
    { results: [{ customerClient: { ...candidate().customerClient, level: '0' } }] },
    { results: [{ customerClient: { ...candidate().customerClient, descriptiveName: DEVELOPER } }] },
    { results: [candidate()], partialFailureError: { secret: ACCESS } }]) {
    f.state.response = value; await assert.rejects(f.execute('discover', { pageToken: null }), { code: 'provider_failed' });
  }
  for (const value of [{ results: [candidate('3333333333')] }, { results: [] },
    { results: [{ customerClient: { ...candidate().customerClient, status: 'CLOSED' } }] }]) {
    f.state.response = value; await assert.rejects(f.execute('prepare', f.intent()), { code: 'provider_failed' });
  }
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_ads_enrollments').get().n, 0);
});
test('audit failure rolls back the registration and receipt together; retry uses a new command and the same intent', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); const append = f.store.appendAudit.bind(f.store);
  f.store.appendAudit = event => { if (event.action === 'integration.completed') throw Error('FICTITIOUS_AUDIT_FAILURE'); return append(event); };
  await assert.rejects(f.execute('prepare', p), { code: 'provider_failed' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_ads_enrollments').get().n, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE state='completed'").get().n, 0);
  f.store.appendAudit = append;
  await f.execute('prepare', p);
  f.store.appendAudit = event => { if (event.action === 'integration.completed') throw Error('FICTITIOUS_AUDIT_FAILURE'); return append(event); };
  await assert.rejects(f.execute('activate', p), { code: 'provider_failed' });
  assert.equal(f.store.db.prepare('SELECT state FROM google_ads_enrollments').get().state, 'prepared');
  f.store.appendAudit = append;
});
test('revocation during provider verification prevents activation with no partial state change', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); await f.execute('prepare', p);
  f.state.onRead = () => f.revoke();
  await assert.rejects(f.execute('activate', p), { code: 'asset_revoked' });
  assert.equal(f.store.db.prepare('SELECT state FROM google_ads_enrollments').get().state, 'prepared');
});
test('status works without secrets while blocked; configuration changes do not inherit old dynamic rights', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); await f.execute('prepare', p); await f.execute('activate', p);
  f.store.db.prepare("UPDATE connections SET state='blocked',revision=revision+1").run(); f.state.failMetadata = true;
  const calls = f.state.sdk.length; const result = await f.execute('status', { enrollmentId: p.enrollmentId });
  assert.equal(result.data.accessBlocked, true); assert.equal(f.state.sdk.length, calls);
  const policy = structuredClone(f.policy); policy.connections[0].googleAdsEnrollmentScopes[0].rootCustomerId = '3333333333';
  const changed = f.make(f.store, policy); await assert.rejects(f.read('account', NEW, changed.broker), { code: 'scope_denied' });
  await f.revoke(NEW, changed.broker);
});
test('timeout cannot leave a late preparation or activation and scope capacity counts pending registrations', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); const fast = f.make(f.store, f.policy, 5);
  let release; let started; const startedPromise = new Promise(resolve => { started = resolve; });
  f.state.onRead = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const waiting = assert.rejects(f.execute('prepare', p, {}, fast.broker), { code: 'provider_timeout' }); await startedPromise;
  await waiting; release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_ads_enrollments').get().n, 0);
  f.state.onRead = null;
  const policy = structuredClone(f.policy); policy.connections[0].googleAdsEnrollmentScopes[0].maxAssets = 1;
  const limited = f.make(f.store, policy); await f.execute('prepare', p, {}, limited.broker);
  await assert.rejects(f.execute('prepare', { ...f.intent(), customerId: '3333333333' }, {}, limited.broker), { code: 'rate_limited' });
});
test('concurrent owners cannot both prepare the same customer and a second process block wins at commit', async t => {
  const f = enrollmentFixture(t); let entered = 0; let release; const barrier = new Promise(resolve => { release = resolve; });
  f.state.onRead = async () => { if (++entered === 2) release(); await barrier; };
  const outcomes = await Promise.allSettled([f.execute('prepare', f.intent()), f.execute('prepare', f.intent())]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_ads_enrollments').get().n, 1);
  const p = f.intent(); p.customerId = '3333333333'; f.state.response = { results: [candidate(p.customerId)] }; f.state.onRead = null;
  const second = new BrokerStore(f.filename); t.after(() => second.close());
  const complete = f.store.complete.bind(f.store);
  f.store.complete = (...args) => {
    second.db.prepare("UPDATE connections SET state='blocked',revision=revision+1 WHERE ref=?").run(f.binding.connectionRef);
    return complete(...args);
  };
  await assert.rejects(f.execute('prepare', p), { code: 'connection_blocked' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_ads_enrollments').get().n, 1);
});
test('enrollment control can revoke before prepare without secrets; the original owner can reconcile after restart', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); const requestId = randomUUID();
  const result = await f.execute(contract.REVOKE_OPERATION, p, { requestId }, f.broker, 'control');
  assert.equal(result.data.state, 'revoked'); assert.equal(result.data.accessBlocked, true);
  assert.equal(f.state.sdk.length, 0); assert.equal(f.state.calls.length, 0);
  assert.equal((await f.execute(contract.REVOKE_OPERATION, p, { requestId }, f.broker, 'control')).replayed, true);
  await assert.rejects(f.execute('prepare', p), { code: 'asset_revoked' });
  const second = new BrokerStore(f.filename); t.after(() => second.close()); const restarted = f.make(second);
  const status = await f.execute('status', { enrollmentId: p.enrollmentId }, {}, restarted.broker);
  assert.equal(status.data.state, 'revoked'); assert.equal(f.state.sdk.length, 0);
});
test('enrollment revocation races with preparation and activation without allowing late grants', async t => {
  const f = enrollmentFixture(t); const p = f.intent();
  f.state.onRead = () => f.execute(contract.REVOKE_OPERATION, p, {}, f.broker, 'control');
  await assert.rejects(f.execute('prepare', p), { code: 'asset_revoked' });
  assert.equal((await f.execute('status', { enrollmentId: p.enrollmentId })).data.state, 'revoked');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_ads_enrollments').get().n, 0);
  const q = { ...f.intent(), customerId: '3333333333' }; f.state.response = { results: [candidate(q.customerId)] };
  f.state.onRead = null; await f.execute('prepare', q);
  f.state.onRead = () => f.execute(contract.REVOKE_OPERATION, q, {}, f.broker, 'control');
  await assert.rejects(f.execute('activate', q), { code: 'asset_revoked' });
});
test('enrollment revocation respects ownership, scope and intent metadata and survives connection/scope blocks', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); await f.execute('prepare', p);
  const before = f.state.sdk.length;
  await assert.rejects(f.execute(contract.REVOKE_OPERATION, p), { code: 'scope_denied' });
  await assert.rejects(f.execute(contract.REVOKE_OPERATION, { ...p, customerId: CUSTOMER }, {}, f.broker, 'control'), { code: 'scope_denied' });
  await assert.rejects(f.execute(contract.REVOKE_OPERATION, { ...p, clinicSetDigest: 'b'.repeat(64) }, {}, f.broker, 'control'), { code: 'idempotency_conflict' });
  await assert.rejects(f.execute(contract.REVOKE_OPERATION, f.intent(), {}, f.broker, 'control'), { code: 'scope_denied' });
  await assert.rejects(f.execute(contract.REVOKE_OPERATION, p, { tenantRef: 'clinic:999' }, f.broker, 'control'), { code: 'scope_denied' });
  await f.revoke(SCOPE); f.store.db.prepare("UPDATE connections SET state='blocked',revision=revision+1").run();
  assert.equal((await f.execute(contract.REVOKE_OPERATION, p, {}, f.broker, 'control')).data.state, 'revoked');
  assert.equal(f.state.sdk.length, before);
});
test('enrollment revocation and its audit receipt roll back together on audit failure', async t => {
  const f = enrollmentFixture(t); const append = f.store.appendAudit.bind(f.store); const p = f.intent();
  f.store.appendAudit = event => { if (event.action === 'integration.completed') throw Error('FICTITIOUS_AUDIT_FAILURE'); return append(event); };
  await assert.rejects(f.execute(contract.REVOKE_OPERATION, p, {}, f.broker, 'control'), { code: 'provider_failed' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_ads_enrollments').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_ads_enrollment_cancellations').get().n, 0);
  f.store.appendAudit = append;
});
test('cancelling an unverified candidate does not reserve or revoke that customer for another authorized clinic', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); await f.execute(contract.REVOKE_OPERATION, p, {}, f.broker, 'control');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_ads_enrollments').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations').get().n, 0);
  assert.equal((await f.execute('discover', { pageToken: null })).data.accounts.length, 0);
  const policy = structuredClone(f.policy); const s = { ...policy.connections[0].googleAdsEnrollmentScopes[0], assetRef: 'ads-enroll:clinic:999', tenantRef: 'clinic:999' };
  policy.connections[0].googleAdsEnrollmentScopes.push(s);
  for (const grant of policy.grants.filter(g => g.assetRef === SCOPE)) policy.grants.push({ ...grant, assetRef: s.assetRef, tenantRef: s.tenantRef });
  validateConfig({ ...f.config, policy }); const other = f.make(f.store, policy);
  const q = { ...f.intent(), clinicCount: 1 };
  assert.equal((await f.execute('prepare', q, { assetRef: s.assetRef, tenantRef: s.tenantRef }, other.broker)).data.state, 'prepared');
  await assert.rejects(f.execute('prepare', f.intent()), { code: 'asset_revoked' });
});
test('scope removal and delegated operation restrictions deny dynamic access; unrelated policy versions preserve ownership', async t => {
  const f = enrollmentFixture(t); const policy = structuredClone(f.policy);
  policy.connections[0].googleAdsEnrollmentScopes[0].readOperations = ['google.ads.discovery.read.v1'];
  const limited = f.make(f.store, policy); const p = f.intent();
  await f.execute('prepare', p, {}, limited.broker); await f.execute('activate', p, {}, limited.broker);
  await assert.rejects(f.read('account', NEW, limited.broker), { code: 'scope_denied' });
  policy.version = 'qa-unrelated-v2'; const changed = f.make(f.store, policy);
  f.state.response = { results: [{ customer: { id: NEW, currencyCode: 'EUR', timeZone: 'Europe/Madrid', status: 'SUSPENDED' } }] };
  assert.equal((await f.read('discovery', NEW, changed.broker)).data.results[0].customer.id, NEW);
  delete policy.connections[0].googleAdsEnrollmentScopes; const removed = f.make(f.store, policy);
  await assert.rejects(f.read('discovery', NEW, removed.broker), { code: 'scope_denied' });
});
test('actual HTTPS runtime enrolls from an empty account registry, activates typed reads and persists revoke/status across restart', async t => {
  const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net');
  const { execFileSync } = require('node:child_process'); const runtime = require('../src/google-main');
  const { allowPort, removePort } = require('./offline-guard.cjs');
  const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
  const { drainAudit } = require('../src/audit'); const f = enrollmentFixture(t);
  assert.equal(require.cache[require.resolve('../../../models')], undefined, 'clinical model index must remain unloaded');
  const cert = path.join(f.dir, 'enroll.crt'); const key = path.join(f.dir, 'enroll.key'); const cursorKey = path.join(f.dir, 'enroll.cursor');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  for (const file of [cert, key]) fs.chmodSync(file, 0o600); fs.writeFileSync(cursorKey, randomBytes(32), { mode: 0o600 });
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const policy = structuredClone(f.policy); delete policy.connections[0].googleAdsAccounts;
  policy.grants = policy.grants.filter(g => g.assetRef === SCOPE);
  const config = { ...f.config, policy, port, stateFile: path.join(f.dir, 'enroll.sqlite'), tlsCertFile: cert, tlsKeyFile: key, cursorKeyFile: cursorKey };
  const file = path.join(f.dir, 'enroll.json'); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const events = []; const sink = { write: async value => {
    events.push(JSON.parse(value.event)); return { versionId: 'fictitious-s3-version', digest: value.digest };
  } };
  const deps = { awsFactory: async () => ({ secrets: f.sdk, sink, close() {} }), http: f.http };
  let app = await runtime.main(file, deps); allowPort(port);
  t.after(async () => { if (app) await app.close(); removePort(port); });
  const client = (keyId, privateKey) => createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${port}`,
    audience: policy.audience, keyId, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(cert) });
  const enrollment = client('enroll-key', f.enrollmentKeys.privateKey);
  const reader = client('qa-key', f.keys.privateKey); const control = client('control-key', f.control.privateKey);
  const command = (operation, payload, assetRef = SCOPE, requestId = randomUUID()) => ({ requestId, operation,
    connectionRef: f.binding.connectionRef, tenantRef: 'clinic:123', assetRef, payload });
  const p = f.intent(); const preparation = command(contract.OPERATIONS.prepare, p);
  assert.equal((await enrollment.execute(command(contract.OPERATIONS.discover, { pageToken: null }))).data.accounts[0].id, NEW);
  await enrollment.execute(preparation); const providerCalls = f.state.calls.length;
  assert.equal((await enrollment.execute(preparation)).replayed, true); assert.equal(f.state.calls.length, providerCalls);
  await assert.rejects(reader.execute(command('google.ads.account.read.v1', {}, 'ads:' + NEW)), { code: 'scope_denied' });
  await enrollment.execute(command(contract.OPERATIONS.activate, p));
  f.state.response = { results: [{ customer: { id: NEW, currencyCode: 'EUR', timeZone: 'Europe/Madrid' } }] };
  assert.equal((await reader.execute(command('google.ads.account.read.v1', {}, 'ads:' + NEW))).data.results[0].customer.id, NEW);
  await control.execute(command(ads.REVOKE_OPERATION, {}, 'ads:' + NEW));
  await app.close(); app = null; app = await runtime.main(file, deps);
  const before = f.state.sdk.length;
  const status = await enrollment.execute(command(contract.OPERATIONS.status, { enrollmentId: p.enrollmentId }));
  assert.equal(status.data.state, 'revoked'); assert.equal(f.state.sdk.length, before);
  await assert.rejects(reader.execute(command('google.ads.account.read.v1', {}, 'ads:' + NEW)), { code: 'asset_revoked' });
  await assert.rejects(enrollment.execute(preparation), { code: 'asset_revoked' });
  await drainAudit(app.store, sink, { limit: 100 });
  assert.ok(events.some(e => e.operation === contract.OPERATIONS.prepare && e.action === 'integration.completed'));
  const durable = JSON.stringify(events) + JSON.stringify(app.store.db.prepare('SELECT * FROM commands').all())
    + JSON.stringify(app.store.db.prepare('SELECT * FROM google_ads_enrollments').all());
  assert.doesNotMatch(durable, /FICTITIOUS_ACCOUNT|FICTITIOUS_ADS|FICTITIOUS_REFRESH|FICTITIOUS_CLIENT_SECRET/);
  assert.equal(require.cache[require.resolve('../../../models')], undefined);
});

'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { adsFixture, ASSET, CUSTOMER, ACCESS } = require('./google-ads-fixture.cjs');
const A = require('../src/google-action-management-contract'), C = require('../src/google-destination-contract');
const D = require('../src/google-data-manager-contract');
const { createGoogleActionManagement } = require('../src/google-action-management');
const { createGoogleDestinations } = require('../src/google-destinations');
const { createDataManagerOperations } = require('../src/google-data-manager');
const { Broker } = require('../src/broker'), { BrokerStore } = require('../src/store');
const { signRequest } = require('../src/auth'), { fail } = require('../src/errors');
const { validateConfig } = require('../src/google-main');
const { validatePolicy } = require('../src/policy');
const input = planId => ({ planId, targets: [{ event: 'lead', sources: ['WEB'] }] });
const selection = () => ({ conversionActionId: '456', eventName: 'lead', eventSource: 'WEB' });
const event = () => ({ ...selection(), event: { timestamp: '2026-09-18T10:00:00.000Z', transactionId: 'FICTITIOUS-EVENT',
  value: 1, currency: 'EUR', advertisingConsent: 'GRANTED', adUserData: null, adPersonalization: null,
  clickId: { type: 'gclid', value: 'FICTITIOUS-CLICK' }, userIdentifiers: [], enhancedPolicyDigest: null } });
function setup(t) {
  const f = adsFixture(t);
  f.binding.googleDataManager = { quotaProjectId: 'fictitious-project', destinations: [] };
  f.binding.googleAdsActionManagement = { accounts: [{ assetRef: ASSET, events: A.EVENTS, currencies: ['EUR'], allowCreate: true, allowNormalize: true }] };
  f.binding.googleDataManagerEnrollment = { accounts: [{ assetRef: ASSET, events: ['lead', 'schedule'], sources: ['WEB', 'OTHER'] }] };
  f.policy.grants[0].operations = [...f.policy.grants[0].operations, ...Object.values(A.OPERATIONS), ...Object.values(C.OPERATIONS), ...Object.values(D.OPERATIONS)];
  const state = { at: Date.now(), rows: [], writes: 0, googleCalls: 0, dmCalls: 0, secretReads: 0, nextId: 456 };
  const http = async request => {
    if (request.hostname === 'datamanager.googleapis.com') {
      state.dmCalls++; await state.onDataManager?.();
      if (request.path.startsWith('/v1/requestStatus:retrieve')) return { requestStatusPerDestination: [] };
      return request.json.validateOnly ? {} : { requestId: 'fictitious-' + state.dmCalls };
    }
    state.googleCalls++;
    if (request.path.endsWith('/googleAds:search')) return { results: structuredClone(state.rows) };
    if (request.json.validateOnly) return {};
    state.writes++;
    const results = request.json.operations.map(operation => {
      assert(operation.create); const id = String(state.nextId++);
      const action = { ...operation.create, id, resourceName: `customers/${CUSTOMER}/conversionActions/${id}`,
        ownerCustomer: 'customers/' + CUSTOMER, includeInConversionsMetric: false };
      state.rows.push({ customer: { id: CUSTOMER }, conversionAction: action }); return { resourceName: action.resourceName };
    });
    await state.afterWrite?.(); return { results };
  };
  const secrets = { async withSecret(binding, work) { state.secretReads++; await state.onSecret?.(); return work(Buffer.from(ACCESS)); }, invalidate() {} };
  let store = f.store, broker;
  const make = () => {
    const actionManagement = createGoogleActionManagement({ store, http, withDeveloperSecret: (binding, work) => work(Buffer.from('FICTITIOUS_DEVELOPER')), now: () => state.at });
    const destinations = createGoogleDestinations({ store, actionManagement, now: () => state.at });
    return new Broker({ store, policy: f.policy, secrets, now: () => state.at,
      operations: { ...actionManagement.operations, ...destinations.operations, ...createDataManagerOperations({ store, http, destinations, now: () => state.at }).operations } });
  };
  broker = make();
  const command = (operation, payload, patch = {}) => f.command('account', {}, { operation, payload, ...patch });
  const execute = (request, signing = {}) => { const signed = signRequest(request, { keyId: 'qa-key', privateKey: f.keys.privateKey,
    audience: f.policy.audience, now: state.at, ...signing }); return broker.execute(signed.raw, signed.headers); };
  const invoke = async (operation, payload, patch, signing) => (await execute(command(operation, payload, patch), signing)).data;
  const prepare = async (events = ['lead']) => invoke(A.OPERATIONS.prepare, { mode: 'create', currency: 'EUR', targets: events.map(event => ({ event, actionId: null })) });
  const apply = plan => invoke(A.OPERATIONS.apply, { planId: plan.planId });
  return { ...f, state, providerHttp: http, command, execute, invoke, prepare, apply, getStore: () => store, getBroker: () => broker,
    reset() { broker = make(); },
    reopen() { store.close(); store = new BrokerStore(f.filename); broker = make(); t.after(() => { try { store.close(); } catch {} }); },
    async authorize() { const p = await prepare(); await apply(p); return invoke(C.OPERATIONS.authorize, input(p.planId)); } };
}

test('preparation, validate-only, applied receipt and status never authorize a destination implicitly', async t => {
  const f = setup(t), p = await f.prepare();
  await f.invoke(A.OPERATIONS.validate, { planId: p.planId });
  await assert.rejects(f.invoke(C.OPERATIONS.authorize, input(p.planId)), { code: 'action_plan_conflict' });
  await assert.rejects(f.invoke(D.OPERATIONS.validate, selection()), { code: 'scope_denied' });
  await f.apply(p); await f.invoke(A.OPERATIONS.status, { planId: p.planId });
  const before = f.state.secretReads;
  await assert.rejects(f.invoke(D.OPERATIONS.ingest, event()), { code: 'scope_denied' });
  assert.equal(f.state.secretReads, before); assert.equal(f.state.dmCalls, 0);
  const request = f.command(C.OPERATIONS.authorize, input(p.planId)), calls = f.state.googleCalls;
  const result = await f.execute(request);
  assert.deepEqual(result.data, { authorizationId: request.requestId, planId: p.planId, state: 'active',
    destinations: [{ event: 'lead', conversionActionId: '456', sources: ['WEB'] }] });
  assert.equal(f.state.googleCalls, calls); assert.equal(f.state.dmCalls, 0);
  assert.equal((await f.execute(request)).replayed, true);
  assert.deepEqual(await f.invoke(D.OPERATIONS.validate, selection()), { validated: true, warningCount: 0 });
  assert.equal(f.state.dmCalls, 1);
  const sent = await f.invoke(D.OPERATIONS.ingest, event()); assert.equal(sent.accepted, true);
  f.reopen(); assert.equal((await f.invoke(C.OPERATIONS.status, { authorizationId: request.requestId })).state, 'active');
  assert.equal((await f.invoke(D.OPERATIONS.status, { submissionId: sent.submissionId })).submissionId, sent.submissionId);
  assert.equal(f.getStore().db.prepare('SELECT COUNT(*) n FROM google_destination_authorizations').get().n, 1);
  const persisted = JSON.stringify(['commands', 'audit_outbox', 'google_destination_authorizations', 'google_destination_targets']
    .map(table => f.getStore().db.prepare('SELECT * FROM ' + table).all()));
  for (const sentinel of [ACCESS, 'FICTITIOUS-CLICK', 'FICTITIOUS-EVENT', 'FICTITIOUS_DEVELOPER']) assert(!persisted.includes(sentinel));
  assert(persisted.includes('conversion_destinations_authorized'));
});

test('unknown Google apply cannot authorize even if the provider action is now visible', async t => {
  const f = setup(t), p = await f.prepare(); f.state.afterWrite = () => fail('provider_timeout');
  await assert.rejects(f.apply(p), { code: 'provider_timeout' }); f.reopen();
  await assert.rejects(f.invoke(C.OPERATIONS.authorize, input(p.planId)), { code: 'outcome_unknown' });
  assert.equal(f.state.dmCalls, 0); assert.equal(f.state.rows.length, 1);
});

test('mixed created and unchanged actions derive IDs only from the original applied receipt', async t => {
  const f = setup(t), first = await f.prepare(); await f.apply(first);
  const p = await f.prepare(['lead', 'schedule']); await f.apply(p);
  const result = await f.invoke(C.OPERATIONS.authorize, { planId: p.planId,
    targets: [{ event: 'lead', sources: ['WEB', 'OTHER'] }, { event: 'schedule', sources: ['OTHER'] }] });
  assert.deepEqual(result.destinations, [{ event: 'lead', conversionActionId: '456', sources: ['WEB', 'OTHER'] },
    { event: 'schedule', conversionActionId: '457', sources: ['OTHER'] }]);
  for (const payload of [{ conversionActionId: '457', eventName: 'lead', eventSource: 'WEB' },
    { conversionActionId: '457', eventName: 'schedule', eventSource: 'WEB' }]) {
    await assert.rejects(f.invoke(D.OPERATIONS.validate, payload), { code: 'scope_denied' });
  }
});

test('hostile IDs, free data, unselected events and excess policy sources fail before secrets', async t => {
  const f = setup(t), p = await f.prepare(); await f.apply(p);
  const before = f.state.secretReads;
  for (const payload of [{ ...input(p.planId), token: ACCESS }, { ...input(p.planId), conversionActionId: '999' },
    { ...input(p.planId), targets: [{ event: 'lead', sources: ['WEB'], actionId: '999' }] },
    { ...input(p.planId), targets: [{ event: 'lead', sources: ['WEB', 'WEB'] }] },
    { ...input(p.planId), targets: [{ event: 'lead', sources: ['ANY'] }] },
    { ...input(p.planId), targets: [{ event: 'lead', sources: ['WEB'] }, { event: 'lead', sources: ['OTHER'] }] },
    { ...input(p.planId), targets: [{ event: 'schedule', sources: ['WEB'] }] },
    { ...input(p.planId), targets: [{ event: 'purchase', sources: ['WEB'] }] }]) {
    await assert.rejects(f.invoke(C.OPERATIONS.authorize, payload), error => ['invalid_request', 'scope_denied'].includes(error.code));
  }
  f.binding.googleDataManagerEnrollment.accounts[0].sources = ['OTHER']; f.reset();
  await assert.rejects(f.invoke(C.OPERATIONS.authorize, input(p.planId)), { code: 'scope_denied' });
  assert.equal(f.state.secretReads, before);
});

test('dynamic grant never permits enhanced identifiers and stays exact to event and source', async t => {
  const f = setup(t); await f.authorize(); const before = f.state.secretReads;
  const enhanced = event(); Object.assign(enhanced.event, { userIdentifiers: [{ type: 'email', sha256: 'a'.repeat(64) }],
    enhancedPolicyDigest: 'b'.repeat(64), adUserData: 'GRANTED', adPersonalization: 'DENIED' });
  for (const payload of [enhanced, { ...event(), conversionActionId: '457' }, { ...event(), eventName: 'schedule' }, { ...event(), eventSource: 'OTHER' }]) {
    await assert.rejects(f.invoke(D.OPERATIONS.ingest, payload), { code: 'scope_denied' });
  }
  assert.equal(f.state.secretReads, before); assert.equal(f.state.dmCalls, 0);
});

test('separate grants on the same asset retain the exact authorized operation in every audit receipt', async t => {
  const f = setup(t), destinationOperations = Object.values(C.OPERATIONS);
  f.policy.grants[0].operations = f.policy.grants[0].operations.filter(op => !destinationOperations.includes(op));
  f.policy.grants.push({ ...f.policy.grants[0], operations: destinationOperations }); f.reset();
  const authorized = await f.authorize();
  await f.invoke(C.OPERATIONS.status, { authorizationId: authorized.authorizationId });
  await f.invoke(C.OPERATIONS.revoke, { authorizationId: authorized.authorizationId });
  const events = f.store.db.prepare('SELECT event FROM audit_outbox').all().map(row => JSON.parse(row.event));
  for (const [family, suffix] of [['authorize', 'authorized'], ['status', 'observed'], ['revoke', 'revoked']]) {
    const event = events.find(row => row.reason === 'conversion_destinations_' + suffix);
    assert.equal(event?.operation, C.OPERATIONS[family]); assert.equal(event?.connectionRef, f.binding.connectionRef);
  }
});

test('foreign principal, tenant, signing key, account and connection cannot inherit grants or receipts', async t => {
  for (const mode of ['principal', 'tenant', 'key', 'account', 'connection']) {
    const f = setup(t), granted = await f.authorize(), keys = generateKeyPairSync('ed25519');
    let patch = {}, signing = {};
    if (mode === 'principal') {
      f.policy.principals.push({ ...f.policy.principals[0], id: 'api:other', keyId: 'other-key', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) });
      f.policy.grants.push({ ...f.policy.grants[0], principalId: 'api:other' }); signing = { privateKey: keys.privateKey, keyId: 'other-key' };
    } else if (mode === 'key') {
      f.policy.principals[0].publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }); signing = { privateKey: keys.privateKey };
    } else {
      patch = mode === 'tenant' ? { tenantRef: 'clinic:999' } : mode === 'account' ? { assetRef: 'ads:9999999999' } : { connectionRef: 'connection:other' };
      if (mode === 'connection') f.policy.connections.push({ ...f.binding, connectionRef: patch.connectionRef });
      f.policy.grants.push({ ...f.policy.grants[0], ...patch });
    }
    f.reset(); const before = f.state.secretReads;
    await assert.rejects(f.invoke(C.OPERATIONS.status, { authorizationId: granted.authorizationId }, patch, signing), { code: 'scope_denied' });
    await assert.rejects(f.invoke(C.OPERATIONS.revoke, { authorizationId: granted.authorizationId }, patch, signing), { code: 'scope_denied' });
    await assert.rejects(f.invoke(D.OPERATIONS.ingest, event(), patch, signing), { code: 'scope_denied' });
    assert.equal(f.state.secretReads, before);
  }
});

test('binding, manager, identity and explicit policy changes invalidate a durable grant', async t => {
  for (const mutate of [b => { b.googleSubject = 'other-subject'; }, b => { b.secretArn += 'changed'; },
    b => { b.clientSecretArn += 'changed'; }, b => { b.developerSecretArn += 'changed'; },
    b => { b.googleAdsAccounts[0].loginCustomerId = '1111111111'; }, b => { b.googleDataManager.quotaProjectId = 'other-project'; },
    b => { b.googleDataManagerEnrollment.accounts[0].events = ['lead']; }]) {
    const f = setup(t), grant = await f.authorize(); mutate(f.binding); f.reset();
    await assert.rejects(f.invoke(D.OPERATIONS.ingest, event()), { code: 'scope_denied' });
    await assert.rejects(f.invoke(C.OPERATIONS.status, { authorizationId: grant.authorizationId }), { code: 'scope_denied' });
    assert.equal(f.state.dmCalls, 0);
  }
});

test('revocation survives restart, denies replay and new UUID adoption of the same plan', async t => {
  const f = setup(t), p = await f.prepare(); await f.apply(p);
  const request = f.command(C.OPERATIONS.authorize, input(p.planId)); await f.execute(request);
  const revoke = f.command(C.OPERATIONS.revoke, { authorizationId: request.requestId });
  assert.equal((await f.execute(revoke)).data.state, 'revoked'); assert.equal((await f.execute(revoke)).replayed, true);
  f.reopen(); assert.equal((await f.invoke(C.OPERATIONS.status, { authorizationId: request.requestId })).state, 'revoked');
  await assert.rejects(f.execute(request), { code: 'idempotency_conflict' });
  await assert.rejects(f.invoke(C.OPERATIONS.authorize, input(p.planId)), { code: 'idempotency_conflict' });
  await assert.rejects(f.invoke(D.OPERATIONS.validate, selection()), { code: 'scope_denied' });
  assert.equal(f.state.dmCalls, 0);
});

test('overlap with another active authorization or a static grant cannot hide revocation', async t => {
  const f = setup(t), first = await f.authorize(), next = await f.prepare(); await f.apply(next);
  await assert.rejects(f.invoke(C.OPERATIONS.authorize, input(next.planId)), { code: 'idempotency_conflict' });
  await f.invoke(C.OPERATIONS.revoke, { authorizationId: first.authorizationId });
  f.binding.googleDataManager.destinations.push({ assetRef: ASSET, ...{ conversionActionId: '456', events: ['lead'], sources: ['WEB'], enhancedPolicy: null } }); f.reset();
  await assert.rejects(f.invoke(C.OPERATIONS.authorize, input(next.planId)), { code: 'idempotency_conflict' });
  // Removing a separately configured static policy does not resurrect a tombstone.
  f.binding.googleDataManager.destinations = []; f.reset();
  await assert.rejects(f.invoke(D.OPERATIONS.ingest, event()), { code: 'scope_denied' });
  const fresh = await f.invoke(C.OPERATIONS.authorize, input(next.planId)); assert.equal(fresh.state, 'active');
});

test('commit and audit failure leave no partial authorization; retries cannot conceal an uncertain command', async t => {
  const f = setup(t), p = await f.prepare(); await f.apply(p);
  const request = f.command(C.OPERATIONS.authorize, input(p.planId));
  const append = f.store.appendAudit.bind(f.store);
  f.store.appendAudit = value => { if (value.reason === 'conversion_destinations_authorized') fail('audit_unavailable'); return append(value); };
  await assert.rejects(f.execute(request), { code: 'audit_unavailable' }); f.store.appendAudit = append;
  for (const table of ['google_destination_authorizations', 'google_destination_targets']) assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM ' + table).get().n, 0);
  await assert.rejects(f.execute(request), { code: 'outcome_unknown' });
  await assert.rejects(f.invoke(D.OPERATIONS.ingest, event()), { code: 'scope_denied' });
});

test('revocation during provider delivery keeps attempted uncertainty and never acknowledges or retransmits', async t => {
  const f = setup(t), grant = await f.authorize(), request = f.command(D.OPERATIONS.ingest, event());
  f.state.onDataManager = async () => { f.state.onDataManager = null; await f.invoke(C.OPERATIONS.revoke, { authorizationId: grant.authorizationId }); };
  await assert.rejects(f.execute(request), { code: 'scope_denied' });
  assert.equal(f.store.db.prepare('SELECT state FROM google_data_manager_receipts WHERE id=?').get(request.requestId).state, 'attempted');
  await assert.rejects(f.execute(request), { code: 'scope_denied' }); assert.equal(f.state.dmCalls, 1);
});

test('late status response rechecks revocation inside the final SQLite transaction', async t => {
  const f = setup(t), grant = await f.authorize(), original = f.store.complete.bind(f.store);
  f.store.complete = (principal, id, result, audit, options) => {
    if (audit.reason === 'conversion_destinations_observed') {
      f.store.db.prepare("UPDATE google_destination_authorizations SET state='revoked' WHERE id=?").run(grant.authorizationId);
      f.store.db.prepare("UPDATE google_destination_targets SET state='revoked' WHERE authorization_id=?").run(grant.authorizationId);
    }
    return original(principal, id, result, audit, options);
  };
  await assert.rejects(f.invoke(C.OPERATIONS.status, { authorizationId: grant.authorizationId }), { code: 'scope_denied' });
});

test('concurrent authorization of the same plan commits once and rejects the late competing UUID', async t => {
  const f = setup(t), p = await f.prepare(); await f.apply(p);
  let winner;
  f.state.onSecret = async () => { f.state.onSecret = null; winner = await f.invoke(C.OPERATIONS.authorize, input(p.planId)); };
  await assert.rejects(f.invoke(C.OPERATIONS.authorize, input(p.planId)), { code: 'idempotency_conflict' });
  assert.equal((await f.invoke(C.OPERATIONS.status, { authorizationId: winner.authorizationId })).state, 'active');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM google_destination_authorizations').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM google_destination_targets').get().n, 1);
});

test('lost authorization response recovers the exact receipt after restart without changing permissions', async t => {
  const f = setup(t), p = await f.prepare(); await f.apply(p);
  const request = f.command(C.OPERATIONS.authorize, input(p.planId));
  await f.execute(request); // Receipt committed, HTTP response discarded by the caller.
  f.reopen(); const calls = f.state.googleCalls, secretReads = f.state.secretReads;
  const recovered = await f.execute(request); assert.equal(recovered.replayed, true);
  assert.equal(recovered.data.authorizationId, request.requestId); assert.equal(f.state.secretReads, secretReads);
  assert.equal(f.state.googleCalls, calls); assert.equal(f.state.dmCalls, 0);
  await assert.rejects(f.execute({ ...request, payload: { ...input(p.planId), targets: [{ event: 'lead', sources: ['OTHER'] }] } }), { code: 'idempotency_conflict' });
});

test('revocation is atomic with its audit; a failed receipt never claims success', async t => {
  const f = setup(t), grant = await f.authorize(), append = f.store.appendAudit.bind(f.store);
  f.store.appendAudit = value => { if (value.reason === 'conversion_destinations_revoked') fail('audit_unavailable'); return append(value); };
  const request = f.command(C.OPERATIONS.revoke, { authorizationId: grant.authorizationId });
  await assert.rejects(f.execute(request), { code: 'audit_unavailable' }); f.store.appendAudit = append;
  assert.equal(f.store.db.prepare('SELECT state FROM google_destination_authorizations WHERE id=?').get(grant.authorizationId).state, 'active');
  assert.equal(f.store.db.prepare('SELECT state FROM google_destination_targets WHERE authorization_id=?').get(grant.authorizationId).state, 'active');
  await assert.rejects(f.execute(request), { code: 'outcome_unknown' });
});

test('revocation before secret callback prevents a provider call and active lookup uses its index', async t => {
  const f = setup(t), grant = await f.authorize();
  f.state.onSecret = async () => { f.state.onSecret = null; await f.invoke(C.OPERATIONS.revoke, { authorizationId: grant.authorizationId }); };
  await assert.rejects(f.invoke(D.OPERATIONS.ingest, event()), { code: 'scope_denied' }); assert.equal(f.state.dmCalls, 0);
  const rows = f.store.db.prepare("EXPLAIN QUERY PLAN SELECT authorization_id FROM google_destination_targets WHERE principal=? AND tenant=? AND connection=? AND asset=? AND action_id=? AND event_name=? AND event_source=? AND state='active'")
    .all('api:test', 'clinic:123', 'connection:test', ASSET, '456', 'lead', 'WEB');
  assert(rows.some(row => row.detail.includes('google_destination_active_target'))); assert(!rows.some(row => /SCAN google_destination_targets/.test(row.detail)));
});

test('configuration requires explicit destination policy and keeps reader, OAuth and enrollment key separation', t => {
  const f = setup(t), config = { cohort: D.COHORT, enabled: true, listenAddress: '127.0.0.1', port: 8998,
    cursorKeyFile: '/qa/cursor', tlsCertFile: '/qa/cert', tlsKeyFile: '/qa/key', stateFile: '/qa/state', policy: f.policy };
  validateConfig(config);
  assert.throws(() => validateConfig({ ...config, cohort: 'google-ads-read-v1' }), { code: 'invalid_request' });
  for (const mutate of [p => { delete p.connections[0].googleDataManagerEnrollment; },
    p => { delete p.connections[0].googleAdsActionManagement; },
    p => { p.connections[0].googleDataManagerEnrollment.accounts[0].events = ['arbitrary']; },
    p => { p.connections[0].googleDataManagerEnrollment.accounts.push(p.connections[0].googleDataManagerEnrollment.accounts[0]); },
    p => { p.grants[1].operations.push(C.OPERATIONS.authorize); }]) {
    const policy = structuredClone(f.policy); mutate(policy);
    assert.throws(() => validateConfig({ ...config, policy }), { code: 'invalid_request' });
  }
  const empty = structuredClone(f.policy); delete empty.connections[0].googleDataManagerEnrollment;
  assert.throws(() => validatePolicy(empty), { code: 'invalid_request' });
  const enrollment = require('../src/google-ads-enrollment-contract');
  const oauth = require('../src/google-oauth-contract');
  for (const controlOperation of [require('../src/google-ads-contract').REVOKE_OPERATION,
    enrollment.OPERATIONS.prepare, oauth.operationsFor('google_ads').begin]) {
    const policy = structuredClone(f.policy); policy.grants[0].operations = [C.OPERATIONS.authorize];
    policy.grants[1].operations = [controlOperation];
    policy.principals[1].publicKey = policy.principals[0].publicKey;
    assert.throws(() => enrollment.validatePolicy(policy), { code: 'invalid_request' });
  }
});

test('real HTTPS runtime and CRM scope/client authorize, validate, ingest and revoke across restart with fictitious providers', async t => {
  const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
  const { randomBytes } = require('node:crypto'), { execFileSync } = require('node:child_process');
  const { allowPort, removePort } = require('./offline-guard.cjs');
  const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
  const { createGoogleAdsBroker } = require('../../../src/services/googleAdsBroker.service');
  const { scopeFixture } = require('../../../src/scripts/tests/fixtures/google_ads_broker_scope.fixture');
  const runtime = require('../src/google-main'), f = setup(t), crm = scopeFixture();
  crm.binding.connection_ref = f.binding.connectionRef; crm.mapping.broker_read_connection_ref = f.binding.connectionRef;
  f.policy.grants.forEach(grant => { grant.tenantRef = 'clinic:59'; });
  const cert = path.join(f.dir, 'tls.crt'), key = path.join(f.dir, 'tls.key'), cursor = path.join(f.dir, 'cursor');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  [cert, key].forEach(file => fs.chmodSync(file, 0o600)); fs.writeFileSync(cursor, randomBytes(32), { mode: 0o600 });
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const config = { enabled: true, cohort: D.COHORT, policy: f.policy, listenAddress: '127.0.0.1', port,
    stateFile: path.join(f.dir, 'runtime.sqlite'), cursorKeyFile: cursor, tlsKeyFile: key, tlsCertFile: cert };
  const filename = path.join(f.dir, 'config.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const delivered = [];
  const dependencies = { http: async request => {
    if (request.hostname === 'oauth2.googleapis.com') { const value = await f.http(request); value.scope += ' ' + D.SCOPES[0]; return value; }
    return f.providerHttp(request);
  }, awsFactory: async () => ({ secrets: { async send(command) {
    const result = await f.sdk.send(command);
    if (command.input.SecretId === f.binding.secretArn && result.SecretString) {
      const value = JSON.parse(result.SecretString); value.scopes.push(...D.SCOPES); result.SecretString = JSON.stringify(value);
    }
    return result;
  } }, sink: { write: async row => { delivered.push(JSON.parse(row.event)); return { versionId: 'fictitious-audit-version', digest: row.digest }; } }, close() {} }) };
  let app = await runtime.main(filename, dependencies); allowPort(port);
  t.after(async () => { if (app) await app.close(); removePort(port); });
  const client = createIntegrationsBrokerClient({ origin: 'https://127.0.0.1:' + port, audience: f.policy.audience,
    keyId: 'qa-key', privateKey: f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(cert) });
  const service = createGoogleAdsBroker({ ...crm.options, client, actionManagementEnabled: () => true,
    destinationsEnabled: () => true, conversionsEnabled: () => true });
  const context = await service.prepare(crm.mapping), options = () => ({ requestId: randomUUID(), beforeExecute: async () => true });
  const invoke = (method, family, payload, config = options()) => service[method](crm.mapping, context, family, payload, config);
  const p = await invoke('actionManagement', 'prepare', { mode: 'create', currency: 'EUR', targets: [{ event: 'lead', actionId: null }] });
  await invoke('actionManagement', 'apply', { planId: p.planId });
  await assert.rejects(invoke('conversion', 'validate', selection()), { code: 'scope_denied' });
  const authorizationOptions = options(), authorized = await invoke('destinations', 'authorize', input(p.planId), authorizationOptions);
  assert.equal(f.state.dmCalls, 0); assert.equal(f.state.writes, 1);
  assert.equal((await invoke('conversion', 'validate', selection())).validated, true);
  const sent = await invoke('conversion', 'ingest', event()); assert.equal(sent.accepted, true);
  await app.close(); app = null; app = await runtime.main(filename, dependencies);
  assert.deepEqual(await invoke('destinations', 'authorize', input(p.planId), authorizationOptions), authorized);
  const status = await invoke('conversion', 'status', { submissionId: sent.submissionId }, { ...options(), expectedActionId: '456' });
  assert.equal(status.requestId, sent.requestId);
  assert.equal((await invoke('destinations', 'revoke', { authorizationId: authorized.authorizationId })).state, 'revoked');
  await app.close(); app = null; app = await runtime.main(filename, dependencies);
  assert.equal((await invoke('destinations', 'status', { authorizationId: authorized.authorizationId })).state, 'revoked');
  await assert.rejects(invoke('conversion', 'ingest', event()), { code: 'scope_denied' });
  assert.equal(f.state.dmCalls, 3); assert.equal(f.state.writes, 1);
  assert(delivered.some(row => row.reason === 'conversion_destinations_authorized'));
  assert(delivered.some(row => row.reason === 'conversion_destinations_revoked'));
  assert.equal(require.cache[require.resolve('../../../models')], undefined);
});

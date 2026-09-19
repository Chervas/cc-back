'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { adsFixture, CUSTOMER, MANAGER, ASSET, ACCESS, DEVELOPER } = require('./google-ads-fixture.cjs');
const C = require('../src/google-action-management-contract');
const { createGoogleActionManagement } = require('../src/google-action-management');
const { createGoogleAdsDeveloperSecret } = require('../src/google-ads-developer-secret');
const { Broker } = require('../src/broker'), { BrokerStore } = require('../src/store');
const { signRequest } = require('../src/auth');
const { fail } = require('../src/errors');
const { randomUUID } = require('node:crypto');
const runtime = require('../src/google-main');
const create = (events = ['lead']) => ({ mode: 'create', currency: 'EUR', targets: events.map(event => ({ event, actionId: null })) });
const normalize = (event = 'lead', actionId = '456') => ({ mode: 'normalize', currency: null, targets: [{ event, actionId }] });
const action = (event = 'lead', id = '456', patch = {}) => ({ customer: { id: CUSTOMER }, conversionAction: {
  id, resourceName: `customers/${CUSTOMER}/conversionActions/${id}`, ownerCustomer: `customers/${CUSTOMER}`,
  name: C.CATALOG[event][0], category: C.CATALOG[event][1], type: 'UPLOAD_CLICKS', status: 'ENABLED',
  countingType: 'MANY_PER_CLICK', primaryForGoal: false, includeInConversionsMetric: false, ...patch } });
function setup(t) {
  const f = adsFixture(t);
  f.binding.googleDataManager = { quotaProjectId: 'fictitious-project', destinations: [{ assetRef: ASSET,
    conversionActionId: '456', events: ['lead'], sources: ['WEB'], enhancedPolicy: null }] };
  f.binding.googleAdsActionManagement = { accounts: [{ assetRef: ASSET, events: C.EVENTS,
    currencies: ['EUR'], allowCreate: true, allowNormalize: true }] };
  f.policy.grants[0].operations = [...f.policy.grants[0].operations, ...Object.values(C.OPERATIONS)];
  const state = { at: Date.now(), sdk: f.state.sdk, rows: [], reads: 0, validations: 0, writes: 0, calls: [], nextId: 456 };
  const http = async request => {
    if (request.hostname === 'oauth2.googleapis.com') return f.http(request);
    assert.equal(request.hostname, 'googleads.googleapis.com'); assert.equal(request.token.toString(), ACCESS);
    assert.equal(request.developerToken.toString(), DEVELOPER); assert.equal(request.loginCustomerId, MANAGER);
    state.calls.push({ path: request.path, json: structuredClone(request.json) });
    await state.before?.(request);
    if (request.path.endsWith('/googleAds:search')) {
      state.reads++; assert.match(request.json.query, /conversion_action.owner_customer/);
      assert.match(request.json.query, /FROM conversion_action LIMIT 5001$/);
      return state.inventoryResponse ? state.inventoryResponse(request) : { results: structuredClone(state.rows) };
    }
    assert.equal(request.path, `/v24/customers/${CUSTOMER}/conversionActions:mutate`);
    assert.equal(request.json.partialFailure, false); assert.equal(request.json.responseContentType, 'RESOURCE_NAME_ONLY');
    if (request.json.validateOnly) {
      state.validations++; await state.onValidation?.(); return state.validationResponse || {};
    }
    state.writes++;
    const results = request.json.operations.map(operation => {
      if (operation.create) {
        const event = C.EVENTS.find(key => C.CATALOG[key][0] === operation.create.name); assert(event);
        assert.deepEqual(operation.create, { name: C.CATALOG[event][0], category: C.CATALOG[event][1],
          type: 'UPLOAD_CLICKS', status: 'ENABLED', primaryForGoal: false, countingType: 'MANY_PER_CLICK',
          valueSettings: { defaultValue: 0, alwaysUseDefaultValue: false, defaultCurrencyCode: 'EUR' } });
        const row = action(event, String(state.nextId++)); state.rows.push(row); return { resourceName: row.conversionAction.resourceName };
      }
      assert.deepEqual(Object.keys(operation.update).sort(), ['countingType', 'primaryForGoal', 'resourceName']);
      assert.equal(operation.updateMask, 'counting_type,primary_for_goal');
      const row = state.rows.find(row => row.conversionAction.resourceName === operation.update.resourceName); assert(row);
      Object.assign(row.conversionAction, operation.update); return { resourceName: row.conversionAction.resourceName };
    });
    await state.afterWrite?.(); return state.mutationResponse || { results };
  };
  const withDeveloperSecret = createGoogleAdsDeveloperSecret({ client: f.sdk, accountId: runtime.ACCOUNT,
    prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtime.SECRET_KEY });
  let store = f.store, policy = f.policy;
  const make = () => new Broker({ store, policy, secrets: f.secrets, now: () => state.at,
    operations: { ...f.engine.operations, ...createGoogleActionManagement({ store, http, withDeveloperSecret, now: () => state.at }).operations } });
  let broker = make();
  const command = (family, payload, extra = {}) => f.command('account', {}, { operation: C.OPERATIONS[family], payload, ...extra });
  const execute = (value, signing = {}) => {
    const signed = signRequest(value, { keyId: 'qa-key', privateKey: f.keys.privateKey, audience: f.policy.audience, now: state.at, ...signing });
    return broker.execute(signed.raw, signed.headers);
  };
  return { ...f, state, http, command, execute, getStore: () => store, getBroker: () => broker,
    reset(next = policy) { policy = next; broker = make(); },
    reopen() { store.close(); store = new BrokerStore(f.filename); broker = make(); t.after(() => { try { store.close(); } catch {} }); },
    prepare: async input => (await execute(command('prepare', input))).data };
}

test('prepare and validate persist only canonical metadata; apply validates, checks drift and creates only missing secondary actions', async t => {
  const f = setup(t); f.state.rows = [action()]; f.state.nextId = 457;
  const p = await f.prepare(create(['lead', 'schedule']));
  assert.equal(p.state, 'prepared'); assert.equal(p.internal, undefined); assert.equal(f.state.writes, 0);
  assert.deepEqual(p.changes, [{ event: 'lead', actionId: '456', change: 'unchanged' }, { event: 'schedule', actionId: null, change: 'create' }]);
  assert.equal((await f.execute(f.command('validate', { planId: p.planId }))).data.validated, true);
  assert.equal(f.state.writes, 0);
  const request = f.command('apply', { planId: p.planId });
  const applied = await f.execute(request); assert.equal(applied.data.state, 'applied'); assert.equal(f.state.writes, 1);
  assert.deepEqual(applied.data.results, [{ event: 'schedule', actionId: '457', change: 'create' }]);
  const calls = f.state.calls.length;
  assert.equal((await f.execute(request)).replayed, true);
  assert.equal((await f.execute(f.command('apply', { planId: p.planId }))).data.state, 'applied');
  assert.equal((await f.execute(f.command('status', { planId: p.planId }))).data.state, 'applied');
  assert.equal(f.state.calls.length, calls);
  assert.equal(f.getStore().db.prepare('SELECT COUNT(*) n FROM google_action_locks').get().n, 0);
  const text = JSON.stringify(['google_action_plans', 'commands', 'audit_outbox'].map(table => f.getStore().db.prepare('SELECT * FROM ' + table).all()));
  assert(!text.includes(ACCESS)); assert(!text.includes(DEVELOPER)); assert(!text.includes('internal'));
  assert(text.includes('canonical_actions_applied'));
});

test('normalization changes exactly two approved fields and leaves unrelated actions and values intact', async t => {
  const f = setup(t); f.state.rows = [action('lead', '456', { primaryForGoal: true, countingType: 'ONE_PER_CLICK' }),
    action('purchase', '888', { name: 'CUSTOMER_OWN_ACTION' })];
  const other = structuredClone(f.state.rows[1]);
  const p = await f.prepare(normalize()); const result = await f.execute(f.command('apply', { planId: p.planId }));
  assert.equal(result.data.results[0].change, 'normalize'); assert.equal(f.state.writes, 1);
  assert.deepEqual(f.state.rows[1], other); assert.equal(f.state.rows[0].conversionAction.primaryForGoal, false);
  assert.equal(f.state.rows[0].conversionAction.countingType, 'MANY_PER_CLICK');
  const unchanged = await f.prepare(normalize()); await f.execute(f.command('apply', { planId: unchanged.planId }));
  assert.equal(f.state.writes, 1);
  assert(!JSON.stringify(f.getStore().db.prepare('SELECT * FROM google_action_plans').all()).includes('CUSTOMER_OWN_ACTION'));
});

for (const [name, patch] of [['foreign owner', { ownerCustomer: 'customers/9999999999' }], ['unknown owner', { ownerCustomer: null }],
  ['foreign resource', { resourceName: 'customers/9999999999/conversionActions/456' }], ['wrong type', { type: 'WEBPAGE' }],
  ['wrong category', { category: 'PURCHASE' }], ['unknown status', { status: 'UNKNOWN' }]]) {
  test('canonical plan refuses ' + name + ' without a mutation', async t => {
    const f = setup(t); f.state.rows = [action('lead', '456', patch)];
    await assert.rejects(f.prepare(normalize()), { code: 'action_plan_conflict' });
    assert.equal(f.state.validations, 0); assert.equal(f.state.writes, 0);
  });
}

test('foreign IDs, duplicate names and malformed or extra command fields cannot select arbitrary actions', async t => {
  const f = setup(t);
  for (const value of [{ ...create(), url: 'https://evil.invalid' }, { ...create(), operations: [] },
    { ...create(), targets: [{ event: 'lead', actionId: '456' }] }, { ...normalize(), currency: 'EUR' },
    { ...create(), targets: [{ event: 'lead', actionId: null }, { event: 'lead', actionId: null }] },
    { ...create(), currency: 'USD' }, { ...create(), mode: 'delete' }]) await assert.rejects(f.prepare(value));
  assert.equal(f.state.sdk.length, 0); assert.equal(f.state.calls.length, 0);
  f.state.rows = [action()]; await assert.rejects(f.prepare(normalize('lead', '999')), { code: 'action_plan_conflict' });
  f.state.rows.push(action('lead', '457'));
  await assert.rejects(f.prepare(create()), { code: 'action_plan_conflict' }); assert.equal(f.state.writes, 0);
});

test('lost mutation ACK remains durable across physical reopen and blocks fresh plans for the same account/event', async t => {
  const f = setup(t), p = await f.prepare(create());
  f.state.afterWrite = () => fail('provider_timeout');
  await assert.rejects(f.execute(f.command('apply', { planId: p.planId })), { code: 'provider_timeout' });
  assert.equal(f.state.writes, 1); f.reopen(); f.state.afterWrite = null;
  assert.equal((await f.execute(f.command('status', { planId: p.planId }))).data.state, 'attempted');
  await assert.rejects(f.execute(f.command('apply', { planId: p.planId })), { code: 'outcome_unknown' });
  // A visible action alone is not reconciliation of the unknown attempt. A new
  // no-op plan must not manufacture an applied receipt for the same event.
  const visible = await f.prepare(create());
  assert.equal(visible.changes[0].change, 'unchanged');
  await assert.rejects(f.execute(f.command('apply', { planId: visible.planId })), { code: 'action_plan_busy' });
  assert.equal((await f.execute(f.command('status', { planId: p.planId }))).data.state, 'attempted');
  // Simulate missing/unavailable provider visibility; it is never permission to retry.
  f.state.rows = [];
  const next = await f.prepare(create());
  await assert.rejects(f.execute(f.command('apply', { planId: next.planId })), { code: 'action_plan_busy' });
  f.state.at += 2 * C.TTL_MS;
  const later = await f.prepare(create());
  await assert.rejects(f.execute(f.command('apply', { planId: later.planId })), { code: 'action_plan_busy' });
  assert.equal(f.state.writes, 1);
});

test('completed apply and original receipt survive reopen and do not repeat a mutation after lost CRM acknowledgement', async t => {
  const f = setup(t), p = await f.prepare(create()); const request = f.command('apply', { planId: p.planId });
  const first = await f.execute(request); f.reopen();
  assert.deepEqual((await f.execute(request)).data, first.data);
  assert.equal((await f.execute(f.command('status', { planId: p.planId }))).data.results[0].actionId, '456');
  assert.equal(f.state.writes, 1);
});

test('parallel apply commands and independent plans cannot both mutate the same canonical action', async t => {
  const f = setup(t), p = await f.prepare(create()), q = await f.prepare(create());
  const results = await Promise.allSettled([p, p, q, q].map(plan => f.execute(f.command('apply', { planId: plan.planId }))));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(f.state.writes, 1);
  assert(results.filter(row => row.status === 'rejected').every(row => ['action_plan_busy', 'action_plan_conflict', 'outcome_unknown'].includes(row.reason.code)));
});

test('state changes during prevalidation stop apply; safe failures release reservations for a new reviewed plan', async t => {
  const f = setup(t), p = await f.prepare(create());
  f.state.onValidation = () => { f.state.rows.push(action()); };
  await assert.rejects(f.execute(f.command('apply', { planId: p.planId })), { code: 'action_plan_conflict' });
  assert.equal(f.state.writes, 0); assert.equal(f.getStore().db.prepare('SELECT COUNT(*) n FROM google_action_locks').get().n, 0);
  f.state.onValidation = null;
  const next = await f.prepare(create()); await f.execute(f.command('apply', { planId: next.planId })); assert.equal(f.state.writes, 0);
});

test('expired plans, changed binding/key and revoked assets cannot use a saved plan or cached result', async t => {
  const f = setup(t), p = await f.prepare(create());
  f.state.at += C.TTL_MS;
  await assert.rejects(f.execute(f.command('apply', { planId: p.planId })), { code: 'action_plan_expired' });
  const changed = structuredClone(f.policy); changed.connections[0].googleAdsActionManagement.accounts[0].currencies.push('USD'); f.reset(changed);
  await assert.rejects(f.execute(f.command('status', { planId: p.planId })), { code: 'scope_denied' });
  const newKeys = generateKeyPairSync('ed25519'), rotated = structuredClone(f.policy);
  rotated.principals[0].keyId = 'rotated-test'; rotated.principals[0].publicKey = newKeys.publicKey.export({ type: 'spki', format: 'pem' });
  f.reset(rotated);
  await assert.rejects(f.execute(f.command('status', { planId: p.planId }), { keyId: 'rotated-test', privateKey: newKeys.privateKey }), { code: 'scope_denied' });
  f.reset(f.policy); await f.revoke();
  await assert.rejects(f.execute(f.command('status', { planId: p.planId })), { code: 'asset_revoked' }); assert.equal(f.state.writes, 0);
});

test('invalid or partial provider replies do not turn attempted mutations into successful receipts', async t => {
  for (const response of [{ results: [] }, { partialFailureError: { message: 'PRIVATE' } },
    { results: [{ resourceName: 'customers/9999999999/conversionActions/456' }] }]) {
    const f = setup(t), p = await f.prepare(create()); f.state.mutationResponse = response;
    await assert.rejects(f.execute(f.command('apply', { planId: p.planId })), { code: 'provider_failed' });
    assert.equal((await f.execute(f.command('status', { planId: p.planId }))).data.state, 'attempted'); assert.equal(f.state.writes, 1);
    assert(!JSON.stringify(f.getStore().db.prepare('SELECT * FROM commands').all()).includes('PRIVATE'));
  }
});

test('completion-audit failure rolls back applied receipt and leaves the durable attempt locked', async t => {
  const f = setup(t), p = await f.prepare(create()), store = f.getStore(), original = store.appendAudit;
  store.appendAudit = function (event) { if (event.reason === 'canonical_actions_applied') throw Error('FICTITIOUS_AUDIT_FAILURE'); return original.call(this, event); };
  await assert.rejects(f.execute(f.command('apply', { planId: p.planId })), { code: 'provider_failed' });
  store.appendAudit = original;
  assert.equal(store.db.prepare('SELECT state FROM google_action_plans WHERE id=?').get(p.planId).state, 'attempted');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM google_action_locks').get().n, 1); assert.equal(f.state.writes, 1);
});

test('runtime requires explicit action bindings and grants and rejects them in read-only cohorts', t => {
  const f = setup(t);
  const config = { enabled: true, cohort: 'google-ads-conversions-v1', policy: f.policy, listenAddress: '127.0.0.1', port: 9443,
    stateFile: '/tmp/fictitious-state', cursorKeyFile: '/tmp/fictitious-cursor', tlsKeyFile: '/tmp/fictitious-key', tlsCertFile: '/tmp/fictitious-cert' };
  assert.equal(runtime.validateConfig(config), config);
  const missing = structuredClone(config); delete missing.policy.connections[0].googleAdsActionManagement;
  assert.throws(() => runtime.validateConfig(missing), { code: 'invalid_request' });
  const read = structuredClone(config); read.cohort = 'google-ads-read-v1'; delete read.policy.connections[0].googleDataManager;
  assert.throws(() => runtime.validateConfig(read), { code: 'invalid_request' });
  const oauthKey = structuredClone(config); oauthKey.policy.grants[1].operations = [...Object.values(C.OPERATIONS)];
  delete oauthKey.policy.connections[0].googleAdsActionManagement;
  assert.throws(() => runtime.validateConfig(oauthKey), { code: 'invalid_request' });
});

test('action-only or Data Manager-only keys cannot also authorize enrollment or revocation', t => {
  const f = setup(t), enrollment = require('../src/google-ads-enrollment-contract');
  for (const operations of [Object.values(C.OPERATIONS), Object.values(require('../src/google-data-manager-contract').OPERATIONS)]) {
    const policy = structuredClone(f.policy); policy.grants[0].operations = operations;
    policy.grants.push({ ...policy.grants[0], operations: [enrollment.OPERATIONS.status] });
    assert.throws(() => enrollment.validatePolicy(policy), { code: 'invalid_request' });
    policy.grants.pop(); policy.grants.push({ ...policy.grants[0], operations: [enrollment.REVOKE_OPERATION] });
    assert.throws(() => enrollment.validatePolicy(policy), { code: 'invalid_request' });
    // Renaming a principal while reusing the same Ed25519 key is still forbidden.
    policy.grants.pop(); policy.principals.push({ ...policy.principals[0], id: 'enrollment:alias', keyId: 'enrollment:alias-key' });
    policy.grants.push({ ...policy.grants[0], principalId: 'enrollment:alias', operations: [enrollment.OPERATIONS.status] });
    assert.throws(() => enrollment.validatePolicy(policy), { code: 'invalid_request' });
  }
});

test('incomplete or repeated inventory pages and duplicate IDs cannot prepare a mutation', async t => {
  const f = setup(t);
  f.state.inventoryResponse = () => ({ results: [action()], nextPageToken: 'repeated' });
  await assert.rejects(f.prepare(create()), { code: 'provider_failed' });
  f.state.inventoryResponse = () => ({ results: [], nextPageToken: 'empty' });
  await assert.rejects(f.prepare(create()), { code: 'provider_failed' });
  f.state.inventoryResponse = () => ({ results: [action(), action()] });
  await assert.rejects(f.prepare(create()), { code: 'provider_failed' });
  assert.equal(f.state.writes, 0); assert.equal(f.getStore().db.prepare('SELECT COUNT(*) n FROM google_action_plans').get().n, 0);
});

test('expiry or revocation during validation cannot cross the actual mutation boundary', async t => {
  for (const mode of ['expiry', 'revocation']) {
    const f = setup(t), p = await f.prepare(create());
    f.state.onValidation = async () => { if (mode === 'expiry') f.state.at += C.TTL_MS; else await f.revoke(); };
    await assert.rejects(f.execute(f.command('apply', { planId: p.planId })), { code: mode === 'expiry' ? 'action_plan_expired' : 'asset_revoked' });
    assert.equal(f.state.writes, 0);
    assert.equal(f.getStore().db.prepare('SELECT state FROM google_action_plans WHERE id=?').get(p.planId).state, 'prepared');
  }
});

test('a crashed preparation lock can expire, while an attempted lock is retained permanently', async t => {
  const f = setup(t), p = await f.prepare(create());
  f.getStore().db.prepare('INSERT INTO google_action_locks VALUES (?,?,?,?)').run(CUSTOMER, 'lead', p.planId, 'fictitious-interrupted-command');
  const q = await f.prepare(create());
  await assert.rejects(f.execute(f.command('apply', { planId: q.planId })), { code: 'action_plan_busy' });
  f.state.at += C.TTL_MS;
  const fresh = await f.prepare(create()); await f.execute(f.command('apply', { planId: fresh.planId }));
  assert.equal(f.state.writes, 1);
  await assert.rejects(f.execute(f.command('apply', { planId: p.planId })), { code: 'action_plan_expired' });
});

test('fixed Google mutation transport is opt-in and does not admit other mutations or unbounded responses', async () => {
  const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
  const { createGoogleHttp } = require('../src/google-http');
  const wire = (options = {}) => {
    const calls = [];
    const http = createGoogleHttp({ actionManagementEnabled: options.enabled !== false, request: (config, callback) => {
      const req = new EventEmitter(); req.destroy = () => {};
      req.end = body => {
        calls.push({ config, body });
        const res = new PassThrough(); res.statusCode = options.status || 200;
        res.headers = options.headers || { 'content-type': 'application/json' };
        callback(res); res.end(options.body || '{}');
      };
      return req;
    } });
    return { http, calls };
  };
  const input = { hostname: 'googleads.googleapis.com', path: `/v24/customers/${CUSTOMER}/conversionActions:mutate`,
    token: Buffer.from(ACCESS), developerToken: Buffer.from(DEVELOPER), loginCustomerId: MANAGER,
    json: { operations: [], partialFailure: false, validateOnly: true, responseContentType: 'RESOURCE_NAME_ONLY' } };
  const w = wire(); await w.http(input);
  assert.equal(w.calls[0].config.method, 'POST'); assert.equal(w.calls[0].config.rejectUnauthorized, true);
  assert.equal(w.calls[0].config.headers['developer-token'], DEVELOPER);
  assert.equal(w.calls[0].config.headers['login-customer-id'], MANAGER); assert.equal(w.calls[0].config.headers['x-goog-user-project'], undefined);
  await assert.rejects(wire({ enabled: false }).http(input), { code: 'invalid_request' });
  for (const patch of [{ path: `/v24/customers/${CUSTOMER}/campaigns:mutate` }, { path: input.path + '?extra=1' },
    { path: input.path.replace('/v24/', '/v25/') }, { hostname: 'evil.invalid' }, { developerToken: undefined }, { quotaProjectId: 'fictitious-project' }]) {
    await assert.rejects(w.http({ ...input, ...patch }), { code: 'invalid_request' });
  }
  assert.equal(w.calls.length, 1);
  for (const options of [{ status: 302 }, { body: 'invalid json' }, { headers: { 'content-type': 'text/html' } },
    { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }, { body: '{"x":"' + 'x'.repeat(131072) + '"}' }]) {
    await assert.rejects(wire(options).http(input), { code: 'provider_failed' });
  }
});

test('real HTTPS runtime prepares, applies and recovers after restart with fictitious AWS/Google only', async t => {
  const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
  const { randomBytes } = require('node:crypto'), { execFileSync } = require('node:child_process');
  const { allowPort, removePort } = require('./offline-guard.cjs');
  const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
  const f = setup(t), cert = path.join(f.dir, 'tls.crt'), key = path.join(f.dir, 'tls.key'), cursor = path.join(f.dir, 'cursor');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  [cert, key].forEach(file => fs.chmodSync(file, 0o600)); fs.writeFileSync(cursor, randomBytes(32), { mode: 0o600 });
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const config = { enabled: true, cohort: 'google-ads-conversions-v1', policy: f.policy, listenAddress: '127.0.0.1', port,
    stateFile: path.join(f.dir, 'runtime.sqlite'), cursorKeyFile: cursor, tlsKeyFile: key, tlsCertFile: cert };
  const filename = path.join(f.dir, 'config.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const delivered = [];
  const dependencies = { http: f.http, awsFactory: async () => ({ secrets: f.sdk, sink: { write: async event => {
    delivered.push(event); return { versionId: 'fictitious-audit-version', digest: event.digest }; } }, close() {} }) };
  let app = await runtime.main(filename, dependencies); allowPort(port);
  t.after(async () => { if (app) await app.close(); removePort(port); });
  const client = createIntegrationsBrokerClient({ origin: 'https://127.0.0.1:' + port, audience: f.policy.audience,
    keyId: 'qa-key', privateKey: f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(cert) });
  const p = (await client.execute(f.command('prepare', create()))).data;
  const command = f.command('apply', { planId: p.planId }); const applied = await client.execute(command);
  assert.equal(applied.data.state, 'applied'); assert.equal(f.state.writes, 1);
  await app.close(); app = null;
  app = await runtime.main(filename, dependencies);
  assert.equal((await client.execute(command)).replayed, true);
  const status = await client.execute(f.command('status', { planId: p.planId }));
  assert.equal(status.data.state, 'applied'); assert.equal(status.data.results[0].actionId, '456'); assert.equal(f.state.writes, 1);
  assert.equal(require.cache[require.resolve('../../../models')], undefined);
});

test('actual CRM scope and client recover an acknowledged signed apply after a lost response and broker restart', async t => {
  const { createGoogleAdsBroker } = require('../../../src/services/googleAdsBroker.service');
  const { scopeFixture } = require('../../../src/scripts/tests/fixtures/google_ads_broker_scope.fixture');
  const f = setup(t), crm = scopeFixture();
  crm.binding.connection_ref = f.binding.connectionRef; crm.mapping.broker_read_connection_ref = f.binding.connectionRef;
  crm.binding.tenant_clinic_id = 123; crm.state.clinics[0].id_clinica = 123;
  let loseAck = false, guards = 0, commands = 0;
  const service = createGoogleAdsBroker({ ...crm.options, actionManagementEnabled: () => true, now: () => f.state.at,
    client: { async execute(command) {
      commands++; const result = await f.execute(command);
      if (loseAck) { loseAck = false; throw Object.assign(Error('FICTITIOUS_LOST_ACK'), { code: 'broker_unavailable' }); }
      return result;
    } } });
  const context = await service.prepare(crm.mapping);
  const options = () => ({ requestId: randomUUID(), beforeExecute: async () => { guards++; return true; } });
  const invoke = (family, payload, config = options()) => service.actionManagement(crm.mapping, context, family, payload, config);
  const prepared = await invoke('prepare', create(['lead', 'contact']));
  assert.equal((await invoke('validate', { planId: prepared.planId })).validated, true);
  const applyOptions = options(); loseAck = true;
  await assert.rejects(invoke('apply', { planId: prepared.planId }, applyOptions), { code: 'broker_unavailable' });
  assert.equal(f.state.writes, 1); assert.equal(commands, 3);
  f.reopen();
  const recovered = await invoke('status', { planId: prepared.planId });
  assert.equal(recovered.state, 'applied'); assert.deepEqual(recovered.results.map(row => row.actionId), ['456', '457']);
  const beforeCalls = f.state.calls.length;
  assert.deepEqual(await invoke('apply', { planId: prepared.planId }, applyOptions), recovered);
  assert.equal(f.state.calls.length, beforeCalls); assert.equal(f.state.writes, 1);
  const normalized = await invoke('prepare', { mode: 'normalize', currency: null, targets: [{ event: 'lead', actionId: '456' }] });
  assert.equal(normalized.changes[0].change, 'unchanged');
  crm.state.grants[0].status = 'revoked';
  const beforeCommands = commands;
  await assert.rejects(invoke('apply', { planId: normalized.planId }), { code: 'scope_denied' });
  assert.equal(commands, beforeCommands); assert.equal(f.state.writes, 1); assert(guards >= 9);
  assert.equal(require.cache[require.resolve('../../../models')], undefined);
});

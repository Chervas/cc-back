'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { fixture } = require('./helpers'); const { Broker } = require('../src/broker'); const { BrokerStore } = require('../src/store');
const { signRequest } = require('../src/auth'); const { eventFor } = require('../src/audit'); const { validateConfig } = require('../src/google-main');
const SC = require('../src/google-search-console-contract'); const GA = require('../src/google-analytics-contract');
function setup(t, kind) {
  const f = fixture(t); const contract = kind === 'search_console' ? SC : GA;
  const resources = kind === 'search_console' ? ['https://example.invalid/', 'sc-domain:other.invalid'].map(SC.site)
    : ['properties/123', 'properties/456'].map(GA.property);
  const controlKeys = generateKeyPairSync('ed25519'); const state = { secrets: 0, http: 0, invalidations: 0 };
  const policy = structuredClone(f.policy); policy.maxBacklog = 1000;
  policy.principals.push({ ...policy.principals[0], id: 'control:test', keyId: 'qa-control', publicKey: controlKeys.publicKey.export({ type: 'spki', format: 'pem' }) });
  policy.connections = ['connection:test', 'connection:other'].map(connectionRef => ({ connectionRef, provider: contract.PROVIDER, initialState: 'active',
    secretArn: 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-property-abcdef',
    clientSecretArn: 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-client-abcdef',
    googleSubject: 'fictitious-subject', ...(kind === 'search_console'
      ? { searchConsoleSites: resources.map(({ siteUrl, assetRef }) => ({ siteUrl, assetRef })) } : { analyticsProperties: resources }) }));
  policy.grants = policy.connections.flatMap(c => resources.flatMap(r => [123, 124].flatMap(clinic => [
    { principalId: 'api:test', tenantRef: `clinic:${clinic}`, connectionRef: c.connectionRef, assetRef: r.assetRef, operations: contract.OPERATIONS },
    { principalId: 'control:test', tenantRef: `clinic:${clinic}`, connectionRef: c.connectionRef, assetRef: r.assetRef, operations: [contract.REVOKE_OPERATION] },
  ])));
  const config = { cohort: kind === 'search_console' ? 'google-search-console-read-v1' : 'google-analytics-read-v1', enabled: true, policy,
    listenAddress: '127.0.0.1', port: 4443, stateFile: f.filename, tlsCertFile: '/fictitious/cert', tlsKeyFile: '/fictitious/key', cursorKeyFile: '/fictitious/cursor' };
  validateConfig(config);
  const create = kind === 'search_console' ? require('../src/google-search-console').createSearchConsoleOperations : require('../src/google-analytics').createAnalyticsOperations;
  const options = { policy, secrets: { invalidate() { state.invalidations++; }, async withSecret(binding, fn) {
    state.secrets++; await state.beforeSecret?.(); return fn(Buffer.from('FICTITIOUS_PROPERTY_SECRET'));
  } }, operations: create({ cursor: {}, http: async request => {
    state.http++; await state.beforeResponse?.();
    if (kind === 'search_console') return { siteUrl: decodeURIComponent(request.path.split('/sites/')[1]), permissionLevel: 'siteOwner' };
    return { name: request.path.slice('/v1beta/'.length), account: 'accounts/789', parent: 'accounts/789', displayName: 'FICTITIOUS_PROPERTY_LABEL', propertyType: 'PROPERTY_TYPE_ORDINARY' };
  } }) };
  const broker = new Broker({ store: f.store, ...options });
  const command = changes => f.command({ operation: contract.PREFIX + 'discovery.read.v1', assetRef: resources[0].assetRef, ...changes });
  const execute = (request, control = false, target = broker) => {
    const signed = signRequest(request, { keyId: control ? 'qa-control' : 'qa-key', privateKey: control ? controlKeys.privateKey : f.keys.privateKey, audience: policy.audience });
    return target.execute(signed.raw, signed.headers);
  };
  return { ...f, kind, contract, resources, state, config, options, policy, broker, command, execute,
    revoke: changes => execute(command({ operation: contract.REVOKE_OPERATION, ...changes }), true) };
}
function readPayload(kind, operation) {
  const range = { startDate: '2026-09-01', endDate: '2026-09-02' };
  if (operation.includes('.discovery.') || operation.includes('.inspection.')) return {};
  if (kind === 'analytics' || operation.includes('.queries.')) return { ...range, pageToken: null };
  return operation.includes('.pages.') ? { ...range, startRow: 0, rowLimit: 500 } : range;
}
for (const kind of ['search_console', 'analytics']) {
  test(kind + ' runtime requires separate control principals and public keys across all grants', t => {
    const f = setup(t, kind);
    const check = (change, code = 'invalid_request') => { const c = structuredClone(f.config); change(c); assert.throws(() => validateConfig(c), { code }); };
    check(c => { c.policy.grants[1].principalId = 'api:test'; });
    check(c => { c.policy.grants[0].operations.push(f.contract.REVOKE_OPERATION); });
    check(c => { c.policy.grants[1].operations.push(f.contract.OPERATIONS[0]); });
    check(c => { c.policy.principals[1].publicKey = c.policy.principals[0].publicKey; });
    check(c => { c.policy.principals[0].enabled = false; c.policy.principals[1].publicKey = c.policy.principals[0].publicKey; });
    check(c => { c.policy.grants[1].operations = [kind === 'search_console' ? GA.REVOKE_OPERATION : SC.REVOKE_OPERATION]; });
    check(c => { c.policy.grants[1].operations = ['google.business_profile.asset.revoke.v1']; });
    check(c => { c.policy.grants[1].operations = [f.contract.PREFIX + 'asset.restore.v1']; });
    check(c => { c.policy.grants[1].assetRef = kind === 'search_console' ? 'sc:' + 'a'.repeat(64) : 'ga4:999'; }, 'scope_denied');
    check(c => { c.policy.grants[1].tenantRef = 'group:9'; });
    const old = structuredClone(f.config); old.policy.grants = old.policy.grants.filter(g => g.principalId === 'api:test');
    assert.equal(validateConfig(old), old); assert(!f.contract.OPERATIONS.includes(f.contract.REVOKE_OPERATION));
    assert.throws(() => f.contract.validate(f.contract.REVOKE_OPERATION, {}), { code: 'operation_denied' });
  });
  test(kind + ' control authorizes an exact tuple, accepts only an empty payload and never loads a secret', async t => {
    const f = setup(t, kind);
    await assert.rejects(f.execute(f.command({ operation: f.contract.REVOKE_OPERATION })), { code: 'scope_denied' });
    await assert.rejects(f.execute(f.command(), true), { code: 'scope_denied' });
    for (const changes of [{ tenantRef: 'clinic:999' }, { connectionRef: 'connection:unknown' }, { assetRef: 'asset:unknown' }]) {
      await assert.rejects(f.revoke(changes), { code: 'scope_denied' });
    }
    for (const payload of [{ token: 'FICTITIOUS_TOKEN' }, { reason: 'arbitrary' }, { siteUrl: 'https://example.invalid/' }, [], null]) {
      await assert.rejects(f.revoke({ payload }), { code: 'invalid_request' });
    }
    assert.deepEqual((await f.revoke()).data, { revoked: true });
    assert.equal(f.state.secrets + f.state.http + f.state.invalidations, 0);
    for (const operation of f.contract.OPERATIONS) {
      await assert.rejects(f.execute(f.command({ operation, payload: readPayload(kind, operation) })), { code: 'asset_revoked' });
    }
    assert.equal(f.state.secrets, 0);
    for (const changes of [{ tenantRef: 'clinic:124' }, { connectionRef: 'connection:other' }, { assetRef: f.resources[1].assetRef }]) {
      assert((await f.execute(f.command(changes))).data);
    }
    assert.equal(f.state.http, 3);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations').get().n, 1);
    const events = f.store.db.prepare('SELECT event FROM audit_outbox').all().map(r => JSON.parse(r.event));
    const revoked = events.filter(e => e.action === 'asset.revoked'); assert.equal(revoked.length, 1);
    assert.equal(revoked[0].version, 2); assert.equal(revoked[0].actorId, 'control:test'); assert.equal(revoked[0].tenantRef, 'clinic:123');
    assert.equal(revoked[0].resourceRef, f.resources[0].assetRef); assert.equal(revoked[0].operation, f.contract.REVOKE_OPERATION);
    const durable = JSON.stringify(events) + JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all());
    for (const sentinel of ['FICTITIOUS_TOKEN', 'FICTITIOUS_PROPERTY_SECRET', 'FICTITIOUS_PROPERTY_LABEL', 'https://example.invalid/']) assert(!durable.includes(sentinel));
  });
  test(kind + ' restart preserves revocation, ACK replay and digest conflicts without duplicate audit', async t => {
    const f = setup(t, kind); const request = f.command({ operation: f.contract.REVOKE_OPERATION });
    await f.execute(request, true); assert.equal(f.store.backlog().pending, 2); f.store.close();
    const store = new BrokerStore(f.filename); t.after(() => store.close()); const broker = new Broker({ store, ...f.options });
    assert.equal((await f.execute(request, true, broker)).replayed, true); assert.equal(store.backlog().pending, 2);
    await assert.rejects(f.execute({ ...request, assetRef: f.resources[1].assetRef }, true, broker), { code: 'idempotency_conflict' });
    assert.equal(store.backlog().pending, 2); assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 1);
    await assert.rejects(f.execute(f.command(), false, broker), { code: 'asset_revoked' });
    await f.execute(f.command({ operation: f.contract.REVOKE_OPERATION }), true, broker);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations').get().n, 1);
    assert.equal(f.state.secrets + f.state.http, 0);
  });
  test(kind + ' revocation during secret retrieval prevents dispatch and during provider wait suppresses the result', async t => {
    for (const step of ['beforeSecret', 'beforeResponse']) {
      const f = setup(t, kind); let entered; let release;
      const started = new Promise(resolve => { entered = resolve; }); const waiting = new Promise(resolve => { release = resolve; });
      f.state[step] = async () => { entered(); await waiting; };
      const running = f.execute(f.command()); const rejected = assert.rejects(running, error => ['asset_revoked', 'provider_timeout'].includes(error.code));
      await started; try { await f.revoke(); } finally { release(); }
      await rejected; assert.equal(f.state.http, step === 'beforeSecret' ? 0 : 1);
      assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE result LIKE '%FICTITIOUS%'").get().n, 0);
    }
  });
  test(kind + ' another SQLite connection revokes during awaits without relying on local abort controllers', async t => {
    for (const step of ['beforeSecret', 'beforeResponse']) {
      const f = setup(t, kind); const store = new BrokerStore(f.filename); t.after(() => store.close());
      const other = new Broker({ store, ...f.options });
      f.state[step] = async () => { await f.execute(f.command({ operation: f.contract.REVOKE_OPERATION }), true, other); };
      await assert.rejects(f.execute(f.command()), { code: 'asset_revoked' });
      assert.equal(f.state.http, step === 'beforeSecret' ? 0 : 1);
    }
  });
  test(kind + ' failed audit and full outbox leave no partial revocation or command', async t => {
    const f = setup(t, kind); const append = f.store.appendAudit.bind(f.store);
    f.store.appendAudit = event => { if (event.action === 'asset.revoked') throw Error('FICTITIOUS_DISK_FAILURE'); return append(event); };
    await assert.rejects(f.revoke());
    assert.equal(f.store.backlog().pending, 0); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations').get().n, 0);
    const g = setup(t, kind); g.broker.policy.maxBacklog = 2;
    g.store.appendAudit(eventFor(g.command(), g.policy.principals[0], g.policy, 'integration.denied', 'denied', 'scope_denied'));
    await assert.rejects(g.revoke(), { code: 'audit_unavailable' });
    assert.equal(g.store.backlog().pending, 1); assert.equal(g.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
    assert.equal(g.store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations').get().n, 0);
  });
  test(kind + ' blocked, expired or revoked connections still permit an authorized asset revocation', async t => {
    for (const state of ['blocked', 'expired', 'revoked']) {
      const f = setup(t, kind); f.store.db.prepare('UPDATE connections SET state=?').run(state);
      assert.equal((await f.revoke()).data.revoked, true); assert.equal(f.state.secrets + f.state.http, 0);
    }
  });
}

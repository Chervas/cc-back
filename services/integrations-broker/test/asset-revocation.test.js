'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { generateKeyPairSync } = require('node:crypto');
const { fixture } = require('./helpers'); const { Broker } = require('../src/broker'); const { BrokerStore } = require('../src/store');
const { signRequest } = require('../src/auth'); const { createGoogleBusinessProfileOperations } = require('../src/google-business-profile');
const { REVOKE_OPERATION, PROVIDER } = require('../src/google-business-profile-contract');
function setup(t) {
  const f = fixture(t); const controlKeys = generateKeyPairSync('ed25519'); const state = { secrets: 0, http: 0 };
  const policy = structuredClone(f.policy); policy.connections[0].provider = PROVIDER;
  policy.principals.push({ ...policy.principals[0], id: 'control:test', keyId: 'qa-control', publicKey: controlKeys.publicKey.export({ type: 'spki', format: 'pem' }) });
  policy.grants = [123, 124].flatMap(clinic => [
    { principalId: 'api:test', tenantRef: `clinic:${clinic}`, connectionRef: 'connection:test', assetRef: 'gbp:123:456', operations: ['google.business_profile.details.read.v1'] },
    { principalId: 'control:test', tenantRef: `clinic:${clinic}`, connectionRef: 'connection:test', assetRef: 'gbp:123:456', operations: [REVOKE_OPERATION] },
  ]);
  const options = { policy, secrets: { invalidate() {}, async withSecret(binding, fn) { state.secrets++; await state.beforeSecret?.(); return fn(Buffer.from('FICTITIOUS_SECRET')); } },
    operations: createGoogleBusinessProfileOperations({ cursor: {}, http: async () => { state.http++; await state.beforeResponse?.(); return { name: 'locations/456', title: 'Fictitious' }; } }) };
  const broker = new Broker({ store: f.store, ...options });
  const command = changes => f.command({ operation: 'google.business_profile.details.read.v1', assetRef: 'gbp:123:456', ...changes });
  const execute = (request, control = false, target = broker) => {
    const r = signRequest(request, { keyId: control ? 'qa-control' : 'qa-key', privateKey: control ? controlKeys.privateKey : f.keys.privateKey, audience: policy.audience });
    return target.execute(r.raw, r.headers);
  };
  return { ...f, state, policy, broker, options, command, execute, revoke: changes => execute(command({ operation: REVOKE_OPERATION, ...changes }), true) };
}
test('asset revocation is atomic, needs a distinct grant, never reads secrets and preserves other tenants', async t => {
  const f = setup(t);
  await assert.rejects(f.execute(f.command({ operation: REVOKE_OPERATION })), { code: 'scope_denied' });
  await assert.rejects(f.revoke({ payload: { token: 'FICTITIOUS_TOKEN' } }), { code: 'invalid_request' });
  await assert.rejects(f.revoke({ tenantRef: 'clinic:999' }), { code: 'scope_denied' });
  const result = await f.revoke(); assert.deepEqual(result.data, { revoked: true }); assert.equal(f.state.secrets, 0); assert.equal(f.state.http, 0);
  await assert.rejects(f.execute(f.command()), { code: 'asset_revoked' });
  assert.equal((await f.execute(f.command({ tenantRef: 'clinic:124' }))).data.title, 'Fictitious');
  const rows = f.store.db.prepare('SELECT event FROM audit_outbox').all(); assert(rows.some(r => JSON.parse(r.event).action === 'asset.revoked'));
  assert(!JSON.stringify(rows).includes('FICTITIOUS_TOKEN'));
});
test('lost ACK replay and another command survive a broker restart without restoring the revoked asset', async t => {
  const f = setup(t); const request = f.command({ operation: REVOKE_OPERATION }); await f.execute(request, true);
  const store = new BrokerStore(f.filename); t.after(() => store.close()); const broker = new Broker({ store, ...f.options });
  assert.equal((await f.execute(request, true, broker)).replayed, true);
  await assert.rejects(f.execute(f.command(), false, broker), { code: 'asset_revoked' });
  await f.execute(f.command({ operation: REVOKE_OPERATION }), true, broker);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations').get().n, 1);
  assert.equal(f.state.secrets, 0);
});
test('revocation while retrieving a secret prevents dispatch and while awaiting a provider suppresses its response', async t => {
  for (const step of ['beforeSecret', 'beforeResponse']) {
    const f = setup(t); let release; let entered; const started = new Promise(resolve => { entered = resolve; });
    f.state[step] = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
    const running = f.execute(f.command()); const rejected = assert.rejects(running, e => ['asset_revoked', 'provider_timeout'].includes(e.code));
    await started; await f.revoke(); release(); await rejected;
    assert.equal(f.state.http, step === 'beforeSecret' ? 0 : 1);
  }
});
test('separate-process tombstones are checked after awaits and audit failure rolls back the revocation', async t => {
  const f = setup(t); const store = new BrokerStore(f.filename); t.after(() => store.close()); const broker = new Broker({ store, ...f.options });
  f.state.beforeResponse = async () => { await f.execute(f.command({ operation: REVOKE_OPERATION }), true, broker); };
  await assert.rejects(f.execute(f.command()), { code: 'asset_revoked' });
  const other = setup(t); const append = other.store.appendAudit.bind(other.store);
  other.store.appendAudit = e => { if (e.action === 'asset.revoked') throw Error('fictitious disk failure'); return append(e); };
  await assert.rejects(other.revoke()); assert.equal(other.store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations').get().n, 0);
  assert.equal(other.store.db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0); assert.equal(other.store.backlog().pending, 0);
});
test('a blocked credential still allows revocation, and outbox pressure rejects it without a partial tombstone', async t => {
  const f = setup(t); f.store.db.prepare("UPDATE connections SET state='revoked'").run();
  assert.equal((await f.revoke()).data.revoked, true); assert.equal(f.state.secrets, 0);
  const g = setup(t); g.broker.policy.maxBacklog = 1;
  await assert.rejects(g.revoke(), { code: 'audit_unavailable' }); assert.equal(g.store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations').get().n, 0);
});

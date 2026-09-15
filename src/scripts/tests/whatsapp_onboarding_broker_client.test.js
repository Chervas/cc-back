'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const { randomUUID, randomBytes } = require('node:crypto');
const { brokerForGateway } = require('./fixtures/whatsapp_onboarding_gateway.fixture.cjs');
const { createWhatsappOnboardingBrokerClient, configuredClient, configuration } = require('../../lib/whatsappOnboardingBrokerClient');
const C = require('../../../services/integrations-broker/src/whatsapp-onboarding-contract');
function context(g) {
  return { requestId: randomUUID(), status: 'awaiting', scope: { type: 'group', id: 9 }, clinicIds: [71,72],
    expiresAt: new Date(g.f.now() + 600000).toISOString(), scopeDigest: C.hash('FICTITIOUS_GATEWAY_SCOPE'),
    clinicSetDigest: C.hash('[71,72]'), state: randomBytes(32).toString('base64url') };
}
const finish = row => ({ state: row.state, code: 'FICTITIOUS_GATEWAY_CODE_' + row.requestId, wabaId: '301', phoneId: '401' });
test('Gateway selected-phone mode accepts verified business discovery and the existing WhatsApp events permission', async t => {
  const g = brokerForGateway(t, { customer: { selectionOnly: true }, scopes: ['public_profile','whatsapp_business_manage_events','whatsapp_business_management','whatsapp_business_messaging'] });
  const row = context(g); await g.client.begin(row); const result = await g.client.finish(row, finish(row));
  assert.equal(result.status, 'staged'); assert.equal(result.connected, false); assert.equal(result.candidate.businessId, '501');
  g.f.restart(); assert.equal((await g.client.status(row)).status, 'staged');
  for (const modify of [v => { v.businessId = null; }, v => { v.grantedWabaIds.push('bad'); }, v => { v.scopes.push('ads_management'); }]) {
    g.state.after = (cmd,r) => { modify(r.data.candidate); return r; };
    await assert.rejects(g.client.status(row), { code: 'whatsapp_onboarding_result_unknown' });
  }
});
test('Gateway accepts only the pinned business and WABAs in a completed group authorization', async t => {
  const g = brokerForGateway(t, { customer: { businessId: '501', wabaIds: ['301','302'] } }); const row = context(g);
  await g.client.begin(row); const result = await g.client.finish(row, finish(row));
  assert.equal(result.connected, false); assert.equal(result.candidate.businessId, '501');
  assert.deepEqual(result.candidate.grantedWabaIds, ['301','302']); g.f.restart();
  assert.equal((await g.client.status(row)).status, 'staged');
  for (const mutate of [v => { v.businessId = '999'; }, v => { v.grantedWabaIds.push('999'); },
    v => { v.grantedWabaIds = ['302']; }, v => { v.grantedWabaIds.reverse(); }, v => { v.tokenType = 'USER'; },
    v => { delete v.businessId; }, v => { v.grantedWabaIds = ['301','302','302']; }]) {
    g.state.after = (cmd, value) => { mutate(value.data.candidate); return value; };
    await assert.rejects(g.client.status(row), { code: 'whatsapp_onboarding_result_unknown' });
  }
  assert.equal(g.f.state.codes, 1); assert.equal(g.f.state.puts, 1);
});
test('Malformed customer bindings are rejected by gateway before any request', async t => {
  const g = brokerForGateway(t); const row = context(g);
  for (const customer of [null, {}, { businessId: '501', wabaIds: ['302','301'] },
    { businessId: '501', wabaIds: ['301'], arbitrary: true }]) {
    g.state.binding = { ...g.metadata, customer };
    await assert.rejects(g.client.begin(row), { code: 'whatsapp_onboarding_binding_invalid' });
  }
  assert.equal(g.state.calls.length, 0);
});
test('Overlapping begin reports busy; the refused UUID can start after the older attempt is cancelled', async t => {
  const g = brokerForGateway(t); const older = context(g); const next = context(g);
  await g.client.begin(older);
  await assert.rejects(g.client.begin(next), { code: 'whatsapp_authorization_busy', outcomeUnknown: false });
  assert.deepEqual(require('../../services/whatsappOnboardingGateway.service').safe({ code: 'whatsapp_authorization_busy' }),
    { code: 'whatsapp_authorization_busy', status: 409, outcomeUnknown: false });
  await g.client.abort(older);
  assert.equal((await g.client.begin(next)).status, 'awaiting');
  assert.equal(g.f.state.codes, 0); assert.equal(g.f.state.puts, 0);
});
test('Known begin refusals are safe while finish errors remain uncertain and are never retried', async t => {
  const g = brokerForGateway(t); const row = context(g);
  for (const [code, mapped] of [['rate_limited', 'whatsapp_authorization_limit'], ['oauth_flow_busy', 'whatsapp_authorization_busy']]) {
    g.state.before = () => { throw Object.assign(Error('FICTITIOUS_SECRET'), { code }); };
    await assert.rejects(g.client.begin(row), e => e.code === mapped && !e.outcomeUnknown && !e.message.includes('FICTITIOUS'));
    await assert.rejects(g.client.finish(row, finish(row)), { code: 'whatsapp_onboarding_result_unknown', outcomeUnknown: true });
  }
  assert.equal(g.state.calls.length, 4); assert.equal(g.f.state.codes, 0); assert.equal(g.f.state.puts, 0);
});
test('Typed gateway client completes signed candidate flow, recovers after restart and cancels without enabling messages', async t => {
  const g = brokerForGateway(t); const row = context(g); const begin = await g.client.begin(row);
  assert.equal(begin.authorization.appId, '101'); const result = await g.client.finish(row, finish(row));
  assert.equal(result.status, 'staged'); assert.equal(result.connected, false); g.f.restart();
  assert.equal((await g.client.status(row)).status, 'staged'); assert.equal((await g.client.abort(row)).status, 'aborted');
  assert.equal(g.f.state.codes, 1); assert.equal(g.f.state.puts, 1);
  assert(!JSON.stringify(result).includes('FICTITIOUS_ONBOARDING_TOKEN'));
});
test('Gateway cancellation before broker begin accepts a tombstone tied to the original clinic set', async t => {
  const g = brokerForGateway(t); const row = context(g); assert.equal((await g.client.abort(row)).status, 'aborted');
  await assert.rejects(g.client.begin(row), { code: 'whatsapp_onboarding_result_unknown' });
  assert.equal(g.f.state.codes, 0); assert.equal(g.f.state.puts, 0);
  const expired = { ...context(g), expiresAt: new Date(g.f.now() - 1000).toISOString(), status: 'cancelled' };
  assert.equal((await g.client.abort(expired)).status, 'aborted');
});
test('Wrong runtime, foreign bindings, altered clinic hash and caller-supplied fields cannot reach broker', async t => {
  const g = brokerForGateway(t); const row = context(g);
  const blocked = createWhatsappOnboardingBrokerClient({ client: g.transport, loadBinding: async () => assert.fail('binding read outside gateway'),
    guard: () => { throw Object.assign(Error(), { code: 'whatsapp_onboarding_disabled' }); } });
  await assert.rejects(blocked.begin(row), { code: 'whatsapp_onboarding_disabled' });
  for (const change of [{ clinicIds: [73] }, { clinicSetDigest: 'f'.repeat(64) }, { scope: { type: 'clinic', id: 71 } }, { requestId: 'invalid' }])
    await assert.rejects(g.client.begin({ ...row, ...change }), { code: 'whatsapp_onboarding_binding_invalid' });
  await assert.rejects(g.client.finish(row, { ...finish(row), accessToken: 'FICTITIOUS_SECRET' }), { code: 'whatsapp_onboarding_binding_invalid' });
  g.state.binding = { ...g.metadata, connectionRef: 123 };
  await assert.rejects(g.client.begin(row), { code: 'whatsapp_onboarding_binding_invalid' });
  assert.equal(g.state.calls.length, 0);
});
test('Broker response cannot replace app/config/URI, scope, expiry or inject credential fields', async t => {
  const g = brokerForGateway(t); const row = context(g);
  for (const mutate of [d => { d.authorization.appId = '999'; }, d => { d.authorization.configId = '999'; },
    d => { d.authorization.redirectUri = 'https://other.invalid/'; }, d => { d.scopeDigest = 'f'.repeat(64); },
    d => { d.clinicCount = 1; }, d => { d.expiresAt++; }, d => { d.connected = true; },
    d => { d.authorization.accessToken = 'FICTITIOUS_SECRET'; }, d => { d.accessToken = 'FICTITIOUS_SECRET'; }]) {
    g.state.after = (cmd, result) => { mutate(result.data); return result; };
    await assert.rejects(g.client.begin(row), e => e.code === 'whatsapp_onboarding_result_unknown' && e.outcomeUnknown && !e.message.includes('FICTITIOUS'));
  }
  assert.equal(g.f.state.codes, 0);
});
test('Candidate identity, permissions, version and unknown fields are checked before gateway can expose metadata', async t => {
  const g = brokerForGateway(t); const row = context(g); await g.client.begin(row); await g.client.finish(row, finish(row));
  for (const mutate of [v => { v.appId = '999'; }, v => { v.versionId = randomUUID(); }, v => { v.scopes.push('ads_management'); },
    v => { v.accessToken = 'FICTITIOUS_SECRET'; }, v => { v.phoneId = 'bad'; }]) {
    g.state.after = (cmd, result) => { mutate(result.data.candidate); return result; };
    await assert.rejects(g.client.status(row), { code: 'whatsapp_onboarding_result_unknown' });
  }
  assert.equal(g.f.state.codes, 1); assert.equal(g.f.state.puts, 1);
});
test('Binding changes or lost responses produce uncertainty without transport retry', async t => {
  const g = brokerForGateway(t); const row = context(g); await g.client.begin(row);
  g.state.after = () => { g.state.binding = { ...g.metadata, configId: '999' }; throw Error('FICTITIOUS_SECRET'); };
  await assert.rejects(g.client.finish(row, finish(row)), { code: 'whatsapp_onboarding_result_unknown' });
  assert.equal(g.f.state.codes, 1); assert.equal(g.f.state.puts, 1);
  g.state.binding = g.metadata; g.state.after = null; g.f.restart(); assert.equal((await g.client.status(row)).status, 'staged');
});
test('Configured gateway rejects insecure files, foreign metadata and disabled environment before network', async t => {
  const g = brokerForGateway(t); const root = fs.mkdtempSync('/tmp/cc-wa-gateway-config-'); fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = root + '/config.json'; const keyFile = root + '/state.key'; fs.writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  const config = { version: 1, origin: 'https://broker.example.invalid', audience: 'broker:qa', keyId: 'gateway:qa', privateKeyFile: root + '/private.pem', caFile: root + '/ca.pem', bindings: [g.metadata] };
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 }); const env = { WHATSAPP_ONBOARDING_BROKER_CONFIG_FILE: file };
  assert.equal(configuration(env).bindings[0].appId, '101'); fs.chmodSync(file, 0o644); assert.throws(() => configuration(env)); fs.chmodSync(file, 0o600);
  fs.symlinkSync(file, root + '/link'); assert.throws(() => configuration({ ...env, WHATSAPP_ONBOARDING_BROKER_CONFIG_FILE: root + '/link' }));
  for (const mutate of [v => { v.bindings.push(v.bindings[0]); }, v => { v.bindings[0].scopes.push('ads_management'); },
    v => { v.bindings[0].secretArn = 'forbidden'; }, v => { v.privateKey = 'FICTITIOUS_SECRET'; }]) {
    const v = structuredClone(config); mutate(v); fs.writeFileSync(file, JSON.stringify(v)); assert.throws(() => configuration(env));
  }
  await assert.rejects(configuredClient({ environment: () => env }).begin(context(g)), { code: 'whatsapp_onboarding_disabled' });
});

test('Gateway presents a completed receipt after OAuth expiry and restart while explicit cancellation remains authoritative', async t => {
  const g = brokerForGateway(t); const row = context(g); await g.client.begin(row); await g.client.finish(row, finish(row));
  let cancelled = false; const local = () => ({ ...row, status: cancelled ? 'cancelled' : Date.parse(row.expiresAt) <= g.f.now() ? 'expired' : 'claimed' });
  const states = { status: async () => local(), cancel: async () => { cancelled = true; return local(); } };
  const service = require('../../services/whatsappOnboardingGateway.service').createService({ states, broker: g.client, guard: () => {} });
  const actor = { requestId: row.requestId, userId: 501, sessionRef: randomUUID(), sessionExpiresAt: Math.floor((g.f.now() + 3600000) / 1000) };
  g.f.state.clock = Date.parse(row.expiresAt) + 1000; g.f.restart();
  const before = { codes: g.f.state.codes, puts: g.f.state.puts, graph: g.f.state.httpCalls.length, aws: g.f.state.awsCalls.length };
  const result = await service.status(actor);
  assert.equal(result.authorizationStatus, 'awaiting_activation'); assert.equal(result.expiresAt, row.expiresAt);
  assert.deepEqual(result.selected, { wabaId: '301', phoneId: '401' }); assert.equal(result.connected, false);
  assert.equal(result.pending, true); assert.equal(result.cancellationConfirmed, false); assert(!Object.hasOwn(result, 'authorization'));
  assert.deepEqual({ codes: g.f.state.codes, puts: g.f.state.puts, graph: g.f.state.httpCalls.length, aws: g.f.state.awsCalls.length }, before);
  const aborted = await service.cancel(actor);
  assert.equal(aborted.authorizationStatus, 'cancelled'); assert.equal(aborted.cancellationConfirmed, true); assert.equal(aborted.selected, null);
  assert.equal((await service.status(actor)).authorizationStatus, 'cancelled');
  assert(g.f.records.get(g.f.binding.secretArn).has(row.requestId)); // Cancellation preserves evidence and stored versions.
});

test('Gateway never labels an expired completed receipt authorized when access or configuration is blocked', async t => {
  for (const reason of ['access', 'configuration']) {
    const g = brokerForGateway(t); const row = context(g); await g.client.begin(row); await g.client.finish(row, finish(row));
    g.f.state.clock = Date.parse(row.expiresAt) + 1000;
    if (reason === 'access') g.f.current.store.db.prepare("UPDATE connections SET state='blocked' WHERE ref=?").run(g.f.binding.connectionRef);
    else g.state.after = (command, result) => { result.data.configurationChanged = true; return result; };
    const service = require('../../services/whatsappOnboardingGateway.service').createService({
      states: { status: async () => ({ ...row, status: 'expired' }) }, broker: g.client, guard: () => {} });
    const result = await service.status({ requestId: row.requestId, userId: 501, sessionRef: randomUUID(), sessionExpiresAt: 1900000000 });
    assert.equal(result.authorizationStatus, 'blocked', reason); assert.equal(result.selected, null);
    assert.equal(result.connected, false); assert.equal(result.pending, false);
    assert.equal(g.f.state.codes, 1); assert.equal(g.f.state.puts, 1);
  }
});

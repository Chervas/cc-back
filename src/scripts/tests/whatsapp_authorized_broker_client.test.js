'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createWhatsappAuthorizedBrokerClient, validateConfiguration, configuration } = require('../../lib/whatsappAuthorizedBrokerClient');
const { requestIdFor } = require('../../lib/whatsappBrokerClient');
const { buildWhatsappOutboundRetryDecision } = require('../../lib/whatsapp-outbound-retry');
const staging = () => ({ RUNTIME_ROLE: 'api', JOB_RUNTIME_NAMESPACE: 'staging', QUEUE_PREFIX: 'staging', JOBS_WORKER_ENABLED: 'true' });
const binding = () => ({ connectionRef: 'wa:qa:123', authorizationId: 'a1234567-1234-4234-8234-123456789abc', clinicId: 123, assetId: 456,
  phoneId: '401', wabaId: '501', revision: 1, sendEnabled: true });
const config = () => ({ version: 1, origin: 'https://broker.example.invalid:8445', keyId: 'staging-whatsapp', audience: 'authorized-wa',
  privateKeyFile: '/etc/clinicaclick-whatsapp-authorized/staging/private.pem', caFile: '/etc/clinicaclick-whatsapp-authorized/staging/ca.pem', bindings: [binding()] });
const asset = () => ({ id: 456, assetType: 'whatsapp_phone_number', assignmentScope: 'clinic', clinicaId: 123, grupoClinicaId: null,
  phoneNumberId: '401', wabaId: '501', isActive: false });
const message = () => ({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '34000000123', type: 'text', text: { body: 'Synthetic QA', preview_url: false } });
const input = () => ({ messageId: '123', clinicId: 123, assetId: 456, expectedBinding: binding(), message: message() });
function fixture(overrides = {}) {
  const calls = []; const counters = { configuration: 0, assets: 0, clinics: 0, blocks: 0, transports: 0 };
  const state = { env: staging(), config: config(), asset: asset(), clinic: { id_clinica: 123, grupoClinicaId: 42 }, blocked: false };
  const client = createWhatsappAuthorizedBrokerClient({ environment: () => state.env,
    loadConfiguration: () => { counters.configuration++; return structuredClone(state.config); },
    loadAsset: async id => { counters.assets++; assert.equal(id, 456); return structuredClone(state.asset); },
    loadClinic: async id => { counters.clinics++; assert.equal(id, 123); return structuredClone(state.clinic); },
    isBlocked: async id => { counters.blocks++; assert.equal(id, 123); return state.blocked; },
    createTransport: () => { counters.transports++; return { execute: async command => { calls.push(command);
      return { requestId: command.requestId, replayed: false, data: { messages: [{ id: 'wamid.SYNTHETIC_ACCEPTED', message_status: 'accepted' }] } }; } }; },
    ...overrides });
  return { state, client, calls, counters };
}
test('DEV, gateway, disabled workers and mismatched queues cannot reach binding or transport', async () => {
  for (const change of [{ RUNTIME_ROLE: 'gateway' }, { JOB_RUNTIME_NAMESPACE: 'dev' }, { QUEUE_PREFIX: 'dev' }, { JOBS_WORKER_ENABLED: 'false' }]) {
    const f = fixture(); Object.assign(f.state.env, change);
    await assert.rejects(f.client.send(input()), { code: 'whatsapp_broker_runtime_denied' });
    assert.deepEqual(f.counters, { configuration: 0, assets: 0, clinics: 0, blocks: 0, transports: 0 });
  }
});
test('every paused binding fails before constructing an HTTP transport', async () => {
  const f = fixture(); f.state.config.bindings[0].sendEnabled = false;
  await assert.rejects(f.client.send({ ...input(), expectedBinding: { ...binding(), sendEnabled: false } }), { code: 'whatsapp_authorized_send_paused' });
  assert.equal(f.counters.transports, 0); assert.equal(f.calls.length, 0);
});
test('durable Message identity and server metadata determine exactly one compatible Graph operation', async () => {
  const f = fixture(); const result = await f.client.send(input());
  assert.deepEqual(result, { messages: [{ id: 'wamid.SYNTHETIC_ACCEPTED', message_status: 'accepted' }] });
  assert.equal(f.calls.length, 1); assert.equal(f.counters.blocks, 3);
  assert.deepEqual(f.calls[0], { requestId: requestIdFor('123'), tenantRef: 'clinic:123', connectionRef: binding().connectionRef,
    assetRef: 'wa-phone:401', operation: 'meta.whatsapp.authorized.send.v1',
    payload: { authorizationId: binding().authorizationId, phoneId: '401', message: message() } });
  await f.client.send({ ...input(), message: { ...message(), text: { body: 'Another synthetic body' } } });
  assert.equal(f.calls[0].requestId, f.calls[1].requestId);
});
test('unbound or forged clinic, asset, authorization and revision never dispatch', async () => {
  for (const forged of [{ clinicId: 999 }, { assetId: 999 }, { phoneId: '402' }, { wabaId: '502' }, { revision: 2 },
    { connectionRef: 'wa:foreign' }, { authorizationId: 'b1234567-1234-4234-8234-123456789abc' }, { accessToken: 'SYNTHETIC_FORBIDDEN' }]) {
    const f = fixture(); await assert.rejects(f.client.send({ ...input(), expectedBinding: { ...binding(), ...forged } }));
    assert.equal(f.calls.length, 0);
  }
  for (const change of [{ clinicId: 999 }, { assetId: 999 }, { messageId: null }, { messageId: 123 }, { messageId: '../123' }, { token: 'SYNTHETIC_FORBIDDEN' }]) {
    const f = fixture(); await assert.rejects(f.client.send({ ...input(), ...change })); assert.equal(f.calls.length, 0);
  }
});
test('exact inactive clinic and group assets are usable, unrelated group or altered phone is rejected', async () => {
  const f = fixture(); await f.client.send(input());
  f.state.asset = { ...asset(), assignmentScope: 'group', clinicaId: null, grupoClinicaId: 42 };
  await f.client.send({ ...input(), messageId: '124' }); assert.equal(f.calls.length, 2); assert.equal(f.state.asset.isActive, false);
  for (const change of [{ grupoClinicaId: 43 }, { phoneNumberId: '402' }, { wabaId: '502' }, { assetType: 'page' }]) {
    const bad = fixture(); bad.state.asset = { ...f.state.asset, ...change };
    await assert.rejects(bad.client.send(input()), { code: 'whatsapp_authorized_binding_invalid' }); assert.equal(bad.calls.length, 0);
  }
});
test('clinic/group tombstones and binding edits are rechecked immediately before the only dispatch', async () => {
  for (const scenario of ['blocked', 'revision', 'removed', 'runtime']) {
    let checks = 0; let f;
    f = fixture({ isBlocked: async () => {
      checks++; if (checks === 2) {
        if (scenario === 'blocked') return true;
        if (scenario === 'revision') f.state.config.bindings[0].revision = 2;
        if (scenario === 'removed') f.state.config.bindings = [];
        if (scenario === 'runtime') f.state.env.JOB_RUNTIME_NAMESPACE = 'dev';
      }
      return false;
    } });
    await assert.rejects(f.client.send(input())); assert.equal(checks, 2); assert.equal(f.calls.length, 0);
  }
});
test('annotation includes inactive exact bindings only and does not trust caller metadata', async () => {
  const f = fixture(); const forged = { ...asset(), id: 457, whatsappAuthorizedBinding: binding() };
  assert.deepEqual(await f.client.annotate(123, [asset(), forged]), [{ ...asset(), whatsappAuthorizedBinding: binding() }]);
  f.state.config = null;
  assert.deepEqual(await f.client.annotate(123, [{ ...forged, isActive: true }, asset()]), [{ ...asset(), id: 457, isActive: true }]);
});
test('configuration forbids secret values, foreign paths, duplicate clinic assets and coerced key identifiers', () => {
  for (const change of [{ accessToken: 'SYNTHETIC_FORBIDDEN' }, { privateKeyFile: '/tmp/key' }, { caFile: '/tmp/ca' }, { keyId: undefined },
    { audience: null }, { origin: 'http://broker.example.invalid' }, { origin: 'https://user:password@broker.example.invalid' },
    { origin: 'https://broker.example.invalid/path' }, { bindings: [binding(), binding()] }]) {
    assert.throws(() => validateConfiguration({ ...config(), ...change }));
  }
  assert.throws(() => configuration({ ...staging(), WHATSAPP_AUTHORIZED_BROKER_CONFIG_FILE: '/tmp/config.json' }), { code: 'whatsapp_authorized_configuration_invalid' });
});
test('raw database and configuration diagnostics do not escape binding preflight', async () => {
  for (const target of ['loadAsset', 'loadClinic', 'isBlocked']) {
    const f = fixture({ [target]: async () => { throw Error('PRIVATE_SQL_AND_DATA'); } });
    await assert.rejects(f.client.send(input()), e => e.message === 'whatsapp_authorized_binding_invalid' && e.retryable === false);
    assert.equal(f.calls.length, 0);
  }
  const unknown = fixture({ isBlocked: async () => undefined });
  await assert.rejects(unknown.client.send(input()), { code: 'whatsapp_authorized_scope_blocked' }); assert.equal(unknown.calls.length, 0);
  const foreign = fixture({ loadClinic: async () => ({ id_clinica: 999, grupoClinicaId: 42 }) });
  await assert.rejects(foreign.client.send(input()), { code: 'whatsapp_authorized_binding_invalid' }); assert.equal(foreign.calls.length, 0);
});
test('inequivocal remote denials stay explicit and cannot trigger automatic retries', async () => {
  for (const code of ['invalid_signature', 'rate_limited']) {
    let calls = 0; const f = fixture({ createTransport: () => ({ execute: async () => { calls++; throw Object.assign(Error('PRIVATE_REMOTE_DETAIL'), { code }); } }) });
    await assert.rejects(f.client.send(input()), e => {
      assert.equal(e.message, code); assert.equal(e.code, code); assert.equal(e.retryable, false); assert.equal(e.delivery_unknown, undefined);
      assert.equal(buildWhatsappOutboundRetryDecision({ error: e, retryOnFailure: true, maxAttempts: 5 }).should_retry, false); return true;
    }); assert.equal(calls, 1);
  }
});
test('post-dispatch changes, ambiguous failures and malformed receipts remain unknown without replay', async () => {
  for (const scenario of ['timeout', 'revoked', 'scope', 'asset', 'operation', 'revision', 'runtime', 'receipt', 'status', 'request']) {
    let calls = 0; let f; f = fixture({ createTransport: () => ({ execute: async command => {
      calls++;
      if (['timeout', 'revoked', 'scope', 'asset', 'operation'].includes(scenario)) throw Object.assign(Error('PRIVATE_REMOTE_DETAIL'), {
        code: { timeout: 'broker_timeout', revoked: 'connection_blocked', scope: 'scope_denied', asset: 'asset_revoked', operation: 'operation_denied' }[scenario], status: 503 });
      if (scenario === 'revision') f.state.config.bindings[0].revision = 2;
      if (scenario === 'runtime') f.state.env.JOBS_WORKER_ENABLED = 'false';
      return { requestId: scenario === 'request' ? requestIdFor('124') : command.requestId, replayed: false,
        data: { messages: [{ id: 'wamid.SYNTHETIC_ACCEPTED', ...(scenario === 'status' ? { message_status: 'bad' } : {}) }],
          ...(scenario === 'receipt' ? { accessToken: 'PRIVATE_REMOTE_DETAIL' } : {}) } };
    } }) });
    await assert.rejects(f.client.send(input()), e => {
      assert.equal(e.message, 'whatsapp_delivery_unknown'); assert.equal(e.delivery_unknown, true); assert.equal(e.retryable, false);
      assert.equal(buildWhatsappOutboundRetryDecision({ error: e, retryOnFailure: true, maxAttempts: 5 }).should_retry, false); return true;
    }); assert.equal(calls, 1);
  }
});
test('accepted cached results preserve quality hold status with no extra attempt', async () => {
  let calls = 0; const f = fixture({ createTransport: () => ({ execute: async command => { calls++;
    return { requestId: command.requestId, replayed: true, data: { messages: [{ id: 'wamid.SYNTHETIC_ACCEPTED', message_status: 'held_for_quality_assessment' }] } };
  } }) });
  assert.deepEqual(await f.client.send(input()), { messages: [{ id: 'wamid.SYNTHETIC_ACCEPTED', message_status: 'held_for_quality_assessment' }] });
  assert.equal(calls, 1);
});

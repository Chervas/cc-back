'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createWhatsappAuthorizedBrokerClient, validateConfiguration, configuration } = require('../../lib/whatsappAuthorizedBrokerClient');
const { requestIdFor } = require('../../lib/whatsappBrokerClient');
const { buildWhatsappOutboundRetryDecision } = require('../../lib/whatsapp-outbound-retry');
const staging = () => ({ RUNTIME_ROLE: 'api', JOB_RUNTIME_NAMESPACE: 'staging', QUEUE_PREFIX: 'staging', JOBS_WORKER_ENABLED: 'true' });
const binding = () => ({ connectionRef: 'wa:qa:123', authorizationId: 'a1234567-1234-4234-8234-123456789abc', clinicId: 123, assetId: 456,
  phoneId: '401', wabaId: '501', revision: 1, sendEnabled: true });
const config = () => ({ version: 1, origin: 'https://broker.example.invalid:8445', keyId: 'staging-whatsapp', audience: 'authorized-wa',
  messageNotBefore: '2026-09-15T00:00:00Z',
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
    loadMessage: async id => ({ id, conversation_id: 71, direction: 'outbound', status: 'pending', createdAt: '2026-09-15T00:01:00Z', metadata: {} }),
    loadConversation: async id => ({ id, clinic_id: 123 }),
    isBlocked: async id => { counters.blocks++; assert.equal(id, 123); return state.blocked; },
    createTransport: () => { counters.transports++; return { execute: async command => { calls.push(command);
      return { requestId: command.requestId, replayed: false, data: { messages: [{ id: 'wamid.SYNTHETIC_ACCEPTED', message_status: 'accepted' }] } }; } }; },
    ...overrides });
  return { state, client, calls, counters };
}
test('current appointment and patient import holds are checked before every provider dispatch', async () => {
  let reads = 0;
  const f = fixture({
    loadMessage: async id => ({ id, conversation_id: 71, direction: 'outbound', status: 'pending', createdAt: new Date(), metadata: { execution_id: 19 } }),
    loadConversation: async id => ({ id, clinic_id: 123, patient_id: 7 }),
    patientHeld: async () => false,
    loadExecution: async () => ({ id: 19, clinic_id: 123, trigger_entity_type: 'appointment', trigger_entity_id: 9 }),
    loadAppointment: async () => { reads++; return { id_cita: 9, clinica_id: 123, paciente_id: 7, source_system: reads === 2 ? 'cliniccloud' : null }; },
  });
  await assert.rejects(f.client.send(input()), { code: 'whatsapp_authorized_message_ineligible' });
  assert.equal(reads, 2); assert.equal(f.calls.length, 0);
});
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
  assert.equal(f.calls.length, 1); assert.equal(f.counters.blocks, 4);
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
  for (const code of ['invalid_signature', 'rate_limited', 'whatsapp_template_not_authorized']) {
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
test('cutoff, current status and accepted/unknown/quarantined metadata block before transport', async () => {
  const eligible = { id: '123', conversation_id: 71, direction: 'outbound', status: 'pending', createdAt: '2026-09-15T00:01:00Z', metadata: {} };
  const changes = [{ createdAt: '2026-09-14T23:59:59Z' }, { createdAt: null }, { direction: 'inbound' },
    ...['sent','delivered','read','failed','cancelled','canceled','quarantined','hold','unknown'].map(status => ({ status })),
    ...[{ wamid: 'wamid.SYNTHETIC_ACCEPTED' }, { provider_acceptance_status: 'accepted' }, { provider_acceptance_at: '2026-09-15T00:01:00Z' },
      { wa_response: { messages: [{ id: 'wamid.SYNTHETIC_ACCEPTED' }] } }, { delivery_unknown: true }, { quarantine: true },
      { error: 'meta_security_quarantine' }, { outbound_retry: { reason: 'delivery_unknown' } }].map(metadata => ({ metadata }))];
  for (const change of changes) {
    const f = fixture({ loadMessage: async () => ({ ...eligible, ...change }) });
    await assert.rejects(f.client.send(input()), { code: 'whatsapp_authorized_message_ineligible' }); assert.equal(f.calls.length, 0);
  }
  const boundary = fixture({ loadMessage: async () => ({ ...eligible, createdAt: '2026-09-15T00:00:00Z', status: 'sending' }) });
  await boundary.client.send(input()); assert.equal(boundary.calls.length, 1);
});
test('Message and Conversation identity cannot be forged and are reread just before dispatch', async () => {
  const eligible = { id: '123', conversation_id: 71, direction: 'outbound', status: 'pending', createdAt: '2026-09-15T00:01:00Z', metadata: {} };
  for (const overrides of [{ loadMessage: async () => null }, { loadMessage: async () => ({ ...eligible, id: '124' }) },
    { loadConversation: async id => ({ id, clinic_id: 999 }) }, { loadConversation: async () => ({ id: 999, clinic_id: 123 }) }]) {
    const f = fixture(overrides); await assert.rejects(f.client.send(input()), { code: 'whatsapp_authorized_message_ineligible' }); assert.equal(f.calls.length, 0);
  }
  for (const status of ['cancelled', 'failed']) {
    let reads = 0; const f = fixture({ loadMessage: async () => ({ ...eligible, status: ++reads === 1 ? 'pending' : status }) });
    await assert.rejects(f.client.send(input()), { code: 'whatsapp_authorized_message_ineligible' }); assert.equal(reads, 2); assert.equal(f.calls.length, 0);
  }
});
test('public pre-mutation guard rejects failed and old rows before a worker can replace status', () => {
  const f = fixture(); const eligible = { direction: 'outbound', status: 'pending', createdAt: '2026-09-15T00:00:00Z', metadata: {} };
  assert.doesNotThrow(() => f.client.assertMessageEligible(eligible));
  assert.throws(() => f.client.assertMessageEligible({ ...eligible, status: 'failed' }), { code: 'whatsapp_authorized_message_ineligible' });
  assert.throws(() => f.client.assertMessageEligible({ ...eligible, createdAt: '2026-09-14T00:00:00Z' }), { code: 'whatsapp_authorized_message_ineligible' });
  f.state.config = null; assert.doesNotThrow(() => f.client.assertMessageEligible({ ...eligible, status: 'failed' }));
});
test('the cutover is mandatory private configuration and cannot be supplied by a send caller', async () => {
  const value = config(); delete value.messageNotBefore;
  assert.throws(() => validateConfiguration(value), { code: 'whatsapp_authorized_configuration_invalid' });
  for (const cutoff of ['invalid', null, 1, '2026-09-15']) assert.throws(() => validateConfiguration({ ...config(), messageNotBefore: cutoff }));
  const f = fixture(); await assert.rejects(f.client.send({ ...input(), messageNotBefore: '2000-01-01T00:00:00Z' }), { code: 'whatsapp_authorized_request_invalid' });
  assert.equal(f.calls.length, 0);
});

'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createWhatsappBrokerClient, requestIdFor } = require('../../lib/whatsappBrokerClient');
const { buildWhatsappOutboundRetryDecision, classifyRetryableWhatsappFailure } = require('../../lib/whatsapp-outbound-retry');
const input = () => ({ messageId: '123', clinicId: 123, assetId: 456, operation: 'meta.whatsapp.text.send.v1', payload: { to: '34000000123', body: 'QA', previewUrl: false } });
const row = () => ({ connectionRef: 'connection:wa-qa', phoneId: '401', clinicId: 123, assetId: 456, revision: 1, active: true });
const staging = () => ({ RUNTIME_ROLE: 'api', JOB_RUNTIME_NAMESPACE: 'staging', QUEUE_PREFIX: 'staging', JOBS_WORKER_ENABLED: 'true' });
const accepted = request => ({ requestId: request.requestId, replayed: false, data: { messageId: 'wamid.FICTITIOUS_ACCEPTED' } });
test('WhatsApp client denies DEV, gateway and paused staging before binding or network access', async () => {
  for (const change of [{ JOB_RUNTIME_NAMESPACE: 'dev' }, { RUNTIME_ROLE: 'gateway' }, { QUEUE_PREFIX: 'gateway' }, { JOBS_WORKER_ENABLED: 'false' }, { RUNTIME_ROLE: undefined }]) {
    let touched = 0;
    const client = createWhatsappBrokerClient({ client: { execute: async () => { touched++; } }, loadBinding: async () => { touched++; }, environment: () => ({ ...staging(), ...change }) });
    await assert.rejects(client.send(input()), { code: 'whatsapp_broker_runtime_denied' }); assert.equal(touched, 0);
  }
});
test('stable Message identity and server binding determine intent and number', async () => {
  const calls = []; let loads = 0;
  const client = createWhatsappBrokerClient({ client: { execute: async req => { calls.push(req); return accepted(req); } },
    loadBinding: async (clinicId, assetId) => { loads++; assert.equal(clinicId, 123); assert.equal(assetId, 456); return row(); }, environment: staging });
  const result = await client.send(input()); await client.send({ ...input(), payload: { ...input().payload, body: 'changed' } });
  assert.equal(loads, 4); assert.equal(calls[0].requestId, calls[1].requestId); assert.equal(calls[0].requestId, requestIdFor('123'));
  assert.notEqual(requestIdFor('123'), requestIdFor('124')); assert.equal(calls[0].assetRef, 'wa-phone:401'); assert.equal(calls[0].tenantRef, 'clinic:123');
  assert.equal(result.providerMessageId, 'wamid.FICTITIOUS_ACCEPTED');
});
test('caller cannot override connection, identity or send an unsupported operation', async () => {
  let calls = 0; const client = createWhatsappBrokerClient({ client: { execute: async () => { calls++; } }, loadBinding: async () => row(), environment: staging });
  for (const change of [{ connectionRef: 'foreign' }, { messageId: '../12' }, { messageId: 123 }, { clinicId: '123' }, { operation: 'meta.whatsapp.template.create.v1' }]) {
    await assert.rejects(client.send({ ...input(), ...change }), { code: 'whatsapp_broker_request_invalid' });
  }
  assert.equal(calls, 0);
});
for (const change of [{ clinicId: 999 }, { assetId: 999 }, { active: false }, { revision: 0 }, { accessToken: 'FICTITIOUS_FORBIDDEN_TOKEN' }]) test('invalid server binding fails before request: ' + Object.keys(change)[0], async () => {
  let calls = 0; const client = createWhatsappBrokerClient({ client: { execute: async () => { calls++; } }, loadBinding: async () => ({ ...row(), ...change }), environment: staging });
  await assert.rejects(client.send(input()), { code: 'whatsapp_broker_binding_invalid' }); assert.equal(calls, 0);
});
test('changed binding or malformed receipt after execution is unknown delivery and never retried automatically', async () => {
  for (const scenario of ['changed', 'missing', 'receipt', 'request', 'runtime', 'timeout']) {
    let loads = 0; let calls = 0; let env = staging();
    const client = createWhatsappBrokerClient({ client: { execute: async req => {
      calls++; if (scenario === 'timeout') throw Object.assign(Error('PRIVATE_DETAIL'), { status: 503 });
      if (scenario === 'runtime') env = { ...env, JOBS_WORKER_ENABLED: 'false' };
      return scenario === 'receipt' ? { ...accepted(req), data: { messageId: 'bad', accessToken: 'PRIVATE_DETAIL' } }
        : scenario === 'request' ? { ...accepted(req), requestId: requestIdFor('456') } : accepted(req);
    } }, loadBinding: async () => { loads++; return loads > 1 && scenario === 'missing' ? null : { ...row(), revision: loads > 1 && scenario === 'changed' ? 2 : 1 }; }, environment: () => env });
    await assert.rejects(client.send(input()), e => {
      assert.equal(e.code, 'whatsapp_delivery_unknown'); assert.equal(e.delivery_unknown, true); assert.equal(e.retryable, false); assert(!e.message.includes('PRIVATE_DETAIL'));
      assert.equal(buildWhatsappOutboundRetryDecision({ error: e, retryOnFailure: true, maxAttempts: 5 }).should_retry, false); return true;
    }); assert.equal(calls, 1);
  }
});
test('explicit unknown delivery takes precedence over HTTP and network retry hints', () => {
  for (const hint of [{ status: 503 }, { code: 'ECONNREFUSED' }, { response: { status: 429, data: { error: { is_transient: true } } } }]) {
    const value = classifyRetryableWhatsappFailure({ ...hint, delivery_unknown: true }); assert.equal(value.retryable, false); assert.equal(value.reason, 'delivery_unknown');
  }
  assert.equal(classifyRetryableWhatsappFailure({ code: 'ECONNREFUSED' }).retryable, true);
  assert.equal(classifyRetryableWhatsappFailure({ code: 'ECONNRESET' }).retryable, false);
  assert.equal(classifyRetryableWhatsappFailure({ response: { status: 503 } }).retryable, true);
});

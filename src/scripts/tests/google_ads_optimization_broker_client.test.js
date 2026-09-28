'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { scopeFixture } = require('./fixtures/google_ads_broker_scope.fixture');
const { createGoogleAdsOptimizationBrokerClient } = require('../../services/googleAdsOptimizationBrokerClient.service');
const { createConfiguredGoogleAdsOptimizationClient } = require('../../services/googleAdsBroker.service');
const C = require('../../../services/integrations-broker/src/google-optimization-write-contract');
async function fixture() {
  const f = scopeFixture(); const context = await f.service.prepare(f.mapping);
  const local = { at: Date.now(), allowed: true, enabled: true, identity: 'a'.repeat(64), calls: [] };
  const input = { executionId: randomUUID(), mandateId: randomUUID(), evidenceFingerprint: 'b'.repeat(64), expiresAt: local.at + 60000,
    campaignId: '30', kind: 'manual_cpc', resourceId: '50', adGroupId: null, baselineAdId: null, before: '1000000', after: '950000' };
  const client = createGoogleAdsOptimizationBrokerClient({ assertContext: f.service.assertContext, now: () => local.at, enabled: () => local.enabled,
    client: { identity: () => local.identity, execute: async command => {
      local.calls.push(structuredClone(command));
      const result = { requestId: command.requestId, data: { executionId: command.payload.executionId,
        state: 'applied', result: { acknowledged: true, resourceName: C.mutation(input, f.mapping.customerId).resourceName } } };
      await local.after?.(result); return result;
    } } });
  const authority = await client.authority(context);
  const invoke = (family = 'apply', value = input, patch = {}) => client.execute(context, family, value, {
    requestId: input.executionId, authority, beforeExecute: async () => local.allowed, ...patch,
  });
  return { ...f, client, local, input, context, authority, invoke };
}
test('typed writer sends only the stored operation and exact scope, never consumer HTTP or credentials', async () => {
  const f = await fixture(); assert.equal((await f.invoke()).state, 'applied');
  assert.deepEqual(f.local.calls[0], { requestId: f.input.executionId, operation: C.OPERATIONS.apply,
    connectionRef: f.binding.connection_ref, assetRef: f.binding.asset_ref, tenantRef: 'clinic:59', payload: f.input });
  assert.equal((await f.invoke('status', { executionId: f.input.executionId })).state, 'applied');
  assert.deepEqual(Object.keys(f.local.calls[1].payload), ['executionId']);
});
test('missing guard, persisted authority, caller request ID and injected payload are rejected before transport', async () => {
  const f = await fixture();
  for (const options of [{ requestId: undefined }, { authority: undefined }, { beforeExecute: undefined }, { beforeExecute: async () => false },
    { timeoutMs: 30001 }, { headers: { authorization: 'private' } }]) await assert.rejects(f.invoke('apply', f.input, options));
  for (const patch of [{ accessToken: 'private' }, { query: 'SELECT *' }, { customerId: '9999999999' }, { kind: 'create' }]) {
    await assert.rejects(f.invoke('apply', { ...f.input, ...patch }), { code: 'invalid_request' });
  }
  await assert.rejects(f.client.authority({}), { code: 'broker_binding_invalid' }); assert.equal(f.local.calls.length, 0);
});
test('revocation, rebind, writer identity and closed local gates are checked before and after transport', async () => {
  for (const phase of ['before', 'after']) for (const mutate of [f => { f.local.allowed = false; }, f => { f.local.enabled = false; },
    f => { f.binding.state = 'revoked'; }, f => { f.local.identity = 'c'.repeat(64); },
    f => { f.mapping.broker_read_connection_ref = f.binding.connection_ref = 'connection:changed'; }]) {
    const f = await fixture(); if (phase === 'before') mutate(f); else f.local.after = () => mutate(f);
    await assert.rejects(f.invoke()); assert.equal(f.local.calls.length, phase === 'before' ? 0 : 1);
  }
});
test('malformed, cross-account and secret-bearing receipts cannot leave the client', async () => {
  const changes = [response => { response.requestId = randomUUID(); }, response => { response.data.executionId = randomUUID(); },
    response => { response.data.result.resourceName = response.data.result.resourceName.replace('1234567890', '9999999999'); },
    response => { response.data.result.resourceName = [response.data.result.resourceName]; },
    response => { response.data.result.accessToken = 'private'; }, response => { response.data.ignored = 'private'; },
    response => { response.data.state = 'unknown'; response.data.result = null; }];
  for (const mutate of changes) { const f = await fixture(); f.local.after = mutate; await assert.rejects(f.invoke(), { code: 'broker_response_invalid' }); }
});
test('expiry, elapsed request deadline and a non-finite clock never yield success or an automatic retry', async () => {
  for (const mode of ['expired', 'elapsed', 'rollback', 'nan']) {
    const f = await fixture(); if (mode === 'expired') f.input.expiresAt = f.local.at;
    else f.local.after = () => { f.local.at += mode === 'elapsed' ? 30000 : mode === 'rollback' ? -1 : NaN; };
    await assert.rejects(f.invoke()); assert.equal(f.local.calls.length, mode === 'expired' ? 0 : 1);
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    const f = await fixture(); f.local.at = value;
    await assert.rejects(f.invoke(), { code: 'broker_timeout' }); assert.equal(f.local.calls.length, 0);
  }
});
test('configured writer is lazy, independently gated and refuses the same reader key under a different filename or ID', () => {
  const reader = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const writer = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const env = { GOOGLE_ADS_BROKER_KEY_ID: 'reader', GOOGLE_ADS_BROKER_KEY_FILE: '/fictitious/reader',
    GOOGLE_ADS_OPTIMIZATION_BROKER_ENABLED: 'false', GOOGLE_ADS_OPTIMIZATION_BROKER_ORIGIN: 'https://127.0.0.1:9443',
    GOOGLE_ADS_OPTIMIZATION_BROKER_AUDIENCE: 'fictitious-writer', GOOGLE_ADS_OPTIMIZATION_BROKER_KEY_ID: 'writer',
    GOOGLE_ADS_OPTIMIZATION_BROKER_KEY_FILE: '/fictitious/writer', GOOGLE_ADS_OPTIMIZATION_BROKER_CA_FILE: '/fictitious/ca' };
  let reads = 0, creates = 0, duplicate = false;
  const options = { env, readPrivateFile: name => { reads++; return name.endsWith('/ca') ? Buffer.from('fictitious-ca') : name.endsWith('/reader') || duplicate ? reader : writer; },
    createClient: config => { creates++; assert.equal(config.privateKey, writer); return { execute: value => value }; } };
  const client = createConfiguredGoogleAdsOptimizationClient(options); assert.equal(reads, 0);
  assert.throws(() => client.identity(), { code: 'broker_cohort_disabled' }); assert.equal(reads, 0);
  env.GOOGLE_ADS_OPTIMIZATION_BROKER_ENABLED = 'true'; duplicate = true;
  assert.throws(() => client.identity(), { code: 'broker_configuration_invalid' }); assert.equal(creates, 0);
  duplicate = false; const identity = client.identity(); assert.match(identity, /^[a-f0-9]{64}$/);
  assert.equal(client.identity(), identity); assert.equal(creates, 1); assert.deepEqual(client.execute({ test: true }), { test: true });
  env.GOOGLE_ADS_OPTIMIZATION_BROKER_KEY_ID = 'changed'; assert.throws(() => client.identity(), { code: 'broker_configuration_invalid' });
  env.GOOGLE_ADS_OPTIMIZATION_BROKER_KEY_ID = 'reader';
  assert.throws(() => createConfiguredGoogleAdsOptimizationClient(options).identity(), { code: 'broker_configuration_invalid' });
});
function reviewFixture(f) {
  const input = { submission: f.input, actorId: 7, confirmed: true, value: f.input.before, observedAt: f.local.at };
  const data = { executionId: f.input.executionId, state: 'reviewed', result: { reviewedAt: f.local.at, observedAt: f.local.at,
    reviewedBy: 7, value: f.input.before, resourceName: C.mutation(f.input, f.mapping.customerId).resourceName, previousState: 'unknown' } };
  f.local.after = response => { response.data = structuredClone(data); };
  return { input, data };
}
test('manual review uses an exact signed envelope and a bounded receipt, distinct from provider acknowledgement', async () => {
  const f = await fixture(); const { input, data } = reviewFixture(f);
  assert.deepEqual(await f.invoke('review', input), data);
  assert.equal(f.local.calls[0].operation, C.OPERATIONS.review); assert.deepEqual(f.local.calls[0].payload, input);
  assert.deepEqual(await f.invoke('status', { executionId: f.input.executionId }), data);
  await assert.rejects(f.invoke(), { code: 'broker_response_invalid' });
  for (const patch of [{ token: 'private' }, { actorId: 0 }, { confirmed: false }, { value: 'private' }, { observedAt: NaN }]) {
    await assert.rejects(f.invoke('review', { ...input, ...patch }), { code: 'invalid_request' });
  }
  assert.equal(f.local.calls.length, 3);
});
test('malformed, cross-resource and secret-bearing manual receipts fail closed', async () => {
  const changes = [d => { d.executionId = randomUUID(); }, d => { d.state = 'applied'; },
    d => { d.result.resourceName = d.result.resourceName.replace('/50', '/51'); },
    d => { d.result.resourceName = d.result.resourceName.replace('1234567890', '9999999999'); },
    d => { d.result.accessToken = 'private'; }, d => { d.result.value = 'PRIVATE'; },
    d => { d.result.value = '0'; }, d => { d.result.value = '0.5'; }, d => { d.result.reviewedAt--; },
    d => { d.result.observedAt = NaN; }, d => { d.result.reviewedBy = 2147483648; },
    d => { d.result.previousState = 'verified'; }, d => { d.result = null; }];
  for (const change of changes) {
    const f = await fixture(); const { input, data } = reviewFixture(f); change(data);
    await assert.rejects(f.invoke('review', input), { code: 'broker_response_invalid' }); assert.equal(f.local.calls.length, 1);
  }
});

'use strict';
require('./fixtures/security_offline_runtime.cjs');
const { test } = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createGoogleAdsBroker } = require('../../services/googleAdsBroker.service');
const { scopeFixture } = require('./fixtures/google_ads_broker_scope.fixture');
const C = require('../../../services/integrations-broker/src/google-destination-contract');
const input = () => ({ planId: randomUUID(), targets: [{ event: 'lead', sources: ['WEB'] }] });
async function fixture() {
  const f = scopeFixture(), local = { at: 1, enabled: true, allowed: true, calls: [], guards: 0, planId: randomUUID() };
  const service = createGoogleAdsBroker({ ...f.options, destinationsEnabled: () => local.enabled, now: () => local.at,
    client: { execute: async (command, budget) => {
      local.calls.push({ command, budget }); await local.onCall?.();
      const family = Object.keys(C.OPERATIONS).find(key => C.OPERATIONS[key] === command.operation);
      const response = { requestId: command.requestId, data: {
        authorizationId: family === 'authorize' ? command.requestId : command.payload.authorizationId,
        planId: family === 'authorize' ? command.payload.planId : local.planId, state: family === 'revoke' ? 'revoked' : 'active',
        destinations: [{ event: 'lead', conversionActionId: '456', sources: ['WEB'] }] } };
      local.mutate?.(response); return response;
    } } });
  const context = await service.prepare(f.mapping);
  const beforeExecute = async () => { local.guards++; await local.onGuard?.(); return local.allowed; };
  const invoke = (family = 'authorize', payload = input(), options = {}) => service.destinations(f.mapping, context, family, payload,
    { requestId: randomUUID(), beforeExecute, ...options });
  return { ...f, local, service, context, invoke, beforeExecute };
}
test('three destination operations preserve caller UUID, opaque account scope and explicit guards', async () => {
  const f = await fixture(), requestId = randomUUID(), value = input();
  const result = await f.invoke('authorize', value, { requestId });
  assert.equal(result.authorizationId, requestId); assert.equal(result.planId, value.planId);
  assert.equal((await f.invoke('status', { authorizationId: requestId })).state, 'active');
  assert.equal((await f.invoke('revoke', { authorizationId: requestId })).state, 'revoked');
  assert.equal(f.local.guards, 6);
  for (const { command, budget } of f.local.calls) {
    assert.equal(command.assetRef, f.binding.asset_ref); assert.equal(command.tenantRef, 'clinic:59');
    assert.equal(command.connectionRef, f.binding.connection_ref); assert(budget.timeoutMs > 0 && budget.timeoutMs <= 30000);
  }
  assert.equal(require.cache[require.resolve('../../../models')], undefined);
});
test('early withdrawal receipt is bound to the original plan and selection', async () => {
  const f = await fixture(), value = input(); f.local.planId = value.planId;
  const payload = { authorizationId: randomUUID(), input: value };
  assert.equal((await f.invoke('revoke', payload)).state, 'revoked');
  for (const mutate of [r => { r.data.planId = randomUUID(); }, r => { r.data.destinations[0].sources = ['OTHER']; },
    r => { r.data.destinations[0].event = 'schedule'; }]) {
    f.local.mutate = mutate;
    await assert.rejects(f.invoke('revoke', payload), { code: 'broker_response_invalid' });
  }
});
test('destination enrollment is disabled unless every explicit flag is true', async () => {
  const keys = ['GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED', 'GOOGLE_ADS_ACTION_MANAGEMENT_BROKER_ENABLED', 'GOOGLE_ADS_DESTINATIONS_BROKER_ENABLED'];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const values of [[undefined, undefined, undefined], ['true', 'true', undefined], ['true', undefined, 'true'], [undefined, 'true', 'true'], ['true', 'true', '1']]) {
      values.forEach((value, i) => { if (value === undefined) delete process.env[keys[i]]; else process.env[keys[i]] = value; });
      const f = scopeFixture(); let calls = 0;
      const service = createGoogleAdsBroker({ ...f.options, client: { execute: async () => { calls++; } } });
      await assert.rejects(service.destinations(f.mapping, await service.prepare(f.mapping), 'authorize', input(),
        { requestId: randomUUID(), beforeExecute: async () => true }), { code: 'broker_cohort_disabled' });
      assert.equal(calls, 0);
    }
  } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
});
test('missing journal UUID, guards, unsafe budgets and arbitrary destination IDs never reach transport', async () => {
  const f = await fixture();
  for (const [family, payload, options] of [['authorize', input(), { requestId: undefined }], ['authorize', input(), { beforeExecute: undefined }],
    ['authorize', input(), { timeoutMs: 30001 }], ['authorize', input(), { token: 'FICTITIOUS-SECRET' }],
    ['authorize', { ...input(), conversionActionId: '999' }, {}], ['authorize', { ...input(), targets: [{ event: 'lead', sources: ['ANY'] }] }, {}],
    ['authorize', { ...input(), targets: [{ event: 'lead', sources: ['WEB'], actionId: '999' }] }, {}],
    ['status', { authorizationId: 'invalid' }, {}], ['status', { authorizationId: randomUUID(), token: 'secret' }, {}], ['delete', {}, {}]]) {
    await assert.rejects(f.invoke(family, payload, options), { code: 'invalid_request' });
  }
  assert.equal(f.local.calls.length, 0);
});
test('forged context, other account, disabled mapping and revoked/shared grants cannot reach transport', async () => {
  for (const mode of ['context', 'account', 'mapping', 'grant', 'shared']) {
    const f = await fixture();
    if (mode === 'mapping') f.mapping.isActive = false;
    if (mode === 'grant') f.state.grants[0].status = 'revoked';
    if (mode === 'shared') f.state.shared.push({ assetId: 11, clinicaId: 999 });
    await assert.rejects(f.service.destinations(mode === 'account' ? { ...f.mapping, customerId: '1111111111' } : f.mapping,
      mode === 'context' ? {} : f.context, 'authorize', input(), { requestId: randomUUID(), beforeExecute: f.beforeExecute }),
    error => ['broker_binding_invalid', 'scope_denied'].includes(error.code));
    assert.equal(f.local.calls.length, 0);
  }
});
test('permission and scope changes at either side of the call discard the response without retry', async () => {
  const denied = await fixture(); denied.local.allowed = false;
  await assert.rejects(denied.invoke(), { code: 'scope_denied' }); assert.equal(denied.local.calls.length, 0);
  for (const mode of ['acl', 'grant', 'flag', 'timeout', 'guard_revocation']) {
    const f = await fixture();
    if (mode === 'guard_revocation') f.local.onGuard = () => { f.state.grants[0].status = 'revoked'; };
    else f.local.onCall = () => {
      if (mode === 'acl') f.local.allowed = false;
      if (mode === 'grant') f.state.grants[0].status = 'revoked';
      if (mode === 'flag') f.local.enabled = false;
      if (mode === 'timeout') f.local.at += 30000;
    };
    await assert.rejects(f.invoke(), { code: { acl: 'scope_denied', grant: 'scope_denied', flag: 'broker_cohort_disabled', timeout: 'broker_timeout', guard_revocation: 'scope_denied' }[mode] });
    assert.equal(f.local.calls.length, mode === 'guard_revocation' ? 0 : 1);
  }
});
test('closed response rejects foreign receipts, expanded permissions, duplicate IDs and free provider content', async () => {
  for (const mutate of [r => { r.requestId = randomUUID(); }, r => { r.data.authorizationId = randomUUID(); },
    r => { r.data.planId = randomUUID(); }, r => { r.data.state = 'revoked'; }, r => { r.data.token = 'FICTITIOUS-SECRET'; },
    r => { r.data.destinations[0].sources.push('OTHER'); }, r => { r.data.destinations[0].conversionActionId = 456; },
    r => { r.data.destinations[0].event = 'schedule'; }, r => { r.data.destinations[0].extra = 'raw'; },
    r => { r.data.destinations.push(r.data.destinations[0]); }, r => { r.data.destinations = []; }]) {
    const f = await fixture(); f.local.mutate = mutate;
    await assert.rejects(f.invoke(), { code: 'broker_response_invalid' }); assert.equal(f.local.calls.length, 1);
  }
  const status = await fixture(); status.local.mutate = r => { r.data.planId = 'foreign'; };
  await assert.rejects(status.invoke('status', { authorizationId: randomUUID() }), { code: 'broker_response_invalid' });
  const revoke = await fixture(); revoke.local.mutate = r => { r.data.state = 'active'; };
  await assert.rejects(revoke.invoke('revoke', { authorizationId: randomUUID() }), { code: 'broker_response_invalid' });
});
test('unknown failures expose only a fixed safe code and never retransmit', async () => {
  const f = await fixture(); f.local.onCall = () => { throw Error('FICTITIOUS-SECRET'); };
  await assert.rejects(f.invoke(), { code: 'google_destinations_broker_failed', message: 'google_destinations_broker_failed' });
  assert.equal(f.local.calls.length, 1);
});

test('closed human guard errors retain actionable session/pause/conflict semantics after transport', async () => {
  for (const code of ['google_destination_session_required', 'conversion_paused', 'google_destination_conflict']) {
    const f = await fixture(); f.local.onCall = () => { f.local.onGuard = () => { throw Object.assign(Error('PRIVATE'), { code }); }; };
    await assert.rejects(f.invoke(), { code }); assert.equal(f.local.calls.length, 1);
  }
});

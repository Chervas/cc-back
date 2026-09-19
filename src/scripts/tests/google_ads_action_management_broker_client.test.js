'use strict';
require('./fixtures/security_offline_runtime.cjs');
const { test } = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createGoogleAdsBroker } = require('../../services/googleAdsBroker.service');
const { scopeFixture } = require('./fixtures/google_ads_broker_scope.fixture');
const C = require('../../../services/integrations-broker/src/google-action-management-contract');
const input = () => ({ mode: 'create', currency: 'EUR', targets: [{ event: 'lead', actionId: null }] });
async function fixture() {
  const f = scopeFixture(), local = { at: 1, enabled: true, allowed: true, calls: [], guards: 0 };
  const changes = [{ event: 'lead', actionId: null, change: 'create' }];
  const service = createGoogleAdsBroker({ ...f.options, actionManagementEnabled: () => local.enabled, now: () => local.at,
    client: { execute: async (command, budget) => {
      local.calls.push({ command, budget }); await local.onCall?.(command);
      const family = Object.keys(C.OPERATIONS).find(key => C.OPERATIONS[key] === command.operation);
      const data = { planId: family === 'prepare' ? command.requestId : command.payload.planId,
        state: family === 'apply' ? 'applied' : 'prepared', expiresAt: 300000, changes: structuredClone(changes) };
      if (family !== 'prepare') data.results = family === 'apply' ? [{ event: 'lead', actionId: '456', change: 'create' }] : null;
      if (family === 'validate') data.validated = true;
      const response = { requestId: command.requestId, data }; local.mutate?.(response); return response;
    } } });
  const context = await service.prepare(f.mapping);
  const beforeExecute = async () => { local.guards++; await local.onGuard?.(); return local.allowed; };
  const invoke = (family = 'prepare', payload = input(), options = {}) => service.actionManagement(f.mapping, context, family, payload,
    { requestId: randomUUID(), beforeExecute, ...options });
  return { ...f, local, service, context, invoke, beforeExecute };
}
test('four operations retain the caller command UUID, opaque account scope and bounded metadata only', async () => {
  const f = await fixture(), requestId = randomUUID(), plan = await f.invoke('prepare', input(), { requestId });
  assert.equal(plan.planId, requestId); assert.equal(plan.state, 'prepared');
  assert.equal((await f.invoke('validate', { planId: requestId })).validated, true);
  assert.equal((await f.invoke('apply', { planId: requestId })).results[0].actionId, '456');
  assert.equal((await f.invoke('status', { planId: requestId })).planId, requestId);
  assert.equal(f.local.guards, 8);
  for (const { command, budget } of f.local.calls) {
    assert.equal(command.connectionRef, f.binding.connection_ref); assert.equal(command.assetRef, f.binding.asset_ref);
    assert.equal(command.tenantRef, 'clinic:59'); assert(budget.timeoutMs > 0 && budget.timeoutMs <= 30000);
    assert.deepEqual(Object.keys(command).sort(), ['assetRef', 'connectionRef', 'operation', 'payload', 'requestId', 'tenantRef']);
  }
  assert.equal(require.cache[require.resolve('../../../models')], undefined);
});
test('action management defaults closed independently of ordinary reads and Data Manager', async () => {
  const keys = ['GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED', 'GOOGLE_ADS_ACTION_MANAGEMENT_BROKER_ENABLED'];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const values of [[undefined, undefined], ['true', undefined], [undefined, 'true'], ['true', '1']]) {
      values.forEach((value, i) => { if (value === undefined) delete process.env[keys[i]]; else process.env[keys[i]] = value; });
      const f = scopeFixture(); let calls = 0;
      const service = createGoogleAdsBroker({ ...f.options, client: { execute: async () => { calls++; } } });
      await assert.rejects(service.actionManagement(f.mapping, await service.prepare(f.mapping), 'prepare', input(),
        { requestId: randomUUID(), beforeExecute: async () => true }), { code: 'broker_cohort_disabled' });
      assert.equal(calls, 0);
    }
  } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
});
test('no command without a caller UUID, explicit guard or closed typed payload', async () => {
  const f = await fixture();
  for (const [family, payload, options] of [['prepare', input(), { requestId: undefined }], ['prepare', input(), { beforeExecute: undefined }],
    ['prepare', input(), { timeoutMs: 30001 }], ['prepare', input(), { token: 'FICTITIOUS-SECRET' }],
    ['prepare', { ...input(), operations: [] }, {}], ['prepare', { ...input(), targets: [{ event: 'unreviewed', actionId: null }] }, {}],
    ['apply', { planId: randomUUID(), operations: [] }, {}], ['status', { planId: '123' }, {}], ['remove', {}, {}]]) {
    await assert.rejects(f.invoke(family, payload, options), { code: 'invalid_request' });
  }
  assert.equal(f.local.calls.length, 0);
});
test('forged context, changed account or mapping, revoked grant and outside sharing cannot call transport', async () => {
  for (const mode of ['context', 'account', 'mapping', 'grant', 'shared']) {
    const f = await fixture();
    if (mode === 'mapping') f.mapping.isActive = false;
    if (mode === 'grant') f.state.grants[0].status = 'revoked';
    if (mode === 'shared') f.state.shared.push({ assetId: 11, clinicaId: 999 });
    await assert.rejects(f.service.actionManagement(mode === 'account' ? { ...f.mapping, customerId: '1111111111' } : f.mapping,
      mode === 'context' ? {} : f.context, 'prepare', input(), { requestId: randomUUID(), beforeExecute: f.beforeExecute }),
    error => ['broker_binding_invalid', 'scope_denied'].includes(error.code));
    assert.equal(f.local.calls.length, 0);
  }
});
test('authorization guard and current scope are rechecked before and after the call', async () => {
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
    await assert.rejects(f.invoke(), { code: { acl: 'scope_denied', grant: 'scope_denied', flag: 'broker_cohort_disabled',
      timeout: 'broker_timeout', guard_revocation: 'scope_denied' }[mode] });
    assert.equal(f.local.calls.length, mode === 'guard_revocation' ? 0 : 1);
  }
});
test('callers cannot change the selected event while an authorization guard is pending', async () => {
  const f = await fixture(), value = input();
  f.local.onGuard = () => { value.targets[0].event = 'purchase'; value.currency = 'USD'; };
  await f.invoke('prepare', value);
  assert.deepEqual(f.local.calls[0].command.payload, input());
});
test('preparation rejects foreign plan IDs, unrequested events, malformed changes and provider content', async () => {
  for (const mutate of [r => r.requestId = randomUUID(), r => r.data.planId = randomUUID(), r => r.data.state = 'applied',
    r => r.data.expiresAt = 'tomorrow', r => r.data.changes = [], r => r.data.changes.push(r.data.changes[0]),
    r => r.data.changes[0].event = 'purchase', r => r.data.changes[0].actionId = '456',
    r => r.data.changes[0].change = 'normalize', r => r.data.changes[0].secret = 'FICTITIOUS-SECRET',
    r => r.data.results = [], r => r.data.details = 'FICTITIOUS-SECRET']) {
    const f = await fixture(); f.local.mutate = mutate;
    await assert.rejects(f.invoke(), error => error.code === 'broker_response_invalid' && error.message === error.code);
    assert.equal(f.local.calls.length, 1);
  }
});
test('normalization preserves the requested existing ID and accepts only its two reviewed outcomes', async () => {
  const f = await fixture(), value = { mode: 'normalize', currency: null, targets: [{ event: 'lead', actionId: '456' }] };
  for (const change of ['unchanged', 'normalize']) {
    f.local.mutate = r => { r.data.changes[0] = { event: 'lead', actionId: '456', change }; };
    assert.equal((await f.invoke('prepare', value)).changes[0].change, change);
  }
  f.local.mutate = r => { r.data.changes[0] = { event: 'lead', actionId: '789', change: 'normalize' }; };
  await assert.rejects(f.invoke('prepare', value), { code: 'broker_response_invalid' });
});
test('applied receipts require a result for every changed event, fixed IDs and no extra fields', async () => {
  for (const mutate of [r => r.data.state = 'prepared', r => r.data.results = null, r => r.data.results = [],
    r => r.data.results.push(r.data.results[0]), r => r.data.results[0].event = 'purchase', r => r.data.results[0].actionId = null,
    r => r.data.results[0].change = 'normalize', r => r.data.results[0].resourceName = 'FICTITIOUS-SECRET',
    r => { r.data.changes[0] = { event: 'lead', actionId: '789', change: 'normalize' }; r.data.results[0].change = 'normalize'; },
    r => r.data.changes.push({ event: 'contact', actionId: '456', change: 'unchanged' })]) {
    const f = await fixture(); f.local.mutate = mutate;
    await assert.rejects(f.invoke('apply', { planId: randomUUID() }), { code: 'broker_response_invalid' });
  }
});
test('status preserves attempted/unknown; validation never turns it into approved or silently accepts false', async () => {
  const f = await fixture(), value = { planId: randomUUID() };
  f.local.mutate = r => { r.data.state = 'attempted'; };
  assert.equal((await f.invoke('status', value)).state, 'attempted');
  await assert.rejects(f.invoke('validate', value), { code: 'broker_response_invalid' });
  f.local.mutate = r => { r.data.validated = false; };
  await assert.rejects(f.invoke('validate', value), { code: 'broker_response_invalid' });
  f.local.mutate = r => { r.data.results = []; };
  await assert.rejects(f.invoke('status', value), { code: 'broker_response_invalid' });
  f.local.mutate = r => { r.data.changes.push({ event: 'contact', actionId: '789', change: 'normalize' }); };
  await assert.rejects(f.invoke('status', value), { code: 'broker_response_invalid' });
});
test('applied no-op plans and completed validation replies remain recoverable with no invented results', async () => {
  const f = await fixture();
  f.local.mutate = r => {
    r.data.state = 'applied'; r.data.changes[0] = { event: 'lead', actionId: '456', change: 'unchanged' };
    r.data.results = []; delete r.data.validated;
  };
  for (const family of ['apply', 'validate', 'status']) assert.deepEqual((await f.invoke(family, { planId: randomUUID() })).results, []);
});
test('provider failures and lost acknowledgements never retry or replace command identity', async () => {
  for (const code of ['outcome_unknown', 'provider_timeout', 'action_plan_busy', 'action_plan_conflict', 'action_plan_expired', 'unreviewed']) {
    const f = await fixture(), requestId = randomUUID();
    f.local.onCall = () => { throw Object.assign(Error('FICTITIOUS-SECRET'), { code }); };
    await assert.rejects(f.invoke('apply', { planId: randomUUID() }, { requestId }),
      { code: code === 'unreviewed' ? 'google_action_management_broker_failed' : code });
    assert.equal(f.local.calls.length, 1); assert.equal(f.local.calls[0].command.requestId, requestId);
  }
});

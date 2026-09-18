'use strict';
require('./fixtures/security_offline_runtime.cjs');
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createGoogleAdsBroker } = require('../../services/googleAdsBroker.service');
const { scopeFixture } = require('./fixtures/google_ads_broker_scope.fixture');
const C = require('../../../services/integrations-broker/src/google-data-manager-contract');
const selection = () => ({ conversionActionId: '456', eventName: 'lead', eventSource: 'WEB' });
const payload = () => ({ ...selection(), event: { timestamp: '2026-09-18T10:00:00.000Z', transactionId: 'FICTITIOUS-ONLY', value: 0,
  currency: 'EUR', advertisingConsent: 'GRANTED', adUserData: null, adPersonalization: 'DENIED',
  clickId: { type: 'gbraid', value: 'FICTITIOUS-CLICK' }, userIdentifiers: [], enhancedPolicyDigest: null } });
async function fixture() {
  const f = scopeFixture(), state = { at: 1, enabled: true, allowed: true, calls: [], guards: 0 };
  const service = createGoogleAdsBroker({ ...f.options, conversionsEnabled: () => state.enabled, now: () => state.at,
    client: { execute: async (command, budget) => {
      state.calls.push({ command, budget }); await state.onCall?.(command);
      const data = command.operation === C.OPERATIONS.validate ? { validated: true, warningCount: 0 }
        : command.operation === C.OPERATIONS.ingest ? { accepted: true, submissionId: command.requestId, requestId: 'fictitious-provider', warningCount: 0 }
          : { requestStatusPerDestination: [] };
      const response = { requestId: command.requestId, data }; state.mutate?.(response); return response;
    } } });
  const context = await service.prepare(f.mapping);
  const beforeExecute = async () => { state.guards++; await state.onGuard?.(); return state.allowed; };
  const invoke = (family = 'ingest', input = payload(), options = {}) => service.conversion(f.mapping, context, family, input,
    { requestId: randomUUID(), beforeExecute, ...options });
  return { ...f, local: state, service, context, beforeExecute, invoke };
}
test('application facade binds all three conversion operations to the existing opaque Ads scope', async () => {
  const f = await fixture(), requestId = randomUUID();
  assert.deepEqual(await f.invoke('validate', selection()), { validated: true, warningCount: 0 });
  const result = await f.invoke('ingest', payload(), { requestId });
  assert.deepEqual(result, { accepted: true, submissionId: requestId, requestId: 'fictitious-provider', warningCount: 0 });
  assert.deepEqual(await f.invoke('status', { submissionId: requestId }, { expectedActionId: '456' }), { requestStatusPerDestination: [] });
  assert.equal(f.local.guards, 6);
  for (const { command, budget } of f.local.calls) {
    assert.equal(command.connectionRef, f.binding.connection_ref); assert.equal(command.assetRef, f.binding.asset_ref);
    assert.equal(command.tenantRef, 'clinic:59'); assert(budget.timeoutMs > 0 && budget.timeoutMs <= 30000);
    assert.deepEqual(Object.keys(command).sort(), ['assetRef', 'connectionRef', 'operation', 'payload', 'requestId', 'tenantRef']);
  }
  assert.equal(require.cache[require.resolve('../../../models')], undefined);
});
test('missing durable command ID, missing guard, arbitrary fields and provider IDs never reach the broker', async () => {
  const f = await fixture();
  for (const [family, input, options] of [['ingest', payload(), { requestId: undefined }],
    ['ingest', payload(), { beforeExecute: undefined }], ['ingest', payload(), { timeoutMs: 30001 }],
    ['ingest', { ...payload(), accessToken: 'FICTITIOUS-SECRET' }, {}],
    ['ingest', { ...payload(), event: { ...payload().event, advertisingConsent: 'DENIED' } }, {}],
    ['status', { requestId: 'foreign-provider-id' }, { expectedActionId: '456' }],
    ['status', { submissionId: randomUUID() }, {}], ['unknown', {}, {}]]) {
    await assert.rejects(f.invoke(family, input, options), { code: 'invalid_request' });
  }
  assert.equal(f.local.calls.length, 0);
});
test('default conversions flag remains closed even when ordinary Ads reads are enabled', async () => {
  const f = scopeFixture(); let calls = 0;
  const old = process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED; delete process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED;
  try {
    const service = createGoogleAdsBroker({ ...f.options, client: { execute: async () => { calls++; } } });
    const context = await service.prepare(f.mapping);
    await assert.rejects(service.conversion(f.mapping, context, 'validate', selection(), {
      requestId: randomUUID(), beforeExecute: async () => true }), { code: 'broker_cohort_disabled' });
    assert.equal(calls, 0);
  } finally { if (old === undefined) delete process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED; else process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED = old; }
});
test('forged contexts, changed mappings and revoked clinical grants fail before transport', async () => {
  for (const mode of ['context', 'account', 'grant', 'mapping', 'shared']) {
    const f = await fixture();
    if (mode === 'grant') f.state.grants[0].status = 'revoked';
    if (mode === 'mapping') f.mapping.isActive = false;
    if (mode === 'shared') f.state.shared.push({ assetId: 11, clinicaId: 999 });
    await assert.rejects(f.service.conversion(mode === 'account' ? { ...f.mapping, customerId: '1111111111' } : f.mapping,
      mode === 'context' ? {} : f.context, 'ingest', payload(), { requestId: randomUUID(), beforeExecute: f.beforeExecute }),
    error => ['broker_binding_invalid', 'scope_denied'].includes(error.code));
    assert.equal(f.local.calls.length, 0);
  }
});
test('clinical policy is re-read immediately before transport and after response', async () => {
  const paused = await fixture(); paused.local.allowed = false;
  await assert.rejects(paused.invoke(), { code: 'conversion_paused' }); assert.equal(paused.local.calls.length, 0);
  for (const mode of ['pause', 'revoke', 'timeout', 'flag', 'guard_changes_scope']) {
    const f = await fixture();
    if (mode === 'guard_changes_scope') f.local.onGuard = () => { f.state.grants[0].status = 'revoked'; };
    else f.local.onCall = () => {
      if (mode === 'pause') f.local.allowed = false;
      if (mode === 'revoke') f.state.grants[0].status = 'revoked';
      if (mode === 'timeout') f.local.at += 30000;
      if (mode === 'flag') f.local.enabled = false;
    };
    await assert.rejects(f.invoke(), { code: { pause: 'conversion_paused', revoke: 'scope_denied', timeout: 'broker_timeout',
      flag: 'broker_cohort_disabled', guard_changes_scope: 'scope_denied' }[mode] });
    assert.equal(f.local.calls.length, mode === 'guard_changes_scope' ? 0 : 1);
  }
});
test('caller mutations during authorization cannot change the frozen command payload', async () => {
  const f = await fixture(), input = payload(); f.local.onGuard = () => { input.event.value = 42; };
  await f.invoke('ingest', input); assert.equal(f.local.calls[0].command.payload.event.value, 0);
});
test('malformed acknowledgements and free provider fields are rejected without returning their contents', async () => {
  for (const mutate of [r => r.requestId = randomUUID(), r => r.data.submissionId = randomUUID(), r => r.data.accepted = false,
    r => r.data.requestId = 'FICTITIOUS SECRET', r => r.data.warningCount = 101, r => r.data.details = 'FICTITIOUS-SECRET']) {
    const f = await fixture(); f.local.mutate = mutate;
    await assert.rejects(f.invoke(), error => error.code === 'broker_response_invalid' && error.message === error.code);
    assert.equal(f.local.calls.length, 1);
  }
});
test('status accepts only the expected account/action, known projection and one submitted event', async () => {
  const f = await fixture();
  const status = () => ({ destination: { operatingAccount: { accountType: 'GOOGLE_ADS', accountId: f.mapping.customerId },
    loginAccount: { accountType: 'GOOGLE_ADS', accountId: f.mapping.loginCustomerId }, productDestinationId: '456' },
    requestStatus: 'SUCCESS', eventsIngestionStatus: { recordCount: 1 }, errorInfo: { errorCounts: [] }, warningInfo: { warningCounts: [] } });
  f.local.mutate = r => { r.data = { requestStatusPerDestination: [status()] }; };
  const result = await f.invoke('status', { submissionId: randomUUID() }, { expectedActionId: '456' });
  assert.equal(result.requestStatusPerDestination[0].requestStatus, 'SUCCESS');
  for (const mutate of [r => r.destination.operatingAccount.accountId = '1111111111', r => r.destination.productDestinationId = '999',
    r => r.eventsIngestionStatus.recordCount = 2, r => r.message = 'FICTITIOUS-SECRET', r => r.requestStatus = 'NEW_UNREVIEWED_STATUS']) {
    f.local.mutate = r => { const row = status(); mutate(row); r.data = { requestStatusPerDestination: [row] }; };
    await assert.rejects(f.invoke('status', { submissionId: randomUUID() }, { expectedActionId: '456' }), { code: 'broker_response_invalid' });
  }
});
test('unknown outcomes and provider timeouts never retry or replace the caller command ID', async () => {
  for (const code of ['outcome_unknown', 'provider_timeout', 'idempotency_conflict']) {
    const f = await fixture(), requestId = randomUUID();
    f.local.onCall = () => { throw Object.assign(Error('FICTITIOUS-SECRET'), { code }); };
    await assert.rejects(f.invoke('ingest', payload(), { requestId }), error => error.code === code && error.message === code);
    assert.equal(f.local.calls.length, 1); assert.equal(f.local.calls[0].command.requestId, requestId);
  }
  const f = await fixture(); f.local.onCall = () => { throw Error('FICTITIOUS-SECRET'); };
  await assert.rejects(f.invoke(), { code: 'google_data_manager_broker_failed', message: 'google_data_manager_broker_failed' });
});

'use strict';
const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { adsFixture, CUSTOMER, ASSET, ACCESS, DEVELOPER, MANAGER } = require('./google-ads-fixture.cjs');
const { optimizationRows, sectionForQuery } = require('./google-optimization-fixture.cjs');
const { targetRows } = require('./google-optimization-targets-fixture.cjs');
const { createGoogleOptimizationWrites } = require('../src/google-optimization-writes');
const { createGoogleAdsDeveloperSecret } = require('../src/google-ads-developer-secret');
const { Broker } = require('../src/broker'); const { BrokerStore } = require('../src/store');
const { signRequest } = require('../src/auth'); const C = require('../src/google-optimization-write-contract');
const runtime = require('../src/google-main');
function setup(t) {
  const f = adsFixture(t); const keys = generateKeyPairSync('ed25519');
  const principal = { ...f.policy.principals[0], id: 'optimization:test', keyId: 'optimization-key', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
  f.policy.principals.push(principal);
  f.policy.grants.push({ ...f.policy.grants[0], principalId: principal.id, operations: Object.values(C.OPERATIONS) });
  f.binding.googleAdsOptimization = { accounts: [{ assetRef: ASSET, campaigns: [{ campaignId: '30', kinds: C.KINDS,
    maxBidMicros: '100000000', maxTargetRoas: '10', maxDailyBudgetMicros: '100000000', allowBudgetIncrease: false }] }] };
  const state = { at: Date.now(), writes: 0, reads: 0, calls: [], sdk: f.state.sdk, rows: optimizationRows() };
  state.rows.campaign[0].customer.timeZone = 'Europe/Madrid';
  const http = async request => {
    if (request.hostname === 'oauth2.googleapis.com') return f.http(request);
    assert.equal(request.token.toString(), ACCESS); assert.equal(request.developerToken.toString(), DEVELOPER); assert.equal(request.loginCustomerId, MANAGER);
    state.calls.push({ path: request.path, json: structuredClone(request.json) });
    if (request.path.endsWith('/googleAds:search')) {
      state.reads++; await state.onRead?.(request);
      return state.readResponse ? state.readResponse(request) : { results: structuredClone(state.rows[sectionForQuery(request.json.query)]) };
    }
    C.validateMutation(request.path, request.optimizationMutation, request.json);
    state.writes++; await state.afterWrite?.(request);
    return state.response || { results: [{ resourceName: request.json.operations[0].update.resourceName }] };
  };
  const withDeveloperSecret = createGoogleAdsDeveloperSecret({ client: f.sdk, accountId: runtime.ACCOUNT,
    prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtime.SECRET_KEY });
  let store = f.store, broker;
  const build = destination => new Broker({ store: destination, policy: f.policy, secrets: f.secrets, now: () => state.at,
    operations: { ...f.engine.operations, ...createGoogleOptimizationWrites({ store: destination, http, withDeveloperSecret, now: () => state.at }).operations } });
  const reset = () => { broker = build(store); };
  reset();
  const command = (kind, input, extra = {}) => f.command('account', {}, { operation: C.OPERATIONS[kind], payload: input, ...extra });
  const send = (destination, value, signing = {}) => { const signed = signRequest(value, { keyId: principal.keyId, privateKey: keys.privateKey,
    audience: f.policy.audience, now: state.at, ...signing }); return destination.execute(signed.raw, signed.headers); };
  const execute = (value, signing) => send(broker, value, signing);
  const input = (kind = 'pause_ad') => ({ executionId: randomUUID(), mandateId: randomUUID(), evidenceFingerprint: 'a'.repeat(64),
    expiresAt: state.at + 60000, campaignId: '30', kind, resourceId: kind === 'pause_ad' ? '60' : kind === 'daily_budget' ? '40' : kind === 'manual_cpc' ? '50' : '30',
    adGroupId: kind === 'pause_ad' ? '50' : null, baselineAdId: kind === 'pause_ad' ? '61' : null,
    before: kind === 'pause_ad' ? 'ENABLED' : kind === 'manual_cpc' ? '1500000' : C.ratioKind(kind) ? '4' : '20000000',
    after: kind === 'pause_ad' ? 'PAUSED' : kind === 'manual_cpc' ? '1425000' : C.ratioKind(kind) ? '3.8' : kind === 'daily_budget' ? '19000000' : '21000000' });
  return { ...f, state, readState: f.state, keys, readerKeys: f.keys, principal, http, command, execute, input, reset, getStore: () => store, getBroker: () => broker,
    fork() { const other = new BrokerStore(f.filename); const peer = build(other); t.after(() => other.close());
      return { execute: value => send(peer, value), store: other }; },
    status: async executionId => (await execute(command('status', { executionId }))).data,
    target(kind) { const strategy = { target_cpa: 'TARGET_CPA', maximize_conversions_cpa: 'MAXIMIZE_CONVERSIONS',
      target_roas: 'TARGET_ROAS', maximize_conversion_value_roas: 'MAXIMIZE_CONVERSION_VALUE' }[kind];
      if (strategy) { const rows = targetRows(strategy); state.rows.campaign = rows.campaign; state.rows.ad_groups = rows.ad_groups; } },
    reopen() { store.close(); store = new BrokerStore(f.filename); reset(); t.after(() => { try { store.close(); } catch {} }); } };
}
module.exports = { setup };

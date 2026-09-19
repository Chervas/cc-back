'use strict';
require('./fixtures/security_offline_runtime.cjs');
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { createGoogleAdsBrokerReader } = require('../../services/googleAdsBrokerReader.service');
const contract = require('../../../services/integrations-broker/src/google-ads-contract');
const account = { customerId: '1234567890', tenantRef: 'clinic:59', assetRef: 'ads:1234567890', connectionRef: 'connection:fictitious' };
function row(id = '1', date = '2026-09-01') {
  return { customer: { id: account.customerId }, campaign: { id, name: 'Fictitious', status: 'ENABLED' },
    segments: { date, device: 'MOBILE', adNetworkType: 'SEARCH' }, metrics: { clicks: '2' } };
}
const payload = { startDate: '2026-09-01', endDate: '2026-09-02' };
function fixture() {
  const context = Object.freeze({}); const state = { calls: [], checks: 0, at: 1, blocked: false, response: { results: [row()], nextPageToken: null } };
  const reader = createGoogleAdsBrokerReader({ now: () => state.at,
    assertContext: async value => { state.checks++; assert.equal(value, context); if (state.blocked) throw Object.assign(Error('blocked'), { code: 'asset_revoked' }); return structuredClone(account); },
    client: { execute: async (command, options) => {
      state.calls.push({ command, options }); await state.onCall?.(command);
      return { requestId: state.badRequestId || command.requestId, data: structuredClone(state.response) };
    } },
  });
  return { state, reader, context, read: (family = 'campaign_metrics', input = payload, budget) => reader.read(context, family, input, budget) };
}
test('opaque authorization is revalidated around every page and only typed fields cross the service boundary', async () => {
  const f = fixture();
  f.state.onCall = () => { f.state.response = f.state.calls.length === 1 ? { results: [row()], nextPageToken: 'opaque-next' }
    : { results: [row('2')], nextPageToken: null }; };
  const rows = await f.read();
  assert.equal(rows.length, 2); assert.equal(f.state.calls.length, 2); assert.equal(f.state.checks, 6);
  for (const { command, options } of f.state.calls) {
    assert.equal(command.operation, 'google.ads.campaign_metrics.read.v1');
    assert.equal(command.assetRef, account.assetRef); assert.equal(command.connectionRef, account.connectionRef);
    assert.deepEqual(Object.keys(command.payload).sort(), ['endDate', 'pageToken', 'startDate']);
    assert.ok(options.timeoutMs <= 30000);
  }
  assert.equal(f.state.calls[1].command.payload.pageToken, 'opaque-next');
});
test('invalid family, token cursor injection, dates and arbitrary payload keys are rejected before authorization or transport', async () => {
  const f = fixture();
  for (const [family, input] of [['mutate', {}], ['campaign_metrics', { ...payload, pageToken: null }],
    ['campaign_metrics', { ...payload, query: 'SELECT *' }], ['campaign_metrics', { ...payload, startDate: '2026-02-30' }],
    ['ads', { campaignId: '1 OR 1=1' }]]) await assert.rejects(f.read(family, input), { code: 'invalid_request' });
  assert.equal(f.state.checks, 0); assert.equal(f.state.calls.length, 0);
  await assert.rejects(f.reader.read({ ...account }, 'account', {}));
  assert.equal(f.state.calls.length, 0);
});
test('a revocation or deadline during a broker call discards every collected row', async () => {
  for (const mode of ['blocked', 'timeout']) {
    const f = fixture(); f.state.onCall = () => { if (mode === 'blocked') f.state.blocked = true; else f.state.at += 1000; };
    await assert.rejects(f.read('campaign_metrics', payload, { timeoutMs: 100 }), { code: mode === 'blocked' ? 'asset_revoked' : 'broker_timeout' });
    assert.equal(f.state.calls.length, 1);
  }
});
test('cross-page duplicates, resource mutations, cursor loops and malformed acknowledgements never produce partial results', async () => {
  for (const mode of ['duplicate', 'mutation', 'loop', 'ack', 'foreign', 'empty', 'partial', 'oversize']) {
    const f = fixture(); f.state.onCall = command => {
      if (f.state.calls.length === 1) { f.state.response = { results: [row()], nextPageToken: 'opaque-next' }; return; }
      const value = row('2');
      f.state.response = { results: [value], nextPageToken: null };
      if (mode === 'duplicate') f.state.response.results = [row()];
      if (mode === 'mutation') { const changed = row('1', '2026-09-02'); changed.campaign.name = 'Changed'; f.state.response.results = [changed]; }
      if (mode === 'loop') f.state.response.nextPageToken = 'opaque-next';
      if (mode === 'ack') f.state.badRequestId = 'wrong-request-id';
      if (mode === 'foreign') value.customer.id = '9999999999';
      if (mode === 'empty') { f.state.response.results = []; f.state.response.nextPageToken = 'opaque-another'; }
      if (mode === 'partial') f.state.response.error = { code: 3 };
      if (mode === 'oversize') f.state.response.results = Array(251).fill(value);
    };
    await assert.rejects(f.read(), { code: 'broker_response_invalid' });
    assert.equal(f.state.calls.length, 2);
  }
});
test('all read families use the same complete-page validator and downstream errors are sanitized', async () => {
  const f = fixture();
  for (const family of contract.FAMILIES) {
    const input = family === 'account' ? {} : family.endsWith('_metrics') || family === 'landing_pages' ? { ...payload } : {};
    if (['ads', 'ad_metrics'].includes(family)) input.campaignId = null;
    f.state.response = { results: ['account', 'discovery'].includes(family)
      ? [{ customer: { id: account.customerId, manager: false, currencyCode: 'EUR', timeZone: 'Europe/Madrid', ...(family === 'discovery' ? { descriptiveName: 'Fictitious account', status: 'ENABLED' } : {}) } }] : [], nextPageToken: null };
    if (family === 'conversion_settings') f.state.response = { results: [{ customer: { id: account.customerId, conversionTrackingSetting: {} } }], nextPageToken: null, dataManagerConfiguration: { quotaProjectConfigured: true } };
    assert.equal((await f.read(family, input)).length, contract.singleResult(family) ? 1 : 0);
  }
  f.state.onCall = () => { throw Error('FICTITIOUS_SECRET_NOT_FOR_LOGS'); };
  await assert.rejects(f.read(), error => { assert.equal(error.code, 'google_ads_broker_read_failed'); assert.doesNotMatch(error.message, /FICTITIOUS_SECRET/); return true; });
});

test('settings configuration must be a closed broker assertion and cannot arrive through provider rows', async () => {
  const f = fixture();
  const data = { results: [{ customer: { id: account.customerId, conversionTrackingSetting: { acceptedCustomerDataTerms: true } },
    dataManagerConfiguration: { quotaProjectConfigured: true } }], nextPageToken: null, dataManagerConfiguration: { quotaProjectConfigured: false } };
  f.state.response = data;
  const rows = await f.read('conversion_settings', {});
  assert.deepEqual(rows[0].dataManagerConfiguration, { quotaProjectConfigured: false });
  assert.equal(rows[0].customer.conversionTrackingSetting.enhancedConversionsForLeadsEnabled, null);
  for (const configuration of [undefined, {quotaProjectConfigured:'true'}, {quotaProjectConfigured:true,projectId:'private'}]) {
    f.state.response = { ...data, dataManagerConfiguration: configuration };
    await assert.rejects(f.read('conversion_settings', {}), { code: 'broker_response_invalid' });
  }
});

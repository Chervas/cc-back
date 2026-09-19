'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict');
const { adsDiscoveryFixture } = require('./fixtures/google_ads_discovery.fixture');
test('registered Ads inventory uses the actual reader and group tenant once for group and clinic aliases', async () => {
  const f = adsDiscoveryFixture(); f.state.mappings.push({ ...f.mapping, id: 12, assignmentScope: 'clinic', clinicaId: 71, customerId: '123-456-7890' });
  f.state.bindings.push({ ...f.binding, mapping_id: 12, scope_key: 'clinic:71' });
  const result = await f.service.list(f.request); assert.equal(result.accounts.length, 1); assert.equal(result.unavailableAccountCount, 0);
  assert.equal(result.accounts[0].customerId, '1234567890'); assert.equal(result.accounts[0].loginCustomerId, '9876543210');
  assert.equal(f.state.providerCalls.length, 1); assert.equal(f.state.providerCalls[0].tenantRef, 'clinic:59'); assert(f.state.validation > 5);
  assert.doesNotMatch(JSON.stringify(result), /fictitious-subject|connection:|broker_read|999|token/);
  await assert.rejects(f.service.assertLegacyAllowed(), { code: 'google_oauth_legacy_closed' });
});
test('pre-cut inventory returns null while registry errors, orphan rows and marked accounts fail closed', async () => {
  const f = adsDiscoveryFixture(); f.state.managed = false; assert.equal(await f.service.list(f.request), null);
  await f.service.assertLegacyAllowed(); assert.equal(f.state.providerCalls.length, 0);
  for (const mutate of [s => { s.registryFailed = true; }, s => { s.bindings = []; }, s => { s.mappings = []; },
    s => { s.bindings[0].state = 'blocked'; }, s => { s.mappings[0].broker_read_asset_ref = null; }, s => { s.connection.credentials_external = 0; }]) {
    const g = adsDiscoveryFixture(); mutate(g.state); await assert.rejects(g.service.list(g.request)); assert.equal(g.state.providerCalls.length, 0);
  }
});
test('typed managers remain identifiable; closed and canceled accounts are counted without being offered', async () => {
  const f = adsDiscoveryFixture(); f.state.manager = true;
  assert.equal((await f.service.list(f.request)).accounts[0].isManager, true);
  for (const status of ['CANCELED', 'CLOSED']) {
    f.state.accountStatus = status; assert.deepEqual(await f.service.list(f.request), { accounts: [], unavailableAccountCount: 1 });
  }
});
test('authorization, scope, registry and deadline changes during the provider await discard the entire inventory', async () => {
  for (const [mutate, code] of [[s => { s.allowed = false; }, 'google_discovery_scope_forbidden'],
    [s => { s.session = false; }, 'google_discovery_session_required'], [s => { s.enabled = false; }, 'broker_cohort_disabled'],
    [s => { s.bindings[0].state = 'blocked'; }, 'asset_revoked'], [s => { s.at = 61000; }, 'broker_timeout'],
    [s => { s.clinics.push({ id_clinica: 72, grupoClinicaId: 5 }); }, 'broker_binding_invalid']]) {
    const f = adsDiscoveryFixture(); f.state.afterCall = () => mutate(f.state);
    await assert.rejects(f.service.list(f.request), { code }); assert.equal(f.state.providerCalls.length, 1);
  }
});
test('a later account cannot hide revocation of an earlier successfully read account', async () => {
  const f = adsDiscoveryFixture(); f.state.mappings.push({ ...f.mapping, id: 12, customerId: '1111111111', broker_read_asset_ref: 'ads:1111111111' });
  f.state.bindings.push({ ...f.binding, customer_id: '1111111111', mapping_id: 12, asset_ref: 'ads:1111111111' });
  f.state.afterCall = () => { if (f.state.providerCalls.length === 2) f.binding.state = 'blocked'; };
  await assert.rejects(f.service.list(f.request), { code: 'broker_binding_invalid' }); assert.equal(f.state.providerCalls.length, 2);
});
test('slow metadata or session checks exhaust the budget before any provider dispatch', async () => {
  const f = adsDiscoveryFixture(); f.state.onRead = kind => { if (kind === 'connection') f.state.at = 61000; };
  await assert.rejects(f.service.list(f.request)); assert.equal(f.state.providerCalls.length, 0);
  const g = adsDiscoveryFixture(); g.state.onValidation = () => { if (g.state.validation === 4) g.state.at = 61000; };
  await assert.rejects(g.service.list(g.request)); assert.equal(g.state.providerCalls.length, 0);
});
test('suspended inventories hold four admission slots and release them without admitting an unbounded fifth request', async () => {
  const f = adsDiscoveryFixture(); let release; const pending = new Promise(resolve => { release = resolve; }); f.state.afterCall = () => pending;
  const requests = Array.from({ length: 4 }, () => f.service.list(f.request)); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.service.list(f.request), { code: 'broker_discovery_busy' }); assert.equal(f.state.providerCalls.length, 4);
  release(); await Promise.all(requests); await f.service.list(f.request);
});
test('bounded inventory rejects duplicate bindings, invalid scope and more than twenty distinct accounts before dispatch', async () => {
  const f = adsDiscoveryFixture(); f.state.bindings.push({ ...f.binding }); await assert.rejects(f.service.list(f.request));
  const g = adsDiscoveryFixture(); await assert.rejects(g.service.list({ ...g.request, scopeKey: 'clinic:59' }));
  const h = adsDiscoveryFixture(); h.state.bindings = []; h.state.mappings = [];
  for (let i = 1; i <= 21; i++) {
    const customer = String(1234567800 + i); h.state.bindings.push({ ...h.binding, mapping_id: i, customer_id: customer, asset_ref: 'ads:' + customer });
    h.state.mappings.push({ ...h.mapping, id: i, customerId: customer, broker_read_asset_ref: 'ads:' + customer });
  }
  await assert.rejects(h.service.list(h.request), { code: 'broker_discovery_limit' });
  for (const x of [f, g, h]) assert.equal(x.state.providerCalls.length, 0);
});

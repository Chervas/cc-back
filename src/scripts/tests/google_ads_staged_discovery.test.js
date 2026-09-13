'use strict';
require('./fixtures/security_offline_runtime.cjs');
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { adsDiscoveryFixture } = require('./fixtures/google_ads_discovery.fixture');
const { createGoogleAdsBrokerScope } = require('../../services/googleAdsBrokerScope.service');
const { createGoogleAdsBrokerReader } = require('../../services/googleAdsBrokerReader.service');
function staged() {
  const f = adsDiscoveryFixture(); f.mapping.isActive = false; f.binding.state = 'staged'; return f;
}
test('a staged account can be selected from typed discovery while sync/data contexts remain unavailable', async () => {
  const f = staged(); const result = await f.service.list(f.request);
  assert.equal(result.accounts[0].customerId, f.mapping.customerId); assert.equal(f.state.providerCalls.length, 1);
  assert.equal(result.accounts[0].broker_read_connection_ref, undefined);
  await assert.rejects(f.broker.prepare(f.mapping), { code: 'broker_binding_invalid' });
  const context = await f.broker.prepareDiscovery(f.mapping);
  await assert.rejects(f.broker.read(f.mapping, context, 'campaigns', {}), { code: 'broker_binding_invalid' });
  assert.equal(f.state.providerCalls.length, 1);
  const scope = createGoogleAdsBrokerScope({ ...f.options, discoveryOnly: true });
  const directContext = await scope.prepare(f.mapping);
  const reader = createGoogleAdsBrokerReader({ assertContext: scope.assertContext, client: { execute: () => assert.fail('must not dispatch') } });
  for (const family of ['account', 'campaigns', 'ads']) await assert.rejects(reader.read(directContext, family,
    family === 'ads' ? { campaignId: null } : {}), { code: 'operation_denied' });
});
test('deleted preparation, inconsistent activation and changed references cannot make an account selectable', async () => {
  for (const mutate of [f => { f.state.mappings = []; }, f => { f.state.bindings = []; },
    f => { f.mapping.isActive = true; }, f => { f.binding.state = 'active'; },
    f => { f.mapping.broker_read_asset_ref = null; }, f => { f.mapping.loginCustomerId = '1111111111'; },
    f => { f.binding.state = 'blocked'; }]) {
    const f = staged(); mutate(f); await assert.rejects(f.service.list(f.request)); assert.equal(f.state.providerCalls.length, 0);
  }
});
test('staged aliases keep group ownership and cannot enlarge the scope of an active read', async () => {
  const f = adsDiscoveryFixture();
  f.state.mappings.push({ ...f.mapping, id: 12, assignmentScope: 'clinic', clinicaId: 71, isActive: false });
  f.state.bindings.push({ ...f.binding, mapping_id: 12, scope_key: 'clinic:71', state: 'staged' });
  assert.equal((await f.service.list(f.request)).accounts.length, 1); assert.equal(f.state.providerCalls.length, 1);
  const active = await f.broker.prepare(f.mapping); assert.ok(active);
  const direct = { ...f.request, scopeKey: 'clinic:71', clinicIds: [71] };
  assert.equal((await f.service.list(direct)).accounts.length, 1);
  f.state.bindings[1].scope_key = 'clinic:99'; f.state.mappings[1].clinicaId = 99;
  await assert.rejects(f.broker.assert(f.mapping, active), { code: 'scope_denied' });
  await assert.rejects(f.service.list(f.request), { code: 'scope_denied' });
});
test('deleted staged aliases invalidate ordinary contexts as well as prepared discovery', async () => {
  const f = adsDiscoveryFixture();
  f.state.mappings.push({ ...f.mapping, id: 12, assignmentScope: 'clinic', clinicaId: 71, isActive: false });
  f.state.bindings.push({ ...f.binding, mapping_id: 12, scope_key: 'clinic:71', state: 'staged' });
  const active = await f.broker.prepare(f.mapping); f.state.mappings.pop();
  await assert.rejects(f.broker.assert(f.mapping, active), { code: 'broker_binding_invalid' });
  await assert.rejects(f.service.list(f.request), { code: 'broker_binding_invalid' });
  assert.equal(f.state.providerCalls.length, 0);
});
test('activation, sharing, permission loss and blocking during discovery discard the response', async () => {
  for (const mutate of [f => { f.mapping.isActive = true; f.binding.state = 'active'; },
    f => { f.state.shared.push({ assetId: 11, clinicaId: 99 }); }, f => { f.state.allowed = false; },
    f => { f.binding.state = 'blocked'; }, f => { f.state.connection.credentials_external = 0; }]) {
    const f = staged(); f.state.afterCall = () => mutate(f);
    await assert.rejects(f.service.list(f.request)); assert.equal(f.state.providerCalls.length, 1);
  }
});
test('the original staged context never becomes an active read context after activation', async () => {
  const f = staged(); const context = await f.broker.prepareDiscovery(f.mapping);
  f.mapping.isActive = true; f.binding.state = 'active';
  await assert.rejects(f.broker.assertDiscovery(f.mapping, context), { code: 'broker_binding_invalid' });
  await assert.rejects(f.broker.read(f.mapping, context, 'campaigns', {}), { code: 'broker_binding_invalid' });
  assert.ok(await f.broker.prepare(f.mapping)); assert.equal(f.state.providerCalls.length, 0);
});
test('selection captures preserve the original contexts across SQL validation and cannot be forged or reused after release', async () => {
  const f = staged(); const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const { selection, inventory } = await f.service.capture(f.request);
  assert.deepEqual(selection, {}); assert.ok(Object.isFrozen(selection));
  inventory.accounts[0].customerId = '1111111111';
  const saved = await f.service.assertSelection(selection, { transaction });
  assert.equal(saved.accounts[0].customerId, f.mapping.customerId); assert.equal(saved.bindings[0].state, 'staged');
  assert.ok(f.state.calls.filter(call => call.kind === 'bindings').some(call => call.args[2] === transaction));
  saved.bindings[0].state = 'blocked';
  assert.equal((await f.service.assertSelection(selection, { transaction })).bindings[0].state, 'staged');
  await assert.rejects(f.service.assertSelection({ ...selection }, { transaction }), { code: 'broker_binding_invalid' });
  await assert.rejects(f.service.assertSelection(selection), { code: 'broker_binding_invalid' });
  f.service.releaseSelection(selection);
  await assert.rejects(f.service.assertSelection(selection, { transaction }), { code: 'broker_binding_invalid' });
});
test('a captured selection expires and rejects changed earlier accounts, privileges and broker ownership before SQL writes', async () => {
  for (const mutate of [f => { f.binding.connection_ref = 'connection:replaced'; f.mapping.broker_read_connection_ref = 'connection:replaced'; },
    f => { f.state.at = 60001; }, f => { f.state.allowed = false; }, f => { f.binding.state = 'blocked'; },
    f => { f.state.clinics.push({ id_clinica: 72, grupoClinicaId: 5 }); }]) {
    const f = staged(); const { selection } = await f.service.capture(f.request); mutate(f);
    await assert.rejects(f.service.assertSelection(selection, { transaction: { LOCK: { UPDATE: 'UPDATE' } } }));
    assert.equal(f.state.providerCalls.length, 1);
  }
});

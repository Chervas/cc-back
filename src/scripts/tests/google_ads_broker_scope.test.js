'use strict';
require('./fixtures/security_offline_runtime.cjs');
const { test } = require('node:test'); const assert = require('node:assert/strict'); const { Op } = require('sequelize');
const { scopeFixture } = require('./fixtures/google_ads_broker_scope.fixture');
const { createGoogleAdsScopeRepository, MAPPING_FIELDS } = require('../../services/googleAdsBrokerScope.service');
const { createGoogleAdsBrokerReader } = require('../../services/googleAdsBrokerReader.service');
test('a group account uses a real member as tenant, preserves aliases and ignores a stale representative clinic as owner', async () => {
  const f = scopeFixture();
  f.state.mappings.push({ ...f.mapping, id: 12, assignmentScope: 'clinic', clinicaId: 71, customerId: '123-456-7890' });
  f.state.bindings.push({ ...f.binding, mapping_id: 12, scope_key: 'clinic:71' });
  f.state.shared = [{ assetId: 11, clinicaId: 59 }, { assetId: 12, clinicaId: 71 }];
  const context = await f.service.prepare(f.mapping); assert.deepEqual(context, {}); assert.ok(Object.isFrozen(context));
  const captured = await f.service.assertContext(context);
  assert.deepEqual(captured.clinicIds, [59, 71]); assert.equal(captured.tenantRef, 'clinic:59');
  assert.equal(captured.scopeKey, 'group:5'); assert.equal(captured.clinicId, 999);
  await assert.rejects(f.service.prepare(f.state.mappings[1]));
  await assert.rejects(f.service.assertContext({ ...captured }), { code: 'broker_binding_invalid' });
  await assert.rejects(f.create().assertContext(context), { code: 'broker_binding_invalid' });
});
test('registry inspection happens with the gate off and absence of both markers is the only legacy candidate', async () => {
  const f = scopeFixture(); f.state.enabled = false;
  await assert.rejects(f.service.prepare(f.mapping), { code: 'broker_cohort_disabled' });
  f.state.bindings = [];
  await assert.rejects(f.service.prepare(f.mapping), { code: 'broker_binding_invalid' });
  f.mapping.broker_read_connection_ref = null; f.mapping.broker_read_asset_ref = null;
  assert.equal(await f.service.prepare(f.mapping), null);
  assert.ok(f.state.calls.filter(call => call.kind === 'bindings').length >= 3);
  f.state.onRead = kind => { if (kind === 'bindings') throw Error('FICTITIOUS_DB_DETAILS'); };
  await assert.rejects(f.service.prepare(f.mapping), { message: 'broker_binding_invalid' });
});
test('deleted and recreated mapping IDs retain durable blocks, including a blocked alias after service reconstruction', async () => {
  const f = scopeFixture(); const hint = { ...f.mapping }; const context = await f.service.prepare(hint);
  f.state.mappings = []; await assert.rejects(f.service.assertContext(context));
  f.state.mappings = [{ ...hint, broker_read_connection_ref: null, broker_read_asset_ref: null }];
  await assert.rejects(f.create().prepare(hint));
  f.state.mappings = [{ ...hint }]; f.state.bindings.push({ ...f.binding, mapping_id: 12, scope_key: 'clinic:71', state: 'blocked' });
  await assert.rejects(f.create().prepare(hint), { code: 'asset_revoked' });
  await assert.rejects(f.service.assertContext(context), { code: 'asset_revoked' });
});
test('every account mapping and explicit sharing relation must fit the selected scope, including deleted registry mappings', async () => {
  for (const mode of ['otherGroup', 'otherClinic', 'otherConnection', 'unregistered', 'shared', 'deletedShared', 'oldScope']) {
    const f = scopeFixture();
    if (['shared', 'deletedShared'].includes(mode)) {
      f.state.shared.push({ assetId: mode === 'shared' ? 11 : 12, clinicaId: 99 });
      if (mode === 'deletedShared') f.state.bindings.push({ ...f.binding, mapping_id: 12 });
    } else if (mode === 'oldScope') f.state.bindings.push({ ...f.binding, mapping_id: 12, scope_key: 'group:6' });
    else {
      const mapping = { ...f.mapping, id: 12 }; const binding = { ...f.binding, mapping_id: 12 };
      if (mode === 'otherGroup') { mapping.grupoClinicaId = 6; binding.scope_key = 'group:6'; }
      if (mode === 'otherClinic') { mapping.assignmentScope = 'clinic'; mapping.clinicaId = 99; binding.scope_key = 'clinic:99'; }
      if (mode === 'otherConnection') { mapping.googleConnectionId = 3; binding.google_connection_id = 3; }
      f.state.mappings.push(mapping); if (mode !== 'unregistered') f.state.bindings.push(binding);
    }
    await assert.rejects(f.service.prepare(f.mapping), { code: ['otherGroup', 'otherClinic', 'shared', 'deletedShared', 'oldScope'].includes(mode) ? 'scope_denied' : 'broker_binding_invalid' });
  }
});
test('revoked, replaced or ambiguous grants cannot authorize group or inherited clinic reads', async () => {
  for (const mode of ['absent', 'revoked', 'ambiguous', 'override', 'replaced']) {
    const f = scopeFixture();
    if (mode === 'absent') f.state.grants = [];
    if (mode === 'revoked') f.state.grants[0].status = 'revoked';
    if (mode === 'ambiguous') f.state.grants.push({ ...f.state.grants[0], id: 101 });
    if (mode === 'replaced') f.state.grants[0].googleConnectionId = 3;
    if (mode === 'override') f.state.grants.push({ id: 102, assignmentScope: 'clinic', clinicaId: 59, grupoClinicaId: 5, googleConnectionId: 2, status: 'disconnected' });
    await assert.rejects(f.service.prepare(f.mapping), { code: 'scope_denied' });
  }
  const f = scopeFixture(); f.mapping.assignmentScope = 'clinic'; f.mapping.clinicaId = 59; f.binding.scope_key = 'clinic:59';
  const context = await f.service.prepare(f.mapping); assert.equal((await f.service.assertContext(context)).scopeKey, 'clinic:59');
  f.state.grants.push({ id: 101, assignmentScope: 'clinic', clinicaId: 59, grupoClinicaId: 5, googleConnectionId: 2, status: 'revoked' });
  await assert.rejects(f.service.assertContext(context), { code: 'scope_denied' });
});
test('foreign identities, residual SQL tokens, bad managers and changed tenant anchors never reach the broker', async () => {
  for (const mutate of [f => { f.state.connection = null; }, f => { f.state.connection.credentials_external = 0; },
    f => { f.state.connection.googleUserId = 'different'; }, f => { f.state.connection.id = 3; },
    f => { f.binding.google_user_id = 'unknown'; }, f => { f.binding.tenant_clinic_id = 999; },
    f => { f.binding.login_customer_id = '1111111111'; }, f => { f.mapping.loginCustomerId = '1 OR 1'; },
    f => { f.mapping.broker_read_asset_ref = 'ads:1111111111'; }, f => { f.state.bindings.push({ ...f.binding }); }]) {
    const f = scopeFixture(); mutate(f); await assert.rejects(f.service.prepare(f.mapping), { code: 'broker_binding_invalid' });
  }
});
test('authorization changes during a read discard broker results and stop subsequent requests', async () => {
  for (const mode of ['revoke', 'membership', 'mapping', 'grant']) {
    const f = scopeFixture(); const context = await f.service.prepare(f.mapping); let calls = 0;
    const reader = createGoogleAdsBrokerReader({ assertContext: f.service.assertContext, client: { execute: async command => {
      calls++;
      if (mode === 'revoke') f.binding.state = 'blocked';
      if (mode === 'membership') f.state.clinics.push({ id_clinica: 72, grupoClinicaId: 5 });
      if (mode === 'mapping') f.mapping.assignmentScope = 'clinic';
      if (mode === 'grant') f.state.grants[0].status = 'disconnected';
      return { requestId: command.requestId, data: { results: [], nextPageToken: null } };
    } } });
    await assert.rejects(reader.read(context, 'campaigns', {})); assert.equal(calls, 1);
    await assert.rejects(reader.read(context, 'campaigns', {})); assert.equal(calls, 1);
  }
});
test('repository uses bounded metadata projections and a SQL NULL predicate without hydrating credentials or old transactions', async () => {
  const calls = []; const fake = name => ({ findAll: async options => { calls.push({ name, options }); return []; },
    findByPk: async (_id, options) => { calls.push({ name, options }); return null; } });
  const models = Object.fromEntries(['ClinicGoogleAdsAccount', 'GoogleAdsBrokerBinding', 'Clinica', 'GroupAssetClinicAssignment', 'GoogleConnectionAssignment', 'GoogleConnection'].map(name => [name, fake(name)]));
  const repository = createGoogleAdsScopeRepository(() => models);
  await repository.loadMapping(11); await repository.loadBindings('1234567890', 11); await repository.loadMappings('1234567890');
  await repository.loadClinics({ scopeKey: 'group:5', groupId: 5 }); await repository.loadShared([11]);
  await repository.loadGrants({ scopeKey: 'group:5', groupId: 5 }, [59, 71]); await repository.loadConnection(2, 'fictitious-subject');
  for (const { name, options } of calls) {
    assert.equal(options.raw, true); assert.equal(options.logging, false); assert.equal(options.transaction, undefined);
    assert.ok(!options.attributes.includes('accessToken') && !options.attributes.includes('refreshToken'));
    if (name === 'GoogleConnection') { assert.equal(options.limit, 2); assert.equal(options.attributes[2][0].val, '(accessToken IS NULL AND refreshToken IS NULL)'); assert.equal(options.where[Op.or].length, 2); }
    else if (options.limit) assert.equal(options.limit, 1001);
  }
  assert.deepEqual(calls[0].options.attributes, MAPPING_FIELDS);
});
test('the assembled broker client rejects a mismatched mapping and never sends after a durable block', async () => {
  const f = scopeFixture(); let calls = 0;
  const { createGoogleAdsBroker } = require('../../services/googleAdsBroker.service');
  const service = createGoogleAdsBroker({ ...f.options, client: { execute: async command => {
    calls++; return { requestId: command.requestId, data: { results: [], nextPageToken: null } };
  } } });
  const context = await service.prepare(f.mapping);
  assert.deepEqual(await service.read(f.mapping, context, 'campaigns', {}), []); assert.equal(calls, 1);
  await assert.rejects(service.read({ ...f.mapping, id: 12 }, context, 'campaigns', {}), { code: 'broker_binding_invalid' });
  f.binding.state = 'blocked';
  await assert.rejects(service.read(f.mapping, context, 'campaigns', {}), { code: 'asset_revoked' });
  assert.equal(calls, 1);
});

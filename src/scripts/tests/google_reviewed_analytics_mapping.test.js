'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const deny = () => { throw Error('NETWORK_FORBIDDEN_IN_REVIEWED_GA4_TEST'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
require('node:http').request = deny;
require('node:https').request = deny;
global.fetch = deny;

const C = require('../../services/googleOAuthCohort.contract');
const { createReviewedAnalyticsMapping, descriptor } = require('../../services/googleReviewedAnalyticsMapping.service');
const { createAnalyticsBroker, createReviewedPropertyReader } = require('../../services/analyticsBroker.service');
const scope = require('../../services/googleOAuthCohortScope.service');
const R = require('../../services/googlePropertyRevocation.contract');
const GA = require('../../../services/integrations-broker/src/google-analytics-contract');
const { GA_OPERATION } = require('../../../services/integrations-broker/src/google-property-discovery-contract');

// Reuse the real project's modeled transaction/authorization fixture without
// importing any runtime model index.
const base = fs.realpathSync(path.join(__dirname, 'google_general_connector_preparation.test.js'));
const source = fs.readFileSync(base, 'utf8'), anchor = "test('general OAuth state/callback worker";
assert(source.includes(anchor));
const fixtureModule = new Module(base, module);
fixtureModule.filename = base;
fixtureModule.paths = Module._nodeModulePaths(path.dirname(base));
fixtureModule._compile(source.slice(0, source.indexOf(anchor)) + '\nmodule.exports = { fixture, clock };', base);
const { fixture, clock } = fixtureModule.exports;

function setup(group = false) {
  const f = fixture();
  if (group) {
    f.state.tables.Clinica[0].grupoClinicaId = 5;
    f.state.tables.Clinica.push({ id_clinica: 72, grupoClinicaId: 5 });
    f.state.tables.UsuarioClinica.push({ ...f.state.tables.UsuarioClinica[0], id_clinica: 72 });
    f.state.tables.GoogleConnectionAssignment.push({ scopeKey: 'group:5', assignmentScope: 'group', grupoClinicaId: 5,
      googleConnectionId: 81, status: 'active' });
    f.input = { ...f.input, scopeKey: 'group:5', clinicIds: [71, 72] };
  }
  const resource = GA.property('properties/101');
  const binding = { ...f.binding, cohort: 'analytics', connection_ref: 'fictitious-ga-connection', asset_ref: resource.assetRef,
    secret_version: '20000000-0000-4000-8000-000000000001', confirmed_at: new Date(clock - 2000) };
  f.state.tables.GoogleOAuthBrokerBinding.push(binding);
  const entry = { descriptorId: '20000000-0000-4000-8000-000000000002', scopeKey: f.input.scopeKey,
    clinicId: 71, clinicIds: f.input.clinicIds, connectionId: 81, googleUserId: binding.google_user_id, connectionRef: binding.connection_ref,
    ...resource, authorizationBindingDigest: C.digest(binding), credentialVersion: binding.secret_version,
    reviewedAtEpochMs: clock, expiresAtEpochMs: clock + 600000 };
  f.state.descriptorEntries = [entry];
  const result = { name: 'properties/101', displayName: 'Propiedad ficticia', propertyType: 'PROPERTY_TYPE_ORDINARY',
    account: 'accounts/1', parent: 'accounts/1' };
  const modelInput = { models: f.models, binding, requestScopeKey: f.input.scopeKey, actorId: f.input.actorId,
    sessionRef: f.input.sessionRef, expiresAt: new Date(f.input.sessionExpiresAt), sessions: f.sessions };
  const client = { async execute(command, budget) {
    assert(Number.isSafeInteger(budget.timeoutMs) && budget.timeoutMs <= 30000);
    f.state.reads.push(command);
    await f.state.afterRead?.();
    return { data: result };
  } };
  const service = createReviewedAnalyticsMapping({ models: f.models, sessions: f.sessions, enabled: () => true, now: () => f.state.time,
    descriptors: () => f.state.descriptorEntries, readProperty: createReviewedPropertyReader(client) });
  const map = () => service.map(f.input, { mappings: [{ clinicaId: entry.clinicId, propertyName: entry.propertyName }] });
  return { ...f, binding, entry, result, service, map, modelInput };
}

test('an empty confirmed GA4 cohort uses only its exact descriptor and then the standard registered reader', async () => {
  for (const group of [false, true]) {
    const f = setup(group);
    await assert.rejects(f.models.sequelize.transaction(tx => scope.authorize({ ...f.modelInput, transaction: tx })));
    assert.equal((await f.service.additionStatus(f.input)).connected, false);
    assert.equal(f.state.reads.length, 0);
    assert.deepEqual(await f.service.inventory(f.input), {
      properties: [f.result], destinations: [{ propertyName: f.result.name, clinicIds: [71] }],
    });
    const mapped = await f.map();
    assert.equal((await f.map()).assets[0].id, mapped.assets[0].id);
    assert.equal(await f.service.additionStatus(f.input), null);
    assert.deepEqual(await f.service.inventory(f.input), { properties: [], destinations: [] });
    assert.deepEqual(f.state.reads, Array(3).fill({
      operation: GA_OPERATION, tenantRef: 'clinic:71', connectionRef: f.entry.connectionRef, assetRef: 'ga4:101', payload: {},
    }));
    assert.equal(f.state.tables.ClinicWebAsset.length, 1);
    assert.equal(f.state.tables.SearchConsoleBrokerBinding.length, 1);
    const [mapping] = f.state.tables.ClinicAnalyticsProperty;
    assert.equal(mapping.measurementId, null);
    assert.equal(f.state.tables.AnalyticsBrokerBinding.length, 1);
    await f.models.sequelize.transaction(tx => scope.authorize({ ...f.modelInput, transaction: tx }));

    const reader = createAnalyticsBroker({
      enabled: () => true,
      loadMapping: async id => f.state.tables.ClinicAnalyticsProperty.find(row => row.id === id),
      loadBindings: async name => f.state.tables.AnalyticsBrokerBinding.filter(row => row.property_name === name),
      loadConnection: async () => ({ id: 81, googleUserId: f.binding.google_user_id, credentials_external: 1 }),
      loadRevocations: async () => [],
      client: { async execute(command) {
        assert.equal(command.assetRef, 'ga4:101');
        assert.equal(command.tenantRef, 'clinic:71');
        return { data: f.result };
      } },
    });
    const context = await reader.prepare(mapping);
    assert.deepEqual((await reader.read(mapping, context, 'discovery', {})).data, f.result);
  }
});

test('foreign scope, missing cohort permissions, unconfirmed or changed credentials and forged capability fail before provider', async () => {
  for (const alter of [
    f => { f.input.clinicIds = [71]; },
    f => { f.input.scopeKey = 'group:6'; },
    f => { f.binding.confirmed_at = null; },
    f => { f.binding.secret_version = '20000000-0000-4000-8000-000000000004'; },
    f => { f.state.tables.UsuarioClinica.pop(); },
    f => { f.state.external = 0; },
    f => { f.state.sessionActive = false; },
    f => { f.state.descriptorEntries = [{ ...f.entry, propertyName: 'properties/102', assetRef: 'ga4:102' }]; },
  ]) {
    const f = setup(true);
    alter(f);
    await assert.rejects(f.map());
    assert.equal(f.state.reads.length + f.state.writes.length, 0);
  }
  const f = setup();
  await assert.rejects(f.models.sequelize.transaction(tx => scope.authorizeReviewedAnalyticsAddition({ ...f.modelInput, transaction: tx }, {})));
  assert.throws(() => descriptor({ ...f.entry, freeApproval: true }, clock));
  assert.equal(f.state.reads.length + f.state.writes.length, 0);
});

test('provider response, renewed descriptor, revised scope and local-write failures leave the two SQL records absent', async () => {
  for (const alter of [
    f => { f.result.name = 'properties/999'; },
    f => { f.state.afterRead = () => { f.state.descriptorEntries = []; }; },
    f => { f.state.afterRead = () => { f.state.permission = false; }; },
    f => { f.state.afterWrite = () => { f.state.descriptorEntries = []; }; },
    f => { f.models.AnalyticsBrokerBinding.create = async () => { throw Error('QA_REGISTRY_FAILURE'); }; },
  ]) {
    const f = setup();
    alter(f);
    await assert.rejects(f.map());
    assert.equal(f.state.reads.length, 1);
    assert.deepEqual(f.state.tables.ClinicAnalyticsProperty, []);
    assert.deepEqual(f.state.tables.AnalyticsBrokerBinding, []);
  }
});

test('existing mappings, orphaned registry and previous revocations are preserved and deny reuse', async () => {
  for (const alter of [
    f => { f.state.tables.ClinicAnalyticsProperty.push({ id: 90, clinicaId: 71, googleConnectionId: 81, propertyName: 'properties/101',
      isActive: false, broker_read_connection_ref: null, broker_read_asset_ref: null }); },
    f => { f.state.tables.AnalyticsBrokerBinding.push({ mapping_id: 90, clinica_id: 71, google_connection_id: 81,
      google_user_id: f.entry.googleUserId, property_name: 'properties/101', connection_ref: f.entry.connectionRef,
      asset_ref: 'ga4:101', state: 'active' }); },
    f => {
      const old = { kind: 'analytics', resource: 'properties/101', connection_ref: 'old-connection', asset_ref: 'ga4:101',
        clinica_id: 71, google_connection_id: 82, google_user_id: f.entry.googleUserId,
        state: 'pending', request_id: '30000000-0000-4000-8000-000000000003', actor_user_id: 501, requested_at: new Date(clock) };
      old.tuple_hash = R.tupleHash(old);
      f.state.tables.GooglePropertyBrokerRevocation.push(old);
    },
  ]) {
    const f = setup();
    alter(f);
    const before = structuredClone(f.state.tables);
    await assert.rejects(f.map());
    assert.deepEqual(f.state.tables, before);
    assert.equal(f.state.reads.length + f.state.writes.length, 0);
  }
});

test('a subsequent addition preserves the anchor and stops after the exact review expires', async () => {
  const f = setup(true);
  await f.map();
  const anchor = structuredClone(f.state.tables.ClinicAnalyticsProperty[0]);
  f.state.descriptorEntries = [{ ...f.entry, clinicId: 72, ...GA.property('properties/102') }];
  f.result.name = 'properties/102';
  const payload = { mappings: [{ clinicaId: 72, propertyName: 'properties/102' }] };
  await f.service.map(f.input, payload);
  assert.deepEqual(f.state.tables.ClinicAnalyticsProperty[0], anchor);
  f.state.time = f.entry.expiresAtEpochMs;
  const reads = f.state.reads.length;
  await assert.rejects(f.service.map(f.input, payload));
  assert.equal(f.state.reads.length, reads);
});

test('reviewed status does not resolve stricter authority for a foreign or absent descriptor', async () => {
  const f = setup(true);
  const resolve = async () => assert.fail('Unrelated descriptor invoked scope authority');
  assert.equal(await f.service.additionStatus(resolve, { scopeKey: 'group:6', connectionId: 81 }), null);
  f.state.descriptorEntries = [];
  assert.equal(await f.service.additionStatus(resolve, { scopeKey: 'group:5', connectionId: 81 }), null);
  await assert.rejects(f.map(), { code: 'broker_discovery_scope_unconfigured' });
  assert.equal(f.state.reads.length + f.state.writes.length, 0);
});

test('reviewed catalogue rejects revoked targets or membership loss before returning exact property data', async () => {
  const f = setup(true);
  f.state.afterRead = () => { f.state.permission = false; };
  await assert.rejects(f.service.inventory(f.input));
  assert.equal(f.state.reads.length, 1);
  const target = setup();
  const tombstone = { kind: 'analytics', resource: 'properties/101', connection_ref: target.entry.connectionRef, asset_ref: 'ga4:101',
    clinica_id: 71, google_connection_id: 81, google_user_id: target.entry.googleUserId, state: 'pending',
    request_id: '30000000-0000-4000-8000-000000000003', actor_user_id: 501, requested_at: new Date(clock) };
  tombstone.tuple_hash = R.tupleHash(tombstone);
  target.state.tables.GooglePropertyBrokerRevocation.push(tombstone);
  for (const op of [() => target.service.additionStatus(target.input), () => target.service.inventory(target.input), target.map]) {
    await assert.rejects(op(), { code: 'asset_revoked' });
  }
  assert.equal(target.state.reads.length + target.state.writes.length, 0);
});

'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const http = require('node:http'); const express = require('express'); const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto'); const sequelize = require('sequelize');
const { createBusinessProfileDiscovery, ERROR_CODES, CONFLICT_CODES } = require('../../services/businessProfileDiscovery.service');
const { createBusinessProfileBroker } = require('../../services/businessProfileBroker.service');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const record = { external_location_id: '456', connection_ref: 'connection:test', asset_ref: 'gbp:123:456', clinica_id: 71, google_connection_id: 81 };
const mapping = { id: 51, clinica_id: 71, google_connection_id: 81, location_id: 'locations/456', is_active: true,
  broker_read_connection_ref: record.connection_ref, broker_read_asset_ref: record.asset_ref };
const SENTINEL = 'FICTITIOUS_DISCOVERY_LEGACY_CREDENTIAL';
function fixture(options = {}) {
  const state = { enabled: true, managed: true, rows: [{ ...record }], location: { ...mapping }, now: 1000,
    calls: 0, validation: 0, tokenReads: 0, legacyCalls: 0, allowed: true, connectionId: 81, resolution: 'assignment', ...options };
  const reader = createBusinessProfileBroker({ enabled: () => state.enabled,
    loadManagedBinding: async id => state.rows.find(row => row.external_location_id === id),
    loadLocation: async () => state.location,
    client: { async execute(command, budget) {
      state.calls++; assert.equal(command.tenantRef, 'clinic:71'); assert.equal(command.operation, 'google.business_profile.discovery.read.v1');
      assert.equal(command.assetRef, record.asset_ref); assert.deepEqual(command.payload, {}); assert(budget.timeoutMs > 0 && budget.timeoutMs <= 30000);
      await state.onRead?.();
      return { data: { account: { name: 'accounts/123', accountName: 'FICTITIOUS_ACCOUNT', accountNumber: '001' }, location: { name: 'locations/456', title: 'FICTITIOUS_LOCATION', metadata: { hasVoiceOfMerchant: true } } } };
    } },
  });
  const service = createBusinessProfileDiscovery({ broker: reader, enabled: () => state.enabled, now: () => state.now,
    hasManagedBindings: async () => { if (state.registryFailure) throw Error(SENTINEL); return state.managed; },
    listBindings: async (ids, connection) => state.rows.filter(row => ids.includes(Number(row.clinica_id)) && Number(row.google_connection_id) === connection),
    loadLocation: async () => state.location,
  });
  const request = { clinicIds: [71], connectionId: 81, revalidate: async () => { state.validation++; if (!state.allowed) throw Object.assign(Error('forbidden'), { code: 'marketing_connection_scope_write_forbidden', httpStatus: 403 }); } };
  return { state, service, request };
}
test('registered inventory revalidates ACL, refs and mappings without a legacy token path', async () => {
  const f = fixture(); const result = await f.service.list(f.request);
  assert.equal(result[0].location.name, 'locations/456'); assert.equal(f.state.calls, 1); assert(f.state.validation >= 4);
  await assert.rejects(f.service.assertLegacyAllowed(), { code: 'broker_legacy_discovery_blocked' });
  f.state.managed = false; assert.equal(await f.service.list(f.request), null); await f.service.assertLegacyAllowed();
});
test('disable, absent scope grants, registry failure and malformed scopes fail before dispatch', async () => {
  for (const [options, code] of [[{ enabled: false }, 'broker_cohort_disabled'], [{ rows: [] }, 'broker_discovery_scope_unconfigured'],
    [{ registryFailure: true }, 'broker_registry_unavailable'], [{ location: { ...mapping, broker_read_asset_ref: null } }, 'broker_binding_invalid'],
    [{ rows: Array.from({ length: 21 }, () => ({ ...record })) }, 'broker_discovery_limit']]) {
    const f = fixture(options); await assert.rejects(f.service.list(f.request), { code }); assert.equal(f.state.calls, 0);
  }
  for (const clinicIds of [[], [71, 71], ['71'], [0], [72]]) {
    const f = fixture(); await assert.rejects(f.service.list({ ...f.request, clinicIds })); assert.equal(f.state.calls, 0);
  }
});
test('permission, binding, gate and deadline changes discard the entire response', async () => {
  for (const change of [state => { state.allowed = false; }, state => { state.enabled = false; }, state => { state.location = { ...mapping, clinica_id: 72 }; },
    state => { state.rows = []; }, state => { state.now = 31000; }]) {
    const f = fixture(); f.state.onRead = async () => change(f.state);
    await assert.rejects(f.service.list(f.request)); assert.equal(f.state.calls, 1);
  }
});
test('four pending inventories retain admission slots and a fifth cannot dispatch', async () => {
  let release; const blocked = new Promise(resolve => { release = resolve; }); const f = fixture({ onRead: () => blocked });
  const active = Array.from({ length: 4 }, () => f.service.list(f.request));
  await new Promise(resolve => setImmediate(resolve)); await assert.rejects(f.service.list(f.request), { code: 'broker_discovery_busy' });
  assert.equal(f.state.calls, 4); release(); await Promise.all(active); await f.service.list(f.request); assert.equal(f.state.calls, 5);
});

async function routeFixture(t, options = {}) {
  const f = fixture(options); const { state } = f; const logs = []; const queries = [];
  const empty = { findAll: async () => [] };
  const models = {
    Clinica: { findByPk: async () => ({ grupoClinicaId: 9 }), findAll: async () => [{ id_clinica: 71 }, { id_clinica: 72 }] },
    SearchConsoleBrokerBinding: { findOne: async () => null },
    AnalyticsBrokerBinding: { findOne: async () => null },
    GoogleConnection: { rawAttributes: { updated_at: {} },
      findByPk: async (_id, query) => { queries.push(query); if (query?.attributes) { assert.deepEqual(clone(query.attributes), ['id']); return { id: state.connectionId }; }
        state.tokenReads++; return { id: 81, accessToken: SENTINEL, expiresAt: new Date(Date.now() + 600000) }; },
      findAll: async query => { assert.deepEqual(clone(query.attributes), ['id']); return [{ id: state.connectionId }]; },
    },
    GoogleConnectionAssignment: { findOne: async query => {
      assert.deepEqual(clone(query.include[0].attributes), ['id']);
      return state.resolution === 'assignment' && query.where.status[sequelize.Op.in].includes('active') ? { googleConnection: { id: state.connectionId } } : null;
    } },
    ClinicGoogleAdsAccount: empty, ClinicWebAsset: empty, ClinicAnalyticsProperty: empty,
    ClinicBusinessLocation: { findAll: async () => state.resolution === 'mapping' ? [{ google_connection_id: 81 }] : [] },
  };
  const resolver = loadDiscoverySource('services/scopeConnectionResolver.service.js', { '../../models': models, sequelize });
  const secret = randomBytes(32); const sessions = require('../../services/accessSession.service');
  const sessionService = {
    ...sessions, ...sessions.createService({ models: () => assert.fail('No real models'), config: () => ({ mode: 'legacy', ttl: 43200, secret }) }),
  };
  const verify = sessionService.verify;
  sessionService.verify = token => { if (state.revoked) throw new jwt.JsonWebTokenError('revoked'); return verify(token); };
  const auth = loadDiscoverySource('routes/auth.middleware.js', { '../services/accessSession.service': sessionService });
  const router = loadDiscoverySource('routes/oauth.routes.js', {
    express, sequelize, '../../models': models, './auth.middleware': auth,
    '../services/accessSession.service': sessionService,
    // This fixture models an installation with no OAuth cohort binding.
    '../services/googleOAuthBroker.service': require('../../services/googleOAuthBroker.service').createGoogleOAuthBroker({
      models: { GoogleOAuthBrokerBinding: { findOne: async () => null }, SearchConsoleBrokerBinding: models.SearchConsoleBrokerBinding,
        AnalyticsBrokerBinding: models.AnalyticsBrokerBinding, GooglePropertyBrokerRevocation: { findOne: async () => null } }, audit: {}, enabled: () => false,
    }),
    '../services/businessProfileDiscovery.service': { ...f.service, ERROR_CODES, CONFLICT_CODES },
    '../services/scopeConnectionResolver.service': resolver,
    '../lib/oauthMarketingScopeAccess': require('../../lib/oauthMarketingScopeAccess'),
    '../lib/businessProfileLocationMapping': require('../../lib/businessProfileLocationMapping'),
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async ({ userId, clinicIds, access }) => {
      assert.equal(access, 'write'); return state.allowed && userId === 701 && clinicIds.every(id => [71, 72].includes(id));
    } },
    axios: { get: async url => { state.legacyCalls++; await state.onLegacyRead?.(); return { data: url.endsWith('/accounts') ? { accounts: [{ name: 'accounts/123' }] } : { locations: [{ name: 'locations/456', title: 'FICTITIOUS_LEGACY_LOCATION' }] } }; },
      post: () => assert.fail('No refresh in route QA') },
  }, { logs });
  const app = express(); app.use(express.json()); app.use('/oauth', router); const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: false }); agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
  const token = jwt.sign({ userId: 701 }, secret, { expiresIn: 60 });
  async function request({ query = '?clinic_id=71', authenticated = true, method = 'GET', body } = {}) {
    const value = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, method,
        path: '/oauth/google/local/' + (method === 'POST' ? 'map-locations' : 'locations') + query,
        headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
      }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })); });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
    assert(!JSON.stringify(value).includes(SENTINEL)); assert(!JSON.stringify(logs).includes(SENTINEL)); return value;
  }
  return { ...f, request, queries, logs };
}
test('actual OAuth HTTP route rejects missing session/scope and forbidden scope before provider dispatch', async t => {
  const f = await routeFixture(t);
  assert.equal((await f.request({ authenticated: false })).status, 401);
  assert.equal((await f.request({ query: '' })).status, 400);
  assert.equal((await f.request({ query: '?clinic_id=99' })).status, 403);
  assert.equal(f.state.calls, 0); assert.equal(f.state.tokenReads, 0); assert.equal(f.state.legacyCalls, 0);
});
test('HTTP DTO uses the same account/location fields and all resolver paths select metadata only', async t => {
  for (const resolution of ['assignment', 'mapping', 'user']) {
    const f = await routeFixture(t, { resolution }); const result = await f.request();
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.inventory_mode, 'broker_grants');
    assert.equal(result.headers['cache-control'], 'private, no-store');
    const account = result.body.accounts[0]; assert.equal(account.accountNumber, '001'); assert.equal(account.locations[0].locationName, 'FICTITIOUS_LOCATION');
    assert.equal(account.locations[0].rawLocation.name, 'locations/456'); assert.equal(f.state.tokenReads, 0); assert.equal(f.state.legacyCalls, 0);
  }
});
test('HTTP handles revocation, broker failure, gate-off and scope reassignment without falling back or exposing errors', async t => {
  for (const [change, status] of [[state => { state.allowed = false; }, 403], [state => { state.connectionId = 82; }, 409],
    [state => { state.revoked = true; }, 401],
    [state => { state.enabled = false; }, 503], [() => { throw Object.assign(Error(SENTINEL), { code: 'credential_revoked' }); }, 503]]) {
    const f = await routeFixture(t); f.state.onRead = () => change(f.state); const result = await f.request();
    assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(f.state.tokenReads, 0); assert.equal(f.state.legacyCalls, 0);
  }
});
test('first registered grant blocks legacy remapping globally while unmigrated installation retains discovery', async t => {
  const managed = await routeFixture(t);
  const blocked = await managed.request({ method: 'POST', body: { mappings: [{ clinicaId: 71, locationId: 'locations/456' }] } });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error, 'broker_legacy_discovery_blocked'); assert.equal(managed.state.tokenReads, 0);
  const legacy = await routeFixture(t, { managed: false }); const result = await legacy.request();
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.accounts[0].locations[0].locationName, 'FICTITIOUS_LEGACY_LOCATION');
  assert.equal(legacy.state.tokenReads, 1); assert.equal(legacy.state.legacyCalls, 2); assert.equal(legacy.state.calls, 0);
});
test('a cut detected between legacy pages discards the whole HTTP result instead of skipping the account', async t => {
  const f = await routeFixture(t, { managed: false }); f.state.onLegacyRead = () => { f.state.managed = true; };
  const result = await f.request(); assert.equal(result.status, 409); assert.equal(result.body.error, 'broker_legacy_discovery_blocked');
  assert.equal(f.state.legacyCalls, 1); assert.equal(f.state.calls, 0); assert.equal(result.body.accounts, undefined);
});

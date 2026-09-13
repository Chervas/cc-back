'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('node:http');
const express = require('express'); const sequelize = require('sequelize');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const { adsDiscoveryFixture } = require('./fixtures/google_ads_discovery.fixture');
const { credentialsFixture } = require('./fixtures/google_legacy_credentials.fixture');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
async function fixture(t) {
  const f = adsDiscoveryFixture(); const { state } = f; const legacy = credentialsFixture(); let legacyCalls = 0; let refreshes = 0; legacy.add(2).scopes = 'https://www.googleapis.com/auth/adwords';
  const sessions = { bearer: value => { if (!value) throw Object.assign(Error('unauthenticated'), { name: 'JsonWebTokenError' }); return value; }, verify: async () => {
    if (!state.session) throw Object.assign(Error('session_revoked'), { name: 'JsonWebTokenError' }); return { userId: 701, sessionVersion: state.legacySession ? undefined : 1,
      jti: '545aef07-91c3-4fbc-8ce4-75135575fd7e', exp: 1800000000 }; } };
  sessions.verifyReference = async (reference, { transaction }) => {
    assert.equal(reference.userId, 701); assert.equal(reference.sessionRef, '545aef07-91c3-4fbc-8ce4-75135575fd7e');
    assert.ok(transaction?.LOCK?.UPDATE); state.referenceChecks = (state.referenceChecks || 0) + 1;
    if (!state.session) throw Object.assign(Error('google_discovery_session_required'), { code: 'google_discovery_session_required' });
  };
  const auth = loadDiscoverySource('routes/auth.middleware.js', { '../services/accessSession.service': sessions });
  const empty = { findAll: async () => [] };
  const models = { Clinica: { findByPk: async () => ({ grupoClinicaId: 5 }), findAll: async () => state.groupChanged ? [{ id_clinica: 59 }] : [{ id_clinica: 59 }, { id_clinica: 71 }] },
    GoogleConnection: { rawAttributes: { updated_at: {} }, findByPk: async (_id, query) => {
      assert.deepEqual(Array.from(query.attributes), ['id']); return { id: state.changedConnection ? 3 : 2 };
    }, findAll: async query => { assert.deepEqual(Array.from(query.attributes), ['id']); return state.noConnection ? [] : [{ id: 2 }]; } },
    GoogleConnectionAssignment: { findOne: async query => { assert.deepEqual(Array.from(query.include[0].attributes), ['id']);
      return state.noConnection ? null : { googleConnection: { id: state.changedConnection ? 3 : 2 } }; } },
    ClinicGoogleAdsAccount: empty, ClinicAnalyticsProperty: empty, ClinicWebAsset: empty, ClinicBusinessLocation: empty };
  state.mappingAudits = []; state.mappingWrites = 0;
  models.sequelize = { transaction: async work => {
    const before = structuredClone({ mappings: state.mappings, bindings: state.bindings, mappingAudits: state.mappingAudits });
    try { return await work({ LOCK: { UPDATE: 'UPDATE' } }); } catch (error) { Object.assign(state, before); throw error; }
  } };
  models.ClinicGoogleAdsAccount = { ...empty, findByPk: async (id, options) => {
    assert.ok(options.transaction?.LOCK?.UPDATE); return structuredClone(state.mappings.find(row => row.id === id));
  }, update: async (changes, { where, transaction }) => {
    assert.ok(transaction?.LOCK?.UPDATE);
    const rows = state.mappings.filter(row => where.id ? row.id === where.id : where.customerId[sequelize.Op.in].includes(row.customerId));
    for (const row of rows) { state.mappingWrites++; Object.assign(row, changes); await state.afterMappingWrite?.(); } return [rows.length];
  } };
  models.GoogleAdsBrokerBinding = { update: async (changes, { where, transaction }) => {
    assert.ok(transaction?.LOCK?.UPDATE); const row = state.bindings.find(row => row.mapping_id === where.mapping_id && row.customer_id === where.customer_id && row.state === where.state);
    if (!row) return [0]; Object.assign(row, changes); return [1];
  } };
  const mappingModule = require('../../services/googleAdsMapping.service');
  const mapping = { ...mappingModule, ...mappingModule.createGoogleAdsMapping({ models, discovery: f.service, broker: f.broker,
    revoke: async args => {
      assert.deepEqual(args.customerIds, ['1234567890']); assert.deepEqual(args.clinicIds, [59,71]); assert.ok(args.transaction.LOCK.UPDATE);
      state.targetedRevocations = (state.targetedRevocations || 0) + 1;
      state.bindings.forEach(row => { if (args.customerIds.includes(row.customer_id)) row.state = 'blocked'; }); return 1;
    },
    snapshot: async () => structuredClone({ bindings: state.bindings, mappings: state.mappings, clinics: state.clinics, shared: state.shared }),
    enabled: () => !state.mappingDisabled, audit: { health: async () => ({ pending: 0, oldestAgeSeconds: 0 }), append: async event => {
      if (state.auditFailed) throw Error('FICTITIOUS_SQL_SECRET'); state.mappingAudits.push(require('../../../services/platform-audit/src/event').pack(event));
    } } }) };
  const resolver = loadDiscoverySource('services/scopeConnectionResolver.service.js', { '../../models': models, sequelize });
  const router = loadDiscoverySource('routes/oauth.routes.js', { express, sequelize, '../../models': models, './auth.middleware': auth,
    '../services/accessSession.service': sessions, '../services/googleAdsDiscovery.service': f.service,
    '../services/googleAdsMapping.service': mapping,
    '../services/googlePropertyDiscovery.service': require('../../services/googleAdsDiscovery.service'),
    '../services/googlePropertyInventoryScope.service': { resolve: async () => state.effectiveMappings || [] },
    '../services/googleLegacyCredentials.service': legacy.credentials, '../services/scopeConnectionResolver.service': resolver,
    '../services/googleOAuthBroker.service': { assertLegacyConnection: async () => {}, bindingFor: async () => null },
    '../lib/oauthMarketingScopeAccess': require('../../lib/oauthMarketingScopeAccess'),
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async ({ userId, clinicIds, access }) => {
      assert.ok(['write', 'read'].includes(access)); return state.allowed && userId === 701
        && clinicIds.every(id => [59, 71].includes(id)); } },
    '../lib/googleAdsClient': {
      normalizeCustomerId: value => String(value || '').replace(/[^0-9]/g, ''),
      formatCustomerId: value => value,
      ensureGoogleAdsConfig: () => ({ managerId: '9876543210' }),
      googleAdsRequest: async (_method, path) => {
        legacyCalls++; await state.afterLegacy?.();
        if (path === 'customers:listAccessibleCustomers') return { resourceNames: ['customers/1234567890'] };
        if (state.closedLegacy) throw { response: { status: 403, data: { error: { details: [{ errors: [{ errorCode: { authorizationError: 'CUSTOMER_NOT_ENABLED' }, message: 'FICTITIOUS_PROVIDER_SECRET' }] }] } } } };
        return { results: [{ customer: { id: '1234567890', descriptiveName: 'Fictitious legacy account', currencyCode: 'EUR', manager: false } }] };
      },
    },
    '../services/googleAdsAccountDiscovery.service': require('../../services/googleAdsAccountDiscovery.service'),
    axios: { post: async url => { assert.equal(url, 'https://oauth2.googleapis.com/token'); refreshes++; await state.afterRefresh?.();
      return { data: { access_token: 'FICTITIOUS_accessToken_refresh', expires_in: 3600 } }; } },
  }, { logs: state.logs });
  const app = express(); app.use(express.json()); app.use('/oauth', router); const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: false }); agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
  const request = (route = 'ads/accounts', query = '?group_id=5&view=selection', authenticated = true, body, method) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, path: '/oauth/google/' + route + query,
      method: method || (body === undefined ? 'GET' : 'POST'), headers: { ...(authenticated ? { authorization: 'Bearer FICTITIOUS_JWT' } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); assert(!/FICTITIOUS_(SECRET|SQL|accessToken|refreshToken)/.test(text + JSON.stringify(state.logs)));
        resolve({ status: res.statusCode, body: JSON.parse(text), headers: res.headers });
      });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  }); return { ...f, request, legacy, legacyCalls: () => legacyCalls, refreshes: () => refreshes };
}

test('actual Ads inventory and status routes read registered accounts with managed sessions and no SQL credentials', async t => {
  const f = await fixture(t); const r = await f.request(); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.inventory_mode, 'broker_grants'); assert.equal(r.body.accounts[0].customerId, '1234567890');
  assert.equal(r.headers['cache-control'], 'private, no-store'); assert.equal(f.state.providerCalls[0].tenantRef, 'clinic:59');
  const status = await f.request('ads/connection-status'); assert.equal(status.status, 200); assert.equal(status.body.connected, true);
  assert.equal(status.body.verification, 'registered_accounts_read'); assert.equal(status.body.hasAccessibleAccounts, true);
  assert.equal(f.legacy.state.tokenReads + f.legacyCalls(), 0);
});
test('Ads routes reject absent scope/session, legacy session and foreign clinic before reads', async t => {
  const f = await fixture(t); assert.equal((await f.request(undefined, undefined, false)).status, 401);
  assert.equal((await f.request(undefined, '')).status, 400); assert.equal((await f.request(undefined, '?clinic_id=999')).status, 403);
  f.state.legacySession = true; assert.equal((await f.request()).status, 401); assert.equal(f.state.providerCalls.length + f.legacy.state.tokenReads, 0);
});
test('Ads HTTP responses are withheld after scope, identity or session changes during reads', async t => {
  for (const [mutate, code] of [[s => { s.allowed = false; }, 403], [s => { s.session = false; }, 401],
    [s => { s.changedConnection = true; }, 409], [s => { s.groupChanged = true; }, 409]]) {
    const f = await fixture(t); f.state.afterCall = () => mutate(f.state); const r = await f.request();
    assert.equal(r.status, code, JSON.stringify(r.body)); assert.equal(r.body.accounts, undefined); assert.equal(f.legacy.state.tokenReads, 0);
  }
});
test('pre-cut Ads picker preserves unavailable-account counts and checks every request through the credential boundary', async t => {
  const f = await fixture(t); f.state.managed = false; f.state.legacySession = true;
  const first = await f.request(); assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.accounts[0].customerId, '1234567890');
  assert.equal(f.legacy.state.loads, 1); assert.equal(f.legacyCalls(), 2);
  f.state.closedLegacy = true; const closed = await f.request(); assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.deepEqual(closed.body.accounts, []); assert.equal(closed.body.unavailableAccountCount, 1);
});
test('a cut during legacy listing or refresh prevents result disclosure and refresh persistence', async t => {
  const f = await fixture(t); f.state.managed = false;
  f.state.afterLegacy = () => { f.state.managed = true; f.legacy.mark(2); };
  const result = await f.request(); assert.notEqual(result.status, 200); assert.equal(result.body.accounts, undefined); assert.equal(f.legacyCalls(), 1);
  const g = await fixture(t); g.state.managed = false; g.legacy.state.rows.get(2).expiresAt = new Date('2000-01-01');
  g.state.afterRefresh = () => { g.state.managed = true; g.legacy.mark(2); };
  assert.notEqual((await g.request()).status, 200); assert.equal(g.refreshes(), 1); assert.equal(g.legacy.state.updates + g.legacyCalls(), 0);
});
test('no connection has an explicit empty status while list returns 404', async t => {
  const f = await fixture(t); f.state.noConnection = true;
  const status = await f.request('ads/connection-status'); assert.equal(status.status, 200); assert.equal(status.body.reason, 'no_connection');
  assert.equal((await f.request()).status, 404); assert.equal(f.state.providerCalls.length + f.legacy.state.tokenReads, 0);
});

test('pre-cut Ads keeps the picker scope and expiry reasons while managed failures remain closed', async t => {
  const f = await fixture(t); f.state.managed = false; f.legacy.state.rows.get(2).scopes = '';
  const missing = await f.request('ads/connection-status'); assert.equal(missing.status, 200); assert.equal(missing.body.reason, 'insufficient_scope');
  assert.equal((await f.request()).status, 403); assert.equal(f.legacyCalls(), 0);
  f.legacy.state.rows.get(2).scopes = 'https://www.googleapis.com/auth/adwords'; f.legacy.state.rows.get(2).expiresAt = null;
  Object.defineProperty(f.legacy.state.rows.get(2), 'refreshToken', { value: null, configurable: true });
  const expired = await f.request('ads/connection-status'); assert.equal(expired.status, 200); assert.equal(expired.body.reason, 'token_expired');
  f.state.managed = true; f.state.enabled = false;
  const managed = await f.request('ads/connection-status'); assert.equal(managed.status, 503); assert.equal(managed.body.reason, 'broker_cohort_disabled');
});

const mappingBody = { mappings: [{ clinicaId: 59, customerId: '1234567890' }], group_id: 5, assignment_scope: 'group' };
test('actual managed mapping POST activates a prepared account and audits the original group owner with no credentials in HTTP', async t => {
  const f = await fixture(t); f.mapping.isActive = false; f.binding.state = 'staged';
  const result = await f.request('ads/map-accounts', '', true, { ...mappingBody,
    mappings: [{ clinicaId: 71, customerId: '1234567890' }, ...mappingBody.mappings] });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.mapped, 1);
  assert.equal(result.body.accounts[0].assignmentScope, 'group'); assert.equal(result.body.accounts[0].clinicaId, 59);
  assert.doesNotMatch(JSON.stringify(result.body), /broker_read|connection:|subject/);
  assert.equal(f.state.bindings[0].state, 'active'); assert.equal(f.state.mappings[0].isActive, true);
  assert.equal(f.state.mappingAudits.length, 1); assert.equal(f.state.mappingAudits[0].event.version, 12);
  assert.equal(f.state.mappingAudits[0].event.previousClinicId, '999'); assert.ok(f.state.referenceChecks >= 2);
  assert.equal(f.legacy.state.tokenReads + f.legacyCalls(), 0);
});
test('mapping POST rejects malformed input, missing explicit scope, legacy session and disabled activation before broker dispatch', async t => {
  for (const mode of ['malformed', 'missingScope', 'legacy', 'disabled']) {
    const f = await fixture(t); const body = structuredClone(mappingBody);
    if (mode === 'malformed') body.mappings[0].clinicaId = '59suffix';
    if (mode === 'missingScope') { delete body.group_id; delete body.assignment_scope; }
    if (mode === 'legacy') f.state.legacySession = true;
    if (mode === 'disabled') f.state.mappingDisabled = true;
    assert.notEqual((await f.request('ads/map-accounts', '', true, body)).status, 200);
    assert.equal(f.state.providerCalls.length + f.state.mappingWrites + f.legacy.state.tokenReads, 0);
  }
});
test('mapping POST cannot mutate an inherited group account from a clinic scope or substitute private references', async t => {
  const f = await fixture(t);
  let result = await f.request('ads/map-accounts', '', true, { mappings: [{ clinicaId: 71, customerId: '1234567890' }], clinic_id: 71 });
  assert.equal(result.status, 409, JSON.stringify(result.body)); assert.equal(f.state.mappingWrites, 0);
  result = await f.request('ads/map-accounts', '', true, { ...mappingBody,
    mappings: [{ ...mappingBody.mappings[0], connection_ref: 'connection:attacker' }] });
  assert.equal(result.status, 400); assert.equal(f.state.mappingWrites, 0);
});
test('audit failure and loss of authorization inside managed HTTP saving leave preparation and all mappings intact', async t => {
  for (const mode of ['audit', 'permission', 'session']) {
    const f = await fixture(t); f.mapping.isActive = false; f.binding.state = 'staged';
    if (mode === 'audit') f.state.auditFailed = true;
    else f.state.afterMappingWrite = () => { f.state[mode === 'permission' ? 'allowed' : 'session'] = false; };
    const result = await f.request('ads/map-accounts', '', true, mappingBody);
    assert.notEqual(result.status, 200); assert.equal(f.state.bindings[0].state, 'staged');
    assert.equal(f.state.mappings[0].isActive, false); assert.equal(f.state.mappings[0].clinicaId, 999);
    assert.equal(f.state.mappingAudits.length, 0); assert.equal(f.legacy.state.tokenReads, 0);
  }
});
test('managed stored mappings can be refreshed over HTTP after saving without contacting the provider', async t => {
  const f = await fixture(t);
  const saved = await f.request('ads/map-accounts', '', true, mappingBody); assert.equal(saved.status, 200);
  const calls = f.state.providerCalls.length;
  const result = await f.request('ads/mappings', '?clinic_id=71');
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.mappings[0].clinicaId, 71);
  assert.equal(result.body.mappings[0].ads[0].customerId, '1234567890'); assert.equal(f.state.providerCalls.length, calls);
  assert.equal(f.legacy.state.tokenReads, 0);
});
test('managed DELETE uses metadata and targeted revocation even when broker reads are disabled, preserving the mapping row', async t => {
  const f = await fixture(t); f.state.enabled = false;
  const denied = await f.request('ads/mappings/11', '?clinic_id=71', true, undefined, 'DELETE');
  assert.equal(denied.status, 409); assert.equal(f.state.targetedRevocations || 0, 0);
  const removed = await f.request('ads/mappings/11', '?group_id=5', true, undefined, 'DELETE');
  assert.equal(removed.status, 200, JSON.stringify(removed.body)); assert.equal(f.state.targetedRevocations, 1);
  assert.equal(f.state.mappings.length, 1); assert.equal(f.state.mappings[0].isActive, false); assert.equal(f.state.bindings[0].state, 'blocked');
  assert.equal(f.state.providerCalls.length + f.legacy.state.tokenReads + f.legacyCalls(), 0);
});
test('saving a readable suspended account preserves its status without claiming advertising capability; managers cannot become account mappings', async t => {
  const f = await fixture(t); f.state.accountStatus = 'SUSPENDED';
  const saved = await f.request('ads/map-accounts', '', true, mappingBody);
  assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.accounts[0].accountStatus, 'SUSPENDED');
  const manager = await fixture(t); manager.state.manager = true;
  assert.equal((await manager.request('ads/map-accounts', '', true, mappingBody)).status, 400); assert.equal(manager.state.mappingWrites, 0);
});

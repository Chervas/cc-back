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
  const auth = loadDiscoverySource('routes/auth.middleware.js', { '../services/accessSession.service': sessions });
  const empty = { findAll: async () => [] };
  const models = { Clinica: { findByPk: async () => ({ grupoClinicaId: 5 }), findAll: async () => state.groupChanged ? [{ id_clinica: 59 }] : [{ id_clinica: 59 }, { id_clinica: 71 }] },
    GoogleConnection: { rawAttributes: { updated_at: {} }, findByPk: async (_id, query) => {
      assert.deepEqual(Array.from(query.attributes), ['id']); return { id: state.changedConnection ? 3 : 2 };
    }, findAll: async query => { assert.deepEqual(Array.from(query.attributes), ['id']); return state.noConnection ? [] : [{ id: 2 }]; } },
    GoogleConnectionAssignment: { findOne: async query => { assert.deepEqual(Array.from(query.include[0].attributes), ['id']);
      return state.noConnection ? null : { googleConnection: { id: state.changedConnection ? 3 : 2 } }; } },
    ClinicGoogleAdsAccount: empty, ClinicAnalyticsProperty: empty, ClinicWebAsset: empty, ClinicBusinessLocation: empty };
  const resolver = loadDiscoverySource('services/scopeConnectionResolver.service.js', { '../../models': models, sequelize });
  const router = loadDiscoverySource('routes/oauth.routes.js', { express, sequelize, '../../models': models, './auth.middleware': auth,
    '../services/accessSession.service': sessions, '../services/googleAdsDiscovery.service': f.service,
    '../services/googlePropertyDiscovery.service': require('../../services/googleAdsDiscovery.service'),
    '../services/googlePropertyInventoryScope.service': { resolve: async () => state.effectiveMappings || [] },
    '../services/googleLegacyCredentials.service': legacy.credentials, '../services/scopeConnectionResolver.service': resolver,
    '../services/googleOAuthBroker.service': { assertLegacyConnection: async () => {}, bindingFor: async () => null },
    '../lib/oauthMarketingScopeAccess': require('../../lib/oauthMarketingScopeAccess'),
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async ({ userId, clinicIds, access }) => {
      assert.equal(access, 'write'); return state.allowed && userId === 701
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
  const app = express(); app.use('/oauth', router); const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: false }); agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
  const request = (route = 'ads/accounts', query = '?group_id=5&view=selection', authenticated = true) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, path: '/oauth/google/' + route + query,
      headers: authenticated ? { authorization: 'Bearer FICTITIOUS_JWT' } : {} }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); assert(!/FICTITIOUS_(SECRET|SQL|accessToken|refreshToken)/.test(text + JSON.stringify(state.logs)));
        resolve({ status: res.statusCode, body: JSON.parse(text), headers: res.headers });
      });
    }); req.on('error', reject); req.end();
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

'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('node:http'); const express = require('express');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const { searchConsoleFixture } = require('./fixtures/search_console_broker.fixture');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
async function fixture(t) {
  const f = searchConsoleFixture(); Object.assign(f.state, { allowed: true, mapped: true, session: true, legacy: 0, metadata: 0, writes: [] });
  const sessions = { bearer: value => { if (!value) throw Object.assign(Error(), { name: 'JsonWebTokenError' }); return value; },
    verify: async () => { if (!f.state.session) throw Object.assign(Error(), { name: 'JsonWebTokenError' });
      return { userId: 501, sessionVersion: f.state.legacySession ? undefined : 1, jti: '545aef07-91c3-4fbc-8ce4-75135575fd7e', exp: 1800000000 }; } };
  const auth = loadDiscoverySource('routes/auth.middleware.js', { '../services/accessSession.service': sessions });
  const models = { Clinica: { findByPk: async () => ({ url_web: 'https://example.invalid/' }) }, WebScDaily: { findOne: async () => null },
    WebPsiSnapshot: { findOne: async () => null, create: async value => { f.state.writes.push(value); await f.state.afterWrite?.(); return value; } } };
  const inventory = async () => { f.state.metadata++; return { google: { available_assets: { search_console: f.state.mapped ? [{
    mapping_id: 91, clinic_id: 71, connection_id: 81, site_url: f.mapping.siteUrl, assignment_origin: 'shared' }] : [] } } }; };
  const forbidden = () => { f.state.legacy++; assert.fail('A managed HTTP consumer cannot load or refresh Google tokens'); };
  const router = loadDiscoverySource('routes/web.routes.js', { express, sequelize: require('sequelize'), '../../models': models, './auth.middleware': auth,
    '../services/searchConsoleBroker.service': f.service, '../services/accessSession.service': sessions,
    '../services/googleLegacyCredentials.service': { load: forbidden, request: forbidden, safe: () => 'google_credentials_unavailable' },
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async ({ clinicIds }) => f.state.allowed && clinicIds.every(id => [71, 72].includes(id)) },
    '../services/effectiveMarketingAssets.service': { resolveEffectiveMarketingAssetInventory: inventory },
    axios: { post: forbidden, get: async () => ({ status: 200, data: { lighthouseResult: { categories: {}, audits: {} } } }), head: async () => ({ status: 404 }) },
  }, { logs: f.state.logs });
  const app = express(); app.use(router); const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: false }); agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
  f.request = (path, method = 'GET', authenticated = true) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, path, method,
      headers: authenticated ? { authorization: 'Bearer FICTITIOUS_MANAGED_JWT' } : {} }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); assert(!text.includes('FICTITIOUS_HIDDEN')); assert(!JSON.stringify(f.state.logs).includes('FICTITIOUS_HIDDEN'));
        resolve({ status: res.statusCode, body: JSON.parse(text) });
      });
    }); req.on('error', reject); req.end();
  }); return f;
}
test('managed HTTP pages keep the public DTO and shared mapping authorization without obtaining a credential', async t => {
  const f = await fixture(t); const result = await f.request('/clinica/72/sc/pages?startDate=2026-09-01&endDate=2026-09-02');
  assert.equal(result.status, 200); assert.deepEqual(result.body.items, [{ page: 'https://example.invalid/page', clicks: 2, impressions: 4, ctr: 0.5, position: 1 }]);
  assert.equal(result.body.partial, false); assert.equal(f.state.calls[0].tenantRef, 'clinic:71'); assert.equal(f.state.legacy, 0); assert(f.state.metadata >= 4);
});
test('managed HTTP status is explicitly metadata, with no provider availability claim or read operation', async t => {
  const f = await fixture(t); const result = await f.request('/clinica/71/status'); assert.equal(result.status, 200);
  assert.equal(result.body.googleConnected, false); assert.equal(result.body.googleConnectionStatus.managed_sites, 1);
  assert.equal(result.body.googleConnectionStatus.metadata_only, true); assert.equal(result.body.googleConnectionStatus.unavailable_sites, 0);
  assert.deepEqual(result.body.googleConnectionStatus.reasons, ['search_console_broker_metadata']); assert.equal(f.state.calls.length + f.state.legacy, 0);
});
test('authentication, managed sessions and current clinic access exclude unauthorized broker operations', async t => {
  const f = await fixture(t); assert.equal((await f.request('/clinica/71/sc/pages', 'GET', false)).status, 401);
  f.state.allowed = false; assert.equal((await f.request('/clinica/71/sc/pages')).status, 403);
  f.state.allowed = true; f.state.legacySession = true; assert.equal((await f.request('/clinica/71/sc/pages')).status, 401);
  assert.equal(f.state.calls.length + f.state.legacy, 0);
});
test('managed status propagates a rejected session and withholds cached metadata', async t => {
  const f = await fixture(t); f.state.legacySession = true;
  const result = await f.request('/clinica/71/status');
  assert.equal(result.status, 401); assert.equal(result.body.error, 'search_console_session_required');
  assert.equal(result.body.lastScDate, undefined); assert.equal(result.body.siteUrls, undefined);
  assert.equal(f.state.calls.length + f.state.legacy, 0);
});
test('lost permission or removed effective assignment during a provider read discards all HTTP rows', async t => {
  for (const change of [s => { s.allowed = false; }, s => { s.mapped = false; }, s => { s.session = false; }]) {
    const f = await fixture(t); f.state.afterCall = () => change(f.state);
    const result = await f.request('/clinica/71/sc/pages?startDate=2026-09-01&endDate=2026-09-02');
    assert([401, 403].includes(result.status), JSON.stringify(result)); assert.equal(result.body.items, undefined);
    assert.equal(f.state.calls.length, 1); assert.equal(f.state.legacy, 0);
  }
});
test('disabled cohort and conflicting persistent references never use a legacy token as fallback', async t => {
  const f = await fixture(t); f.state.enabled = false;
  const result = await f.request('/clinica/71/sc/pages'); assert.equal(result.status, 409);
  assert.equal(result.body.authorization_errors[0].reason, 'broker_cohort_disabled');
  f.state.enabled = true; f.state.record = null;
  const conflict = await f.request('/clinica/71/sc/pages'); assert.equal(conflict.status, 409);
  assert.equal(conflict.body.authorization_errors[0].reason, 'broker_binding_invalid'); assert.equal(f.state.calls.length + f.state.legacy, 0);
});
test('PSI uses broker index metadata, and loss of access at persistence prevents its HTTP disclosure', async t => {
  const f = await fixture(t); const first = await f.request('/clinica/71/psi/refresh', 'POST');
  assert.equal(first.status, 200); assert.equal(first.body.snapshot.indexed_ok, true); assert.equal(f.state.legacy, 0);
  f.state.afterWrite = () => { f.state.allowed = false; };
  const second = await f.request('/clinica/71/psi/refresh', 'POST'); assert.equal(second.status, 403); assert.equal(second.body.snapshot, undefined);
});

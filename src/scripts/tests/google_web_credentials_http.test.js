'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('node:http');
const express = require('express');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const { credentialsFixture } = require('./fixtures/google_legacy_credentials.fixture');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
async function fixture(t) {
  const f = credentialsFixture(); f.state.allowed = true; f.state.inventory = 0; f.state.posts = [];
  const models = { Clinica: { findByPk: async () => ({ url_web: 'https://fictitious.invalid/' }) },
    WebScDaily: { findOne: async () => null }, WebPsiSnapshot: { findOne: async () => null,
      create: async values => values } };
  const axios = {
    get: async url => ({ status: 200, data: url.includes('pagespeed') ? { lighthouseResult: { categories: {}, audits: {} } } : {} }),
    head: async () => ({ status: 404 }),
    post: async (url, body, options) => {
      f.state.posts.push(url); assert.equal(options.headers.Authorization, 'Bearer FICTITIOUS_accessToken_81');
      if (f.state.failProvider) throw Object.assign(Error('FICTITIOUS_PROVIDER_SECRET'), { code: 'FICTITIOUS_PROVIDER_SECRET', response: { data: 'FICTITIOUS_PROVIDER_SECRET' } });
      if (f.state.markDuringRequest) f.mark();
      return { data: { rows: [{ keys: ['https://fictitious.invalid/page'], clicks: 4, impressions: 8, ctr: 0.5, position: 1 }] } };
    },
  };
  const auth = loadDiscoverySource('routes/auth.middleware.js', { '../services/accessSession.service': {
    bearer: header => { if (!header) throw Object.assign(Error(), { name: 'JsonWebTokenError' }); return header; }, verify: async () => ({ userId: 501 }),
  } });
  const router = loadDiscoverySource('routes/web.routes.js', { express, axios, sequelize: require('sequelize'), '../../models': models,
    './auth.middleware': auth, '../services/googleLegacyCredentials.service': f.credentials, '../services/searchConsoleBroker.service': { prepare: async () => null },
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async input => f.state.allowed && input.clinicIds.every(id => id === 71) },
    '../services/effectiveMarketingAssets.service': { resolveEffectiveMarketingAssetInventory: async () => {
      f.state.inventory++; return { google: { available_assets: { search_console: [{ mapping_id: 91, connection_id: 81, clinic_id: 71, site_url: 'https://fictitious.invalid/' }] } } };
    } },
  }, { logs: f.state.logs });
  const app = express(); app.use(router); const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const agent = new http.Agent({ keepAlive: false }); agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
  f.request = (path, method = 'GET', authenticated = true) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, path, method,
      headers: authenticated ? { authorization: 'Bearer FICTITIOUS_JWT' } : {} }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); assert(!/FICTITIOUS_(?:accessToken|refreshToken|PROVIDER_SECRET)/.test(text + JSON.stringify(f.state.logs)));
        resolve({ status: res.statusCode, body: JSON.parse(text) });
      });
    }); req.on('error', reject); req.end();
  }); return f;
}
test('HTTP status reports an unavailable managed connection and pages returns 409 without token reads', async t => {
  const f = await fixture(t); f.mark();
  const status = await f.request('/clinica/71/status'); assert.equal(status.status, 200);
  assert.equal(status.body.googleConnected, false); assert.deepEqual(status.body.googleConnectionStatus.reasons, ['google_oauth_legacy_closed']);
  const pages = await f.request('/clinica/71/sc/pages'); assert.equal(pages.status, 409);
  assert.equal(pages.body.authorization_errors[0].reason, 'google_oauth_legacy_closed'); assert.equal(f.state.posts.length + f.state.loads + f.state.tokenReads, 0);
});
test('HTTP authentication and clinic permissions precede inventory and credential access', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/clinica/71/sc/pages', 'GET', false)).status, 401);
  assert.equal((await f.request('/clinica/72/sc/pages')).status, 403);
  f.state.allowed = false; assert.equal((await f.request('/clinica/71/status')).status, 403);
  assert.equal(f.state.inventory + f.state.posts.length + f.state.loads, 0);
});
test('unmarked web mappings preserve the business DTO and hide raw provider failures', async t => {
  const f = await fixture(t); const pages = await f.request('/clinica/71/sc/pages');
  assert.equal(pages.status, 200); assert.deepEqual(pages.body.items, [{ page: 'https://fictitious.invalid/page', clicks: 4, impressions: 8, ctr: 0.5, position: 1 }]);
  f.state.failProvider = true; const failed = await f.request('/clinica/71/sc/pages');
  assert.equal(failed.status, 409); assert.equal(failed.body.authorization_errors[0].reason, 'google_credentials_unavailable');
});
test('HTTP discards a provider response if the connection becomes managed during that request', async t => {
  const f = await fixture(t); f.state.markDuringRequest = true;
  const pages = await f.request('/clinica/71/sc/pages'); assert.equal(pages.status, 409);
  assert.equal(pages.body.authorization_errors[0].reason, 'google_oauth_legacy_closed'); assert.equal(pages.body.items, undefined);
  await f.request('/clinica/71/sc/pages'); assert.equal(f.state.posts.length, 1);
});
test('PSI refresh keeps its technical snapshot but skips OAuth URL inspection for a managed identity', async t => {
  const f = await fixture(t); f.mark(); const result = await f.request('/clinica/71/psi/refresh', 'POST');
  assert.equal(result.status, 200); assert.equal(result.body.snapshot.indexed_ok, null);
  assert.equal(f.state.posts.length + f.state.loads + f.state.tokenReads, 0);
});

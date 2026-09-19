'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('node:http');
const express = require('express'); const sequelize = require('sequelize'); const { randomUUID } = require('node:crypto');
const { loadDiscoverySource, unusedMetaSurfaceDependencies } = require('./fixtures/business_profile_discovery.fixture');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
async function fixture(t) {
  const state = { allowed: true, managed: true, globalClosed: true, begin: 0, callbacks: 0, statuses: 0, provider: 0, redis: 0, metadata: 0, logs: [], selections: [] };
  const sessionRef = randomUUID(); const conn = { id: 81 };
  for (const field of ['accessToken', 'refreshToken']) Object.defineProperty(conn, field, { get() { assert.fail('General API must not obtain a token'); } });
  const models = { Clinica: { findByPk: async () => ({ grupoClinicaId: 9 }), findAll: async () => [{ id_clinica: 71 }] } };
  const sessions = { bearer: value => { if (value !== 'Bearer FICTITIOUS_JWT') throw Object.assign(Error(), { name: 'JsonWebTokenError' }); return value; },
    verify: async () => ({ userId: 501, sessionVersion: 1, jti: sessionRef, exp: Math.floor(Date.now() / 1000) + 600 }) };
  const auth = loadDiscoverySource('routes/auth.middleware.js', { '../services/accessSession.service': sessions });
  const broker = {
    bindingFor: async (id, service) => {
      state.selections.push(service);
      if (service !== undefined && !['business_profile', 'search_console', 'analytics'].includes(service)) throw Object.assign(Error('FICTITIOUS_SECRET'), { code: 'google_oauth_service_invalid', httpStatus: 400 });
      return id === 81 && state.managed ? { google_connection_id: 81, cohort: service } : null;
    },
    assertLegacyAllowed: async () => { if (state.globalClosed) throw Object.assign(Error('FICTITIOUS_SECRET'), { code: 'google_oauth_legacy_closed', httpStatus: 409 }); },
    safe: e => e.code === 'google_oauth_legacy_closed' ? e.code : 'google_oauth_unavailable',
    begin: async input => { assert.equal(input.actorId, 501); assert.equal(input.scopeKey, 'clinic:71'); assert.equal(input.sessionRef, sessionRef);
      assert.equal(input.returnTo, 'https://app.clinicaclick.com'); state.begin++; return { success: true, mode: 'broker', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=FICTITIOUS_STATE' }; },
    callback: async input => { state.callbacks++; if (input.state !== 'FICTITIOUS_STATE') return null;
      assert.equal(input.code, 'FICTITIOUS_CODE'); assert.equal(input.denied, false);
      return { returnTo: 'https://app.clinicaclick.com', authorization_status: 'activation_pending', pending: true, activation_confirmed: false }; },
    status: async input => { assert.equal(input.scopeKey, 'clinic:71'); assert.equal(input.sessionRef, sessionRef); state.statuses++;
      return { mode: 'broker', connected: false, pending: true, authorization_status: 'activation_pending', enabled: true, activation_confirmed: false }; },
  };
  const router = loadDiscoverySource('routes/oauth.routes.js', { ...unusedMetaSurfaceDependencies(), express, sequelize, '../../models': models, './auth.middleware': auth,
    '../services/accessSession.service': sessions, '../services/googleOAuthBroker.service': broker,
    '../lib/oauthRedirect': require('../../lib/oauthRedirect'), '../lib/oauthMarketingScopeAccess': require('../../lib/oauthMarketingScopeAccess'),
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async ({ clinicIds }) => state.allowed && clinicIds.every(id => id === 71) },
    '../services/scopeConnectionResolver.service': { resolveGoogleConnectionForScope: async opts => {
      assert.equal(opts.metadataOnly, true); state.metadata++; return { connection: conn, scope: { scopeKey: 'clinic:71' }, assignment: { googleConnectionId: 81 } }; } },
    '../services/oauthState.service': { consumeOAuthState: async () => { state.redis++; throw Error('FICTITIOUS_SECRET'); } },
    axios: { post: async () => { state.provider++; assert.fail('Provider token exchange belongs to the broker'); } },
  }, { logs: state.logs });
  const app = express(); app.use('/oauth', router); const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const agent = new http.Agent({ keepAlive: false }); agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
  const request = (path, authenticated = true) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, path: '/oauth/google/' + path,
      headers: authenticated ? { authorization: 'Bearer FICTITIOUS_JWT' } : {} }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); assert(!text.includes('FICTITIOUS_SECRET'));
        assert(!JSON.stringify(state.logs).includes('FICTITIOUS_SECRET'));
        resolve({ status: res.statusCode, headers: res.headers, text, body: res.headers['content-type']?.includes('json') ? JSON.parse(text) : null });
      });
    }); req.on('error', reject); req.end();
  }); return { state, request };
}
test('managed connect and status resolve only metadata, carry a managed session and do not require API client secrets', async t => {
  const f = await fixture(t); const result = await f.request('connect?clinic_id=71&return_to=https%3A%2F%2Fapp.clinicaclick.com%2Fmarketing');
  assert.equal(result.status, 200, result.text); assert.equal(result.body.mode, 'broker'); assert.equal(result.headers['cache-control'], 'no-store');
  const status = await f.request('connection-status?clinic_id=71'); assert.equal(status.status, 200, status.text);
  assert.equal(status.body.pending, true); assert.equal(f.state.begin, 1); assert.equal(f.state.statuses, 1); assert.equal(f.state.provider + f.state.redis, 0);
});
test('one-use managed callback redirects to pending without returning state/code or contacting legacy OAuth', async t => {
  const f = await fixture(t); const result = await f.request('callback?state=FICTITIOUS_STATE&code=FICTITIOUS_CODE', false);
  assert.equal(result.status, 302); assert.equal(result.headers.location, 'https://app.clinicaclick.com/pages/settings?google_authorization=pending');
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert(!result.text.includes('FICTITIOUS_CODE')); assert(!result.text.includes('FICTITIOUS_STATE')); assert.equal(f.state.provider + f.state.redis, 0);
});
test('first binding globally closes unmatched legacy connect and callbacks with sanitized responses', async t => {
  const f = await fixture(t); f.state.managed = false;
  assert.equal((await f.request('connect?clinic_id=71')).status, 409);
  const result = await f.request('callback?state=foreign&code=FICTITIOUS_CODE&error=FICTITIOUS_SECRET', false);
  assert.equal(result.status, 302); assert(!result.headers.location.includes('FICTITIOUS_SECRET'));
  assert.equal(f.state.provider + f.state.redis, 0);
});
test('authentication and full scope permission precede managed state and URL reads', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('connect?clinic_id=71', false)).status, 401);
  assert.equal((await f.request('connect')).status, 400);
  assert.equal((await f.request('connect?clinic_id=72')).status, 403);
  f.state.allowed = false; assert.equal((await f.request('connection-status?clinic_id=71')).status, 403);
  assert.equal(f.state.begin + f.state.statuses + f.state.metadata, 0);
});
test('connect and status pass the explicit Google service to selection; invalid duplicated selectors fail before OAuth', async t => {
  const f = await fixture(t);
  for (const service of ['search_console', 'analytics']) {
    assert.equal((await f.request('connect?clinic_id=71&google_service=' + service)).status, 200);
    assert.equal((await f.request('connection-status?clinic_id=71&google_service=' + service)).status, 200);
  }
  assert.deepEqual(f.state.selections, ['search_console', 'search_console', 'analytics', 'analytics']);
  assert.equal((await f.request('connect?clinic_id=71&google_service=analytics&google_service=search_console')).status, 400);
  assert.equal((await f.request('connection-status?clinic_id=71&google_service=ads')).status, 400);
  assert.equal(f.state.begin, 2); assert.equal(f.state.statuses, 2); assert.equal(f.state.provider + f.state.redis, 0);
});

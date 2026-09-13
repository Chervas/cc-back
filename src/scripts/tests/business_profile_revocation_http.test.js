'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('node:http');
const express = require('express'); const sequelize = require('sequelize'); const jwt = require('jsonwebtoken'); const { randomBytes } = require('node:crypto');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
async function fixture(t, options = {}) {
  const state = { allowed: true, clinics: [71,72], pending: 1, writes: 0, attempts: 0, commits: 0, rolledBack: 0,
    checks: 0, reads: 0, propertyReads: 0, propertyPending: 0, propertyConfirmed: 0, propertyManaged: 0, adsManaged: 0, adsPending: 0, adsConfirmed: 0,
    resolves: 0, managed: 1, destroyed: 0, ...options }; const logs = [];
  const conn = { id: 81, googleUserId: 'fictitious-subject', destroy: async () => state.destroyed++ };
  const empty = { count: async () => 0, findAll: async () => [] };
  const models = { Clinica: { findByPk: async () => ({ grupoClinicaId: 9 }), findAll: async () => state.clinics.map(id_clinica => ({ id_clinica })) },
    GoogleConnection: empty, GoogleConnectionAssignment: { count: async () => 0,
      findOne: async () => ({ status: 'active', googleConnectionId: state.changedAssignment ? 82 : 81 }),
      upsert: async (value, { transaction }) => { assert.equal(value.status, 'disconnected'); transaction.writes++; await state.onUpsert?.(); } },
    ClinicWebAsset: empty, ClinicAnalyticsProperty: empty, ClinicGoogleAdsAccount: empty, ClinicBusinessLocation: empty,
    GoogleOAuthBrokerBinding: empty, SearchConsoleBrokerBinding: empty, AnalyticsBrokerBinding: empty, GoogleAdsBrokerBinding: empty, GoogleAdsBrokerRevocation: { count: async () => state.adsManaged },
    GooglePropertyBrokerRevocation: { count: async ({ where }) => {
      assert.deepEqual(JSON.parse(JSON.stringify(where[sequelize.Op.or])), [{ google_connection_id: 81 }, { google_user_id: 'fictitious-subject' }]); return state.propertyManaged;
    } },
    BusinessProfileBrokerBinding: { count: async () => state.managed }, BusinessProfileBrokerRevocation: empty,
    sequelize: { transaction: async fn => { const tx = { LOCK: { UPDATE: 'UPDATE' }, writes: 0, attempts: 0 };
      try { await fn(tx); state.writes += tx.writes; state.attempts += tx.attempts; state.commits++; }
      catch (error) { state.rolledBack++; throw error; }
    } } };
  const secret = randomBytes(32); const sessions = require('../../services/accessSession.service');
  const session = { ...sessions, ...sessions.createService({ models: () => assert.fail('No real models'), config: () => ({ mode: 'legacy', ttl: 43200, secret }) }) };
  const verify = session.verify; session.verify = async token => { state.checks++; if (state.revoked) throw new jwt.JsonWebTokenError('revoked'); return verify(token); };
  const auth = loadDiscoverySource('routes/auth.middleware.js', { '../services/accessSession.service': session });
  const resolver = loadDiscoverySource('services/scopeConnectionResolver.service.js', { '../../models': models, sequelize });
  const router = loadDiscoverySource('routes/oauth.routes.js', { express, sequelize, '../../models': models, './auth.middleware': auth,
    '../services/accessSession.service': session,
    '../services/scopeConnectionResolver.service': { ...resolver, resolveGoogleConnectionForScope: async opts => {
      assert.equal(opts.metadataOnly, true); state.resolves++; return { connection: conn, assignment: { googleConnectionId: 81 } };
    }, findSingleUserConnection: async (model, userId, attributes) => {
      assert.equal(Number(userId), 701); assert.deepEqual(Array.from(attributes), ['id', 'googleUserId']); return { connection: conn, ambiguous: false };
    } },
    '../lib/oauthMarketingScopeAccess': require('../../lib/oauthMarketingScopeAccess'),
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async ({ userId, clinicIds, access }) => {
      assert.equal(access, 'write'); return userId === 701 && state.allowed && clinicIds.every(id => state.clinics.includes(id));
    } },
    '../services/googleAdsRevocation.service': { status: async ids => {
      assert(ids.every(id => [71, 72].includes(id))); await state.onAdsStatus?.();
      if (state.adsStatusFailure) throw Error('FICTITIOUS_PRIVATE_ERROR');
      return { pending_assets: state.adsPending, confirmed_assets: state.adsConfirmed };
    } },
    '../services/googlePropertyRevocation.service': { status: async ids => {
      state.propertyReads++; assert(ids.every(id => [71, 72].includes(id))); await state.onPropertyStatus?.();
      if (state.propertyStatusFailure) throw Error('FICTITIOUS_SECRET');
      return { pending_assets: state.propertyPending, confirmed_assets: state.propertyConfirmed };
    } },
    '../services/businessProfileRevocation.service': { status: async ids => { state.reads++; assert(ids.every(id => state.clinics.includes(id)));
      await state.onStatus?.(); if (state.statusFailure) throw Error('FICTITIOUS_SECRET');
      return { status: state.pending ? 'pending' : 'confirmed', pending_assets: state.pending, confirmed_assets: state.pending ? 0 : 1 };
    } },
    '../services/oauthScopedDisconnect.service': { deactivateGoogleMappingsForScope: async args => {
      assert.equal(args.actorId, 701); assert.equal(args.connectionId, 81); args.transaction.attempts++;
      if (state.enqueueFailure === 'scope_disconnect_shared_asset_conflict') throw Object.assign(Error('La propiedad se utiliza fuera del ámbito.'), { code: state.enqueueFailure, httpStatus: 409 });
      if (state.enqueueFailure) throw Object.assign(Error('FICTITIOUS_SECRET'), { code: typeof state.enqueueFailure === 'string' ? state.enqueueFailure : 'gbp_revocation_unavailable' });
      return { brokerRevocationsPending: state.pending };
    } },
  }, { logs });
  const app = express(); app.use('/oauth', router); const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const agent = new http.Agent({ keepAlive: false }); agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
  const token = jwt.sign({ userId: 701 }, secret, { expiresIn: 60 });
  const request = ({ status = false, query = '?clinic_id=71', authenticated = true } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, method: status ? 'GET' : 'DELETE',
      path: '/oauth/google/' + (status ? 'disconnection-status' : 'disconnect') + query,
      headers: authenticated ? { authorization: 'Bearer ' + token } : {},
    }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()); assert(!JSON.stringify(body).includes('FICTITIOUS_SECRET')); assert(!JSON.stringify(logs).includes('FICTITIOUS_SECRET'));
      resolve({ status: res.statusCode, headers: res.headers, body });
    }); }); req.on('error', reject); req.end();
  }); return { state, request };
}
test('OAuth disconnect returns 202 only after a committed intent; status reads metadata with write scope', async t => {
  const f = await fixture(t); const result = await f.request(); assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(result.body.status, 'revocation_pending'); assert.equal(result.headers['cache-control'], 'private, no-store');
  assert.equal(f.state.commits, 1); assert.equal(f.state.attempts, 1); assert.equal(f.state.resolves, 1);
  const status = await f.request({ status: true }); assert.equal(status.status, 200); assert.equal(status.body.pending_assets, 1);
  assert.equal(status.headers['cache-control'], 'private, no-store');
  f.state.pending = 0; assert.equal((await f.request()).status, 200); assert.equal((await f.request({ status: true })).body.status, 'confirmed');
});
test('canonical authentication, explicit status scope and full management permission precede queries', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ authenticated: false })).status, 401); assert.equal((await f.request({ status: true, query: '' })).status, 400);
  assert.equal((await f.request({ status: true, query: '?clinic_id=99' })).status, 403); f.state.allowed = false;
  assert.equal((await f.request()).status, 403); assert.equal(f.state.resolves + f.state.reads + f.state.attempts, 0);
});
test('scope, assignment or session changes and queue failure roll back local disconnect', async t => {
  for (const [options, code] of [[{ changedAssignment: true }, 409], [{ enqueueFailure: true }, 503],
    [{ onUpsert: 'revoke' }, 401], [{ onUpsert: 'deny' }, 403], [{ onUpsert: 'group' }, 409]]) {
    const f = await fixture(t, options);
    if (options.onUpsert) f.state.onUpsert = () => { if (options.onUpsert === 'revoke') f.state.revoked = true;
      else if (options.onUpsert === 'deny') f.state.allowed = false; else f.state.clinics = [71]; };
    const result = await f.request({ query: '?group_id=9' }); assert.equal(result.status, code, JSON.stringify(result.body));
    assert.equal(f.state.writes + f.state.attempts + f.state.commits, 0); assert.equal(f.state.rolledBack, 1);
  }
});
test('status loses stale metadata on post-read revocation, scope loss, membership change or SQL failure', async t => {
  for (const [change, code] of [[state => { state.revoked = true; }, 401], [state => { state.allowed = false; }, 403],
    [state => { state.clinics = [71]; }, 403], [state => { state.statusFailure = true; }, 503]]) {
    const f = await fixture(t); f.state.onStatus = () => change(f.state);
    const result = await f.request({ status: true, query: '?group_id=9' }); assert.equal(result.status, code); assert.equal(result.body.pending_assets, undefined);
  }
});
test('unscoped deletion refuses connections with any surviving managed reference', async t => {
  const f = await fixture(t); assert.equal((await f.request({ query: '' })).status, 409); assert.equal(f.state.destroyed, 0);
});
test('property metadata is aggregated with GBP and a property-only tombstone prevents unscoped deletion', async t => {
  const f = await fixture(t, { managed: 0, propertyManaged: 1, propertyPending: 2, propertyConfirmed: 3 });
  assert.deepEqual((await f.request({ status: true })).body, { status: 'pending', pending_assets: 3, confirmed_assets: 3 });
  f.state.pending = 0; f.state.propertyPending = 0;
  assert.deepEqual((await f.request({ status: true })).body, { status: 'confirmed', pending_assets: 0, confirmed_assets: 4 });
  assert.equal((await f.request({ query: '' })).status, 409); assert.equal(f.state.destroyed, 0);
});
test('SC/GA capture errors and shared conflicts roll back the HTTP transaction with closed errors', async t => {
  for (const [error, status] of [['google_ads_revocation_unavailable', 503], ['google_property_revocation_unavailable', 503], ['scope_disconnect_shared_asset_conflict', 409]]) {
    const f = await fixture(t, { enqueueFailure: error }); const result = await f.request();
    assert.equal(result.status, status); assert.equal(result.body.error, error);
    assert.equal(f.state.writes + f.state.attempts + f.state.commits, 0); assert.equal(f.state.rolledBack, 1);
  }
});
test('post-property status checks discard data on session or scope loss and fail closed on invalid counts', async t => {
  for (const [change, code] of [[state => { state.revoked = true; }, 401], [state => { state.allowed = false; }, 403],
    [state => { state.clinics = [71]; }, 403], [state => { state.propertyStatusFailure = true; }, 503],
    [state => { state.propertyPending = Number.MAX_SAFE_INTEGER; }, 503]]) {
    const f = await fixture(t); f.state.onPropertyStatus = () => change(f.state);
    const result = await f.request({ status: true, query: '?group_id=9' }); assert.equal(result.status, code);
    assert.equal(result.body.pending_assets, undefined); if (code === 503) assert.equal(result.body.error, 'google_revocation_unavailable');
  }
});

test('Ads history joins status totals, closes unscoped deletion and cannot leak metadata after scope/session loss', async t => {
  const f = await fixture(t, { managed: 0, adsManaged: 1, adsPending: 2, adsConfirmed: 3 });
  assert.deepEqual((await f.request({ status: true, query: '?group_id=9' })).body, { status: 'pending', pending_assets: 3, confirmed_assets: 3 });
  assert.equal((await f.request({ query: '' })).status, 409); assert.equal(f.state.destroyed, 0);
  for (const [change, code] of [[s => { s.revoked = true; }, 401], [s => { s.allowed = false; }, 403],
    [s => { s.clinics = [71]; }, 403], [s => { s.adsStatusFailure = true; }, 503], [s => { s.adsPending = Number.MAX_SAFE_INTEGER; }, 503]]) {
    const f = await fixture(t); f.state.onAdsStatus = () => change(f.state);
    const result = await f.request({ status: true, query: '?group_id=9' }); assert.equal(result.status, code); assert.equal(result.body.pending_assets, undefined);
  }
});

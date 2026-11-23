'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('node:http');
const express = require('express'); const sequelize = require('sequelize');
const { loadDiscoverySource, unusedMetaSurfaceDependencies } = require('./fixtures/business_profile_discovery.fixture');
const { propertyFixture } = require('./fixtures/google_property_discovery.fixture');
const { credentialsFixture } = require('./fixtures/google_legacy_credentials.fixture');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
async function fixture(t, kind = 'analytics') {
  const f = propertyFixture(kind); const { state } = f; const legacy = credentialsFixture(); let legacyCalls = 0; let refreshes = 0;
  const reviewedCalls = [];
  const reviewed = {
    async additionStatus(loadInput, hint) {
      if (!state.reviewed) return null;
      const input = await loadInput();
      reviewedCalls.push({ operation: 'status', scopeKey: input.scopeKey, hint });
      return state.reviewed.status;
    },
    async inventory(input) {
      reviewedCalls.push({ operation: 'inventory', scopeKey: input.scopeKey, clinicIds: input.clinicIds });
      return state.reviewed.catalogue;
    },
    async map(input, payload) {
      reviewedCalls.push({ operation: 'map', scopeKey: input.scopeKey, payload });
      if (state.reviewed.error) throw Object.assign(Error('FICTITIOUS_SECRET_PRIVATE'), state.reviewed.error);
      return state.reviewed.receipt;
    },
  };
  const sessions = { bearer: value => { if (!value) throw Object.assign(Error('unauthenticated'), { name: 'JsonWebTokenError' }); return value; }, verify: async () => {
    if (!state.session) throw Object.assign(Error('session_revoked'), { name: 'JsonWebTokenError' }); return { userId: 701, sessionVersion: state.legacySession ? undefined : 1,
      jti: '545aef07-91c3-4fbc-8ce4-75135575fd7e', exp: 1800000000 }; } };
  const auth = loadDiscoverySource('routes/auth.middleware.js', { '../services/accessSession.service': sessions });
  const empty = { findAll: async () => [] };
  const models = { Clinica: { findByPk: async () => ({ grupoClinicaId: 9 }), findAll: async () => state.groupChanged ? [{ id_clinica: 71 }] : [{ id_clinica: 71 }, { id_clinica: 72 }] },
    GoogleConnection: { rawAttributes: { updated_at: {} }, findByPk: async (_id, query) => {
      assert.deepEqual(Array.from(query.attributes), ['id']); return { id: state.changedConnection ? 82 : 81 };
    }, findAll: async query => { assert.deepEqual(Array.from(query.attributes), ['id']); return state.noConnection ? [] : [{ id: 81 }]; } },
    GoogleConnectionAssignment: { findOne: async query => { assert.deepEqual(Array.from(query.include[0].attributes), ['id']);
      return state.noConnection ? null : { googleConnection: { id: state.changedConnection ? 82 : 81 } }; } },
    ClinicGoogleAdsAccount: empty, ClinicAnalyticsProperty: empty, ClinicWebAsset: empty, ClinicBusinessLocation: empty };
  const resolver = loadDiscoverySource('services/scopeConnectionResolver.service.js', { '../../models': models, sequelize });
  const router = loadDiscoverySource('routes/oauth.routes.js', { ...unusedMetaSurfaceDependencies(), express, sequelize, '../../models': models, './auth.middleware': auth,
    './googleOAuthAdmission.http': { createGoogleOAuthAdmissionHttpAdapter: () => ({
      router: () => assert.fail('Unexpected first identity router'), callback: () => assert.fail('Unexpected first identity callback'),
    }) },
    '../lib/googleCutoverAdmission': { application: { run: async (operation, work) => {
      assert.equal(operation, 'oauth_refresh'); return work();
    } } },
    '../services/accessSession.service': sessions, '../services/googlePropertyDiscovery.service': f.service,
    '../services/googleReviewedAnalyticsMapping.service': reviewed,
    '../services/googleReviewedSearchConsoleMapping.service': { inventory: async () => [], map: async () => assert.fail('No reviewed descriptor in this historical fixture') },
    '../services/googlePropertyInventoryScope.service': { resolve: async () => state.effectiveMappings || [] },
    '../services/googleLegacyCredentials.service': legacy.credentials, '../services/scopeConnectionResolver.service': resolver,
    '../services/googleOAuthBroker.service': { assertLegacyConnection: async () => {}, bindingFor: async (_id, service) =>
      state.reviewed && service === 'analytics' ? {} : null },
    '../lib/oauthMarketingScopeAccess': require('../../lib/oauthMarketingScopeAccess'),
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async ({ userId, clinicIds, access }) => {
      if (!state.reviewed) assert.equal(access, state.statusRequest ? 'read' : 'write'); return state.allowed && userId === 701
        && clinicIds.every(id => state.onlyRecipient ? id === 72 : [71, 72].includes(id)); } },
    axios: { get: async url => {
      legacyCalls++; await state.afterLegacy?.();
      return { data: url.includes('accountSummaries') ? { accountSummaries: [{ name: 'accountSummaries/456', displayName: 'Fictitious legacy account',
        propertySummaries: [{ property: 'properties/123', displayName: 'Fictitious legacy property', propertyType: 'PROPERTY_TYPE_ORDINARY', parent: 'accounts/456' }] }],
        ...(state.repeatCursor ? { nextPageToken: 'same-fictitious-cursor' } : {}) } : { siteEntry: [{ siteUrl: 'sc-domain:example.invalid', permissionLevel: 'siteOwner' }] } };
    }, post: async url => { assert.equal(url, 'https://oauth2.googleapis.com/token'); refreshes++; await state.afterRefresh?.();
      return { data: { access_token: 'FICTITIOUS_accessToken_refresh', expires_in: 3600 } }; } },
  }, { logs: state.logs });
  const app = express(); app.use(express.json()); app.use('/oauth', router); const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: false }); agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
  const request = (route = kind === 'analytics' ? 'analytics/properties' : 'assets', query = '?clinic_id=71', authenticated = true, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, path: '/oauth/google/' + route + query,
      method: body ? 'POST' : 'GET', headers: { ...(authenticated ? { authorization: 'Bearer FICTITIOUS_JWT' } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); assert(!/FICTITIOUS_(SECRET|SQL|accessToken|refreshToken)/.test(text + JSON.stringify(state.logs)));
        resolve({ status: res.statusCode, body: JSON.parse(text), headers: res.headers });
      });
    }); req.on('error', reject); req.end(body && JSON.stringify(body));
  }); return { ...f, request, legacy, legacyCalls: () => legacyCalls, refreshes: () => refreshes, reviewedCalls };
}
for (const kind of ['search_console', 'analytics']) {
  test(kind + ' actual OAuth inventory route preserves DTO, requires managed session and never hydrates credentials', async t => {
    const f = await fixture(t, kind); const result = await f.request(); assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.inventory_mode, 'broker_grants'); assert.equal(result.headers['cache-control'], 'private, no-store');
    if (kind === 'analytics') {
      assert.equal(result.body.accounts[0].accountName, 'accountSummaries/456'); assert.equal(result.body.accounts[0].accountDisplayName, 'accounts/456');
      assert.equal(result.body.accounts[0].properties[0].propertyName, 'properties/123');
    } else { assert.equal(result.body.assets[0].propertyType, 'sc-domain'); assert.equal(result.body.total, 1); }
    assert.equal(f.legacy.state.loads + f.legacyCalls(), 0);
  });
  test(kind + ' no session, absent scope, foreign clinic and legacy session fail before broker or credentials', async t => {
    const f = await fixture(t, kind); assert.equal((await f.request(undefined, undefined, false)).status, 401);
    assert.equal((await f.request(undefined, '')).status, 400); assert.equal((await f.request(undefined, '?clinic_id=999')).status, 403);
    f.state.legacySession = true; assert.equal((await f.request()).status, 401);
    assert.equal(f.state.calls.length + f.legacy.state.loads + f.legacyCalls(), 0);
  });
  test(kind + ' scope, session or connection changes while reading prevent HTTP disclosure', async t => {
    for (const [change, expected] of [[s => { s.allowed = false; }, 403], [s => { s.session = false; }, 401], [s => { s.changedConnection = true; }, 409]]) {
      const f = await fixture(t, kind); f.state.afterCall = () => change(f.state);
      const result = await f.request(); assert.equal(result.status, expected, JSON.stringify(result.body));
      assert.equal(result.body.assets, undefined); assert.equal(result.body.accounts, undefined); assert.equal(f.legacy.state.loads + f.legacyCalls(), 0);
    }
  });
  test(kind + ' pre-cut legacy uses conditional credential loader and stops on a marker committed during provider await', async t => {
    const f = await fixture(t, kind); f.state.managed = false; f.state.legacySession = true;
    assert.equal((await f.request()).status, 200); assert.equal(f.legacy.state.loads, 1); assert.equal(f.legacyCalls(), 1);
    f.state.afterLegacy = () => { f.state.managed = true; f.legacy.mark(); };
    const result = await f.request(); assert.equal(result.status, 409); assert.equal(result.body.error, 'google_oauth_legacy_closed');
    assert.equal(result.body.assets, undefined); assert.equal(result.body.accounts, undefined);
  });
  test(kind + ' actual recipient-clinic route rechecks shared assignment and does not require owner-clinic permission', async t => {
    const f = await fixture(t, kind); f.state.onlyRecipient = true; f.state.effectiveMappings = [{ mapping_id: 91, clinic_id: 71, connection_id: 81,
      resource: f.mapping.siteUrl || f.mapping.propertyName }];
    const result = await f.request(undefined, '?clinic_id=72'); assert.equal(result.status, 200); assert.equal(f.state.calls[0].tenantRef, 'clinic:71');
    f.state.afterCall = () => { f.state.effectiveMappings = []; };
    assert.equal((await f.request(undefined, '?clinic_id=72')).status, 403); assert.equal(f.legacy.state.loads + f.legacyCalls(), 0);
  });
}
test('GA status verifies exact registered properties and does not claim whole account or OAuth health', async t => {
  const f = await fixture(t); const result = await f.request('analytics/connection-status'); assert.equal(result.status, 200);
  assert.equal(result.body.connected, true); assert.equal(result.body.verification, 'registered_properties_read'); assert.equal(result.body.accounts, 1);
  assert.equal(result.body.expiresAt, undefined); assert.equal(f.state.calls.length, 1); assert.equal(f.legacy.state.loads, 0);
  f.state.noConnection = true;
  const missing = await f.request('analytics/connection-status'); assert.equal(missing.status, 200); assert.equal(missing.body.reason, 'no_connection');
  assert.equal((await f.request()).status, 404); assert.equal(f.state.calls.length, 1);
});
test('generic Google status closes before a second resolver can hydrate after the first registered cut', async t => {
  const f = await fixture(t); f.state.statusRequest = true; const result = await f.request('connection-status');
  assert.equal(result.status, 409); assert.equal(result.body.reason, 'google_oauth_legacy_closed'); assert.equal(f.legacy.state.loads + f.legacyCalls(), 0);
});
test('legacy GA repeated pagination fails with fixed errors and never returns partial accounts', async t => {
  const f = await fixture(t); f.state.managed = false; f.state.repeatCursor = true;
  const result = await f.request(); assert.equal(result.status, 503); assert.equal(f.legacyCalls(), 2); assert.equal(result.body.accounts, undefined);
});
test('whole group membership is revalidated after managed discovery awaits', async t => {
  const f = await fixture(t); assert.equal((await f.request(undefined, '?group_id=9')).status, 200);
  f.state.afterCall = () => { f.state.groupChanged = true; };
  const result = await f.request(undefined, '?group_id=9'); assert.equal(result.status, 409); assert.equal(result.body.accounts, undefined);
});
test('a marker committed during a fictitious legacy refresh prevents SQL write and subsequent provider listing', async t => {
  const f = await fixture(t); f.state.managed = false; f.legacy.state.rows.get(81).expiresAt = new Date('2000-01-01');
  f.state.afterRefresh = () => { f.state.managed = true; f.legacy.mark(); };
  const result = await f.request(); assert.equal(result.status, 503); assert.equal(result.body.accounts, undefined);
  assert.equal(f.refreshes(), 1); assert.equal(f.legacy.state.updates + f.legacyCalls(), 0);
});

const reviewedQuery = '?clinic_id=71&assignment_scope=clinic&reviewed_addition=1';
const reviewedBody = { clinic_id: 71, assignment_scope: 'clinic', reviewed_addition: true,
  mappings: [{ clinicaId: 71, propertyName: 'properties/789' }], replace_existing: false };
const reviewedStatus = { mode: 'broker_reviewed_addition', connected: false, google_service: 'analytics',
  inventory_access: 'operator_reviewed_exact_property' };
function seedReviewed(f) {
  f.state.reviewed = { status: reviewedStatus, catalogue: { properties: [{ name: 'properties/789', displayName: 'Reviewed GA4',
    propertyType: 'PROPERTY_TYPE_ORDINARY', account: 'accounts/123', parent: 'accounts/123' }],
    destinations: [{ propertyName: 'properties/789', clinicIds: [71] }] },
  receipt: { success: true, mapped: 1, inventory_mode: 'broker_grants', assets: [{ id: 91, clinicaId: 71, propertyName: 'properties/789' }] } };
}

test('reviewed Analytics generic/dedicated status stays disconnected and exposes no provider inventory or credentials', async t => {
  const f = await fixture(t); seedReviewed(f);
  for (const route of ['connection-status', 'analytics/connection-status']) {
    const result = await f.request(route, '?google_service=analytics&clinic_id=71&assignment_scope=clinic');
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body, reviewedStatus);
    assert.match(result.headers['cache-control'], /no-store/);
  }
  assert.deepEqual(f.reviewedCalls.map(call => [call.operation, call.scopeKey, call.hint.scopeKey, call.hint.connectionId]),
    Array(2).fill(['status', 'clinic:71', 'clinic:71', 81]));
  assert.equal(f.state.calls.length + f.legacyCalls() + f.legacy.state.loads, 0);
});

test('reviewed Analytics catalogue is explicitly selected and exact destinations are preserved for a complete group', async t => {
  const f = await fixture(t); seedReviewed(f);
  const result = await f.request('analytics/properties', '?group_id=9&assignment_scope=group&reviewed_addition=1');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.accounts[0].properties[0].propertyName, 'properties/789');
  assert.deepEqual(result.body.reviewed_properties, [{ propertyName: 'properties/789', clinicIds: [71] }]);
  assert.deepEqual(f.reviewedCalls.map(call => [call.operation, call.scopeKey, [...call.clinicIds]]), [['inventory', 'group:9', [71,72]]]);
  assert.equal(f.state.calls.length + f.legacyCalls() + f.legacy.state.loads, 0);

  const ordinary = await f.request('analytics/properties');
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.body));
  assert.equal(ordinary.body.accounts[0].properties[0].propertyName, 'properties/123');
  assert.equal(ordinary.body.reviewed_properties, undefined);
});

test('reviewed Analytics denies an out-of-scope actor before a catalogue or mapping call', async t => {
  const f = await fixture(t); seedReviewed(f);
  f.state.allowed = false;
  assert.equal((await f.request('analytics/properties', reviewedQuery)).status, 403);
  assert.equal((await f.request('analytics/map-properties', '', true, reviewedBody)).status, 403);
  assert.equal(f.reviewedCalls.length + f.state.calls.length + f.legacy.state.loads, 0);
});

test('reviewed Analytics tolerates no pending review but does not fall back to legacy on a missing or withdrawn review', async t => {
  const f = await fixture(t); seedReviewed(f);
  f.state.reviewed.status = null;
  const normal = await f.request('analytics/connection-status');
  assert.equal(normal.body.verification, 'registered_properties_read');
  f.state.reviewed.catalogue = { properties: [], destinations: [] };
  const result = await f.request('analytics/properties', reviewedQuery);
  assert.deepEqual(result.body, { success: true, accounts: [], inventory_mode: 'broker_grants', reviewed_properties: [] });
  for (const [code, status] of [['asset_revoked', 409], ['broker_discovery_scope_unconfigured', 409], ['provider_unauthorized', 403]]) {
    f.state.reviewed.error = { code };
    const failure = await f.request('analytics/map-properties', '', true, reviewedBody);
    assert.equal(failure.status, status);
    assert.deepEqual(failure.body, { success: false, error: code });
  }
  assert.equal(f.legacyCalls() + f.legacy.state.loads, 0);
});

test('reviewed Analytics confirmation returns only the native receipt, with strict scope and no replacement', async t => {
  const f = await fixture(t); seedReviewed(f);
  for (const [body, query] of [
    [{ ...reviewedBody, replace_existing: true }, ''],
    [{ ...reviewedBody, group_id: 9 }, ''],
    [{ ...reviewedBody, clinic_id: '71' }, ''],
    [{ ...reviewedBody, reviewed_addition: 'true' }, ''],
    [reviewedBody, '?clinic_id=72'],
  ]) assert.equal((await f.request('analytics/map-properties', query, true, body)).status, 400);
  assert.equal(f.reviewedCalls.length, 0);
  for (let i = 0; i < 2; i++) {
    const result = await f.request('analytics/map-properties', '', true, reviewedBody);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body, f.state.reviewed.receipt);
    assert.match(result.headers['cache-control'], /no-store/);
  }
  assert.deepEqual(f.reviewedCalls.map(call => [call.operation, call.scopeKey, call.payload.mappings[0].clinicaId]),
    Array(2).fill(['map', 'clinic:71', 71]));
  assert.equal(f.legacyCalls() + f.legacy.state.loads, 0);
});

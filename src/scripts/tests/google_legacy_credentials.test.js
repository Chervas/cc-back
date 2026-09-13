'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict');
const { credentialsFixture } = require('./fixtures/google_legacy_credentials.fixture');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const { loadBusinessProfileJobs } = require('./fixtures/business_profile_jobs.fixture');
function web(f) {
  return loadDiscoverySource('routes/web.routes.js', { express: require('express'), '../../models': {},
    '../services/googleLegacyCredentials.service': f.credentials, './auth.middleware': (_req, _res, next) => next() }).__test;
}
test('a durable OAuth marker excludes the ID and duplicate Google subjects before credential loads or getters', async () => {
  const f = credentialsFixture(); f.add(82); f.mark();
  for (const id of [81, 82]) await assert.rejects(f.credentials.load(id), { code: 'google_oauth_legacy_closed' });
  f.state.rows.delete(81); await assert.rejects(f.create().load(81), { code: 'google_oauth_legacy_closed' });
  f.add(81, 'different-subject'); await assert.rejects(f.create().load(81), { code: 'google_oauth_legacy_closed' });
  assert.equal(f.state.loads + f.state.tokenReads + f.state.updates, 0);
});
test('missing schema/metadata, invalid identities and malformed IDs fail closed with fixed errors', async () => {
  const f = credentialsFixture();
  for (const id of [0, -1, '81x', '8.1', '8e1', ' 81', '081', 2147483648, null]) await assert.rejects(f.credentials.load(id), { code: 'google_connection_missing' });
  await assert.rejects(f.credentials.assert({ id: 81 }), { code: 'google_connection_changed' });
  f.state.failMetadata = true; await assert.rejects(f.credentials.load(81), { message: 'google_credentials_unavailable' });
  assert.equal(f.state.loads + f.state.tokenReads, 0);
});
test('conditional load and refresh cannot cross a marker committed after their metadata check', async () => {
  const f = credentialsFixture(); f.state.beforeLoad = () => f.mark();
  await assert.rejects(f.credentials.load(81), { code: 'google_oauth_legacy_closed' }); assert.equal(f.state.loads, 0);
  const g = credentialsFixture(); const row = await g.credentials.load(81); g.state.beforeUpdate = () => g.mark();
  await assert.rejects(g.credentials.saveRefresh(row, { accessToken: 'FICTITIOUS_NEW', expiresAt: new Date('2099-01-01') }), { code: 'google_oauth_legacy_closed' });
  assert.equal(g.state.updates, 0);
});
test('cached identity and provider response are revalidated, and a new service instance still blocks', async () => {
  const f = credentialsFixture(); const row = await f.credentials.load(81); let calls = 0;
  await assert.rejects(f.credentials.request(row, async () => { calls++; f.mark(); return { data: 'FICTITIOUS_PROVIDER_DATA' }; }), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(f.create().request(row, async () => calls++), { code: 'google_oauth_legacy_closed' }); assert.equal(calls, 1);
  const g = credentialsFixture(); const cached = await g.credentials.load(81); g.add(81, 'changed-subject');
  await assert.rejects(g.credentials.request(cached, async () => assert.fail('Old identity cannot send')), { code: 'google_connection_changed' });
});
test('web cache is scoped by connection, closes after a marker, evicts the old entry and rejects ambiguous IDs', async () => {
  const f = credentialsFixture(); f.add(82, 'separate-subject'); const helpers = web(f); const cache = new Map();
  const get = id => helpers.getAccessTokenForWebMapping({ googleConnectionId: id }, cache);
  assert.equal((await get(81)).accessToken, 'FICTITIOUS_accessToken_81');
  assert.equal((await get(82)).accessToken, 'FICTITIOUS_accessToken_82');
  await get(81); assert.equal(f.state.loads, 2);
  f.mark(); const reads = f.state.tokenReads;
  await assert.rejects(get(81), { code: 'google_oauth_legacy_closed' }); assert.equal(cache.has(81), false);
  await assert.rejects(get('81x'), { code: 'web_mapping_connection_missing' });
  assert.equal(f.state.tokenReads, reads); assert.equal(cache.has(82), true);
});
test('web and job refresh discard a response when registration occurs during exchange, with no SQL write', async () => {
  for (const source of ['web', 'jobs']) {
    const f = credentialsFixture(); const connection = f.state.rows.get(81); connection.expiresAt = new Date('2000-01-01');
    const http = { post: async () => { f.mark(); return { data: { access_token: 'FICTITIOUS_NEW', expires_in: 3600 } }; } };
    const task = source === 'web' ? web(f).getGoogleAccessTokenForConnection(81, { http })
      : loadBusinessProfileJobs({ credentials: f.credentials, models: {}, legacyHttp: http }).__test.ensureGoogleConnectionAccessToken(connection,
        { env: { GOOGLE_CLIENT_ID: 'FICTITIOUS_ID', GOOGLE_CLIENT_SECRET: 'FICTITIOUS_SECRET' } });
    await assert.rejects(task, { code: 'google_oauth_legacy_closed' }); assert.equal(f.state.updates, 0);
  }
});
test('job token loader excludes a managed connection before hydrating, even with every broker gate off', async () => {
  const f = credentialsFixture(); f.mark(); const jobs = loadBusinessProfileJobs({ credentials: f.credentials, models: {}, legacyHttp: {} }).metaSyncJobs;
  await assert.rejects(jobs._ensureGoogleAccessToken(81), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(jobs._runGaReport({ connection: f.state.rows.get(81), accessToken: 'FICTITIOUS_CACHED' }, 'properties/123', {}), { code: 'google_oauth_legacy_closed' });
  assert.equal(f.state.loads + f.state.tokenReads, 0);
});
test('provider failures never reflect messages, bodies or arbitrary error codes', async () => {
  const f = credentialsFixture(); const row = await f.credentials.load(81);
  await assert.rejects(f.credentials.request(row, async () => { throw Object.assign(Error('FICTITIOUS_SECRET'), { code: 'FICTITIOUS_SECRET', response: { data: 'FICTITIOUS_SECRET' } }); }),
    error => error.code === 'google_credentials_unavailable' && error.message === error.code && error.response === undefined);
});

'use strict';
require('./fixtures/scheduled_jobs.fixture.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { credentialsFixture } = require('./fixtures/google_legacy_credentials.fixture');
const { loadBusinessProfileJobs } = require('./fixtures/business_profile_jobs.fixture');
const legacy = require('../../services/googleLegacyCredentials.service');
const boundary = require('../../services/googleAdsLegacyConnection.service');
const runtime = require('../../services/googleAdsScopedRuntime.service');
const onboarding = require('../../controllers/campaignOnboarding.controller').__test;
const diagnostics = require('../../services/googleDataManagerDiagnostics.service');
function fixture() {
  const f = credentialsFixture();
  f.state.rows.get(81).scopes = `${runtime.GOOGLE_ADS_SCOPE} ${runtime.GOOGLE_DATA_MANAGER_SCOPE}`;
  return f;
}
function attempts(count = 1) {
  return Array.from({ length: count }, (_, i) => ({ googleConnectionId: 81, status: 'accepted', providerRequestId: 'FICTITIOUS_' + i,
    update: async function (values) { Object.assign(this, values); } }));
}
for (const registry of ['markers', 'scMarkers', 'gaMarkers', 'propertyMarkers', 'adsMarkers', 'adsRevocations']) {
  test(`Ads rejects ${registry} before loading any credential, including duplicate subjects`, async () => {
    const f = fixture(); f.add(82);
    f.state[registry].push({ google_connection_id: 81, google_user_id: 'fictitious-subject' });
    for (const id of [81, 82]) await assert.rejects(boundary.loadGoogleAdsLegacyConnection(f.models, id), { code: 'google_oauth_legacy_closed' });
    assert.equal(f.state.loads + f.state.tokenReads + f.state.updates, 0);
  });
}
test('Ads metadata keeps caller locks; tokens and registry guards are selected outside an old transaction', async () => {
  const f = fixture(); const transaction = { LOCK: { UPDATE: 'UPDATE' } }; const calls = [];
  const read = f.models.GoogleConnection.findByPk;
  f.models.GoogleConnection.findByPk = async (id, options) => { calls.push(options); return read(id, options); };
  const connection = await boundary.loadGoogleAdsLegacyConnection(f.models, 81, { transaction, lock: 'UPDATE' });
  assert.equal(calls[0].transaction, transaction); assert.equal(calls[0].lock, 'UPDATE');
  assert.ok(calls.slice(1).every(options => options.transaction === undefined));
  assert.equal(connection.scopes, `${runtime.GOOGLE_ADS_SCOPE} ${runtime.GOOGLE_DATA_MANAGER_SCOPE}`);
});
test('captured subject cannot be replaced before loading credentials; unreadable registry closes the path', async () => {
  const f = fixture(); const read = f.models.GoogleConnection.findByPk; let calls = 0;
  f.models.GoogleConnection.findByPk = async (...args) => { if (++calls === 2) f.add(81, 'replacement'); return read(...args); };
  await assert.rejects(boundary.loadGoogleAdsLegacyConnection(f.models, 81), { code: 'google_connection_changed' });
  assert.equal(f.state.loads + f.state.tokenReads, 0);
  const g = fixture(); delete g.models.AnalyticsBrokerBinding;
  await assert.rejects(boundary.loadGoogleAdsLegacyConnection(g.models, 81), { code: 'google_credentials_unavailable' });
  assert.equal(g.state.loads, 0);
  const h = fixture(); h.state.failMetadata = true;
  await assert.rejects(boundary.loadGoogleAdsLegacyConnection(h.models, 81), { message: 'google_credentials_unavailable' });
});
test('runtime preserves direct clinic grant selection and rejects ambiguity before credentials', async () => {
  const f = fixture(); const account = { googleConnectionId: 81, clinicaId: 71, customerId: '123', loginCustomerId: '456' };
  const input = { clinicId: 71, groupId: 7, customerId: '123', credentials: f.credentials,
    accountModel: { findAll: async () => [{ googleConnectionId: 82, grupoClinicaId: 7 }, account] } };
  assert.equal((await runtime.resolveScopedGoogleAdsRuntime(input)).connection.id, 81);
  input.accountModel.findAll = async () => [account, { ...account, googleConnectionId: 82 }]; const reads = f.state.loads;
  await assert.rejects(runtime.resolveScopedGoogleAdsRuntime(input), { code: 'GOOGLE_ADS_ACCOUNT_MAPPING_AMBIGUOUS' });
  assert.equal(f.state.loads, reads);
  f.mark(); input.accountModel.findAll = async () => [account];
  await assert.rejects(runtime.resolveScopedGoogleAdsRuntime(input), { code: 'google_oauth_legacy_closed' });
});
test('no-refresh paths revalidate stale instances before reading tokens', async () => {
  for (const ensure of [runtime.ensureGoogleConnectionAccessToken, onboarding.ensureGoogleAccessToken]) {
    const f = fixture(); const row = f.state.rows.get(81); f.mark();
    await assert.rejects(ensure(row, { credentials: f.credentials, allowExpired: true }), { code: 'google_oauth_legacy_closed' });
    assert.equal(f.state.tokenReads + f.state.updates, 0);
  }
});
test('both refresh implementations discard late responses and conditionally save without instance.update', async () => {
  process.env.GOOGLE_CLIENT_ID = 'FICTITIOUS_CLIENT'; process.env.GOOGLE_CLIENT_SECRET = 'FICTITIOUS_SECRET';
  for (const ensure of [runtime.ensureGoogleConnectionAccessToken, onboarding.ensureGoogleAccessToken]) {
    for (const phase of ['response', 'save', 'success']) {
      const f = fixture(); const row = f.state.rows.get(81); row.expiresAt = new Date('2000-01-01');
      row.update = () => assert.fail('Unsafe instance update');
      if (phase === 'save') f.state.beforeUpdate = () => f.mark();
      const http = { post: async (_url, _body, options) => {
        assert.equal(options.maxRedirects, 0); assert.equal(options.timeout, 8000);
        if (phase === 'response') f.mark(); return { data: { access_token: 'FICTITIOUS_NEW', expires_in: 3600 } };
      } };
      const operation = ensure(row, { credentials: f.credentials, axiosClient: http, http, allowExpired: true });
      if (phase === 'success') { assert.equal((await operation).accessToken, 'FICTITIOUS_NEW'); assert.equal(f.state.updates, 1); }
      else { await assert.rejects(operation, { code: 'google_oauth_legacy_closed' }); assert.equal(f.state.updates, 0); }
    }
  }
});
test('request wrapper captures identity and stops pagination after a concurrent marker', async () => {
  const f = fixture(); const connection = { id: 81, googleUserId: 'fictitious-subject' }; let sends = 0;
  const request = boundary.guardGoogleAdsLegacyRequest(connection, async () => { sends++; f.mark(); return { nextPageToken: 'page2' }; }, f.credentials);
  connection.googleUserId = 'forged';
  await assert.rejects(request('POST', 'fictitious'), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(request('POST', 'fictitious'), { code: 'google_oauth_legacy_closed' }); assert.equal(sends, 1);
});
test('Ads job reloads guarded credentials and cannot hydrate a managed identity', async () => {
  const f = fixture(); f.mark();
  const jobs = loadBusinessProfileJobs({ credentials: f.credentials, models: {}, legacyHttp: {}, overrides: {
    '../services/googleAdsScopedRuntime.service': runtime,
  } }).metaSyncJobs;
  await assert.rejects(jobs._getGoogleAccessToken({ id: 81, googleUserId: 'fictitious-subject' }), { code: 'google_oauth_legacy_closed' });
  assert.equal(f.state.loads + f.state.tokenReads, 0);
});
test('actual Ads metric job rejects a response after a marker before persisting its snapshot', async () => {
  const f = fixture(); let sends = 0; let saves = 0;
  const jobs = loadBusinessProfileJobs({ credentials: f.credentials, models: {}, legacyHttp: {}, overrides: {
    '../services/googleAdsLegacyConnection.service': {
      guardGoogleAdsLegacyRequest: (connection, request) => boundary.guardGoogleAdsLegacyRequest(connection, request, f.credentials),
    },
    '../lib/googleAdsClient': { ensureGoogleAdsConfig: () => ({ managerId: '456' }), normalizeCustomerId: String,
      googleAdsRequest: async () => { sends++; f.mark(); return { results: [], nextPageToken: 'page2' }; } },
    '../lib/googleAdsSearchRows': require('../../lib/googleAdsSearchRows'),
    '../services/googleAdCache.service': { daysBetween: () => ['2026-09-10'] },
    '../services/googleCampaignMetricsCache.service': {
      collectGoogleCampaignMetrics: async ({ read }) => read({ customerId: '123', accessToken: 'FICTITIOUS_TOKEN', query: 'SELECT customer.id FROM customer' }),
      persistGoogleCampaignMetrics: async () => { saves++; return { rows: 1 }; },
    },
  } }).metaSyncJobs;
  await assert.rejects(jobs._syncGoogleAdsAccount({ customerId: '123', googleConnection: { id: 81, googleUserId: 'fictitious-subject' } },
    { start: '2026-09-10', end: '2026-09-10', accessToken: 'FICTITIOUS_TOKEN' }), { code: 'google_oauth_legacy_closed' });
  assert.equal(sends, 1); assert.equal(saves, 0);
});
test('Diagnostics revalidates its token cache and discards late responses with sanitized errors', async () => {
  for (const late of [false, true]) {
    const f = fixture(); const rows = attempts(2); let sends = 0;
    const update = rows[0].update;
    rows[0].update = async function (values) { await update.call(this, values); f.mark(); };
    const result = await diagnostics.reconcileGoogleDataManagerDiagnostics({ credentials: f.credentials,
      attemptModel: { findAll: async () => rows }, ensureAccessToken: async () => ({ accessToken: 'FICTITIOUS_TOKEN' }),
      retrieveStatus: async () => { sends++; if (late) f.mark(); return { requestStatusPerDestination: [{ requestStatus: 'SUCCESS' }] }; } });
    assert.equal(sends, 1); assert.equal(result.succeeded, late ? 0 : 1); assert.equal(result.errors, late ? 2 : 1);
    assert.equal(rows[1].status, 'accepted');
    assert.equal(rows[1].responseMetadata.diagnostics_error.code, 'google_oauth_legacy_closed');
    assert.doesNotMatch(JSON.stringify(rows), /FICTITIOUS_TOKEN|accessToken|refreshToken/);
  }
});
test('Diagnostics provider failure does not persist arbitrary response bodies or secrets', async () => {
  const f = fixture(); const rows = attempts();
  await diagnostics.reconcileGoogleDataManagerDiagnostics({ credentials: legacy.forModels(f.models),
    attemptModel: { findAll: async () => rows }, ensureAccessToken: async () => ({ accessToken: 'FICTITIOUS_TOKEN' }),
    retrieveStatus: async () => { throw Object.assign(Error('FICTITIOUS_SECRET'), { response: { status: 403, data: { error: { message: 'FICTITIOUS_SECRET' } } } }); } });
  assert.equal(rows[0].responseMetadata.diagnostics_error.code, 'google_credentials_unavailable');
  assert.doesNotMatch(JSON.stringify(rows), /FICTITIOUS_SECRET/);
});

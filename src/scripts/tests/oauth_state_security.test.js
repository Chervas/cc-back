'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  consumeOAuthState,
  issueOAuthState,
} = require('../../services/oauthState.service');
const { normalizeOAuthReturnTo } = require('../../lib/oauthRedirect');
const { evaluateMetaConnectionHealth } = require('../../lib/oauthConnectionHealth');

class FakeRedis {
  constructor() {
    this.status = 'ready';
    this.values = new Map();
    this.setCalls = [];
  }

  async set(key, value, ...args) {
    this.setCalls.push({ key, value, args });
    if (this.values.has(key) && args.includes('NX')) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async getdel(key) {
    const value = this.values.get(key) || null;
    this.values.delete(key);
    return value;
  }
}

async function testOpaqueOneTimeState() {
  const store = new FakeRedis();
  const token = await issueOAuthState({
    provider: 'google',
    userId: 77,
    returnTo: 'https://crm.clinicaclick.com/marketing/informes',
    clinicId: 55,
    assignmentScope: 'clinic',
  }, { store, ttlSeconds: 300 });

  assert.match(token, /^[A-Za-z0-9_-]{40,100}$/);
  assert.equal(token.includes('77'), false, 'state must not expose the application user id');
  assert.deepEqual(store.setCalls[0].args, ['EX', 300, 'NX'], 'state must have a TTL and collision protection');

  const payload = await consumeOAuthState('google', token, { store });
  assert.equal(payload.userId, 77);
  assert.equal(payload.clinicId, 55);
  await assert.rejects(
    consumeOAuthState('google', token, { store }),
    (error) => error?.code === 'oauth_state_invalid',
    'a consumed callback state must never be reusable'
  );
}

async function testAtomicReplayAndProviderBinding() {
  const store = new FakeRedis();
  const token = await issueOAuthState({ provider: 'meta', userId: 88 }, { store });
  await assert.rejects(
    consumeOAuthState('google', token, { store }),
    (error) => error?.code === 'oauth_state_invalid',
    'a state issued for Meta must not authorize Google'
  );

  const results = await Promise.allSettled([
    consumeOAuthState('meta', token, { store }),
    consumeOAuthState('meta', token, { store }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
}

function testNoHardcodedMetaSecretOrLegacyStateParser() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../routes/oauth.routes.js'), 'utf8');
  assert.match(source, /const META_APP_SECRET = process\.env\.META_APP_SECRET \|\| '';/);
  assert.doesNotMatch(source, /function parseOAuthState/,
    'callbacks must not accept caller-controlled JSON/base64 state payloads');
  assert.match(source, /consumeOAuthState\('google', state\)/);
  assert.match(source, /consumeOAuthState\('meta', state\)/);
  assert.match(source, /normalizeFrontendReturnTo\(oauthState\.returnTo\)/,
    'the callback must revalidate the server-stored return target before redirecting');
  assert.match(source, /const PUBLIC_OAUTH_PATHS = new Set/);
  assert.match(source, /return authMiddleware\(req, res, next\)/,
    'all non-callback OAuth routes must use the standard blocked-user-aware middleware');
  assert.doesNotMatch(source, /jwt\.verify|Token JWT decodificado/,
    'oauth routes must not decode or log JWT payloads independently');
}

function testOAuthReturnTargetAllowlist() {
  const options = {
    allowedOrigins: new Set([
      'https://crm.clinicaclick.com',
      'https://app.clinicaclick.com',
      'http://localhost:4203',
    ]),
    fallback: 'https://app.clinicaclick.com',
  };
  assert.equal(
    normalizeOAuthReturnTo('https://crm.clinicaclick.com/marketing/informes?clinic_id=55', options),
    'https://crm.clinicaclick.com/marketing/informes?clinic_id=55'
  );
  for (const unsafe of [
    'https://evil.example/callback',
    'https://crm.clinicaclick.com.evil.example/callback',
    'https://user@crm.clinicaclick.com/callback',
    'javascript:alert(1)',
    '//evil.example/callback',
  ]) {
    assert.equal(normalizeOAuthReturnTo(unsafe, options), options.fallback, unsafe);
  }
}

function testResolversAndProviderMappingsStayServerAuthoritative() {
  const routeSource = fs.readFileSync(path.resolve(__dirname, '../../routes/oauth.routes.js'), 'utf8');
  const resolverSource = fs.readFileSync(
    path.resolve(__dirname, '../../services/scopeConnectionResolver.service.js'),
    'utf8'
  );
  assert.doesNotMatch(routeSource, /persistAssignments/);
  assert.doesNotMatch(resolverSource, /persistAssignments/);
  assert.doesNotMatch(resolverSource, /promoted_clinic_assignment_group/);
  assert.match(routeSource, /loadAuthorizedAnalyticsProperties\(conn\)/);
  assert.match(routeSource, /loadAuthorizedSearchConsoleSites\(conn\)/);
  assert.match(routeSource, /loadAuthorizedGoogleAdsAccounts\(conn\)/);
  assert.doesNotMatch(routeSource, /propertyDisplayName:\s*m\.propertyDisplayName/);
  assert.doesNotMatch(routeSource, /permissionLevel:\s*m\.permissionLevel/);
  assert.doesNotMatch(routeSource, /descriptiveName:\s*mapping\?\.descriptiveName/);
  assert.doesNotMatch(routeSource, /SocialAds(?:Insights|Actions)Daily\.destroy/,
    'individual Meta unlinks must not delete global ad-account caches');

  const googleDisconnect = routeSource.slice(
    routeSource.indexOf("router.delete('/google/disconnect'"),
    routeSource.indexOf("router.get('/meta/connection-status'")
  );
  const metaDisconnect = routeSource.slice(
    routeSource.indexOf("router.delete('/meta/disconnect'"),
    routeSource.indexOf('module.exports = router')
  );
  assert.doesNotMatch(googleDisconnect, /GoogleConnectionAssignment\.update/,
    'disconnecting a group must not tombstone clinic Google overrides');
  assert.doesNotMatch(metaDisconnect, /MetaConnectionAssignment\.update/,
    'disconnecting a group must not tombstone clinic Meta overrides');

  const adsMapping = routeSource.slice(
    routeSource.indexOf("router.post('/google/ads/map-accounts'"),
    routeSource.indexOf("router.get('/google/ads/mappings'")
  );
  assert.doesNotMatch(adsMapping, /if \(!replaceExisting\)/,
    'additive mapping of accounts A+B must not deactivate A while processing B');
  assert.match(adsMapping, /if \(replaceExisting\)/,
    'explicit replace mode remains the only path allowed to deactivate omitted accounts');
}

function testProviderTokenHealthFailsClosed() {
  const nowMs = Date.parse('2026-07-15T12:00:00Z');
  const validConnection = { expiresAt: new Date(nowMs + 60_000) };
  assert.equal(evaluateMetaConnectionHealth({}, { is_valid: true }, { nowMs }).reason, 'token_expiry_unknown');
  assert.equal(evaluateMetaConnectionHealth(
    { expiresAt: new Date(nowMs - 1) },
    { is_valid: true },
    { nowMs }
  ).reason, 'token_expired');
  assert.equal(evaluateMetaConnectionHealth(validConnection, { is_valid: false }, { nowMs }).reason, 'token_invalid');
  assert.equal(evaluateMetaConnectionHealth(
    validConnection,
    { is_valid: true, app_id: 'other' },
    { nowMs, expectedAppId: 'expected' }
  ).reason, 'token_app_mismatch');
  assert.equal(evaluateMetaConnectionHealth(
    validConnection,
    { is_valid: true, expires_at: Math.floor(nowMs / 1000) - 1 },
    { nowMs }
  ).reason, 'token_expired');
  assert.equal(evaluateMetaConnectionHealth(
    validConnection,
    { is_valid: true, data_access_expires_at: Math.floor(nowMs / 1000) - 1 },
    { nowMs }
  ).reason, 'data_access_expired');
  assert.equal(evaluateMetaConnectionHealth(
    validConnection,
    { is_valid: true, app_id: 'expected' },
    { nowMs, expectedAppId: 'expected' }
  ).connected, true);
}

function testScopeInventoryAclAndMultiConnectionCutoverGuards() {
  const routeSource = fs.readFileSync(path.resolve(__dirname, '../../routes/oauth.routes.js'), 'utf8');
  const webSource = fs.readFileSync(path.resolve(__dirname, '../../routes/web.routes.js'), 'utf8');
  const whatsappSource = fs.readFileSync(
    path.resolve(__dirname, '../../routes/whatsapp-embedded.routes.js'),
    'utf8'
  );
  const diagnosticSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/metasync.diagnostic.js'),
    'utf8'
  );
  const metaSyncRoutesSource = fs.readFileSync(
    path.resolve(__dirname, '../../routes/metasync.routes.js'),
    'utf8'
  );
  const metaSyncControllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/metasync.controller.js'),
    'utf8'
  );
  const migrationSource = fs.readFileSync(
    path.resolve(__dirname, '../../../migrations/20260715151500-enable-multiple-oauth-connections.js'),
    'utf8'
  );

  assert.match(routeSource, /const PROVIDER_INVENTORY_PATHS = new Set/);
  assert.match(routeSource, /const EXPLICIT_SCOPE_REQUIRED_PATHS = new Set/);
  for (const requiredPath of [
    '/google/assets',
    '/google/analytics/properties',
    '/google/local/locations',
    '/google/ads/accounts',
    '/meta/assets',
    '/google/ads/request-link',
    '/google/ads/accept-link',
  ]) {
    assert.ok(routeSource.includes(`'${requiredPath}'`), requiredPath);
  }
  assert.match(routeSource, /providerInventory\s*\|\|\s*req\.method !== 'GET'/,
    'provider inventories require the same write permission as connection mutations');

  const adsStatus = routeSource.slice(
    routeSource.indexOf("router.get('/google/ads/connection-status'"),
    routeSource.indexOf("router.get('/google/ads/accounts'")
  );
  assert.doesNotMatch(adsStatus, /customers\s*[:,]/);
  assert.doesNotMatch(adsStatus, /managerId\s*[:,]/);
  const adsAccounts = routeSource.slice(
    routeSource.indexOf("router.get('/google/ads/accounts'"),
    routeSource.indexOf("router.post('/google/ads/map-accounts'")
  );
  assert.match(adsAccounts, /filterReadableClinicMappings/);
  assert.doesNotMatch(routeSource, /triggerInitialSync/,
    'provider mapping routes must only enqueue durable orchestrated jobs');

  assert.match(routeSource, /persistGoogleConnection\(/);
  assert.match(routeSource, /persistMetaConnection\(/);
  assert.doesNotMatch(routeSource, /googleUserId\s*=\s*ui\.data\?\.id\s*\|\|\s*'unknown'/);
  assert.doesNotMatch(routeSource, /MetaConnection\.upsert\(/);
  assert.match(routeSource, /parsedNextUrl\.origin !== allowedOrigin/,
    'Meta paging.next must never become an arbitrary bearer-token request');

  assert.match(webSource, /router\.use\('\/clinica\/:clinicaId'/);
  assert.ok(
    webSource.indexOf('router.use(authMiddleware)')
      < webSource.indexOf("router.use('/clinica/:clinicaId'"),
    'the standard JWT and blocked-user middleware must run before clinic ACL'
  );
  assert.match(webSource, /hasMarketingClinicScopeAccess/);
  assert.ok(
    whatsappSource.indexOf('canManageTarget') < whatsappSource.indexOf('resolveMetaConnectionForScope({'),
    'WhatsApp must authorize every destination clinic before resolving the shared grant'
  );
  assert.match(diagnosticSource, /access:\s*'write'/);
  assert.equal(
    (diagnosticSource.match(/await authorizeDiagnosticAssetAccess\(req, asset\)/g) || []).length,
    3,
    'every diagnostic endpoint that accepts assetId must authorize that asset'
  );
  assert.doesNotMatch(diagnosticSource, /tokenPrefix|pageTokenLength|userTokenLength/);
  assert.doesNotMatch(diagnosticSource, /requestDetails:\s*\{[\s\S]{0,120}params:\s*params/);
  for (const tokenRoute of [
    "router.get('/tokens/validate', requireTechnicalAdmin",
    "router.get('/tokens/validate/:connectionId', requireTechnicalAdmin",
    "router.get('/tokens/stats', requireTechnicalAdmin",
  ]) {
    assert.ok(metaSyncRoutesSource.includes(tokenRoute), tokenRoute);
  }
  assert.ok(
    metaSyncRoutesSource.indexOf("router.use('/jobs', requireTechnicalAdmin)")
      < metaSyncRoutesSource.indexOf("router.post('/jobs/initialize'"),
    'every manual job, backfill, quota-resume and log-tail route must be admin-only'
  );
  for (const sensitiveJobRoute of [
    "router.post('/jobs/web/backfill'",
    "router.post('/jobs/analytics/backfill'",
    "router.post('/jobs/usage/google-ads/resume'",
    "router.get('/jobs/sync-logs/:id/tail'",
  ]) {
    assert.ok(metaSyncRoutesSource.includes(sensitiveJobRoute), sensitiveJobRoute);
  }
  const validationStats = metaSyncControllerSource.slice(
    metaSyncControllerSource.indexOf('exports.getTokenValidationStats'),
    metaSyncControllerSource.indexOf('// ========== FUNCIONES INTERNAS')
  );
  assert.match(validationStats, /attributes:\s*\[/);
  assert.doesNotMatch(validationStats, /['"]accessToken['"]/,
    'token validation statistics must never serialize Meta bearer tokens');

  assert.ok(
    migrationSource.indexOf("name: 'uniq_google_connections_user_provider'")
      < migrationSource.indexOf("dropMatchingUniqueIndexes(queryInterface, 'GoogleConnections', ['userId'])"),
    'the composite Google unique must exist before old uniques are removed'
  );
  assert.ok(
    migrationSource.indexOf("name: 'uniq_google_connections_user_id'")
      < migrationSource.lastIndexOf("['userId', 'googleUserId']"),
    'rollback restores the old unique before dropping the composite'
  );

  const googleDisconnect = routeSource.slice(
    routeSource.indexOf("router.delete('/google/disconnect'"),
    routeSource.indexOf("router.get('/meta/connection-status'")
  );
  const metaDisconnect = routeSource.slice(
    routeSource.indexOf("router.delete('/meta/disconnect'"),
    routeSource.indexOf('module.exports = router')
  );
  assert.match(googleDisconnect, /deactivateGoogleMappingsForScope/);
  assert.match(metaDisconnect, /deactivateMetaMappingsForScope/);
}

async function run() {
  await testOpaqueOneTimeState();
  await testAtomicReplayAndProviderBinding();
  testNoHardcodedMetaSecretOrLegacyStateParser();
  testOAuthReturnTargetAllowlist();
  testResolversAndProviderMappingsStayServerAuthoritative();
  testProviderTokenHealthFailsClosed();
  testScopeInventoryAclAndMultiConnectionCutoverGuards();
  console.log('oauth state security tests: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

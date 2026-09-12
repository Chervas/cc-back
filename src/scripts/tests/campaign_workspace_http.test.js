'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
const express = require('express');
const jwt = require('jsonwebtoken');
const { activateWorkspace } = require('../../services/campaignWorkspaceActivation.service');
const settings = require('../../services/campaignWorkspaceSettings.service');
const { campaignReference } = require('../../services/campaignWorkspaceMetaDestination.service');
const { googleCampaignReference } = require('../../services/campaignWorkspaceGoogleDestination.service');

const root = path.resolve(__dirname, '../..');
function loadModule(relative, overrides, globals = {}) {
  const filename = path.join(root, relative);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
    Date, ...globals,
  }, { filename });
  return module.exports;
}

const readRoutes = [
  ['', 'loadCampaignWorkspace'], ['/ad-creative', 'loadWorkspaceAdCreative'],
  ['/configuration', 'loadWorkspaceInventory'], ['/preparation', 'loadWorkspacePreparation'],
  ['/meta-preparation', 'metaCampaignContext'], ['/google-preparation', 'loadGooglePreparation'],
  ['/google-destinations', 'googleDestinationContext'], ['/shared-account', 'loadSharedAccountReview'],
  ['/optimization', 'loadOptimizationPreparation'], ['/optimization/history', 'loadOptimizationHistory'],
  ['/meta-signals', 'loadMetaSignalPreparation'], ['/meta-preparation/jobs/8', 'getPageReceptionJob'],
];
const writeRoutes = [
  ['PUT', '/configuration', 'saveWorkspaceAccounts'], ['PUT', '/assignment', 'assignWorkspaceCampaign'],
  ['POST', '/meta-preparation/check', 'refreshMetaCampaignDestinations'],
  ['POST', '/meta-preparation/page', 'requestPageReception'], ['PUT', '/preferences', 'saveWorkspacePreferences'],
  ['POST', '/optimization/check', 'checkOptimizationPreparation'],
  ['POST', '/optimization/pause', 'pauseWorkspaceOptimization'],
  ['POST', '/optimization/history/run-test/resolve', 'resolveOptimizationReview'],
  ['POST', '/shared-account/assignment', 'assignSharedAccountCampaigns'],
  ['POST', '/google-destinations/check', 'refreshGoogleDestinations'],
  ['POST', '/google-preparation/check', 'checkGooglePreparation'],
  ['POST', '/meta-signals/check', 'checkMetaSignalPreparation'],
];
const routes = [...readRoutes.map(([suffix, operation]) => ['GET', suffix, operation]), ...writeRoutes,
  ['PUT', '/activation', 'activateWorkspace']];

async function fixture(t) {
  const state = { scopes: [], accesses: [], calls: [], errors: new Map(), requests: 0 };
  t.after(() => t.diagnostic(`${state.requests} HTTP requests against the isolated loopback server`));
  const inventory = { accounts: [], campaigns: [], selectedClinics: [] };
  const campaign = { id: 'meta_ads:20:30', campaign_id: '30' };
  const results = {
    loadWorkspaceInventory: inventory,
    metaCampaignContext: { revision: 'cached', campaign, connection: { accessToken: 'TEST-PRIVATE-GRANT' } },
    googleDestinationContext: { revision: 'cached', campaign, account: { accessToken: 'TEST-PRIVATE-GRANT' } },
    loadNativeFormEvidence: new Map(), loadGoogleNativeEvidence: new Map(),
  };
  const operation = name => async input => {
    state.calls.push({ name, input });
    if (state.errors.has(name)) throw state.errors.get(name);
    return Object.hasOwn(results, name) ? results[name] : { success: true, operation: name };
  };
  const operations = Object.fromEntries([
    ...routes.map(row => row[2]), 'loadWorkspaceInventory', 'loadNativeFormEvidence', 'loadGoogleNativeEvidence',
  ].map(name => [name, operation(name)]));
  const models = {
    CampaignWorkspaceSetting: { findOne: async () => { state.calls.push({ name: 'settings' }); return null; } },
    sequelize: { transaction: () => assert.fail('The closed activation gate must not start a transaction') },
  };
  const resolveClinicScope = async raw => {
    state.scopes.push(raw);
    if (raw === '999') return { notFound: true };
    if (raw === 'all') return { isAll: true, isValid: true, clinicIds: [1, 2, 3], groupId: null };
    if (raw === 'group:5') return { isValid: true, clinicIds: [1, 2], groupId: 5 };
    return { isValid: true, clinicIds: raw.split(',').map(Number), groupId: null };
  };
  const hasMarketingClinicScopeAccess = async input => {
    state.accesses.push(input);
    return input.clinicIds.every(id => id === 1 || id === 2)
      && (input.userId === 701 || input.userId === 702 && input.access === 'read');
  };
  const controllerSource = fs.readFileSync(path.join(root, 'controllers/campaignWorkspace.controller.js'), 'utf8');
  // Keep the actual controller exports and route registration; replace only its data/provider boundary.
  const overrides = {
    '../../models': models,
    '../lib/clinicScope': { resolveClinicScope },
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess,
      getAccessibleMarketingClinicIds: async ({ clinicIds }) => clinicIds.filter(id => id === 1 || id === 2) },
  };
  for (const match of controllerSource.matchAll(/require\('(\.\.\/services\/[^']+)'\)/g)) {
    overrides[match[1]] = { ...operations };
  }
  overrides['../services/campaignWorkspaceSettings.service'] = { ...settings, saveWorkspaceAccounts: operations.saveWorkspaceAccounts };
  overrides['../services/campaignWorkspaceMetaDestination.service'].campaignReference = campaignReference;
  overrides['../services/campaignWorkspaceGoogleDestination.service'].googleCampaignReference = googleCampaignReference;
  overrides['../services/campaignWorkspaceActivation.service'] = { activateWorkspace: async input => {
    state.calls.push({ name: 'activateWorkspace', input });
    return activateWorkspace({ ...input, deploymentReady: false, optimizationDeploymentReady: false });
  } };
  const controller = loadModule('controllers/campaignWorkspace.controller.js', overrides);
  const secret = randomBytes(32).toString('hex');
  const auth = loadModule('routes/auth.middleware.js', {}, { process: { env: { JWT_SECRET: secret } } });
  const unrelated = () => assert.fail('Unrelated marketing endpoints must not execute');
  const unrelatedController = new Proxy({}, { get: () => unrelated });
  const routeSource = fs.readFileSync(path.join(root, 'routes/marketing.routes.js'), 'utf8');
  const routeOverrides = {
    './auth.middleware': auth, '../controllers/campaignWorkspace.controller': controller,
    '../lib/marketingWebRequestGuards': { createMarketingWebRateLimiter: () => () => unrelated,
      createPublicMarketingWebRateLimiter: () => () => unrelated },
    '../services/webWordpressInstallations.service': { WORDPRESS_V2_ARTIFACT_RATE_LIMIT: 600 },
  };
  for (const match of routeSource.matchAll(/require\('(\.\.\/controllers\/[^']+)'\)/g)) {
    if (!Object.hasOwn(routeOverrides, match[1])) routeOverrides[match[1]] = unrelatedController;
  }
  const router = loadModule('routes/marketing.routes.js', routeOverrides);
  const registered = router.stack.filter(layer => layer.route?.path.startsWith('/campaign-workspace')).map(layer =>
    `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path.replace(':jobId', '8').replace(':runId', 'run-test')}`);
  assert.deepEqual(registered.sort(), routes.map(([method, suffix]) => `${method} /campaign-workspace${suffix}`).sort());
  const app = express();
  app.use(express.json());
  app.use('/api/marketing', router);
  app.use((error, req, res, next) => { res.status(500).json({ success: false, error: 'internal_error' }); });
  const server = http.createServer(app);
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = connectionForTestServer(server);
  t.after(() => agent.destroy());
  const tokens = {
    writer: jwt.sign({ userId: 701, email: 'writer@example.invalid' }, secret, { expiresIn: 60 }),
    reader: jwt.sign({ userId: 702, email: 'reader@example.invalid' }, secret, { expiresIn: 60 }),
    stranger: jwt.sign({ userId: 703, email: 'stranger@example.invalid' }, secret, { expiresIn: 60 }),
    expired: jwt.sign({ userId: 701 }, secret, { expiresIn: -1 }),
    wrong: jwt.sign({ userId: 701 }, randomBytes(32), { expiresIn: 60 }),
  };
  async function request(method, suffix, { role = 'writer', scope = 'group:5', query = {}, body = {} } = {}) {
    state.requests++;
    const search = new URLSearchParams({ scope, account_id: '20', campaign_id: '30', provider: 'meta_ads', ad_id: '40', ...query });
    const data = method === 'GET' ? null : JSON.stringify(body);
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, method,
        path: `/api/marketing/campaign-workspace${suffix}?${search}`,
        headers: { ...(tokens[role] ? { authorization: `Bearer ${tokens[role]}` } : {}),
          ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
      }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on('error', reject); if (data !== null) req.write(data); req.end();
    });
    assert.ok(!JSON.stringify(response.body).includes('TEST-PRIVATE-GRANT'));
    return response;
  }
  const clear = () => { state.scopes.length = 0; state.calls.length = 0; state.accesses.length = 0; };
  return { state, request, clear };
}

test('every registered workspace route rejects missing, expired and foreign signatures before scope or data access', async t => {
  const f = await fixture(t);
  for (const [method, suffix] of routes) for (const role of ['anonymous', 'expired', 'wrong']) {
    f.clear(); const response = await f.request(method, suffix, { role });
    assert.equal(response.status, 401, `${method} ${suffix}: ${role}`);
    assert.equal(f.state.scopes.length, 0); assert.equal(f.state.calls.length, 0);
  }
});

test('authenticated users without complete clinic membership cannot access any workspace route', async t => {
  const f = await fixture(t);
  for (const [method, suffix] of routes) for (const input of [{ role: 'stranger' }, { scope: '3' }, { scope: '1,3' }]) {
    f.clear(); const response = await f.request(method, suffix, input);
    assert.ok([400, 403].includes(response.status), `${method} ${suffix}`);
    assert.equal(f.state.calls.length, 0);
  }
});

test('read access reaches each read endpoint with private no-store responses but never a write service', async t => {
  const f = await fixture(t);
  for (const [suffix, operation] of readRoutes) {
    f.clear(); const response = await f.request('GET', suffix, { role: 'reader' });
    assert.equal(response.status, 200, suffix); assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.ok(f.state.calls.some(call => call.name === operation), operation);
    if (['/configuration', '/meta-preparation', '/google-destinations'].includes(suffix)) assert.equal(response.body.canWrite, false);
  }
  for (const [method, suffix] of routes.filter(row => row[0] !== 'GET')) {
    f.clear(); const response = await f.request(method, suffix, { role: 'reader' });
    assert.equal(response.status, 403, suffix); assert.equal(f.state.calls.length, 0);
  }
});

test('write routes bind the session actor and resolved scope instead of client-supplied ownership', async t => {
  const f = await fixture(t);
  for (const [method, suffix, operation] of writeRoutes) {
    f.clear(); const response = await f.request(method, suffix, { body: { actorId: 999, scope: '3', clinicIds: [3] } });
    assert.equal(response.status, suffix === '/meta-preparation/page' ? 202 : 200, suffix);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    const call = f.state.calls.find(row => row.name === operation);
    assert.ok(call, operation); assert.equal(call.input.actorId, 701);
    assert.deepEqual(call.input.scope.clinicIds, [1, 2]);
    if (suffix.includes('run-test')) assert.equal(call.input.runId, 'run-test');
  }
});

test('the real activation validator and closed gate reject even a permitted writer without DB mutations', async t => {
  const f = await fixture(t);
  for (const mode of ['measurement', 'optimize']) {
    const response = await f.request('PUT', '/activation', { body: {
      expected_version: 1, preparation_revision: 'a'.repeat(64), mode, signals: { enabled: true }, confirmed: true,
    } });
    assert.equal(response.status, 409); assert.equal(response.body.error, 'workspace_activation_deployment_pending');
  }
  const invalid = await f.request('PUT', '/activation', { body: { confirmed: true, actorId: 701 } });
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error, 'invalid_workspace_activation');
  assert.ok(f.state.calls.every(call => call.name === 'activateWorkspace'));
});

test('aggregated reports use only authorized clinics and cannot become writable aggregate configurations', async t => {
  const f = await fixture(t);
  for (const suffix of ['', '/ad-creative', '/optimization/history']) {
    f.clear(); const response = await f.request('GET', suffix, { scope: 'all', role: 'reader', query: { days: '7', page: '2' } });
    assert.equal(response.status, 200); assert.deepEqual(f.state.calls[0].input.scope.clinicIds, [1, 2]);
  }
  for (const [method, suffix] of routes.filter(row => !['', '/ad-creative', '/optimization/history'].includes(row[1]))) {
    f.clear(); const response = await f.request(method, suffix, { scope: 'all' });
    assert.equal(response.status, 400, suffix); assert.equal(f.state.calls.length, 0);
  }
  for (const query of [{ days: '180' }, { scope: 'group:0' }, { scope: '1x' }]) {
    f.clear(); assert.equal((await f.request('GET', '', { query })).status, 400); assert.equal(f.state.calls.length, 0);
  }
  f.clear(); assert.equal((await f.request('GET', '', { scope: '999' })).status, 404); assert.equal(f.state.calls.length, 0);
});

test('version conflicts, revoked resources and pending checks remain actionable HTTP errors, not successful saves', async t => {
  const f = await fixture(t);
  for (const [operation, method, suffix, status, code] of [
    ['saveWorkspaceAccounts', 'PUT', '/configuration', 409, 'workspace_version_conflict'],
    ['assignWorkspaceCampaign', 'PUT', '/assignment', 409, 'workspace_assignment_already_reviewed'],
    ['loadWorkspaceAdCreative', 'GET', '/ad-creative', 404, 'workspace_campaign_not_in_scope'],
    ['checkMetaSignalPreparation', 'POST', '/meta-signals/check', 409, 'workspace_meta_reconnect_required'],
    ['checkGooglePreparation', 'POST', '/google-preparation/check', 403, 'marketing_scope_forbidden'],
  ]) {
    f.state.errors.set(operation, Object.assign(new Error('Test conflict'), { status, code }));
    const response = await f.request(method, suffix);
    assert.equal(response.status, status); assert.equal(response.body.success, false); assert.equal(response.body.error, code);
  }
});

test('the HTTP test transport does not reopen arbitrary sockets, fetch or business queues', () => {
  const socket = new (require('node:net').Socket)();
  assert.throws(() => socket.connect({ host: '127.0.0.1', port: 3004 }), /NETWORK_FORBIDDEN/);
  socket.destroy();
  assert.throws(() => fetch('https://example.invalid'), /NETWORK_FORBIDDEN/);
  assert.throws(() => require('../../services/queue.service').queues.outboundWhatsApp.add('test', {}), /NETWORK_FORBIDDEN/);
  assert.throws(() => connectionForTestServer({ listening: true, address: () => ({ address: '127.0.0.1', port: 3004 }) }), /NETWORK_FORBIDDEN/);
});

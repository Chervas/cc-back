'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name.startsWith('@aws-sdk/') || name === 'dotenv' || /(?:^|\/)models(?:\/index)?$/.test(name)) throw Error('UNEXPECTED_EXTERNAL_DEPENDENCY_IN_FIRST_HTTP_TEST');
  return originalLoad.call(this, name, ...args);
};
const express = require('express');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
const H = require('../../routes/googleOAuthAdmission.http');
function loadDiscoverySource(relative, dependencies, { logs = [] } = {}) {
  const filename = path.resolve(__dirname, '../..', relative), module = { exports: {} };
  const forbidden = () => { throw Error('UNEXPECTED_UNRELATED_OAUTH_DEPENDENCY'); };
  const blocked = new Proxy({}, { get: () => forbidden });
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, URL, URLSearchParams, Date, Set,
    setTimeout, clearTimeout, process: { env: { RUNTIME_ROLE: 'gateway', JOBS_AUTO_START: 'false' } },
    console: Object.fromEntries(['log', 'warn', 'error'].map(key => [key, (...args) => logs.push(args)])),
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : blocked,
  }, { filename, timeout: 2000 });
  return module.exports;
}
function unusedMetaSurfaceDependencies() {
  const deny = () => { throw Error('UNEXPECTED_META_SURFACE_IN_FIRST_HTTP_TEST'); };
  return { '../services/metaConnectionMetadata.service': { createMetaConnectionMetadata: () => ({ handler: () => deny }),
    createMetaMetadataRepository: () => deny, createMetaDataAccessRepository: () => deny },
  '../services/metaMarketingAccessCheck.service': { createMetaMarketingAccessCheck: () => ({ handler: () => deny }) },
  '../services/metaMarketingBrokerReader.service': { forModels: () => ({ prepare: deny, read: deny }) },
  './metaMarketingRevocation.routes': { createRouter: () => deny },
  '../services/googleLegacyOAuthGuard.service': { createGoogleLegacyOAuthGuard: () => ({ assertAllowed: deny }) } };
}
const PRIVATE = 'FICTITIOUS_PRIVATE_SQL_OR_PROVIDER_DETAIL';
const CODE = 'FICTITIOUS_SINGLE_USE_CODE', STATE = 'S'.repeat(43);
const ID = 'a6aef39a-96e4-43da-b59c-1a29d50e801e';
const scope = '?scope_key=group%3A29&google_service=analytics';
const selected = { attempt_id: ID, scope_key: 'group:29', google_service: 'analytics' };
const scSelected = { ...selected, google_service: 'search_console' };
const scStatusPath = '/google/admission/status?attempt_id=' + ID + '&scope_key=group%3A29&google_service=search_console';
const assetsPath = scStatusPath.replace('/status?', '/assets?');
const SITE = 'sc-domain:example.invalid';
const ASSET = 'sc:' + createHash('sha256').update(SITE).digest('hex');
const confirmBody = { ...scSelected, clinic_id: 66, asset_ref: ASSET };
const statusPath = '/google/admission/status?attempt_id=' + ID + '&scope_key=group%3A29&google_service=analytics';
const callbackPath = '/google/callback?state=' + STATE + '&code=' + CODE;
const error = status => Object.assign(Error(PRIVATE), { status });
const dto = (selection, begin = false) => ({ attemptId: selection.attemptId, scopeKey: selection.scopeKey, service: selection.service,
  state: 'prepared', revision: 0, expiresAt: new Date(Date.now() + 600000).toISOString(), authorizationState: 'prepared', authorizationConfirmed: false,
  connected: false, ...(begin ? { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=' + STATE } : {}) });
const returned = (extra = {}) => ({ recognized: true, action: 'resume_google_admission', returnPath: '/pages/settings', attemptId: ID,
  scopeKey: 'group:29', service: 'analytics', outcome: 'pending', authorizationState: 'candidate_ready', authorizationConfirmed: false, connected: false, ...extra });

async function fixture(t, { installed = false, origin = 'https://crm.example.invalid', runtime: provided, completion = false } = {}) {
  const state = { auth: 0, capability: 0, begin: 0, status: 0, assets: 0, publish: 0, callback: 0, oldCallback: 0, enabled: false, sessionRef: randomUUID(), cuts: [],
    logs: [], seen: [], codeReferences: [], callbackValue: returned(), ...provided?.state };
  const sessions = {
    bearer(value) { if (!['Bearer FICTITIOUS_JWT', 'Bearer CHILD_JWT', 'Bearer LEGACY_JWT'].includes(value)) throw Object.assign(Error(), { name: 'JsonWebTokenError' }); return value.slice(7); },
    async verify(token) { state.auth++; return { userId: 501, email: 'fictitious@example.invalid', jti: state.sessionRef,
      exp: Math.floor(Date.now() / 1000) + 3600, ...(token === 'LEGACY_JWT' ? {} : { sessionVersion: 1 }),
      ...(token === 'CHILD_JWT' ? { authDelegation: { delegationId: 'fictitious' } } : {}) }; },
  };
  const auth = loadDiscoverySource('routes/auth.middleware.js', { '../services/accessSession.service': sessions,
    '../services/platformAudit.delegation': { admitHttp: async (_req, _res, work) => work() },
    '../lib/delegatedOperationPolicy': { requiresOwnSession: () => false } });
  const runtime = provided?.value || {
    settingsOrigin: origin,
    async capability(req, selection) { state.capability++; state.seen.push({ kind: 'capability', selection, actorId: req.userData.userId, session: req.authSession.id });
      if (state.capabilityError) throw error(state.capabilityError); return state.capabilityValue || { enabled: state.enabled }; },
    async begin(req, selection) { state.begin++; state.seen.push({ kind: 'begin', selection, actorId: req.userData.userId, session: req.authSession.id });
      if (state.beginError) throw error(state.beginError); return state.beginValue || dto(selection, true); },
    async status(req, selection) { state.status++; state.seen.push({ kind: 'status', selection, actorId: req.userData.userId, session: req.authSession.id });
      if (state.statusError) throw error(state.statusError); return state.statusValue || dto(selection); },
    async callback(input) { state.callback++; assert.equal(state.cuts.at(-1), 'oauth_callback');
      state.seen.push({ kind: 'callback', denied: input.denied === true });
      if (input.codeBuffer) { assert.equal(input.codeBuffer.toString(), CODE); state.codeReferences.push(input.codeBuffer); }
      if (state.callbackError) throw error(state.callbackError); return state.callbackValue; },
  };
  if (!provided?.value && (completion === true || completion === 'assets_only')) runtime.assets = async (req, selection) => {
    state.assets++; state.seen.push({ kind: 'assets', selection, actorId: req.userData.userId, session: req.authSession.id });
    if (state.assetsError) throw error(state.assetsError);
    return state.assetsValue || { attemptId: selection.attemptId, scopeKey: selection.scopeKey, service: selection.service,
      assets: [{ assetRef: ASSET, siteUrl: SITE, clinicIds: selection.scopeKey.startsWith('clinic:') ? [Number(selection.scopeKey.slice(7))] : [66, 72] }] };
  };
  if (!provided?.value && (completion === true || completion === 'publish_only')) runtime.publish = async (req, selection) => {
    state.publish++; state.seen.push({ kind: 'publish', selection, actorId: req.userData.userId, session: req.authSession.id });
    if (state.publishError) throw error(state.publishError);
    return state.publishValue || { attemptId: selection.attemptId, scopeKey: selection.scopeKey, service: selection.service,
      authorizationConfirmed: true, connected: true, configurationPending: false, replayed: state.replayed === true };
  };
  const oldGoogle = { async callback(value) { state.oldCallback++; state.oldValue = value;
    return { returnTo: 'https://crm.clinicaclick.com', pending: true, activation_confirmed: false }; }, safe: () => 'old_error' };
  const router = loadDiscoverySource('routes/oauth.routes.js', { ...unusedMetaSurfaceDependencies(), express, sequelize: require('sequelize'), '../../models': {},
    './auth.middleware': auth, './googleOAuthAdmission.http': H, '../services/accessSession.service': sessions,
    '../services/googleOAuthBroker.service': oldGoogle,
    '../lib/oauthMarketingScopeAccess': require('../../lib/oauthMarketingScopeAccess'),
    '../lib/googleCutoverAdmission': { application: { async run(kind, work) { state.cuts.push(kind); return work(); } } },
    '../lib/oauthRedirect': require('../../lib/oauthRedirect'),
  }, { logs: state.logs });
  let adapter;
  if (installed) { adapter = H.createGoogleOAuthAdmissionHttpAdapter({ runtime, authenticate: auth }); router.installGoogleOAuthAdmissionHttp(adapter); }
  const app = express(); app.use('/oauth', router); app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  const server = http.createServer(app); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const agent = new http.Agent({ keepAlive: false }); agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
  const request = (pathname, { method = 'GET', body, raw, token = 'FICTITIOUS_JWT', headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = raw === undefined ? body === undefined ? undefined : JSON.stringify(body) : raw;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, method, path: '/oauth' + pathname,
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...headers } }, res => {
      let response = ''; res.on('data', value => { response += value; }); res.on('end', () => {
        let json; try { json = JSON.parse(response); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: response, json });
      });
    }); req.on('error', reject); req.end(data);
  });
  return { state, router, adapter, runtime, auth, request };
}
function protectedHeaders(response) {
  assert.match(response.headers['cache-control'], /no-store/); assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
}

test('default absent capability mounts metadata only without runtime calls, preserves old callback and authenticates once', async t => {
  const f = await fixture(t);
  const response = await f.request('/google/admission/capability' + scope);
  assert.equal(response.status, 200); protectedHeaders(response);
  assert.deepEqual(response.json, { mode: 'google_first_admission', scopeKey: 'group:29', service: 'analytics', installed: false, enabled: false, canChooseAssets: false });
  assert.equal(f.state.auth, 1); assert.equal(f.state.capability, 0);
  assert.equal((await f.request('/google/admission/begin', { method: 'POST', body: selected })).status, 503);
  assert.equal((await f.request(statusPath)).status, 503); assert.equal(f.state.begin + f.state.status, 0);
  const old = await f.request(callbackPath, { token: null }); assert.equal(old.status, 302);
  assert.equal(old.headers.location, 'https://crm.clinicaclick.com/pages/settings?google_authorization=pending');
  assert.equal(f.state.oldCallback, 1); assert.equal(f.state.callback, 0);
  assert.deepEqual(f.state.cuts, ['oauth_callback']);
});

test('new endpoints require normal managed own session; missing, legacy and delegated cannot call installed runtime', async t => {
  const f = await fixture(t, { installed: true });
  for (const [token, expected] of [[null, 401], ['LEGACY_JWT', 401], ['CHILD_JWT', 403]]) {
    const response = await f.request('/google/admission/capability' + scope, { token });
    assert.equal(response.status, expected); protectedHeaders(response);
  }
  assert.equal(f.state.capability + f.state.begin + f.state.status, 0);
});

test('capability is scope AND service specific and errors do not advertise Connect', async t => {
  const f = await fixture(t, { installed: true }); f.state.enabled = true;
  const response = await f.request('/google/admission/capability' + scope);
  assert.equal(response.json.enabled, true); assert.equal(response.json.installed, true); assert.equal(response.json.canChooseAssets, false);
  assert.deepEqual(f.state.seen[0].selection, { scopeKey: 'group:29', service: 'analytics' });
  assert.equal(f.state.seen[0].actorId, 501); assert.equal(f.state.seen[0].session, f.state.sessionRef);
  f.state.capabilityError = 403;
  const denied = await f.request('/google/admission/capability' + scope); assert.equal(denied.status, 403); assert(!denied.body.includes(PRIVATE));
  for (const query of ['?scope_key=group:29', '?google_service=analytics', scope + '&group_id=29', scope + '&google_service=ads',
    '?scope_key=group:29evil&google_service=analytics', '?scope_key=group:29&google_service=all']) {
    assert.equal((await f.request('/google/admission/capability' + query)).status, 400);
  }
});

test('begin requires enabled scoped capability and preserves the original request authority', async t => {
  const f = await fixture(t, { installed: true });
  assert.equal((await f.request('/google/admission/begin', { method: 'POST', body: selected })).status, 503); assert.equal(f.state.begin, 0);
  f.state.enabled = true;
  const response = await f.request('/google/admission/begin', { method: 'POST', body: selected });
  assert.equal(response.status, 200); protectedHeaders(response); assert.equal(response.json.canChooseAssets, false);
  assert.equal(response.json.authorizationConfirmed, false); assert.equal(response.json.connected, false);
  assert.equal(response.json.authorizationUrl.startsWith('https://accounts.google.com/'), true);
  const call = f.state.seen.find(value => value.kind === 'begin');
  assert.deepEqual(call.selection, { attemptId: ID, scopeKey: 'group:29', service: 'analytics' }); assert.equal(call.session, f.state.sessionRef);
  assert.equal(response.json.authUrl, undefined); assert.equal(f.state.status, 0);
});

test('paused new starts preserve authenticated status and callback processing for issued attempts', async t => {
  const f = await fixture(t, { installed: true });
  assert.equal((await f.request('/google/admission/begin', { method: 'POST', body: selected })).status, 503);
  const status = await f.request(statusPath); assert.equal(status.status, 200); assert.equal(status.json.canChooseAssets, false);
  assert.equal(f.state.status, 1);
  const callback = await f.request(callbackPath, { token: null }); assert.equal(callback.status, 303); assert.equal(f.state.callback, 1);
  assert.equal(f.state.oldCallback, 0);
});

test('matched return uses fixed safe hint, original scope and headers, with no state/code/identity', async t => {
  const f = await fixture(t, { installed: true });
  const response = await f.request(callbackPath + '&scope=openid%20email&authuser=0&prompt=consent&return_to=https://attacker.invalid/', { token: null });
  assert.equal(response.status, 303); protectedHeaders(response);
  const url = new URL(response.headers.location);
  assert.equal(url.origin, 'https://crm.example.invalid'); assert.equal(url.pathname, '/pages/settings');
  assert.deepEqual(Object.fromEntries(url.searchParams), { panel: 'connected-accounts', action: 'resume_google_admission',
    attempt_id: ID, google_service: 'analytics', scope_key: 'group:29' });
  assert(!response.headers.location.includes(CODE)); assert(!response.headers.location.includes(STATE)); assert(!response.headers.location.includes('google_authorization'));
  assert(f.state.codeReferences.every(value => value.every(byte => byte === 0))); assert.equal(f.state.auth, 0);
  assert.equal(f.state.oldCallback, 0);
});

test('exact unknown 43b64 state alone continues the existing managed callback chain unchanged', async t => {
  const f = await fixture(t, { installed: true }); f.state.callbackValue = { recognized: false };
  const response = await f.request(callbackPath, { token: null }); assert.equal(response.status, 302);
  assert.equal(response.headers.location, 'https://crm.clinicaclick.com/pages/settings?google_authorization=pending');
  assert.equal(f.state.oldCallback, 1); assert.equal(f.state.oldValue.state, STATE); assert.equal(f.state.oldValue.code, CODE);
  assert(f.state.codeReferences[0].every(byte => byte === 0));
});

test('failed/ambiguous or loose unknown callbacks never fall through, including installed-config failure facade', async t => {
  const f = await fixture(t, { installed: true });
  for (const value of [{ recognized: false, extra: true }, { recognized: true }, returned({ connected: true }), returned({ returnPath: '/arbitrary' })]) {
    f.state.callbackValue = value; const response = await f.request(callbackPath, { token: null });
    assert.equal(response.status, 303); assert.equal(new URL(response.headers.location).searchParams.get('google_admission_error'), '1');
  }
  f.state.callbackError = 503;
  const failed = await f.request(callbackPath, { token: null }); assert.equal(failed.status, 303); assert(!failed.headers.location.includes(PRIVATE));
  assert.equal(f.state.oldCallback, 0);
  const unavailable = { settingsOrigin: 'https://crm.example.invalid', capability: async () => { throw error(503); },
    begin: async () => { throw error(503); }, status: async () => { throw error(503); }, callback: async () => { throw error(503); } };
  const g = await fixture(t, { installed: true, runtime: { value: unavailable } });
  assert.equal((await g.request(statusPath)).status, 503); assert.equal((await g.request(callbackPath, { token: null })).status, 303); assert.equal(g.state.oldCallback, 0);
});

test('provider denial is a bound unresolved hint, never a fake cancelled/confirmed response', async t => {
  const f = await fixture(t, { installed: true }); f.state.callbackValue = returned({ outcome: 'declined_unresolved', authorizationState: null });
  const response = await f.request('/google/callback?state=' + STATE + '&error=access_denied&error_description=' + PRIVATE, { token: null });
  const url = new URL(response.headers.location); assert.equal(response.status, 303);
  assert.equal(url.searchParams.get('google_admission_outcome'), 'declined_unresolved'); assert.equal(url.searchParams.has('google_authorization'), false);
  assert.equal(f.state.seen.at(-1).denied, true); assert.equal(f.state.codeReferences.length, 0); assert.equal(f.state.oldCallback, 0);
  assert(!response.headers.location.includes(PRIVATE));
});

test('HTTP validates exact metadata schemas, bounded JSON and errors without private details', async t => {
  const f = await fixture(t, { installed: true }); f.state.enabled = true;
  for (const body of [{ ...selected, actorId: 999 }, { ...selected, refreshToken: PRIVATE }, { ...selected, attempt_id: 'bad' },
    { ...selected, scope_key: 'group:29evil' }, { ...selected, google_service: 'all' }]) {
    assert.equal((await f.request('/google/admission/begin', { method: 'POST', body })).status, 400);
  }
  for (const raw of ['{"scope_key":' + PRIVATE, JSON.stringify({ padding: 'A'.repeat(5000) })]) {
    const response = await f.request('/google/admission/begin', { method: 'POST', raw }); assert.equal(response.status, 400); assert(!response.body.includes(PRIVATE));
  }
  assert.equal(f.state.begin, 0);
  for (const value of [dto({ attemptId: ID, scopeKey: 'group:29', service: 'ads' }),
    { ...dto({ attemptId: ID, scopeKey: 'group:29', service: 'analytics' }), refreshToken: PRIVATE },
    { ...dto({ attemptId: ID, scopeKey: 'group:29', service: 'analytics' }), canChooseAssets: true }]) {
    f.state.statusValue = value; const response = await f.request(statusPath); assert.equal(response.status, 503); assert(!response.body.includes(PRIVATE));
  }
  f.state.statusValue = null; f.state.statusError = 403;
  const forbidden = await f.request(statusPath); assert.equal(forbidden.status, 403); assert(!forbidden.body.includes(PRIVATE));
});

test('malformed callback state/code is terminal only after install; absent capability leaves old parser untouched', async t => {
  const f = await fixture(t, { installed: true });
  for (const query of ['state=bad&code=' + CODE, 'state=' + STATE + '&code=a&code=b', 'state=' + STATE,
    'state=' + STATE + '&code=' + 'A'.repeat(4097), 'state=' + STATE + '&error=denied&code=' + CODE]) {
    const response = await f.request('/google/callback?' + query, { token: null }); assert.equal(response.status, 303);
    assert.equal(new URL(response.headers.location).searchParams.get('google_admission_error'), '1');
  }
  assert.equal(f.state.callback, 0); assert.equal(f.state.oldCallback, 0);
  const g = await fixture(t); assert.equal((await g.request('/google/callback?state=oldformat&code=x', { token: null })).status, 302);
  assert.equal(g.state.oldCallback, 1);
});

test('startup origin is pinned to HTTPS or the one exact localhost DEV origin; request origin cannot override', async t => {
  const f = await fixture(t, { installed: true, origin: 'http://localhost:4203' });
  const response = await f.request(callbackPath + '&returnOrigin=https://attacker.invalid', { token: null });
  assert.equal(new URL(response.headers.location).origin, 'http://localhost:4203');
  for (const origin of ['http://127.0.0.1:4203', 'http://localhost:4200', 'http://localhost:4203/', 'http://crm.example.invalid',
    'https://crm.example.invalid/path', 'https://user:pass@crm.example.invalid', 'https://crm.example.invalid?code=' + CODE]) {
    assert.throws(() => H.createGoogleOAuthAdmissionHttpAdapter({ authenticate: f.auth, runtime: f.runtime, returnOrigin: origin }), { status: 503 });
  }
  assert.throws(() => f.router.installGoogleOAuthAdmissionHttp(f.adapter), { status: 503 });
  assert(!JSON.stringify(f.state.logs).includes(CODE)); assert(!JSON.stringify(f.state.logs).includes(PRIVATE));
});

test('optional completion routes fail closed before paired runtime installation', async t => {
  for (const options of [{}, { installed: true }, { installed: true, completion: 'assets_only' }, { installed: true, completion: 'publish_only' }]) {
    const f = await fixture(t, options);
    assert.equal((await f.request(assetsPath)).status, 503);
    assert.equal((await f.request('/google/admission/confirm', { method: 'POST', body: confirmBody })).status, 503);
    assert.equal(f.state.assets + f.state.publish, 0);
    assert.equal(f.state.status + f.state.capability, 0);
  }
});

test('SC status accepts positive server readiness only for prepared candidate_staged with paired methods, independently of starts', async t => {
  const f = await fixture(t, { installed: true, completion: true });
  f.state.statusValue = { ...dto({ attemptId: ID, scopeKey: 'group:29', service: 'search_console' }),
    authorizationState: 'candidate_staged', canChooseAssets: true };
  f.state.capabilityError = 503; // New starts are paused; status does not query their capability.
  const ready = await f.request(scStatusPath); assert.equal(ready.status, 200); assert.equal(ready.json.canChooseAssets, true);
  assert.equal(ready.json.authorizationConfirmed, false); assert.equal(ready.json.connected, false); assert.equal(f.state.capability, 0);
  for (const change of [{ authorizationState: 'candidate_ready' }, { state: 'cancelled', revision: 1 }, { state: 'expired', revision: 1 }]) {
    const previous = f.state.statusValue; f.state.statusValue = { ...previous, ...change };
    assert.equal((await f.request(scStatusPath)).status, 503); f.state.statusValue = previous;
  }
  const g = await fixture(t, { installed: true }); g.state.statusValue = f.state.statusValue;
  assert.equal((await g.request(scStatusPath)).status, 503);
  f.state.statusValue = { ...f.state.statusValue, canChooseAssets: false };
  assert.equal((await f.request(scStatusPath)).json.canChooseAssets, false);
});

test('SC assets and confirm preserve original authority without extra status/start-capability calls, and pass exact repeat receipts', async t => {
  const f = await fixture(t, { installed: true, completion: true }); f.state.capabilityError = f.state.statusError = 503;
  const assets = await f.request(assetsPath); assert.equal(assets.status, 200); protectedHeaders(assets);
  assert.deepEqual(assets.json, { attemptId: ID, scopeKey: 'group:29', service: 'search_console',
    assets: [{ assetRef: ASSET, siteUrl: SITE, clinicIds: [66, 72] }] });
  const response = await f.request('/google/admission/confirm', { method: 'POST', body: confirmBody });
  assert.equal(response.status, 200); protectedHeaders(response);
  assert.deepEqual(response.json, { attemptId: ID, scopeKey: 'group:29', service: 'search_console',
    authorizationConfirmed: true, connected: true, configurationPending: false, replayed: false });
  f.state.replayed = true;
  assert.equal((await f.request('/google/admission/confirm', { method: 'POST', body: confirmBody })).json.replayed, true);
  const call = f.state.seen.find(value => value.kind === 'publish');
  assert.deepEqual(call.selection, { attemptId: ID, scopeKey: 'group:29', service: 'search_console', clinicId: 66, assetRef: ASSET });
  assert.equal(call.actorId, 501); assert.equal(call.session, f.state.sessionRef);
  assert.equal(f.state.status + f.state.capability, 0); assert.equal(f.state.assets, 1); assert.equal(f.state.publish, 2);
});

test('an empty SC catalogue is valid and cannot manufacture a completed connection', async t => {
  const f = await fixture(t, { installed: true, completion: true });
  f.state.assetsValue = { attemptId: ID, scopeKey: 'group:29', service: 'search_console', assets: [] };
  const empty = await f.request(assetsPath); assert.equal(empty.status, 200); assert.deepEqual(empty.json.assets, []);
  assert.equal(Object.hasOwn(empty.json, 'connected'), false); assert.equal(f.state.publish, 0);
});

test('completion remains Search Console only with exact request schemas and strict numeric clinic', async t => {
  const f = await fixture(t, { installed: true, completion: true });
  assert.equal((await f.request(assetsPath.replace('search_console', 'analytics'))).status, 400);
  assert.equal((await f.request(assetsPath + '&asset_ref=' + ASSET)).status, 400);
  for (const body of [{ ...confirmBody, google_service: 'ads' }, { ...confirmBody, clinic_id: '66' }, { ...confirmBody, clinic_id: 0 },
    { ...confirmBody, asset_ref: 'gbp:1:2' }, { ...confirmBody, accessToken: PRIVATE }, { ...confirmBody, scope_key: 'clinic:72' }]) {
    const response = await f.request('/google/admission/confirm', { method: 'POST', body });
    assert.equal(response.status, 400); assert(!response.body.includes(PRIVATE));
  }
  assert.equal(f.state.assets + f.state.publish, 0);
  for (const token of [null, 'LEGACY_JWT', 'CHILD_JWT']) {
    assert.equal((await f.request(assetsPath, { token })).status, token === 'CHILD_JWT' ? 403 : 401);
    assert.equal((await f.request('/google/admission/confirm', { method: 'POST', body: confirmBody, token })).status, token === 'CHILD_JWT' ? 403 : 401);
  }
});

test('SC catalogue validates canonical site/hash, IDs, duplicates, scope and closed metadata', async t => {
  const f = await fixture(t, { installed: true, completion: true });
  const base = { attemptId: ID, scopeKey: 'group:29', service: 'search_console', assets: [{ assetRef: ASSET, siteUrl: SITE, clinicIds: [66] }] };
  const badRows = [{ ...base.assets[0], assetRef: 'sc:' + '0'.repeat(64) }, { ...base.assets[0], siteUrl: 'javascript:alert(1)' },
    { ...base.assets[0], clinicIds: ['66'] }, { ...base.assets[0], clinicIds: [66, 66] }, { ...base.assets[0], clinicIds: [-1] },
    { ...base.assets[0], refreshToken: PRIVATE }];
  for (const row of badRows) {
    f.state.assetsValue = { ...base, assets: [row] }; const response = await f.request(assetsPath); assert.equal(response.status, 503); assert(!response.body.includes(PRIVATE));
  }
  for (const value of [{ ...base, service: 'analytics' }, { ...base, scopeKey: 'group:30' }, { ...base, token: PRIVATE },
    { ...base, assets: [base.assets[0], base.assets[0]] }]) {
    f.state.assetsValue = value; assert.equal((await f.request(assetsPath)).status, 503);
  }
  f.state.assetsValue = { ...base, scopeKey: 'clinic:72' };
  assert.equal((await f.request(assetsPath.replace('group%3A29', 'clinic%3A72'))).status, 503);
});

test('SC completion preserves sanitized runtime 409/503 and rejects permissive or malformed confirmation receipts', async t => {
  const f = await fixture(t, { installed: true, completion: true });
  for (const status of [409, 503]) {
    f.state.assetsError = f.state.publishError = status;
    const assets = await f.request(assetsPath), confirmed = await f.request('/google/admission/confirm', { method: 'POST', body: confirmBody });
    assert.equal(assets.status, status); assert.equal(confirmed.status, status);
    assert(!assets.body.includes(PRIVATE)); assert(!confirmed.body.includes(PRIVATE));
  }
  f.state.assetsError = f.state.publishError = null;
  const receipt = { attemptId: ID, scopeKey: 'group:29', service: 'search_console', authorizationConfirmed: true, connected: true, configurationPending: false, replayed: false };
  for (const change of [{ scopeKey: 'group:30' }, { service: 'ads' }, { configurationPending: true }, { connected: false },
    { authorizationConfirmed: false }, { replayed: 'true' }, { secretArn: PRIVATE }]) {
    f.state.publishValue = { ...receipt, ...change }; const response = await f.request('/google/admission/confirm', { method: 'POST', body: confirmBody });
    assert.equal(response.status, 503); assert(!response.body.includes(PRIVATE));
  }
});

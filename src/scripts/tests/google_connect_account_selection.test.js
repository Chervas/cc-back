'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = process.env.GOOGLE_CONNECT_SOURCE_ROOT || path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'src/routes/oauth.routes.js'), 'utf8');
const start = source.indexOf("router.get('/google/connect',");
const end = source.indexOf("router.get('/google/callback',", start);
assert(start > 0 && end > start);
const scopes = 'openid email profile https://www.googleapis.com/auth/business.manage';
function fixture() {
  let handler;
  const state = { authenticated: true, managed: false, states: [], begins: 0 };
  const context = { URL, URLSearchParams, console, router: { get: (route, fn) => { assert.equal(route, '/google/connect'); handler = fn; } },
    getUserIdFromToken: () => state.authenticated ? 91002 : null,
    GOOGLE_CLIENT_ID: 'FICTITIOUS_CLIENT.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'FICTITIOUS_SECRET',
    GOOGLE_REDIRECT_URI: 'https://autenticacion.clinicaclick.com/oauth/google/callback', GOOGLE_SCOPES: scopes,
    normalizeFrontendReturnTo: () => 'https://crm.clinicaclick.com',
    getScopeInputFromRequest: req => ({ clinicIdRaw: req.query.clinic_id, groupIdRaw: undefined, assignmentScopeRaw: undefined }),
    issueOAuthState: async payload => { state.states.push(payload); return 'FICTITIOUS_STATE_' + state.states.length; },
    resolveGoogleRequestConnection: async () => ({ connection: { id: 81 }, scope: { scopeKey: 'clinic:92' } }),
    googleOAuthBroker: { bindingFor: async () => state.managed ? { google_connection_id: 81 } : null,
      assertLegacyAllowed: async () => {}, safe: () => 'FICTITIOUS_ERROR', begin: async () => {
        state.begins++; return { success: true, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?login_hint=FICTITIOUS_BOUND_SUBJECT' };
      } },
  };
  vm.runInNewContext(source.slice(start, end), context);
  const request = async () => {
    let status = 200, body;
    const res = { set() { return this; }, status(value) { status = value; return this; }, json(value) { body = value; return this; } };
    await handler({ query: { clinic_id: '92', return_to: 'https://crm.clinicaclick.com' }, authSession: {} }, res);
    return { status, body };
  };
  return { state, request };
}
test('each legacy connect requests account choice and consent, keeps scopes/redirect/state and supplies no prior account hint', async () => {
  const f = fixture();
  for (let i = 1; i <= 2; i++) {
    const result = await f.request(); assert.equal(result.status, 200);
    const url = new URL(result.body.authUrl);
    assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.pathname, '/o/oauth2/v2/auth');
    assert.deepEqual(url.searchParams.get('prompt').split(' '), ['select_account', 'consent']);
    assert.equal(url.searchParams.get('scope'), scopes); assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://autenticacion.clinicaclick.com/oauth/google/callback');
    assert.equal(url.searchParams.get('state'), 'FICTITIOUS_STATE_' + i);
    assert.equal(url.searchParams.has('login_hint'), false); assert.equal(url.searchParams.has('authuser'), false);
    assert.equal(url.searchParams.has('client_secret'), false); assert.equal(f.state.states[i - 1].clinicId, '92');
    assert.equal(f.state.states[i - 1].userId, 91002);
  }
});
test('anonymous connect cannot issue state or an authorization URL', async () => {
  const f = fixture(); f.state.authenticated = false;
  assert.equal((await f.request()).status, 401); assert.equal(f.state.states.length, 0);
});
test('managed reauthorization retains its bound identity and original broker URL', { skip: !source.slice(start, end).includes('googleOAuthBroker.begin') }, async () => {
  const f = fixture(); f.state.managed = true;
  const result = await f.request(); assert.equal(result.status, 200);
  assert.equal(result.body.authUrl, 'https://accounts.google.com/o/oauth2/v2/auth?login_hint=FICTITIOUS_BOUND_SUBJECT');
  assert.equal(f.state.states.length, 0); assert.equal(f.state.begins, 1);
});

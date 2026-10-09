'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
const sourceRoot = path.resolve(process.env.GATEWAY_BOUNDARY_SOURCE_ROOT || path.resolve(__dirname, '../../..'));
const { externalRouteAllowed, gatewayHttpBoundary, gatewaySocketBoundary } = require(path.join(sourceRoot, 'src/lib/gatewayHttpBoundary'));

const external = [
  ['GET', '/api/whatsapp/webhook'], ['POST', '/api/whatsapp/webhook/'],
  ['GET', '/api/whatsapp/onboarding/window'],
  ...['begin', 'finish', 'status', 'cancel', 'authorizations', 'complete']
    .map(operation => ['POST', '/api/whatsapp/onboarding/' + operation]),
  ...['/oauth', '/api/oauth'].flatMap(prefix => ['meta', 'meta/marketing', 'google'].map(provider => ['GET', `${prefix}/${provider}/callback`])),
  ...['/api/leads/webhook', '/api/intake/leads/webhook'].flatMap(route => ['GET', 'POST'].map(method => [method, route])),
  ['GET', '/api/intake/config'],
  ...['leads', 'landing-leads', 'events', 'whatsapp-origin'].map(operation => ['POST', '/api/intake/' + operation]),
  ['POST', '/_clinicaclick/intake'], ['POST', '/_clinicaclick/events'],
  ['GET', '/api/email/events/provider/health'], ['POST', '/api/email/events/provider'], ['POST', '/api/email/unsubscribe'],
  ['GET', '/r/FICTITIOUS_TRACKING_TOKEN'],
  ['GET', '/api/marketing/web-installations/501/desired-state'],
  ['POST', '/api/marketing/web-installations/501/reports'],
  ...['manifest', 'envelope', 'files/aW5kZXguaHRtbA'].map(operation => ['GET', '/api/marketing/web-installations/501/artifacts/fictitious-hash/' + operation]),
  ['GET', '/api/consentimientos/public/FICTITIOUS_TOKEN'], ['POST', '/api/consentimientos/public/FICTITIOUS_TOKEN/sign'],
  ['POST', '/api/consentimientos/tablet/login'], ['GET', '/api/consentimientos/tablet/session'], ['GET', '/api/consentimientos/tablet/packages'],
  ['POST', '/api/consentimientos/tablet/packages/501/session'], ['POST', '/api/consentimientos/tablet/budget-signatures/501/session'],
  ['GET', '/api/economics/public/budget-signatures/FICTITIOUS_TOKEN'], ['POST', '/api/economics/public/budget-signatures/FICTITIOUS_TOKEN/sign'],
];

const management = [
  '/api/citas', '/api/citas/501', '/api/citas/501/care/finish', '/API/CITAS/501',
  '/api/pacientes', '/api/personal/221/calendar', '/api/marketing/reactivation/lists/501/prepare',
  '/api/economics/vouchers/501/program-appointments', '/api/economics/vouchers/501/appointments',
  '/api/tratamientos', '/api/accounting', '/api/intake/leads/501', '/api/intake/config/admin',
  '/api/intake/leads/import/execute', '/api/automations', '/api/automation-catalog',
  '/api/whatsapp/messages', '/api/whatsapp/phones', '/api/whatsapp/phones/501/register',
  '/api/whatsapp/templates', '/api/whatsapp/templates/create-from-catalog', '/api/whatsapp/onboarding/unknown',
  '/api/whatsapp/onboarding/status/', '/api/consentimientos/packages/501/send-mock',
  '/api/consentimientos/appointments/501/package', '/api/marketing/web-installations/501/revoke',
  '/api/marketing/web-projects', '/api/marketing/web-publications', '/api/email/admin/overview',
  '/api/email/admin/test-message', '/oauth/meta/connect', '/api/oauth/google/map-assets',
  '/oauth/google/local/locations', '/api/auth/sign-in', '/api/users', '/api/job-requests',
  '/api/conversations', '/socket.io/', '/api', '/oauth',
];

async function fixture(t, role = 'gateway', withSockets = false) {
  const observed = { downstream: 0, parser: 0, bytes: null, url: null, socketAuth: 0 };
  const app = express();
  app.use(gatewayHttpBoundary({ RUNTIME_ROLE: role }));
  app.use(cors({ origin: 'https://crm.clinicaclick.com', credentials: true }));
  // Stand-in for durable ingress, before any parser. No real AWS/Meta client.
  app.post('/api/whatsapp/webhook', async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed.bytes = Buffer.concat(chunks);
    observed.url = req.originalUrl;
    observed.downstream++;
    res.json({ received: true });
  });
  app.use(express.json({ limit: '8kb', verify: () => { observed.parser++; } }));
  app.use((req, res) => { observed.downstream++; res.json({ downstream: true }); });
  const server = http.createServer(app);
  const io = withSockets ? new Server(server, { transports: ['polling'], allowUpgrades: false }) : null;
  if (io) {
    io.use(gatewaySocketBoundary({ RUNTIME_ROLE: role }));
    io.use((_socket, next) => { observed.socketAuth++; next(); });
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => {
    agent.destroy();
    if (io) io.close(resolve); else server.close(resolve);
    server.closeAllConnections();
  }));
  const request = (method, route, body = '', headers = {}) => new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, method, path: route,
      headers: { 'content-length': data.length, ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(data);
  });
  return { observed, request };
}

test('External contract inventory keeps methods, aliases and automatic HEAD only for reads', () => {
  for (const [method, route] of external) {
    assert.equal(externalRouteAllowed(method, route), true, `${method} ${route}`);
    if (method === 'GET') assert.equal(externalRouteAllowed('HEAD', route), true);
    for (const wrongMethod of ['PATCH', 'PUT', 'DELETE']) assert.equal(externalRouteAllowed(wrongMethod, route), false);
  }
  assert.equal(externalRouteAllowed('GET', '/api/intake/leads'), false);
  assert.equal(externalRouteAllowed('POST', '/api/whatsapp/onboarding/window'), false);
});

test('Every public provider callback declared in the current OAuth router is preserved, without opening its diagnostic route', () => {
  const source = fs.readFileSync(path.join(sourceRoot, 'src/routes/oauth.routes.js'), 'utf8');
  const declaration = source.match(/const PUBLIC_OAUTH_PATHS = new Set\(\[([\s\S]*?)\]\)/);
  assert(declaration, 'OAuth public path inventory must remain explicit');
  const callbacks = [...declaration[1].matchAll(/'([^']+\/callback)'/g)].map(match => match[1]);
  assert(callbacks.length >= 3);
  for (const callback of callbacks) for (const prefix of ['/oauth', '/api/oauth']) {
    assert.equal(externalRouteAllowed('GET', prefix + callback), true, prefix + callback);
    assert.equal(externalRouteAllowed('POST', prefix + callback), false);
  }
  assert.equal(externalRouteAllowed('GET', '/oauth/test'), false);
});

test('All management methods are closed before CORS, parser or handlers, including authenticated callers', async t => {
  const f = await fixture(t);
  for (const route of management) for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']) {
    const result = await f.request(method, route, method === 'POST' ? '{broken' : '', {
      'content-type': 'application/json', authorization: 'Bearer FICTITIOUS_TOKEN',
      origin: 'https://crm.clinicaclick.com', host: 'app.clinicaclick.com',
    });
    assert.equal(result.status, 404, `${method} ${route}`);
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  assert.equal(f.observed.downstream, 0); assert.equal(f.observed.parser, 0);
});

test('All external entry shapes reach downstream guards without introducing authorization', async t => {
  const f = await fixture(t);
  for (const [method, route] of external) assert.equal((await f.request(method, route)).status, 200, route);
  assert.equal(f.observed.downstream, external.length);
});

test('Preflight admits only an existing external method, not arbitrary management routes', async t => {
  const f = await fixture(t);
  for (const [method, route] of external) assert.equal((await f.request('OPTIONS', route, '', {
    origin: 'https://crm.clinicaclick.com', 'access-control-request-method': method,
  })).status, 204);
  for (const route of management) assert.equal((await f.request('OPTIONS', route, '', {
    origin: 'https://crm.clinicaclick.com', 'access-control-request-method': 'POST',
  })).status, 404);
  assert.equal((await f.request('OPTIONS', '/api/intake/leads', '', { 'access-control-request-method': 'DELETE' })).status, 404);
  assert.equal((await f.request('OPTIONS', '/api/intake/leads')).status, 404);
});

test('Signed webhook bytes, query and signature remain unchanged outside the general parser', async t => {
  const f = await fixture(t);
  const bytes = ' { "entry": [ ], "whitespace": "  " }\n';
  const route = '/api/whatsapp/webhook/?fictitious=1';
  const result = await f.request('POST', route, bytes, {
    'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '1'.repeat(64),
  });
  assert.equal(result.status, 200); assert.equal(f.observed.bytes.toString(), bytes);
  assert.equal(f.observed.url, route); assert.equal(f.observed.parser, 0);
});

test('Encoded aliases, slash and traversal variants cannot reach old management or public-prefix siblings', async t => {
  const f = await fixture(t);
  for (const route of ['/api/%63itas/501', '/%61pi/citas/501', '//api/citas/501', '/api%2fcitas/501',
    '/api/whatsapp/webhook/../messages', '/api/whatsapp/onboarding/status%2f', '/api/whatsapp/onboarding/status%252f',
    '/api/marketing/web-installations/501/desired-state/../revoke', '/api/marketing/web-installations/%2e%2e/desired-state',
    '/api/marketing/web-installations/501%2frevoke/desired-state', '/api/marketing/web-installations/501/reports/extra',
    '/api/whatsapp/webhook%00', '/api/whatsapp/webhook%5c', '/api/whatsapp/webhook%', '/api/intake/leads//',
    '/api/consentimientos/public/FICTITIOUS_TOKEN/../../appointments/501/package']) {
    assert.equal((await f.request('POST', route)).status, 404, route);
    assert.equal((await f.request('GET', route)).status, 404, route);
  }
  assert.equal(f.observed.downstream, 0);
});

test('Hosted read-only pages remain available; site write paths do not bypass the boundary', async t => {
  const f = await fixture(t);
  for (const route of ['/', '/implantes/', '/demo/assets/site.css', '/robots.txt']) {
    assert.equal((await f.request('GET', route)).status, 200);
    assert.equal((await f.request('HEAD', route)).status, 200);
    assert.equal((await f.request('POST', route)).status, 404);
  }
});

test('API and isolated DEV retain management routing unchanged', async t => {
  for (const role of ['api', 'dev', '']) {
    const f = await fixture(t, role);
    for (const route of management) assert.equal((await f.request('PATCH', route)).status, 200, `${role}: ${route}`);
  }
});

test('Gateway sockets stop before authentication/rooms while API keeps its existing session guard', () => {
  let result;
  gatewaySocketBoundary({ RUNTIME_ROLE: 'gateway' })({}, error => { result = error; });
  assert.equal(result.message, 'gateway_management_unavailable');
  assert.deepEqual(result.data, { code: 'gateway_management_unavailable' });
  gatewaySocketBoundary({ RUNTIME_ROLE: 'api' })({}, error => { result = error; });
  assert.equal(result, undefined);
});

test('Actual Socket.IO namespace refuses gateway clients after transport handshake; API connects unchanged', async t => {
  for (const role of ['gateway', 'api']) {
    const f = await fixture(t, role, true);
    const handshake = await f.request('GET', '/socket.io/?EIO=4&transport=polling');
    assert.equal(handshake.status, 200);
    const sid = JSON.parse(handshake.text.slice(1)).sid;
    const route = '/socket.io/?EIO=4&transport=polling&sid=' + encodeURIComponent(sid);
    assert.equal((await f.request('POST', route, '40', { 'content-type': 'text/plain' })).status, 200);
    const packet = await f.request('GET', route);
    if (role === 'gateway') {
      assert.equal(packet.text.slice(0, 2), '44');
      assert.equal(JSON.parse(packet.text.slice(2)).data.code, 'gateway_management_unavailable');
      assert.equal(f.observed.socketAuth, 0);
    } else {
      assert.equal(packet.text.slice(0, 2), '40');
      assert.equal(f.observed.socketAuth, 1);
    }
    assert.equal(f.observed.downstream, 0);
  }
});

test('Production mounting precedes parsers/CORS/raw ingress and socket authentication', () => {
  const source = fs.readFileSync(path.join(sourceRoot, 'src/app.js'), 'utf8');
  const boundary = source.indexOf("app.use(require('./lib/gatewayHttpBoundary').gatewayHttpBoundary());");
  assert(boundary >= 0);
  for (const later of ['app.use(cors(corsOptionsDelegate))', "app.use(require('./lib/whatsappInboxGateway').gatewayMiddleware())", 'app.use(express.json('])
    assert(boundary < source.indexOf(later), later);
  const socket = source.indexOf("io.use(require('./lib/gatewayHttpBoundary').gatewaySocketBoundary());");
  assert(socket >= 0 && socket < source.indexOf('installSocketSessionGuard(io)'));
});

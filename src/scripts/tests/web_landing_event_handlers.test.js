'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPublicMarketingWebRateLimiter } = require('../../lib/marketingWebRequestGuards');
const {
  CANONICAL_PUBLICATION_LIMIT,
  INVALID_PREPARE_IDENTITY,
  PREPARE_GLOBAL_IP_LIMIT,
  PREPARE_LIMIT,
  landingEventBridgePrepareIdentity,
  landingEventBridgeRateLimitOptions,
} = require('../../lib/webLandingEventRateLimit');

const IDS = {
  project: '11111111-1111-4111-8111-111111111111',
  revision: '22222222-2222-4222-8222-222222222222',
  pageA: '33333333-3333-4333-8333-333333333333',
  pageB: '44444444-4444-4444-8444-444444444444',
};

function request(pageId, pathname = '/cita/') {
  return {
    body: {
      schema_version: 1,
      endpoint: 'events',
      payload: { event_name: 'ViewContent' },
      web_project_id: IDS.project,
      web_revision_id: IDS.revision,
      web_page_id: pageId,
    },
    headers: { referer: `https://cliente.example.test${pathname}?gclid=ignored` },
    ip: '203.0.113.20',
  };
}

function responseDouble() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test('la barrera previa particiona por identidad y ruta sin usar query ni confiar en UUID incompletos', () => {
  const pageA = landingEventBridgePrepareIdentity(request(IDS.pageA));
  assert.match(pageA, /^[a-f0-9-]{36}$/);
  assert.equal(pageA, landingEventBridgePrepareIdentity(request(IDS.pageA, '/cita/?ignored=1')));
  assert.notEqual(pageA, landingEventBridgePrepareIdentity(request(IDS.pageB)));
  assert.notEqual(pageA, landingEventBridgePrepareIdentity(request(IDS.pageA, '/otra-landing/')));
  assert.equal(
    landingEventBridgePrepareIdentity({ ...request(IDS.pageA), body: { web_page_id: IDS.pageA } }),
    INVALID_PREPARE_IDENTITY
  );
  assert.equal(
    landingEventBridgePrepareIdentity({ ...request(IDS.pageA), headers: { referer: 'http://cliente.example.test/cita/' } }),
    INVALID_PREPARE_IDENTITY
  );
});

test('mantiene el bucket canónico por publicación y un backstop global separado', () => {
  const options = landingEventBridgeRateLimitOptions();
  assert.equal(options.preliminary.operation, 'landing_event_bridge_prepare');
  assert.equal(options.preliminary.limit, PREPARE_LIMIT);
  assert.equal(options.preliminary.globalIpLimit, PREPARE_GLOBAL_IP_LIMIT);
  assert.equal(options.preliminary.identity, landingEventBridgePrepareIdentity);
  assert.equal(options.canonical.operation, 'landing_event_bridge');
  assert.equal(options.canonical.limit, CANONICAL_PUBLICATION_LIMIT);
  assert.equal(options.canonical.globalIpLimit, undefined);
  assert.ok(PREPARE_LIMIT > CANONICAL_PUBLICATION_LIMIT);
});

test('dos landings tras la misma IP no comparten el límite preliminar', async () => {
  const options = landingEventBridgeRateLimitOptions();
  const preliminary = createPublicMarketingWebRateLimiter({ now: () => 1000, store: false })(options.preliminary);
  let accepted = 0;
  const next = () => { accepted += 1; };
  const pageA = request(IDS.pageA);
  const pageB = request(IDS.pageB);
  for (let index = 0; index < PREPARE_LIMIT; index += 1) {
    await preliminary(pageA, responseDouble(), next);
  }
  await preliminary(pageB, responseDouble(), next);
  const limited = responseDouble();
  await preliminary(pageA, limited, next);
  assert.equal(accepted, PREPARE_LIMIT + 1);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.payload?.error?.code, 'rate_limit_exceeded');
});

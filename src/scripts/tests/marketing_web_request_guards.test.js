'use strict';

const assert = require('node:assert/strict');
const {
  MARKETING_WEB_JSON_LIMIT_BYTES,
  assertMarketingWebJsonBodySize,
  createMarketingWebRateLimiter,
  createPublicMarketingWebRateLimiter,
  invalidMarketingWebJsonResponse,
  isMarketingWebJsonPath,
} = require('../../lib/marketingWebRequestGuards');
const { assertWebScopeEnabled } = require('../../lib/marketingWebFeatureFlags');

function responseDouble() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
}

async function main() {

const rolloutEnv = {
  editor: process.env.MARKETING_WEB_EDITOR_ENABLED,
  enabled: process.env.MARKETING_WEB_ENABLED_SCOPES,
  disabled: process.env.MARKETING_WEB_DISABLED_SCOPES,
};
try {
  process.env.MARKETING_WEB_EDITOR_ENABLED = 'true';
  process.env.MARKETING_WEB_ENABLED_SCOPES = 'clinic:66,group:4';
  process.env.MARKETING_WEB_DISABLED_SCOPES = 'clinic:67';
  assert.equal(assertWebScopeEnabled({ type: 'clinic', id: 66 }), true);
  assert.throws(
    () => assertWebScopeEnabled({ type: 'clinic', id: 68 }),
    (error) => error.code === 'web_editor_disabled'
      && error.details.rollout_reason === 'scope_not_enabled'
  );
  process.env.MARKETING_WEB_ENABLED_SCOPES = 'clinic:66,broken';
  assert.throws(
    () => assertWebScopeEnabled({ type: 'clinic', id: 66 }),
    (error) => error.code === 'marketing_web_invalid_enabled_scopes'
  );
} finally {
  if (rolloutEnv.editor === undefined) delete process.env.MARKETING_WEB_EDITOR_ENABLED;
  else process.env.MARKETING_WEB_EDITOR_ENABLED = rolloutEnv.editor;
  if (rolloutEnv.enabled === undefined) delete process.env.MARKETING_WEB_ENABLED_SCOPES;
  else process.env.MARKETING_WEB_ENABLED_SCOPES = rolloutEnv.enabled;
  if (rolloutEnv.disabled === undefined) delete process.env.MARKETING_WEB_DISABLED_SCOPES;
  else process.env.MARKETING_WEB_DISABLED_SCOPES = rolloutEnv.disabled;
}

assert.equal(isMarketingWebJsonPath('/api/marketing/web-projects/abc/draft'), true);
assert.equal(isMarketingWebJsonPath('/api/marketing/web-content/abc'), true);
assert.equal(isMarketingWebJsonPath('/api/marketing/web-media/abc'), true);
assert.equal(isMarketingWebJsonPath('/api/intake/leads'), false);
assert.equal(assertMarketingWebJsonBodySize(
  { originalUrl: '/api/marketing/web-projects' },
  Buffer.alloc(MARKETING_WEB_JSON_LIMIT_BYTES)
), true);
assert.throws(
  () => assertMarketingWebJsonBodySize(
    { originalUrl: '/api/marketing/web-projects/id/draft' },
    Buffer.alloc(MARKETING_WEB_JSON_LIMIT_BYTES + 1)
  ),
  (error) => error.status === 413 && error.code === 'marketing_web_payload_too_large'
);

const malformedJson = new SyntaxError('Unexpected token }');
malformedJson.status = 400;
malformedJson.body = '{"broken":}';
assert.deepEqual(
  invalidMarketingWebJsonResponse(malformedJson, '/api/marketing/web-projects?scope_id=66'),
  {
    success: false,
    error: {
      code: 'marketing_web_invalid_json',
      message: 'El cuerpo JSON no es válido.',
    },
  }
);
assert.equal(invalidMarketingWebJsonResponse(malformedJson, '/api/pacientes'), null);
assert.equal(
  invalidMarketingWebJsonResponse(Object.assign(new Error('other'), { status: 400 }), '/api/marketing/web-projects'),
  null
);

let clock = 1000;
const rateLimit = createMarketingWebRateLimiter({ now: () => clock });
const middleware = rateLimit({ operation: 'save', limit: 2, windowMs: 1000 });
const req = { userData: { userId: 66 } };
let nextCalls = 0;
const next = () => { nextCalls += 1; };
middleware(req, responseDouble(), next);
middleware(req, responseDouble(), next);
const limited = responseDouble();
middleware(req, limited, next);
assert.equal(nextCalls, 2);
assert.equal(limited.statusCode, 429);
assert.equal(limited.payload.error.code, 'rate_limit_exceeded');
clock = 2001;
middleware(req, responseDouble(), next);
assert.equal(nextCalls, 3);

clock = 3000;
const publicLimit = createPublicMarketingWebRateLimiter({ now: () => clock, store: false });
const publicMiddleware = publicLimit({
  operation: 'landing_intake',
  limit: 1,
  windowMs: 1000,
  identity: (request) => request.webLandingRateLimitIdentity,
  globalIpLimit: 3,
});
const publicNext = { calls: 0 };
const landingA = {
  webLandingRateLimitIdentity: '11111111-1111-4111-8111-111111111111',
  ip: '203.0.113.10',
};
const landingB = {
  webLandingRateLimitIdentity: '22222222-2222-4222-8222-222222222222',
  ip: '203.0.113.10',
};
await publicMiddleware(landingA, responseDouble(), () => { publicNext.calls += 1; });
const sameLandingLimited = responseDouble();
await publicMiddleware(landingA, sameLandingLimited, () => { publicNext.calls += 1; });
await publicMiddleware(landingB, responseDouble(), () => { publicNext.calls += 1; });
const randomizedUuidBlockedGlobally = responseDouble();
await publicMiddleware(
  { ...landingB, webLandingRateLimitIdentity: '33333333-3333-4333-8333-333333333333' },
  randomizedUuidBlockedGlobally,
  () => { publicNext.calls += 1; }
);
assert.equal(publicNext.calls, 2);
assert.equal(sameLandingLimited.statusCode, 429);
assert.equal(randomizedUuidBlockedGlobally.statusCode, 429);

// Dos workers comparten el contador atómico mediante Redis. Este doble
// reproduce el contrato de INCR + PEXPIRE sin abrir una conexión real.
const distributedCounts = new Map();
const distributedStore = {
  status: 'ready',
  async eval(script, keys, key, ttl) {
    assert.equal(keys, 1);
    assert.match(script, /INCR/);
    const count = (distributedCounts.get(key) || 0) + 1;
    distributedCounts.set(key, count);
    return [count, Number(ttl)];
  },
};
const workerA = createPublicMarketingWebRateLimiter({ now: () => clock, store: distributedStore })({
  operation: 'shared', limit: 1, windowMs: 1000, identity: () => '44444444-4444-4444-8444-444444444444',
});
const workerB = createPublicMarketingWebRateLimiter({ now: () => clock, store: distributedStore })({
  operation: 'shared', limit: 1, windowMs: 1000, identity: () => '44444444-4444-4444-8444-444444444444',
});
await workerA({ ip: '203.0.113.20' }, responseDouble(), () => {});
const sharedLimited = responseDouble();
await workerB({ ip: '203.0.113.20' }, sharedLimited, () => {});
assert.equal(sharedLimited.statusCode, 429);

console.log('marketing web request guards: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

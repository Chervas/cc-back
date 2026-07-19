'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
assert.throws(
  () => publicLimit({ operation: 'unguarded', limit: 1, windowMs: 1000 }),
  /public_marketing_web_global_ip_rate_limit_required/
);
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

// El backstop global corre antes del bucket aportado por el cliente. Una IP que
// rota UUID válidos o inválidos queda limitada y, tras el corte, no puede crear
// más claves específicas en Redis. Otra IP conserva su propia cuota.
const sprayCounts = new Map();
const sprayCalls = [];
const sprayStore = {
  status: 'ready',
  async eval(script, keys, key, ttl) {
    assert.equal(keys, 1);
    assert.match(script, /INCR/);
    sprayCalls.push(key);
    const count = (sprayCounts.get(key) || 0) + 1;
    sprayCounts.set(key, count);
    return [count, Number(ttl)];
  },
};
const sprayLimit = createPublicMarketingWebRateLimiter({ now: () => clock, store: sprayStore })({
  operation: 'installation_spray',
  limit: 1,
  globalIpLimit: 4,
  windowMs: 1000,
});
const sprayIp = '203.0.113.30';
const sprayIds = [
  '51111111-1111-4111-8111-111111111111',
  'not-a-uuid',
  '52222222-2222-4222-8222-222222222222',
  '53333333-3333-4333-8333-333333333333',
];
let sprayAccepted = 0;
for (const installationId of sprayIds) {
  await sprayLimit(
    { ip: sprayIp, params: { installationId } },
    responseDouble(),
    () => { sprayAccepted += 1; }
  );
}
const blockedSprayId = '54444444-4444-4444-8444-444444444444';
const sprayBlocked = responseDouble();
await sprayLimit(
  { ip: sprayIp, params: { installationId: blockedSprayId } },
  sprayBlocked,
  () => { sprayAccepted += 1; }
);
assert.equal(sprayAccepted, sprayIds.length);
assert.equal(sprayBlocked.statusCode, 429);
const redisDigest = (rawKey) => crypto.createHash('sha256').update(rawKey).digest('hex');
const blockedSpecificDigest = redisDigest(`installation_spray:${blockedSprayId}:${sprayIp}`);
assert.equal(sprayCalls.some((key) => key.endsWith(blockedSpecificDigest)), false);
assert.equal(sprayCalls.length, (sprayIds.length * 2) + 1);

await sprayLimit(
  { ip: '203.0.113.31', params: { installationId: blockedSprayId } },
  responseDouble(),
  () => { sprayAccepted += 1; }
);
assert.equal(sprayAccepted, sprayIds.length + 1);

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
  operation: 'shared', limit: 1, globalIpLimit: 3, windowMs: 1000,
  identity: () => '44444444-4444-4444-8444-444444444444',
});
const workerB = createPublicMarketingWebRateLimiter({ now: () => clock, store: distributedStore })({
  operation: 'shared', limit: 1, globalIpLimit: 3, windowMs: 1000,
  identity: () => '44444444-4444-4444-8444-444444444444',
});
await workerA({ ip: '203.0.113.20' }, responseDouble(), () => {});
const sharedLimited = responseDouble();
await workerB({ ip: '203.0.113.20' }, sharedLimited, () => {});
assert.equal(sharedLimited.statusCode, 429);

// Si Redis cae, los dos niveles siguen aplicándose por worker. El fallback no
// deja pasar el spray ni agrega la segunda IP al bucket de la primera.
const failedStore = {
  status: 'ready',
  async eval() { throw new Error('redis unavailable'); },
};
const fallbackLimit = createPublicMarketingWebRateLimiter({ now: () => clock, store: failedStore })({
  operation: 'fallback',
  limit: 1,
  globalIpLimit: 3,
  windowMs: 1000,
});
const originalConsoleError = console.error;
let fallbackWarnings = 0;
console.error = () => { fallbackWarnings += 1; };
try {
  let fallbackAccepted = 0;
  const fallbackNext = () => { fallbackAccepted += 1; };
  const fallbackIp = '203.0.113.40';
  await fallbackLimit(
    { ip: fallbackIp, params: { installationId: '61111111-1111-4111-8111-111111111111' } },
    responseDouble(),
    fallbackNext
  );
  const fallbackIdentityBlocked = responseDouble();
  await fallbackLimit(
    { ip: fallbackIp, params: { installationId: '61111111-1111-4111-8111-111111111111' } },
    fallbackIdentityBlocked,
    fallbackNext
  );
  await fallbackLimit(
    { ip: fallbackIp, params: { installationId: '62222222-2222-4222-8222-222222222222' } },
    responseDouble(),
    fallbackNext
  );
  const fallbackGlobalBlocked = responseDouble();
  await fallbackLimit(
    { ip: fallbackIp, params: { installationId: '63333333-3333-4333-8333-333333333333' } },
    fallbackGlobalBlocked,
    fallbackNext
  );
  await fallbackLimit(
    { ip: '203.0.113.41', params: { installationId: '63333333-3333-4333-8333-333333333333' } },
    responseDouble(),
    fallbackNext
  );
  assert.equal(fallbackAccepted, 3);
  assert.equal(fallbackIdentityBlocked.statusCode, 429);
  assert.equal(fallbackGlobalBlocked.statusCode, 429);
} finally {
  console.error = originalConsoleError;
}
assert.ok(fallbackWarnings >= 1);

// El fallback local no borra buckets vivos al alcanzar su cota: una identidad
// nueva falla cerrada y una IP conocida conserva su contador.
const boundedLocalLimit = createPublicMarketingWebRateLimiter({
  now: () => clock,
  store: false,
  maxLocalBuckets: 4,
})({
  operation: 'bounded_local',
  limit: 1,
  globalIpLimit: 3,
  windowMs: 1000,
});
let boundedAccepted = 0;
await boundedLocalLimit(
  { ip: '203.0.113.50', params: { installationId: '71111111-1111-4111-8111-111111111111' } },
  responseDouble(),
  () => { boundedAccepted += 1; }
);
await boundedLocalLimit(
  { ip: '203.0.113.51', params: { installationId: '72222222-2222-4222-8222-222222222222' } },
  responseDouble(),
  () => { boundedAccepted += 1; }
);
const boundedRejected = responseDouble();
await boundedLocalLimit(
  { ip: '203.0.113.52', params: { installationId: '73333333-3333-4333-8333-333333333333' } },
  boundedRejected,
  () => { boundedAccepted += 1; }
);
assert.equal(boundedAccepted, 2);
assert.equal(boundedRejected.statusCode, 429);
const boundedKnownIdentity = responseDouble();
await boundedLocalLimit(
  { ip: '203.0.113.50', params: { installationId: '71111111-1111-4111-8111-111111111111' } },
  boundedKnownIdentity,
  () => { boundedAccepted += 1; }
);
assert.equal(boundedKnownIdentity.statusCode, 429);

console.log('marketing web request guards: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

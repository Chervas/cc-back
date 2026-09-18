'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { randomBytes, randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
const { createService } = require('../../services/awsInfrastructureCosts.service');
const { snapshot } = require('./fixtures/aws_costs.fixture');
const root = path.resolve(__dirname, '../..');
function load(relative, overrides, globals = {}) {
  const filename = path.join(root, relative); const localRequire = createRequire(filename); const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name), ...globals }, { filename });
  return module.exports;
}
async function fixture(t) {
  let reads = 0; const forbidden = () => assert.fail('No provider, queue or scheduler activation allowed');
  const service = createService({ now: () => new Date('2026-09-12T04:00:00Z'), collect: forbidden,
    repository: { read: async key => { reads++; return { snapshot: snapshot(key.slice(-7), { token: 'SECRET_SENTINEL' }) }; } } });
  const unrelated = new Proxy({}, { get: () => forbidden });
  const jobs = load('controllers/metasync.jobs.controller.js', {
    '../jobs/sync.jobs': {}, '../lib/metaClient': {}, '../lib/googleAdsClient': {},
    '../services/marketingAiVisibility.service': {}, '../services/apiUsageTelemetry.service': {},
    '../services/aiRuntimeMonitoring.service': {}, '../services/jobRequests.service': {}, '../services/jobScheduler.service': {},
    '../../models': {}, '../services/awsInfrastructureCosts.service': service,
  });
  const secret = randomBytes(32); const issuedAt = Math.floor(Date.now() / 1000);
  const sessions = require('../../services/accessSession.service'); const rows = new Map();
  const auth = load('routes/auth.middleware.js', { '../services/accessSession.service': {
    ...sessions, ...sessions.createService({ config: () => ({ mode: 'enforce', emailMfaMode: 'enforce', ttl: 43200, secret }),
      models: { sequelize: { query: async (_sql, options) => {
        const row = rows.get(options.replacements.id);
        return [[row && row.user_id === options.replacements.userId ? row : null].filter(Boolean)];
      } } } }),
  } });
  const router = load('routes/metasync.routes.js', { './auth.middleware': auth,
    '../controllers/metasync.jobs.controller': jobs, '../controllers/socialstats.controller': unrelated,
    '../controllers/metasync.controller': unrelated, '../controllers/metasync.diagnostic': unrelated,
    '../controllers/securityMonitoring.controller': unrelated });
  const server = http.createServer(express().use('/api/metasync', router));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: false }); agent.createConnection = connectionForTestServer(server);
  t.after(() => { agent.destroy(); return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  return { reads: () => reads, request: (actor, query = '') => new Promise((resolve, reject) => {
    const claims = typeof actor === 'object' && actor !== null ? actor : { userId: actor };
    const sessionId = randomUUID(); const user = { id_usuario: claims.userId, password_usuario: 'FICTITIOUS_HASH',
      email_usuario: 'fictitious@example.invalid', estado_cuenta: 'activo', es_provisional: false };
    rows.set(sessionId, { ...user, user_id: claims.userId, session_id: sessionId, state: 'active',
      credential_binding: sessions.binding(user, secret), authentication_method: 'password_email',
      issued_at: new Date(issuedAt * 1000), email_verified_at: new Date(issuedAt * 1000), email_challenge_id: randomUUID(),
      expires_at: new Date((issuedAt + 60) * 1000), absolute_expires_at: new Date((issuedAt + 60) * 1000) });
    const token = actor === null ? null : jwt.sign({ ...claims, sessionVersion: 1, type: 'cc_access', jti: sessionId,
      iss: 'clinicaclick', aud: 'clinicaclick-platform', iat: issuedAt, amr: ['pwd','email'], emailVerifiedAt: issuedAt }, secret, { expiresIn: 60 });

    http.get({ host: '127.0.0.1', port: server.address().port, agent,
      path: '/api/metasync/jobs/usage/aws-infrastructure/costs' + query,
      headers: token ? { authorization: `Bearer ${token}` } : {} }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); assert(!text.includes('SECRET_SENTINEL'));
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) });
      });
    }).on('error', reject);
  }) };
}
test('actual HTTP route rejects anonymous, clinical admins and forged admin fields before cache access', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(null)).status, 401);
  for (const actor of [701, { userId: 701, isAdmin: true, role: 'admin' }]) assert.equal((await f.request(actor, '?userId=1&scope=all')).status, 403);
  assert.equal(f.reads(), 0);
});
test('actual controller returns private closed cache to both technical admins and validates month', async t => {
  const f = await fixture(t);
  for (const actor of [1, 44]) {
    const r = await f.request(actor, '?month=2026-08'); assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'private, no-store'); assert.equal(r.body.snapshot.amount, '0.2'); assert.equal(r.body.month, '2026-08');
  }
  assert.equal((await f.request(1, '?month=2025-01')).status, 400); assert.equal(f.reads(), 2);
});

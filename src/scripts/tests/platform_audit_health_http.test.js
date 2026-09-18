'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const http = require('node:http'); const { createRequire } = require('node:module'); const express = require('express');
const jwt = require('jsonwebtoken'); const { randomBytes } = require('node:crypto');
const { createMonitor } = require('../../services/platformAudit.monitor');
const adminCredentials = require('../../lib/adminCredentialSession');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
function load(file, overrides, globals = {}) {
  const filename = path.resolve(__dirname, '../..', file); const localRequire = createRequire(filename); const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name), ...globals }, { filename }); return module.exports;
}
test('health endpoint rejects anonymous and clinical admin claims before DB and returns only private counts for technical admins', async t => {
  let reads = 0; let failure = false; const secret = randomBytes(32).toString('hex');
  const user = id => ({ id_usuario: id, password_usuario: 'FICTITIOUS_PASSWORD_HASH', email_usuario: `fictitious-${id}@example.invalid`,
    estado_cuenta: 'activo', es_provisional: false });
  const monitor = createMonitor({ repository: { health: async () => { reads++; if (failure) throw Error('SENTINEL_SECRET');
    return { pending: 5, reconcile: 0, oldestAgeSeconds: 10, unresolvedAttempts: 0, oldestUnresolvedAgeSeconds: 0, jwt: 'SENTINEL_SECRET' }; } },
  state: { read: async () => ({ last_completed_at: new Date(), actorId: 'SENTINEL_SECRET' }) }, config: () => ({ deliveryEnabled: true }) });
  const controller = load('controllers/platformAudit.controller.js', { '../services/platformAudit.monitor': monitor });
  const auth = load('routes/auth.middleware.js', { '../services/accessSession.service': {
    ...require('../../services/accessSession.service'),
    ...require('../../services/accessSession.service').createService({ models: { Usuario: { findByPk: async id => {
      assert([1, 44].includes(id)); return user(id);
    } } },
      config: () => ({ mode: 'legacy', ttl: 43200, secret }) }),
  } });
  const unrelated = new Proxy({}, { get: () => () => assert.fail('unrelated monitoring handler') });
  const router = load('routes/system-monitoring.routes.js', { './auth.middleware': auth,
    '../controllers/platformAudit.controller': controller, '../controllers/systemMonitoring.controller': unrelated });
  const app = express(); app.use('/api/system-monitoring', router); const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent(); agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
  const request = (actor, bound = true) => new Promise((resolve, reject) => {
    const token = actor ? jwt.sign({ ...actor, email: user(actor.userId).email_usuario,
      ...(bound ? adminCredentials.claims(user(actor.userId), secret) : {}) }, secret, { expiresIn: 60 }) : null;
    http.get({ host: '127.0.0.1', port: server.address().port, agent, path: '/api/system-monitoring/audit/health?userId=1&includeEvents=true',
      headers: token ? { authorization: `Bearer ${token}` } : {} }, res => {
      const chunks = []; res.on('data', value => chunks.push(value)); res.on('end', () => {
        const body = Buffer.concat(chunks).toString(); assert(!body.includes('SENTINEL'));
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
      });
    }).on('error', reject);
  });
  assert.equal((await request(null)).status, 401);
  assert.equal((await request({ userId: 1 }, false)).status, 401); assert.equal(reads, 0);
  assert.equal((await request({ userId: 701, isAdmin: true, role: 'admin' })).status, 403); assert.equal(reads, 0);
  for (const userId of [1, 44]) { const value = await request({ userId }); assert.equal(value.status, 200);
    assert.equal(value.body.health.pending, 5); assert.equal(value.headers['cache-control'], 'private, no-store'); assert(!value.body.events); }
  failure = true; assert.equal((await request({ userId: 1 })).status, 503);
});

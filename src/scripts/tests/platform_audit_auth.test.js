'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken'); const bcrypt = require('bcryptjs');
const { memoryRepository } = require('../../../services/platform-audit/test/fixture.cjs');
const { createService } = require('../../services/platformAudit.service');
const cache = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
let service; let found; let queries; let saved; let modelError;
cache('../../../models', { Usuario: { findOne: async () => { queries++; if (modelError) throw Error('SENTINEL_DB_PASSWORD'); return found; } } });
cache('../../services/passwordReset.service', {}); cache('../../services/systemNotifications.service', {});
cache('../../services/platformAudit.service', { begin: (...args) => service.begin(...args) });
const controller = require('../../controllers/auth.controllers');
const secret = process.env.JWT_SECRET;
function setup(options = {}) {
  queries = 0; saved = 0; modelError = false;
  found = { id_usuario: 123, email_usuario: 'fictitious@example.invalid', password_usuario: bcrypt.hashSync('FICTITIOUS_PASSWORD', 4),
    save: async () => { saved++; }, get: () => ({ id_usuario: 123, email_usuario: 'fictitious@example.invalid', password_usuario: 'SENTINEL_HASH' }) };
  const repo = options.repository || memoryRepository();
  service = createService({ repository: repo, config: () => ({ enabled: true, policy: 'auth-durable-v1', ...options.config }), now: () => new Date('2026-09-12T12:00:00Z') });
  return repo;
}
async function call(method, body) {
  const req = { body, socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.17', authorization: 'SENTINEL_JWT' } };
  const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await controller[method](req, res); return res;
}
test('three successful login methods emit verified actor and issued nonsecret JTI, never credentials or forwarded IP', async () => {
  for (const method of ['signIn', 'signInWithToken', 'unlockSession']) {
    const repo = setup(); const input = method === 'signInWithToken'
      ? { accessToken: jwt.sign({ userId: 123, email: found.email_usuario }, secret, { expiresIn: 60 }) }
      : { email: found.email_usuario, password: 'FICTITIOUS_PASSWORD' };
    const res = await call(method, input); assert.equal(res.statusCode, 200); assert.equal(saved, 1);
    assert.equal(res.body.user.password_usuario, undefined);
    const events = [...repo.rows.values()].map(row => row.event); assert.equal(events.length, 2);
    assert.equal(events[0].outcome, 'unknown'); assert.equal(events[1].outcome, 'success'); assert.equal(events[1].actor.id, '123');
    assert.equal(events[0].correlationId, events[1].correlationId);
    assert.equal(events[1].sessionRef, jwt.verify(res.body.token, secret).jti);
    const evidence = JSON.stringify(events);
    for (const sentinel of ['SENTINEL', 'FICTITIOUS_PASSWORD', found.email_usuario, input.accessToken, res.body.token, '198.51.100.17'].filter(Boolean)) assert(!evidence.includes(sentinel));
  }
});
test('wrong password, missing user, invalid/expired token remain anonymous denials without false successful login', async () => {
  for (const kind of ['wrong_password', 'missing_user', 'invalid_token', 'expired_token', 'missing_token']) {
    const repo = setup(); if (kind === 'missing_user') found = null;
    const tokenMethod = kind.includes('token'); const input = tokenMethod
      ? { accessToken: kind === 'expired_token' ? jwt.sign({ userId: 123 }, secret, { expiresIn: -1 }) : kind === 'missing_token' ? null : 'SENTINEL_JWT' }
      : { email: 'fictitious@example.invalid', password: 'wrong' };
    const res = await call(tokenMethod ? 'signInWithToken' : 'signIn', input);
    assert([400, 401].includes(res.statusCode)); assert.equal(saved, 0);
    const event = [...repo.rows.values()].at(-1).event; assert.equal(event.outcome, 'denied'); assert.equal(event.actor.type, 'anonymous');
    if (kind === 'expired_token') assert.equal(event.reason, 'token_expired');
  }
});
test('unavailable queue/backlog prevents login work; failed result persistence does not return a token', async () => {
  for (const phase of ['begin', 'complete', 'backlog']) {
    const repository = memoryRepository(); let writes = 0; const append = repository.append;
    repository.append = async value => { writes++; if (phase === 'begin' || phase === 'complete' && writes === 2) throw Error('SENTINEL_SECRET'); return append(value); };
    if (phase === 'backlog') repository.health = async () => ({ pending: 10000, oldestAgeSeconds: 0 });
    setup({ repository }); const res = await call('signIn', { email: found.email_usuario, password: 'FICTITIOUS_PASSWORD' });
    assert.equal(res.statusCode, 503); assert(!res.body.token); assert.equal(queries, phase === 'complete' ? 1 : 0);
    assert(!JSON.stringify(res.body).includes('SENTINEL'));
  }
});
test('disabled audit does not use queue and business errors expose only a closed category', async () => {
  setup({ config: { enabled: false }, repository: { health: () => { throw Error('must not call'); } } });
  assert.equal((await call('signIn', { email: found.email_usuario, password: 'FICTITIOUS_PASSWORD' })).statusCode, 200);
  const repo = setup(); modelError = true;
  const res = await call('signIn', { email: 'fictitious@example.invalid', password: 'FICTITIOUS_PASSWORD' });
  assert.equal(res.statusCode, 500); assert.equal([...repo.rows.values()].at(-1).event.reason, 'internal_error');
  assert(!JSON.stringify(res.body).includes('SENTINEL'));
});
test('retrying a local ambiguous commit reuses event bytes; changing its outcome is rejected', async () => {
  const repository = setup(); const attempt = await service.begin({ socket: {} }, 'auth.sign_in');
  await attempt.complete({ outcome: 'denied', reason: 'credentials_rejected' });
  await attempt.complete({ outcome: 'denied', reason: 'credentials_rejected' }); assert.equal(repository.rows.size, 2);
  await assert.rejects(attempt.complete({ outcome: 'error', reason: 'internal_error' }), /audit_event_conflict/);
});
test('actual auth router preserves HTTP contracts and issued JTI remains valid for existing protected middleware', async t => {
  const http = require('node:http'); const express = require('express');
  const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
  cache('../../controllers/personal.controller', { reclamarCuenta: () => assert.fail('unrelated onboarding') });
  const app = express(); app.use(express.json()); app.use('/api/auth', require('../../routes/auth.routes'));
  app.get('/fictitious/protected', require('../../routes/auth.middleware'), (req, res) => res.json({ userId: req.userData.userId }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent(); agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
  const request = (route, body, token) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, agent, method: data ? 'POST' : 'GET',
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(data);
  });
  const repo = setup(); const login = await request('/api/auth/sign-in', { email: found.email_usuario, password: 'FICTITIOUS_PASSWORD' });
  assert.equal(login.status, 200); assert(!login.body.user.password_usuario);
  assert.equal((await request('/fictitious/protected', null, login.body.token)).body.userId, 123);
  assert.equal((await request('/fictitious/protected')).status, 401);
  assert.equal((await request('/api/auth/unlock-session', { email: found.email_usuario, password: 'wrong' })).status, 401);
  assert.equal((await request('/api/auth/sign-in-with-token', { accessToken: login.body.token })).status, 200);
  assert.equal(repo.rows.size, 6);
});

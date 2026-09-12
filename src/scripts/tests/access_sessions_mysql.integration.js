'use strict';
const assert = require('node:assert/strict'); const { DataTypes } = require('sequelize');
const jwt = require('jsonwebtoken'); const bcrypt = require('bcryptjs');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const cache = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  cache('dotenv', { config: () => ({}) });
  const env = { JWT_SECRET: 'FICTITIOUS_SESSION_KEY_NEVER_DEPLOY', AUTH_SESSION_MODE: 'enforce', AUTH_ACCESS_TOKEN_TTL_SECONDS: '300',
    PLATFORM_AUDIT_AUTH_ENABLED: 'true', PLATFORM_AUDIT_AUTH_POLICY: 'auth-durable-v1' };
  const api = require('../../services/accessSession.service');
  const migration = require('../../../migrations/20260912220000-create-auth-sessions');
  models.Usuario = require('../../../models/usuario')(sql, DataTypes); await models.Usuario.sync();
  await require('../../../migrations/20260912210000-create-platform-audit-events').up(sql.getQueryInterface(), DataTypes);
  await migration.up(sql.getQueryInterface(), DataTypes);
  models.AuthSession = require('../../../models/authsession')(sql, DataTypes);
  models.PlatformAuditEvent = require('../../../models/platformauditevent')(sql, DataTypes);
  const repo = require('../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent);
  let at = new Date(); const now = () => at;
  const service = () => api.createService({ models, audit: repo, config: () => api.settings(env), now });
  let sessions = service();
  const user = await models.Usuario.create({ nombre: 'Fictitious', email_usuario: 'session@example.invalid', password_usuario: bcrypt.hashSync('FICTITIOUS_PASSWORD', 4) });
  const fresh = () => models.Usuario.findByPk(user.id_usuario);
  const login = async () => (await sessions.authenticated(await fresh())).body;
  const first = await login(); const firstId = jwt.decode(first.token).jti;
  assert.equal((await sessions.verify(first.token)).userId, user.id_usuario);
  assert.equal(await models.AuthSession.count(), 1); assert.equal(await models.PlatformAuditEvent.count(), 1);
  assert(!JSON.stringify(first.user).includes('password'));
  const tokenRows = JSON.stringify(await models.AuthSession.findAll({ raw: true }));
  assert(!tokenRows.includes(first.token)); assert(!tokenRows.includes(user.password_usuario)); assert(!tokenRows.includes(user.email_usuario));
  report.checks.push('real migration and issuance bind a managed JWT to durable session plus sanitized transactional event');
  at = new Date(at.getTime() + 30000);
  const renew = await Promise.all(Array.from({ length: 4 }, async () => sessions.authenticated(await fresh(), { parentToken: first.token })));
  assert(renew.every(v => jwt.decode(v.body.token).jti === firstId)); assert.equal(await models.AuthSession.count(), 1);
  await sessions.verify(first.token); await sessions.verify(renew[0].body.token);
  assert.equal(await models.PlatformAuditEvent.count(), 5);
  report.checks.push('four concurrent tab renewals keep one revocable session and preserve signed token expiry');
  const originalAppend = repo.append;
  repo.append = async () => { throw Error('FICTITIOUS_OUTBOX_FAILURE'); };
  await assert.rejects(sessions.revoke(first.token), /FICTITIOUS_OUTBOX_FAILURE/);
  await sessions.verify(first.token); assert.equal((await models.AuthSession.findByPk(firstId)).state, 'active');
  await assert.rejects(login(), /FICTITIOUS_OUTBOX_FAILURE/); assert.equal(await models.AuthSession.count(), 1);
  repo.append = originalAppend;
  assert.equal((await sessions.revoke(first.token)).revoked, true); sessions = service();
  for (const token of [first.token, ...renew.map(v => v.body.token)]) await assert.rejects(sessions.verify(token), /auth_invalid/);
  assert.equal((await sessions.revoke(first.token)).revoked, true);
  assert.equal(await models.PlatformAuditEvent.count(), 6);
  env.AUTH_SESSION_MODE = 'legacy'; await assert.rejects(sessions.verify(first.token), /auth_invalid/); env.AUTH_SESSION_MODE = 'enforce';
  report.checks.push('failed outbox rolls back issuance/revocation; confirmed logout survives restart, retry and legacy-mode downgrade');
  const second = await login(); const capturedProof = await fresh();
  await models.Usuario.update({ password_usuario: bcrypt.hashSync('FICTITIOUS_CHANGED_PASSWORD', 4) }, { where: { id_usuario: user.id_usuario } });
  await assert.rejects(sessions.verify(second.token), /auth_invalid/);
  await assert.rejects(sessions.authenticated(capturedProof), /auth_invalid/);
  report.checks.push('password mutation invalidates prior sessions without model hooks and rejects a stale password proof racing reset');
  const third = await login();
  await models.Usuario.update({ estado_cuenta: 'inactivo' }, { where: { id_usuario: user.id_usuario } });
  await assert.rejects(sessions.verify(third.token), /auth_invalid/);
  await models.Usuario.update({ estado_cuenta: 'activo' }, { where: { id_usuario: user.id_usuario } });
  const fourth = await login(); await sessions.revoke(fourth.token, true);
  await assert.rejects(sessions.verify(third.token), /auth_invalid/); await assert.rejects(sessions.verify(fourth.token), /auth_invalid/);
  report.checks.push('disabled account is denied and owner revoke-all invalidates all its managed sessions');
  const legacy = jwt.sign({ userId: user.id_usuario, email: user.email_usuario }, env.JWT_SECRET, { expiresIn: 3600 });
  await assert.rejects(sessions.verify(legacy), /auth_invalid/);
  env.AUTH_SESSION_MODE = 'legacy'; assert.equal((await sessions.revoke(legacy)).status, 'local_only');
  const noDB = api.createService({ models: () => assert.fail('legacy must not access models'), config: () => api.settings(env), now });
  await noDB.verify(legacy); env.AUTH_SESSION_MODE = 'enforce';
  const phantom = jwt.sign({ ...jwt.decode(first.token), jti: require('node:crypto').randomUUID() }, env.JWT_SECRET);
  await assert.rejects(sessions.verify(phantom), /auth_invalid/);
  for (const change of [{ aud: 'another-product' }, { userId: String(user.id_usuario) }, { sessionVersion: 2 }]) {
    await assert.rejects(sessions.verify(jwt.sign({ ...jwt.decode(first.token), ...change }, env.JWT_SECRET)), /auth_invalid/);
  }
  report.checks.push('legacy compatibility is explicit and model-free; enforcement rejects legacy, phantom IDs and incompatible claims');
  const expiring = await login(); const exp = jwt.decode(expiring.token).exp;
  at = new Date((exp + 1) * 1000); await assert.rejects(sessions.verify(expiring.token), /jwt expired/);
  const expiryResults = await Promise.all([sessions.expire(), service().expire()]);
  assert.equal(expiryResults.reduce((n, result) => n + result.expired, 0), 1);
  assert.equal((await models.AuthSession.findByPk(jwt.decode(expiring.token).jti)).state, 'expired');
  const expiry = (await models.PlatformAuditEvent.findAll({ raw: true })).map(row => JSON.parse(row.body)).find(v => v.action === 'session.expired');
  assert.equal(expiry.effectiveAt, new Date(exp * 1000).toISOString()); assert.equal(expiry.occurredAt, at.toISOString());
  report.checks.push('concurrent expiry workers record one observed event and preserve effective expiry without inventing past observations');
  // The real controller and middleware run on an owned HTTP server; no application bootstrap or providers.
  at = new Date(); cache('../../services/accessSession.service', { ...api, ...sessions, settings: () => api.settings(env) });
  const capture = require('../../services/platformAudit.service').createService({ repository: repo, config: () => ({ enabled: true, policy: 'auth-durable-v1' }), now });
  cache('../../services/platformAudit.service', capture);
  cache('../../services/systemNotifications.service', { notifyUserRegistration: async () => {} });
  cache('../../services/passwordReset.service', {});
  cache('../../services/personalPresence.service', {});
  models.UsuarioClinica = sql.define('FictitiousInvite', { id_usuario: DataTypes.INTEGER, invite_token: DataTypes.STRING,
    estado_invitacion: DataTypes.STRING, responded_at: DataTypes.DATE }, { timestamps: false }); await models.UsuarioClinica.sync();
  const http = require('node:http'); const express = require('express'); const app = express(); app.use(express.json());
  app.use('/api/auth', require('../../routes/auth.routes'));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent(); agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
  const request = (route, body, token) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, agent, method: data ? 'POST' : 'GET',
      headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString()), cache: res.headers['cache-control'] }));
    }); req.on('error', reject); req.end(data);
  });
  let io; let client;
  try {
    const loginHttp = await request('/api/auth/sign-in', { email: user.email_usuario, password: 'FICTITIOUS_CHANGED_PASSWORD' });
    assert.equal(loginHttp.status, 200, 'HTTP sign-in: ' + JSON.stringify(loginHttp.body)); const token = loginHttp.body.token;
    const me = await request('/api/auth/me', null, token); assert.equal(me.status, 200, 'HTTP me'); assert.equal(me.body.session.managed, true);
    assert.equal(me.cache, 'private, no-store'); assert(!JSON.stringify(me.body).includes('password'));
    assert.equal((await request('/api/auth/sign-out', {}, token)).body.revoked, true);
    assert.equal((await request('/api/auth/me', null, token)).status, 401);
    assert.equal((await request('/api/auth/sign-in-with-token', { accessToken: token })).status, 401);
    const signup = await request('/api/auth/sign-up', { nombre: 'New fixture', email_usuario: 'new@example.invalid', password: 'FICTITIOUS_PASSWORD' });
    assert.equal(signup.status, 201); await sessions.verify(signup.body.token);
    const invited = await models.Usuario.create({ nombre: 'Invited fixture', email_usuario: 'invite@example.invalid', es_provisional: true });
    await models.UsuarioClinica.create({ id_usuario: invited.id_usuario, invite_token: 'FICTITIOUS_INVITATION' });
    repo.append = async () => { throw Error('FICTITIOUS_OUTBOX_FAILURE'); };
    const inviteBody = { invite_token: 'FICTITIOUS_INVITATION', email_usuario: 'claimed@example.invalid', password: 'FICTITIOUS_PASSWORD' };
    assert.equal((await request('/api/auth/claim-invite', inviteBody)).status, 503);
    assert.equal((await models.Usuario.findByPk(invited.id_usuario)).es_provisional, true);
    assert.equal(await models.UsuarioClinica.count({ where: { invite_token: 'FICTITIOUS_INVITATION' } }), 1);
    repo.append = originalAppend;
    const claimed = await request('/api/auth/claim-invite', inviteBody); assert.equal(claimed.status, 200, 'HTTP claim: ' + JSON.stringify(claimed.body)); await sessions.verify(claimed.body.token);
    assert.equal((await request('/api/auth/claim-invite', inviteBody)).status, 404);
    report.checks.push('real HTTP auth, me, logout, renewal, signup and invite claim; failed invite audit keeps the account and invitation unconsumed');
    const { Server } = require('socket.io'); io = new Server(server);
    require('../../lib/socket-session-guard').installSocketSessionGuard(io, sessions, { intervalMs: 30, timeoutMs: 100 });
    io.on('connection', socket => { socket.join('fictitious-room'); socket.on('echo', (value, ack) => ack(value)); });
    client = require('/home/ubuntu/wt/front-dev/node_modules/socket.io-client').io(`http://127.0.0.1:${server.address().port}`, {
      auth: { token: claimed.body.token }, transports: ['websocket'], agent, reconnection: false, forceNew: true });
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    assert.equal(await client.timeout(1000).emitWithAck('echo', 'FICTITIOUS'), 'FICTITIOUS');
    const disconnected = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('socket revocation timeout')), 1000);
      client.once('disconnect', () => { clearTimeout(timer); resolve(); }); });
    await service().revoke(claimed.body.token); await disconnected;
    assert.equal(io.sockets.adapter.rooms.has('fictitious-room'), false);
    report.checks.push('actual Socket.IO handshake and packets verify sessions; a second service revokes and the socket leaves outbound rooms');
  } finally {
    client?.disconnect(); agent.destroy();
    if (io) await new Promise(resolve => io.close(resolve));
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
  const rows = await models.PlatformAuditEvent.findAll({ raw: true });
  const { unpack, keyFor } = require('../../../services/platform-audit/src/event');
  for (const row of rows) { unpack(row); assert(keyFor(row).startsWith(`app/platform/v${JSON.parse(row.body).version}/`)); }
  const evidence = rows.map(row => row.body).join('');
  for (const sentinel of ['FICTITIOUS_PASSWORD', 'FICTITIOUS_CHANGED_PASSWORD', 'example.invalid', env.JWT_SECRET, first.token]) assert(!evidence.includes(sentinel));
  await assert.rejects(migration.down(), /preserve_revocations/);
  report.checks.push('v1/v2 outbox integrity, no tokens/passwords/email in audit and conservative migration rollback');
}).catch(() => { process.exitCode = 1; });

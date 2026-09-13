'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs');
const path = require('node:path'); const { createRequire } = require('node:module');
const http = require('node:http'); const jwt = require('jsonwebtoken'); const bcrypt = require('bcryptjs');
require('./fixtures/security_offline_runtime.cjs');
const root = process.env.ADMIN_SESSION_CANDIDATE_ROOT;
if (!['/home/ubuntu/wt/security-admin-session-staging-20260913','/home/ubuntu/wt/security-admin-session-gateway-20260913'].includes(root)
  || fs.realpathSync(root) !== root || fs.existsSync(path.join(root, '.env'))) throw Error('private_review_candidate_required');
const fromCandidate = createRequire(path.join(root, 'package.json'));
const cache = (file, exports) => { const id = fromCandidate.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const users = new Map(); let dbUnavailable = false; let raceReset = false; let resetRequests = 0;
const secret = process.env.JWT_SECRET;
const makeUser = id => ({ id_usuario: id, nombre: 'Fictitious', email_usuario: 'user-' + id + '@example.invalid',
  password_usuario: bcrypt.hashSync('FICTITIOUS_PASSWORD', 4), estado_cuenta: 'activo', es_provisional: false,
  async save() {}, get() { return { ...this }; } });
cache('./models', { Usuario: {
  async findByPk(id) { if (dbUnavailable) throw Error('FICTITIOUS_DB_UNAVAILABLE'); return users.get(Number(id)); },
  async findOne({ where }) {
    const user = [...users.values()].find(value => where.id_usuario ? value.id_usuario === where.id_usuario : value.email_usuario === where.email_usuario);
    if (raceReset && user) { raceReset = false; user.password_usuario = bcrypt.hashSync('FICTITIOUS_CHANGED_PASSWORD', 4); }
    return user;
  },
} });
cache('./src/services/passwordReset.service', { async requestPasswordReset() { resetRequests++; } });
cache('./src/services/systemNotifications.service', {});

test('review candidate rejects old admin HTTP/refresh/socket tokens, keeps recovery and checks password changes', async () => {
  for (const id of [1,44,99]) users.set(id, makeUser(id));
  const controller = fromCandidate('./src/controllers/auth.controllers');
  const auth = fromCandidate('./src/routes/auth.middleware');
  const policy = fromCandidate('./src/lib/adminCredentialSession');
  const app = require('express')(); app.use(require('express').json());
  app.post('/sign-in', controller.signIn); app.post('/refresh', controller.signInWithToken);
  app.post('/forgot-password', controller.forgotPassword); app.post('/unlock', controller.unlockSession);
  app.get('/protected', auth, (req, res) => res.json({ userId: req.userData.userId }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const agent = new http.Agent(); agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
  const request = (pathname, body, token) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname,
      method: body ? 'POST' : 'GET', agent, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) } }, res => {
      const chunks = []; res.on('data', value => chunks.push(value)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  let io; let client;
  try {
    const beforeCut = id => jwt.sign({ userId: id, email: users.get(id).email_usuario }, secret, { expiresIn: 300 });
    for (const id of [1,44]) {
      const old = beforeCut(id);
      assert.equal((await request('/protected', null, old)).status, 401);
      assert.equal((await request('/refresh', { accessToken: old })).status, 401);
      const login = await request('/sign-in', { email: users.get(id).email_usuario, password: 'FICTITIOUS_PASSWORD' });
      assert.equal(login.status, 200); assert.equal(login.body.user.password_usuario, undefined);
      assert.equal((await request('/protected', null, login.body.token)).status, 200);
      assert.equal((await request('/refresh', { accessToken: login.body.token })).status, 200);
      const unlock = await request('/unlock', { email: users.get(id).email_usuario, password: 'FICTITIOUS_PASSWORD' });
      assert.equal(unlock.status, 200); assert.equal((await request('/protected', null, unlock.body.token)).status, 200);
      users.get(id).password_usuario = bcrypt.hashSync('FICTITIOUS_NEW_PASSWORD', 4);
      assert.equal((await request('/protected', null, login.body.token)).status, 401);
      assert.equal((await request('/refresh', { accessToken: login.body.token })).status, 401);
    }
    assert.equal((await request('/protected', null, beforeCut(99))).status, 200);
    assert.equal((await request('/forgot-password', { email: 'user-1@example.invalid' })).status, 202); assert.equal(resetRequests, 1);
    users.set(1, makeUser(1));
    const raceLogin = await request('/sign-in', { email: users.get(1).email_usuario, password: 'FICTITIOUS_PASSWORD' });
    raceReset = true; assert.equal((await request('/refresh', { accessToken: raceLogin.body.token })).status, 401);
    users.set(1, makeUser(1));
    const login = await request('/sign-in', { email: users.get(1).email_usuario, password: 'FICTITIOUS_PASSWORD' });
    dbUnavailable = true; assert.equal((await request('/protected', null, login.body.token)).status, 401); dbUnavailable = false;
    io = new (require('socket.io').Server)(server);
    fromCandidate('./src/lib/socket-session-guard').installSocketSessionGuard(io, {
      verify: value => policy.verifyToken(value, secret), bearer: policy.bearer,
    }, { intervalMs: 30, timeoutMs: 100 });
    io.on('connection', socket => { socket.join('fictional-room'); socket.on('echo', (value, ack) => ack(value)); });
    const connect = value => require('/home/ubuntu/wt/front-dev/node_modules/socket.io-client').io('http://127.0.0.1:' + server.address().port,
      { auth: { token: value }, transports: ['websocket'], agent, reconnection: false, forceNew: true });
    client = connect(beforeCut(1)); await new Promise((resolve, reject) => { client.once('connect_error', resolve); client.once('connect', () => reject(Error('old socket accepted'))); }); client.disconnect();
    client = connect(login.body.token); await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    assert.equal(await client.timeout(1000).emitWithAck('echo', 'fictional'), 'fictional');
    const disconnected = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('socket revocation timeout')), 1000);
      client.once('disconnect', () => { clearTimeout(timer); resolve(); }); });
    users.get(1).password_usuario = bcrypt.hashSync('FICTITIOUS_LATEST_PASSWORD', 4); await disconnected;
    assert.equal(io.sockets.adapter.rooms.has('fictional-room'), false);
    // Verify the app uses the tested adapter and every clinics helper call waits.
    const appSource = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
    assert(appSource.includes('verify: token => adminCredentials.verifyToken(token, process.env.JWT_SECRET)'));
    const clinics = fs.readFileSync(path.join(root, 'src/routes/userclinicas.routes.js'), 'utf8');
    assert(clinics.includes('await adminCredentials.verifyToken('));
    assert.equal((clinics.match(/getUserIdFromToken\(req\)/g) || []).length, (clinics.match(/await getUserIdFromToken\(req\)/g) || []).length);
  } finally {
    client?.disconnect(); agent.destroy(); if (io) await new Promise(resolve => io.close(resolve));
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});

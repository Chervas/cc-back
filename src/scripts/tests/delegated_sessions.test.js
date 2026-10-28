'use strict';
// Entirely synthetic, injected storage. SQL locking/rollback must additionally
// be exercised with the selected migration in an isolated MySQL fixture.
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const jwt = require('jsonwebtoken'), { Op } = require('sequelize');
const S = require('../../services/delegatedSession.service'), A = require('../../services/accessSession.service');
const policy = require('../../lib/delegatedOperationPolicy');
const secret = 'FICTITIOUS_DELEGATION_KEY_NEVER_A_RUNTIME_CREDENTIAL';
const origin = 'https://crm.example.invalid';
const invalid = () => Object.assign(Error('auth_invalid'), { code: 'auth_invalid', status: 401, name: 'JsonWebTokenError' });
function match(row, where) {
  return Reflect.ownKeys(where || {}).every(key => {
    const expected = where[key];
    if (key === Op.or) return expected.some(value => match(row, value));
    if (key === Op.and) return expected.every(value => match(row, value));
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      return Reflect.ownKeys(expected).every(op => op === Op.in ? expected[op].includes(row[key])
        : op === Op.gt ? row[key] > expected[op] : op === Op.lte ? row[key] <= expected[op] : false);
    }
    return row[key] === expected;
  });
}
function fixture({ parentSeconds = 3600, clock = new Date('2026-10-28T10:00:00.000Z') } = {}) {
  let at = new Date(Math.floor(clock.getTime() / 1000) * 1000), ready = true, failAction = null, turn = Promise.resolve(), queries = 0;
  const users = new Map([1, 44, 53, 99].map(id => [id, { id_usuario: id, nombre: 'Fictitious ' + id,
    apellidos: 'TESTONLY', email_usuario: 'testonly-' + id + '@example.invalid', password_usuario: 'FICTITIOUS_HASH_' + id,
    estado_cuenta: 'activo', es_provisional: false, isProfesional: id === 53 }]));
  const parentId = randomUUID(), rows = new Map(), auditRows = [], locks = [];
  const parents = new Map([[parentId, { session_id: parentId, user_id: 1, state: 'active',
    expires_at: new Date(at.getTime() + parentSeconds * 1000), absolute_expires_at: new Date(at.getTime() + 86400000),
    credential_binding: A.binding(users.get(1), secret), authentication_method: 'password_email' }]]);
  const principals = new Map([['normal-admin', { userId: 1, email: users.get(1).email_usuario,
    sessionVersion: 1, type: 'cc_access', jti: parentId, iat: at.getTime() / 1000,
    exp: parents.get(parentId).expires_at.getTime() / 1000, amr: ['pwd', 'email'] }]]);
  const wrap = data => data && new Proxy({}, { get(_target, key) {
    if (key === 'update') return async patch => { Object.assign(data, patch); return wrap(data); };
    return data[key];
  } });
  const models = {
    Usuario: { findAll: async opts => { queries++; locks.push(['users', opts.order, Boolean(opts.lock)]);
      return [...users.values()].filter(row => match(row, opts.where)).sort((a, b) => a.id_usuario - b.id_usuario); },
    findByPk: async id => users.get(id) },
    AuthSession: { findByPk: async id => { queries++; return parents.get(id); } },
    DelegatedSession: {
      findByPk: async id => { queries++; return wrap(rows.get(id)); },
      findOne: async opts => { queries++; return wrap([...rows.values()].find(row => match(row, opts.where))); },
      count: async opts => [...rows.values()].filter(row => match(row, opts.where)).length,
      create: async data => { queries++; const row = { activated_at: null, handoff_consumed_at: null,
        ended_at: null, end_reason: null, ...data }; rows.set(row.delegation_id, row); return wrap(row); },
    },
    sequelize: { transaction: async work => {
      const prior = turn; let release; turn = new Promise(resolve => { release = resolve; }); await prior;
      const saved = structuredClone(rows), savedAudit = structuredClone(auditRows);
      try { return await work({ LOCK: { UPDATE: 'UPDATE' } }); }
      catch (error) { rows.clear(); for (const entry of saved) rows.set(...entry); auditRows.splice(0, auditRows.length, ...savedAudit); throw error; }
      finally { release(); }
    } },
  };
  const normal = {
    activeUser: A.activeUser, projectUser: A.projectUser, credentialBinding: user => A.binding(user, secret),
    verifyNormal: async token => { const v = principals.get(token); if (!v) throw invalid(); return v; },
    verifyNormalReference: async ({ userId, sessionRef, expiresAt }) => {
      locks.push(['normal-parent', userId, sessionRef]);
      const row = parents.get(sessionRef), user = users.get(userId);
      if (!row || row.user_id !== userId || row.state !== 'active' || !A.activeUser(user)
        || row.authentication_method === 'password' || row.credential_binding !== A.binding(user, secret)
        || expiresAt <= at || expiresAt > row.expires_at || expiresAt > row.absolute_expires_at) throw invalid();
      return { userId, sessionRef };
    },
  };
  const audit = { assertReady: async () => { if (!ready) throw Error('TESTONLY audit unavailable'); },
    lifecycle: async value => { auditRows.push(value); if (value.action === failAction) throw Error('TESTONLY audit rollback'); } };
  const config = { enabled: true, secret, origin, runtimeNamespace: 'testonly' };
  const service = S.createService({ models, normalSessions: normal, audit, config: () => config, now: () => at });
  const pkceVerifier = 'v'.repeat(43), pkceChallenge = createHash('sha256').update(pkceVerifier).digest('base64url'), tabNonce = 'n'.repeat(43);
  const create = (extra = {}) => service.create({ token: 'normal-admin', targetUserId: 53, pkceChallenge, tabNonce, origin, ...extra });
  const exchange = (issued, extra = {}) => service.exchange({ handoff: issued.handoff, pkceVerifier, tabNonce, origin, ...extra });
  return { service, models, normal, config, rows, users, parents, principals, parentId, auditRows, locks, create, exchange,
    advance: ms => { at = new Date(at.getTime() + ms); }, now: () => at, ready: value => { ready = value; },
    failAudit: action => { failAction = action; }, queries: () => queries };
}
function actualMiddleware(f, admitted = async (_req, _res, next) => next()) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../routes/auth.middleware'), 'utf8'), { module,
    require: name => name.endsWith('accessSession.service') ? { bearer: A.bearer,
      verify: token => S.isDelegatedToken(token) ? f.service.verify(token) : f.normal.verifyNormal(token) }
      : name.endsWith('platformAudit.delegation') ? { admitHttp: admitted } : policy });
  return module.exports;
}

test('delegation is disabled by default and requires managed MFA, audit configuration, exact origin and runtime', async () => {
  assert.deepEqual(S.settings({}), { enabled: false });
  const env = { AUTH_DELEGATION_ENABLED: 'true', AUTH_DELEGATION_ORIGIN: origin, AUTH_SESSION_MODE: 'enforce',
    AUTH_EMAIL_MFA_MODE: 'enforce', PLATFORM_AUDIT_AUTH_ENABLED: 'true', PLATFORM_AUDIT_AUTH_POLICY: 'auth-durable-v1',
    JOB_RUNTIME_NAMESPACE: 'testonly', JWT_SECRET: secret };
  assert.equal(S.settings(env).enabled, true);
  for (const patch of [{ AUTH_SESSION_MODE: 'legacy' }, { AUTH_EMAIL_MFA_MODE: 'off' }, { PLATFORM_AUDIT_AUTH_ENABLED: 'false' },
    { AUTH_DELEGATION_ORIGIN: origin + '/' }, { AUTH_DELEGATION_ORIGIN: 'http://external.example.invalid' },
    { JOB_RUNTIME_NAMESPACE: '' }, { JWT_SECRET: '' }, { AUTH_DELEGATION_ENABLED: 'maybe' }]) {
    assert.throws(() => S.settings({ ...env, ...patch }), { code: 'auth_delegation_unavailable' });
  }
  const f = fixture(); f.config.enabled = false;
  await assert.rejects(f.create(), { code: 'auth_delegation_unavailable' }); assert.equal(f.queries(), 0);
});

test('admin capabilities are read only, explicitly unavailable while disabled/unready and never inherited by a child', async () => {
  const f = fixture(); f.config.enabled = false;
  assert.deepEqual(await f.service.capabilities({ token: 'normal-admin' }), { enabled: false, ready: false,
    reason: 'auth_delegation_unavailable', sessionMaxSeconds: 900, handoffMaxSeconds: 60 });
  assert.equal(f.queries(), 0); f.config.enabled = true; f.ready(false);
  assert.equal((await f.service.capabilities({ token: 'normal-admin' })).ready, false);
  f.ready(true); assert.equal((await f.service.capabilities({ token: 'normal-admin' })).ready, true);
  const child = await f.exchange(await f.create());
  await assert.rejects(f.service.capabilities({ token: child.token }), { code: 'delegated_operation_requires_own_session' });
});

test('handoff stores only digests, exchanges once and produces a distinct bounded target token without target MFA or login writes', async () => {
  const f = fixture(), issued = await f.create(), before = JSON.stringify([...f.users.values()]), result = await f.exchange(issued);
  const v = S.decode(result.token, f.config, f.now());
  assert.equal(v.type, 'cc_delegated_access'); assert.equal(v.aud, S.AUDIENCE); assert.equal(v.userId, 53);
  assert.equal(v.adminUserId, 1); assert.equal(v.jti, issued.delegationId); assert.equal(result.user.isAdmin, false);
  assert.equal(v.amr, undefined); assert.equal(v.sessionVersion, undefined); assert.equal(v.emailVerifiedAt, undefined);
  assert.equal(result.expiresIn, 900); assert.equal(f.parents.size, 1); assert.equal(JSON.stringify([...f.users.values()]), before);
  const stored = JSON.stringify([...f.rows.values()]); assert(!stored.includes(issued.handoff)); assert(!stored.includes(result.token));
  assert(!stored.includes('FICTITIOUS_HASH')); assert(!stored.includes('testonly-53@example.invalid'));
  assert.deepEqual(f.auditRows.map(row => row.action), ['delegation.requested', 'delegation.started']);
  assert.equal((await f.service.verify(result.token)).authDelegation.effectiveUserId, 53);
  await assert.rejects(f.exchange(issued));
  assert.throws(() => A.decode(result.token, { ...f.config, mode: 'enforce', emailMfaMode: 'enforce' }, f.now()));
});

test('two concurrent handoff exchanges admit exactly one child, and lifecycle persistence failure rolls activation back', async () => {
  const f = fixture(), issued = await f.create();
  const outcomes = await Promise.allSettled([f.exchange(issued), f.exchange(issued)]);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(f.auditRows.filter(row => row.action === 'delegation.started').length, 1);
  const g = fixture(), pending = await g.create(); g.failAudit('delegation.started');
  await assert.rejects(g.exchange(pending), /audit rollback/);
  assert.equal(g.rows.get(pending.delegationId).state, 'pending'); assert.equal(g.auditRows.length, 1);
  g.failAudit(null); await g.exchange(pending);
});

test('wrong nonce, PKCE, origin, expired handoff and unknown handoff never consume a pending session', async () => {
  const f = fixture(), issued = await f.create();
  for (const patch of [{ tabNonce: 'x'.repeat(43) }, { pkceVerifier: 'x'.repeat(43) }, { origin: 'https://other.example.invalid' },
    { handoff: 'x'.repeat(43) }, { pkceVerifier: 'short' }]) {
    await assert.rejects(f.exchange(issued, patch)); assert.equal(f.rows.get(issued.delegationId).state, 'pending');
  }
  f.advance(61000); await assert.rejects(f.exchange(issued));
  assert.equal(f.rows.get(issued.delegationId).state, 'pending');
});

test('owners, agencies, password-only/legacy parents, self/admin/inactive/provisional targets and nested children are denied', async () => {
  for (const parent of [{ userId: 99 }, { sessionVersion: undefined }, { type: undefined }, { amr: ['pwd'] }]) {
    const f = fixture(); Object.assign(f.principals.get('normal-admin'), parent);
    await assert.rejects(f.create()); assert.equal(f.rows.size, 0);
  }
  for (const id of [1, 44]) { const f = fixture(); await assert.rejects(f.create({ targetUserId: id }), { status: 403 }); }
  for (const patch of [{ estado_cuenta: 'suspendido' }, { es_provisional: true }]) {
    const f = fixture(); Object.assign(f.users.get(53), patch);
    await assert.rejects(f.create(), { code: 'auth_delegation_target_forbidden', status: 403 });
  }
  const f = fixture(), child = await f.exchange(await f.create());
  await assert.rejects(f.create({ token: child.token, targetUserId: 99 }), { code: 'delegated_operation_requires_own_session', status: 403 });
});

test('both credential bindings, current account state and the current parent session are checked on every child verification', async () => {
  for (const mutate of [f => { f.users.get(53).password_usuario += 'changed'; }, f => { f.users.get(53).email_usuario = 'changed@example.invalid'; },
    f => { f.users.get(53).estado_cuenta = 'suspendido'; }, f => { f.users.get(1).password_usuario += 'changed'; },
    f => { f.parents.get(f.parentId).state = 'revoked'; }, f => { f.parents.get(f.parentId).authentication_method = 'password'; },
    f => { f.config.runtimeNamespace = 'another-runtime'; }, f => { f.config.origin = 'https://other.example.invalid'; }]) {
    const f = fixture(), child = await f.exchange(await f.create()); mutate(f);
    await assert.rejects(f.service.verify(child.token));
  }
});

test('strict signed child claims cannot change actor/target/session/purpose or claim ordinary target MFA', async () => {
  const f = fixture(), child = await f.exchange(await f.create()), claims = jwt.decode(child.token);
  for (const patch of [{ userId: 99 }, { adminUserId: 44 }, { parentSessionRef: randomUUID() }, { jti: randomUUID() },
    { type: 'cc_access' }, { aud: 'clinicaclick-platform' }, { amr: ['pwd', 'email'] }, { exp: claims.exp + 1 },
    { iat: claims.iat - 1 }, { delegationVersion: 2 }]) {
    const forged = jwt.sign({ ...claims, ...patch }, secret, { algorithm: 'HS256' });
    await assert.rejects(f.service.verify(forged));
  }
  await assert.rejects(f.service.verify(jwt.sign(claims, 'OTHER_FICTITIOUS_KEY')));
});

test('parent expiry caps the child; refresh returns the same token and never extends either lifetime', async () => {
  const f = fixture({ parentSeconds: 180 }), child = await f.exchange(await f.create()), initial = jwt.decode(child.token);
  assert.equal(child.expiresIn, 180); f.advance(60000);
  const refreshed = await f.service.refresh(child.token);
  assert.equal(refreshed.token, child.token); assert.equal(refreshed.expiresIn, 120); assert.equal(jwt.decode(refreshed.token).exp, initial.exp);
  f.advance(121000); await assert.rejects(f.service.verify(child.token));
});

test('business reference requires an explicit reviewed purpose and never substitutes parent permissions or target MFA', async () => {
  const f = fixture(), child = await f.exchange(await f.create()), v = jwt.decode(child.token);
  const reference = { userId: 53, sessionRef: v.jti, expiresAt: new Date(v.exp * 1000) };
  const result = await f.service.verifyReference(reference, { purpose: 'business_profile.write' });
  assert.equal(result.userId, 53); assert.equal(result.authDelegation.adminUserId, 1);
  for (const options of [{}, { purpose: 'oauth.authorize' }, { purpose: 'business_profile.write', requireEmail: true }]) {
    await assert.rejects(f.service.verifyReference(reference, options), { code: 'delegated_operation_requires_own_session', status: 403 });
  }
  await assert.rejects(f.service.verifyReference({ ...reference, userId: 99 }, { purpose: 'business_profile.write' }));
  await assert.rejects(f.service.verifyReference({ ...reference, expiresAt: new Date((v.exp + 1) * 1000) }, { purpose: 'business_profile.write' }));
});

test('canonical session dispatcher accepts only the typed child path and returns explicit own-session errors for child references', async () => {
  const f = fixture(), child = await f.exchange(await f.create()), claims = jwt.decode(child.token);
  const dispatcher = A.createService({ delegatedSessions: f.service,
    models: { sequelize: { query: async () => [[]] } }, now: f.now,
    config: () => ({ mode: 'enforce', secret, emailMfaMode: 'enforce' }) });
  assert.equal((await dispatcher.verify(child.token)).userId, 53);
  await assert.rejects(dispatcher.verifyNormal(child.token));
  const ref = { userId: 53, sessionRef: claims.jti, expiresAt: new Date(claims.exp * 1000) };
  assert.equal((await dispatcher.verifyReference(ref, { purpose: 'business_profile.write' })).userId, 53);
  await assert.rejects(dispatcher.verifyReference(ref), { code: 'delegated_operation_requires_own_session', status: 403 });
  await assert.rejects(dispatcher.verifyReference(ref, { purpose: 'business_profile.write', requireEmail: true }),
    { code: 'delegated_operation_requires_own_session', status: 403 });
  await assert.rejects(dispatcher.revoke(child.token, true), { code: 'delegated_operation_requires_own_session' });
});

test('child exit affects only itself; siblings and principal remain valid and other child IDs return a distinct 403', async () => {
  const f = fixture(), a = await f.exchange(await f.create()), b = await f.exchange(await f.create({ targetUserId: 99 }));
  await assert.rejects(f.service.revoke({ token: a.token, delegationId: b.delegation.delegationId }),
    { code: 'delegated_operation_requires_own_session', status: 403 });
  await f.service.revoke({ token: a.token, delegationId: a.delegation.delegationId });
  await assert.rejects(f.service.verify(a.token)); await f.service.verify(b.token);
  assert.equal(f.parents.get(f.parentId).state, 'active');
  await f.service.revoke({ token: 'normal-admin', delegationId: b.delegation.delegationId });
  await assert.rejects(f.service.verify(b.token)); assert.equal(f.auditRows.at(-1).reason, 'admin_revoked');
});

test('audit outage or lifecycle write failure cannot issue or activate a child', async () => {
  const f = fixture(); f.ready(false); await assert.rejects(f.create()); assert.equal(f.rows.size, 0);
  f.ready(true); f.failAudit('delegation.requested'); await assert.rejects(f.create()); assert.equal(f.rows.size, 0);
  f.failAudit(null); const issued = await f.create(); f.ready(false);
  await assert.rejects(f.exchange(issued)); assert.equal(f.rows.get(issued.delegationId).state, 'pending');
});

test('expired pending handoffs do not exhaust the child cap; expiry records one durable transition', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) await f.create();
  await assert.rejects(f.create(), { code: 'auth_delegation_limit' });
  f.advance(61000); const later = await f.create(); assert(later.handoff);
  assert.equal((await f.service.expire()).expired, 5); assert.equal((await f.service.expire()).expired, 0);
  assert.equal(f.auditRows.filter(row => row.action === 'delegation.expired').length, 5);
});

test('HTTP middleware uses only the target ACL identity, ignores client actor claims and admits before business dispatch', async () => {
  const f = fixture(), child = await f.exchange(await f.create()), module = { exports: {} }, order = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../../routes/auth.middleware'), 'utf8'), { module,
    require: name => name.endsWith('accessSession.service') ? { verify: token => f.service.verify(token), bearer: A.bearer }
      : name.endsWith('platformAudit.delegation') ? { admitHttp: async (_req, _res, next) => { order.push('audit'); return next(); } }
        : policy });
  const request = path => ({ method: 'POST', originalUrl: path, body: { actorId: 1, role: 'admin' },
    headers: { authorization: 'Bearer ' + child.token, 'x-actor-id': '1', 'x-user-id': '1' } });
  const response = () => ({ statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
  const req = request('/api/citas'), res = response();
  await module.exports(req, res, () => order.push('business'));
  assert.deepEqual(order, ['audit', 'business']); assert.equal(req.userData.userId, 53); assert.equal(req.authDelegation.adminUserId, 1);
  const denied = response(); await module.exports(request('/api/access-policies/overrides'), denied, () => assert.fail('must not dispatch'));
  assert.equal(denied.statusCode, 403); assert.equal(denied.body.error, 'delegated_operation_requires_own_session');
});

test('parent revocation while durable admission waits prevents HTTP business dispatch', async () => {
  const f = fixture(), child = await f.exchange(await f.create());
  const auth = actualMiddleware(f, async (_req, _res, next) => {
    f.parents.get(f.parentId).state = 'revoked'; return next();
  });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await auth({ method: 'POST', originalUrl: '/api/citas', headers: { authorization: 'Bearer ' + child.token }, body: {} },
    res, () => assert.fail('revoked authority must not reach a domain writer'));
  assert.equal(res.statusCode, 401);
});

test('own-session policy blocks security mutations while preserving normal agenda/schedule/business operations', () => {
  const denied = [
    ['POST','/api/auth/delegations',{}], ['POST','/api/auth/email-code/step-up',{}], ['POST','/api/auth/revoke-sessions',{}],
    ['PATCH','/api/users/53',{ email_usuario: 'changed@example.invalid' }], ['PATCH','/api/personal/53',{ clinicas: [] }],
    ['PUT','/api/access-policies/overrides',{}], ['POST','/api/personal/invitar',{}], ['POST','/api/personal/me/invitaciones/72/aceptar',{}],
    ['DELETE','/api/personal/53/clinicas/72',{}], ['PUT','/api/patient-direction/profiles/53',{}],
    ['GET','/api/oauth/google/connect',{}], ['POST','/oauth/meta/marketing/authorization',{}],
    ['POST','/api/whatsapp/onboarding/begin',{}], ['PUT','/api/whatsapp/routing',{}],
    ['POST','/api/whatsapp/embedded-signup/callback',{}], ['PATCH','/api/clinicas/72',{ grupoClinicaId: 7 }],
    ['PATCH','/API/Personal/53',{ clinicas: [] }],
    ['POST','/api/personal/reclamar',{}], ['POST','/api/accounting/firm/credentials',{}],
  ];
  for (const [method, originalUrl, body] of denied) assert.equal(policy.requiresOwnSession({ method, originalUrl, body }), true, originalUrl);
  const allowed = [['POST','/api/citas'], ['PATCH','/api/citas/23/attendance'], ['GET','/api/disponibilidad'],
    ['POST','/api/personal/me/bloqueos'], ['PUT','/api/personal/53/schedule-sharing'], ['POST','/api/personal/53/horarios/copy'],
    ['PATCH','/api/users/53'], ['POST','/api/whatsapp/onboarding/authorizations'], ['POST','/api/marketing/google-ads/conversion-action-plans']];
  for (const [method, originalUrl] of allowed) assert.equal(policy.requiresOwnSession({ method, originalUrl, body: { nombre: 'TESTONLY' } }), false, originalUrl);
  assert.equal(policy.requiresOwnSession({ method: 'PATCH', originalUrl: '/api/clinicas/72', body: { email: 'clinic@example.invalid' } }), false,
    'the clinic contact email is a business field, not the user login mailbox');
});

test('socket identity is the effective target and an incoming check disconnects a revoked child without touching its parent', async () => {
  const f = fixture({ clock: new Date() }), child = await f.exchange(await f.create()), io = new EventEmitter();
  io.use = middleware => { io.middleware = middleware; };
  const guard = require('../../lib/socket-session-guard');
  guard.installSocketSessionGuard(io, { verify: token => f.service.verify(token), bearer: A.bearer }, { intervalMs: 60000, timeoutMs: 5000 });
  const socket = new EventEmitter(); socket.connected = true; socket.handshake = { auth: { token: child.token } };
  socket.use = fn => { socket.packetCheck = fn; }; socket.disconnect = () => { socket.connected = false; socket.emit('disconnect'); };
  await io.middleware(socket, error => { if (error) throw error; }); io.emit('connection', socket);
  assert.equal(socket.userData.userId, 53); assert.equal(socket.authDelegation.adminUserId, 1);
  f.parents.get(f.parentId).state = 'revoked';
  await new Promise(resolve => socket.packetCheck(['subscribe', [72]], error => { assert(error); resolve(); }));
  assert.equal(socket.connected, false); assert.equal(f.parents.get(f.parentId).state, 'revoked');
});

test('real outbound guard rechecks each child and suppresses a revoked target while a sibling and principal keep receiving', async () => {
  const f = fixture({ clock: new Date() }), a = await f.exchange(await f.create()), b = await f.exchange(await f.create({ targetUserId: 99 }));
  const io = new EventEmitter(); io.sockets = { sockets: new Map() }; io.use = fn => { io.middleware = fn; };
  const sessions = { bearer: A.bearer, verify: token => S.isDelegatedToken(token) ? f.service.verify(token) : f.normal.verifyNormal(token) };
  require('../../lib/socket-session-guard').installSocketSessionGuard(io, sessions, { intervalMs: 60000, timeoutMs: 5000 });
  const actors = [];
  const realtime = require('../../lib/socket-realtime-guard').installRealtimeAccess(io, {
    audit: { run: async (actor, _operation, work) => { actors.push(actor); return work(); } },
    policy: {
      subscription: async (id, requested) => ({ allowed: [1, 53, 99].includes(id), clinicIds: requested.length ? requested : [72] }),
      resolve: async () => ({ clinicIds: [72], scope: { type: 'clinic', id: '72' } }),
      authorize: async id => [1, 53, 99].includes(id),
    },
  });
  const sockets = [];
  const connect = async (id, token) => {
    const socket = new EventEmitter(); Object.assign(socket, { connected: true, rooms: new Set(), sent: [], handshake: { auth: { token } } });
    socket.use = fn => { socket.packetCheck = fn; }; socket.join = room => socket.rooms.add(room); socket.leave = room => socket.rooms.delete(room);
    socket.emit = (...args) => { socket.sent.push(args); };
    socket.disconnect = () => { if (socket.connected) { socket.connected = false; EventEmitter.prototype.emit.call(socket, 'disconnect'); } };
    await io.middleware(socket, error => { if (error) throw error; }); io.sockets.sockets.set(id, socket); sockets.push(socket); io.emit('connection', socket);
    return socket;
  };
  const idle = async () => {
    const deadline = Date.now() + 5000;
    while (realtime.pending()) { if (Date.now() > deadline) assert.fail('TESTONLY outbound queue timeout'); await new Promise(resolve => setTimeout(resolve, 2)); }
  };
  try {
    const sa = await connect('a', a.token), sb = await connect('b', b.token), principal = await connect('principal', 'normal-admin'); await idle();
    assert(sa.rooms.has('user:53')); assert(sb.rooms.has('user:99')); assert(principal.rooms.has('user:1'));
    const payload = { id: 23, conversation_id: 12, content: 'TESTONLY_OUTBOUND_MESSAGE' };
    realtime.deliver('message:created', payload, ['clinic:72']); await idle();
    assert.deepEqual([sa.sent.length, sb.sent.length, principal.sent.length], [1, 1, 1]);
    assert(actors.some(actor => actor.userId === 53 && actor.authDelegation?.adminUserId === 1));
    f.users.get(53).password_usuario += '_ROTATED';
    realtime.deliver('message:created', { ...payload, id: 24 }, ['clinic:72']); await idle();
    assert.equal(sa.connected, false); assert.deepEqual([sa.sent.length, sb.sent.length, principal.sent.length], [1, 2, 2]);
    assert.equal(sb.connected, true); assert.equal(principal.connected, true); assert.equal(f.parents.get(f.parentId).state, 'active');
  } finally { for (const socket of sockets) socket.disconnect(); }
});

test('real HTTP handoff router validates bodies/origin, never falls back to parent on exchange and dispatches target-only business context', async () => {
  const f = fixture(), http = require('node:http'), express = require('express'), app = express(), auth = actualMiddleware(f);
  app.use(express.json());
  app.use('/api/auth/delegations', require('../../routes/authDelegations.routes').createRouter({ service: f.service, sessions: A, auth }));
  app.post('/api/citas', auth, (req, res) => res.json({ userId: req.userData.userId, adminUserId: req.authDelegation.adminUserId }));
  app.put('/api/access-policies/overrides', auth, () => assert.fail('security mutation must not dispatch'));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent(); agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
  const request = (path, body, token, method = 'POST') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, agent,
      headers: { 'content-type': 'application/json', origin, ...(token ? { authorization: 'Bearer ' + token } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode,
        cache: res.headers['cache-control'], body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  try {
    const verifier = 'h'.repeat(43), challenge = createHash('sha256').update(verifier).digest('base64url'), nonce = 'a'.repeat(43);
    const body = { targetUserId: 53, pkceChallenge: challenge, tabNonce: nonce };
    assert.equal((await request('/api/auth/delegations', body)).status, 401);
    assert.equal((await request('/api/auth/delegations', { ...body, actorId: 1 }, 'normal-admin')).status, 400);
    const issued = await request('/api/auth/delegations', body, 'normal-admin');
    assert.equal(issued.status, 200); assert.equal(issued.cache, 'private, no-store');
    const wrong = await request('/api/auth/delegations/exchange', { handoff: 'x'.repeat(43), pkceVerifier: verifier, tabNonce: nonce }, 'normal-admin');
    assert.equal(wrong.status, 401, 'a normal principal header cannot replace the one-use handoff');
    const exchangeBody = { handoff: issued.body.handoff, pkceVerifier: verifier, tabNonce: nonce };
    const child = await request('/api/auth/delegations/exchange', exchangeBody);
    assert.equal(child.status, 200); assert.equal((await request('/api/auth/delegations/exchange', exchangeBody)).status, 401);
    const domain = await request('/api/citas', { actorId: 1, role: 'admin' }, child.body.token);
    assert.deepEqual(domain.body, { userId: 53, adminUserId: 1 });
    const denied = await request('/api/access-policies/overrides', {}, child.body.token, 'PUT');
    assert.equal(denied.status, 403); assert.equal(denied.body.error, 'delegated_operation_requires_own_session');
    const exited = await request('/api/auth/delegations/' + child.body.delegation.delegationId + '/revoke', {}, child.body.token);
    assert.equal(exited.status, 200); assert.equal(f.parents.get(f.parentId).state, 'active');
  } finally { agent.destroy(); await new Promise(resolve => server.close(resolve)); }
});

test('actual auth controller refresh/logout do not authenticate the target, invent target login/MFA or clear the principal device cookie', async () => {
  const f = fixture(), child = await f.exchange(await f.create()), module = { exports: {} }; let cookiesCleared = 0, auditAttempts = 0;
  const dependencies = {
    dotenv: { config() {} }, bcryptjs: {}, '../../models': f.models,
    '../services/accessSession.service': { ...A, authenticated: () => assert.fail('must not authenticate target') },
    '../services/delegatedSession.service': { ...S, ...f.service },
    '../services/platformAudit.service': { begin: () => { auditAttempts++; assert.fail('must not claim target auth'); } },
    '../services/platformAudit.delegation': { admitHttp: async (_req, _res, next) => next() },
    '../lib/blocked-auth-emails': { isBlockedAuthEmail: () => false },
    '../services/passwordReset.service': {}, '../services/systemNotifications.service': {}, '../services/authEmailChallenge.service': {},
    '../services/authTrustedDevice.service': { clearCookie: () => { cookiesCleared++; } },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../controllers/auth.controllers'), 'utf8'), { module, exports: module.exports,
    require: name => { assert(Object.hasOwn(dependencies, name), name); return dependencies[name]; }, console: { error() {} } });
  const response = () => ({ statusCode: 200, set() { return this; }, status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; } });
  f.advance(60000); const refreshed = response();
  await module.exports.signInWithToken({ body: { accessToken: child.token } }, refreshed);
  assert.equal(refreshed.statusCode, 200); assert.equal(refreshed.body.token, child.token); assert.equal(refreshed.body.expiresIn, 840);
  assert.equal(auditAttempts, 0); assert.equal(f.users.get(53).ultimo_login, undefined);
  const denied = response(); await module.exports.revokeSessions({ headers: { authorization: 'Bearer ' + child.token } }, denied);
  assert.equal(denied.statusCode, 403); assert.equal(cookiesCleared, 0); await f.service.verify(child.token);
  const exited = response(); await module.exports.signOut({ headers: { authorization: 'Bearer ' + child.token } }, exited);
  assert.equal(exited.statusCode, 200); assert.equal(exited.body.delegated, true); assert.equal(cookiesCleared, 0);
  assert.equal(f.parents.get(f.parentId).state, 'active'); await assert.rejects(f.service.verify(child.token));
});

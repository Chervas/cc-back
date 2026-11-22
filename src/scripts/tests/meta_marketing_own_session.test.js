'use strict';
// Real normal-session verifier and Meta scope, with synthetic storage only.
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const noIO = () => { throw Error('OFFLINE_META_SESSION_IO_FORBIDDEN'); };
require('node:net').Socket.prototype.connect = noIO;
require('node:tls').connect = noIO;
global.fetch = noIO;
const modelFile = require.resolve('../../../models');
require.cache[modelFile] = { id: modelFile, filename: modelFile, loaded: true, exports: {} };
const A = require('../../services/accessSession.service');
const { createScope } = require('../../services/metaMarketingOAuthScope.service');

function fixture({ method = 'password_trusted_device', group = false } = {}) {
  const now = new Date('2030-01-01T12:00:00Z'), transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const input = { scopeKey: group ? 'group:19' : 'clinic:11', actorId: 22, sessionRef: randomUUID(), sessionExpiresAt: new Date(+now + 1800000) };
  const user = { id_usuario: 22, password_usuario: 'FICTITIOUS_PASSWORD_BINDING', email_usuario: 'fixture@example.invalid', estado_cuenta: 'activo', es_provisional: false };
  const secret = 'FICTITIOUS_META_OWN_SESSION_KEY';
  const row = { ...user, user_id: 22, session_id: input.sessionRef, state: 'active', issued_at: new Date(+now - 60000),
    expires_at: new Date(+now + 3600000), absolute_expires_at: new Date(+now + 3600000), authentication_method: method,
    email_verified_at: new Date(+now - 61000), email_challenge_id: method === 'password_email' ? randomUUID() : null,
    trusted_device_id: method === 'password_trusted_device' ? randomUUID() : null, credential_binding: A.binding(user, secret) };
  const state = { reads: [], normalChecks: 0, genericChecks: 0, delegatedChecks: 0, deviceChecks: 0, deviceValid: true, permitted: group ? [11, 12] : [11] };
  const models = {
    Usuario: { findByPk: async (id, options) => { assert.equal(id, 22);assert.equal(options.transaction, transaction);assert.equal(options.lock, 'UPDATE');state.reads.push('user');return user; } },
    sequelize: { query: async (sql, options) => {
      assert.match(sql, /^SELECT s\.\*, u\.password_usuario/);assert.match(sql, /FROM AuthSessions s JOIN Usuarios/);assert.match(sql, /FOR UPDATE$/);
      assert.equal(options.transaction, transaction);assert.equal(options.logging, false);state.reads.push('session');
      return [[...(options.replacements.id === row.session_id && options.replacements.userId === row.user_id ? [row] : [])]];
    } },
    Clinica: { findAll: async options => { assert.equal(options.transaction, transaction);state.reads.push('clinics');return (group ? [11, 12] : [11]).map(id_clinica => ({ id_clinica })); } },
    UsuarioClinica: { findAll: async options => { assert.equal(options.transaction, transaction);assert.equal(options.lock, 'UPDATE');assert.equal(options.where.id_usuario, 22);state.reads.push('membership');return state.permitted.map(id_clinica => ({ id_clinica })); } },
  };
  const actual = A.createService({ models, now: () => now, config: () => ({ mode: 'enforce', secret, emailMfaMode: 'enforce', ttl: 43200 }),
    audit: { append: noIO }, trustedDevices: { verifySession: async (_row, _user, options) => {
      state.deviceChecks++;assert.equal(options.transaction, transaction);
      if (!state.deviceValid) throw Object.assign(Error('auth_invalid'), { code: 'auth_invalid', status: 401 });
    } }, delegatedSessions: { hasReference: async () => { state.delegatedChecks++;return true; }, verifyReference: async () => { state.delegatedChecks++;return { userId: 22 }; } } });
  const sessions = { ...actual,
    verifyNormalReference: async (reference, options) => { state.normalChecks++;assert.deepEqual(Object.keys(options), ['transaction']);return actual.verifyNormalReference(reference, options); },
    verifyReference: async () => { state.genericChecks++;throw Error('GENERIC_DELEGATED_FALLBACK_FORBIDDEN'); },
  };
  const scope = createScope({ models, sessions, recoveryGuard: {} });
  return { input, transaction, row, user, state, models, actual, scope, run: () => scope.authorize(input, transaction) };
}

test('a valid own trusted-device CRM session authorizes Meta without another email/password challenge', async () => {
  const f = fixture(), before = JSON.stringify([f.row, f.user]), value = await f.run();
  assert.equal(value.sessionRef, f.input.sessionRef);assert.equal(+value.sessionExpiresAt, +f.input.sessionExpiresAt);
  assert.deepEqual(value.clinicIds, [11]);assert.equal(f.state.deviceChecks, 1);
  assert.deepEqual(f.state.reads, ['user', 'session', 'clinics', 'membership']);
  assert.equal(f.state.normalChecks, 1);assert.equal(f.state.genericChecks, 0);assert.equal(f.state.delegatedChecks, 0);
  assert.equal(JSON.stringify([f.row, f.user]), before);
  // Other operations explicitly requesting email retain the central step-up.
  await assert.rejects(f.actual.verifyNormalReference({ userId: 22, sessionRef: f.input.sessionRef, expiresAt: f.input.sessionExpiresAt },
    { transaction: f.transaction, requireEmail: true }), { code: 'auth_email_verification_required', status: 403 });
});

test('an existing own email-verified session keeps the same Meta authority without issuing or replacing a session', async () => {
  const f = fixture({ method: 'password_email' });await f.run();
  assert.equal(f.state.deviceChecks, 0);assert.equal(f.state.normalChecks, 1);assert.equal(f.state.genericChecks, 0);
});

test('a reference existing only in delegation storage never reaches the generic delegated fallback', async () => {
  const f = fixture();f.input.sessionRef = randomUUID();
  await assert.rejects(f.run(), { code: 'meta_oauth_session_required', httpStatus: 401 });
  assert.equal(f.state.delegatedChecks, 0);assert.equal(f.state.genericChecks, 0);assert(!f.state.reads.includes('clinics'));
});

test('logout, expired session, password change, disabled account and revoked trusted device still deny Meta authority', async t => {
  for (const [label, change] of [
    ['logout', f => { f.row.state = 'revoked'; }],
    ['stored expiry', f => { f.row.expires_at = new Date('2029-12-31'); }],
    ['original reference expiry', f => { f.input.sessionExpiresAt = new Date('2029-12-31'); }],
    ['password binding', f => { f.row.password_usuario = 'FICTITIOUS_CHANGED_BINDING'; }],
    ['disabled account', f => { f.row.estado_cuenta = 'inactivo'; }],
    ['trusted-device withdrawal', f => { f.state.deviceValid = false; }],
  ]) await t.test(label, async () => {
    const f = fixture();change(f);await assert.rejects(f.run(), { code: 'meta_oauth_session_required', httpStatus: 401 });
    assert.equal(f.state.genericChecks, 0);assert.equal(f.state.delegatedChecks, 0);assert(!f.state.reads.includes('clinics'));
  });
});

test('a valid normal session cannot omit a clinic from the complete group WRITE permission check', async () => {
  const f = fixture({ group: true });f.state.permitted = [11];
  await assert.rejects(f.run(), { code: 'meta_oauth_scope_forbidden', httpStatus: 403 });
  assert.equal(f.state.deviceChecks, 1);assert.equal(f.state.genericChecks, 0);
});

test('missing normal-reference verification fails closed instead of borrowing a generic verifier', async () => {
  const f = fixture();let generic = 0;
  const scope = createScope({ models: f.models, sessions: { verifyReference: async () => { generic++;return {}; } }, recoveryGuard: {} });
  await assert.rejects(scope.authorize(f.input, f.transaction), { code: 'meta_oauth_unavailable', httpStatus: 503 });
  assert.equal(generic, 0);assert.deepEqual(f.state.reads, []);
});

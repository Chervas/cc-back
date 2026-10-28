'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const jwt = require('jsonwebtoken');
require('./fixtures/security_offline_runtime.cjs');
const admin = require('../../lib/adminCredentialSession');
const secret = 'FICTITIOUS_ADMIN_SIGNING_KEY';
const { randomUUID } = require('node:crypto');
const user = id => ({ id_usuario: id, email_usuario: 'admin-' + id + '@example.invalid', password_usuario: 'FICTITIOUS_PASSWORD_HASH', estado_cuenta: 'activo', es_provisional: false });
const token = u => ({ userId: u.id_usuario, email: u.email_usuario, ...admin.claims(u, secret) });
test('all canonical global administrators require current credentials; old JWTs fail before SQL', async () => {
  for (const id of [1,44]) {
    const u = user(id); let reads = 0;
    const findUser = async value => { reads++; assert.equal(value, id); return u; };
    await assert.rejects(admin.verify({ userId: id, email: u.email_usuario }, secret, { findUser }), { code: 'auth_invalid' });
    assert.equal(reads, 0);
    const v = jwt.verify(jwt.sign(token(u), secret), secret);
    assert.equal(await admin.verify(v, secret, { findUser }), v); assert.equal(reads, 1);
    assert(!JSON.stringify(v).includes(u.password_usuario));
  }
});
test('password/email changes, disabled accounts, missing accounts and another admin invalidate the proof', async () => {
  const u = user(1); const v = token(u);
  for (const current of [{ ...u, password_usuario: 'ROTATED_FICTITIOUS_HASH' }, { ...u, email_usuario: 'new@example.invalid' },
    { ...u, estado_cuenta: 'suspendido' }, { ...u, es_provisional: true }, user(44), null]) {
    await assert.rejects(admin.verify(v, secret, { findUser: async () => current }), { code: 'auth_invalid' });
  }
  await assert.rejects(admin.verify(v, 'OTHER_FICTITIOUS_KEY', { findUser: async () => u }), { code: 'auth_invalid' });
});
test('database failures cannot authorize; malformed proof and string admin IDs are rejected', async () => {
  const u = user(1); const v = token(u);
  await assert.rejects(admin.verify(v, secret, { findUser: async () => { throw Error('FICTITIOUS_SQL_FAILURE'); } }));
  for (const invalid of [{ ...v, userId: '1' }, { ...v, adminCredentialBinding: 'bad' }, { ...v, adminCredentialVersion: 2 }]) {
    await assert.rejects(admin.verify(invalid, secret, { findUser: async () => { throw Error('must not read'); } }), { code: 'auth_invalid' });
  }
});
test('ordinary clinic owners keep legacy compatibility without DB reads or admin claims', async () => {
  const u = user(99); assert.deepEqual(admin.claims(u, secret), {});
  const v = { userId: 99, email: u.email_usuario };
  assert.equal(await admin.verify(v, secret, { findUser() { throw Error('must not read'); } }), v);
});
test('the public verifier checks signature, expiry, algorithm and bearer syntax before accepting claims', async () => {
  const u = user(1); const signed = jwt.sign(token(u), secret, { expiresIn: 300 });
  assert.equal((await admin.verifyToken(admin.bearer('Bearer ' + signed), secret, { findUser: async () => u })).userId, 1);
  for (const invalid of [jwt.sign(token(u), 'WRONG_KEY', { expiresIn: 300 }), jwt.sign(token(u), secret, { expiresIn: -1 }),
    jwt.sign(token(u), secret), jwt.sign(token(u), secret, { algorithm: 'HS384', expiresIn: 300 })]) {
    await assert.rejects(admin.verifyToken(invalid, secret, { findUser: async () => u }));
  }
  for (const header of [null, 'Basic abc', 'Bearer a b', 'Bearer ']) assert.throws(() => admin.bearer(header));
});
test('legacy token renewal cannot upgrade a password proof that raced a credential reset', async () => {
  const sessions = require('../../services/accessSession.service').createService({ models: {},
    config: () => ({ mode: 'legacy', ttl: 300, secret, emailMfaMode: 'off' }) });
  const u = user(1); const issued = await sessions.issue(u);
  const v = jwt.verify(issued.token, secret); admin.assertMatches(v, u, secret);
  const renewed = await sessions.issue(u, { parentToken: issued.token }); admin.assertMatches(jwt.verify(renewed.token, secret), u, secret);
  await assert.rejects(sessions.issue({ ...u, password_usuario: 'ROTATED_FICTITIOUS_HASH' }, { parentToken: issued.token }), { code: 'auth_invalid' });
  const beforeCut = jwt.sign({ userId: 1, email: u.email_usuario }, secret, { expiresIn: 300 });
  await assert.rejects(sessions.issue(u, { parentToken: beforeCut }), { code: 'auth_invalid' });
});
test('legacy verifier rejects signed child and every typed purpose before any registry/user lookup, including a revoked child context', async () => {
  let reads = 0;
  const findUser = async () => { reads++; throw Error('must not consult credentials for another token purpose'); };
  const claims = { userId: 53, email: user(53).email_usuario, type: 'cc_delegated_access', delegationVersion: 1,
    adminUserId: 1, parentSessionRef: randomUUID() };
  const child = jwt.sign(claims, secret, { expiresIn: 300, issuer: 'clinicaclick', audience: 'clinicaclick-delegated', jwtid: randomUUID() });
  const registry = { state: 'active' };
  for (const state of ['active', 'revoked']) {
    registry.state = state;
    await assert.rejects(admin.verifyToken(child, secret, { findUser, findDelegatedSession: () => registry }), { code: 'auth_invalid' });
  }
  for (const type of ['cc_access', 'consent_signature_package', 'clinic_tablet_kiosk', 'economic_budget_signature_request', 'unknown_purpose']) {
    const signed = jwt.sign({ userId: 53, email: user(53).email_usuario, type }, secret, { expiresIn: 300 });
    await assert.rejects(admin.verifyToken(signed, secret, { findUser }), { code: 'auth_invalid' });
  }
  for (const patch of [{ type: null }, { sessionVersion: 1 }, { delegationVersion: 1 }, { adminUserId: 1 },
    { parentSessionRef: randomUUID() }, { iss: 'other_purpose' }, { aud: 'other_purpose' }]) {
    await assert.rejects(admin.verifyToken(jwt.sign({ userId: 53, email: user(53).email_usuario, ...patch }, secret, { expiresIn: 300 }), secret, { findUser }), { code: 'auth_invalid' });
  }
  assert.equal(reads, 0);
});
test('untyped legacy owners retain compatibility while managed normal access uses the central registry and revocation check', async () => {
  const owner = user(99); let legacyReads = 0;
  const legacy = jwt.sign(token(owner), secret, { expiresIn: 300 });
  assert.equal((await admin.verifyToken(legacy, secret, { findUser: () => { legacyReads++; throw Error('must not read'); } })).userId, 99);
  assert.equal(legacyReads, 0);
  const sessionsModule = require('../../services/accessSession.service');
  const at = Math.floor(Date.now() / 1000), target = user(53); let reads = 0, row;
  const sessions = sessionsModule.createService({ models: { sequelize: { query: async () => { reads++; return [[row]]; } } },
    config: () => ({ mode: 'enforce', ttl: 300, secret, emailMfaMode: 'enforce' }) });
  const sessionRef = randomUUID(), emailVerifiedAt = at - 1;
  row = { ...target, user_id: 53, session_id: sessionRef, state: 'active', credential_binding: sessions.credentialBinding(target),
    issued_at: new Date(at * 1000), expires_at: new Date((at + 300) * 1000), absolute_expires_at: new Date((at + 900) * 1000),
    authentication_method: 'password_email', email_verified_at: new Date(emailVerifiedAt * 1000), email_challenge_id: randomUUID(), trusted_device_id: null };
  const managed = jwt.sign({ userId: 53, email: target.email_usuario, type: 'cc_access', sessionVersion: 1,
    amr: ['pwd', 'email'], emailVerifiedAt, iat: at, exp: at + 300 }, secret,
  { algorithm: 'HS256', issuer: 'clinicaclick', audience: 'clinicaclick-platform', jwtid: sessionRef });
  await assert.rejects(admin.verifyToken(managed, secret), { code: 'auth_invalid' });
  assert.equal((await sessions.verifyNormal(managed)).userId, 53); assert.equal(reads, 1);
  row.state = 'revoked';
  await assert.rejects(sessions.verifyNormal(managed), { code: 'auth_invalid' }); assert.equal(reads, 2);
});

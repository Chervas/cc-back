'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const jwt = require('jsonwebtoken');
require('./fixtures/security_offline_runtime.cjs');
const admin = require('../../lib/adminCredentialSession');
const secret = 'FICTITIOUS_ADMIN_SIGNING_KEY';
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

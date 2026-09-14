'use strict';
const assert = require('node:assert/strict'); const { DataTypes: D } = require('sequelize');
const { randomUUID } = require('node:crypto'); const jwt = require('jsonwebtoken'); const bcrypt = require('bcryptjs');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const migration = require('../../../migrations/20260913130000-create-auth-email-challenges');
  const qi = sql.getQueryInterface();
  models.Usuario = require('../../../models/usuario')(sql, D); await models.Usuario.sync();
  await require('../../../migrations/20260912210000-create-platform-audit-events').up(qi, D);
  await require('../../../migrations/20260913003000-add-platform-audit-result-part').up(qi);
  await require('../../../migrations/20260912220000-create-auth-sessions').up(qi, D);
  await migration.up(qi); await migration.down(qi); await migration.up(qi);
  await require('../../../migrations/20260914220000-create-auth-trusted-devices').up(qi);
  models.AuthSession = require('../../../models/authsession')(sql, D);
  models.AuthEmailChallenge = require('../../../models/authemailchallenge')(sql, D);
  models.PlatformAuditEvent = require('../../../models/platformauditevent')(sql, D);
  const api = require('../../services/accessSession.service');
  const challengeApi = require('../../services/authEmailChallenge.service');
  const guard = require('../../services/authEmailDeliveryGuard.service');
  const C = require('../../services/authEmailChallenge.contract');
  const repo = require('../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const env = { JWT_SECRET: 'FICTITIOUS_EMAIL_SESSION_KEY_NOT_FOR_DEPLOYMENT', AUTH_SESSION_MODE: 'enforce',
    AUTH_EMAIL_MFA_MODE: 'enforce', PLATFORM_AUDIT_AUTH_ENABLED: 'true', PLATFORM_AUDIT_AUTH_POLICY: 'auth-durable-v1' };
  let at = new Date(Math.floor(Date.now() / 1000) * 1000); const now = () => at;
  const config = () => ({ mode: env.AUTH_EMAIL_MFA_MODE, key: Buffer.alloc(32, 7) });
  const makeSessions = () => api.createService({ models, audit: repo, now, config: () => api.settings(env) });
  let sessions = makeSessions(); let mailFailure = false; let nextMailId = 0; const mail = [];
  const make = () => challengeApi.createService({ models, sessions, audit: repo, now, config,
    queueEmail: async (input, { transaction }) => { assert(transaction); if (mailFailure) throw Error('FICTITIOUS_MAIL_SECRET');
      const row = { id: ++nextMailId, input }; mail.push(row); return { emailMessage: { id: row.id, status: 'queued' } }; } });
  let challenges = make(); let userNumber = 0;
  const user = () => models.Usuario.create({ nombre: 'Fictitious', email_usuario: 'email-qa-' + (++userNumber) + '@example.invalid',
    password_usuario: bcrypt.hashSync('FICTITIOUS_PASSWORD', 4) });
  const codeFor = id => mail.filter(m => m.input.usuarioId === id).at(-1).input.templateContext.verification_code;
  const pendingRow = token => models.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(token) } });
  const wrong = code => code === '000000' ? '111111' : '000000';
  report.checks.push('Actual additive challenge/session DDL round trips while empty without shared database access');

  const firstUser = await user();
  await assert.rejects(sql.transaction(transaction => sessions.issue(firstUser, { transaction })), { code: 'auth_email_required' });
  env.AUTH_EMAIL_MFA_MODE = 'off'; const old = (await sessions.authenticated(firstUser)).body;
  env.AUTH_EMAIL_MFA_MODE = 'enforce'; await assert.rejects(sessions.verify(old.token), /auth_invalid/);
  const started = await challenges.begin(firstUser); assert.equal(started.mfaRequired, true); assert(!started.token && !started.user);
  const originalRow = await pendingRow(started.challengeToken); const originalCode = codeFor(firstUser.id_usuario);
  const stored = JSON.stringify(originalRow.toJSON());
  for (const value of [started.challengeToken, firstUser.email_usuario, firstUser.password_usuario]) assert(!stored.includes(value));
  assert.equal(originalRow.code_hash, C.codeHash(config().key, originalRow.challenge_id, originalCode));
  assert.equal(await models.AuthSession.count(), 1, 'No new session at the password-only step');
  report.checks.push('Password proof only queues an opaque challenge; enforced session issuance rejects missing proof and old password-only JWTs');

  const races = await Promise.allSettled([challenges.verify(started.challengeToken, originalCode), make().verify(started.challengeToken, originalCode)]);
  assert.equal(races.filter(v => v.status === 'fulfilled').length, 1);
  const login = races.find(v => v.status === 'fulfilled').value; const claims = jwt.decode(login.token);
  assert.deepEqual(claims.amr, ['pwd', 'email']); assert.equal((await sessions.verify(login.token)).userId, firstUser.id_usuario);
  assert.equal((await pendingRow(started.challengeToken)).state, 'used');
  assert.equal(await models.AuthSession.count({ where: { authentication_method: 'password_email' } }), 1);
  await assert.rejects(challenges.verify(started.challengeToken, originalCode), { code: 'auth_email_invalid' });
  sessions = makeSessions(); challenges = make(); await sessions.verify(login.token);
  await sessions.verifyReference({ userId: firstUser.id_usuario, sessionRef: claims.jti, expiresAt: new Date(claims.exp * 1000) });
  const renewed = await sessions.authenticated(firstUser, { parentToken: login.token });
  assert.deepEqual(jwt.decode(renewed.body.token).amr, ['pwd', 'email']); assert.equal(jwt.decode(renewed.body.token).jti, claims.jti);
  const stripped = { ...claims }; delete stripped.amr; delete stripped.emailVerifiedAt;
  await assert.rejects(sessions.verify(jwt.sign(stripped, env.JWT_SECRET)), /auth_invalid/);
  await sessions.revoke(login.token); await assert.rejects(sessions.verify(renewed.body.token), /auth_invalid/);
  report.checks.push('Concurrent correct codes consume once; durable email proof survives service recreation, renewal and callback checks, while replay, stripped claims and logout are rejected');

  const lockedUser = await user(); const locked = await challenges.begin(lockedUser); const lockedCode = codeFor(lockedUser.id_usuario);
  const failures = await Promise.allSettled(Array.from({ length: 5 }, () => make().verify(locked.challengeToken, wrong(lockedCode))));
  assert(failures.every(v => v.status === 'rejected')); assert.equal((await pendingRow(locked.challengeToken)).attempts, 5);
  assert.equal((await pendingRow(locked.challengeToken)).state, 'locked');
  await assert.rejects(challenges.verify(locked.challengeToken, lockedCode)); await assert.rejects(challenges.resend(locked.challengeToken));
  report.checks.push('Five concurrent incorrect guesses persist all attempts, lock the challenge and cannot be bypassed with a later correct code or resend');

  const resendUser = await user(); const resendStart = await challenges.begin(resendUser); const beforeCode = codeFor(resendUser.id_usuario);
  await assert.rejects(challenges.resend(resendStart.challengeToken), { code: 'auth_email_rate_limited' });
  await assert.rejects(challenges.verify(resendStart.challengeToken, wrong(beforeCode)));
  at = new Date(at.getTime() + 60000); await challenges.resend(resendStart.challengeToken);
  const afterCode = codeFor(resendUser.id_usuario); assert.notEqual(beforeCode, afterCode);
  assert.equal((await pendingRow(resendStart.challengeToken)).attempts, 1);
  await assert.rejects(challenges.verify(resendStart.challengeToken, beforeCode));
  assert.equal((await pendingRow(resendStart.challengeToken)).attempts, 2);
  await sessions.verify((await challenges.verify(resendStart.challengeToken, afterCode)).token);
  report.checks.push('Resend cooldown is persistent; a different code replaces the old one without resetting attempts');

  const expiryUser = await user(); const expiring = await challenges.begin(expiryUser); const expiryRow = await pendingRow(expiring.challengeToken);
  at = new Date(expiryRow.expires_at); await assert.rejects(challenges.verify(expiring.challengeToken, codeFor(expiryUser.id_usuario)), { code: 'auth_email_expired' });
  assert.equal((await pendingRow(expiring.challengeToken)).state, 'expired');
  const changedUser = await user(); const changed = await challenges.begin(changedUser);
  await models.Usuario.update({ email_usuario: 'changed@example.invalid' }, { where: { id_usuario: changedUser.id_usuario } });
  await assert.rejects(challenges.verify(changed.challengeToken, codeFor(changedUser.id_usuario)), { code: 'auth_email_invalid' });
  assert.equal((await pendingRow(changed.challengeToken)).state, 'revoked');
  report.checks.push('Expiry at the exact boundary and a changed account email revoke pending proofs without issuing a session');

  const rollbackUser = await user(); const rollback = await challenges.begin(rollbackUser); const rollbackCode = codeFor(rollbackUser.id_usuario);
  const append = repo.append; repo.append = async (value, options) => { if (value.version === 13 && value.reason === 'code_verified') throw Error('FICTITIOUS_AUDIT_SECRET'); return append(value, options); };
  await assert.rejects(challenges.verify(rollback.challengeToken, rollbackCode), { code: 'auth_email_unavailable' });
  assert.equal((await pendingRow(rollback.challengeToken)).state, 'pending');
  assert.equal(await models.AuthSession.count({ where: { user_id: rollbackUser.id_usuario } }), 0);
  repo.append = append; await sessions.verify((await challenges.verify(rollback.challengeToken, rollbackCode)).token);
  const mailUser = await user(); mailFailure = true;
  await assert.rejects(challenges.begin(mailUser), { code: 'auth_email_unavailable' }); mailFailure = false;
  assert.equal(await models.AuthEmailChallenge.count({ where: { user_id: mailUser.id_usuario } }), 0);
  report.checks.push('Failed human audit rolls back code consumption and session together; failed mail enqueue rolls back the new challenge');

  const deliveryUser = await user(); const delivery = await challenges.begin(deliveryUser); const queued = mail.at(-1);
  const deliveryRow = await pendingRow(delivery.challengeToken);
  const message = { id: queued.id, template_key: 'auth.email_verification', related_type: 'auth_email_challenge',
    related_id: deliveryRow.challenge_id, recipient_hash: C.emailHash(deliveryUser.email_usuario) };
  const guardOptions = { models, config, sessionService: sessions, now };
  assert(await guard.mayDeliver(message, deliveryUser.email_usuario, queued.input.templateContext, guardOptions));
  assert(!await guard.mayDeliver({ ...message, id: message.id + 1 }, deliveryUser.email_usuario, queued.input.templateContext, guardOptions));
  await models.Usuario.update({ estado_cuenta: 'inactivo' }, { where: { id_usuario: deliveryUser.id_usuario } });
  assert(!await guard.mayDeliver(message, deliveryUser.email_usuario, queued.input.templateContext, guardOptions));
  await assert.rejects(challenges.verify(delivery.challengeToken, codeFor(deliveryUser.id_usuario)));
  report.checks.push('Delivery checks current account, current message and current code; disabled users or superseded messages cannot send a usable code');

  const cache = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
  cache('dotenv', { config: () => ({}) });
  cache('../../services/accessSession.service', { ...api, ...sessions, settings: () => api.settings(env) });
  cache('../../services/authEmailChallenge.service', { ...challengeApi, ...challenges, mode: () => env.AUTH_EMAIL_MFA_MODE });
  const capture = require('../../services/platformAudit.service').createService({ repository: repo,
    config: () => ({ enabled: true, policy: 'auth-durable-v1' }), now });
  cache('../../services/platformAudit.service', capture);
  cache('../../services/systemNotifications.service', { notifyUserRegistration: async () => {} });
  const resetApi = require('../../services/passwordReset.service');
  cache('../../services/personalPresence.service', {});
  models.UsuarioClinica = sql.define('FictitiousEmailInvite', { id_usuario: D.INTEGER, invite_token: D.STRING,
    estado_invitacion: D.STRING, responded_at: D.DATE }, { timestamps: false }); await models.UsuarioClinica.sync();
  const http = require('node:http'); const app = require('express')(); app.use(require('express').json());
  app.use('/api/auth', require('../../routes/auth.routes'));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent(); agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
  const request = (path, body, token) => new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, agent, method: raw ? 'POST' : 'GET',
      headers: { ...(raw ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(raw);
  });
  try {
    const httpUser = await user(); const before = mail.length;
    assert.equal((await request('/api/auth/sign-in', { email: httpUser.email_usuario, password: 'wrong' })).status, 401);
    assert.equal(mail.length, before);
    const start = await request('/api/auth/sign-in', { email: httpUser.email_usuario, password: 'FICTITIOUS_PASSWORD' });
    assert.equal(start.status, 202); assert.match(start.headers['cache-control'], /no-store/);
    assert(start.body.mfaRequired && !start.body.token && !start.body.user);
    assert.equal((await request('/api/auth/me', null, start.body.challengeToken)).status, 401);
    const code = codeFor(httpUser.id_usuario);
    assert.equal((await request('/api/auth/email-code/verify', { challengeToken: start.body.challengeToken, code: wrong(code) })).status, 401);
    const verified = await request('/api/auth/email-code/verify', { challengeToken: start.body.challengeToken, code });
    assert.equal(verified.status, 200); assert.match(verified.headers['cache-control'], /no-store/);
    assert.equal((await request('/api/auth/me', null, verified.body.token)).status, 200);
    assert.equal((await request('/api/auth/sign-in-with-token', { accessToken: old.token })).status, 401);
    at = new Date(at.getTime() + 60000);
    const unlock = await request('/api/auth/unlock-session', { email: httpUser.email_usuario, password: 'FICTITIOUS_PASSWORD' });
    assert.equal(unlock.status, 202); assert(!unlock.body.token);
    assert.equal((await request('/api/auth/email-code/resend', { challengeToken: unlock.body.challengeToken })).status, 429);
    assert.equal((await request('/api/auth/email-code/verify', { challengeToken: unlock.body.challengeToken, code: codeFor(httpUser.id_usuario), userId: 999 })).status, 400);
    report.checks.push('Actual HTTP login and unlock require email, challenge tokens cannot access me, wrong codes can retry, old sessions fail renewal and request schemas are closed');

    const signup = await request('/api/auth/sign-up', { nombre: 'Fictitious signup', email_usuario: 'signup@example.invalid', password: 'FICTITIOUS_PASSWORD' });
    assert.equal(signup.status, 201); assert.equal(signup.body.signInRequired, true); assert(!signup.body.token);
    const invited = await models.Usuario.create({ nombre: 'Fictitious invite', email_usuario: 'provisional@example.invalid',
      password_usuario: bcrypt.hashSync('FICTITIOUS_OLD_PASSWORD', 4), es_provisional: true });
    await models.UsuarioClinica.create({ id_usuario: invited.id_usuario, invite_token: 'FICTITIOUS_EMAIL_INVITATION', estado_invitacion: 'pendiente' });
    const claim = await request('/api/auth/claim-invite', { invite_token: 'FICTITIOUS_EMAIL_INVITATION', email_usuario: 'claimed-email@example.invalid', password: 'FICTITIOUS_PASSWORD' });
    assert.equal(claim.status, 200); assert.equal(claim.body.signInRequired, true); assert(!claim.body.token);
    assert.equal(await models.AuthSession.count({ where: { user_id: invited.id_usuario } }), 0);
    assert.equal((await request('/api/auth/sign-in', { email: 'claimed-email@example.invalid', password: 'FICTITIOUS_PASSWORD' })).status, 202);
    report.checks.push('Actual HTTP signup and invitation claim issue no full session; the claimed account must complete password plus email login');
  } finally { agent.destroy(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }

  const cappedUser = await user(); const capped = await challenges.begin(cappedUser);
  for (let i = 0; i < 2; i++) { at = new Date(at.getTime() + 60000); await challenges.resend(capped.challengeToken); }
  at = new Date(at.getTime() + 60000);
  await assert.rejects(challenges.resend(capped.challengeToken), { code: 'auth_email_rate_limited' });
  await challenges.begin(cappedUser); at = new Date(at.getTime() + 60000); await challenges.begin(cappedUser);
  at = new Date(at.getTime() + 60000); await assert.rejects(challenges.begin(cappedUser), { code: 'auth_email_rate_limited' });
  const oldestCapped = await pendingRow(capped.challengeToken);
  await oldestCapped.update({ created_at: new Date(at.getTime() - 3601000), last_sent_at: new Date(at.getTime() - 3540000) });
  await assert.rejects(challenges.begin(cappedUser), { code: 'auth_email_rate_limited' });
  const absoluteUser = await user(); const absolute = await challenges.begin(absoluteUser);
  at = new Date(at.getTime() + 599000); await challenges.resend(absolute.challengeToken);
  assert.equal((await pendingRow(absolute.challengeToken)).expires_at.getTime(), (await pendingRow(absolute.challengeToken)).absolute_expires_at.getTime());
  at = new Date(at.getTime() + 1000);
  await assert.rejects(challenges.verify(absolute.challengeToken, codeFor(absoluteUser.id_usuario)), { code: 'auth_email_expired' });
  report.checks.push('Three sends per intent, five per rolling user hour and the original ten-minute password proof deadline remain enforced across fresh login attempts');

  const savedEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    models.PasswordResetToken = require('../../../models/passwordresettoken')(sql, D); await models.PasswordResetToken.sync();
    const recovered = await user(); const intent = await challenges.begin(recovered);
    const active = await challenges.verify(intent.challengeToken, codeFor(recovered.id_usuario));
    at = new Date(at.getTime() + 60000); const pending = await challenges.begin(recovered);
    const resetToken = 'FICTITIOUS_RESET_TOKEN';
    const resetRow = await models.PasswordResetToken.create({ user_id: recovered.id_usuario, token_hash: resetApi.tokenHash(resetToken),
      token_prefix: 'FICTITIOUS', email_hash: C.emailHash(recovered.email_usuario), expires_at: new Date(Date.now() + 600000) });
    const resetCreate = models.PlatformAuditEvent.create;
    models.PlatformAuditEvent.create = async () => { throw Error('FICTITIOUS_AUDIT_FAILURE'); };
    try { await assert.rejects(resetApi.consumePasswordResetToken({ token: resetToken, password: 'FICTITIOUS_NEW_PASSWORD' })); }
    finally { models.PlatformAuditEvent.create = resetCreate; }
    await resetRow.reload(); assert.equal(resetRow.status, 'pending'); await sessions.verify(active.token);
    const reset = await resetApi.consumePasswordResetToken({ token: resetToken, password: 'FICTITIOUS_NEW_PASSWORD' });
    assert(!reset.token); await assert.rejects(sessions.verify(active.token), /auth_invalid/);
    await assert.rejects(challenges.verify(pending.challengeToken, codeFor(recovered.id_usuario)), { code: 'auth_email_invalid' });
    await assert.rejects(resetApi.consumePasswordResetToken({ token: resetToken, password: 'FICTITIOUS_NEW_PASSWORD' }), { code: 'password_reset_token_invalid' });
    await recovered.reload(); at = new Date(at.getTime() + 60000);
    const again = await challenges.begin(recovered); assert(again.mfaRequired && !again.token);
    report.checks.push('Actual password reset is audited atomically, consumes its token once, invalidates existing sessions and pending email proofs, and still requires a fresh email login');

    const target = await user(); const previousHash = target.password_usuario; const previousEmail = target.email_usuario;
    const controller = require('../../controllers/user.controller');
    const before = await models.PlatformAuditEvent.count();
    for (const patch of [{ email_usuario: 'attacker@example.invalid', nombre: 'CHANGED' }, { password_usuario: 'NEW_PASSWORD', nombre: 'CHANGED' }]) {
      const response = { status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
      await controller.updateUser({ userDirectoryAccess: { mode: 'admin' }, userData: { userId: target.id_usuario }, params: { id: target.id_usuario }, body: patch }, response);
      assert.equal(response.statusCode, 409); assert.equal(response.body.error, 'auth_credentials_recovery_required');
      await target.reload(); assert.equal(target.email_usuario, previousEmail); assert.equal(target.password_usuario, previousHash); assert.notEqual(target.nombre, 'CHANGED');
    }
    assert.equal(await models.PlatformAuditEvent.count(), before + 2);
    report.checks.push('Actual generic user editor rejects mailbox/password replacement without partial profile changes and durably audits both attempts');
  } finally { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }

  await assert.rejects(migration.down(qi), /Preserve email verification history/);
  assert.equal((await qi.describeTable('AuthEmailChallenges')).challenge_id.primaryKey, true);
  report.checks.push('Populated rollback refuses to delete challenge/session verification history');
}).catch(error => {
  console.error(JSON.stringify({ success: false, error: error.message })); process.exitCode = 1;
});

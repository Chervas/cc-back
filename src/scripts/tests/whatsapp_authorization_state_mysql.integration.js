'use strict';
const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto'); const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const qi = sql.getQueryInterface();
  async function table(name, tableName, fields) { models[name] = sql.define(name, fields, { tableName, timestamps: false }); await models[name].sync(); }
  await table('Usuario', 'Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true }, password_usuario: D.STRING,
    email_usuario: D.STRING, estado_cuenta: D.STRING, es_provisional: D.BOOLEAN });
  await table('Clinica', 'Clinicas', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER });
  await table('UsuarioClinica', 'UsuariosClinicas', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
    id_usuario: D.INTEGER, id_clinica: D.INTEGER, rol_clinica: D.STRING, estado_invitacion: D.STRING });
  await table('MetaConnectionAssignment', 'MetaConnectionAssignments', { id: { type: D.INTEGER, primaryKey: true },
    scopeKey: D.STRING, status: D.STRING, metaConnectionId: D.INTEGER, authorizedByUserId: D.INTEGER });
  for (const file of ['20260912210000-create-platform-audit-events', '20260913003000-add-platform-audit-result-part',
    '20260912220000-create-auth-sessions', '20260913130000-create-auth-email-challenges', '20260913140000-create-meta-scope-blocks']) {
    await require('../../../migrations/' + file).up(qi, D);
  }
  const migration = require('../../../migrations/20260913150000-create-whatsapp-authorization-states');
  await migration.up(qi, D); await migration.down(qi, D); await migration.up(qi, D);
  for (const [name, file] of [['PlatformAuditEvent', 'platformauditevent'], ['AuthSession', 'authsession'],
    ['MetaScopeBlock', 'metascopeblock'], ['WhatsappAuthorizationState', 'whatsappauthorizationstate']]) models[name] = require('../../../models/' + file)(sql, D);
  const R = models.WhatsappAuthorizationState; const A = models.PlatformAuditEvent;
  let at = new Date(Math.floor(Date.now() / 1000) * 1000); const now = () => new Date(at);
  const advance = ms => { at = new Date(at.getTime() + ms); };
  const sessionsApi = require('../../services/accessSession.service');
  // The email-login suite validates delivery and one-use code verification.
  // Here seed fictitious durable proof to exercise the real session verifier.
  const config = () => ({ mode: 'enforce', emailMfaMode: 'off', ttl: 3600, secret: 'FICTITIOUS_JWT_KEY' });
  const sessions = sessionsApi.createService({ models, now, config });
  const repo = require('../../services/platformAudit.repository').createRepository(A);
  const keys = [];
  const make = (extra = {}) => require('../../services/whatsappAuthorizationState.service').createService({ models, sessions, now,
    config: () => { const key = Buffer.alloc(32, 7); keys.push(key); return { key }; }, ...extra });
  let service = make(); let nextUser = 501;
  await models.Clinica.bulkCreate([{ id_clinica: 71, grupoClinicaId: 9 }, { id_clinica: 72, grupoClinicaId: 9 },
    { id_clinica: 73, grupoClinicaId: null }]);
  async function actor({ method = 'password_email', ttl = 3600000 } = {}) {
    const userId = nextUser++;
    const user = await models.Usuario.create({ id_usuario: userId, password_usuario: 'FICTITIOUS_HASH', email_usuario: userId + '@example.invalid', estado_cuenta: 'activo', es_provisional: false });
    await models.UsuarioClinica.bulkCreate([71, 72, 73].map(id_clinica => ({ id_usuario: userId, id_clinica, rol_clinica: 'propietario', estado_invitacion: 'aceptada' })));
    const sessionRef = randomUUID(); const exp = now().getTime() + ttl;
    await models.AuthSession.create({ session_id: sessionRef, user_id: userId, issued_at: now(), expires_at: new Date(exp), absolute_expires_at: new Date(exp),
      credential_binding: sessions.credentialBinding(user), state: 'active', authentication_method: method,
      email_verified_at: method === 'password_email' ? now() : null, email_challenge_id: method === 'password_email' ? randomUUID() : null });
    return { userId, sessionRef, sessionExpiresAt: exp / 1000 };
  }
  const issue = (who, scope = { type: 'group', id: 9 }, api = service, requestId = randomUUID()) => api.issue({ ...who, requestId, scope });
  const inputFor = (who, flow) => ({ ...who, requestId: flow.requestId });
  const codeFor = flow => 'FICTITIOUS_OAUTH_CODE_' + flow.requestId;
  const claim = (who, flow, api = service) => api.claim({ ...inputFor(who, flow), state: flow.state, code: codeFor(flow) });
  const codeIs = code => e => e.code === code && e.message === code;
  const who = await actor(); const flow = await issue(who);
  assert.deepEqual(flow.clinicIds, [71, 72]); assert.equal(new Date(flow.expiresAt) - at, 600000);
  service = make(); assert.equal((await issue(who, flow.scope, service, flow.requestId)).state, flow.state);
  assert.equal(await A.count(), 1); assert.equal(await R.count(), 1);
  report.checks.push('Empty migration up/down/up; state and original scope survive service restart; idempotent issue adds no row or audit');
  await assert.rejects(issue(who, { type: 'clinic', id: 71 }, service, flow.requestId), codeIs('whatsapp_authorization_conflict'));
  const outsider = await actor(); await assert.rejects(claim(outsider, flow), codeIs('whatsapp_authorization_forbidden'));
  await assert.rejects(service.claim({ ...inputFor(who, flow), state: 'x'.repeat(43), code: 'FICTITIOUS_OAUTH_CODE' }), codeIs('whatsapp_authorization_invalid'));
  const concurrent = await Promise.allSettled([claim(who, flow), claim(who, flow)]);
  assert.equal(concurrent.filter(r => r.status === 'fulfilled' && r.value.mayExchange).length, 1);
  assert.equal(concurrent.find(r => r.status === 'rejected').reason.code, 'whatsapp_authorization_consumed');
  await assert.rejects(claim(who, flow, make()), codeIs('whatsapp_authorization_consumed'));
  assert.equal((await service.assertClaimActive(inputFor(who, flow))).status, 'claimed');
  assert.equal(await A.count(), 2);
  const secondFlow = await issue(outsider, { type: 'clinic', id: 73 });
  await assert.rejects(service.claim({ ...inputFor(outsider, secondFlow), state: secondFlow.state, code: codeFor(flow) }), codeIs('whatsapp_authorization_consumed'));
  assert.equal((await R.findByPk(secondFlow.requestId)).state, 'awaiting');
  report.checks.push('Foreign actor, changed scope and false state rejected; two concurrent claimants yield one winner; restart or another user/scope/state cannot exchange the same code again');
  const plain = await actor({ method: 'password' });
  await sessions.verifyReference({ userId: plain.userId, sessionRef: plain.sessionRef, expiresAt: new Date(plain.sessionExpiresAt * 1000) });
  await assert.rejects(issue(plain), codeIs('auth_invalid'));
  report.checks.push('WhatsApp explicitly requires email proof even when injected managed-session configuration allows password-only sessions');
  const rotating = make({ config: () => ({ key: Buffer.alloc(32, 8) }) });
  await assert.rejects(rotating.status(inputFor(who, flow)), codeIs('whatsapp_authorization_unavailable'));
  const row = await R.findByPk(flow.requestId); await row.update({ scope_digest: 'f'.repeat(64) });
  await assert.rejects(service.status(inputFor(who, flow)), codeIs('whatsapp_authorization_unavailable'));
  await row.update({ scope_digest: require('../../services/whatsappAuthorizationState.contract').digest(JSON.stringify({ scope: flow.scope, clinics: [{ id: 71, groupId: 9 }, { id: 72, groupId: 9 }] })) });
  report.checks.push('Key rotation and altered scope digest fail closed');
  const moveWho = await actor(); const moveFlow = await issue(moveWho, { type: 'clinic', id: 71 });
  await models.Clinica.update({ grupoClinicaId: 10 }, { where: { id_clinica: 71 } });
  await assert.rejects(claim(moveWho, moveFlow), codeIs('whatsapp_authorization_conflict'));
  await models.Clinica.update({ grupoClinicaId: 9 }, { where: { id_clinica: 71 } });
  const groupWho = await actor(); const groupFlow = await issue(groupWho);
  await models.Clinica.update({ grupoClinicaId: 9 }, { where: { id_clinica: 73 } });
  await assert.rejects(claim(groupWho, groupFlow), codeIs('whatsapp_authorization_conflict'));
  await models.Clinica.update({ grupoClinicaId: null }, { where: { id_clinica: 73 } });
  await models.UsuarioClinica.update({ rol_clinica: 'paciente' }, { where: { id_usuario: groupWho.userId, id_clinica: 72 } });
  await assert.rejects(claim(groupWho, groupFlow), codeIs('whatsapp_authorization_forbidden'));
  assert.equal((await service.cancel(inputFor(groupWho, groupFlow))).status, 'cancelled');
  report.checks.push('Clinic moving group, newly added group member and lost membership deny claim; cancellation remains possible after permission loss');
  await models.MetaScopeBlock.create({ scope_key: 'clinic:71', reason: 'scope_disconnected', created_at: now() });
  await assert.rejects(service.assertClaimActive(inputFor(who, flow)), codeIs('whatsapp_authorization_forbidden'));
  assert.equal((await service.cancel(inputFor(who, flow))).status, 'cancelled');
  const cancelAudit = await A.count(); await service.cancel(inputFor(who, flow)); assert.equal(await A.count(), cancelAudit);
  // Only the owned fixture removes its fictitious block to inspect tombstones.
  await models.MetaScopeBlock.destroy({ where: { scope_key: 'clinic:71' } });
  await assert.rejects(issue(who, flow.scope, service, flow.requestId), codeIs('whatsapp_authorization_cancelled'));
  report.checks.push('Durable clinic block prevents claimed-state revalidation; cancellation is durable and idempotent, and original request cannot be reused');
  for (const change of ['logout', 'password', 'email', 'suspended']) {
    const authWho = await actor(); const authFlow = await issue(authWho);
    if (change === 'logout') await models.AuthSession.update({ state: 'revoked' }, { where: { session_id: authWho.sessionRef } });
    else await models.Usuario.update(change === 'password' ? { password_usuario: 'CHANGED_FICTITIOUS_HASH' }
      : change === 'email' ? { email_usuario: 'changed@example.invalid' } : { estado_cuenta: 'suspendido' }, { where: { id_usuario: authWho.userId } });
    await assert.rejects(claim(authWho, authFlow), codeIs('auth_invalid'));
    assert.equal((await R.findByPk(authFlow.requestId)).state, 'awaiting');
  }
  report.checks.push('Logout, password/email changes and suspended account deny claim without consuming the state');
  const badAudit = make({ audit: { ...repo, append: async () => { throw Error('FICTITIOUS_AUDIT_SECRET'); } } });
  const failWho = await actor(); const failId = randomUUID();
  await assert.rejects(issue(failWho, flow.scope, badAudit, failId), codeIs('whatsapp_authorization_unavailable')); assert.equal(await R.findByPk(failId), null);
  const failFlow = await issue(failWho);
  await assert.rejects(claim(failWho, failFlow, badAudit), codeIs('whatsapp_authorization_unavailable'));
  assert.equal((await R.findByPk(failFlow.requestId)).state, 'awaiting');
  await assert.rejects(badAudit.cancel(inputFor(failWho, failFlow)), codeIs('whatsapp_authorization_unavailable'));
  assert.equal((await R.findByPk(failFlow.requestId)).state, 'awaiting');
  const backlog = make({ audit: { ...repo, health: async () => ({ pending: 10000, oldestAgeSeconds: 0 }) } });
  await assert.rejects(claim(failWho, failFlow, backlog), codeIs('whatsapp_authorization_unavailable'));
  report.checks.push('Audit outage or backlog prevents partial issuance, claim or cancellation; fixed errors contain no raw backend message');
  const shortWho = await actor({ ttl: 120000 }); const shortFlow = await issue(shortWho); assert.equal(new Date(shortFlow.expiresAt) - at, 120000);
  const expiryWho = await actor(); const expiryFlow = await issue(expiryWho); advance(600000);
  await assert.rejects(claim(expiryWho, expiryFlow), codeIs('whatsapp_authorization_expired'));
  assert.equal((await service.status(inputFor(expiryWho, expiryFlow))).status, 'expired');
  await assert.rejects(claim(shortWho, shortFlow), codeIs('auth_invalid'));
  report.checks.push('State lifetime is capped by original JWT expiry and ten minutes; status projects expiration without reissuing');
  const limitWho = await actor(); const limits = await Promise.allSettled(Array.from({ length: 6 }, () => issue(limitWho)));
  assert.equal(limits.filter(r => r.status === 'fulfilled').length, 5); assert.equal(limits.find(r => r.status === 'rejected').reason.code, 'whatsapp_authorization_limit');
  for (const result of limits.filter(r => r.status === 'fulfilled')) await service.cancel(inputFor(limitWho, result.value));
  for (let i = 0; i < 5; i++) { const f = await issue(limitWho); await service.cancel(inputFor(limitWho, f)); }
  await assert.rejects(issue(limitWho), codeIs('whatsapp_authorization_limit'));
  report.checks.push('Concurrent issuance enforces five active attempts per user; cancellation does not evade ten-per-hour limit');
  const historyId = flow.requestId;
  await models.UsuarioClinica.destroy({ where: { id_usuario: who.userId } }); await models.AuthSession.destroy({ where: { user_id: who.userId } });
  await models.Usuario.destroy({ where: { id_usuario: who.userId } }); assert.equal((await R.findByPk(historyId)).state, 'cancelled');
  await assert.rejects(migration.down(qi, D), /Preserve WhatsApp authorization states/);
  report.checks.push('Deletion of original user/session cannot cascade into authorization history; nonempty down refuses to erase evidence');
  const rows = await A.findAll({ raw: true }); const bodies = rows.map(r => r.body).join('\n');
  assert(!bodies.includes(flow.state)); assert(!bodies.includes('FICTITIOUS_OAUTH_CODE')); assert(!bodies.includes('FICTITIOUS_JWT_KEY'));
  assert(rows.every(r => JSON.parse(r.body).version === 15));
  const persisted = JSON.stringify(await R.findAll({ raw: true })); assert(!persisted.includes(flow.state)); assert(!persisted.includes('FICTITIOUS_OAUTH_CODE'));
  const { drain } = require('../../services/platformAudit.repository'); const { keyFor } = require('../../../services/platform-audit/src/event');
  // Keep the fixture clock ahead of the newest rows for durable ACKs.
  const delivered = await drain(repo, { write: async row => ({ key: keyFor(row), digest: row.digest, versionId: 'FICTITIOUS_V15' }) }, { now, limit: 100 });
  assert.equal(delivered.failed, 0); assert.equal(delivered.delivered, rows.length); assert.equal(delivered.pending, 0);
  assert(keys.every(key => key.every(byte => byte === 0)));
  report.checks.push('Only state/code digests persist; audit contains no code/state/secret; all v15 events drain with version receipts and state keys are wiped');
}).catch(error => { console.error(error); process.exitCode = 1; });

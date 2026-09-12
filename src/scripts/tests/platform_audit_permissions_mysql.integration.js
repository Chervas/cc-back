'use strict';
const assert = require('node:assert/strict'); const { randomUUID, randomBytes } = require('node:crypto');
const { DataTypes: D } = require('sequelize'); const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const cache = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  cache('dotenv', { config: () => ({}) });
  await require('../../../migrations/20260912210000-create-platform-audit-events').up(sql.getQueryInterface(), D);
  await require('../../../migrations/20260912230000-index-platform-audit-view').up(sql.getQueryInterface());
  await require('../../../migrations/20260211023000-create-access-policy-overrides').up(sql.getQueryInterface(), require('sequelize'));
  models.PlatformAuditEvent = require('../../../models/platformauditevent')(sql, D);
  models.AccessPolicyOverride = require('../../../models/accesspolicyoverride')(sql, D);
  // Minimal fictional domain tables; the outbox/override migrations and controller are actual code.
  models.GrupoClinica = sql.define('GrupoClinica', { id_grupo: { type: D.INTEGER, primaryKey: true }, nombre_grupo: D.STRING }, { tableName: 'GruposClinicas', timestamps: false });
  models.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, nombre_clinica: D.STRING,
    grupoClinicaId: { type: D.INTEGER, references: { model: 'GruposClinicas', key: 'id_grupo' } } }, { tableName: 'Clinicas', timestamps: false });
  models.Usuario = require('../../../models/usuario')(sql, D);
  models.UsuarioClinica = require('../../../models/usuarioclinica')(sql, D);
  models.PatientDirectionProfile = sql.define('PatientDirectionProfile', { user_id: { type: D.INTEGER, primaryKey: true }, is_active: D.BOOLEAN }, { timestamps: false });
  models.PatientDirectionSetting = sql.define('PatientDirectionSetting', { clinic_id: { type: D.INTEGER, primaryKey: true }, director_user_id: D.INTEGER, is_enabled: D.BOOLEAN }, { timestamps: false });
  for (const name of ['GrupoClinica', 'Clinica', 'Usuario', 'UsuarioClinica', 'PatientDirectionProfile', 'PatientDirectionSetting']) await models[name].sync();
  await models.GrupoClinica.create({ id_grupo: 51, nombre_grupo: 'FICTITIOUS_GROUP_NAME' });
  await models.Clinica.bulkCreate([{ id_clinica: 71, grupoClinicaId: 51, nombre_clinica: 'FICTITIOUS_CLINIC_ONE' }, { id_clinica: 72, grupoClinicaId: 51, nombre_clinica: 'FICTITIOUS_CLINIC_TWO' }]);
  const bcrypt = require('bcryptjs');
  for (const id_usuario of [1, 501, 502, 503]) await models.Usuario.create({ id_usuario, nombre: 'FICTITIOUS_PERSON_NAME', email_usuario: `fixture-${id_usuario}@example.invalid`, password_usuario: bcrypt.hashSync('FICTITIOUS_PASSWORD', 4) });
  await models.UsuarioClinica.bulkCreate([
    { id_usuario: 501, id_clinica: 71, rol_clinica: 'propietario' },
    { id_usuario: 502, id_clinica: 71, rol_clinica: 'propietario' }, { id_usuario: 502, id_clinica: 72, rol_clinica: 'propietario' },
    { id_usuario: 503, id_clinica: 71, rol_clinica: 'propietario', estado_invitacion: 'pendiente' },
  ]);
  const repo = require('../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const { pack, unpack, keyFor } = require('../../../services/platform-audit/src/event');
  const originalPermissions = require('../../services/platformAudit.permissions');
  let flag = 'true'; let clock = Date.parse('2026-09-12T20:00:00.000Z'); const now = () => new Date(clock += 10);
  const capture = originalPermissions.createCapture({ repository: repo, sequelize: sql, catalog: require('../../lib/access-policy').getAccessPolicyCatalog, enabled: () => flag, now });
  cache('../../services/platformAudit.permissions', { ...originalPermissions, ...capture });
  const controller = require('../../controllers/accessPolicy.controller');
  async function call(name, actorId, values = {}) {
    let status = 200; let body; const headers = {};
    const request = { userData: { userId: actorId }, authSession: { id: randomUUID() }, query: {}, body: {}, ...values };
    const response = { set(k, v) { headers[k] = v; }, status(v) { status = v; return this; }, json(v) { body = v; return this; } };
    await controller[name](request, response); return { status, body, headers };
  }
  const key = { scope_type: 'clinic', scope_id: 71, feature_key: 'patients.sensitive.view', role_code: 'doctor' };
  const change = (actorId, state, scope = key) => call('upsertOverride', actorId, { body: { ...scope, state } });
  const events = async () => (await models.PlatformAuditEvent.findAll({ raw: true })).map(row => unpack(row).event);
  const complete = async () => (await events()).filter(e => e.version === 4 && e.stage === 'completed');
  const created = await change(501, 'allow'); assert.equal(created.status, 200); assert(created.body.item.updated_at);
  let record = (await complete()).at(-1); assert.equal(record.previousEffect, 'inherit'); assert.equal(record.requestedEffect, 'allow');
  assert.equal(record.actor.id, '501'); assert.equal(record.authorizationBasis, 'scope_owner'); assert.equal(record.scopeClinicCount, 1);
  assert.equal(record.resultCount, 1); assert(keyFor(pack(record)).startsWith('app/platform/v4/'));
  assert.equal((await change(501, 'deny')).status, 200); assert.equal((await change(501, 'inherit')).status, 200);
  assert.equal(await models.AccessPolicyOverride.count(), 0);
  assert.equal((await change(501, 'inherit')).status, 200);
  record = (await complete()).find(e => e.reason === 'override_unchanged'); assert.equal(record.previousEffect, 'inherit'); assert.equal(record.resultCount, 0);
  report.checks.push('actual override/outbox migrations; allow/deny/inherit and no-change retain closed previous/requested values and owner authorization');

  const group = { ...key, scope_type: 'group', scope_id: 51 };
  assert.equal((await change(501, 'allow', group)).status, 403);
  assert.equal((await call('getAssignments', 501, { query: { scope_type: 'group', scope_id: '51' } })).status, 403);
  assert.equal((await change(503, 'allow')).status, 403);
  assert.equal((await change(1, 'allow', { ...key, scope_id: 999 })).status, 403);
  assert.equal((await change(502, 'allow', group)).status, 200);
  const inherited = await call('getOverrides', 501); assert.equal(inherited.status, 200); assert(inherited.body.items.some(item => item.scope_type === 'group'));
  const ownerAssignments = await call('getAssignments', 502, { query: { scope_type: 'group', scope_id: '51' } });
  assert.equal(ownerAssignments.status, 200); assert.equal(ownerAssignments.body.can_manage_scope, true);
  assert.equal((await call('getAssignments', 501, { query: { scope_type: 'clinic', scope_id: '71' } })).body.can_manage_scope, true);
  await models.UsuarioClinica.update({ rol_clinica: 'personaldeclinica' }, { where: { id_usuario: 502, id_clinica: 72 } });
  const mixed = await call('getAssignments', 502, { query: { scope_type: 'group', scope_id: '51' } });
  assert.equal(mixed.status, 200); assert.equal(mixed.body.can_manage_scope, false);
  await models.UsuarioClinica.update({ rol_clinica: 'propietario' }, { where: { id_usuario: 502, id_clinica: 72 } });
  assert.equal((await call('getCatalog', 501)).status, 200);
  report.checks.push('partial group owner cannot change group policy or list other-clinic assignments; full owner can; pending invitation denied and inherited policy remains readable');

  const initialCount = await models.AccessPolicyOverride.count(); const append = repo.append; let workCalls = 0;
  repo.append = async () => { throw Error('FICTITIOUS_OUTBOX_FAILURE'); };
  const findScope = models.GrupoClinica.findByPk;
  models.GrupoClinica.findByPk = async (...args) => { workCalls++; return findScope.apply(models.GrupoClinica, args); };
  assert.equal((await change(502, 'deny')).status, 503); assert.equal(workCalls, 0); repo.append = append; models.GrupoClinica.findByPk = findScope;
  repo.append = async (value, options) => { if (value.stage === 'completed') throw Error('FICTITIOUS_OUTBOX_FAILURE'); return append(value, options); };
  assert.equal((await change(502, 'allow')).status, 503);
  assert.equal(await models.AccessPolicyOverride.count(), initialCount);
  const failedRead = await call('getAssignments', 502, { query: { scope_type: 'group', scope_id: '51' } });
  assert.equal(failedRead.status, 503); assert(!JSON.stringify(failedRead).includes('FICTITIOUS_PERSON_NAME'));
  repo.append = append; assert((await repo.health(now())).unresolvedAttempts >= 2);
  report.checks.push('attempt failure prevents domain access; result failure rolls back policy write and never releases read payload; uncertainty remains observable');

  const beforeConcurrency = new Set((await events()).map(v => v.eventId));
  const parallel = await Promise.all([change(502, 'allow'), change(502, 'deny')]); assert.deepEqual(parallel.map(v => v.status), [200, 200]);
  const chain = (await complete()).filter(v => !beforeConcurrency.has(v.eventId)); assert.equal(chain.length, 2);
  const first = chain.find(v => v.previousEffect === 'inherit'); assert(first);
  const second = chain.find(v => v.eventId !== first.eventId); assert.equal(second.previousEffect, first.requestedEffect);
  assert.equal((await models.AccessPolicyOverride.findOne({ where: key })).effect, second.requestedEffect);
  report.checks.push('concurrent writes to the same scope serialize and preserve a correct previous/next audit chain');

  const held = await sql.transaction(); await models.GrupoClinica.findByPk(51, { transaction: held, lock: held.LOCK.UPDATE });
  let observed; const waiting = new Promise(resolve => { observed = resolve; });
  models.GrupoClinica.findByPk = async (...args) => { if (args[1]?.lock) observed(); return findScope.apply(models.GrupoClinica, args); };
  const racing = change(501, 'allow');
  try { await waiting; await models.UsuarioClinica.update({ estado_invitacion: 'cancelada' }, { where: { id_usuario: 501, id_clinica: 71 }, transaction: held }); await held.commit(); }
  finally { models.GrupoClinica.findByPk = findScope; if (!held.finished) await held.rollback(); }
  assert.equal((await racing).status, 403);
  await models.UsuarioClinica.update({ estado_invitacion: 'aceptada' }, { where: { id_usuario: 501, id_clinica: 71 } });
  report.checks.push('ownership revoked while the writer waits for the scope lock is reread and denied before mutation');

  const malformed = [ { ...key, scope_id: -1 }, { ...key, scope_id: 1.2 }, { ...key, scope_id: true }, { ...key, scope_id: ['71'] },
    { ...key, feature_key: 'FICTITIOUS_SENTINEL_SECRET' }, { ...key, state: 'allow', effect: 'deny' }, { ...key, jwt: 'FICTITIOUS_SENTINEL_SECRET' } ];
  for (const body of malformed) assert.equal((await call('upsertOverride', 1, { body })).status, 400);
  const serialized = JSON.stringify(await events());
  for (const forbidden of ['FICTITIOUS_SENTINEL_SECRET', 'FICTITIOUS_PERSON_NAME', 'example.invalid', 'FICTITIOUS_PASSWORD']) assert(!serialized.includes(forbidden));
  report.checks.push('invalid IDs, conflicting effects and extra fields are denied without raw query, user data, passwords or secrets in audit');

  const baselineEvents = await models.PlatformAuditEvent.count(); flag = 'false';
  const health = repo.health; repo.health = async () => assert.fail('disabled capture must not inspect outbox');
  assert.equal((await change(501, 'deny', group)).status, 403); assert.equal((await change(502, 'allow')).status, 200);
  assert.equal((await call('getCatalog', 501)).status, 200); assert.equal(await models.PlatformAuditEvent.count(), baselineEvents);
  flag = 'typo'; assert.equal((await change(502, 'deny')).status, 503); flag = 'true'; repo.health = health;
  report.checks.push('capture disabled uses no outbox and retains scope enforcement/transactional writes; invalid configuration fails closed');

  await require('../../../migrations/20260912220000-create-auth-sessions').up(sql.getQueryInterface(), D);
  models.AuthSession = require('../../../models/authsession')(sql, D);
  const sessionsApi = require('../../services/accessSession.service');
  const sessions = sessionsApi.createService({ models, audit: repo, now, config: () => ({ mode: 'enforce', ttl: 300, secret: 'FICTITIOUS_HTTP_KEY' }) });
  const token = (await sessions.authenticated(await models.Usuario.findByPk(1))).body.token;
  cache('../../services/accessSession.service', { ...sessionsApi, ...sessions });
  const http = require('node:http'); const app = require('express')(); app.use(require('express').json()); app.use('/api/access-policies', require('../../routes/access-policy.routes'));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent(); agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
  const request = bearer => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, agent, path: '/api/access-policies/assignments?scope_type=group&scope_id=51', headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }, res => {
      const chunks = []; res.on('data', v => chunks.push(v)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)), cache: res.headers['cache-control'] }));
    }).on('error', reject);
  });
  try { assert.equal((await request()).status, 401); const result = await request(token); assert.equal(result.status, 200); assert.equal(result.cache, 'private, no-store');
    await sessions.revoke(token); assert.equal((await request(token)).status, 401);
  } finally { agent.destroy(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  report.checks.push('actual HTTP route plus managed JWT rejects anonymous/revoked sessions and sends private successful assignment responses');

  const { createWriter, KEY_ARN } = require('../../../services/platform-audit/src/s3'); const objects = new Map(); let n = 0;
  const writer = createWriter({ send: async c => { const o = { Body: c.input.Body, ContentLength: Buffer.byteLength(c.input.Body), ContentType: 'application/json',
    ChecksumSHA256: c.input.ChecksumSHA256, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN, VersionId: 'fixture-' + (++n) }; objects.set(c.input.Key, o); return o; } });
  for (;;) { const row = await repo.claim(now()); if (!row) break; await repo.acknowledge(row, await writer.write(row), now()); }
  const { readBatch } = require('../../../services/platform-audit/src/reader'); const { signRequest } = require('../../../services/platform-audit/src/reader-protocol');
  const keys = require('node:crypto').generateKeyPairSync('ed25519');
  const reader = { read: command => readBatch(signRequest(command, { keyId: 'fixture', privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }).input,
    { send: async c => { const o = objects.get(c.input.Key); assert.equal(o.VersionId, c.input.VersionId); return { ...o, Body: require('node:stream').Readable.from([o.Body]) }; } }) };
  const view = require('../../services/platformAudit.view').createView({ model: models.PlatformAuditEvent, audit: repo, reader,
    codec: require('../../../services/platform-audit/src/view-contract').cursorCodec(randomBytes(32)), now });
  const viewed = await view.read({ actorId: 1, sessionRef: randomUUID(), query: { from: '2026-09-12', to: '2026-09-12', action: 'permission.override.change' } });
  assert(viewed.events.length); assert(viewed.events.every(e => e.permission && e.verification === 's3_version_verified'));
  assert(viewed.events.some(e => e.permission.previousEffect)); assert(!JSON.stringify(viewed).includes('FICTITIOUS_PERSON_NAME'));
  report.checks.push('actual v4 codec, writer and version reader feed projected permission transitions into the audit viewer with no personal payload');
}).catch(() => { process.exitCode = 1; });

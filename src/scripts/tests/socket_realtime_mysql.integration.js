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
  models.PatientDirectionProfile.hasMany(models.PatientDirectionSetting, { as: 'clinicSettings', foreignKey: 'director_user_id', sourceKey: 'user_id', constraints: false });
  await require('../../../migrations/20260912220000-create-auth-sessions').up(sql.getQueryInterface(), D);
  models.AuthSession = require('../../../models/authsession')(sql, D);
  // Only scope metadata is needed. No production clinical rows, jobs, Redis or providers.
  models.Conversation = sql.define('Conversation', { id: { type: D.INTEGER, primaryKey: true }, clinic_id: D.INTEGER, patient_id: D.INTEGER, channel: D.STRING }, { timestamps: false });
  models.LeadIntake = sql.define('LeadIntake', { id: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, grupo_clinica_id: D.INTEGER }, { timestamps: false });
  models.FlowExecutionV2 = sql.define('FlowExecutionV2', { id: { type: D.INTEGER, primaryKey: true }, clinic_id: D.INTEGER, group_id: D.INTEGER }, { timestamps: false });
  models.CitaPaciente = sql.define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, paciente_id: D.INTEGER, lead_intake_id: D.INTEGER }, { timestamps: false });
  models.Notification = require('../../../models/notification')(sql, D);
  for (const name of ['Conversation', 'LeadIntake', 'FlowExecutionV2', 'CitaPaciente', 'Notification']) await models[name].sync();
  await models.Conversation.bulkCreate([{ id: 91, clinic_id: 71, channel: 'whatsapp', patient_id: 801 }, { id: 92, clinic_id: 71, channel: 'whatsapp', patient_id: null }, { id: 93, clinic_id: 72, channel: 'internal' }]);
  await models.LeadIntake.create({ id: 94, grupo_clinica_id: 51 });
  await models.FlowExecutionV2.create({ id: 95, clinic_id: 71 });
  await models.Notification.bulkCreate([{ id: 96, userId: 501, category: 'crm', event: 'fictitious', clinicaId: 71, data: { quickChatConversationId: 91 } }, { id: 97, userId: 502, category: 'system', event: 'fictitious' }]);
  const api = require('../../services/accessSession.service');
  const env = { JWT_SECRET: randomBytes(32).toString('hex'), AUTH_SESSION_MODE: 'enforce', AUTH_ACCESS_TOKEN_TTL_SECONDS: '300', PLATFORM_AUDIT_AUTH_ENABLED: 'true', PLATFORM_AUDIT_AUTH_POLICY: 'auth-durable-v1' };
  const sessions = api.createService({ models, audit: repo, config: () => api.settings(env) });
  const issued = await sql.transaction(async transaction => sessions.issue(await models.Usuario.findByPk(501, { transaction, lock: transaction.LOCK.UPDATE }), { transaction }));
  const policy = require('../../services/socketAccess.service').createPolicy({ models, canAccess: require('../../lib/access-policy').canUserAccessFeature, isAdmin: id => id === 1 });
  const { packetFor } = require('../../lib/socket-payload');
  const patient = packetFor('message:created', { id: 2001, conversation_id: 91, content: 'FICTITIOUS_CLINICAL_MESSAGE' });
  let descriptor = await policy.resolve(patient); assert(await policy.authorize(501, descriptor)); assert(!await policy.authorize(503, descriptor));
  assert.equal((await policy.subscription(503, [71])).allowed, false); assert.equal((await policy.subscription(501, [999])).allowed, false);
  for (const bad of [null, '71', [true], [-1], ['71.0'], Array(101).fill(71)]) assert.equal((await policy.subscription(501, bad)).invalid, true);
  report.checks.push('real SQL membership/invitation filtering; closed subscription IDs; no denied-selection fallback');
  await models.AccessPolicyOverride.create({ scope_type: 'clinic', scope_id: 71, feature_key: 'quickchat.read_leads', role_code: 'propietario', effect: 'deny', updated_by: 1 });
  assert(await policy.authorize(501, descriptor));
  const leadChat = await policy.resolve(packetFor('message:created', { id: 2002, conversation_id: 92 }));
  assert(!await policy.authorize(501, leadChat));
  assert.equal(await policy.resolve(packetFor('message:created', { id: 2001, conversation_id: 999 })), null);
  assert.equal(await policy.resolve(packetFor('lead:created', { lead_id: 94, clinic_id: 999 })), null);
  report.checks.push('same clinic does not merge patient and lead grants; missing resources and mismatched scope hints fail closed');
  const group = await policy.resolve(packetFor('lead:created', { lead_id: 94 }));
  assert(!await policy.authorize(501, group));
  await models.AccessPolicyOverride.destroy({ where: {} }); assert(await policy.authorize(502, group)); assert(!await policy.authorize(501, group));
  const notification = await policy.resolve(packetFor('notification:created', { id: 96 }));
  assert(await policy.authorize(501, notification)); assert(!await policy.authorize(502, notification));
  const deleted = packetFor('appointment:deleted', { appointment_id: 98, clinic_id: 71, patient_id: 801, estado: 'FICTITIOUS' });
  assert(await policy.resolve(deleted)); assert.deepEqual(deleted.body, { appointment_id: 98, clinic_id: 71 });
  report.checks.push('group events require permissions in every current clinic; notification ownership and conversation scope checked; deleted appointment reduced to invalidation');
  const http = require('node:http'); const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent(); agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
  const { Server } = require('socket.io'); const io = new Server(server); let client;
  require('../../lib/socket-session-guard').installSocketSessionGuard(io, sessions, { intervalMs: 100, timeoutMs: 1000 });
  let failCompleted = false;
  const audit = require('../../services/platformAudit.realtime').createCapture({ repository: { ...repo, append: async v => {
    if (failCompleted && v.action === 'realtime.read' && v.stage === 'completed') throw Error('FICTITIOUS_OUTBOX_FAILURE'); return repo.append(v);
  } }, enabled: () => 'true' });
  const guard = require('../../lib/socket-realtime-guard').installRealtimeAccess(io, { policy, audit, timeoutMs: 3000 });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function idle() { const until = Date.now() + 5000; while (guard.pending()) { if (Date.now() > until) throw Error('realtime fixture deadline'); await delay(5); } await delay(20); }
  async function connect() {
    client = require('/home/ubuntu/wt/front-dev/node_modules/socket.io-client').io(`http://127.0.0.1:${server.address().port}`, {
      auth: { token: issued.token }, transports: ['websocket'], agent, reconnection: false, forceNew: true });
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); }); await idle();
  }
  try {
    await connect(); const received = []; client.on('message:created', v => received.push(v));
    assert.deepEqual(await client.timeout(3000).emitWithAck('subscribe', [71]), { status: 'ready', clinicIds: [71] });
    guard.deliver('message:created', { ...patient.body, metadata: { provider_token: 'FICTITIOUS_PROVIDER_SECRET' } }, ['clinic:71', 'user:501']); await idle();
    assert.equal(received.length, 1); assert(!JSON.stringify(received).includes('FICTITIOUS_PROVIDER_SECRET'));
    await models.AccessPolicyOverride.create({ scope_type: 'clinic', scope_id: 71, feature_key: 'patients.sensitive.view', role_code: 'propietario', effect: 'deny', updated_by: 1 });
    for (const rooms of [['clinic:71'], ['user:501'], []]) guard.deliver('message:created', patient.body, rooms);
    await idle(); assert.equal(received.length, 1); assert(client.connected);
    await models.AccessPolicyOverride.destroy({ where: {} });
    await models.UsuarioClinica.update({ estado_invitacion: 'cancelada' }, { where: { id_usuario: 501, id_clinica: 71 } });
    guard.deliver('message:created', patient.body, ['clinic:71']); await idle(); assert.equal(received.length, 1);
    assert.deepEqual(await client.timeout(3000).emitWithAck('subscribe', [71]), { status: 'denied', clinicIds: [] });
    await models.UsuarioClinica.update({ estado_invitacion: 'aceptada' }, { where: { id_usuario: 501, id_clinica: 71 } });
    await client.timeout(3000).emitWithAck('subscribe', [71]);
    report.checks.push('actual Socket.IO/managed JWT/outbox: open connection immediately respects SQL policy and membership revocation across clinic/user/broadcast destinations');
    failCompleted = true; guard.deliver('message:created', patient.body, ['clinic:71']); await idle();
    assert.equal(received.length, 1); assert.equal(client.connected, false); failCompleted = false;
    assert((await repo.health(new Date())).unresolvedAttempts >= 1);
    await connect(); await sessions.revoke(issued.token); guard.deliver('message:created', patient.body, ['user:501']); await idle();
    assert.equal(client.connected, false);
    report.checks.push('failed durable result disconnects without releasing clinical payload; managed session revocation also blocks outbound traffic');
  } finally {
    client?.disconnect(); agent.destroy(); await new Promise(resolve => io.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  const events = (await models.PlatformAuditEvent.findAll({ raw: true })).map(row => unpack(row).event);
  const v5 = events.filter(v => v.version === 5); assert(v5.length > 10);
  for (const row of v5) { assert(keyFor(pack(row)).startsWith('app/platform/v5/')); for (const forbidden of ['FICTITIOUS_CLINICAL_MESSAGE', 'FICTITIOUS_PROVIDER_SECRET', 'FICTITIOUS_OUTBOX_FAILURE', 'example.invalid']) assert(!JSON.stringify(row).includes(forbidden)); }
  assert(v5.some(v => v.reason === 'packet_prepared' && v.scope.id === '71' && v.actor.id === '501'));
  report.checks.push('actual outbox stores canonical v5 actor/session/resource/scope without message content, provider secrets or raw errors');
  const { createWriter, KEY_ARN } = require('../../../services/platform-audit/src/s3'); const objects = new Map(); let sequence = 0;
  const writer = createWriter({ send: async c => { const value = { Body: c.input.Body, ContentLength: Buffer.byteLength(c.input.Body), ContentType: 'application/json',
    ChecksumSHA256: c.input.ChecksumSHA256, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN, VersionId: 'fictitious-' + (++sequence) }; objects.set(c.input.Key, value); return value; } });
  for (;;) { const row = await repo.claim(new Date()); if (!row) break; await repo.acknowledge(row, await writer.write(row), new Date()); }
  const { readBatch } = require('../../../services/platform-audit/src/reader'); const { signRequest } = require('../../../services/platform-audit/src/reader-protocol');
  const keys = require('node:crypto').generateKeyPairSync('ed25519');
  const reader = { read: command => readBatch(signRequest(command, { keyId: 'fixture', privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }).input,
    { send: async c => { const value = objects.get(c.input.Key); assert.equal(value.VersionId, c.input.VersionId); return { ...value, Body: require('node:stream').Readable.from([value.Body]) }; } }) };
  const view = require('../../services/platformAudit.view').createView({ model: models.PlatformAuditEvent, audit: repo, reader,
    codec: require('../../../services/platform-audit/src/view-contract').cursorCodec(randomBytes(32)), now: () => new Date() });
  const date = new Date().toISOString().slice(0, 10);
  const viewed = await view.read({ actorId: 1, sessionRef: randomUUID(), query: { from: date, to: date, action: 'realtime.read' } });
  assert(viewed.events.length); assert(viewed.events.every(e => e.realtime && e.verification === 's3_version_verified'));
  assert(viewed.events.some(e => e.realtime.resourceId === '91')); assert(!JSON.stringify(viewed).includes('FICTITIOUS_CLINICAL_MESSAGE'));
  report.checks.push('v5 travels through actual SQL claims/ACK, writer, version reader and projected audit-view query using fictitious S3 only');
}).catch(error => { console.error(error); process.exitCode = 1; });

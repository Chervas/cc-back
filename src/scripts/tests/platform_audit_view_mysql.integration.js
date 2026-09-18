'use strict';
const assert = require('node:assert/strict'); const { randomUUID, randomBytes } = require('node:crypto');
const { Readable } = require('node:stream'); const { DataTypes } = require('sequelize'); const bcrypt = require('bcryptjs');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { fixture } = require('../../../services/platform-audit/test/fixture.cjs');
const { createWriter, KEY_ARN } = require('../../../services/platform-audit/src/s3');
const { signRequest } = require('../../../services/platform-audit/src/reader-protocol');
const { readBatch } = require('../../../services/platform-audit/src/reader');
const { cursorCodec } = require('../../../services/platform-audit/src/view-contract');
const { pack, keyFor } = require('../../../services/platform-audit/src/event');
const cache = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  cache('dotenv', { config: () => ({}) });
  await require('../../../migrations/20260912210000-create-platform-audit-events').up(sql.getQueryInterface(), DataTypes);
  await require('../../../migrations/20260913003000-add-platform-audit-result-part').up(sql.getQueryInterface());
  const index = require('../../../migrations/20260912230000-index-platform-audit-view'); await index.up(sql.getQueryInterface());
  models.PlatformAuditEvent = require('../../../models/platformauditevent')(sql, DataTypes);
  const repo = require('../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const { createView } = require('../../services/platformAudit.view');
  const objects = new Map(); let writes = 0; let gets = 0; let at = new Date('2026-09-12T12:00:00.900Z'); const now = () => at;
  const writer = createWriter({ send: async command => {
    assert.equal(command.constructor.name, 'PutObjectCommand'); const version = 'fixture-' + (++writes);
    const object = { Body: command.input.Body, ContentLength: Buffer.byteLength(command.input.Body), ContentType: 'application/json',
      ChecksumSHA256: command.input.ChecksumSHA256, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN, VersionId: version };
    objects.set(command.input.Key + '@' + version, object); objects.set(command.input.Key, object); return object;
  } });
  const { privateKey } = require('node:crypto').generateKeyPairSync('ed25519');
  const reader = { read: command => {
    const input = signRequest(command, { keyId: 'fixture', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }).input;
    return readBatch(input, { send: async command => {
      gets++; assert.equal(command.constructor.name, 'GetObjectCommand');
      const object = objects.get(command.input.Key + (command.input.VersionId ? '@' + command.input.VersionId : ''));
      if (!object) throw Error('FICTITIOUS_VERSION_MISSING'); return { ...object, Body: Readable.from([object.Body]) };
    } });
  } };
  const sessionRef = randomUUID(); const criteria = { from: '2026-09-12', to: '2026-09-12' };
  const codec = cursorCodec(randomBytes(32)); const view = createView({ model: models.PlatformAuditEvent, audit: repo, reader, codec, now });
  for (let i = 0; i < 52; i++) {
    const e = fixture({ occurredAt: new Date(at.getTime() - (1000 + i * 5)).toISOString(), actor: { type: 'user', id: i % 2 ? '123' : '456' } });
    await repo.append(e); const row = await repo.claim(at); await repo.acknowledge(row, await writer.write(row), at);
  }
  const first = await view.read({ actorId: 1, sessionRef, query: criteria }); assert.equal(first.events.length, 25); assert(first.nextCursor);
  assert(first.events.every(v => v.verification === 's3_version_verified')); assert.equal(gets, 25);
  const reads = (await models.PlatformAuditEvent.findAll({ raw: true })).map(row => JSON.parse(row.body)).filter(v => v.version === 3);
  assert.equal(reads.length, 2); assert.equal(reads[0].correlationId, reads[1].correlationId);
  assert.equal(reads.find(v => v.stage === 'attempted').resultCount, null);
  assert.equal(reads.find(v => v.stage === 'completed').resultCount, 25);
  assert(!JSON.stringify(first).includes('127.0.0.1')); assert(!JSON.stringify(first).includes('receipt'));
  report.checks.push('real SQL migration/index, exact S3 versions and durable attempted/completed viewer audit before releasing projected data');
  at = new Date(at.getTime() + 60000);
  const late = await repo.append(fixture({ occurredAt: '2026-09-12T11:59:20.500Z' }));
  const lateModel = await models.PlatformAuditEvent.findByPk(late.event.eventId);
  await lateModel.update({ state: 'delivered', receipt: await writer.write(late), delivered_at: at });
  const second = await view.read({ actorId: 1, sessionRef, query: { ...criteria, cursor: first.nextCursor } }); assert.equal(second.events.length, 25);
  const third = await view.read({ actorId: 1, sessionRef, query: { ...criteria, cursor: second.nextCursor } }); assert.equal(third.events.length, 2); assert.equal(third.nextCursor, null);
  const ids = [...first.events, ...second.events, ...third.events].map(v => v.eventId); assert.equal(new Set(ids).size, 52); assert(!ids.includes(late.event.eventId));
  report.checks.push('millisecond snapshots and 52 events in one second paginate 25/25/2 without loss or duplicates; later delivery stays excluded');
  const filtered = await view.read({ actorId: 44, sessionRef, query: { ...criteria, userId: '456', action: 'auth.sign_in' } });
  assert(filtered.events.every(v => v.actorId === '456')); assert.equal(filtered.events.length, 25);
  const beforeDenied = gets;
  await assert.rejects(view.read({ actorId: 701, sessionRef, query: criteria }), /technical_admin_required/);
  await assert.rejects(view.read({ actorId: 1, sessionRef: null, query: criteria }), /managed_session_required/);
  await assert.rejects(view.read({ actorId: 44, sessionRef, query: { ...criteria, cursor: first.nextCursor } }), /audit_query_invalid/);
  await assert.rejects(view.read({ actorId: 1, sessionRef, query: { ...criteria, endpoint: 'SENTINEL_SECRET' } }), /audit_query_invalid/);
  assert.equal(gets, beforeDenied);
  const denials = (await models.PlatformAuditEvent.findAll({ raw: true })).map(row => JSON.parse(row.body)).filter(v => v.outcome === 'denied');
  assert.equal(denials.length, 4); assert(denials.every(v => v.criteria === null)); assert(!JSON.stringify(denials).includes('SENTINEL'));
  report.checks.push('actor/action filters and session-bound cursor; denied access and malformed queries are audited without data reads or raw input');
  const whatsapp = await repo.append({ version: 15, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: at.toISOString(),
    action: 'integration.whatsapp.authorization_state', stage: 'completed', outcome: 'success', reason: 'state_claimed',
    actor: { type: 'user', id: '123' }, scope: { type: 'clinic', id: '71' }, sessionRef,
    requestRef: randomUUID(), capturePolicy: 'whatsapp-onboarding-v1' });
  await models.PlatformAuditEvent.update({ state: 'delivered', receipt: await writer.write(whatsapp), delivered_at: at },
    { where: { event_id: whatsapp.event.eventId } });
  const whatsappPage = await view.read({ actorId: 1, sessionRef, query: { ...criteria, action: 'integration.whatsapp.authorization_state' } });
  assert.equal(whatsappPage.events.length, 1);
  assert.equal(whatsappPage.events[0].correlationId, whatsapp.event.correlationId);
  assert.deepEqual(whatsappPage.events[0].whatsappAuthorization, { requestRef: whatsapp.event.requestRef });
  assert.equal(whatsappPage.events[0].reason, 'state_claimed');
  assert(!Object.hasOwn(whatsappPage.events[0], 'receipt'));
  report.checks.push('WhatsApp authorization audit is filterable and exposes verified correlation/request references without claiming operational activation');
  const { fromEnrollment, PHASES } = require('../../../services/platform-audit/src/google-ads-enrollment-event');
  const enrollment = { enrollment_id: randomUUID(), scope_key: 'group:5', actor_user_id: 9, session_ref: sessionRef,
    connection_ref: 'google:fixture', customer_id: '1234567890', mapping_id: 11, clinic_count: 2, clinic_digest: 'a'.repeat(64) };
  for (const reason of Object.keys(PHASES)) {
    const saved = await repo.append(fromEnrollment(enrollment, reason, { now: at,
      ...(reason === 'enrollment_cancel_requested' ? { cause: 'scope_disconnected', actorId: 55, sessionRef } : {}) }));
    await models.PlatformAuditEvent.update({ state: 'delivered', receipt: await writer.write(saved), delivered_at: at },
      { where: { event_id: saved.event.eventId } });
  }
  const enrollmentPage = await view.read({ actorId: 1, sessionRef, query: { ...criteria, action: 'integration.asset.enrollment' } });
  assert.equal(enrollmentPage.events.length, 4);
  assert.deepEqual(enrollmentPage.events.map(row => row.reason).sort(), Object.keys(PHASES).sort());
  assert.ok(enrollmentPage.events.every(row => row.adsEnrollment.requestRef === enrollment.enrollment_id
    && row.adsEnrollment.clinicCount === 2 && row.adsEnrollment.assetRef === 'ads:1234567890' && row.verification === 's3_version_verified'));
  assert.equal(enrollmentPage.events.find(row => row.reason === 'enrollment_cancel_requested').actorId, '55');
  assert.equal(enrollmentPage.events.find(row => row.reason === 'enrollment_broker_confirmed').actorType, 'job');
  report.checks.push('four enrollment audit phases share one request with distinct SQL parts; verified DTO keeps human/job attribution, pending mapping and confirmed cancellation separate');
  const broken = await models.PlatformAuditEvent.findByPk(first.events[0].eventId); const goodReceipt = broken.receipt;
  await broken.update({ receipt: { ...goodReceipt, versionId: 'missing-version' } });
  await assert.rejects(view.read({ actorId: 1, sessionRef, query: criteria }), /audit_view_unavailable/);
  await broken.update({ receipt: goodReceipt });
  report.checks.push('missing S3 version fails the entire page without returning a cached/local fallback');
  const append = repo.append; let attempted = false;
  repo.append = async value => { if (value.version === 3 && value.stage === 'completed') throw Error('FICTITIOUS_OUTBOX_DOWN'); attempted = true; return append(value); };
  await assert.rejects(view.read({ actorId: 1, sessionRef, query: criteria }), /audit_view_unavailable/); assert(attempted);
  repo.append = append; assert((await repo.health(at)).unresolvedAttempts >= 1);
  const unavailable = createView({ model: models.PlatformAuditEvent, audit: { ...repo, append: async () => { throw Error('FICTITIOUS'); } }, reader, codec, now });
  const before = gets; await assert.rejects(unavailable.read({ actorId: 1, sessionRef, query: criteria }), /audit_view_unavailable/); assert.equal(gets, before);
  report.checks.push('failed attempt capture prevents all external reads; failed result capture releases no records and remains observable as unresolved');
  const uncertain = await repo.append(fixture({ occurredAt: at.toISOString() })); await writer.write(uncertain);
  await models.PlatformAuditEvent.update({ state: 'reconcile', next_attempt_at: at }, { where: { event_id: uncertain.event.eventId } });
  const { createReconciliation } = require('../../services/platformAudit.reconciliation');
  const reconciliation = () => createReconciliation({ repository: repo, reader, now });
  const result = await Promise.all([reconciliation().run(), reconciliation().run()]);
  assert.equal(result.reduce((n, v) => n + v.reconciled, 0), 1);
  assert.equal((await models.PlatformAuditEvent.findByPk(uncertain.event.eventId)).state, 'delivered');
  report.checks.push('concurrent reconciliation workers recover one lost ACK using receipts only and the original outbox lease');
  // Actual HTTP route and central JWT verifier with managed sessions in the owned database.
  models.Usuario = require('../../../models/usuario')(sql, DataTypes); await models.Usuario.sync();
  await require('../../../migrations/20260912220000-create-auth-sessions').up(sql.getQueryInterface(), DataTypes);
  await require('../../../migrations/20260913130000-create-auth-email-challenges').up(sql.getQueryInterface(), DataTypes);
  await require('../../../migrations/20260914220000-create-auth-trusted-devices').up(sql.getQueryInterface(), DataTypes);
  models.AuthSession = require('../../../models/authsession')(sql, DataTypes);
  models.AuthTrustedDevice = require('../../../models/authtrusteddevice')(sql, DataTypes);
  const user = await models.Usuario.create({ id_usuario: 1, nombre: 'Fictitious admin', email_usuario: 'fixture@example.invalid', password_usuario: bcrypt.hashSync('FICTITIOUS_PASSWORD', 4) });
  const api = require('../../services/accessSession.service'); const sessions = api.createService({ models, audit: repo, now,
    config: () => ({ mode: 'enforce', ttl: 300, secret: 'FICTITIOUS_HTTP_KEY' }) });
  const token = (await sessions.authenticated(user)).body.token;
  cache('../../services/accessSession.service', { ...api, ...sessions });
  cache('../../services/platformAudit.view', view);
  cache('../../controllers/systemMonitoring.controller', new Proxy({}, { get: () => () => assert.fail('unrelated monitoring operation') }));
  const http = require('node:http'); const express = require('express'); const app = express(); app.use('/api/system-monitoring', require('../../routes/system-monitoring.routes'));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent(); agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
  const request = bearer => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, agent, path: '/api/system-monitoring/audit/events?from=2026-09-12&to=2026-09-12',
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }, res => { const chunks = []; res.on('data', v => chunks.push(v));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), cache: res.headers['cache-control'] })); }).on('error', reject);
  });
  try {
    assert.equal((await request()).status, 401); const page = await request(token); assert.equal(page.status, 200); assert.equal(page.cache, 'private, no-store');
    await sessions.revoke(token); assert.equal((await request(token)).status, 401);
  } finally { agent.destroy(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  report.checks.push('actual private HTTP viewer rejects anonymous/revoked sessions and returns verified projected records to a managed technical administrator');
  const count = await models.PlatformAuditEvent.count(); await index.down(sql.getQueryInterface()); assert.equal(await models.PlatformAuditEvent.count(), count);
  await index.up(sql.getQueryInterface()); for (const row of await models.PlatformAuditEvent.findAll({ raw: true })) pack(JSON.parse(row.body));
  report.checks.push('index rollback/reapply preserves all evidence and every auth/session/view event retains its closed schema');
}).catch(() => { process.exitCode = 1; });

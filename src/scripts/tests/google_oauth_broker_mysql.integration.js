'use strict';
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  models.GoogleAdsBrokerBinding = require('../../../models/googleadsbrokerbinding')(sql, D);
  await models.GoogleAdsBrokerBinding.sync();
  const qi = sql.getQueryInterface();
  function table(name, tableName, fields) {
    models[name] = sql.define(name, fields, { tableName, timestamps: false }); return models[name];
  }
  table('Usuario', 'Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true }, password_usuario: D.STRING,
    email_usuario: D.STRING, estado_cuenta: D.STRING, es_provisional: D.BOOLEAN });
  table('Clinica', 'Clinicas', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER });
  table('UsuarioClinica', 'UsuariosClinicas', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
    id_usuario: D.INTEGER, id_clinica: D.INTEGER, rol_clinica: D.STRING, estado_invitacion: D.STRING });
  for (const name of ['Usuario', 'Clinica', 'UsuarioClinica']) await models[name].sync();
  await qi.createTable('GoogleConnections', { id: { type: D.INTEGER, primaryKey: true },
    googleUserId: D.STRING(128), accessToken: { type: D.TEXT, allowNull: false }, refreshToken: D.TEXT });
  const migration = require('../../../migrations/20260913020000-create-google-oauth-broker-flows');
  await migration.up(qi, D); await migration.down(qi, D); await migration.up(qi, D);
  await require('../../../migrations/20260913070000-scope-google-oauth-by-service').up(qi, D);
  await require('../../../migrations/20260912210000-create-platform-audit-events').up(qi, D);
  await require('../../../migrations/20260913003000-add-platform-audit-result-part').up(qi, D);
  await require('../../../migrations/20260912220000-create-auth-sessions').up(qi, D);
  for (const [name, file] of [['GoogleOAuthBrokerBinding', 'googleoauthbrokerbinding'], ['GoogleOAuthBrokerRequest', 'googleoauthbrokerrequest'],
    ['PlatformAuditEvent', 'platformauditevent'], ['AuthSession', 'authsession']]) models[name] = require('../../../models/' + file)(sql, D);
  table('GoogleConnectionAssignment', 'GoogleConnectionAssignments', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
    googleConnectionId: D.INTEGER, scopeKey: D.STRING, assignmentScope: D.STRING, clinicaId: D.INTEGER, grupoClinicaId: D.INTEGER, status: D.STRING });
  for (const name of ['ClinicWebAsset', 'ClinicAnalyticsProperty', 'ClinicGoogleAdsAccount']) {
    await table(name, name === 'ClinicAnalyticsProperty' ? 'ClinicAnalyticsProperties' : name + 's',
      { id: { type: D.INTEGER, primaryKey: true }, googleConnectionId: D.INTEGER, isActive: D.BOOLEAN }).sync();
  }
  table('ClinicBusinessLocation', 'ClinicBusinessLocations', { id: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER,
    google_connection_id: D.INTEGER, location_id: D.STRING, broker_read_connection_ref: D.STRING, broker_read_asset_ref: D.STRING, is_active: D.BOOLEAN });
  table('BusinessProfileBrokerBinding', 'BusinessProfileBrokerBindings', { external_location_id: { type: D.STRING, primaryKey: true },
    clinica_id: D.INTEGER, google_connection_id: D.INTEGER, connection_ref: D.STRING, asset_ref: D.STRING });
  table('BusinessProfileBrokerRevocation', 'BusinessProfileBrokerRevocations', { external_location_id: { type: D.STRING, primaryKey: true } });
  for (const name of ['GoogleConnectionAssignment', 'ClinicBusinessLocation', 'BusinessProfileBrokerBinding', 'BusinessProfileBrokerRevocation']) await models[name].sync();
  await require('../../../migrations/20260913030000-add-search-console-broker-read-binding').up(qi, D);
  await require('../../../migrations/20260913050000-scope-search-console-bindings-by-mapping').up(qi, D);
  models.SearchConsoleBrokerBinding = require('../../../models/searchconsolebrokerbinding')(sql, D);
  await require('../../../migrations/20260913040000-add-analytics-broker-read-binding').up(qi, D);
  models.AnalyticsBrokerBinding = require('../../../models/analyticsbrokerbinding')(sql, D);
  await require('../../../migrations/20260913060000-create-google-property-broker-revocations').up(qi, D);
  models.GooglePropertyBrokerRevocation = require('../../../models/googlepropertybrokerrevocation')(sql, D);
  const B = models.GoogleOAuthBrokerBinding; const R = models.GoogleOAuthBrokerRequest; const A = models.PlatformAuditEvent;
  const user = await models.Usuario.create({ id_usuario: 501, password_usuario: 'FICTITIOUS_PASSWORD_HASH',
    email_usuario: 'oauth@example.invalid', estado_cuenta: 'activo', es_provisional: false });
  await models.Clinica.bulkCreate([{ id_clinica: 71, grupoClinicaId: 9 }, { id_clinica: 72, grupoClinicaId: 9 }]);
  await models.UsuarioClinica.bulkCreate([71, 72].map(id_clinica => ({ id_usuario: 501, id_clinica, rol_clinica: 'propietario', estado_invitacion: 'aceptada' })));
  await sql.query("INSERT INTO GoogleConnections (id,googleUserId,accessToken,refreshToken) VALUES (81,'fictitious-subject',NULL,NULL)");
  await models.GoogleConnectionAssignment.create({ googleConnectionId: 81, scopeKey: 'group:9', assignmentScope: 'group', grupoClinicaId: 9, status: 'active' });
  await models.ClinicBusinessLocation.create({ id: 91, clinica_id: 71, google_connection_id: 81, location_id: 'locations/456',
    broker_read_connection_ref: 'connection:qa', broker_read_asset_ref: 'gbp:123:456', is_active: true });
  await models.BusinessProfileBrokerBinding.create({ external_location_id: '456', clinica_id: 71, google_connection_id: 81,
    connection_ref: 'connection:qa', asset_ref: 'gbp:123:456' });
  const binding = (await B.create({ google_user_id: 'fictitious-subject', google_connection_id: 81, clinica_id: 71,
    connection_ref: 'connection:qa', asset_ref: 'gbp:123:456', scope_key: 'group:9', policy_version: 'google-oauth-pinned-v1' })).get({ plain: true });
  let at = new Date(); const now = () => at; const advance = ms => { at = new Date(at.getTime() + ms); };
  const sessionsApi = require('../../services/accessSession.service');
  const sessions = sessionsApi.createService({ models, now, config: () => ({ mode: 'enforce', ttl: 3600, secret: 'FICTITIOUS_JWT_KEY' }) });
  const issued = await sql.transaction(transaction => sessions.issue(user, { transaction }));
  const jwtPayload = require('jsonwebtoken').decode(issued.token);
  const actor = { actorId: 501, sessionRef: issued.sessionRef, sessionExpiresAt: jwtPayload.exp };
  const ref = { userId: 501, sessionRef: issued.sessionRef, expiresAt: new Date(jwtPayload.exp * 1000) };
  await sessions.verifyReference(ref);
  for (const changes of [{ userId: 502 }, { sessionRef: randomUUID() }, { expiresAt: new Date(at.getTime() - 1) },
    { expiresAt: new Date((jwtPayload.exp + 1) * 1000) }]) await assert.rejects(sessions.verifyReference({ ...ref, ...changes }));
  const legacySessions = sessionsApi.createService({ models: () => assert.fail('Legacy reference cannot query DB'), config: () => ({ mode: 'legacy', secret: 'FICTITIOUS_JWT_KEY' }) });
  await assert.rejects(legacySessions.verifyReference(ref));
  report.checks.push('Managed session references check owner, durable state and original expiry; legacy and phantom references fail closed');
  const remote = new Map(); const calls = []; const sentinels = []; let loseFinish = false; let loseActivate = false; let loseBegin = false; let beforeFinish;
  const client = { execute: async command => {
    calls.push({ operation: command.operation, requestId: command.requestId, flowId: command.payload.flowId });
    const name = command.operation.split('.')[3]; const id = command.payload.flowId || command.requestId;
    assert.equal(command.tenantRef, 'clinic:71'); assert.equal(command.connectionRef, 'connection:qa');
    if (name === 'begin') {
      const params = new URLSearchParams({ state: command.payload.state, response_type: 'code', code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update('fictitious-pkce').digest('base64url'), login_hint: binding.google_user_id });
      sentinels.push(command.payload.state); remote.set(id, 'awaiting');
      if (loseBegin) { loseBegin = false; throw Object.assign(Error('FICTITIOUS_SECRET'), { code: 'broker_timeout' }); }
      return { requestId: command.requestId, replayed: false, data: { flowId: id, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?' + params, expiresAt: at.getTime() + 600000 } };
    }
    if (name === 'finish') { assert.equal(remote.get(id), 'awaiting'); assert.equal(command.payload.code, 'FICTITIOUS_CODE');
      remote.set(id, 'staged'); await beforeFinish?.();
      if (loseFinish) { loseFinish = false; throw Object.assign(Error('FICTITIOUS_SECRET'), { code: 'broker_timeout' }); }
    }
    if (name === 'activate') { assert(['staged', 'active'].includes(remote.get(id))); remote.set(id, 'active');
      if (loseActivate) { loseActivate = false; throw Object.assign(Error('FICTITIOUS_SECRET'), { code: 'broker_timeout' }); }
    }
    if (name === 'abort') remote.set(id, 'aborted');
    const status = remote.get(id); return { requestId: command.requestId, replayed: false, data: { flowId: id, connectionRef: binding.connection_ref,
      googleUserId: binding.google_user_id, status, secretVersion: ['staged', 'active'].includes(status) ? id : null, accessBlocked: false } };
  } };
  const api = require('../../services/googleOAuthBroker.service');
  const create = () => api.createGoogleOAuthBroker({ models, sessions, client, enabled: () => true, workerEnabled: () => true, now });
  let service = create();
  const begin = async () => {
    const result = await service.begin({ binding, scopeKey: 'group:9', ...actor, returnTo: 'https://app.clinicaclick.com' });
    const state = new URL(result.authUrl).searchParams.get('state');
    const row = await R.findOne({ where: { state_hash: createHash('sha256').update(state).digest('hex') }, raw: true });
    return { state, row };
  };
  const finish = flow => service.callback({ state: flow.state, code: 'FICTITIOUS_CODE' });
  const stateOf = async flow => (await R.findByPk(flow.row.flow_id)).state;
  const first = await begin(); assert.equal(await stateOf(first), 'awaiting');
  assert.equal((await finish(first)).authorization_status, 'activation_pending');
  assert.equal(remote.get(first.row.flow_id), 'staged');
  const pending = await service.status({ binding, scopeKey: 'group:9', ...actor }); assert(pending.pending); assert.equal(pending.connected, false);
  await service.run(); assert.equal(await stateOf(first), 'active'); assert.equal((await B.findByPk(binding.google_user_id)).secret_version, first.row.flow_id);
  await finish(first); await service.run(); assert.equal(calls.filter(c => c.operation.includes('.finish.')).length, 1);
  const auditFor = async flow => (await A.findAll({ where: { correlation_id: [flow.row.flow_id, flow.row.activation_id] }, raw: true })).map(r => JSON.parse(r.body));
  const events = await auditFor(first); assert.equal(events.length, 4); assert(events.every(e => e.version === 8 && e.subjectUserId === '501'));
  assert(events.some(e => e.actor.type === 'job' && e.reason === 'activation_confirmed'));
  report.checks.push('Authorization stages before a durable activation intent; worker confirms metadata and four correlated user/job audit records exactly once');
  const { keyFor } = require('../../../services/platform-audit/src/event');
  for (const record of await A.findAll({ where: { correlation_id: [first.row.flow_id, first.row.activation_id] } })) {
    const receipt = { key: keyFor(record.get({ plain: true })), digest: record.digest, versionId: 'fictitious-v8' };
    await record.update({ state: 'delivered', delivered_at: now(), receipt });
  }
  const view = require('../../services/platformAudit.view').createView({ model: A,
    audit: require('../../services/platformAudit.repository').createRepository(A), now,
    codec: require('../../../services/platform-audit/src/view-contract').cursorCodec(require('node:crypto').randomBytes(32)),
    reader: { read: async ({ refs }) => ({ results: await Promise.all(refs.map(async receipt => {
      const record = await A.findOne({ where: { digest: receipt.digest }, raw: true });
      assert.equal(keyFor(record), receipt.key); assert.equal(receipt.versionId, 'fictitious-v8');
      return { status: 'verified', receipt, body: record.body };
    })) }) },
  });
  const page = await view.read({ actorId: 1, sessionRef: randomUUID(), query: { from: now().toISOString().slice(0, 10),
    to: now().toISOString().slice(0, 10), action: 'integration.oauth.activate', userId: '501' } });
  assert.equal(page.events.length, 2); assert(page.events.every(e => e.integrationOAuth.connectionRef === 'connection:qa'
    && e.integrationOAuth.correlationId === first.row.activation_id && e.subjectUserId === '501'));
  report.checks.push('Actual SQL audit view filters v8 activation records by initiating user and projects only references from verified reader responses');
  loseFinish = true; const lost = await begin(); await finish(lost); assert.equal(await stateOf(lost), 'processing');
  advance(121000); service = create(); loseActivate = true; await service.run(); assert.equal(await stateOf(lost), 'activation_pending');
  advance(10000); await service.run(); assert.equal(await stateOf(lost), 'active');
  assert.equal(calls.filter(c => c.flowId === lost.row.flow_id && c.operation.includes('.finish.')).length, 1);
  const retries = calls.filter(c => c.flowId === lost.row.flow_id && c.operation.includes('.activate.')); assert.equal(retries.length, 2); assert.equal(retries[0].requestId, retries[1].requestId);
  report.checks.push('A fresh worker reconciles lost callback and activation responses using status and a stable activation UUID; the OAuth code is never resent');
  loseBegin = true; await assert.rejects(begin()); await service.run();
  assert.equal(await R.count({ where: { state: 'abort_pending' } }), 0);
  report.checks.push('A lost begin response cancels durably and confirms the broker tombstone without persisting the OAuth state');
  const countBefore = await R.count();
  const auditFailure = () => { throw Error('FICTITIOUS_OUTBOX_FAILURE'); };
  A.addHook('beforeCreate', 'fail', auditFailure); await assert.rejects(begin()); A.removeHook('beforeCreate', 'fail');
  assert.equal(await R.count(), countBefore);
  const auditLost = await begin();
  A.addHook('beforeCreate', 'fail', auditFailure); await finish(auditLost); A.removeHook('beforeCreate', 'fail');
  assert.equal(await stateOf(auditLost), 'processing'); advance(121000); await service.run(); assert.equal(await stateOf(auditLost), 'active');
  report.checks.push('Outbox failure rolls back request creation and activation authorization; reconciliation recovers a staged candidate without repeating exchange');
  const forbidden = await begin(); await models.UsuarioClinica.update({ rol_clinica: 'paciente' }, { where: { id_clinica: 72 } });
  const before = calls.length; await finish(forbidden); assert.equal(calls.length, before); assert.equal(await stateOf(forbidden), 'abort_pending');
  await service.run(); await models.UsuarioClinica.update({ rol_clinica: 'propietario' }, { where: { id_clinica: 72 } });
  const raced = await begin(); beforeFinish = () => models.Clinica.update({ grupoClinicaId: 8 }, { where: { id_clinica: 72 } });
  await finish(raced); beforeFinish = null; assert.equal(await stateOf(raced), 'abort_pending'); await service.run();
  assert.equal(remote.get(raced.row.flow_id), 'aborted'); await models.Clinica.update({ grupoClinicaId: 9 }, { where: { id_clinica: 72 } });
  report.checks.push('Lost group permission blocks exchange; group membership changes during the callback cancel the staged candidate before activation');
  for (const setup of [
    async () => { await models.ClinicGoogleAdsAccount.create({ id: 1, googleConnectionId: 81, isActive: true }); return () => models.ClinicGoogleAdsAccount.destroy({ where: {} }); },
    async () => { await models.GoogleConnectionAssignment.create({ googleConnectionId: 81, scopeKey: 'clinic:72', assignmentScope: 'clinic', clinicaId: 72, status: 'active' }); return () => models.GoogleConnectionAssignment.destroy({ where: { scopeKey: 'clinic:72' } }); },
    async () => { await sql.query("UPDATE GoogleConnections SET refreshToken='FICTITIOUS_OLD_REFRESH'"); return () => sql.query('UPDATE GoogleConnections SET refreshToken=NULL'); },
    async () => { await models.BusinessProfileBrokerRevocation.create({ external_location_id: '456' }); return () => models.BusinessProfileBrokerRevocation.destroy({ where: {} }); },
  ]) { const undo = await setup(); const before = calls.length; await assert.rejects(begin()); assert.equal(calls.length, before); await undo(); }
  report.checks.push('Legacy consumers, multiple assignments, remaining SQL credentials and a revoked controlling asset all prevent broker OAuth');
  const concurrent = await Promise.allSettled([begin(), begin()]); assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1,
    JSON.stringify(concurrent.map(r => ({ status: r.status, code: r.reason?.code }))));
  const only = concurrent.find(r => r.status === 'fulfilled').value;
  await Promise.all([finish(only), finish(only)]); await service.run(); assert.equal(await stateOf(only), 'active');
  assert.equal(calls.filter(c => c.flowId === only.row.flow_id && c.operation.includes('.finish.')).length, 1);
  report.checks.push('SQL binding locks serialize parallel starts; callback claims prevent concurrent authorization-code exchange');
  const revoked = await begin(); await sessions.revoke(issued.token); await assert.rejects(sessions.verifyReference(ref));
  const prior = calls.length; await finish(revoked); assert.equal(calls.length, prior); await service.run(); assert.equal(await stateOf(revoked), 'aborted');
  await assert.rejects(service.assertLegacyAllowed(), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(service.assertLegacyConnection({ id: 900, googleUserId: binding.google_user_id }), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(migration.down(qi, D), /google_oauth_preserve_bindings/);
  report.checks.push('Revoked sessions reject callbacks without JWT replay; identity tombstones block legacy recreation and rollback refuses credential/history loss');
  const rows = JSON.stringify(await R.findAll({ raw: true })) + JSON.stringify(await A.findAll({ raw: true }));
  for (const secret of [...sentinels, issued.token, 'FICTITIOUS_CODE', 'FICTITIOUS_SECRET', 'FICTITIOUS_OLD_REFRESH', 'FICTITIOUS_PASSWORD_HASH']) assert(!rows.includes(secret), 'Sensitive sentinel persisted');
  report.checks.push('Database request and audit rows contain no raw OAuth state, code, provider token, JWT or credential hash');
}).catch(error => { console.error(error.code || 'google_oauth_qa_failed'); console.error(error.stack?.split('\n').slice(1, 5).join('\n')); process.exitCode = 1; });

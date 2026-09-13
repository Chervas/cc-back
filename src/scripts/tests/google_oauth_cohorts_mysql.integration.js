'use strict';
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  models.GoogleAdsBrokerBinding = require('../../../models/googleadsbrokerbinding')(sql, D);
  await models.GoogleAdsBrokerBinding.sync();
  models.GoogleAdsBrokerRevocation = require('../../../models/googleadsbrokerrevocation')(sql, D);
  await models.GoogleAdsBrokerRevocation.sync();
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
  const expansion = require('../../../migrations/20260913070000-scope-google-oauth-by-service');
  const oldBinding = { google_user_id: 'old-fictitious-subject', google_connection_id: 80, connection_ref: 'connection:old',
    asset_ref: 'gbp:123:456', clinica_id: 71, scope_key: 'clinic:71', policy_version: 'google-oauth-pinned-v1' };
  const oldPendingDigest = require('../../services/googleOAuthCohort.contract').digest(oldBinding);
  await qi.bulkInsert('GoogleOAuthBrokerBindings', [oldBinding]);
  const { policy_version, ...oldRequestBinding } = oldBinding;
  const oldFlowId = randomUUID();
  await qi.bulkInsert('GoogleOAuthBrokerRequests', [{ ...oldRequestBinding, flow_id: oldFlowId, activation_id: randomUUID(),
    state_hash: 'a'.repeat(64), binding_digest: oldPendingDigest, clinic_ids: JSON.stringify([71]), actor_user_id: 501, session_ref: randomUUID(),
    return_to: 'https://app.clinicaclick.com', requested_at: new Date(), expires_at: new Date(Date.now() + 600000), state: 'awaiting', next_attempt_at: new Date() }]);
  await expansion.up(qi, D);
  const [oldRows] = await sql.query('SELECT * FROM GoogleOAuthBrokerRequests WHERE flow_id=:id', { replacements: { id: oldFlowId } });
  assert.equal(oldRows[0].cohort, 'business_profile'); assert.equal(oldRows[0].policy_version, policy_version);
  assert.equal(oldRows[0].request_scope_key, null); assert.equal(oldRows[0].state, 'awaiting');
  assert.equal(require('../../services/googleOAuthCohort.contract').digest(oldRows[0]), oldPendingDigest);
  await assert.rejects(expansion.down(qi), /google_oauth_preserve_cohort_history/);
  await qi.bulkDelete('GoogleOAuthBrokerRequests', { flow_id: oldFlowId });
  await qi.bulkDelete('GoogleOAuthBrokerBindings', { google_user_id: oldBinding.google_user_id });
  await expansion.down(qi); await expansion.up(qi, D);
  report.checks.push('Populated expansion preserves an awaiting GBP request, its original digest and identity, with no invented request scope; down refuses its history');
  report.checks.push('OAuth service DDL empty up/down/up succeeds on the owned MySQL only');
  await require('../../../migrations/20260912210000-create-platform-audit-events').up(qi, D);
  await require('../../../migrations/20260913003000-add-platform-audit-result-part').up(qi, D);
  await require('../../../migrations/20260912220000-create-auth-sessions').up(qi, D);
  for (const [name, file] of [['GoogleOAuthBrokerBinding', 'googleoauthbrokerbinding'], ['GoogleOAuthBrokerRequest', 'googleoauthbrokerrequest'],
    ['PlatformAuditEvent', 'platformauditevent'], ['AuthSession', 'authsession']]) models[name] = require('../../../models/' + file)(sql, D);
  table('GoogleConnectionAssignment', 'GoogleConnectionAssignments', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
    googleConnectionId: D.INTEGER, scopeKey: D.STRING, assignmentScope: D.STRING, clinicaId: D.INTEGER, grupoClinicaId: D.INTEGER, status: D.STRING });
  for (const name of ['ClinicWebAsset', 'ClinicAnalyticsProperty', 'ClinicGoogleAdsAccount']) {
    await table(name, name === 'ClinicAnalyticsProperty' ? 'ClinicAnalyticsProperties' : name + 's',
      { id: { type: D.INTEGER, primaryKey: true }, clinicaId: D.INTEGER, googleConnectionId: D.INTEGER, isActive: D.BOOLEAN, siteUrl: D.STRING(512), propertyName: D.STRING(128) }).sync();
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
  let binding = (await B.create({ google_user_id: 'fictitious-subject', google_connection_id: 81, clinica_id: 71,
    connection_ref: 'connection:qa', asset_ref: 'gbp:123:456', scope_key: 'group:9', policy_version: 'google-oauth-pinned-v1' })).get({ plain: true });
  const C = require('../../services/googleOAuthCohort.contract');
  const oldDigest = createHash('sha256').update(JSON.stringify(['fictitious-subject', 81, 'connection:qa', 'gbp:123:456', 71, 'group:9', C.LEGACY_POLICY])).digest('hex');
  assert.equal(C.digest(binding), oldDigest);
  assert.equal(C.digest({ ...binding, cohort: undefined }), oldDigest);
  await B.update({ policy_version: C.POLICY, scope_key: 'connection:81' }, { where: C.keyFor(binding) });
  binding = await B.findOne({ where: C.keyFor(binding), raw: true });
  table('GroupAssetClinicAssignment', 'GroupAssetClinicAssignments', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
    grupoClinicaId: D.INTEGER, clinicaId: D.INTEGER, assetId: D.INTEGER, assetType: D.STRING });
  const groupFields = { id_grupo: { type: D.INTEGER, primaryKey: true } };
  for (const kind of ['business_profile', 'search_console', 'analytics']) groupFields[kind + '_assignment_mode'] = D.STRING;
  for (const field of ['business_profile_primary_location_id', 'search_console_primary_asset_id', 'analytics_primary_property_id']) groupFields[field] = D.INTEGER;
  table('GrupoClinica', 'GruposClinicas', groupFields);
  await models.GroupAssetClinicAssignment.sync(); await models.GrupoClinica.sync();
  await models.GrupoClinica.bulkCreate([{ id_grupo: 9 }, { id_grupo: 10 }]);
  await models.Clinica.create({ id_clinica: 73, grupoClinicaId: 10 });
  await models.GoogleConnectionAssignment.create({ googleConnectionId: 81, scopeKey: 'group:10', assignmentScope: 'group', grupoClinicaId: 10, status: 'active' });
  const sc = require('../../../services/integrations-broker/src/google-search-console-contract').site('https://cohort.example.invalid/');
  await models.ClinicWebAsset.create({ id: 92, clinicaId: 71, googleConnectionId: 81, siteUrl: sc.siteUrl, isActive: true,
    broker_read_connection_ref: 'connection:qa:sc', broker_read_asset_ref: sc.assetRef });
  // Mapping definitions precede their migration; register newly added metadata
  // fields explicitly, without sync altering a table or loading the app index.
  for (const name of ['ClinicWebAsset', 'ClinicAnalyticsProperty']) {
    models[name].rawAttributes.broker_read_connection_ref = { type: D.STRING(128), field: 'broker_read_connection_ref' };
    models[name].rawAttributes.broker_read_asset_ref = { type: D.STRING(128), field: 'broker_read_asset_ref' };
    models[name].refreshAttributes();
  }
  await models.ClinicWebAsset.update({ broker_read_connection_ref: 'connection:qa:sc', broker_read_asset_ref: sc.assetRef }, { where: { id: 92 } });
  await models.SearchConsoleBrokerBinding.create({ mapping_id: 92, clinica_id: 71, google_connection_id: 81, google_user_id: binding.google_user_id,
    connection_ref: 'connection:qa:sc', asset_ref: sc.assetRef, site_hash: sc.siteHash, site_url: sc.siteUrl, state: 'active' });
  await models.ClinicAnalyticsProperty.create({ id: 93, clinicaId: 71, googleConnectionId: 81, propertyName: 'properties/123', isActive: true,
    broker_read_connection_ref: 'connection:qa:ga', broker_read_asset_ref: 'ga4:123' });
  await models.AnalyticsBrokerBinding.create({ mapping_id: 93, clinica_id: 71, google_connection_id: 81, google_user_id: binding.google_user_id,
    connection_ref: 'connection:qa:ga', asset_ref: 'ga4:123', property_name: 'properties/123', state: 'active' });
  const bindings = { business_profile: binding };
  for (const [cohort, connection_ref, asset_ref] of [['search_console', 'connection:qa:sc', sc.assetRef], ['analytics', 'connection:qa:ga', 'ga4:123']]) {
    bindings[cohort] = (await B.create({ ...binding, cohort, connection_ref, asset_ref })).get({ plain: true });
  }
  assert.equal(await B.count(), 3);
  for (const changes of [{}, { google_user_id: 'another' }, { google_user_id: 'another', google_connection_id: 82 }]) {
    await assert.rejects(B.create({ ...bindings.search_console, ...changes }), e => e.name === 'SequelizeUniqueConstraintError');
  }
  await assert.rejects(expansion.down(qi), /google_oauth_preserve_cohort_history/);
  report.checks.push('One Google identity supports three services; duplicate identity/connection/reference within a service and populated down are rejected; GBP digest unchanged');
  let at = new Date(); const now = () => at; const advance = ms => { at = new Date(at.getTime() + ms); };
  const sessions = require('../../services/accessSession.service').createService({ models, now,
    config: () => ({ mode: 'enforce', ttl: 3600, secret: 'FICTITIOUS_JWT_KEY' }) });
  const issued = await sql.transaction(transaction => sessions.issue(user, { transaction }));
  const actor = { actorId: 501, sessionRef: issued.sessionRef, sessionExpiresAt: require('jsonwebtoken').decode(issued.token).exp };
  const remote = new Map(); const commands = []; let beforeFinish; let lostActivate = false;
  const client = { execute: async command => {
    const [_, vertical, __, action] = command.operation.split('.');
    const cohort = vertical === 'business_profile' ? 'business_profile' : vertical === 'search_console' ? 'search_console' : vertical === 'analytics' ? 'analytics' : null;
    assert(cohort); const selected = bindings[cohort]; commands.push(command);
    assert.equal(command.connectionRef, selected.connection_ref); assert.equal(command.assetRef, selected.asset_ref); assert.equal(command.tenantRef, 'clinic:71');
    const flowId = command.payload.flowId || command.requestId;
    if (action === 'begin') {
      remote.set(flowId, { cohort, state: 'awaiting' });
      const query = new URLSearchParams({ state: command.payload.state, response_type: 'code', code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update('FICTITIOUS_PKCE').digest('base64url'), login_hint: selected.google_user_id });
      return { requestId: command.requestId, replayed: false, data: { flowId, expiresAt: at.getTime() + 600000, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?' + query } };
    }
    const flow = remote.get(flowId); assert.equal(flow.cohort, cohort);
    if (action === 'finish') { assert.equal(command.payload.code, 'FICTITIOUS_CODE'); assert.equal(flow.state, 'awaiting'); flow.state = 'staged'; await beforeFinish?.(); }
    if (action === 'activate') { assert(['staged', 'active'].includes(flow.state)); flow.state = 'active';
      if (lostActivate) { lostActivate = false; throw Object.assign(Error('FICTITIOUS_SECRET'), { code: 'broker_timeout' }); } }
    if (action === 'abort') flow.state = 'aborted';
    return { requestId: command.requestId, replayed: false, data: { flowId, connectionRef: selected.connection_ref, googleUserId: selected.google_user_id,
      status: flow.state, secretVersion: ['active', 'staged'].includes(flow.state) ? flowId : null, accessBlocked: false } };
  } };
  const factory = require('../../services/googleOAuthBroker.service').createGoogleOAuthBroker;
  const service = factory({ models, sessions, client, now, enabled: () => true, workerEnabled: () => true });
  const input = (kind, scopeKey = 'clinic:71') => ({ binding: bindings[kind], scopeKey, ...actor, returnTo: 'https://app.clinicaclick.com' });
  const start = async (kind, scopeKey) => {
    const value = await service.begin(input(kind, scopeKey)); const state = new URL(value.authUrl).searchParams.get('state');
    const row = await R.findOne({ where: { state_hash: createHash('sha256').update(state).digest('hex') }, raw: true });
    assert.equal(row.cohort, kind); assert.equal(row.policy_version, C.POLICY); assert.equal(row.request_scope_key, scopeKey || 'clinic:71');
    return { state, row };
  };
  const callback = flow => service.callback({ state: flow.state, code: 'FICTITIOUS_CODE' });
  const count = () => R.count();
  const index = await service.bindingFor(81);
  assert.equal(index.mode, 'broker_services');
  assert.deepEqual((await service.status({ ...input('analytics'), binding: index })).services.sort(), ['analytics', 'business_profile', 'search_console']);
  await assert.rejects(service.begin({ ...input('analytics'), binding: index }), { code: 'google_oauth_service_required' });
  for (const selector of ['ads', '', ['analytics'], null]) await assert.rejects(service.bindingFor(81, selector), { code: 'google_oauth_service_invalid' });
  await assert.rejects(service.bindingFor(null, 'analytics'), { code: 'google_oauth_service_unconfigured' });
  for (const kind of Object.keys(bindings)) assert.equal((await service.bindingFor(81, kind)).cohort, kind);
  report.checks.push('Service selection is explicit, metadata index verifies managed scope/session, unsupported or unconfigured selectors never enter legacy');
  const flows = [];
  for (const kind of Object.keys(bindings)) {
    const flow = await start(kind); flows.push(flow);
    await assert.rejects(start(kind), { code: 'google_oauth_flow_busy' });
    assert.equal((await callback(flow)).authorization_status, 'activation_pending');
  }
  lostActivate = true; const firstRun = await service.run(); assert.equal(firstRun.failed, 1); assert.equal(firstRun.confirmed, 2);
  advance(10000); assert.equal((await service.run()).confirmed, 1);
  for (const [kind, selected] of Object.entries(bindings)) {
    const status = await service.status(input(kind)); assert.equal(status.authorization_status, 'active'); assert.equal(status.google_service, kind);
    const row = await B.findOne({ where: C.keyFor(selected) }); assert.equal(row.secret_version, flows.find(flow => flow.row.cohort === kind).row.flow_id);
  }
  const events = (await A.findAll({ raw: true })).map(event => require('../../../services/platform-audit/src/event').unpack({ body: event.body, digest: event.digest }).event);
  const oauthEvents = events.filter(value => value.action.startsWith('integration.oauth.')); assert.equal(oauthEvents.length, 12);
  for (const value of oauthEvents) {
    assert.equal(value.version, 10); assert.equal(value.clinicCount, 1);
    assert.equal(value.clinicSetDigest, createHash('sha256').update(JSON.stringify(['71'])).digest('hex'));
  }
  report.checks.push('Three services authorize and activate independently, duplicate begins close, lost activation ACK reconciles and each binding/version and v10 audit stays isolated');
  const { keyFor } = require('../../../services/platform-audit/src/event');
  for (const record of await A.findAll({ where: { correlation_id: flows.flatMap(flow => [flow.row.flow_id, flow.row.activation_id]) } })) {
    const receipt = { key: keyFor(record.get({ plain: true })), digest: record.digest, versionId: 'fictitious-v10' };
    await record.update({ state: 'delivered', delivered_at: now(), receipt });
  }
  const view = require('../../services/platformAudit.view').createView({ model: A,
    audit: require('../../services/platformAudit.repository').createRepository(A), now,
    codec: require('../../../services/platform-audit/src/view-contract').cursorCodec(require('node:crypto').randomBytes(32)),
    reader: { read: async ({ refs }) => ({ results: await Promise.all(refs.map(async receipt => {
      const record = await A.findOne({ where: { digest: receipt.digest }, raw: true });
      assert.equal(keyFor(record), receipt.key); assert.equal(receipt.versionId, 'fictitious-v10');
      return { status: 'verified', receipt, body: record.body };
    })) }) },
  });
  const page = await view.read({ actorId: 1, sessionRef: randomUUID(), query: { from: now().toISOString().slice(0, 10),
    to: now().toISOString().slice(0, 10), action: 'integration.oauth.activate', userId: '501' } });
  assert.equal(page.events.length, 6); assert(page.events.every(e => e.integrationOAuth.clinicCount === 1 && /^[a-f0-9]{64}$/.test(e.integrationOAuth.clinicSetDigest)));
  assert.equal(new Set(page.events.map(e => e.integrationOAuth.provider)).size, 3);
  report.checks.push('Actual SQL audit view projects three v10 services with the verified version, initiating user and clinic-set commitment');
  const baseCount = await count();
  await models.GroupAssetClinicAssignment.create({ grupoClinicaId: 10, clinicaId: 73, assetId: 92, assetType: 'google.search_console' });
  await assert.rejects(start('search_console'), { code: 'google_oauth_scope_forbidden' }); assert.equal(await count(), baseCount);
  await models.UsuarioClinica.create({ id_usuario: 501, id_clinica: 73, rol_clinica: 'propietario', estado_invitacion: 'aceptada' });
  const shared = await start('search_console'); assert.deepEqual(shared.row.clinic_ids, [71, 73]); await callback(shared); await service.run();
  await models.GrupoClinica.update({ analytics_assignment_mode: 'group', analytics_primary_property_id: 93 }, { where: { id_grupo: 9 } });
  const inherited = await start('analytics', 'clinic:72'); assert.deepEqual(inherited.row.clinic_ids, [71, 72]); await callback(inherited); await service.run();
  await models.UsuarioClinica.update({ rol_clinica: 'lector' }, { where: { id_usuario: 501, id_clinica: 72 } });
  await assert.rejects(start('analytics'), { code: 'google_oauth_scope_forbidden' });
  await models.UsuarioClinica.update({ rol_clinica: 'propietario' }, { where: { id_usuario: 501, id_clinica: 72 } });
  report.checks.push('Shared recipients in another group and primary group members require write; inherited clinic requests capture the full affected set across multiple connection assignments');
  const override = await models.GoogleConnectionAssignment.create({ googleConnectionId: 81, scopeKey: 'clinic:72', assignmentScope: 'clinic', clinicaId: 72, status: 'disconnected' });
  await assert.rejects(start('analytics', 'clinic:72'), { code: 'google_oauth_scope_conflict' }); await override.destroy();
  await assert.rejects(start('business_profile', 'clinic:72'), { code: 'google_oauth_scope_forbidden' });
  const beforeCount = await count(); const beforeAudit = await A.count();
  const failedAudit = factory({ models, sessions, client, now, enabled: () => true, audit: { health: async () => ({ pending: 0, oldestAgeSeconds: 0 }), append: async () => { throw Error('FICTITIOUS_AUDIT_FAILURE'); } } });
  await assert.rejects(failedAudit.begin(input('analytics')), /FICTITIOUS_AUDIT_FAILURE/);
  assert.equal(await count(), beforeCount); assert.equal(await A.count(), beforeAudit);
  report.checks.push('Disconnected override prevents inheritance, unrelated service cannot be selected from another clinic, and outbox failure rolls back the whole begin');
  const changing = await start('analytics');
  beforeFinish = async () => { await models.GrupoClinica.update({ analytics_assignment_mode: 'group', analytics_primary_property_id: 93 }, { where: { id_grupo: 10 } }); };
  assert.equal((await callback(changing)).authorization_status, 'abort_pending'); beforeFinish = null;
  await service.run(); assert.equal((await R.findByPk(changing.row.flow_id)).state, 'aborted');
  await models.GrupoClinica.update({ analytics_assignment_mode: 'clinic', analytics_primary_property_id: null }, { where: { id_grupo: 10 } });
  report.checks.push('A new primary consumer appearing during the provider await cancels authorization even when the actor also has permission there');
  const revoked = require('../../services/googlePropertyRevocation.contract').fromBinding('analytics', await models.AnalyticsBrokerBinding.findOne({ raw: true }));
  await models.GooglePropertyBrokerRevocation.create({ ...revoked, request_id: randomUUID(), actor_user_id: 501, requested_at: now(), next_attempt_at: now(), state: 'pending' });
  await assert.rejects(start('analytics'), { code: 'google_oauth_scope_conflict' });
  const stillValid = await start('search_console'); await callback(stillValid); await service.run();
  assert.equal(await models.GooglePropertyBrokerRevocation.count(), 1);
  const pending = await start('search_console');
  beforeFinish = async () => models.UsuarioClinica.update({ rol_clinica: 'lector' }, { where: { id_usuario: 501, id_clinica: 73 } });
  assert.equal((await callback(pending)).authorization_status, 'abort_pending'); beforeFinish = null; await service.run();
  report.checks.push('A controlling revoked tuple cannot authorize; another managed service can update without removing the tombstone; lost shared permission cancels after callback');
  await models.UsuarioClinica.update({ rol_clinica: 'propietario' }, { where: { id_usuario: 501, id_clinica: 73 } });
  const orphanSite = require('../../../services/integrations-broker/src/google-search-console-contract').site('https://orphan.example.invalid/');
  const orphan = await models.SearchConsoleBrokerBinding.create({ mapping_id: 94, clinica_id: 72, google_connection_id: 81, google_user_id: binding.google_user_id,
    connection_ref: 'connection:qa:sc', asset_ref: orphanSite.assetRef, site_hash: orphanSite.siteHash, site_url: orphanSite.siteUrl, state: 'active' });
  await assert.rejects(start('search_console', 'clinic:72'), { code: 'google_oauth_scope_forbidden' });
  const recreated = await models.ClinicWebAsset.create({ id: 94, clinicaId: 73, googleConnectionId: 81, siteUrl: orphanSite.siteUrl, isActive: true,
    broker_read_connection_ref: 'connection:qa:sc', broker_read_asset_ref: orphanSite.assetRef });
  await assert.rejects(start('search_console'), { code: 'google_oauth_scope_conflict' }); await recreated.destroy(); await orphan.destroy();
  const legacyMapping = await models.ClinicWebAsset.create({ id: 95, clinicaId: 71, googleConnectionId: 81, siteUrl: 'https://legacy.example.invalid/', isActive: true });
  await assert.rejects(start('search_console'), { code: 'google_oauth_consumers_pending' }); await legacyMapping.destroy();
  await sql.query("UPDATE GoogleConnections SET accessToken='FICTITIOUS_SECRET' WHERE id=81");
  await assert.rejects(start('search_console'), { code: 'google_oauth_scope_conflict' });
  await sql.query('UPDATE GoogleConnections SET accessToken=NULL WHERE id=81');
  report.checks.push('Orphan history does not create an active use, reused mapping ownership is rejected, and unmanaged consumers or remaining SQL credentials prevent new OAuth');
  await B.update({ connection_ref: 'connection:qa:sc:new' }, { where: C.keyFor(bindings.search_console) });
  await models.SearchConsoleBrokerBinding.update({ connection_ref: 'connection:qa:sc:new' }, { where: { mapping_id: 92 } });
  await models.ClinicWebAsset.update({ broker_read_connection_ref: 'connection:qa:sc:new' }, { where: { id: 92 } });
  const replacement = await service.bindingFor(81, 'search_console');
  assert.equal((await service.status({ ...input('search_console'), binding: replacement })).authorization_status, 'none');
  report.checks.push('Historical confirmation of another binding cannot confirm a replacement credential reference');
  assert(!JSON.stringify(await A.findAll({ raw: true })).includes('FICTITIOUS_CODE'));
  assert(!JSON.stringify(await R.findAll({ raw: true })).includes('FICTITIOUS_CODE'));
  const [credentials] = await sql.query('SELECT COUNT(*) AS n FROM GoogleConnections WHERE accessToken IS NOT NULL OR refreshToken IS NOT NULL');
  assert.equal(Number(credentials[0].n), 0);
  assert.equal(commands.filter(command => command.operation.endsWith('.finish.v1') && command.payload.flowId === pending.row.flow_id).length, 1);
  report.checks.push('API/SQL/audit keep provider codes and credentials out; no token restored and each callback code exchanged once through its service only');
}).catch(error => { console.error(error.code || error.message); console.error(error.stack?.split('\n').slice(0, 4).join('\n')); process.exitCode = 1; });

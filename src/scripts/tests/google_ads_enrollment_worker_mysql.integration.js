'use strict';
// Real SQL and application scope/client/worker. Broker responses are fictitious;
// this is not a provider, deployed worker, authenticated UI or acceptance test.
const assert = require('node:assert/strict');
const { DataTypes: D } = require('sequelize'); const { randomUUID } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  await require('./fixtures/google_ads_enrollment_mysql.fixture').installGoogleAdsEnrollmentTables({ sql, models });
  await sql.getQueryInterface().createTable('Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true } });
  for (const [name, file] of [['GoogleConnection','googleconnection'], ['ClinicGoogleAdsAccount','clinicgoogleadsaccount'],
    ['GoogleAdsBrokerBinding','googleadsbrokerbinding'], ['GoogleAdsBrokerRevocation','googleadsbrokerrevocation'],
    ['GoogleConnectionAssignment','googleconnectionassignment'], ['GroupAssetClinicAssignment','groupassetclinicassignment'],
    ['PlatformAuditEvent','platformauditevent']]) {
    models[name] = require('../../../models/' + file)(sql, D); await models[name].sync();
  }
  models.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER },
    { tableName: 'Clinicas', timestamps: false });
  models.UsuarioClinica = sql.define('UsuarioClinica', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
    id_usuario: D.INTEGER, id_clinica: D.INTEGER, rol_clinica: D.STRING(64), estado_invitacion: D.STRING(32) },
  { tableName: 'UsuarioClinicas', timestamps: false });
  await models.Clinica.sync(); await models.UsuarioClinica.sync();
  await models.Clinica.bulkCreate([{ id_clinica: 59, grupoClinicaId: 5 }, { id_clinica: 71, grupoClinicaId: 5 }, { id_clinica: 99, grupoClinicaId: 6 }]);
  const { MARKETING_WRITE_ROLES } = require('../../lib/role-helpers');
  const { hasMarketingClinicScopeAccess } = require('../../lib/marketingScopeAccess');
  await models.UsuarioClinica.bulkCreate([59,71].map(id => ({ id_usuario: 9, id_clinica: id,
    rol_clinica: MARKETING_WRITE_ROLES[0], estado_invitacion: 'aceptada' })));
  await models.GoogleConnection.create({ id: 2, googleUserId: 'fictitious-subject', accessToken: null, refreshToken: null });
  await models.GoogleConnectionAssignment.create({ id: 1, scopeKey: 'group:5', assignmentScope: 'group', grupoClinicaId: 5, googleConnectionId: 2, status: 'active' });
  const S = models.GoogleAdsEnrollmentScope; const R = models.GoogleAdsEnrollmentRequest;
  const M = models.ClinicGoogleAdsAccount; const B = models.GoogleAdsBrokerBinding;
  const scopeData = { scope_key: 'group:5', google_connection_id: 2, google_user_id: 'fictitious-subject', connection_ref: 'google:ads:test',
    asset_ref: 'ads-enroll:group:5', tenant_clinic_id: 59, root_customer_id: '9876543210', login_customer_id: null, state: 'active' };
  await S.create(scopeData);
  const oldMapping = await M.create({ clinicaId: 59, grupoClinicaId: 5, assignmentScope: 'group', googleConnectionId: 2,
    customerId: '9000000000', loginCustomerId: '9876543210', managerCustomerId: '9876543210', isActive: true,
    broker_read_connection_ref: 'google:ads:test', broker_read_asset_ref: 'ads:9000000000' });
  await B.create({ customer_id: '9000000000', mapping_id: oldMapping.id, google_connection_id: 2, google_user_id: 'fictitious-subject',
    connection_ref: 'google:ads:test', asset_ref: 'ads:9000000000', scope_key: 'group:5', tenant_clinic_id: 59, login_customer_id: '9876543210', state: 'active' });
  const originalMapping = await M.findByPk(oldMapping.id, { raw: true });
  const originalBinding = await B.findOne({ where: { mapping_id: oldMapping.id }, raw: true });
  let at = Date.now(); let enrollmentEnabled = true; let workerEnabled = true; let sessionValid = true;
  let tokenReads = 0; let afterRemote; let beforeRemote; const calls = []; const remote = new Map(); const receipts = new Map();
  models.GoogleConnection.addHook('beforeFind', options => {
    if (!options.attributes || options.attributes.includes('accessToken') || options.attributes.includes('refreshToken')) tokenReads++;
  });
  const C = require('../../services/googleAdsEnrollment.contract');
  const { createGoogleAdsEnrollmentScope, createGoogleAdsEnrollmentScopeRepository } = require('../../services/googleAdsEnrollmentScope.service');
  const scope = createGoogleAdsEnrollmentScope({ ...createGoogleAdsEnrollmentScopeRepository(() => models), now: () => at,
    enabled: () => enrollmentEnabled, authorize: (input, { transaction }) => sessionValid && hasMarketingClinicScopeAccess({
      userId: input.actorId, clinicIds: input.clinicIds, access: 'write', globalAdminCheck: () => false,
      membershipModel: { findAll: options => models.UsuarioClinica.findAll({ ...options, logging: false,
        ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) }) } }) });
  const repository = require('../../services/googleAdsEnrollment.repository').createGoogleAdsEnrollmentRepository({ models, scope, now: () => new Date(at) });
  const fail = code => { throw Object.assign(Error('FICTITIOUS_PRIVATE_ERROR'), { code }); };
  const transport = async (command, control) => {
    const name = control ? 'revoke' : Object.keys(C.broker.OPERATIONS).find(key => C.broker.OPERATIONS[key] === command.operation);
    assert.equal(control, command.operation === C.broker.REVOKE_OPERATION);
    assert.ok(['prepare', 'activate', 'status', 'revoke'].includes(name));
    assert.equal(command.connectionRef, scopeData.connection_ref); assert.equal(command.tenantRef, 'clinic:59');
    const id = command.payload.enrollmentId; calls.push({ name, id, requestId: command.requestId });
    await beforeRemote?.(name, command);
    const old = receipts.get(command.requestId);
    if (old) { assert.deepEqual(command, old.command); return { ...structuredClone(old.result), replayed: true }; }
    let data = remote.get(id);
    if (name === 'status' && !data) fail('scope_denied');
    if (name === 'prepare' && data?.state === 'revoked') fail('asset_revoked');
    if (name === 'activate' && data?.state !== 'prepared') fail('scope_denied');
    if (name !== 'status') {
      data = { enrollmentId: id, assetRef: 'ads:' + command.payload.customerId, scopeRef: command.assetRef,
        clinicCount: command.payload.clinicCount, clinicSetDigest: command.payload.clinicSetDigest,
        state: name === 'prepare' ? 'prepared' : name === 'activate' ? 'active' : 'revoked' };
      remote.set(id, data);
    }
    const result = { requestId: command.requestId, replayed: false,
      data: { ...data, ...(['revoke','status'].includes(name) ? { accessBlocked: data.state === 'revoked' } : {}) } };
    if (name !== 'status') receipts.set(command.requestId, { command: structuredClone(command), result: structuredClone(result) });
    await afterRemote?.(name, command); return result;
  };
  const client = require('../../services/googleAdsEnrollmentClient.service').createGoogleAdsEnrollmentClient({ scope, now: () => at,
    client: { execute: command => transport(command, false) }, controlClient: { execute: command => transport(command, true) } });
  const workerFactory = extra => require('../../services/googleAdsEnrollmentWorker.service').createGoogleAdsEnrollmentWorker({
    repository, client, scope, now: () => at, enabled: () => workerEnabled, ...extra });
  const worker = workerFactory(); let sequence = 1000000000;
  const state = async id => C.request(await R.findByPk(id, { raw: true }));
  const inputs = () => ({ scopeKey: 'group:5', connectionId: 2, clinicIds: [59,71], actorId: 9, sessionRef: randomUUID(), sessionExpiresAt: at + 300000 });
  const enqueue = async () => {
    const input = inputs(); const context = await scope.capture(input);
    const result = await repository.enqueue(context, { enrollmentId: randomUUID(), customerId: String(++sequence) });
    return { id: result.enrollmentId, result, context, input };
  };
  const unchanged = async () => {
    assert.deepEqual(await M.findByPk(oldMapping.id, { raw: true }), originalMapping);
    assert.deepEqual(await B.findOne({ where: { mapping_id: oldMapping.id }, raw: true }), originalBinding);
    assert.equal(tokenReads, 0);
  };
  const cancelAll = async () => {
    await sql.transaction(transaction => repository.cancelScope({ scopeKey: 'group:5', connectionId: 2, clinicIds: [59,71], transaction }));
    const result = await worker.run(); assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(await R.count({ where: { state: { [require('sequelize').Op.ne]: 'revoked' } } }), 0); await unchanged();
  };

  const first = await enqueue();
  assert.deepEqual(await repository.enqueue(first.context, { enrollmentId: first.id, customerId: first.result.customerId }), first.result);
  const differentSession = await scope.capture(inputs());
  await assert.rejects(repository.enqueue(differentSession, { enrollmentId: first.id, customerId: first.result.customerId }), { code: 'google_ads_enrollment_scope_conflict' });
  await assert.rejects(repository.enqueue(first.context, { customerId: first.result.customerId }), { code: 'google_ads_enrollment_account_in_use' });
  assert.equal(await R.count(), 1); assert.equal(calls.length, 0);
  report.checks.push('durable enqueue is idempotent only for the original customer, actor, session and scope; another intent cannot acquire the account');

  afterRemote = name => { if (name === 'prepare') { afterRemote = null; fail('broker_timeout'); } };
  assert.equal((await worker.run()).failed, 1);
  assert.equal((await state(first.id)).state, 'prepare_pending'); assert.equal(await M.count(), 1);
  at += 3000; assert.equal((await worker.run()).status, 'completed');
  const ready = await state(first.id); assert.equal(ready.state, 'activation_confirmed');
  assert.equal((await M.findByPk(ready.mapping_id, { raw: true })).isActive, 0);
  assert.equal((await B.findOne({ where: { mapping_id: ready.mapping_id }, raw: true })).state, 'staged');
  assert.equal(calls.filter(c => c.id === first.id && c.name === 'prepare').length, 1);
  assert.ok(calls.some(c => c.id === first.id && c.name === 'status')); await unchanged();
  report.checks.push('lost prepare ACK is recovered by status without duplicate prepare; confirmed broker activation leaves the new CRM mapping inactive and existing accounts intact');

  at = ready.session_expires_at.getTime() + 1;
  assert.equal((await worker.run()).cancelled, 1); assert.equal((await state(first.id)).state, 'revoked');
  assert.equal(remote.get(first.id).state, 'revoked');
  assert.equal((await B.findOne({ where: { mapping_id: ready.mapping_id }, raw: true })).state, 'blocked'); await unchanged();
  report.checks.push('original session expiry before human mapping selection cancels a remotely active enrollment and blocks only its own local binding');

  const sqlLost = await enqueue(); let sqlFailure = true;
  M.addHook('afterCreate', 'enrollment_ack_failure', () => { if (sqlFailure) { sqlFailure = false; fail('FICTITIOUS_SQL_FAILURE'); } });
  assert.equal((await worker.run()).failed, 1); M.removeHook('afterCreate', 'enrollment_ack_failure');
  assert.equal((await state(sqlLost.id)).mapping_id, null); assert.equal(await M.count({ where: { customerId: sqlLost.result.customerId } }), 0);
  at += 3000; assert.equal((await worker.run()).status, 'completed'); assert.equal((await state(sqlLost.id)).state, 'activation_confirmed');
  assert.equal(await M.count({ where: { customerId: sqlLost.result.customerId } }), 1);
  assert.equal(calls.filter(c => c.id === sqlLost.id && c.name === 'prepare').length, 1);
  report.checks.push('SQL rollback after remote preparation leaves no partial mapping or binding; the next claim recovers the receipt and creates exactly one pair');
  await cancelAll();

  const activateLost = await enqueue();
  afterRemote = name => { if (name === 'activate') { afterRemote = null; fail('broker_timeout'); } };
  assert.equal((await worker.run()).failed, 1); assert.equal((await state(activateLost.id)).state, 'activate_pending');
  at += 9000; assert.equal((await worker.run()).status, 'completed'); assert.equal((await state(activateLost.id)).state, 'activation_confirmed');
  assert.equal(calls.filter(c => c.id === activateLost.id && c.name === 'activate').length, 1);
  report.checks.push('lost activation ACK recovers the committed active receipt; no second activation command and no premature local activation'); await cancelAll();

  const cases = [
    ['permission loss', () => models.UsuarioClinica.update({ estado_invitacion: 'pendiente' }, { where: { id_usuario: 9, id_clinica: 71 } }),
      () => models.UsuarioClinica.update({ estado_invitacion: 'aceptada' }, { where: { id_usuario: 9, id_clinica: 71 } })],
    ['group expansion', () => models.Clinica.update({ grupoClinicaId: 5 }, { where: { id_clinica: 99 } }),
      () => models.Clinica.update({ grupoClinicaId: 6 }, { where: { id_clinica: 99 } })],
    ['scope removal', () => S.destroy({ where: { scope_key: 'group:5' } }), () => S.create(scopeData)],
    ['enrollment disabled', () => { enrollmentEnabled = false; }, () => { enrollmentEnabled = true; }],
    ['session revoked', () => { sessionValid = false; }, () => { sessionValid = true; }],
  ];
  for (const [label, change, restore] of cases) {
    const request = await enqueue(); await change(); const result = await worker.run();
    assert.equal(result.cancelled, 1, label); assert.equal((await state(request.id)).state, 'revoked', label);
    assert.deepEqual(calls.filter(c => c.id === request.id).map(c => c.name), ['revoke'], label);
    assert.equal(remote.get(request.id).clinicSetDigest, C.digest([59,71])); await restore(); await unchanged();
  }
  report.checks.push('permission loss, scope removal, group expansion, logout and disabled enrollment all revoke through the independent control client without granting or broadening access');

  const during = await enqueue();
  afterRemote = async name => { if (name === 'prepare') { afterRemote = null;
    await models.UsuarioClinica.update({ estado_invitacion: 'pendiente' }, { where: { id_usuario: 9, id_clinica: 71 } }); } };
  assert.equal((await worker.run()).cancelled, 1); assert.equal((await state(during.id)).state, 'revoked');
  assert.equal((await state(during.id)).mapping_id, null);
  assert.deepEqual(calls.filter(c => c.id === during.id).map(c => c.name), ['prepare', 'revoke']);
  await models.UsuarioClinica.update({ estado_invitacion: 'aceptada' }, { where: { id_usuario: 9, id_clinica: 71 } });
  report.checks.push('permission loss while preparation is in flight withholds the receipt, leaves no CRM mapping and durably cancels the broker grant');

  const race = await enqueue();
  afterRemote = async name => { if (name === 'prepare') { afterRemote = null;
    await sql.transaction(transaction => repository.cancelScope({ scopeKey: 'group:5', connectionId: 2, clinicIds: [59,71], transaction })); } };
  await worker.run(); assert.equal((await state(race.id)).state, 'revoked');
  assert.equal((await state(race.id)).mapping_id, null);
  assert.deepEqual(calls.filter(c => c.id === race.id).map(c => c.name), ['prepare', 'revoke']);
  report.checks.push('disconnect committed during remote preparation invalidates the old SQL lease; its late receipt cannot recreate or activate a mapping');

  const paused = await enqueue();
  const stopping = workerFactory({ repository: { ...repository, claim: async () => { const row = await repository.claim(); workerEnabled = false; return row; } } });
  assert.equal((await stopping.run()).failed, 1); assert.equal((await state(paused.id)).state, 'prepare_pending');
  assert.equal(calls.filter(c => c.id === paused.id).length, 0); workerEnabled = true; at += 3000;
  await worker.run(); assert.equal((await state(paused.id)).state, 'activation_confirmed');
  report.checks.push('a worker switch disabled after claim prevents dispatch and preserves the same durable intent for a later retry'); await cancelAll();

  const claims = [await enqueue(), await enqueue()];
  const held = await sql.transaction(); let second;
  try {
    report.phase = 'lock first intent';
    await R.findByPk(claims[0].id, { transaction: held, lock: held.LOCK.UPDATE });
    report.phase = 'claim while first intent is locked';
    second = await repository.claim(); assert.equal(second.enrollment_id, claims[1].id);
  } finally { await held.rollback(); }
  report.phase = 'claim after releasing first intent';
  const firstClaim = await repository.claim(); assert.equal(firstClaim.enrollment_id, claims[0].id);
  assert.equal(await repository.claim(), null); at += 120001;
  report.phase = 'replace expired claim'; const replacement = await repository.claim();
  const stale = replacement.enrollment_id === firstClaim.enrollment_id ? firstClaim : second;
  assert.notEqual(replacement.lease_token, stale.lease_token);
  for (const action of [() => repository.assertClaim(stale), () => repository.retry(stale, 'broker_timeout'),
    () => repository.cancelClaim(stale, 'scope_disconnected')]) await assert.rejects(action, { code: 'google_ads_enrollment_lease_lost' });
  report.checks.push('real SKIP LOCKED allows an independent owner, concurrent claims do not duplicate work, and expired leases cannot confirm, retry or cancel replacement work');
  await cancelAll(); delete report.phase;

  const wrong = await enqueue(); const claimed = await repository.claim();
  const other = await scope.capture(inputs());
  const receipt = { enrollmentId: wrong.id, assetRef: 'ads:' + wrong.result.customerId, scopeRef: scopeData.asset_ref,
    clinicCount: 2, clinicSetDigest: C.digest([59,71]), state: 'prepared' };
  await assert.rejects(repository.prepared(claimed, other, receipt), { code: 'google_ads_enrollment_scope_conflict' });
  assert.equal((await state(wrong.id)).mapping_id, null); await cancelAll();
  report.checks.push('repository commit independently pins the original session even when supplied a different currently authorized opaque context');

  const mappingRequest = await enqueue();
  beforeRemote = name => { if (name === 'activate') fail('provider_timeout'); };
  await worker.run(); assert.equal((await state(mappingRequest.id)).state, 'activate_pending'); beforeRemote = null;
  const { createGoogleAdsScopeRepository } = require('../../services/googleAdsBrokerScope.service');
  const reader = require('../../services/googleAdsBroker.service').createGoogleAdsBroker({
    ...createGoogleAdsScopeRepository(() => models), enabled: () => true, now: () => at,
    client: { execute: async command => {
      assert.equal(command.operation, 'google.ads.discovery.read.v1');
      return { requestId: command.requestId, data: { results: [{ customer: { id: command.assetRef.slice(4),
        descriptiveName: 'Fictitious account', manager: false, currencyCode: 'EUR', timeZone: 'Europe/Madrid', status: 'ENABLED' } }], nextPageToken: null } };
    } } });
  const { createGoogleAdsDiscovery, createGoogleAdsDiscoveryRepository } = require('../../services/googleAdsDiscovery.service');
  const discovery = createGoogleAdsDiscovery({ ...createGoogleAdsDiscoveryRepository(() => models), broker: reader,
    enabled: () => true, hasManaged: async () => true, now: () => at });
  const realAudit = require('../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const mappingFactory = extra => require('../../services/googleAdsMapping.service').createGoogleAdsMapping({ models, discovery,
    broker: reader, audit: realAudit, enrollment: repository, enabled: () => true, now: () => new Date(at),
    revoke: args => require('../../services/googleAdsRevocation.service').enqueue({ ...args, enabled: 'true' }), ...extra });
  const capture = () => discovery.capture({ clinicIds: [59,71], connectionId: 2, scopeKey: 'group:5', revalidate: async () => {} });
  const map = async (service = mappingFactory(), extra = {}) => service.save({ selection: (await capture()).selection,
    mappings: [{ clinicaId: 71, customerId: mappingRequest.result.customerId }], actorId: 9,
    sessionRef: mappingRequest.input.sessionRef, authorize: async () => true, ...extra });
  let auditBaseline = await models.PlatformAuditEvent.count();
  await assert.rejects(map(mappingFactory(), { replaceExisting: true }), { code: 'google_ads_enrollment_not_ready' });
  assert.equal(await models.PlatformAuditEvent.count(), auditBaseline); assert.equal(await models.GoogleAdsBrokerRevocation.count(), 0);
  assert.equal((await state(mappingRequest.id)).state, 'activate_pending'); await unchanged();
  report.checks.push('actual discovery and mapping reject an enrollment whose broker activation is unconfirmed; replacement, revocation and audit all roll back with the existing account preserved');
  at += 9000; await worker.run(); assert.equal((await state(mappingRequest.id)).state, 'activation_confirmed');
  auditBaseline = await models.PlatformAuditEvent.count();
  await assert.rejects(map(mappingFactory(), { sessionRef: randomUUID() }), { code: 'google_ads_enrollment_scope_conflict' });
  assert.equal(await models.PlatformAuditEvent.count(), auditBaseline);
  const finalFailure = mappingFactory({ broker: { ...reader, assert: async (...args) => {
    await reader.assert(...args); fail('FICTITIOUS_FINAL_VALIDATION_FAILURE');
  } } });
  await assert.rejects(map(finalFailure, { replaceExisting: true }), { code: 'google_ads_mapping_unavailable' });
  const beforeAccepted = await state(mappingRequest.id); assert.equal(beforeAccepted.state, 'activation_confirmed');
  assert.equal((await M.findByPk(beforeAccepted.mapping_id, { raw: true })).isActive, 0);
  assert.equal((await B.findOne({ where: { mapping_id: beforeAccepted.mapping_id }, raw: true })).state, 'staged');
  assert.equal(await models.PlatformAuditEvent.count(), auditBaseline); assert.equal(await models.GoogleAdsBrokerRevocation.count(), 0); await unchanged();
  report.checks.push('a different user session or a failure after enrollment acknowledgement rolls back the request, active mapping, replacement and durable human audit together');
  process.env.GOOGLE_ADS_ENROLLMENT_ENABLED = 'true';
  let accepted;
  try {
    // Exercise the production composition too: the route's persistent-session
    // callback requires the surrounding transaction on every authorization.
    accepted = await map(mappingFactory({ enrollment: undefined }), { authorize: async args => {
      assert.ok(args.transaction?.LOCK?.UPDATE); assert.equal(args.actorId, 9);
      assert.equal(args.sessionRef, mappingRequest.input.sessionRef); assert.deepEqual(args.clinicIds, [59,71]); return true;
    } });
  } finally { delete process.env.GOOGLE_ADS_ENROLLMENT_ENABLED; }
  assert.equal(accepted.mapped, 1); assert.equal((await state(mappingRequest.id)).state, 'active');
  assert.equal((await M.findByPk(beforeAccepted.mapping_id, { raw: true })).isActive, 1);
  assert.equal((await B.findOne({ where: { mapping_id: beforeAccepted.mapping_id }, raw: true })).state, 'active');
  const event = (await models.PlatformAuditEvent.findAll({ raw: true })).find(row => JSON.parse(row.body).version === 12);
  const auditEvent = require('../../../services/platform-audit/src/event').unpack(event).event;
  assert.equal(auditEvent.version, 12); assert.equal(auditEvent.sessionRef, mappingRequest.input.sessionRef);
  assert.equal(auditEvent.reason, 'mapping_activated'); assert.equal(auditEvent.affectedClinicCount, 2);
  at = mappingRequest.input.sessionExpiresAt + 1; assert.equal((await worker.run()).advanced, 0);
  assert.equal((await state(mappingRequest.id)).state, 'active'); await unchanged();
  report.checks.push('only the original confirmed selection commits active enrollment, mapping, binding and version-12 human audit; later session expiry does not undo an already accepted mapping');
  await cancelAll();

  const revokeLost = await enqueue();
  await sql.transaction(transaction => repository.cancelScope({ scopeKey: 'group:5', connectionId: 2, clinicIds: [59,71], transaction }));
  afterRemote = name => { if (name === 'revoke') { afterRemote = null; fail('broker_timeout'); } };
  await worker.run(); assert.equal((await state(revokeLost.id)).state, 'revoke_pending');
  at += 3000; await worker.run(); assert.equal((await state(revokeLost.id)).state, 'revoked');
  const revokeCalls = calls.filter(c => c.id === revokeLost.id); assert.equal(revokeCalls.length, 2);
  assert.ok(revokeCalls.every(c => c.name === 'revoke' && c.requestId === revokeCalls[0].requestId));
  report.checks.push('lost cancellation ACK retries only the same durable control request and accepts its replayed receipt without creating a new grant');

  const foreign = await enqueue(); await worker.run(); const foreignRow = await state(foreign.id);
  await M.update({ clinicaId: 99, grupoClinicaId: 6, isActive: true, broker_read_connection_ref: 'foreign:connection' }, { where: { id: foreignRow.mapping_id } });
  await B.update({ scope_key: 'group:6', tenant_clinic_id: 99, connection_ref: 'foreign:connection', state: 'active' }, { where: { mapping_id: foreignRow.mapping_id } });
  const foreignMapping = await M.findByPk(foreignRow.mapping_id, { raw: true });
  const foreignBinding = await B.findOne({ where: { mapping_id: foreignRow.mapping_id }, raw: true });
  await cancelAll();
  assert.deepEqual(await M.findByPk(foreignRow.mapping_id, { raw: true }), foreignMapping);
  assert.deepEqual(await B.findOne({ where: { mapping_id: foreignRow.mapping_id }, raw: true }), foreignBinding);
  report.checks.push('revoking the original durable intent cannot mutate a mapping or binding repurposed to a foreign owner');

  const unknown = await enqueue(); beforeRemote = name => { if (name === 'prepare') fail('FICTITIOUS_UNKNOWN_PROVIDER_ERROR'); };
  const unknownResult = await worker.run(); assert.equal(unknownResult.failed, 1);
  assert.equal((await state(unknown.id)).last_error, 'google_ads_enrollment_unavailable');
  assert.doesNotMatch(JSON.stringify(unknownResult), /FICTITIOUS|PRIVATE/); beforeRemote = null; await cancelAll();
  report.checks.push('unknown provider/SQL details are replaced with a closed error code and all fixtures leave pre-existing accounts and credential values untouched');
  const auditRows = (await models.PlatformAuditEvent.findAll({ raw: true })).map(row => require('../../../services/platform-audit/src/event').unpack(row).event);
  const firstEvents = auditRows.filter(row => row.version === 16 && row.requestRef === first.id);
  assert.deepEqual(firstEvents.map(row => row.reason).sort(), ['enrollment_broker_confirmed', 'enrollment_cancel_confirmed', 'enrollment_cancel_requested', 'enrollment_requested']);
  assert.equal(firstEvents.find(e => e.reason === 'enrollment_requested').actor.id, '9');
  assert.equal(firstEvents.find(e => e.reason === 'enrollment_requested').sessionRef, first.input.sessionRef);
  assert.ok(firstEvents.filter(e => e.reason !== 'enrollment_requested').every(e => e.actor.type === 'job' && e.sessionRef === null));
  const originals = auditRows.filter(row => row.reason === 'enrollment_requested'); assert.equal(originals.length, await R.count());
  report.checks.push('four audit phases preserve human/job attribution and the original scope; idempotent enqueue and lost ACK recovery produce exactly one durable event per phase');

  // Persistent sessions and real HTTP handlers against this owned database.
  // Fictitious password-only QA issuance is not an authenticated product UI test.
  models.Usuario = require('../../../models/usuario')(sql, D); await models.Usuario.sync({ alter: true });
  await require('../../../migrations/20260912220000-create-auth-sessions').up(sql.getQueryInterface(), D);
  await require('../../../migrations/20260913130000-create-auth-email-challenges').up(sql.getQueryInterface(), D);
  await require('../../../migrations/20260914220000-create-auth-trusted-devices').up(sql.getQueryInterface(), D);
  models.AuthSession = require('../../../models/authsession')(sql, D);
  const user = await models.Usuario.create({ id_usuario: 9, nombre: 'Fictitious enrollment QA', email_usuario: 'enrollment@example.invalid',
    password_usuario: require('bcryptjs').hashSync('FICTITIOUS_PASSWORD_NEVER_DEPLOY', 4) });
  const sessionApi = require('../../services/accessSession.service');
  const env = { JWT_SECRET: 'FICTITIOUS_SESSION_KEY_NEVER_DEPLOY', AUTH_SESSION_MODE: 'enforce', AUTH_EMAIL_MFA_MODE: 'off',
    AUTH_ACCESS_TOKEN_TTL_SECONDS: '300', PLATFORM_AUDIT_AUTH_ENABLED: 'true', PLATFORM_AUDIT_AUTH_POLICY: 'auth-durable-v1' };
  const sessions = sessionApi.createService({ models, now: () => new Date(at), config: () => sessionApi.settings(env) });
  const token = (await sessions.authenticated(user)).body.token;
  const apiClients = { client: { execute: command => command.operation === C.broker.OPERATIONS.discover
    ? { requestId: command.requestId, replayed: false, data: { accounts: [{ id: '1999999999', manager: false,
      currencyCode: 'EUR', timeZone: 'Europe/Madrid', descriptiveName: 'Fictitious eligible account', status: 'ENABLED' }], nextPageToken: null } }
    : transport(command, false) }, controlClient: { execute: command => transport(command, true) } };
  const enrollmentApi = require('../../services/googleAdsEnrollment.service').createGoogleAdsEnrollment({ models, sessions,
    clients: apiClients, now: () => at, enabled: () => enrollmentEnabled, workerEnabled: () => workerEnabled, gateway: () => false });
  const { authorizeRequestedMarketingConnectionScope, marketingScopeInputFromRequest } = require('../../lib/oauthMarketingScopeAccess');
  const authorizeScope = req => authorizeRequestedMarketingConnectionScope({ userId: req.userData.userId,
    ...marketingScopeInputFromRequest(req), access: 'write', findClinicGroupId: async id => (await models.Clinica.findByPk(id)).grupoClinicaId,
    findGroupClinicIds: async id => (await models.Clinica.findAll({ where: { grupoClinicaId: id }, raw: true })).map(c => c.id_clinica),
    authorizeClinicIds: input => hasMarketingClinicScopeAccess({ ...input, membershipModel: models.UsuarioClinica, globalAdminCheck: () => false }) });
  const express = require('express'); const http = require('node:http'); const app = express(); app.use(express.json());
  const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
  app.use(loadDiscoverySource('routes/auth.middleware.js', { '../services/accessSession.service': { ...sessions, bearer: sessionApi.bearer } }));
  app.use('/oauth/google/ads/enrollment', require('../../routes/googleAdsEnrollment.routes').createRouter({ service: enrollmentApi,
    sessions: { ...sessions, bearer: sessionApi.bearer }, authorizeScope, resolveConnection: async (_req, options) => {
      assert.equal(options.allowLegacyUserFallback, false); assert.equal(options.metadataOnly, true);
      return { connection: { id: 2 }, scope: { scopeKey: 'group:5' } };
    } }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: false }); agent.createConnection = require('./fixtures/campaign_offline_runtime.cjs').connectionForTestServer(server);
  const request = (path, body, bearer = token) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent,
      path: '/oauth/google/ads/enrollment/' + path, method: body ? 'POST' : 'GET', headers: {
        ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); assert.doesNotMatch(text, /FICTITIOUS|PRIVATE|google:ads:test|fictitious-subject/);
        resolve({ status: res.statusCode, body: JSON.parse(text), cache: res.headers['cache-control'] });
      });
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    assert.equal((await request('accounts?group_id=5', undefined, null)).status, 401);
    const listed = await request('accounts?group_id=5'); assert.equal(listed.status, 200);
    assert.equal(listed.body.accounts[0].customerId, '1999999999'); assert.equal(listed.cache, 'private, no-store');
    for (const path of ['accounts', 'accounts?group_id=5suffix', 'accounts?group_id=5&clinic_id=59',
      'accounts?group_id=5&connectionRef=injected', 'accounts?group_id=5&group_id=6']) {
      assert.equal((await request(path)).status, 400, path);
    }
    assert.equal((await request('accounts?group_id=6')).status, 403);
    const newId = randomUUID(); const payload = { group_id: 5, customerId: String(++sequence), enrollmentId: newId };
    assert.equal((await request('requests', { ...payload, assetRef: 'injected' })).status, 400);
    for (const customerId of ['0000000000', '123-456-7890', '123suffix', 1234567890]) {
      assert.equal((await request('requests', { ...payload, customerId })).status, 400);
    }
    const made = await request('requests', payload); assert.equal(made.status, 202); assert.equal(made.body.state, 'prepare_pending');
    assert.equal((await request('requests', payload)).status, 202);
    assert.equal((await request('requests/' + randomUUID() + '?group_id=5')).status, 404);
    assert.equal((await request('requests/' + newId + '?group_id=5')).body.canComplete, false);
    assert.equal((await enrollmentApi.run()).status, 'completed');
    const visible = await request('requests/' + newId + '?group_id=5'); assert.equal(visible.body.state, 'activation_confirmed');
    assert.equal(visible.body.canComplete, true); assert.equal(visible.cache, 'private, no-store');
    const providerBeforeCapabilities = calls.length;
    assert.equal((await request('capabilities?group_id=5')).body.enabled, true);
    workerEnabled = false;
    assert.equal((await request('capabilities?group_id=5')).body.enabled, false); workerEnabled = true;
    assert.equal(calls.length, providerBeforeCapabilities);
    const resumed = await request('requests?group_id=5'); assert.equal(resumed.status, 200);
    assert.deepEqual(resumed.body.requests.map(row => row.enrollmentId), [newId]);
    assert.equal(resumed.body.requests[0].canComplete, true); assert.equal(resumed.body.hasMore, false);
    const anotherToken = (await sessions.authenticated(user)).body.token;
    assert.deepEqual((await request('requests?group_id=5', undefined, anotherToken)).body.requests, []);
    assert.equal((await request('requests/' + newId + '?group_id=5', undefined, anotherToken)).body.canComplete, false);
    await models.Clinica.update({ grupoClinicaId: 6 }, { where: { id_clinica: 71 } });
    try {
      const resized = await request('requests?group_id=5'); assert.equal(resized.status, 200); assert.deepEqual(resized.body.requests, []);
      assert.equal((await request('requests/' + newId + '?group_id=5')).status, 409);
    } finally { await models.Clinica.update({ grupoClinicaId: 5 }, { where: { id_clinica: 71 } }); }
    const cancelId = randomUUID(); const cancelPayload = { ...payload, customerId: String(++sequence), enrollmentId: cancelId };
    assert.equal((await request('requests', cancelPayload)).status, 202);
    const cancelPath = 'requests/' + cancelId + '/cancel';
    assert.equal((await request(cancelPath, { group_id: 5, customerId: cancelPayload.customerId })).status, 400);
    assert.equal((await request(cancelPath, { group_id: 6 })).status, 403);
    models.PlatformAuditEvent.addHook('beforeCreate', 'http_cancel_audit', event => {
      if (JSON.parse(event.body).reason === 'enrollment_cancel_requested') throw Object.assign(Error('FICTITIOUS_AUDIT_FAILURE'), { code: 'audit_unavailable' });
    });
    assert.equal((await request(cancelPath, { group_id: 5 })).status, 503);
    assert.equal((await state(cancelId)).state, 'prepare_pending'); models.PlatformAuditEvent.removeHook('beforeCreate', 'http_cancel_audit');
    enrollmentEnabled = false;
    const cancel = await request(cancelPath, { group_id: 5 }); assert.equal(cancel.status, 202);
    assert.equal(cancel.body.state, 'revoke_pending'); assert.equal(cancel.body.canComplete, false);
    assert.equal((await request(cancelPath, { group_id: 5 })).status, 202);
    await enrollmentApi.run(); assert.equal((await state(cancelId)).state, 'revoked');
    assert.equal((await state(cancelId)).mapping_id, null); enrollmentEnabled = true;
    const cancelAudit = (await models.PlatformAuditEvent.findAll({ raw: true })).map(e => JSON.parse(e.body))
      .filter(e => e.requestRef === cancelId && e.reason === 'enrollment_cancel_requested');
    assert.equal(cancelAudit.length, 1); assert.equal(cancelAudit[0].cause, 'user_cancelled');
    assert.equal(cancelAudit[0].actor.id, '9'); assert.equal(cancelAudit[0].sessionRef, require('jsonwebtoken').decode(token).jti);
    report.checks.push('metadata capabilities never call the provider; same-session history resumes pending requests while another session cannot complete them; explicit cancellation works with enrollment disabled, rolls back failed audit and confirms once');
    env.AUTH_EMAIL_MFA_MODE = 'enforce';
    assert.equal((await request('requests/' + newId + '?group_id=5')).status, 401); env.AUTH_EMAIL_MFA_MODE = 'off';
    report.checks.push('real authenticated HTTP uses persistent session verification, strict scope/body, metadata-only resolution, idempotent enqueue and scoped status; enforcing MFA rejects the fictitious password-only session');

    const claims = require('jsonwebtoken').decode(token);
    const liveInput = { scopeKey: 'group:5', connectionId: 2, clinicIds: [59,71], actorId: 9,
      sessionRef: claims.jti, sessionExpiresAt: claims.exp * 1000 };
    const originalExecute = apiClients.client.execute; let releaseDiscovery; let readyDiscoveries; let enteredDiscoveries = 0;
    const heldDiscovery = new Promise(resolve => { releaseDiscovery = resolve; });
    const fourDiscoveries = new Promise(resolve => { readyDiscoveries = resolve; });
    apiClients.client.execute = async command => {
      if (command.operation === C.broker.OPERATIONS.discover) { if (++enteredDiscoveries === 4) readyDiscoveries(); await heldDiscovery; }
      return originalExecute(command);
    };
    const running = Array.from({ length: 4 }, () => enrollmentApi.discover(liveInput));
    try {
      await fourDiscoveries;
      assert.equal((await request('accounts?group_id=5')).status, 429); assert.equal(enteredDiscoveries, 4);
    } finally { releaseDiscovery(); await Promise.all(running); apiClients.client.execute = originalExecute; }
    const gatewayApi = require('../../services/googleAdsEnrollment.service').createGoogleAdsEnrollment({
      models: () => assert.fail('gateway cannot access enrollment SQL'), sessions, clients: apiClients,
      gateway: () => true, enabled: () => true, workerEnabled: () => true });
    assert.equal((await gatewayApi.run()).skipped, true);
    await assert.rejects(gatewayApi.discover(liveInput), { code: 'google_ads_enrollment_disabled' });
    report.checks.push('four in-flight listings exhaust admission without an unbounded queue or fifth broker call; gateway cannot run or discover enrollments even with both flags enabled');

    const inflightId = randomUUID();
    assert.equal((await request('requests', { ...payload, customerId: String(++sequence), enrollmentId: inflightId })).status, 202);
    afterRemote = async name => { if (name === 'prepare') { afterRemote = null; await sessions.revoke(token); } };
    await enrollmentApi.run(); assert.equal((await state(inflightId)).state, 'revoked');
    assert.equal((await state(inflightId)).mapping_id, null); assert.equal((await request('requests/' + inflightId + '?group_id=5')).status, 401);
    at += 30001; await enrollmentApi.run(); assert.equal((await state(newId)).state, 'revoked');
    report.checks.push('logout persisted during remote preparation prevents mapping creation, triggers independent cancellation and invalidates both later HTTP and earlier unaccepted enrollments');
  } finally { agent.destroy(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  let failAuditReason = 'enrollment_requested';
  report.phase = 'audit rollback on enqueue';
  models.PlatformAuditEvent.addHook('beforeCreate', 'enrollment_audit_rollback', event => {
    if (JSON.parse(event.body).reason === failAuditReason) throw Object.assign(Error('FICTITIOUS_AUDIT_FAILURE'), { code: 'audit_unavailable' });
  });
  const countBefore = await R.count();
  await assert.rejects(enqueue(), { code: 'audit_unavailable' }); assert.equal(await R.count(), countBefore);
  failAuditReason = null;
  report.phase = 'enqueue for scoped disconnect';
  const pendingDisconnect = await enqueue(); const disconnectModels = { ...models };
  for (const key of ['ClinicWebAsset','ClinicAnalyticsProperty','ClinicBusinessLocation','SearchConsoleBrokerBinding',
    'AnalyticsBrokerBinding','GooglePropertyBrokerRevocation','BusinessProfileBrokerBinding','BusinessProfileBrokerRevocation']) {
    disconnectModels[key] = { findAll: async () => [] }; // Other cohorts are empty in this Ads fixture.
  }
  const disconnectSession = require('jsonwebtoken').decode((await sessions.authenticated(await models.Usuario.findByPk(9))).body.token).jti;
  const disconnect = () => sql.transaction(transaction => require('../../services/oauthScopedDisconnect.service').deactivateGoogleMappingsForScope({
    models: disconnectModels, transaction, scope: { assignmentScope: 'group', groupId: 5 }, connectionId: 2,
    actorId: 9, sessionRef: disconnectSession, now: () => new Date(at) }));
  const beforeDisconnectAudit = await models.PlatformAuditEvent.count();
  process.env.GOOGLE_ADS_REVOCATION_ENABLED = 'true';
  try {
    report.phase = 'scoped disconnect audit rollback';
    failAuditReason = 'enrollment_cancel_requested';
    await assert.rejects(disconnect(), { code: 'audit_unavailable' });
    assert.equal((await state(pendingDisconnect.id)).state, 'prepare_pending');
    assert.equal(await models.GoogleAdsBrokerRevocation.count(), 0); assert.equal(await models.PlatformAuditEvent.count(), beforeDisconnectAudit);
    await unchanged();
    failAuditReason = null;
    report.phase = 'scoped disconnect commit';
    const result = await disconnect(); assert.equal(result.enrollmentPending, 1);
    assert.ok(result.brokerRevocationsPending > 0); assert.equal(result.ads, 1);
    const cancelled = await state(pendingDisconnect.id); assert.equal(cancelled.state, 'revoke_pending'); assert.equal(cancelled.mapping_id, null);
    assert.equal((await M.findByPk(oldMapping.id, { raw: true })).isActive, 0);
    assert.deepEqual(await M.findByPk(foreignRow.mapping_id, { raw: true }), foreignMapping);
    const cancellation = (await models.PlatformAuditEvent.findAll({ raw: true })).map(row => JSON.parse(row.body))
      .find(row => row.requestRef === pendingDisconnect.id && row.reason === 'enrollment_cancel_requested');
    assert.equal(cancellation.actor.type, 'user'); assert.equal(cancellation.actor.id, '9'); assert.equal(cancellation.sessionRef, disconnectSession);
    assert.equal((await enrollmentApi.disconnectionStatus([59,71])).pending_enrollments, 1);
    report.phase = 'cancel after disconnected assignment';
    await models.GoogleConnectionAssignment.update({ status: 'disconnected' }, { where: { id: 1 } });
    failAuditReason = 'enrollment_cancel_confirmed'; await enrollmentApi.run();
    assert.equal((await state(pendingDisconnect.id)).state, 'revoke_pending'); assert.equal(remote.get(pendingDisconnect.id).state, 'revoked');
    failAuditReason = null; at += 60000; await enrollmentApi.run();
    assert.equal((await state(pendingDisconnect.id)).state, 'revoked');
    assert.equal((await enrollmentApi.disconnectionStatus([59,71])).pending_enrollments, 0);
  } finally { delete process.env.GOOGLE_ADS_REVOCATION_ENABLED; models.PlatformAuditEvent.removeHook('beforeCreate', 'enrollment_audit_rollback'); }
  report.checks.push('failed audit rolls back enqueue and the entire scoped disconnect; an authorized group disconnect cancels a request with no mapping, audits its actual user and preserves foreign ownership');
  report.checks.push('independent cancellation continues after assignment disconnect; failed confirmation audit leaves retry pending and the same broker receipt is recovered without duplicate completion');
  delete report.phase;
  report.externalProviderCalls = 0; report.authenticatedUi = false;
}).catch(error => { console.error(String(error.stack || '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 7).join('\n')); process.exitCode = 1; });

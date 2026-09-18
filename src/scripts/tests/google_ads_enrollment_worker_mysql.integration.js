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
  const inputs = () => ({ scopeKey: 'group:5', connectionId: 2, clinicIds: [59,71], actorId: 9, sessionRef: randomUUID(), sessionExpiresAt: at + 3600000 });
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
  await assert.rejects(map(mappingFactory(), { replaceExisting: true }), { code: 'google_ads_enrollment_not_ready' });
  assert.equal(await models.PlatformAuditEvent.count(), 0); assert.equal(await models.GoogleAdsBrokerRevocation.count(), 0);
  assert.equal((await state(mappingRequest.id)).state, 'activate_pending'); await unchanged();
  report.checks.push('actual discovery and mapping reject an enrollment whose broker activation is unconfirmed; replacement, revocation and audit all roll back with the existing account preserved');
  at += 9000; await worker.run(); assert.equal((await state(mappingRequest.id)).state, 'activation_confirmed');
  await assert.rejects(map(mappingFactory(), { sessionRef: randomUUID() }), { code: 'google_ads_enrollment_scope_conflict' });
  assert.equal(await models.PlatformAuditEvent.count(), 0);
  const finalFailure = mappingFactory({ broker: { ...reader, assert: async (...args) => {
    await reader.assert(...args); fail('FICTITIOUS_FINAL_VALIDATION_FAILURE');
  } } });
  await assert.rejects(map(finalFailure, { replaceExisting: true }), { code: 'google_ads_mapping_unavailable' });
  const beforeAccepted = await state(mappingRequest.id); assert.equal(beforeAccepted.state, 'activation_confirmed');
  assert.equal((await M.findByPk(beforeAccepted.mapping_id, { raw: true })).isActive, 0);
  assert.equal((await B.findOne({ where: { mapping_id: beforeAccepted.mapping_id }, raw: true })).state, 'staged');
  assert.equal(await models.PlatformAuditEvent.count(), 0); assert.equal(await models.GoogleAdsBrokerRevocation.count(), 0); await unchanged();
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
  const [event] = await models.PlatformAuditEvent.findAll({ raw: true });
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
  report.externalProviderCalls = 0; report.authenticatedUi = false;
}).catch(() => { process.exitCode = 1; });

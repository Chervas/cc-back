'use strict';
// Actual MySQL journal + scope/client + signed SQLite broker; Google/AWS are
// fictitious. The fixture permits only its own Unix socket, never public data.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { DataTypes: D } = require('sequelize'); const { randomUUID, createHash } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  for (const [table, key] of [['Usuarios', 'id_usuario'], ['GruposClinicas', 'id_grupo'], ['IntakeConfigs', 'id']]) {
    await sql.getQueryInterface().createTable(table, { [key]: { type: D.INTEGER, primaryKey: true } });
  }
  const migration = require('../../../migrations/20260918110000-create-google-conversion-submissions');
  models.GoogleConversionSubmission = require('../../../models/googleconversionsubmission')(sql, D);
  for (const [name, file] of [['GoogleConnection', 'googleconnection'], ['ClinicGoogleAdsAccount', 'clinicgoogleadsaccount'],
    ['GoogleAdsBrokerBinding', 'googleadsbrokerbinding'], ['GoogleAdsBrokerRevocation', 'googleadsbrokerrevocation'],
    ['GoogleConnectionAssignment', 'googleconnectionassignment'], ['GroupAssetClinicAssignment', 'groupassetclinicassignment']]) {
    models[name] = require('../../../models/' + file)(sql, D); await models[name].sync();
  }
  models.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER,
    estado_clinica: { type: D.BOOLEAN, defaultValue: true } },
    { tableName: 'Clinicas', timestamps: false }); await models.Clinica.sync();
  await models.Clinica.bulkCreate([{ id_clinica: 59, grupoClinicaId: 5 }, { id_clinica: 71, grupoClinicaId: 5 }, { id_clinica: 99, grupoClinicaId: 6 }]);
  await sql.query('INSERT INTO GruposClinicas (id_grupo) VALUES (5),(6)');
  const configFields = { assignment_scope: D.STRING, clinic_id: D.INTEGER, group_id: D.INTEGER, config: D.JSON, domains: D.JSON, hmac_key: D.STRING };
  for (const [name, type] of Object.entries(configFields)) await sql.getQueryInterface().addColumn('IntakeConfigs', name, { type });
  models.IntakeConfig = sql.define('IntakeConfig', { id: { type: D.INTEGER, primaryKey: true }, ...configFields },
    { tableName: 'IntakeConfigs', timestamps: false });
  for (const file of ['20260711003000-create-google-ads-conversion-upload-attempts',
    '20260711012000-add-google-ads-conversion-destination-key', '20260712090000-add-data-manager-conversion-statuses']) {
    await require('../../../migrations/' + file).up(sql.getQueryInterface(), require('sequelize'));
  }
  models.GoogleAdsConversionUploadAttempt = require('../../../models/googleadsconversionuploadattempt')(sql, D);
  await sql.getQueryInterface().createTable('SequelizeMeta', { name: { type: D.STRING(255), primaryKey: true } });
  const migrationName = '20260918110000-create-google-conversion-submissions.js';
  const newMigrations = [migrationName, '20260918235000-index-google-receipt-review.js'];
  const legacyMigrations = ['20260711003000-create-google-ads-conversion-upload-attempts.js',
    '20260711012000-add-google-ads-conversion-destination-key.js', '20260712090000-add-data-manager-conversion-statuses.js'];
  await sql.getQueryInterface().bulkInsert('SequelizeMeta', legacyMigrations.map(name => ({ name })));
  const release = require('../../../ops/security/schema-contract.json');
  const contract = { version: 1, defaults: release.defaults,
    tables: Object.fromEntries(['GoogleAdsConversionUploadAttempts', 'GoogleConversionSubmissions'].map(name => [name, release.tables[name]])),
    migrations: release.migrations.filter(row => [...legacyMigrations, ...newMigrations].includes(row.name)) };
  const schema = require('../../lib/securitySchemaContract');
  const connection = await sql.connectionManager.getConnection();
  try {
    const query = async (text, values = []) => (await connection.promise().query(text, values))[0];
    const before = await schema.snapshot(query); assert.equal(schema.compare(before, contract).compatible, false);
    const required = contract.migrations.find(row => row.name === migrationName);
    assert.equal(required.sha256, createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../../../migrations', migrationName))).digest('hex'));
    const info = { revision: 'isolated-conversion-journal', contractDigest: schema.digest(contract), contract,
      migrations: Object.fromEntries(contract.migrations.map(row => [row.name, row.sha256])) };
    const plan = { version: 1, runtime: 'dev', database: 'clinicaclick_dev_isolated', revision: info.revision,
      contractDigest: info.contractDigest, beforeDigest: schema.digest(before), migrations: newMigrations.map(name => contract.migrations.find(row => row.name === name)) };
    const applied = await require('../security-schema-release').applyPlan({ connection: connection.promise(), plan, info,
      journal: () => {}, loadMigration: value => require('../../../migrations/' + value.name) });
    assert.deepEqual(applied.completed, newMigrations); assert.equal(schema.compare(await schema.snapshot(query), contract).compatible, true);
    await assert.rejects(require('../security-schema-release').applyPlan({ connection: connection.promise(), plan, info,
      journal: () => {}, loadMigration: () => assert.fail('must not repeat DDL') }), /schema_plan_stale_or_invalid/);
  } finally { await sql.connectionManager.releaseConnection(connection); }
  report.checks.push('pinned schema plan applies the journal and receipt-review index migrations, validates both tables and rejects replay of the stale plan');
  await models.GoogleConnection.create({ id: 2, googleUserId: 'fictitious-subject', accessToken: null, refreshToken: null,
    scopes: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/datamanager' });
  await models.GoogleConnection.create({ id: 3, googleUserId: 'foreign-subject', accessToken: null, refreshToken: null });
  await models.GoogleConnectionAssignment.create({ id: 100, scopeKey: 'group:5', googleConnectionId: 2, assignmentScope: 'group', grupoClinicaId: 5, status: 'active' });
  const mapping = (await models.ClinicGoogleAdsAccount.create({ id: 11, clinicaId: 59, grupoClinicaId: 5, assignmentScope: 'group',
    googleConnectionId: 2, customerId: '1234567890', loginCustomerId: '9876543210', isActive: true,
    broker_read_connection_ref: 'connection:test', broker_read_asset_ref: 'ads:1234567890' })).get({ plain: true });
  await models.GoogleAdsBrokerBinding.create({ customer_id: mapping.customerId, mapping_id: mapping.id, google_connection_id: 2,
    google_user_id: 'fictitious-subject', connection_ref: 'connection:test', asset_ref: 'ads:1234567890', scope_key: 'group:5',
    tenant_clinic_id: 59, login_customer_id: mapping.loginCustomerId, state: 'active' });
  const A = models.GoogleAdsConversionUploadAttempt, J = models.GoogleConversionSubmission;
  const C = require('../../../services/integrations-broker/src/google-data-manager-contract');
  const { adsFixture, ACCESS } = require('../../../services/integrations-broker/test/google-ads-fixture.cjs');
  const cleanups = [], f = adsFixture({ after: fn => cleanups.push(fn) });
  let at = +new Date('2026-09-18T11:00:00.000Z'), enabled = true, allowed = true, afterRemote, beforeRemote;
  let providerWrites = 0, providerMode = 'SUCCESS', tokenReads = 0; const remoteCalls = [];
  models.GoogleConnection.addHook('beforeFind', options => {
    if (!options.attributes || options.attributes.includes('accessToken') || options.attributes.includes('refreshToken')) tokenReads++;
  });
  const actionEvents = ['lead', 'qualified_lead', 'schedule'];
  f.binding.googleDataManager = { quotaProjectId: 'fictitious-project', destinations: actionEvents.map((event, index) => ({ assetRef: 'ads:1234567890',
    conversionActionId: String(456 + index), events: [event], sources: ['WEB', 'OTHER'], enhancedPolicy: null })) };
  f.policy.grants.forEach(grant => { grant.tenantRef = 'clinic:59'; });
  f.policy.grants[0].operations = [...f.policy.grants[0].operations, ...Object.values(C.OPERATIONS)];
  const sdk = { async send(command) { const result = await f.sdk.send(command);
    if (command.input.SecretId === f.binding.secretArn && result.SecretString) {
      const value = JSON.parse(result.SecretString); value.scopes.push(...C.SCOPES); result.SecretString = JSON.stringify(value);
    } return result;
  } };
  const providerDestinations = new Map(); const validations = [];
  const http = async request => {
    if (request.hostname === 'oauth2.googleapis.com') return { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/adwords ' + C.SCOPES[0] };
    assert.equal(request.token.toString(), ACCESS);
    if (request.hostname === 'googleads.googleapis.com') {
      assert.match(request.json.query, /FROM conversion_action LIMIT 5001$/);
      assert.equal(request.loginCustomerId, mapping.loginCustomerId);
      return { results: actionEvents.map((event, index) => ({ customer: { id: mapping.customerId }, conversionAction: {
        id: String(456 + index), resourceName: `customers/${mapping.customerId}/conversionActions/${456 + index}`,
        name: ['Lead - ClinicaClick', 'Qualified Lead - ClinicaClick', 'Schedule - ClinicaClick'][index],
        type: 'UPLOAD_CLICKS', category: ['SUBMIT_LEAD_FORM', 'QUALIFIED_LEAD', 'BOOK_APPOINTMENT'][index], status: 'ENABLED',
        countingType: 'MANY_PER_CLICK', primaryForGoal: false, includeInConversionsMetric: false } })) };
    }
    assert.equal(request.hostname, 'datamanager.googleapis.com');
    if (request.path === '/v1/events:ingest') {
      if (request.json.validateOnly) { validations.push(structuredClone(request.json)); return {}; }
      providerWrites++; const id = 'fictitious-receipt-' + providerWrites;
      providerDestinations.set(id, request.json.destinations[0].productDestinationId); return { requestId: id };
    }
    assert.match(request.path, /^\/v1\/requestStatus:retrieve\?requestId=fictitious-receipt-/);
    return providerMode === 'EMPTY' ? {} : { requestStatusPerDestination: [{ destination: {
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: mapping.customerId },
      loginAccount: { accountType: 'GOOGLE_ADS', accountId: mapping.loginCustomerId }, productDestinationId: providerDestinations.get(request.path.split('requestId=')[1]) || '456' },
    requestStatus: providerMode, eventsIngestionStatus: { recordCount: '1' } }] };
  };
  const runtime = require('../../../services/integrations-broker/src/google-main');
  const secrets = require('../../../services/integrations-broker/src/google-secrets').createGoogleSecretStore({ client: sdk, http,
    accountId: runtime.ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtime.SECRET_KEY, provider: C.PROVIDER, now: () => at });
  let store = f.store;
  const adsEngine = require('../../../services/integrations-broker/src/google-ads').createGoogleAdsOperations({ http,
    cursor: require('../../../services/integrations-broker/src/provider-cursor').cursorCodec(require('node:crypto').randomBytes(32), () => at),
    withDeveloperSecret: require('../../../services/integrations-broker/src/google-ads-developer-secret').createGoogleAdsDeveloperSecret({
      client: sdk, accountId: runtime.ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtime.SECRET_KEY }), now: () => at });
  const makeRemote = () => new (require('../../../services/integrations-broker/src/broker').Broker)({ store, policy: f.policy, secrets,
    operations: { ...adsEngine.operations, ...require('../../../services/integrations-broker/src/google-data-manager').createDataManagerOperations({ store, http, now: () => at }).operations },
    now: () => at });
  let remote = makeRemote();
  const transport = { execute: async command => {
    remoteCalls.push(structuredClone(command)); await beforeRemote?.(command);
    const signed = require('../../../services/integrations-broker/src/auth').signRequest(command, {
      keyId: 'qa-key', privateKey: f.keys.privateKey, audience: f.policy.audience, now: at });
    const result = await remote.execute(signed.raw, signed.headers); await afterRemote?.(command); return result;
  } };
  const broker = require('../../services/googleAdsBroker.service').createGoogleAdsBroker({
    ...require('../../services/googleAdsBrokerScope.service').createGoogleAdsScopeRepository(() => models),
    client: transport, enabled: () => true, conversionsEnabled: () => enabled, now: () => at });
  const context = await broker.prepare(mapping);
  const deliveryIdentity = { audience: f.policy.audience, keyId: 'qa-key' }, activeSince = '2026-09-18T10:59:00.000Z';
  const makeRepository = extra => require('../../services/googleConversionSubmission.repository').createGoogleConversionSubmissionRepository({
    models, assertContext: broker.assert, deliveryIdentity, activeSince, now: () => new Date(at), ...extra });
  let repository = makeRepository();
  const makeDelivery = () => require('../../services/googleConversionDelivery.service').createGoogleConversionDelivery({ repository, broker, enabled: () => enabled });
  let delivery = makeDelivery();
  const fail = code => { throw Object.assign(Error('FICTITIOUS-PRIVATE-DETAIL'), { code }); };
  const input = async patch => {
    const dedupeKey = createHash('sha256').update(randomUUID()).digest('hex'), eventId = randomUUID();
    const payload = { conversionActionId: '456', eventName: 'lead', eventSource: 'WEB', event: {
      timestamp: new Date(at).toISOString(), transactionId: eventId, value: 5, currency: 'EUR', advertisingConsent: 'GRANTED',
      adUserData: 'GRANTED', adPersonalization: 'DENIED', clickId: { type: 'gclid', value: 'FICTITIOUS-CLICK' },
      userIdentifiers: [], enhancedPolicyDigest: null } };
    const attempt = await A.create({ dedupeKey, clinicaId: 59, grupoClinicaId: 5, assignmentScope: 'group', googleConnectionId: 2,
      googleConnectionAssignmentId: 100, customerId: mapping.customerId, loginCustomerId: mapping.loginCustomerId,
      conversionAction: 'customers/' + mapping.customerId + '/conversionActions/456', eventName: 'lead', eventId,
      clickIdType: 'gclid', clickIdHash: createHash('sha256').update('FICTITIOUS-CLICK').digest('hex'), consentStatus: 'GRANTED',
      status: 'pending', attemptCount: 1, attemptedAt: new Date(at), created_at: new Date(at), updated_at: new Date(at),
      requestMetadata: { currency: 'EUR', value_amount: 5, user_identifier_count: 0,
        explicit_ad_user_data_consent_status: 'GRANTED', visitor_ad_personalization_consent_status: 'DENIED' }, ...patch });
    return { account: mapping, context, attemptId: attempt.id, dedupeKey, payload, beforeExecute: async () => allowed };
  };
  const identity = (value, receipt) => ({ account: mapping, context, attemptId: value.attemptId, submissionId: receipt.submissionId, beforeExecute: value.beforeExecute });
  const row = id => J.findByPk(id, { raw: true });
  const attempt = id => A.findByPk(id, { raw: true });
  try {
    const first = await input(); const receipts = await Promise.all(Array.from({ length: 5 }, () => repository.reserve(first)));
    assert.equal(new Set(receipts.map(r => r.submissionId)).size, 1); assert.equal(await J.count(), 1);
    assert.equal((await attempt(first.attemptId)).requestMetadata.broker_submission_id, receipts[0].submissionId);
    assert.equal(providerWrites, 0);
    report.checks.push('five concurrent reservations converge on one UUID and one atomic marker without provider calls');
    const modified = structuredClone(first.payload); modified.event.value++;
    await assert.rejects(repository.reserve({ ...first, payload: modified }), { code: 'idempotency_conflict' });
    await assert.rejects(repository.reserve({ ...first, context: {} }), { code: 'broker_binding_invalid' });
    const foreign = await input();
    await assert.rejects(repository.reserve({ ...foreign, dedupeKey: first.dedupeKey }), { code: 'conversion_submission_conflict' });
    report.checks.push('changed payload, forged context and another audit attempt cannot acquire a prior UUID');
    const sent = await Promise.all(Array.from({ length: 5 }, () => delivery.submit(first)));
    assert.equal(sent.filter(r => r.dispatch).length, 1); assert.equal(providerWrites, 1);
    assert.equal((await row(receipts[0].submissionId)).state, 'accepted'); assert.equal((await attempt(first.attemptId)).status, 'accepted');
    assert.equal((await delivery.submit(first)).dispatch, false); assert.equal(providerWrites, 1);
    report.checks.push('five concurrent senders issue one signed ingest and preserve the accepted result on repetition');

    const lost = await input(); afterRemote = command => { if (command.operation === C.OPERATIONS.ingest) { afterRemote = null; fail('broker_timeout'); } };
    await assert.rejects(delivery.submit(lost), { code: 'broker_timeout' });
    const lostReceipt = await J.findOne({ where: { attempt_id: lost.attemptId }, raw: true });
    assert.equal(lostReceipt.state, 'unknown'); assert.equal((await attempt(lost.attemptId)).reason, 'broker_outcome_unknown');
    const writes = providerWrites;
    store.close(); store = new (require('../../../services/integrations-broker/src/store').BrokerStore)(f.filename); remote = makeRemote();
    repository = makeRepository(); delivery = makeDelivery();
    assert.equal((await delivery.submit(lost)).dispatch, false); assert.equal(providerWrites, writes);
    providerMode = 'EMPTY'; const recovered = await delivery.reconcile(identity(lost, { submissionId: lostReceipt.submission_id }));
    assert.equal(recovered.state, 'accepted'); assert.equal(recovered.providerRequestId,
      store.db.prepare('SELECT provider_id FROM google_data_manager_receipts WHERE id=?').get(lostReceipt.submission_id).provider_id);
    assert.equal((await attempt(lost.attemptId)).status, 'accepted');
    providerMode = 'SUCCESS'; assert.equal((await delivery.reconcile(identity(lost, recovered))).state, 'succeeded');
    assert.equal(providerWrites, writes);
    const processing = { submissionId: recovered.submissionId, requestId: recovered.providerRequestId, requestStatusPerDestination: [] };
    assert.equal((await repository.reconcile(identity(lost, recovered), processing)).state, 'succeeded');
    const health = require('../../services/campaignWorkspaceGoogleSignalEvidence.service').googleDeliveryEvidence([await attempt(lost.attemptId)], new Date(at));
    assert.equal(health.checked, true); assert.equal(health.processed, 1);
    report.checks.push('lost CRM ACK survives reconstructed service and physical SQLite reopen; status recovers acceptance/success without another ingest or terminal downgrade');

    const dropped = await input(); beforeRemote = command => { if (command.operation === C.OPERATIONS.ingest) fail('broker_unavailable'); };
    await assert.rejects(delivery.submit(dropped), { code: 'broker_unavailable' }); beforeRemote = null;
    const droppedReceipt = await J.findOne({ where: { attempt_id: dropped.attemptId }, raw: true });
    await assert.rejects(delivery.reconcile(identity(dropped, { submissionId: droppedReceipt.submission_id })), { code: 'scope_denied' });
    assert.equal((await delivery.submit(dropped)).dispatch, false); assert.equal(providerWrites, writes);
    report.checks.push('transport failure before remote receipt stays unknown; absence of a receipt never authorizes an automatic resend');

    const commitLost = await input(); let commitFail = true;
    A.addHook('afterUpdate', 'fictitious_commit_failure', value => {
      if (commitFail && value.status === 'accepted') { commitFail = false; fail('FICTITIOUS_SQL_FAILURE'); }
    });
    await assert.rejects(delivery.submit(commitLost), { code: 'google_data_manager_broker_failed' });
    A.removeHook('afterUpdate', 'fictitious_commit_failure');
    const broken = await J.findOne({ where: { attempt_id: commitLost.attemptId }, raw: true });
    assert.equal(broken.state, 'unknown'); assert.equal(broken.provider_request_id, null); assert.equal((await attempt(commitLost.attemptId)).status, 'pending');
    const beforeRecovery = providerWrites;
    assert.equal((await delivery.reconcile(identity(commitLost, { submissionId: broken.submission_id }))).state, 'succeeded');
    assert.equal(providerWrites, beforeRecovery);
    report.checks.push('local ACK and legacy-attempt updates roll back atomically; status reconciles provider acceptance after SQL failure');

    const diskLost = await input();
    A.addHook('afterUpdate', 'fictitious_persistence_failure', value => {
      if (value.id === diskLost.attemptId && (value.status === 'accepted' || value.reason === 'broker_outcome_unknown')) fail('FICTITIOUS_SQL_FAILURE');
    });
    await assert.rejects(delivery.submit(diskLost), { code: 'conversion_receipt_persistence_failed' });
    A.removeHook('afterUpdate', 'fictitious_persistence_failure');
    const diskRow = await J.findOne({ where: { attempt_id: diskLost.attemptId }, raw: true }); assert.equal(diskRow.state, 'attempted');
    const diskWrites = providerWrites;
    assert.equal((await delivery.submit(diskLost)).dispatch, false);
    assert.equal((await delivery.reconcile(identity(diskLost, { submissionId: diskRow.submission_id }))).state, 'succeeded');
    assert.equal(providerWrites, diskWrites);
    report.checks.push('failure of both local ACK and uncertainty updates still leaves the pre-call attempted marker and prevents retransmission');

    const reserveLost = await input(); const beforeCount = await J.count();
    A.addHook('afterUpdate', 'fictitious_reservation_failure', value => { if (value.id === reserveLost.attemptId) fail('FICTITIOUS_SQL_FAILURE'); });
    await assert.rejects(repository.reserve(reserveLost)); A.removeHook('afterUpdate', 'fictitious_reservation_failure');
    assert.equal(await J.count(), beforeCount); assert.equal((await attempt(reserveLost.attemptId)).requestMetadata.broker_submission_id, undefined);
    report.checks.push('failed reservation leaves neither journal identity nor a partial legacy marker');

    for (const patch of [{ status: 'failed' }, { status: 'accepted', providerRequestId: 'old-provider' }, { attemptCount: 2 },
      { created_at: new Date('2026-09-18T10:58:00Z') }, { attemptedAt: new Date('2026-09-18T10:58:00Z') }]) {
      await assert.rejects(repository.reserve(await input(patch)), { code: 'conversion_history_not_eligible' });
    }
    const historicalEvent = await input(); historicalEvent.payload.event.timestamp = '2026-09-18T10:58:00.000Z';
    await assert.rejects(repository.reserve(historicalEvent), { code: 'conversion_history_not_eligible' });
    report.checks.push('pre-cut events/audit rows, old pending attempts, failures and previously accepted legacy deliveries are not adopted or replayed');

    for (const patch of [{ consentStatus: 'DENIED' }, { customerId: '1111111111' }, { googleConnectionId: 3 },
      { clinicaId: 99 }, { grupoClinicaId: 6 }, { conversionAction: 'customers/1234567890/conversionActions/999' },
      { clickIdHash: 'b'.repeat(64) }, { eventId: 'foreign-event' }]) {
      await assert.rejects(repository.reserve(await input(patch)), { code: 'conversion_submission_conflict' });
    }
    report.checks.push('the original audit scope, destination, consent and click digest must match the typed command');
    const paused = await input(); const beforePaused = await J.count(); allowed = false;
    await assert.rejects(delivery.submit(paused), { code: 'conversion_paused' }); allowed = true;
    enabled = false; await assert.rejects(delivery.submit(paused), { code: 'broker_cohort_disabled' }); enabled = true;
    assert.equal(await J.count(), beforePaused);
    report.checks.push('clinical pause and disabled conversions stop before reservation or provider access');

    const revoked = await input();
    afterRemote = async command => { if (command.operation === C.OPERATIONS.ingest) {
      afterRemote = null; await models.GoogleConnectionAssignment.update({ status: 'disconnected' }, { where: { id: 100 } });
    } };
    await assert.rejects(delivery.submit(revoked), { code: 'scope_denied' });
    const revokedRow = await J.findOne({ where: { attempt_id: revoked.attemptId }, raw: true }); assert.equal(revokedRow.state, 'unknown');
    await assert.rejects(delivery.reconcile(identity(revoked, { submissionId: revokedRow.submission_id })), { code: 'scope_denied' });
    await models.GoogleConnectionAssignment.update({ status: 'active' }, { where: { id: 100 } });
    const beforeRestore = providerWrites;
    assert.equal((await delivery.reconcile(identity(revoked, { submissionId: revokedRow.submission_id }))).state, 'succeeded');
    assert.equal(providerWrites, beforeRestore);
    report.checks.push('revocation during a remote call prevents acceptance locally; uncertainty remains durable and later status never repeats the delivery');

    await assert.rejects(makeRepository({ deliveryIdentity: { ...deliveryIdentity, keyId: 'foreign-key' } }).inspect(identity(first, receipts[0])),
      { code: 'conversion_submission_conflict' });
    await assert.rejects(makeRepository({ activeSince: '2026-09-18T10:58:00.000Z' }).inspect(identity(first, receipts[0])),
      { code: 'conversion_submission_conflict' });
    report.checks.push('a different signer audience/key or changed cutover boundary cannot reuse persisted submission identity');

    const legacy = require('../../services/googleAdsConversionUpload.service');
    for (const value of [first, lost, dropped, commitLost]) {
      await assert.rejects(legacy.prepareAuditRow({ auditModel: A, values: { dedupeKey: value.dedupeKey }, status: 'pending' }),
        { code: 'GOOGLE_CONVERSION_BROKER_RESERVED' });
    }
    report.checks.push('reserved attempts cannot fall back to the legacy five-minute retry path');

    let legacyRead = 0;
    await assert.rejects(legacy.prepareAuditRow({ auditModel: {
      findOne: options => ++legacyRead === 1 ? null : A.findOne(options),
      create: async () => { throw Object.assign(Error('fictitious insert collision'), { name: 'SequelizeUniqueConstraintError' }); }
    }, values: { dedupeKey: first.dedupeKey }, status: 'pending' }), { code: 'GOOGLE_CONVERSION_BROKER_RESERVED' });
    assert.equal(legacyRead, 2);

    const failed = await input(); const failedReceipt = await delivery.submit(failed); providerMode = 'FAILED';
    assert.equal((await delivery.reconcile(identity(failed, failedReceipt))).state, 'failed'); providerMode = 'SUCCESS';
    const failedWrites = providerWrites;
    assert.equal((await delivery.submit(failed)).state, 'failed'); assert.equal(providerWrites, failedWrites);
    const failedAttempt = await attempt(failed.attemptId); assert.equal(failedAttempt.history.length, 1);
    assert.equal(failedAttempt.history[0].status, 'accepted');
    report.checks.push('a terminal Google rejection remains failed with audit history and never becomes a fresh delivery attempt');

    const expired = await input(), expiredReceipt = await repository.reserve(expired), oldAt = at; at += 300001;
    await assert.rejects(repository.begin({ ...identity(expired, expiredReceipt), payload: expired.payload }), { code: 'conversion_history_not_eligible' });
    at = oldAt; assert.equal((await row(expiredReceipt.submissionId)).state, 'prepared');
    report.checks.push('a prepared request cannot wake after a long pause and emit an old conversion');

    const scoped = require('../../services/googleAdsScopedRuntime.service').resolveScopedGoogleAdsRuntime;
    const resolveRuntime = options => scoped({ ...options, accountModel: models.ClinicGoogleAdsAccount,
      connectionModel: models.GoogleConnection, broker, credentials: { load: () => assert.fail('must not hydrate legacy credentials') },
      ensureAccessToken: () => assert.fail('must not refresh legacy OAuth') });
    const scopedArgs = { clinicId: 71, groupId: 5, assignmentScope: 'clinic', customerId: mapping.customerId,
      requiredScopes: [C.SCOPES[0]] };
    const managedRuntime = await resolveRuntime(scopedArgs);
    assert.equal(managedRuntime.deliveryMode, 'broker'); assert(!Object.hasOwn(managedRuntime, 'accessToken'));
    assert.deepEqual(Object.keys(managedRuntime.connection).sort(), ['googleUserId', 'id', 'scopes']);
    await assert.rejects(resolveRuntime({ ...scopedArgs, clinicId: 99 }), { code: 'scope_denied' });
    report.checks.push('actual scoped resolver uses the durable Ads scope without local tokens and rejects a foreign clinic under a group mapping');

    const cfg = await models.IntakeConfig.create({ id: 1, assignment_scope: 'clinic', clinic_id: 71, group_id: 5,
      config: { features: { consent_mode_enabled: true }, google_ads: { enabled: true, customer_id: mapping.customerId,
        events: { lead: { enabled: true, conversion_action_id: '456', currency: 'EUR', value: 5 } } } } });
    Object.assign(process.env, { GOOGLE_ADS_BROKER_AUDIENCE: deliveryIdentity.audience,
      GOOGLE_ADS_BROKER_KEY_ID: deliveryIdentity.keyId, GOOGLE_ADS_CONVERSIONS_ACTIVE_SINCE: activeSince });
    const web = eventId => ({ cfgRecord: cfg, eventName: 'lead', eventId, clinicId: 71, groupId: 5, assignmentScope: 'clinic',
      consent: { marketing: true, ad_user_data: 'granted', ad_personalization: 'denied' },
      customData: { gclid: 'FICTITIOUS-CLICK' }, dependencies: { models, auditModel: A, resolveRuntime,
        uploadConversion: () => assert.fail('must not send using a local token'),
        brokerEnabled: () => enabled, now: () => new Date(at) } });
    const freshWeb = web(randomUUID()), writesBeforeWeb = providerWrites;
    const webResults = await Promise.all(Array.from({ length: 5 }, () => legacy.maybeUploadGoogleConversion(freshWeb)));
    assert.equal(webResults.filter(r => r.sent).length, 1); assert.equal(providerWrites, writesBeforeWeb + 1);
    assert.equal(new Set(webResults.map(r => r.audit_id)).size, 1);
    const webAttempt = await attempt(webResults[0].audit_id);
    assert.equal(webAttempt.assignmentScope, 'clinic'); assert.equal(webAttempt.clinicaId, 71);
    assert.equal(webAttempt.attemptCount, 1); assert.equal(webAttempt.requestMetadata.explicit_ad_user_data_consent_status, 'GRANTED');
    assert.equal(webAttempt.requestMetadata.visitor_ad_personalization_consent_status, 'DENIED');
    assert.equal(webAttempt.requestMetadata.broker_delivery_version, 1);
    assert.equal((await legacy.maybeUploadGoogleConversion(freshWeb)).accepted, true);
    assert.equal(providerWrites, writesBeforeWeb + 1);
    report.checks.push('real business upload plus actual scoped resolver, SQL and signed broker emits once under concurrent clinic events with group grants; explicit DENIED signals and audit scope are preserved');

    const webLost = web(randomUUID()); afterRemote = command => { if (command.operation === C.OPERATIONS.ingest) { afterRemote = null; fail('broker_timeout'); } };
    await assert.rejects(legacy.maybeUploadGoogleConversion(webLost), { code: 'broker_timeout' });
    const webLostWrites = providerWrites, repeatLost = await legacy.maybeUploadGoogleConversion(webLost);
    assert.equal(repeatLost.sent, false); assert.equal(repeatLost.accepted, false); assert.equal(repeatLost.unknown_count, 1);
    assert.equal(repeatLost.skipped_count, 0); assert.equal(providerWrites, webLostWrites);
    const recoveredWeb = await delivery.reconcile({ account: managedRuntime.account, context: managedRuntime.brokerContext,
      attemptId: repeatLost.audit_id, submissionId: repeatLost.submission_id, beforeExecute: async () => true });
    assert.equal(recoveredWeb.state, 'succeeded');
    assert.equal((await legacy.maybeUploadGoogleConversion(webLost)).reason, 'duplicate_already_succeeded');
    assert.equal(providerWrites, webLostWrites);
    const originalNow = at; at += 600000;
    assert.equal((await legacy.maybeUploadGoogleConversion(webLost)).reason, 'duplicate_already_succeeded');
    assert.equal(providerWrites, webLostWrites); at = originalNow;
    report.checks.push('business-path lost ACK stays explicitly unknown, is not counted as skipped or accepted, and recovers by receipt without another ingest');

    const gapWeb = web(randomUUID()); let gapAttempt;
    gapWeb.dependencies.auditModel = { findOne: options => A.findOne(options), create: async values => {
      const row = await A.create(values); gapAttempt = row;
      await assert.rejects(legacy.prepareAuditRow({ auditModel: A, values, status: 'pending' }), { code: 'GOOGLE_CONVERSION_BROKER_RESERVED' });
      fail('broker_timeout');
    } };
    const beforeGap = providerWrites;
    await assert.rejects(legacy.maybeUploadGoogleConversion(gapWeb), { code: 'broker_timeout' });
    assert(!gapAttempt.requestMetadata.broker_submission_id); assert.equal(providerWrites, beforeGap);
    gapWeb.dependencies.auditModel = A;
    assert.equal((await legacy.maybeUploadGoogleConversion(gapWeb)).sent, true);
    assert.equal(providerWrites, beforeGap + 1);
    report.checks.push('insert-time managed marker blocks legacy before UUID reservation; a crash before reservation can continue only the same fresh business attempt');

    const guardEvent = web(randomUUID()); const guardCount = await A.count(); const guardWrites = providerWrites;
    enabled = false; await assert.rejects(legacy.maybeUploadGoogleConversion(guardEvent), { code: 'broker_cohort_disabled' }); enabled = true;
    await models.Clinica.update({ estado_clinica: false }, { where: { id_clinica: 71 } });
    await assert.rejects(legacy.maybeUploadGoogleConversion(guardEvent), { code: 'conversion_paused' });
    await models.Clinica.update({ estado_clinica: true }, { where: { id_clinica: 71 } });
    const changedConfig = structuredClone(cfg.config); changedConfig.google_ads.enabled = false;
    await models.IntakeConfig.update({ config: changedConfig }, { where: { id: cfg.id } });
    await assert.rejects(legacy.maybeUploadGoogleConversion(guardEvent), { code: 'conversion_paused' });
    await models.IntakeConfig.update({ config: cfg.config }, { where: { id: cfg.id } });
    assert.equal(await A.count(), guardCount); assert.equal(providerWrites, guardWrites);
    report.checks.push('real clinic pause, disabled conversion flag and changed SQL tracking configuration stop before creating an attempt or reaching the provider');

    const foreignCfg = await models.IntakeConfig.create({ id: 2, assignment_scope: 'clinic', clinic_id: 59, group_id: 5, config: cfg.config });
    await assert.rejects(legacy.maybeUploadGoogleConversion({ ...web(randomUUID()), cfgRecord: foreignCfg }), { code: 'scope_denied' });
    assert.equal(await A.count(), guardCount); assert.equal(providerWrites, guardWrites);
    report.checks.push('a sibling clinic tracking record cannot authorize an event merely because the Ads grant is shared by the group');

    const mutatedWeb = web(randomUUID()); afterRemote = async command => {
      if (command.operation === C.OPERATIONS.ingest) { afterRemote = null;
        await models.IntakeConfig.update({ config: changedConfig }, { where: { id: cfg.id } }); }
    };
    await assert.rejects(legacy.maybeUploadGoogleConversion(mutatedWeb), { code: 'conversion_paused' });
    const mutatedWrites = providerWrites;
    await models.IntakeConfig.update({ config: cfg.config }, { where: { id: cfg.id } });
    assert.equal((await legacy.maybeUploadGoogleConversion(mutatedWeb)).reason, 'broker_outcome_unknown');
    assert.equal(providerWrites, mutatedWrites);
    report.checks.push('tracking configuration changed during delivery leaves durable uncertainty and never re-enters legacy or sends again');

    const deniedWeb = web(randomUUID()); deniedWeb.consent.ad_user_data = 'denied';
    const deniedWrites = providerWrites;
    assert.equal((await legacy.maybeUploadGoogleConversion(deniedWeb)).reason, 'consent_not_granted');
    assert.equal(providerWrites, deniedWrites);
    report.checks.push('the existing business consent gate still rejects explicit ad-user-data denial even with generic marketing consent');

    const collisionWeb = web(randomUUID()); let oldAttempt;
    collisionWeb.dependencies.auditModel = { findOne: options => A.findOne(options), create: async values => {
      const metadata = { ...values.requestMetadata }; delete metadata.broker_delivery_version;
      oldAttempt = await A.create({ ...values, requestMetadata: metadata, status: 'failed' });
      throw Object.assign(Error('fictitious legacy insert race'), { name: 'SequelizeUniqueConstraintError' });
    } };
    const oldWrites = providerWrites;
    await assert.rejects(legacy.maybeUploadGoogleConversion(collisionWeb), { code: 'conversion_history_not_eligible' });
    assert.equal((await attempt(oldAttempt.id)).status, 'failed'); assert.equal(providerWrites, oldWrites);
    report.checks.push('an insertion race with a failed legacy attempt cannot adopt that row, reset history or emit through the broker');

    const configWeb = web(randomUUID()); const beforeConfig = await A.count();
    delete process.env.GOOGLE_ADS_CONVERSIONS_ACTIVE_SINCE;
    await assert.rejects(legacy.maybeUploadGoogleConversion(configWeb), { code: 'broker_configuration_invalid' });
    process.env.GOOGLE_ADS_CONVERSIONS_ACTIVE_SINCE = activeSince;
    assert.equal(await A.count(), beforeConfig);
    report.checks.push('the production coordinator factory requires a configured stable cutover before creating any attempt');

    const clickOnly = await input();
    await A.update({ requestMetadata: { ...(await attempt(clickOnly.attemptId)).requestMetadata,
      enhanced_conversion_authorization_digest: 'a'.repeat(64) } }, { where: { id: clickOnly.attemptId } });
    assert.equal((await delivery.submit(clickOnly)).state, 'accepted');
    report.checks.push('a configured enhanced authorization does not block a click-only event with no personal hashes');

    await require('./fixtures/google_workspace_broker_checks.fixture')({ models, sql, report, broker, delivery, mapping,
      now: () => new Date(at), writes: () => providerWrites, calls: () => remoteCalls.length, validations,
      setAfterRemote: fn => { afterRemote = fn; }, setBeforeRemote: fn => { beforeRemote = fn; },
      setProviderMode: value => { providerMode = value; } });

    await require('./fixtures/google_receipt_review_checks.fixture')({ models, sql, report, broker, mapping, context,
      input, repository, delivery, deliveryIdentity, activeSince, now: () => at });

    const table = 'GoogleConversionSubmissions';
    const query = async (text, values = []) => { const [rows] = await sql.query(text, { replacements: values }); return rows; };
    const metadata = await require('../../lib/securitySchemaContract').snapshot(query);
    const t = metadata.tables.find(v => v.TABLE_NAME === table), columns = metadata.columns.filter(v => v.TABLE_NAME === table), indexes = metadata.indexes.filter(v => v.TABLE_NAME === table);
    const observed = { ENGINE: t.ENGINE, TABLE_COLLATION: t.TABLE_COLLATION, columns: columns.map(({ TABLE_NAME, ...v }) => v),
      indexes: [...new Set(indexes.map(v => v.INDEX_NAME))].map(name => ({ name, columns: indexes.filter(v => v.INDEX_NAME === name).map(({ TABLE_NAME, ...v }) => v) })),
      checks: metadata.checks.filter(v => v.TABLE_NAME === table).map(({ TABLE_NAME, ...v }) => v) };
    fs.writeFileSync(path.join(report.root, 'google-conversion-schema.json'), JSON.stringify(observed, null, 2), { mode: 0o600 });
    const legacyTable = 'GoogleAdsConversionUploadAttempts'; const legacyMetadata = metadata.tables.find(v => v.TABLE_NAME === legacyTable);
    const legacyIndexes = metadata.indexes.filter(v => v.TABLE_NAME === legacyTable);
    fs.writeFileSync(path.join(report.root, 'google-conversion-attempt-schema.json'), JSON.stringify({ ENGINE: legacyMetadata.ENGINE,
      TABLE_COLLATION: legacyMetadata.TABLE_COLLATION, columns: metadata.columns.filter(v => v.TABLE_NAME === legacyTable).map(({ TABLE_NAME, ...v }) => v),
      indexes: [...new Set(legacyIndexes.map(v => v.INDEX_NAME))].map(name => ({ name,
        columns: legacyIndexes.filter(v => v.INDEX_NAME === name).map(({ TABLE_NAME, ...v }) => v) })), checks: [] }, null, 2), { mode: 0o600 });
    assert.equal(observed.checks.length, 3); assert(observed.checks.every(v => v.ENFORCED === 'YES'));
    assert.equal(schema.compare(metadata, contract).compatible, true);
    await sql.query('ALTER TABLE GoogleConversionSubmissions ALTER CHECK cc_google_conversion_attempt NOT ENFORCED');
    assert.equal(schema.compare(await schema.snapshot(query), contract).compatible, false);
    await sql.query('ALTER TABLE GoogleConversionSubmissions ALTER CHECK cc_google_conversion_attempt ENFORCED');
    for (const patch of ["state='prepared'", 'acknowledged_at=NULL', 'completed_at=NOW(3)']) {
      await assert.rejects(sql.query('UPDATE GoogleConversionSubmissions SET ' + patch + ' WHERE submission_id=?', { replacements: [receipts[0].submissionId] }),
        error => error.original?.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
    }
    await assert.rejects(migration.down(sql.getQueryInterface()), /Preserve conversion identities/);
    assert.equal(tokenReads, 0);
    const journalDump = JSON.stringify(await J.findAll({ raw: true }));
    for (const sentinel of ['FICTITIOUS-CLICK', ACCESS, 'FICTITIOUS_REFRESH', 'FICTITIOUS-PRIVATE-DETAIL']) assert(!journalDump.includes(sentinel));
    assert(!journalDump.includes(first.payload.event.transactionId));
    report.checks.push('real CHECKs reject invalid lifecycle states, down preserves history, SQL credential hydration is zero and ledger stores no click/body/token/provider error text');
    report.providerWrites = providerWrites; report.signedBrokerCalls = remoteCalls.length; report.submissions = await J.count();
  } finally {
    adsEngine.close(); secrets.close(); if (store !== f.store) store.close();
    for (const close of cleanups.reverse()) await close();
  }
}).catch(() => { process.exitCode = 1; });

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
  models.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER },
    { tableName: 'Clinicas', timestamps: false }); await models.Clinica.sync();
  await models.Clinica.bulkCreate([{ id_clinica: 59, grupoClinicaId: 5 }, { id_clinica: 71, grupoClinicaId: 5 }, { id_clinica: 99, grupoClinicaId: 6 }]);
  await sql.query('INSERT INTO GruposClinicas (id_grupo) VALUES (5),(6)');
  for (const file of ['20260711003000-create-google-ads-conversion-upload-attempts',
    '20260711012000-add-google-ads-conversion-destination-key', '20260712090000-add-data-manager-conversion-statuses']) {
    await require('../../../migrations/' + file).up(sql.getQueryInterface(), require('sequelize'));
  }
  models.GoogleAdsConversionUploadAttempt = require('../../../models/googleadsconversionuploadattempt')(sql, D);
  await sql.getQueryInterface().createTable('SequelizeMeta', { name: { type: D.STRING(255), primaryKey: true } });
  const migrationName = '20260918110000-create-google-conversion-submissions.js';
  const legacyMigrations = ['20260711003000-create-google-ads-conversion-upload-attempts.js',
    '20260711012000-add-google-ads-conversion-destination-key.js', '20260712090000-add-data-manager-conversion-statuses.js'];
  await sql.getQueryInterface().bulkInsert('SequelizeMeta', legacyMigrations.map(name => ({ name })));
  const release = require('../../../ops/security/schema-contract.json');
  const contract = { version: 1, defaults: release.defaults,
    tables: Object.fromEntries(['GoogleAdsConversionUploadAttempts', 'GoogleConversionSubmissions'].map(name => [name, release.tables[name]])),
    migrations: release.migrations.filter(row => [...legacyMigrations, migrationName].includes(row.name)) };
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
      contractDigest: info.contractDigest, beforeDigest: schema.digest(before), migrations: [required] };
    const applied = await require('../security-schema-release').applyPlan({ connection: connection.promise(), plan, info,
      journal: () => {}, loadMigration: () => migration });
    assert.deepEqual(applied.completed, [migrationName]); assert.equal(schema.compare(await schema.snapshot(query), contract).compatible, true);
    await assert.rejects(require('../security-schema-release').applyPlan({ connection: connection.promise(), plan, info,
      journal: () => {}, loadMigration: () => assert.fail('must not repeat DDL') }), /schema_plan_stale_or_invalid/);
  } finally { await sql.connectionManager.releaseConnection(connection); }
  report.checks.push('pinned schema plan applies only the new journal migration, validates both tables and rejects replay of the stale plan');
  await models.GoogleConnection.create({ id: 2, googleUserId: 'fictitious-subject', accessToken: null, refreshToken: null });
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
  f.binding.googleDataManager = { quotaProjectId: 'fictitious-project', destinations: [{ assetRef: 'ads:1234567890',
    conversionActionId: '456', events: ['lead'], sources: ['WEB', 'OTHER'], enhancedPolicy: null }] };
  f.policy.grants.forEach(grant => { grant.tenantRef = 'clinic:59'; });
  f.policy.grants[0].operations = [...f.policy.grants[0].operations, ...Object.values(C.OPERATIONS)];
  const sdk = { async send(command) { const result = await f.sdk.send(command);
    if (command.input.SecretId === f.binding.secretArn && result.SecretString) {
      const value = JSON.parse(result.SecretString); value.scopes.push(...C.SCOPES); result.SecretString = JSON.stringify(value);
    } return result;
  } };
  const http = async request => {
    if (request.hostname === 'oauth2.googleapis.com') return { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/adwords ' + C.SCOPES[0] };
    assert.equal(request.hostname, 'datamanager.googleapis.com'); assert.equal(request.token.toString(), ACCESS);
    if (request.path === '/v1/events:ingest') { providerWrites++; return { requestId: 'fictitious-receipt-' + providerWrites }; }
    assert.match(request.path, /^\/v1\/requestStatus:retrieve\?requestId=fictitious-receipt-/);
    return providerMode === 'EMPTY' ? {} : { requestStatusPerDestination: [{ destination: {
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: mapping.customerId },
      loginAccount: { accountType: 'GOOGLE_ADS', accountId: mapping.loginCustomerId }, productDestinationId: '456' },
    requestStatus: providerMode, eventsIngestionStatus: { recordCount: '1' } }] };
  };
  const runtime = require('../../../services/integrations-broker/src/google-main');
  const secrets = require('../../../services/integrations-broker/src/google-secrets').createGoogleSecretStore({ client: sdk, http,
    accountId: runtime.ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtime.SECRET_KEY, provider: C.PROVIDER, now: () => at });
  let store = f.store;
  const makeRemote = () => new (require('../../../services/integrations-broker/src/broker').Broker)({ store, policy: f.policy, secrets,
    operations: require('../../../services/integrations-broker/src/google-data-manager').createDataManagerOperations({ store, http, now: () => at }).operations,
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
    secrets.close(); if (store !== f.store) store.close();
    for (const close of cleanups.reverse()) await close();
  }
}).catch(() => { process.exitCode = 1; });

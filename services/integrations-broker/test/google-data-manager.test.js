'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const C = require('../src/google-data-manager-contract');
const { createDataManagerOperations } = require('../src/google-data-manager');
const { Broker } = require('../src/broker'); const { BrokerStore } = require('../src/store');
const { createGoogleSecretStore } = require('../src/google-secrets');
const { signRequest } = require('../src/auth'); const { BrokerError } = require('../src/errors');
const { createGoogleHttp } = require('../src/google-http');
const runtime = require('../src/google-main');
const { adsFixture, CUSTOMER, MANAGER, ASSET, ACCESS } = require('./google-ads-fixture.cjs');
const selection = () => ({ conversionActionId: '456', eventName: 'lead', eventSource: 'WEB' });
const payload = () => ({ ...selection(), event: { timestamp: '2026-09-18T10:00:00.000Z', transactionId: 'FICTITIOUS-EVENT',
  value: 4.5, currency: 'EUR', advertisingConsent: 'GRANTED', adUserData: 'GRANTED', adPersonalization: 'DENIED',
  clickId: { type: 'gclid', value: 'FICTITIOUS-CLICK' }, userIdentifiers: [], enhancedPolicyDigest: null } });
function setup(t) {
  const f = adsFixture(t); const state = { at: Date.now(), sdk: f.state.sdk, calls: [], response: { requestId: 'fictitious-provider-request' }, onCall: null };
  f.binding.googleDataManager = { quotaProjectId: 'fictitious-project', destinations: [{ assetRef: ASSET, ...selection(),
    events: ['lead', 'schedule'], sources: ['WEB', 'OTHER'], enhancedPolicy: null }] };
  delete f.binding.googleDataManager.destinations[0].eventName; delete f.binding.googleDataManager.destinations[0].eventSource;
  f.policy.grants[0].operations = [...f.policy.grants[0].operations, ...Object.values(C.OPERATIONS)];
  const sdk = { async send(command) {
    const output = await f.sdk.send(command);
    if (command.input.SecretId === f.binding.secretArn && output.SecretString) {
      const value = JSON.parse(output.SecretString); value.scopes.push(...C.SCOPES); output.SecretString = JSON.stringify(value);
    }
    await state.onSecret?.(); return output;
  } };
  const http = async request => {
    if (request.hostname === 'oauth2.googleapis.com') {
      const result = await f.http(request); result.scope += ' ' + C.SCOPES[0]; return result;
    }
    assert.equal(request.hostname, 'datamanager.googleapis.com'); assert.equal(request.token.toString(), ACCESS);
    assert.equal(request.quotaProjectId, 'fictitious-project'); assert.equal(request.developerToken, undefined);
    state.calls.push({ path: request.path, json: request.json }); await state.onCall?.();
    return structuredClone(state.response);
  };
  const secrets = createGoogleSecretStore({ client: sdk, http, accountId: runtime.ACCOUNT,
    prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtime.SECRET_KEY, provider: C.PROVIDER, now: () => state.at });
  const make = (store = f.store, policy = f.policy) => new Broker({ store, policy, secrets,
    operations: { ...f.engine.operations, ...createDataManagerOperations({ store, http, now: () => state.at }).operations }, now: () => state.at });
  let broker = make();
  const command = (operation, value, patch = {}) => f.command('account', {}, { operation: C.OPERATIONS[operation], payload: value, ...patch });
  const execute = (value, privateKey = f.keys.privateKey, keyId = 'qa-key') => {
    const signed = signRequest(value, { keyId, privateKey, audience: f.policy.audience, now: state.at });
    return broker.execute(signed.raw, signed.headers);
  };
  const status = () => ({ requestStatusPerDestination: [{ destination: { operatingAccount: { accountType: 'GOOGLE_ADS', accountId: CUSTOMER },
    loginAccount: { accountType: 'GOOGLE_ADS', accountId: MANAGER }, productDestinationId: '456' },
    requestStatus: 'SUCCESS', eventsIngestionStatus: { recordCount: '1' } }] });
  t.after(() => secrets.close());
  return { ...f, state, sdk, http, secrets, command, execute, status, make, reset: policy => { broker = make(f.store, policy); } };
}
test('Data Manager validates without sending a conversion and projects warnings without provider details', async t => {
  const f = setup(t); f.state.response = {};
  const result = await f.execute(f.command('validate', selection()));
  assert.deepEqual(result.data, { validated: true, warningCount: 0 });
  assert.equal(f.state.calls[0].json.validateOnly, true); assert.equal(f.state.calls[0].json.events[0].adIdentifiers.gclid, 'GCLID_1');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM google_data_manager_receipts').get().n, 0);
  f.state.response = { fieldWarnings: [{ message: ACCESS, fieldPath: 'FICTITIOUS-PERSONAL-DATA' }] };
  assert.deepEqual((await f.execute(f.command('validate', selection()))).data, { validated: false, warningCount: 1 });
});
test('one typed ingest fixes destination, journals only metadata, audits acceptance and replays no provider write', async t => {
  const f = setup(t), request = f.command('ingest', payload());
  const result = await f.execute(request);
  assert.deepEqual(result.data, { accepted: true, submissionId: request.requestId, requestId: 'fictitious-provider-request', warningCount: 0 });
  const body = f.state.calls[0].json;
  assert.deepEqual(body.destinations, [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: CUSTOMER },
    loginAccount: { accountType: 'GOOGLE_ADS', accountId: MANAGER }, productDestinationId: '456' }]);
  assert.equal(body.validateOnly, false); assert.deepEqual(body.events[0].consent, { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED' });
  assert.equal((await f.execute(request)).replayed, true); assert.equal(f.state.calls.length, 1);
  await assert.rejects(f.execute({ ...request, payload: { ...payload(), event: { ...payload().event, value: 8 } } }), { code: 'idempotency_conflict' });
  const events = f.store.db.prepare('SELECT event FROM audit_outbox').all().map(row => JSON.parse(row.event));
  assert(events.some(event => event.result === 'accepted' && event.reason === 'provider_accepted'));
  const persisted = JSON.stringify(['commands', 'audit_outbox', 'google_data_manager_receipts'].map(table => f.store.db.prepare('SELECT * FROM ' + table).all()));
  for (const sentinel of ['FICTITIOUS-CLICK', 'FICTITIOUS-EVENT', ACCESS, 'FICTITIOUS_REFRESH']) assert(!persisted.includes(sentinel));
});
test('hostile payloads, denied consent, plaintext identifiers and unregistered destinations fail before secret reads', async t => {
  const f = setup(t), base = payload();
  for (const value of [{ ...base, token: ACCESS }, { ...base, url: 'https://evil.invalid' }, { ...base, query: 'SELECT *' },
    { ...base, conversionActionId: '999' }, { ...base, eventName: 'purchase' },
    { ...base, event: { ...base.event, advertisingConsent: 'DENIED' } },
    { ...base, event: { ...base.event, adUserData: 'DENIED', enhancedPolicyDigest: 'a'.repeat(64),
      userIdentifiers: [{ type: 'email', sha256: 'b'.repeat(64) }] } },
    { ...base, event: { ...base.event, timestamp: '2026-02-31T10:00:00.000Z' } },
    { ...base, event: { ...base.event, userIdentifiers: [{ type: 'email', sha256: 'patient@example.invalid' }] } },
    { ...base, event: { ...base.event, clickId: null } },
    { ...base, event: { ...base.event, clientId: 'FICTITIOUS-PATIENT-ID' } }]) {
    const before = f.state.sdk.length;
    await assert.rejects(f.execute(f.command('ingest', value)), error => ['invalid_request', 'scope_denied'].includes(error.code));
    assert.equal(f.state.sdk.length, before);
  }
  assert.equal(f.state.calls.length, 0);
});
test('enhanced data requires bound current authorization and only approved hashes reach transport', async t => {
  const f = setup(t), value = payload();
  value.event.userIdentifiers = [{ type: 'email', sha256: 'b'.repeat(64) }]; value.event.enhancedPolicyDigest = 'a'.repeat(64);
  await assert.rejects(f.execute(f.command('ingest', value)), { code: 'scope_denied' });
  f.binding.googleDataManager.destinations[0].enhancedPolicy = { digest: 'a'.repeat(64),
    notBefore: new Date(f.state.at - 1000).toISOString(), expiresAt: new Date(f.state.at + 10000).toISOString(), permittedIdentifiers: ['email'] };
  f.reset(f.policy);
  const result = await f.execute(f.command('ingest', value)); assert.equal(result.data.accepted, true);
  assert.equal(f.state.calls[0].json.encoding, 'HEX');
  assert.deepEqual(f.state.calls[0].json.events[0].userData, { userIdentifiers: [{ emailAddress: 'b'.repeat(64) }] });
  assert(!JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all()).includes('b'.repeat(64)));
  const calls = f.state.calls.length;
  f.state.onSecret = () => { f.state.at += 10001; };
  await assert.rejects(f.execute(f.command('ingest', value)), { code: 'scope_denied' });
  assert.equal(f.state.calls.length, calls);
});
test('status is bound to the durable sender/tenant/account receipt across broker reconstruction', async t => {
  const f = setup(t), request = f.command('ingest', payload()); await f.execute(request);
  f.state.response = f.status(); f.reset(f.policy);
  const result = await f.execute(f.command('status', { submissionId: request.requestId }));
  assert.equal(result.data.submissionId, request.requestId); assert.equal(result.data.requestId, 'fictitious-provider-request');
  assert.equal(result.data.requestStatusPerDestination[0].requestStatus, 'SUCCESS');
  assert.equal(f.state.calls[1].path, '/v1/requestStatus:retrieve?requestId=fictitious-provider-request');
  const other = generateKeyPairSync('ed25519');
  f.policy.principals.push({ ...f.policy.principals[0], id: 'api:other', keyId: 'other-key', publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }) });
  f.policy.grants.push({ ...f.policy.grants[0], principalId: 'api:other' });
  f.policy.grants.push({ ...f.policy.grants[0], tenantRef: 'clinic:999' }); f.reset(f.policy);
  const before = f.state.sdk.length;
  await assert.rejects(f.execute(f.command('status', { submissionId: request.requestId }), other.privateKey, 'other-key'), { code: 'scope_denied' });
  await assert.rejects(f.execute(f.command('status', { submissionId: request.requestId }, { tenantRef: 'clinic:999' })), { code: 'scope_denied' });
  await assert.rejects(f.execute(f.command('status', { submissionId: randomUUID() })), { code: 'scope_denied' });
  await assert.rejects(f.execute(f.command('status', { submissionId: request.requestId, requestId: 'foreign-provider-id' })), { code: 'invalid_request' });
  assert.equal(f.state.sdk.length, before);
  f.binding.googleDataManager.quotaProjectId = 'another-project'; f.reset(f.policy);
  await assert.rejects(f.execute(f.command('status', { submissionId: request.requestId })), { code: 'scope_denied' });
});
test('lost provider ACK, interrupted attempts and late revoked responses never trigger automatic retransmission', async t => {
  const f = setup(t), request = f.command('ingest', payload());
  f.state.onCall = () => { throw new BrokerError('provider_timeout'); };
  await assert.rejects(f.execute(request), { code: 'provider_timeout' });
  f.state.onCall = null; f.reset(f.policy);
  await assert.rejects(f.execute(request), { code: 'outcome_unknown' });
  await assert.rejects(f.execute(f.command('status', { submissionId: request.requestId })), { code: 'outcome_unknown' });
  assert.equal(f.state.calls.length, 1);
  const second = f.command('ingest', payload()); f.state.onCall = () => f.revoke();
  await assert.rejects(f.execute(second), { code: 'asset_revoked' });
  assert.equal(f.store.db.prepare('SELECT state FROM google_data_manager_receipts WHERE id=?').get(second.requestId).state, 'attempted');
  assert.equal(f.store.db.prepare('SELECT state FROM commands WHERE id=?').get(second.requestId).state, 'unknown');
});
test('receipt update and audit completion roll back together after a provider acceptance', async t => {
  const f = setup(t), request = f.command('ingest', payload());
  const append = f.store.appendAudit.bind(f.store);
  f.store.appendAudit = event => { if (event.reason === 'provider_accepted') throw Error('fictitious disk failure'); return append(event); };
  await assert.rejects(f.execute(request), { code: 'provider_failed' });
  const row = f.store.db.prepare('SELECT * FROM google_data_manager_receipts WHERE id=?').get(request.requestId);
  assert.equal(row.state, 'attempted'); assert.equal(row.provider_id, null);
  await assert.rejects(f.execute(request), { code: 'outcome_unknown' }); assert.equal(f.state.calls.length, 1);
});
test('a provider receipt cannot acknowledge two distinct submissions', async t => {
  const f = setup(t); await f.execute(f.command('ingest', payload()));
  const second = f.command('ingest', { ...payload(), event: { ...payload().event, transactionId: 'FICTITIOUS-OTHER' } });
  await assert.rejects(f.execute(second), { code: 'provider_failed' });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM google_data_manager_receipts WHERE state='accepted'").get().n, 1);
  await assert.rejects(f.execute(second), { code: 'outcome_unknown' }); assert.equal(f.state.calls.length, 2);
});
test('status rejects other destinations, unbounded counts and foreign statuses; provider details are projected', async t => {
  const f = setup(t), request = f.command('ingest', payload()); await f.execute(request);
  for (const mutate of [r => r.destination.operatingAccount.accountId = '1111111111', r => r.destination.productDestinationId = '999',
    r => r.requestStatus = ACCESS, r => r.eventsIngestionStatus.recordCount = '2',
    r => r.removeAllAudienceMembersStatus = {}, r => r.audienceMembersIngestionStatus = null,
    r => r.audienceMembersRemovalStatus = {}]) {
    f.state.response = f.status(); mutate(f.state.response.requestStatusPerDestination[0]);
    await assert.rejects(f.execute(f.command('status', { submissionId: request.requestId })), { code: 'provider_failed' });
  }
  f.state.response = f.status(); f.state.response.requestStatusPerDestination[0].warningInfo = {
    warningCounts: [{ reason: ACCESS, recordCount: '1', detail: 'FICTITIOUS-PERSONAL-DATA' }] };
  const result = await f.execute(f.command('status', { submissionId: request.requestId }));
  assert.deepEqual(result.data.requestStatusPerDestination[0].warningInfo.warningCounts, [{ reason: 'UNKNOWN', recordCount: 1 }]);
  f.state.response = {};
  assert.deepEqual((await f.execute(f.command('status', { submissionId: request.requestId }))).data,
    { submissionId: request.requestId, requestId: 'fictitious-provider-request', requestStatusPerDestination: [] });
  f.state.response = f.status(); f.state.response.requestStatusPerDestination[0].requestStatus = 'FAILED';
  f.state.response.requestStatusPerDestination[0].errorInfo = { errorCounts: [{ reason: 'PROCESSING_ERROR_REASON_CLICK_NOT_FOUND', recordCount: '1' }] };
  assert.equal((await f.execute(f.command('status', { submissionId: request.requestId }))).data
    .requestStatusPerDestination[0].errorInfo.errorCounts[0].reason, 'PROCESSING_ERROR_REASON_CLICK_NOT_FOUND');
});
test('conversion config requires the explicit new cohort and separate OAuth/revocation keys', t => {
  const f = setup(t), config = { enabled: true, cohort: C.COHORT, policy: f.policy, listenAddress: '127.0.0.1', port: 8446,
    stateFile: '/tmp/fictitious.sqlite', tlsCertFile: '/tmp/fictitious.crt', tlsKeyFile: '/tmp/fictitious.key', cursorKeyFile: '/tmp/fictitious.cursor' };
  runtime.validateConfig(config);
  assert.throws(() => runtime.validateConfig({ ...config, cohort: 'google-ads-read-v1' }), { code: 'invalid_request' });
  const reused = structuredClone(config); reused.policy.grants[1].operations.push(C.OPERATIONS.ingest);
  assert.throws(() => runtime.validateConfig(reused), { code: 'invalid_request' });
  const missing = structuredClone(config); delete missing.policy.connections[0].googleDataManager;
  assert.throws(() => runtime.validateConfig(missing), { code: 'invalid_request' });
});
test('typed click conversion preserves the existing CRM Data Manager body and consent signals', t => {
  const f = setup(t), { buildDataManagerEventRequest } = require('../../../src/services/googleDataManagerConversion.service');
  for (const eventSource of ['WEB', 'OTHER']) for (const type of ['gclid', 'gbraid', 'wbraid'])
    for (const adUserData of [null, 'GRANTED', 'DENIED']) for (const adPersonalization of [null, 'GRANTED', 'DENIED']) {
    const value = payload(); value.eventSource = eventSource; value.event.clickId.type = type;
    value.event.adUserData = adUserData; value.event.adPersonalization = adPersonalization;
    const target = C.resource(f.binding, ASSET, value);
    const typed = C.body(C.OPERATIONS.ingest, value, target, randomUUID(), f.state.at);
    const previous = buildDataManagerEventRequest({ customerId: CUSTOMER, conversionAction: 'customers/' + CUSTOMER + '/conversionActions/456',
      loginCustomerId: MANAGER, conversionDateTime: value.event.timestamp, externalId: value.event.transactionId,
      value: value.event.value, currency: value.event.currency, eventName: value.eventName, eventSource,
      [type]: value.event.clickId.value, consentStatus: value.event.adUserData, adPersonalizationStatus: value.event.adPersonalization });
    assert.deepEqual(typed, previous);
  }
});
test('conversion OAuth requests the extra Data Manager scope only for the explicitly configured binding', async t => {
  const f = require('./google-oauth-broker-fixture.cjs').setup(t, 'google_ads');
  const binding = { quotaProjectId: 'fictitious-project', destinations: [{ assetRef: ASSET, conversionActionId: '456',
    events: ['lead'], sources: ['WEB'], enhancedPolicy: null }] };
  f.binding.googleDataManager = binding; f.policy.connections[0].googleDataManager = binding;
  f.binding.oauth.scopes.push(...C.SCOPES); f.reopen();
  const started = await f.begin(); assert(started.url.searchParams.get('scope').split(' ').includes(C.SCOPES[0]));
  assert.equal(started.url.searchParams.get('scope').split(' ').length, 5);
  assert.equal((await f.finish(started)).data.status, 'staged');
  assert.equal((await f.activate(started)).data.status, 'active');
  const missing = structuredClone(f.binding); missing.oauth.scopes = missing.oauth.scopes.filter(scope => !C.SCOPES.includes(scope));
  assert.throws(() => require('../src/google-oauth-contract').bindingFor(missing), { code: 'invalid_request' });
  const extra = structuredClone(f.binding); extra.oauth.scopes.push('https://www.googleapis.com/auth/business.manage');
  assert.throws(() => require('../src/google-oauth-contract').bindingFor(extra), { code: 'invalid_request' });
});
function wire({ status = 200, body = '{}', headers = { 'content-type': 'application/json' }, enabled = true } = {}) {
  const calls = [];
  const http = createGoogleHttp({ dataManagerEnabled: enabled, request: (options, callback) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = sent => { calls.push({ options, sent }); queueMicrotask(() => {
      const response = new PassThrough(); response.statusCode = status; response.headers = headers;
      callback(response); if (!response.destroyed) response.end(body);
    }); }; return req;
  } }); return { calls, http };
}
test('Data Manager transport has exact endpoints, quota header, TLS and bounded responses', async () => {
  const input = { hostname: 'datamanager.googleapis.com', path: '/v1/events:ingest', token: Buffer.from(ACCESS),
    quotaProjectId: 'fictitious-project', json: { destinations: [], events: [], validateOnly: true } };
  const w = wire(); await w.http(input);
  assert.equal(w.calls[0].options.method, 'POST'); assert.equal(w.calls[0].options.headers['x-goog-user-project'], 'fictitious-project');
  assert.equal(w.calls[0].options.rejectUnauthorized, true); assert.equal(w.calls[0].options.port, 443);
  assert.equal(w.calls[0].options.headers['developer-token'], undefined);
  await w.http({ ...input, path: '/v1/requestStatus:retrieve?requestId=fictitious%3Aid', json: undefined });
  assert.equal(w.calls[1].options.method, 'GET'); assert.equal(w.calls[1].sent, undefined);
  await assert.rejects(wire({ enabled: false }).http(input), { code: 'invalid_request' });
  for (const patch of [{ hostname: 'evil.invalid' }, { path: '/v1/audienceMembers:ingest' }, { path: '/v2/events:ingest' },
    { quotaProjectId: 'injected\r\nheader' }, { quotaProjectId: undefined }, { developerToken: Buffer.from('FICTITIOUS') },
    { path: '/v1/requestStatus:retrieve?requestId=fictitious&extra=x', json: undefined },
    { path: '/v1/requestStatus:retrieve?requestId=fictitious:id', json: undefined }]) {
    await assert.rejects(w.http({ ...input, ...patch }), { code: 'invalid_request' });
  }
  assert.equal(w.calls.length, 2);
  for (const options of [{ status: 302 }, { body: 'not JSON' }, { headers: { 'content-type': 'text/html' } },
    { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }, { body: '{"ignored":"' + 'x'.repeat(131072) + '"}' }]) {
    await assert.rejects(wire(options).http(input), { code: 'provider_failed' });
  }
});
test('complete HTTPS runtime preserves receipts across SQLite reopen and refuses replay after revocation', async t => {
  const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
  const { randomBytes } = require('node:crypto'), { execFileSync } = require('node:child_process');
  const { allowPort, removePort } = require('./offline-guard.cjs');
  const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
  const f = setup(t); const cert = path.join(f.dir, 'tls.crt'), key = path.join(f.dir, 'tls.key'), cursorKey = path.join(f.dir, 'cursor');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  for (const file of [key, cert]) fs.chmodSync(file, 0o600); fs.writeFileSync(cursorKey, randomBytes(32), { mode: 0o600 });
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const config = { enabled: true, cohort: C.COHORT, policy: f.policy, listenAddress: '127.0.0.1', port,
    stateFile: path.join(f.dir, 'runtime.sqlite'), tlsCertFile: cert, tlsKeyFile: key, cursorKeyFile: cursorKey };
  const filename = path.join(f.dir, 'config.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const delivered = []; const dependencies = { http: f.http, awsFactory: async () => ({ secrets: f.sdk,
    sink: { write: async value => { delivered.push(JSON.parse(value.event)); return { versionId: 'fictitious-s3', digest: value.digest }; } }, close() {} }) };
  let app = await runtime.main(filename, dependencies); allowPort(port);
  t.after(async () => { if (app) await app.close(); removePort(port); });
  const client = (keyId, privateKey) => createIntegrationsBrokerClient({ origin: 'https://127.0.0.1:' + port,
    audience: f.policy.audience, keyId, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(cert) });
  const sender = client('qa-key', f.keys.privateKey), control = client('control-key', f.control.privateKey);
  const consumer = require('../../../src/services/googleDataManagerBrokerClient.service').createGoogleDataManagerBrokerClient({
    client: sender, enabled: () => true, assertContext: async () => ({ discoveryOnly: false,
      customerId: CUSTOMER, loginCustomerId: MANAGER, connectionRef: f.binding.connectionRef,
      assetRef: ASSET, tenantRef: f.policy.grants[0].tenantRef }) });
  const request = f.command('ingest', payload());
  const send = () => consumer.execute({}, 'ingest', request.payload, { requestId: request.requestId, beforeExecute: async () => true });
  const accepted = await send();
  assert.equal(accepted.accepted, true); assert.equal(f.state.calls.length, 1);
  await app.close(); app = null;
  const reopened = new BrokerStore(config.stateFile);
  assert.equal(reopened.db.prepare('SELECT state FROM google_data_manager_receipts WHERE id=?').get(request.requestId).state, 'accepted');
  reopened.close();
  app = await runtime.main(filename, dependencies);
  assert.deepEqual(await send(), accepted); assert.equal(f.state.calls.length, 1);
  assert.equal((await sender.execute(request)).replayed, true); assert.equal(f.state.calls.length, 1);
  f.state.response = f.status();
  assert.equal((await consumer.execute({}, 'status', { submissionId: request.requestId }, { requestId: randomUUID(),
    expectedActionId: '456', beforeExecute: async () => true })).requestStatusPerDestination[0].requestStatus, 'SUCCESS');
  assert.equal((await sender.execute(f.command('status', { submissionId: request.requestId }))).data.requestStatusPerDestination[0].requestStatus, 'SUCCESS');
  const revoke = f.command('validate', {}, { operation: 'google.ads.asset.revoke.v1' });
  await control.execute(revoke);
  const calls = f.state.calls.length;
  await assert.rejects(send(), { code: 'asset_revoked' });
  await assert.rejects(sender.execute(request), { code: 'asset_revoked' });
  await assert.rejects(sender.execute(f.command('status', { submissionId: request.requestId })), { code: 'asset_revoked' });
  assert.equal(f.state.calls.length, calls);
  assert.equal(require.cache[require.resolve('../../../models')], undefined);
});

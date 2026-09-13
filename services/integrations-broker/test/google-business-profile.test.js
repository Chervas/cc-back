'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const { fixture } = require('./helpers'); const { Broker } = require('../src/broker'); const { BrokerStore } = require('../src/store');
const { BrokerError } = require('../src/errors'); const { eventFor } = require('../src/audit');
const contract = require('../src/google-business-profile-contract'); const { createGoogleBusinessProfileOperations } = require('../src/google-business-profile');
const { cursorCodec } = require('../src/provider-cursor'); const { createGoogleHttp } = require('../src/google-http');
const { createGoogleSecretStore, SCOPE } = require('../src/google-secrets');
const runtime = require('../src/google-main');
const ACCESS = 'FICTITIOUS_GBP_ACCESS_SENTINEL'; const REFRESH = 'FICTITIOUS_GBP_REFRESH_SENTINEL'; const CLIENT = 'FICTITIOUS_GBP_CLIENT_SENTINEL';
const parent = 'accounts/123/locations/456'; const secretArn = 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/qa-connection-abcdef';
const appArn = secretArn.replace('qa-connection', 'qa-client');
const connection = { version: 2, provider: contract.PROVIDER, connectionRef: 'connection:test', refreshToken: REFRESH, scopes: [SCOPE] };
const application = { version: 1, provider: 'google-oauth-client', clientId: 'fictitious.apps.googleusercontent.com', clientSecret: CLIENT };
function fakeSecrets(options = {}) {
  const requests = []; let revision = 'qa-v1'; let refreshes = 0;
  const sdk = { async send(cmd) {
    requests.push({ name: cmd.constructor.name, input: cmd.input }); const arn = cmd.input.SecretId;
    assert([secretArn, appArn].includes(arn));
    if (cmd.constructor.name === 'DescribeSecretCommand') return { ARN: arn, KmsKeyId: runtime.SECRET_KEY, ...options.metadata };
    assert.equal(cmd.input.VersionStage, 'AWSCURRENT');
    return { ARN: arn, VersionId: revision, VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(arn === secretArn ? { ...connection, ...options.connection } : application) };
  } };
  const store = createGoogleSecretStore({ client: sdk, accountId: runtime.ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtime.SECRET_KEY,
    ...options, http: async request => {
      refreshes++; assert.equal(request.hostname, 'oauth2.googleapis.com'); assert.equal(request.path, '/token');
      const form = new URLSearchParams(request.form); assert.equal(form.get('refresh_token'), REFRESH); assert.equal(form.get('client_secret'), CLIENT);
      assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(request.token, undefined);
      if (options.refresh) return options.refresh(request);
      return { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600, scope: SCOPE };
    } });
  return { store, sdk, requests, rotate: () => { revision = 'qa-v2'; }, count: () => refreshes };
}
function gbp(t, { http = async () => ({}), secrets, now } = {}) {
  const f = fixture(t); f.policy.connections[0] = { ...f.policy.connections[0], provider: contract.PROVIDER, secretArn, clientSecretArn: appArn };
  f.policy.grants[0] = { ...f.policy.grants[0], assetRef: 'gbp:123:456', operations: contract.OPERATIONS };
  const credentials = secrets || fakeSecrets().store; t.after(() => credentials.close?.());
  const operations = createGoogleBusinessProfileOperations({ http, cursor: cursorCodec(randomBytes(32)) });
  const broker = new Broker({ store: f.store, policy: f.policy, secrets: credentials, operations, now });
  const command = (family, payload = {}, rest = {}) => f.command({ operation: contract.PREFIX + family + '.read.v1', assetRef: 'gbp:123:456', payload, ...rest });
  const execute = command => { const signed = f.signed(command); return broker.execute(signed.raw, signed.headers); };
  return { ...f, broker, command, execute, operations, credentials };
}
test('six fixed reads preserve projected contracts without caching content or credentials in SQLite', async t => {
  const seen = [];
  const responses = [
    { name: 'locations/456', title: 'FICTITIOUS_BUSINESS', metadata: { hasVoiceOfMerchant: true }, secret: REFRESH },
    { hasVoiceOfMerchant: true, debug: CLIENT },
    { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [
      { date: { year: 2026, month: 9, day: 1 } }, { date: { year: 2026, month: 9, day: 2 }, value: '0' }] } }] }] },
    { reviews: [{ reviewId: 'review-one', comment: 'FICTITIOUS_REVIEW_CONTENT', reviewer: { displayName: 'FICTITIOUS_REVIEWER', access_token: ACCESS } }], totalReviewCount: 1 },
    { localPosts: [{ name: parent + '/localPosts/post-one', summary: 'FICTITIOUS_POST', media: [{ googleUrl: 'https://example.invalid/image.jpg' }] }] },
    { mediaItems: [{ name: parent + '/media/media-one', googleUrl: 'https://example.invalid/image.jpg' }] },
  ];
  const f = gbp(t, { http: async request => { assert.equal(request.token.toString(), ACCESS); seen.push(request); return responses.shift(); } });
  for (const family of ['details', 'verification', 'metrics', 'reviews', 'posts', 'media']) {
    const payload = family === 'metrics' ? { startDate: '2026-09-01', endDate: '2026-09-02' } : ['reviews', 'posts', 'media'].includes(family) ? { pageToken: null } : {};
    const command = f.command(family, payload); const result = await f.execute(command);
    assert(!JSON.stringify(result).includes('SENTINEL'));
    if (family === 'reviews') { assert.equal(result.data.reviews[0].reviewId, 'review-one'); assert.equal(result.data.reviews[0].name, undefined); }
    if (family === 'metrics') assert.equal(result.data.multiDailyMetricTimeSeries[0].dailyMetricTimeSeries[0].timeSeries.datedValues[0].value, undefined);
    await assert.rejects(f.execute(command), { code: 'outcome_unknown' });
  }
  assert.equal(seen.length, 6); assert.match(seen[0].path, /^\/v1\/locations\/456\?readMask=/);
  assert.equal(seen[1].path, '/v1/locations/456/VoiceOfMerchantState');
  const metricParams = new URL('https://example.invalid' + seen[2].path).searchParams;
  assert.deepEqual(metricParams.getAll('dailyMetrics'), [...contract.METRICS]); assert.equal(metricParams.get('dailyRange.start_date.year'), '2026');
  assert.match(seen[3].path, /pageSize=50/); assert.match(seen[4].path, /pageSize=100/);
  const saved = JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all()) + JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all());
  for (const v of [ACCESS, REFRESH, CLIENT, 'FICTITIOUS_REVIEW_CONTENT', 'FICTITIOUS_BUSINESS']) assert(!saved.includes(v));
  assert.equal(f.store.backlog().pending, 12);
});
test('schema, foreign asset and operations are rejected before obtaining any credential', async t => {
  let reads = 0; const f = gbp(t, { secrets: { invalidate() {}, withSecret() { reads++; throw Error(); } } });
  for (const command of [f.command('details', { url: 'https://169.254.169.254' }), f.command('details', {}, { assetRef: 'gbp:123:999' }),
    f.command('details', {}, { tenantRef: 'clinic:999' }), f.command('reviews', { pageToken: null, pageSize: 500 }),
    f.command('metrics', { startDate: '2026-02-30', endDate: '2026-03-01' }), f.command('metrics', { startDate: '2024-01-01', endDate: '2026-09-01' }), f.command('reply')]) await assert.rejects(f.execute(command));
  assert.equal(reads, 0);
});
test('opaque pagination is scoped to principal, tenant, connection, asset, operation, policy and expiry', async t => {
  let calls = 0; const rawPage = 'FICTITIOUS_PROVIDER_PAGE_SECRET';
  const f = gbp(t, { http: async request => { calls++; if (calls === 2) assert.equal(new URL('https://example.invalid' + request.path).searchParams.get('pageToken'), rawPage); return { reviews: [], nextPageToken: calls === 1 ? rawPage : undefined }; } });
  const first = await f.execute(f.command('reviews', { pageToken: null })); const pageToken = first.data.nextPageToken;
  assert(!pageToken.includes(rawPage)); await f.execute(f.command('reviews', { pageToken }));
  await assert.rejects(f.execute(f.command('posts', { pageToken })), { code: 'invalid_request' }); assert.equal(calls, 2);
  let now = 1000; const codec = cursorCodec(randomBytes(32), () => now);
  const scope = { principalId: 'p', tenantRef: 'c', binding: { connectionRef: 'r' }, assetRef: 'a', operation: 'o', policyVersion: 'v' };
  const token = codec.seal(rawPage, scope);
  for (const change of [{ principalId: 'other' }, { tenantRef: 'other' }, { binding: { connectionRef: 'other' } }, { assetRef: 'other' }, { operation: 'other' }, { policyVersion: 'other' }]) assert.throws(() => codec.open(token, { ...scope, ...change }));
  assert.throws(() => codec.open(token.slice(0, -3) + 'AAA', scope)); now += 600000; assert.throws(() => codec.open(token, scope));
});
test('malformed or cross-resource responses cannot trigger cache replacement', () => {
  for (const [family, raw] of [['reviews', { reviews: [], totalReviewCount: null }], ['details', { name: 'locations/999' }],
    ['reviews', { reviews: [{ name: 'accounts/999/locations/456/reviews/r' }] }], ['media', { mediaItems: [{ name: parent + '/media/../secret' }] }],
    ['metrics', { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 2, day: 30 }, value: '1' }] } }] }] }],
    ['metrics', { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: '9007199254740992' }] } }] }] }]]) {
    assert.throws(() => contract.project(contract.PREFIX + family + '.read.v1', raw, contract.asset('gbp:123:456')));
  }
});
test('refresh cache obeys expiration and secret versions, coalesces concurrent refresh, clears working buffers', async t => {
  let now = 1000; let release; const f = fakeSecrets({ now: () => now, refresh: async () => { await new Promise(resolve => { release = resolve; }); return { access_token: ACCESS, token_type: 'Bearer', expires_in: 120 }; } }); t.after(() => f.store.close());
  const binding = { ...connection, secretArn, clientSecretArn: appArn }; const buffers = [];
  const read = () => f.store.withSecret(binding, async token => { buffers.push(token); assert.equal(token.toString(), ACCESS); return { ok: true }; });
  const a = read(); const b = read(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.count(), 1); release(); await Promise.all([a, b]);
  await read(); assert.equal(f.count(), 1); assert(buffers.every(v => v.every(byte => byte === 0))); assert.equal(f.requests.length, 12);
  now += 61000; const c = read(); await new Promise(resolve => setImmediate(resolve)); release(); await c; assert.equal(f.count(), 2);
  f.rotate(); const d = read(); await new Promise(resolve => setImmediate(resolve)); release(); await d; assert.equal(f.count(), 3);
});
test('KMS, OAuth scope and reflected access/refresh/client secrets fail closed', async t => {
  for (const options of [{ metadata: { KmsKeyId: 'other' } }, { connection: { scopes: [] } }]) {
    const f = fakeSecrets(options); t.after(() => f.store.close());
    await assert.rejects(f.store.withSecret({ ...connection, secretArn, clientSecretArn: appArn }, async () => ({})), { code: 'secret_unavailable' }); assert.equal(f.count(), 0);
  }
  const f = fakeSecrets(); t.after(() => f.store.close());
  for (const sentinel of [ACCESS, REFRESH, CLIENT]) await assert.rejects(f.store.withSecret({ ...connection, secretArn, clientSecretArn: appArn }, async () => ({ comment: 'prefix ' + sentinel })), { code: 'provider_failed' });
});
test('invalid_grant persists revocation through restart; a block cancels refresh without late dispatch', async t => {
  const bad = fakeSecrets({ refresh: async () => { throw new BrokerError('credential_revoked'); } });
  const f = gbp(t, { secrets: bad.store }); await assert.rejects(f.execute(f.command('details')), { code: 'credential_revoked' });
  assert.equal(f.store.db.prepare('SELECT state FROM connections').get().state, 'revoked');
  const reopened = new BrokerStore(f.filename); t.after(() => reopened.close());
  const restarted = new Broker({ store: reopened, policy: f.policy, secrets: bad.store, operations: f.operations });
  const signed = f.signed(f.command('details')); await assert.rejects(restarted.execute(signed.raw, signed.headers), { code: 'connection_blocked' }); assert.equal(bad.count(), 1);
  let release; let calls = 0; const delayed = fakeSecrets({ refresh: async () => { await new Promise(r => { release = r; }); return { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600 }; } });
  const g = gbp(t, { secrets: delayed.store, http: async () => { calls++; return {}; } }); const command = g.command('details'); const running = g.execute(command);
  await new Promise(resolve => setImmediate(resolve)); g.broker.block(command.connectionRef, eventFor(command, g.policy.principals[0], g.policy, 'connection.blocked', 'success', 'operator_block'));
  release(); await assert.rejects(running); assert.equal(calls, 0);
});
test('Google HTTPS transport pins method, hosts, TLS and caps responses, timeout, redirects and error details', async () => {
  const requests = [];
  function transport({ status = 200, value = {}, redirect = false, slow = false, oversized = false } = {}) {
    return createGoogleHttp({ timeoutMs: 15, request: (options, callback) => {
      requests.push(options); const req = new EventEmitter(); req.destroy = () => {};
      req.end = () => { const res = new PassThrough(); res.statusCode = status; res.headers = { 'content-type': 'application/json', ...(redirect ? { location: 'https://example.invalid' } : {}) };
        callback(res); if (!slow) res.end(oversized ? 'x'.repeat(2100000) : JSON.stringify(value)); };
      return req;
    } });
  }
  const read = { hostname: 'mybusiness.googleapis.com', path: '/v4/accounts/123/locations/456/reviews', token: Buffer.from(ACCESS) };
  await transport()(read); assert.equal(requests[0].method, 'GET'); assert.equal(requests[0].rejectUnauthorized, true); assert.equal(requests[0].minVersion, 'TLSv1.2'); assert.equal(requests[0].port, 443);
  for (const hostname of ['169.254.169.254', 'googleapis.com', 'mybusiness.googleapis.com.evil.invalid']) await assert.rejects(transport()({ ...read, hostname }), { code: 'invalid_request' });
  await assert.rejects(transport({ status: 302, redirect: true })(read), { code: 'provider_failed' });
  await assert.rejects(transport({ oversized: true })(read), { code: 'provider_failed' });
  await assert.rejects(transport({ status: 401, value: { error: ACCESS } })(read), { code: 'provider_unauthorized' });
  await assert.rejects(transport({ status: 400, value: { error: 'invalid_grant', error_description: REFRESH } })({ hostname: 'oauth2.googleapis.com', path: '/token', form: 'fictitious=1' }), { code: 'credential_revoked' });
  const keepAlive = setInterval(() => {}, 100); try { await assert.rejects(transport({ slow: true })(read), { code: 'provider_timeout' }); } finally { clearInterval(keepAlive); }
});
test('production entry point rejects unapproved cohort config and AWS environment before network', async () => {
  assert.throws(() => runtime.validateConfig({ enabled: false }));
  await assert.rejects(runtime.connectAws(), { code: 'invalid_request' });
});
test('revocation received after the caller timeout is still durable and a metadata-time block never renews', async t => {
  let release;
  const late = fakeSecrets({ refresh: async () => { await new Promise(r => { release = r; }); throw new BrokerError('credential_revoked'); } });
  const f = gbp(t, { secrets: late.store }); f.broker.timeoutMs = 10;
  const running = f.execute(f.command('details')); await assert.rejects(running, { code: 'provider_timeout' });
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.db.prepare('SELECT state FROM connections').get().state, 'revoked');
  let endMetadata; let refreshes = 0; const controller = new AbortController();
  const sdk = fakeSecrets().sdk;
  const credentials = createGoogleSecretStore({ accountId: runtime.ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtime.SECRET_KEY,
    client: { async send(command) { const value = await sdk.send(command); if (command.input.SecretId === appArn && command.constructor.name === 'GetSecretValueCommand') await new Promise(r => { endMetadata = r; }); return value; } },
    http: async () => { refreshes++; throw Error('MUST_NOT_RENEW'); } }); t.after(() => credentials.close());
  const waiting = credentials.withSecret({ ...connection, secretArn, clientSecretArn: appArn }, async () => ({}), { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); endMetadata();
  await assert.rejects(waiting, { code: 'connection_blocked' }); assert.equal(refreshes, 0);
});
test('audit admission failure prevents provider reads and persisted operations sanitize arbitrary references', async t => {
  let calls = 0; const f = gbp(t, { http: async () => { calls++; return { name: 'locations/456' }; } }); f.broker.policy.maxBacklog = 2;
  await f.execute(f.command('details')); await assert.rejects(f.execute(f.command('details')), { code: 'audit_unavailable' }); assert.equal(calls, 1);
  const g = gbp(t); await assert.rejects(g.execute(g.command('details', {}, { connectionRef: 'FICTITIOUS_UNTRUSTED_REF' })));
  const rows = g.store.db.prepare('SELECT event FROM audit_outbox').all(); assert(!JSON.stringify(rows).includes('FICTITIOUS_UNTRUSTED_REF'));
  assert.equal(JSON.parse(rows[0].event).operation, 'unassigned');
});
module.exports = { fakeSecrets, secretArn, appArn, ACCESS, REFRESH, CLIENT };

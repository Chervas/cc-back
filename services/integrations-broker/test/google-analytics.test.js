'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const { fixture } = require('./helpers'); const { analyticsReport, families } = require('./analytics-helpers');
const contract = require('../src/google-analytics-contract'); const { createAnalyticsOperations } = require('../src/google-analytics');
const { Broker } = require('../src/broker'); const { BrokerStore } = require('../src/store'); const { cursorCodec } = require('../src/provider-cursor');
const { createGoogleSecretStore } = require('../src/google-secrets'); const { createGoogleHttp } = require('../src/google-http');
const { eventFor, drainAudit } = require('../src/audit'); const runtime = require('../src/google-main');
const range = { startDate: '2026-09-01', endDate: '2026-09-02', pageToken: null }; const ACCESS = 'FICTITIOUS_GA_ACCESS';
function gaFixture(t) {
  let now = Date.now(); const f = fixture(t, { now: () => now }); const resource = contract.property('properties/123');
  const secretArn = 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-ga-abcdef';
  const appArn = secretArn.replace('fictitious-ga', 'fictitious-app');
  const secret = { version: 3, provider: contract.PROVIDER, connectionRef: 'connection:test', googleUserId: 'fictitious-subject',
    clientId: 'fictitious-client', refreshToken: 'FICTITIOUS_GA_REFRESH', scopes: [contract.SCOPES[0]] };
  f.policy.connections[0] = { ...f.policy.connections[0], provider: contract.PROVIDER, secretArn, clientSecretArn: appArn,
    googleSubject: secret.googleUserId, analyticsProperties: [resource] };
  f.policy.grants[0] = { ...f.policy.grants[0], assetRef: resource.assetRef, operations: contract.OPERATIONS };
  f.policy.maxBacklog = 10000; f.policy.principals[0].maxPerMinute = 600;
  const state = { secret, calls: [], sdk: [], refreshes: 0, revoked: false, response: null, before: null };
  const client = { async send(command) {
    const arn = command.input.SecretId; assert([secretArn, appArn].includes(arn)); state.sdk.push(command.constructor.name);
    if (command.constructor.name === 'DescribeSecretCommand') return { ARN: arn, KmsKeyId: runtime.SECRET_KEY };
    assert.equal(command.constructor.name, 'GetSecretValueCommand');
    return { ARN: arn, VersionId: 'fictitious-current', VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(arn === secretArn ? secret
      : { version: 1, provider: 'google-oauth-client', clientId: 'fictitious-client', clientSecret: 'FICTITIOUS_GA_CLIENT' }) };
  } };
  const http = async request => {
    if (request.hostname === 'oauth2.googleapis.com') {
      state.refreshes++; if (state.revoked) throw new (require('../src/errors').BrokerError)('credential_revoked');
      assert.equal(new URLSearchParams(request.form).get('refresh_token'), secret.refreshToken);
      return { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600, scope: contract.SCOPES[0] };
    }
    state.calls.push(request); assert.equal(request.token.toString(), ACCESS); await state.before?.(request);
    if (state.response) return state.response(request);
    const family = request.json.dimensions.length === 1 ? 'daily' : Object.keys(families).find(k => families[k] === request.json.dimensions[1].name);
    return { ...analyticsReport(family), ignoredSecret: ACCESS };
  };
  const secrets = createGoogleSecretStore({ provider: contract.PROVIDER, client, http, accountId: runtime.ACCOUNT,
    prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtime.SECRET_KEY, now: () => now }); t.after(() => secrets.close());
  const cursor = cursorCodec(randomBytes(32), () => now);
  const make = store => new Broker({ store, policy: f.policy, secrets, operations: createAnalyticsOperations({ http, cursor }), now: () => now });
  const broker = make(f.store);
  const command = (family, payload = range, extra = {}) => f.command({ operation: contract.PREFIX + family + '.read.v1', assetRef: resource.assetRef, payload, ...extra });
  const execute = (family, payload, extra) => { const signed = f.signed(command(family, payload, extra)); return broker.execute(signed.raw, signed.headers); };
  return { ...f, state, execute, command, broker, make, resource, advance: ms => { now += ms; } };
}
test('nine GA reports pin property, dimensions, current keyEvents metric and provider JSON while stripping unrelated fields', async t => {
  const f = gaFixture(t);
  for (const family of Object.keys(families)) {
    const result = (await f.execute(family)).data;
    assert.equal(result.rows[0].metricValues[3].value, '1.5'); assert.equal(result.rows[0].metricValues[4].value, '-12.50');
    assert.equal(result.rowCount, 1); assert.equal(result.nextPageToken, null); assert(!JSON.stringify(result).includes(ACCESS));
  }
  assert.equal(f.state.refreshes, 1); assert.equal(f.state.calls.length, 9); assert.equal(f.state.sdk.length, 36);
  for (const req of f.state.calls) {
    assert.equal(req.hostname, 'analyticsdata.googleapis.com'); assert.equal(req.path, '/v1beta/properties/123:runReport');
    assert.deepEqual(req.json.metrics.map(m => m.name), ['sessions', 'activeUsers', 'newUsers', 'keyEvents', 'totalRevenue']);
    assert.equal(req.json.limit, '500'); assert.equal(req.json.offset, '0'); assert.equal(req.json.keepEmptyRows, false);
    assert.deepEqual(req.json.orderBys.map(v => v.dimension.dimensionName), req.json.dimensions.map(d => d.name));
  }
});
test('denied tenant/property/operation and arbitrary report fields never reach secrets or provider', async t => {
  const f = gaFixture(t);
  for (const extra of [{ tenantRef: 'clinic:999' }, { assetRef: 'ga4:999' }, { operation: 'google.analytics.delete.v1' }]) await assert.rejects(f.execute('daily', range, extra));
  for (const payload of [{}, { ...range, metrics: [] }, { ...range, property: 'properties/999' }, { ...range, url: 'https://foreign.invalid/' },
    { ...range, startDate: '2026-02-30' }, { ...range, endDate: '2020-01-01' }, { ...range, startDate: '2020-01-01' }]) await assert.rejects(f.execute('daily', payload), { code: 'invalid_request' });
  assert.equal(f.state.sdk.length + f.state.calls.length + f.state.refreshes, 0);
});
test('GA cursors bind identity, operation, dates, row count and quality metadata, and reject expiry/tampering', async t => {
  const f = gaFixture(t); f.state.response = r => analyticsReport('city', { offset: Number(r.json.offset), count: r.json.offset === '0' ? 500 : 1, total: 501 });
  const first = (await f.execute('city')).data; assert(first.nextPageToken); assert(!first.nextPageToken.includes('offset'));
  await assert.rejects(f.execute('city', { ...range, endDate: '2026-09-03', pageToken: first.nextPageToken }), { code: 'invalid_request' });
  await assert.rejects(f.execute('country', { ...range, pageToken: first.nextPageToken }), { code: 'invalid_request' });
  await assert.rejects(f.execute('city', { ...range, pageToken: first.nextPageToken.slice(0, -1) }), { code: 'invalid_request' });
  assert.equal(f.state.calls.length, 1);
  const second = (await f.execute('city', { ...range, pageToken: first.nextPageToken })).data;
  assert.equal(second.nextPageToken, null); assert.equal(f.state.calls[1].json.offset, '500');
  f.state.response = () => analyticsReport('city', { offset: 500, count: 2, total: 502 });
  await assert.rejects(f.execute('city', { ...range, pageToken: first.nextPageToken }), { code: 'provider_failed' });
  f.state.response = () => { const raw = analyticsReport('city', { offset: 500, count: 1, total: 501 }); raw.metadata.currencyCode = 'USD'; return raw; };
  await assert.rejects(f.execute('city', { ...range, pageToken: first.nextPageToken }), { code: 'provider_failed' });
  f.advance(600001); const before = f.state.calls.length;
  await assert.rejects(f.execute('city', { ...range, pageToken: first.nextPageToken }), { code: 'invalid_request' }); assert.equal(f.state.calls.length, before);
});
test('the full 100,000-row local ceiling is paginated and explicitly reports remaining provider rows', async t => {
  const f = gaFixture(t); f.state.response = r => analyticsReport('city', { offset: Number(r.json.offset), count: 500, total: 100001 });
  let pageToken = null; let count = 0; let result;
  do { result = (await f.execute('city', { ...range, pageToken })).data; count += result.rows.length; pageToken = result.nextPageToken; } while (pageToken);
  assert.equal(count, 100000); assert.equal(result.rowCount, 100001); assert.equal(result.rowLimitReached, true); assert.equal(f.state.calls.length, 200);
});
test('headers, row cardinality, dates, SQL bounds, restrictions and credential-bearing fields fail closed', async t => {
  const f = gaFixture(t);
  const mutations = [r => { r.dimensionHeaders[1].name = 'foreign'; }, r => { r.metricHeaders[3].name = 'conversions'; },
    r => { r.rows[0].metricValues[0].value = '2147483648'; }, r => { r.rows[0].metricValues[0].value = '1.2'; },
    r => { r.rows[0].metricValues[4].value = '1e100'; }, r => { r.rows[0].dimensionValues[0].value = '20260230'; },
    r => { r.rows[0].dimensionValues[1].value = 'x'.repeat(257); }, r => { r.rows[0].dimensionValues[1].value = ACCESS; },
    r => { r.rows.push(r.rows[0]); r.rowCount = 2; }, r => { r.rowCount = 2; }, r => { r.metadata = {}; }, r => { r.metadata.currencyCode = ['EUR']; },
    r => { r.metadata.schemaRestrictionResponse = { activeMetricRestrictions: [{ metricName: 'totalRevenue' }] }; },
    r => { r.metadata.samplingMetadatas = [{ samplesReadCount: '11', samplingSpaceSize: '10' }]; }];
  for (const mutate of mutations) {
    f.state.response = () => { const result = analyticsReport('city'); mutate(result); return result; };
    await assert.rejects(f.execute('city'), { code: 'provider_failed' });
  }
});
test('quality flags and safe empty metadata survive projection without arbitrary empty reason or quota content', async t => {
  const f = gaFixture(t); f.state.response = () => { const r = analyticsReport('gender', { count: 0 }); Object.assign(r.metadata,
    { subjectToThresholding: true, dataLossFromOtherRow: true, emptyReason: 'FICTITIOUS_RAW_EMPTY_DETAIL',
      samplingMetadatas: [{ samplesReadCount: '5', samplingSpaceSize: '10' }] }); r.propertyQuota = { arbitrary: ACCESS }; return r; };
  const r = (await f.execute('gender')).data; assert.equal(r.metadata.subjectToThresholding, true); assert.equal(r.metadata.dataLossFromOtherRow, true);
  assert.equal(r.metadata.emptyReason, 'provider_report_empty'); assert.equal(r.metadata.samplingMetadatas[0].samplesReadCount, '5');
  assert(!JSON.stringify(r).includes('FICTITIOUS_RAW_EMPTY_DETAIL')); assert.equal(r.propertyQuota, undefined);
});
test('GA v3 credentials bind provider, subject, client and scopes and invalid_grant preserves revocation', async t => {
  const f = gaFixture(t); const original = structuredClone(f.state.secret);
  for (const patch of [{ version: 2 }, { provider: 'google_search_console' }, { googleUserId: 'foreign' }, { clientId: 'foreign' }, { scopes: ['https://www.googleapis.com/auth/webmasters'] }]) {
    Object.assign(f.state.secret, original, patch); await assert.rejects(f.execute('daily'), { code: 'secret_unavailable' });
  }
  assert.equal(f.state.refreshes, 0); Object.assign(f.state.secret, original); f.state.revoked = true;
  await assert.rejects(f.execute('daily'), { code: 'credential_revoked' }); assert.throws(() => f.store.connection('connection:test'), { code: 'connection_blocked' });
});
test('GA metrics/dimensions are not persisted in ledger or audit and durable blocks survive restart', async t => {
  const f = gaFixture(t); await f.execute('city'); const events = [];
  await drainAudit(f.store, { write: async row => { events.push(JSON.parse(row.event)); return { versionId: 'fictitious-s3', digest: row.digest }; } });
  assert(events.some(e => e.version === 2 && e.operation === 'google.analytics.city.read.v1'));
  const durable = JSON.stringify(events) + JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all());
  for (const value of [ACCESS, 'FICTITIOUS_GA_REFRESH', 'FICTITIOUS_GA_CLIENT', 'FICTITIOUS_DIMENSION_']) assert(!durable.includes(value));
  f.broker.block('connection:test', eventFor(f.command('daily'), f.policy.principals[0], f.policy, 'connection.blocked', 'success', 'operator_block'));
  f.store.close(); const store = new BrokerStore(f.filename); const broker = f.make(store); const signed = f.signed(f.command('daily'));
  await assert.rejects(broker.execute(signed.raw, signed.headers), { code: 'connection_blocked' }); store.close(); assert.equal(f.state.calls.length, 1);
});
test('GA transport and runtime configuration permit only the reviewed cohort and fixed runReport POST', async t => {
  const f = gaFixture(t); const config = { enabled: true, cohort: 'google-analytics-read-v1', policy: f.policy, listenAddress: '127.0.0.1', port: 4444,
    stateFile: '/tmp/fictitious-ga.sqlite', tlsCertFile: '/tmp/fictitious.crt', tlsKeyFile: '/tmp/fictitious.key', cursorKeyFile: '/tmp/fictitious.cursor' };
  assert.equal(runtime.validateConfig(config), config);
  for (const mutate of [c => { c.policy.connections[0].googleSubject = 'unknown'; }, c => { c.policy.connections[0].analyticsProperties[0].assetRef = 'ga4:999'; },
    c => { c.policy.connections[0].searchConsoleSites = [{ assetRef: 'sc:foreign', siteUrl: 'https://example.invalid/' }]; },
    c => { c.policy.grants[0].operations = ['google.business_profile.oauth.begin.v1']; }, c => { c.policy.grants[0].tenantRef = 'group:123'; }]) {
    const bad = structuredClone(config); mutate(bad); assert.throws(() => runtime.validateConfig(bad));
  }
  const sent = []; let status = 200;
  const http = createGoogleHttp({ request: (options, callback) => { const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => { sent.push({ options, body }); const res = new PassThrough(); res.statusCode = status; res.headers = { 'content-type': 'application/json' }; callback(res); res.end('{}'); }; return req; } });
  const request = { hostname: 'analyticsdata.googleapis.com', path: '/v1beta/properties/123:runReport', token: Buffer.from(ACCESS), json: {} };
  await http(request); assert.equal(sent[0].options.method, 'POST'); assert.equal(sent[0].options.rejectUnauthorized, true);
  for (const patch of [{ hostname: 'analyticsadmin.googleapis.com' }, { path: '/v1beta/properties/123:batchRunReports' }, { path: '/v1beta/properties/0123:runReport' },
    { path: request.path + '?x=1' }, { form: 'arbitrary' }, { json: undefined }]) await assert.rejects(http({ ...request, ...patch }), { code: 'invalid_request' });
  status = 302; await assert.rejects(http(request), { code: 'provider_failed' });
});
module.exports = { gaFixture };

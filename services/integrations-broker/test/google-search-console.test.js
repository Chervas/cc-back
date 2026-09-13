'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto'); const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const { fixture } = require('./helpers'); const { Broker } = require('../src/broker'); const { BrokerStore } = require('../src/store');
const contract = require('../src/google-search-console-contract'); const { createSearchConsoleOperations } = require('../src/google-search-console');
const { createGoogleSecretStore } = require('../src/google-secrets'); const { createGoogleHttp } = require('../src/google-http');
const { cursorCodec } = require('../src/provider-cursor'); const { eventFor, drainAudit } = require('../src/audit'); const runtime = require('../src/google-main');
const ACCESS = 'FICTITIOUS_SC_ACCESS'; const REFRESH = 'FICTITIOUS_SC_REFRESH'; const CLIENT = 'FICTITIOUS_SC_CLIENT';
const SITE = contract.site('sc-domain:example.invalid'); const START = '2026-09-01'; const END = '2026-09-02';
test('SC discovery reads only the registered site and excludes unverified or foreign provider entries', async t => {
  const f = await scFixture(t);
  await assert.rejects(f.execute('discovery', { siteUrl: 'sc-domain:foreign.invalid' }), { code: 'invalid_request' });
  await assert.rejects(f.execute('discovery', {}, { tenantRef: 'clinic:999' }), { code: 'scope_denied' });
  assert.equal(f.sdkCalls.length, 0);
  f.state.response = () => ({ siteUrl: SITE.siteUrl, permissionLevel: 'siteOwner', token: ACCESS });
  assert.deepEqual((await f.execute('discovery', {})).data, { siteUrl: SITE.siteUrl, permissionLevel: 'siteOwner' });
  assert.equal(f.calls[0].hostname, 'www.googleapis.com'); assert.equal(f.calls[0].path, '/webmasters/v3/sites/sc-domain%3Aexample.invalid');
  assert.equal(f.calls[0].json, undefined);
  for (const result of [{ siteUrl: 'sc-domain:foreign.invalid', permissionLevel: 'siteOwner' },
    { siteUrl: SITE.siteUrl, permissionLevel: 'siteUnverifiedUser' }, { siteUrl: SITE.siteUrl, permissionLevel: [ACCESS] }]) {
    f.state.response = () => result; await assert.rejects(f.execute('discovery', {}), { code: 'provider_failed' });
  }
  const rows = JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all()); assert(!rows.includes(SITE.siteUrl));
});
async function scFixture(t) {
  let at = Date.now(); const f = fixture(t, { now: () => at }); const calls = []; const sdkCalls = [];
  const secretArn = 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-sc-abcdef';
  const appArn = secretArn.replace('fictitious-sc', 'fictitious-app');
  const connection = { version: 3, provider: contract.PROVIDER, connectionRef: 'connection:test', googleUserId: 'fictitious-subject',
    clientId: 'fictitious.apps.googleusercontent.com', refreshToken: REFRESH, scopes: [contract.SCOPES[0]] };
  const app = { version: 1, provider: 'google-oauth-client', clientId: connection.clientId, clientSecret: CLIENT };
  f.policy.connections[0] = { ...f.policy.connections[0], provider: contract.PROVIDER, secretArn, clientSecretArn: appArn,
    googleSubject: connection.googleUserId, searchConsoleSites: [{ siteUrl: SITE.siteUrl, assetRef: SITE.assetRef }] };
  f.policy.grants[0] = { ...f.policy.grants[0], assetRef: SITE.assetRef, operations: contract.OPERATIONS };
  f.policy.maxBacklog = 10000; f.policy.principals[0].maxPerMinute = 600;
  const state = { connection, app, version: 'fictitious-version-1', response: null, beforeResponse: null, refreshes: 0, revoked: false };
  const sdk = { async send(command) {
    const arn = command.input.SecretId; sdkCalls.push(command.constructor.name); assert([secretArn, appArn].includes(arn));
    if (command.constructor.name === 'DescribeSecretCommand') return { ARN: arn, KmsKeyId: runtime.SECRET_KEY };
    assert.equal(command.constructor.name, 'GetSecretValueCommand');
    return { ARN: arn, VersionId: state.version, VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(arn === secretArn ? connection : app) };
  } };
  const http = async request => {
    if (request.hostname === 'oauth2.googleapis.com') {
      state.refreshes++; if (state.revoked) throw new (require('../src/errors').BrokerError)('credential_revoked');
      assert.equal(request.path, '/token'); assert(new URLSearchParams(request.form).get('refresh_token') === REFRESH);
      return { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600, scope: contract.SCOPES[0] };
    }
    calls.push(request); assert.equal(request.token.toString(), ACCESS); await state.beforeResponse?.(request);
    if (state.response) return state.response(request);
    return request.hostname === 'searchconsole.googleapis.com'
      ? { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Indexed', googleCanonical: ACCESS }, token: REFRESH } }
      : { rows: [{ keys: request.json.dimensions.length === 3 ? [START, 'FICTITIOUS_QUERY', 'https://example.invalid/page']
        : request.json.dimensions[0] === 'page' ? ['https://example.invalid/page'] : [START], clicks: 4, impressions: 8, ctr: 0.5, position: 1, secret: ACCESS }], extra: REFRESH };
  };
  const secrets = createGoogleSecretStore({ provider: contract.PROVIDER, client: sdk, http, accountId: runtime.ACCOUNT,
    prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtime.SECRET_KEY, now: () => at });
  t.after(() => secrets.close()); const cursor = cursorCodec(randomBytes(32), () => at);
  const make = store => new Broker({ store, policy: f.policy, secrets, operations: createSearchConsoleOperations({ http, cursor }), now: () => at });
  const broker = make(f.store);
  const command = (family, payload, overrides = {}) => f.command({ operation: contract.PREFIX + family + '.read.v1', assetRef: SITE.assetRef, payload, ...overrides });
  const execute = (family, payload, overrides) => { const req = f.signed(command(family, payload, overrides)); return broker.execute(req.raw, req.headers); };
  return { ...f, broker, command, execute, state, calls, sdkCalls, make, advance: ms => { at += ms; } };
}
test('four closed SC operations select only registered properties, fixed dimensions and sanitized provider fields', async t => {
  const f = await scFixture(t);
  for (const [family, payload] of [['timeseries', { startDate: START, endDate: END }], ['queries', { startDate: START, endDate: END, pageToken: null }],
    ['pages', { startDate: START, endDate: END, startRow: 0, rowLimit: 10 }], ['inspection', {}]]) {
    const result = await f.execute(family, payload); assert(!JSON.stringify(result).includes(ACCESS)); assert(!JSON.stringify(result).includes(REFRESH));
  }
  assert.equal(f.state.refreshes, 1); assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls[0].json.dimensions, ['date']); assert.equal(f.calls[0].json.dataState, 'final'); assert.equal(f.calls[0].json.type, 'web');
  assert.deepEqual(f.calls[1].json.dimensions, ['date', 'query', 'page']); assert.equal(f.calls[1].json.rowLimit, 500);
  assert.equal(f.calls[2].json.startRow, 0); assert.equal(f.calls[2].json.rowLimit, 10);
  assert.equal(f.calls[3].path, '/v1/urlInspection/index:inspect'); assert.deepEqual(f.calls[3].json, { siteUrl: SITE.siteUrl, inspectionUrl: 'https://example.invalid/', languageCode: 'en-US' });
  assert(f.calls.slice(0, 3).every(r => r.hostname === 'www.googleapis.com' && r.path === '/webmasters/v3/sites/sc-domain%3Aexample.invalid/searchAnalytics/query'));
});
test('tenant, property, operation, date and arbitrary-payload denials precede any provider access', async t => {
  const f = await scFixture(t);
  for (const overrides of [{ tenantRef: 'clinic:999' }, { assetRef: contract.site('sc-domain:other.invalid').assetRef }, { operation: 'google.search_console.write.v1' }])
    await assert.rejects(f.execute('timeseries', { startDate: START, endDate: END }, overrides));
  for (const payload of [{}, { startDate: '2026-02-30', endDate: END }, { startDate: END, endDate: START },
    { startDate: '2020-01-01', endDate: END }, { startDate: START, endDate: END, siteUrl: SITE.siteUrl },
    { startDate: START, endDate: END, accessToken: ACCESS }]) await assert.rejects(f.execute('timeseries', payload), { code: 'invalid_request' });
  await assert.rejects(f.execute('inspection', { inspectionUrl: 'https://foreign.invalid/' }), { code: 'invalid_request' });
  assert.equal(f.calls.length + f.sdkCalls.length + f.state.refreshes, 0);
});
test('opaque query cursors bind operation, property, scope, policy and date range; expired cursors cannot send', async t => {
  const f = await scFixture(t); f.state.response = request => ({ rows: Array.from({ length: request.json.startRow ? 1 : 500 }, (_, i) => ({
    keys: [START, 'query-' + (request.json.startRow + i), 'https://example.invalid/page'], clicks: 1, impressions: 2, ctr: 0.5, position: 1 })) });
  const first = (await f.execute('queries', { startDate: START, endDate: END, pageToken: null })).data;
  assert(first.nextPageToken); assert(!first.nextPageToken.includes('startRow')); assert.equal(first.rowLimitReached, false);
  await assert.rejects(f.execute('queries', { startDate: START, endDate: '2026-09-03', pageToken: first.nextPageToken }), { code: 'invalid_request' });
  await assert.rejects(f.execute('queries', { startDate: START, endDate: END, pageToken: first.nextPageToken.slice(0, -1) }), { code: 'invalid_request' });
  assert.equal(f.calls.length, 1);
  const second = (await f.execute('queries', { startDate: START, endDate: END, pageToken: first.nextPageToken })).data;
  assert.equal(f.calls[1].json.startRow, 500); assert.equal(second.nextPageToken, null);
  f.advance(600001); await assert.rejects(f.execute('queries', { startDate: START, endDate: END, pageToken: first.nextPageToken }), { code: 'invalid_request' });
  assert.equal(f.calls.length, 2);
});
test('25,000-row query ceiling is explicit and prevents an extra page', async t => {
  const f = await scFixture(t); f.state.response = r => ({ rows: Array.from({ length: 500 }, (_, i) => ({
    keys: [START, 'query-' + (r.json.startRow + i), 'https://example.invalid/page'], clicks: 1, impressions: 1, ctr: 1, position: 1 })) });
  let pageToken = null; let count = 0; let result;
  do { result = (await f.execute('queries', { startDate: START, endDate: END, pageToken })).data; count += result.rows.length; pageToken = result.nextPageToken; } while (pageToken);
  assert.equal(count, 25000); assert.equal(f.calls.length, 50); assert.equal(result.rowLimitReached, true);
});
test('oversized, malformed, duplicate or credential-bearing result fields cannot cross the broker', async t => {
  const f = await scFixture(t);
  for (const rows of [[{ keys: [START], clicks: -1 }], [{ keys: [START], clicks: '1' }], [{ keys: ['2026-08-01'] }],
    [{ keys: [START], ctr: 2 }], [{ keys: [START] }, { keys: [START] }], Array.from({ length: 551 }, () => ({ keys: [START] }))]) {
    f.state.response = () => ({ rows }); await assert.rejects(f.execute('timeseries', { startDate: START, endDate: END }), { code: 'provider_failed' });
  }
  f.state.response = () => ({ rows: [{ keys: [START, ACCESS, 'https://example.invalid/page'] }] });
  await assert.rejects(f.execute('queries', { startDate: START, endDate: END, pageToken: null }), { code: 'provider_failed' });
  f.state.response = () => ({ rows: [{ keys: [START, 'x'.repeat(8193), 'https://example.invalid/page'] }] });
  await assert.rejects(f.execute('queries', { startDate: START, endDate: END, pageToken: null }), { code: 'provider_failed' });
});
test('SC v3 secret pins provider, exact subject, client and scope; invalid_grant persists revocation', async t => {
  const f = await scFixture(t); const original = structuredClone(f.state.connection);
  for (const change of [{ version: 2 }, { provider: 'google_business_profile' }, { googleUserId: 'foreign-subject' },
    { clientId: 'foreign-client' }, { scopes: ['https://www.googleapis.com/auth/business.manage'] }]) {
    Object.assign(f.state.connection, original, change);
    await assert.rejects(f.execute('timeseries', { startDate: START, endDate: END }), { code: 'secret_unavailable' });
  }
  assert.equal(f.state.refreshes, 0); Object.assign(f.state.connection, original); f.state.revoked = true;
  await assert.rejects(f.execute('timeseries', { startDate: START, endDate: END }), { code: 'credential_revoked' });
  assert.throws(() => f.store.connection('connection:test'), { code: 'connection_blocked' });
  assert.equal(f.store.db.prepare('SELECT state FROM connections WHERE ref=?').get('connection:test').state, 'revoked');
});
test('blocked connection survives restart and read result/query contents never enter durable commands or audit', async t => {
  const f = await scFixture(t); await f.execute('queries', { startDate: START, endDate: END, pageToken: null });
  const delivered = []; await drainAudit(f.store, { write: async row => { delivered.push(JSON.parse(row.event)); return { versionId: 'fictitious', digest: row.digest }; } });
  assert(delivered.some(e => e.version === 2 && e.operation === contract.OPERATIONS[1] && e.resourceRef === SITE.assetRef));
  const serialized = JSON.stringify(delivered) + JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all());
  for (const secret of [ACCESS, REFRESH, CLIENT, 'FICTITIOUS_QUERY', 'https://example.invalid/page']) assert(!serialized.includes(secret));
  f.broker.block('connection:test', eventFor(f.command('timeseries', {}), f.policy.principals[0], f.policy, 'connection.blocked', 'success', 'operator_block'));
  f.store.close(); const next = new BrokerStore(f.filename); const broker = f.make(next);
  const signed = f.signed(f.command('timeseries', { startDate: START, endDate: END }));
  await assert.rejects(broker.execute(signed.raw, signed.headers), { code: 'connection_blocked' }); next.close(); assert.equal(f.calls.length, 1);
});
test('SC HTTPS transport permits only fixed JSON POST paths and rejects arbitrary hosts, forms and redirects', async () => {
  const sent = []; let status = 200;
  const transport = createGoogleHttp({ request: (options, callback) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => { sent.push({ options, body }); const res = new PassThrough(); res.statusCode = status; res.headers = { 'content-type': 'application/json' }; callback(res); res.end('{}'); };
    return req;
  } });
  const request = { hostname: 'searchconsole.googleapis.com', path: '/v1/urlInspection/index:inspect', token: Buffer.from(ACCESS), json: { siteUrl: SITE.siteUrl } };
  await transport(request); assert.equal(sent[0].options.method, 'POST'); assert.equal(sent[0].options.headers['content-type'], 'application/json');
  assert.equal(sent[0].options.rejectUnauthorized, true); assert.equal(sent[0].body, JSON.stringify(request.json));
  for (const patch of [{ hostname: 'searchconsole.googleapis.com.evil.invalid' }, { path: '/v1/arbitrary' }, { path: request.path + '?x=1' }, { form: 'x=1' }, { json: null }])
    await assert.rejects(transport({ ...request, ...patch }), { code: 'invalid_request' });
  status = 302; await assert.rejects(transport(request), { code: 'provider_failed' });
});
test('SC runtime policy is read-only, scoped to exact property hashes and cannot enable OAuth or GBP operations', async t => {
  const f = await scFixture(t); const config = { enabled: true, cohort: 'google-search-console-read-v1', listenAddress: '127.0.0.1', port: 4444,
    stateFile: '/tmp/fictitious-sc.sqlite', tlsCertFile: '/tmp/fictitious.crt', tlsKeyFile: '/tmp/fictitious.key', cursorKeyFile: '/tmp/fictitious-cursor.key', policy: f.policy };
  assert.equal(runtime.validateConfig(config), config);
  for (const patch of [c => { c.policy.connections[0].googleSubject = 'unknown'; }, c => { c.policy.connections[0].searchConsoleSites[0].siteUrl = 'https://foreign.invalid/'; },
    c => { c.policy.grants[0].operations = ['google.business_profile.oauth.begin.v1']; }, c => { c.policy.grants[0].tenantRef = 'group:123'; }]) {
    const bad = structuredClone(config); patch(bad); assert.throws(() => runtime.validateConfig(bad));
  }
  for (const site of ['http://127.0.0.1/', 'https://u:p@example.invalid/', 'https://example.invalid/x', 'https://example.invalid/%2e/', 'https://EXAMPLE.invalid/', 'sc-domain:example.invalid/']) assert.throws(() => contract.site(site));
});

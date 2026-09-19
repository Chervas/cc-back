'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { fixture } = require('./helpers');
const { Broker } = require('../src/broker'), { BrokerStore } = require('../src/store');
const { createBusinessProfileWrites } = require('../src/google-business-profile-writes');
const C = require('../src/google-business-profile-write-contract');
const reads = require('../src/google-business-profile-contract');
const { createGoogleHttp } = require('../src/google-http');
const { eventFor } = require('../src/audit');
const { signRequest } = require('../src/auth');
const { fail } = require('../src/errors');
const runtime = require('../src/google-main');
const ACCESS = 'FICTITIOUS_GBP_WRITE_ACCESS';
const ASSET = 'gbp:123:456', TENANT = 'clinic:123', PARENT = 'accounts/123/locations/456';
const PHOTO = C.PUBLIC_ORIGIN + '/marketing/clinic-123/2026/09/00000000-0000-4000-8000-000000000001.jpg';
const reply = () => ({ operationId: randomUUID(), reviewId: 'review_1', comment: 'FICTITIOUS_PUBLIC_REPLY' });
const photo = () => ({ operationId: randomUUID(), sourceUrl: PHOTO, category: 'ADDITIONAL', description: null });
const hours = (periods = []) => ({ operationId: randomUUID(), periods });
const closed = (startDate = '2026-12-24', endDate = startDate) => ({ kind: 'closed', startDate, endDate, openTime: null, closeTime: null });
const open = (openTime, closeTime) => ({ ...closed(), kind: 'open', openTime, closeTime });
function setup(t) {
  const f = fixture(t), state = { secrets: 0, reads: 0, writes: 0, calls: [] };
  const binding = f.policy.connections[0] = { ...f.policy.connections[0], provider: C.PROVIDER,
    secretArn: 'qa-google', clientSecretArn: 'qa-client', googleBusinessProfileWrites: { locations: [{
      assetRef: ASSET, tenantRef: TENANT, allowReviewReplies: true, allowPhotos: true, allowSpecialHours: true,
    }] } };
  f.policy.maxBacklog = 1000;
  f.policy.grants[0] = { ...f.policy.grants[0], assetRef: ASSET, operations: Object.values(C.OPERATIONS) };
  const http = async request => {
    assert.equal(request.token.toString(), ACCESS); state.calls.push(request);
    if (!request.businessProfileMutation) {
      state.reads++; return state.regular || { name: 'locations/456', regularHours: { periods: [{ openDay: 'MONDAY' }] } };
    }
    state.writes++; await state.beforeReturn?.(request);
    if (state.response) return state.response(request);
    if (request.businessProfileMutation === 'replyUpdate') return { ...request.json, updateTime: '2026-09-19T12:00:00Z', ignored: ACCESS };
    if (request.businessProfileMutation === 'replyDelete') return {};
    if (request.businessProfileMutation === 'hours') return { ...request.json, ignored: ACCESS };
    return { name: PARENT + '/media/one', mediaFormat: 'PHOTO', sourceUrl: 'https://lh3.googleusercontent.com/fictitious', ignored: ACCESS };
  };
  let store = f.store, broker;
  const secrets = { invalidate() {}, async withSecret(binding, work, options) {
    state.secrets++; assert.deepEqual(options.requiredScopes, C.SCOPES);
    if (state.secretFailure) fail('secret_unavailable');
    await state.beforeSecret?.(); return work(Buffer.from(ACCESS));
  } };
  const reset = () => { broker = new Broker({ store, policy: f.policy, secrets,
    operations: createBusinessProfileWrites({ store, http }).operations }); };
  reset();
  const command = (kind, payload, rest = {}) => f.command({ operation: C.OPERATIONS[kind], assetRef: ASSET, payload, ...rest });
  const execute = (value, signing = {}) => {
    const signed = signRequest(value, { keyId: 'qa-key', privateKey: f.keys.privateKey, audience: f.policy.audience, ...signing });
    return broker.execute(signed.raw, signed.headers);
  };
  return { ...f, state, binding, http, command, execute, reset, store: () => store, broker: () => broker,
    status: async id => (await execute(command('status', { operationId: id }))).data,
    reopen() { store.close(); store = new BrokerStore(f.filename); reset(); t.after(() => { try { store.close(); } catch {} }); } };
}
test('four typed writers use exact resources, project outputs, persist receipts and audit metadata only', async t => {
  const f = setup(t);
  for (const [kind, input] of [['replyUpdate', reply()], ['replyDelete', { operationId: randomUUID(), reviewId: 'review_1' }],
    ['photo', photo()], ['hours', hours([closed(), open('09:00', '12:00')].slice(0, 1))]]) {
    const command = f.command(kind, input), result = await f.execute(command);
    assert.equal(result.data.state, 'applied'); assert.equal(result.data.kind, kind);
    assert.equal((await f.execute(command)).replayed, true);
    assert.deepEqual((await f.execute(f.command(kind, input))).data, result.data);
    const secrets = f.state.secrets; assert.deepEqual(await f.status(input.operationId), result.data); assert.equal(f.state.secrets, secrets);
  }
  assert.equal(f.state.writes, 4); assert.equal(f.state.reads, 1);
  assert.equal(f.state.calls[0].path, `/v4/${PARENT}/reviews/review_1/reply`);
  assert.equal(f.state.calls[1].json, undefined); assert.equal(f.state.calls[2].json.sourceUrl, PHOTO);
  assert.equal(f.state.calls.at(-1).path, '/v1/locations/456?updateMask=specialHours');
  assert.equal(f.store().db.prepare('SELECT COUNT(*) n FROM google_business_profile_mutation_locks').get().n, 0);
  for (const sql of ['SELECT * FROM google_business_profile_mutations WHERE id=?',
    'DELETE FROM google_business_profile_mutation_locks WHERE operation_id=?']) {
    const plan = f.store().db.prepare('EXPLAIN QUERY PLAN ' + sql).all(randomUUID());
    assert(plan.some(row => /SEARCH .* USING .*INDEX/.test(row.detail))); assert(!plan.some(row => /SCAN /.test(row.detail)));
  }
  const audit = JSON.stringify(f.store().db.prepare('SELECT event FROM audit_outbox').all());
  for (const value of [ACCESS, PHOTO, 'FICTITIOUS_PUBLIC_REPLY']) assert(!audit.includes(value));
  assert(audit.includes('business_profile_mutation_applied'));
  for (const table of ['commands', 'google_business_profile_mutations']) assert(!JSON.stringify(f.store().db.prepare('SELECT * FROM ' + table).all()).includes(ACCESS));
});
test('invalid scope, capability, payload and private/cross-clinic photo URLs never read credentials', async t => {
  const f = setup(t);
  const commands = [f.command('replyUpdate', { ...reply(), method: 'PUT' }), f.command('replyUpdate', { ...reply(), reviewId: '../elsewhere' }),
    f.command('replyUpdate', { ...reply(), comment: ' ' }), f.command('replyUpdate', { ...reply(), comment: '🌻'.repeat(2049) }), f.command('replyUpdate', reply(), { tenantRef: 'clinic:999' }),
    f.command('replyUpdate', reply(), { assetRef: 'gbp:123:999' }), f.command('photo', { ...photo(), category: 'VIDEO' }),
    f.command('photo', { ...photo(), category: 'COVER', description: 'bad' }),
    ...[PHOTO + '?signature=private', PHOTO.replace('clinic-123', 'clinic-999'), PHOTO.replace('marketing', 'clinical'),
      PHOTO.replace('https:', 'http:'), PHOTO.replace('media.clinicaclick.com', 'media.clinicaclick.com.evil.invalid'),
      PHOTO.replace('2026/09/', '2026/09/../'), 'https://169.254.169.254/latest', PHOTO + '#fragment']
      .map(sourceUrl => f.command('photo', { ...photo(), sourceUrl })),
    f.command('hours', hours([closed('2026-02-30')])), f.command('hours', hours([open('12:00', '10:00')])),
    f.command('hours', hours([open('09:00', '12:00'), open('11:00', '13:00')])),
    f.command('hours', hours([closed(), open('09:00', '12:00')])),
    f.command('hours', { ...hours(), updateMask: 'regularHours' })];
  for (const command of commands) await assert.rejects(f.execute(command));
  f.binding.googleBusinessProfileWrites.locations[0].allowPhotos = false; f.reset();
  await assert.rejects(f.execute(f.command('photo', photo())), { code: 'scope_denied' });
  assert.equal(f.state.secrets, 0); assert.equal(f.state.writes, 0);
});
test('hours preserve 730 expanded days, split shifts and explicit clearing without expanding signed requests', async t => {
  const f = setup(t), input = hours([closed('2026-01-01', '2027-12-31')]);
  assert(Buffer.byteLength(JSON.stringify(input)) < 400);
  const result = await f.execute(f.command('hours', input));
  assert.equal(result.data.result.specialHours.specialHourPeriods.length, 730);
  assert.equal(f.state.calls.at(-1).json.specialHours.specialHourPeriods.length, 730);
  await assert.rejects(f.execute(f.command('hours', hours([closed('2026-01-01', '2028-01-01')]))), { code: 'invalid_request' });
  assert.equal((await f.execute(f.command('hours', hours([open('09:00', '12:00'), open('12:00', '17:00')])))).data.result.specialHours.specialHourPeriods.length, 2);
  assert.deepEqual((await f.execute(f.command('hours', hours()))).data.result.specialHours, { specialHourPeriods: [] });
  f.state.regular = { name: 'locations/456', regularHours: {} };
  const missing = hours(); await assert.rejects(f.execute(f.command('hours', missing)), { code: 'business_profile_regular_hours_required' });
  assert.equal((await f.status(missing.operationId)).state, 'not_found'); assert.equal(f.state.writes, 3);
});
test('lost consumer ACK recovers after SQLite reopen without a credential or another provider mutation', async t => {
  const f = setup(t), input = photo(); await f.execute(f.command('photo', input));
  f.reopen(); f.state.secretFailure = true;
  const result = await f.status(input.operationId); assert.equal(result.state, 'applied');
  assert.equal(result.result.name, PARENT + '/media/one'); assert.equal(f.state.writes, 1);
  assert.equal(f.state.secrets, 1);
  await assert.rejects(f.execute(f.command('photo', { ...input, description: 'changed' })), { code: 'idempotency_conflict' });
  assert.equal(f.state.secrets, 1);
});
test('lost provider ACK holds durable locks across new request IDs, operation IDs and restarts', async t => {
  const f = setup(t), input = photo(); f.state.beforeReturn = () => fail('provider_timeout');
  await assert.rejects(f.execute(f.command('photo', input)), { code: 'provider_timeout' });
  f.reopen(); delete f.state.beforeReturn;
  assert.equal((await f.status(input.operationId)).state, 'unknown');
  await assert.rejects(f.execute(f.command('photo', input)), { code: 'outcome_unknown' });
  await assert.rejects(f.execute(f.command('photo', photo())), { code: 'business_profile_mutation_busy' });
  assert.equal(f.state.writes, 1);
  const other = { ...photo(), sourceUrl: PHOTO.replace('000000000001.jpg', '000000000002.jpg') };
  await f.execute(f.command('photo', other)); assert.equal(f.state.writes, 2);
});
test('a late provider success after the broker deadline remains unknown and cannot release its lock', async t => {
  const f = setup(t), input = reply(); let release;
  f.state.beforeReturn = () => new Promise(resolve => { release = resolve; });
  f.broker().timeoutMs = 10;
  await assert.rejects(f.execute(f.command('replyUpdate', input)), { code: 'provider_timeout' });
  release(); await new Promise(resolve => setImmediate(resolve)); delete f.state.beforeReturn;
  f.broker().timeoutMs = 10000;
  assert.equal((await f.status(input.operationId)).state, 'unknown');
  await assert.rejects(f.execute(f.command('replyUpdate', reply())), { code: 'business_profile_mutation_busy' });
  assert.equal(f.state.writes, 1);
});
test('another SQLite connection observes the durable boundary and cannot bypass it', async t => {
  const f = setup(t), input = photo(); f.state.beforeReturn = () => fail('provider_failed');
  await assert.rejects(f.execute(f.command('photo', input)));
  const store = new BrokerStore(f.filename); t.after(() => store.close()); let providerCalls = 0;
  const peer = new Broker({ store, policy: f.policy, secrets: { invalidate() {}, withSecret: (_binding, work) => work(Buffer.from(ACCESS)) },
    operations: createBusinessProfileWrites({ store, http: async () => { providerCalls++; throw Error('MUST_NOT_SEND'); } }).operations });
  const signed = f.signed(f.command('photo', photo()));
  await assert.rejects(peer.execute(signed.raw, signed.headers), { code: 'business_profile_mutation_busy' });
  assert.equal(providerCalls, 0); assert.equal(f.state.writes, 1);
});
test('concurrent replies cannot overtake an uncertain update with a deletion or another principal/account', async t => {
  const f = setup(t), input = reply(); let release;
  f.state.beforeReturn = () => new Promise(resolve => { release = resolve; });
  const running = f.execute(f.command('replyUpdate', input)); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.status(input.operationId)).state, 'unknown');
  await assert.rejects(f.execute(f.command('replyDelete', { operationId: randomUUID(), reviewId: input.reviewId })), { code: 'business_profile_mutation_busy' });
  const keys = generateKeyPairSync('ed25519');
  f.policy.principals.push({ ...f.policy.principals[0], id: 'writer:other', keyId: 'key:other', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) });
  f.binding.googleBusinessProfileWrites.locations.push({ ...f.binding.googleBusinessProfileWrites.locations[0], assetRef: 'gbp:999:456' });
  f.policy.grants.push({ ...f.policy.grants[0], principalId: 'writer:other', assetRef: 'gbp:999:456' }); f.reset();
  await assert.rejects(f.execute(f.command('replyUpdate', reply(), { assetRef: 'gbp:999:456' }), { keyId: 'key:other', privateKey: keys.privateKey }), { code: 'business_profile_mutation_busy' });
  assert.equal(f.state.writes, 1); release(); await running;
});
test('profile/LOGO keeps a slot lock, accepts Google hosted source and never uses epoch as completion time', async t => {
  const f = setup(t), input = { ...photo(), category: 'LOGO' };
  f.state.response = () => ({ name: PARENT + '/media/profile', mediaFormat: 'PHOTO', sourceUrl: 'https://lh3.googleusercontent.com/profile',
    locationAssociation: { category: 'PROFILE' }, createTime: '1970-01-01T00:00:00Z' });
  const result = await f.execute(f.command('photo', input));
  assert.equal(result.data.result.locationAssociation.category, 'PROFILE'); assert(result.data.completedAt > 0);
  f.state.beforeReturn = () => fail('provider_failed');
  await assert.rejects(f.execute(f.command('photo', { ...photo(), category: 'PROFILE' })));
  delete f.state.beforeReturn;
  await assert.rejects(f.execute(f.command('photo', { ...photo(), category: 'LOGO', sourceUrl: PHOTO.replace('000000000001', '000000000002') })), { code: 'business_profile_mutation_busy' });
  assert.equal(f.state.writes, 2);
});
test('foreign receipts, removed permissions, key replacement and changed credentials are denied', async t => {
  const f = setup(t), input = reply(); await f.execute(f.command('replyUpdate', input));
  f.binding.googleBusinessProfileWrites.locations.push({ ...f.binding.googleBusinessProfileWrites.locations[0], tenantRef: 'clinic:999' });
  f.policy.grants.push({ ...f.policy.grants[0], tenantRef: 'clinic:999' }); f.reset();
  await assert.rejects(f.execute(f.command('status', { operationId: input.operationId }, { tenantRef: 'clinic:999' })), { code: 'scope_denied' });
  f.policy.grants[0].operations = [C.OPERATIONS.status]; f.reset();
  await assert.rejects(f.status(input.operationId), { code: 'scope_denied' });
  f.policy.grants[0].operations = Object.values(C.OPERATIONS); f.binding.clientSecretArn += '-changed'; f.reset();
  await assert.rejects(f.status(input.operationId), { code: 'scope_denied' });
  f.binding.clientSecretArn = 'qa-client';
  const keys = generateKeyPairSync('ed25519'); f.policy.principals[0].publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }); f.reset();
  await assert.rejects(f.execute(f.command('status', { operationId: input.operationId }), { privateKey: keys.privateKey }), { code: 'scope_denied' });
  assert.equal(f.state.secrets, 1); assert.equal(f.state.writes, 1);
});
test('provider success followed by audit failure or revocation never exposes an applied receipt', async t => {
  const f = setup(t), input = reply(), append = f.store().appendAudit.bind(f.store());
  f.store().appendAudit = event => { if (event.action === 'integration.completed') fail('audit_unavailable'); return append(event); };
  await assert.rejects(f.execute(f.command('replyUpdate', input)), { code: 'audit_unavailable' });
  f.store().appendAudit = append; assert.equal((await f.status(input.operationId)).state, 'unknown');
  await assert.rejects(f.execute(f.command('replyUpdate', reply())), { code: 'business_profile_mutation_busy' });
  const p = photo(), request = f.command('photo', p);
  f.state.beforeReturn = () => f.broker().block(request.connectionRef, eventFor(request, f.policy.principals[0], f.policy,
    'connection.blocked', 'success', 'operator_block'));
  await assert.rejects(f.execute(request));
  assert.equal(f.store().db.prepare('SELECT state FROM google_business_profile_mutations WHERE id=?').get(p.operationId).state, 'attempted');
  await assert.rejects(f.status(p.operationId), { code: 'connection_blocked' }); assert.equal(f.state.writes, 2);
});
test('admission failure stops all provider access; malformed provider data remains uncertain', async t => {
  const f = setup(t); f.broker().policy.maxBacklog = 2;
  await f.status(randomUUID()); await assert.rejects(f.execute(f.command('photo', photo())), { code: 'audit_unavailable' });
  assert.equal(f.state.secrets, 0); f.broker().policy.maxBacklog = 1000;
  f.state.response = () => ({ name: 'accounts/123/locations/999/media/one' }); const input = photo();
  await assert.rejects(f.execute(f.command('photo', input)), { code: 'scope_denied' });
  assert.equal((await f.status(input.operationId)).state, 'unknown'); assert.equal(f.state.writes, 1);
});
test('malformed schedules and replies cannot be projected as successful provider writes', () => {
  const target = reads.asset(ASSET), input = hours([closed()]);
  for (const specialHours of [null, [], { specialHourPeriods: [{}] }, { specialHourPeriods: [] },
    { specialHourPeriods: [{ startDate: { year: 2026, month: 2, day: 30 }, closed: true }] },
    { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 24 }, openTime: { hours: 25 }, closeTime: {} }] }]) {
    assert.throws(() => C.project('hours', { name: 'locations/456', specialHours }, target, input), { code: 'provider_failed' });
  }
  assert.throws(() => C.project('replyUpdate', { comment: null }, target), { code: 'provider_failed' });
  assert.throws(() => C.project('replyDelete', { errorDetails: 'bad' }, target), { code: 'provider_failed' });
});
test('read-only cohort cannot acquire writer capabilities; writers use distinct keys from readers and revokers', t => {
  const f = setup(t);
  const config = { cohort: C.COHORT, enabled: true, listenAddress: '127.0.0.1', port: 4443, policy: f.policy,
    stateFile: f.filename, cursorKeyFile: '/qa/cursor', tlsKeyFile: '/qa/key', tlsCertFile: '/qa/cert' };
  assert.equal(runtime.validateConfig(config), config);
  assert.throws(() => runtime.validateConfig({ ...config, cohort: 'google-business-profile-read-v1' }), { code: 'invalid_request' });
  for (const operation of [reads.OPERATIONS[0], reads.REVOKE_OPERATION]) {
    const copy = structuredClone(config); copy.policy.grants[0].operations.push(operation);
    assert.throws(() => runtime.validateConfig(copy), { code: 'invalid_request' });
    const sameKey = structuredClone(config); sameKey.policy.principals.push({ ...sameKey.policy.principals[0], id: 'reader', keyId: 'reader-key' });
    sameKey.policy.grants.push({ ...sameKey.policy.grants[0], principalId: 'reader', operations: [operation] });
    assert.throws(() => runtime.validateConfig(sameKey), { code: 'invalid_request' });
    sameKey.policy.principals[1].publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    runtime.validateConfig(sameKey);
  }
  const denied = structuredClone(config); denied.policy.connections[0].googleBusinessProfileWrites.locations[0].allowPhotos = false;
  assert.throws(() => runtime.validateConfig(denied), { code: 'invalid_request' });
});
test('transport fixes four methods and rejects endpoint, mask, body and gate changes before sockets', async () => {
  const calls = [];
  const transport = options => createGoogleHttp({ businessProfileWritesEnabled: true, ...options, request: (opts, callback) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => { calls.push({ ...opts, body }); const res = new PassThrough(); res.statusCode = 200;
      res.headers = { 'content-type': 'application/json' }; callback(res); res.end('{}'); };
    return req;
  } });
  const base = { hostname: 'mybusiness.googleapis.com', path: `/v4/${PARENT}/reviews/review_1/reply`, token: Buffer.from(ACCESS), businessProfileMutation: 'replyUpdate', json: { comment: 'reply' } };
  await transport()(base); await transport()({ ...base, businessProfileMutation: 'replyDelete', json: undefined });
  await transport()({ ...base, businessProfileMutation: 'photo', path: `/v4/${PARENT}/media`,
    json: { sourceUrl: PHOTO, mediaFormat: 'PHOTO', locationAssociation: { category: 'ADDITIONAL' } } });
  const patch = { ...base, hostname: 'mybusinessbusinessinformation.googleapis.com', path: '/v1/locations/456?updateMask=specialHours',
    businessProfileMutation: 'hours', json: { name: 'locations/456', specialHours: { specialHourPeriods: C.expandPeriods([closed('2026-01-01', '2027-12-31')]) } } };
  await transport()(patch);
  assert.deepEqual(calls.map(call => call.method), ['PUT', 'DELETE', 'POST', 'PATCH']); assert(Buffer.byteLength(calls[3].body) > 32768);
  for (const call of calls) { assert.equal(call.rejectUnauthorized, true); assert.equal(call.port, 443); assert.equal(call.agent, false); }
  for (const change of [{ businessProfileMutation: 'POST' }, { businessProfileMutation: '__proto__' }, { hostname: 'evil.invalid' },
    { path: base.path + '?updateMask=all' }, { path: '/v4/accounts/123/locations/456/admins' }, { json: { comment: 'reply', url: 'https://evil.invalid' } }]) {
    await assert.rejects(transport()({ ...base, ...change }), { code: 'invalid_request' });
  }
  await assert.rejects(transport({ businessProfileWritesEnabled: false })(base), { code: 'invalid_request' });
  await assert.rejects(transport()({ ...patch, path: '/v1/locations/456?updateMask=regularHours' }), { code: 'invalid_request' });
  await assert.rejects(transport()({ ...patch, json: { ...patch.json, name: 'locations/999' } }), { code: 'invalid_request' });
  assert.equal(calls.length, 4);
});
test('actual adapter and HTTPS runtime recover a severed response after restart without secrets or another photo', async t => {
  const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
  const { randomBytes } = require('node:crypto'), { execFileSync } = require('node:child_process');
  const { allowPort, removePort } = require('./offline-guard.cjs');
  const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
  const { createBusinessProfileBroker } = require('../../../src/services/businessProfileBroker.service');
  const { drainAudit } = require('../src/audit');
  const f = setup(t), cert = path.join(f.dir, 'tls.crt'), key = path.join(f.dir, 'tls.key'), cursor = path.join(f.dir, 'cursor');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  [cert, key].forEach(file => fs.chmodSync(file, 0o600)); fs.writeFileSync(cursor, randomBytes(32), { mode: 0o600 });
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const secretArn = 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-gbp-abcdef';
  const appArn = secretArn.replace('fictitious-gbp', 'fictitious-app');
  f.binding.secretArn = secretArn; f.binding.clientSecretArn = appArn;
  const config = { cohort: C.COHORT, enabled: true, policy: f.policy, listenAddress: '127.0.0.1', port,
    stateFile: path.join(f.dir, 'runtime.sqlite'), cursorKeyFile: cursor, tlsKeyFile: key, tlsCertFile: cert };
  const filename = path.join(f.dir, 'config.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  let sdkCalls = 0, credentialsAvailable = true; const events = [];
  const sink = { async write(row) { events.push(JSON.parse(row.event)); return { versionId: 'fictitious-version', digest: row.digest }; } };
  const deps = { http: async request => request.hostname === 'oauth2.googleapis.com'
    ? { access_token: ACCESS, token_type: 'Bearer', expires_in: 3600, scope: C.SCOPES[0] } : f.http(request),
    awsFactory: async () => ({ sink, close() {}, secrets: { async send(command) {
      sdkCalls++; assert(credentialsAvailable, 'STATUS_MUST_NOT_READ_SECRETS'); const arn = command.input.SecretId;
      assert([secretArn, appArn].includes(arn));
      if (command.constructor.name === 'DescribeSecretCommand') return { ARN: arn, KmsKeyId: runtime.SECRET_KEY };
      const value = arn === secretArn ? { version: 2, provider: C.PROVIDER, connectionRef: 'connection:test', refreshToken: 'FICTITIOUS_REFRESH', scopes: C.SCOPES }
        : { version: 1, provider: 'google-oauth-client', clientId: 'fictitious.apps.googleusercontent.com', clientSecret: 'FICTITIOUS_SECRET' };
      return { ARN: arn, VersionId: 'fictitious-current', VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(value) };
    } } }) };
  let app = await runtime.main(filename, deps); allowPort(port);
  t.after(async () => { if (app) await app.close(); removePort(port); });
  const writerClient = createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${port}`, audience: f.policy.audience,
    keyId: 'qa-key', privateKey: f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(cert) });
  const location = { id: 51, clinica_id: 123, google_connection_id: 81, location_id: 'locations/456', is_active: true,
    broker_read_connection_ref: 'connection:test', broker_read_asset_ref: ASSET };
  const consumer = createBusinessProfileBroker({ client: {}, writerClient, enabled: () => true, writesEnabled: () => true,
    loadLocation: async () => location, loadManagedBinding: async () => ({ external_location_id: '456', connection_ref: 'connection:test',
      asset_ref: ASSET, clinica_id: 123, google_connection_id: 81 }) });
  const context = await consumer.prepare(location, () => { throw Error('LEGACY_TOKEN_FORBIDDEN'); }, new Map());
  let response; app.server.prependListener('request', (_req, res) => { response = res; });
  const execute = app.broker.execute.bind(app.broker);
  app.broker.execute = async (...args) => { const value = await execute(...args); response.destroy(); return value; };
  let guards = 0; const options = { beforeExecute: async () => { guards++; } }, input = photo();
  await assert.rejects(consumer.write(location, context, 'photo', input, options), { code: 'broker_unavailable' });
  assert.equal(f.state.writes, 1); assert.equal(guards, 1);
  assert.equal(app.store.db.prepare('SELECT state FROM google_business_profile_mutations WHERE id=?').get(input.operationId).state, 'applied');
  await app.close(); app = null; credentialsAvailable = false;
  app = await runtime.main(filename, deps); const before = sdkCalls;
  const receipt = await consumer.write(location, context, 'status', { operationId: input.operationId }, options);
  assert.equal(receipt.data.state, 'applied'); assert.equal(receipt.data.result.name, PARENT + '/media/one');
  assert.equal(f.state.writes, 1); assert.equal(sdkCalls, before); assert.equal(guards, 3);
  await drainAudit(app.store, sink); assert.equal(app.store.backlog().pending, 0);
  assert(events.some(event => event.operation === C.OPERATIONS.photo && event.result === 'success'));
  assert(events.some(event => event.operation === C.OPERATIONS.status && event.result === 'success'));
  assert(!JSON.stringify(events).includes(PHOTO)); assert(!JSON.stringify(events).includes(ACCESS));
  assert.equal(require.cache[require.resolve('../../../models')], undefined);
});

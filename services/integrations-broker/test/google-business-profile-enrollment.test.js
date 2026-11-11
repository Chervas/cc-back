'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, generateKeyPairSync } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./helpers');
const { Broker } = require('../src/broker');
const { BrokerStore } = require('../src/store');
const { signRequest } = require('../src/auth');
const { cursorCodec } = require('../src/provider-cursor');
const { createGoogleBusinessProfileOperations } = require('../src/google-business-profile');
const { createBusinessProfileEnrollment } = require('../src/google-business-profile-enrollment');
const C = require('../src/google-business-profile-enrollment-contract');
const R = require('../src/google-business-profile-contract');
const W = require('../src/google-business-profile-write-contract');
const O = require('../src/google-oauth-contract');
const { validateConfig } = require('../src/google-main');

const ACCOUNT = '103033606619897470310';
const OLD = '2059408182723799157';
const NEW = '15765789532715328937';
const NEXT = '15765789532715328938';
const THIRD = '15765789532715328939';
const PREVIOUS = `gbp:${ACCOUNT}:${OLD}`;
const SCOPE = 'gbp-enroll:clinic:123';
const SUBJECT = '113861427645841982815';
const ACCESS = 'FICTITIOUS_GBP_ENROLLMENT_ACCESS_SENTINEL';
const location = id => ({ name: 'locations/' + id, title: 'FICTITIOUS_CLINIC_' + id,
  storeCode: '06587484819053063098', storefrontAddress: { addressLines: ['FICTITIOUS_ADDRESS'], locality: 'FICTITIOUS_CITY' },
  metadata: { hasVoiceOfMerchant: true, placeId: 'FICTITIOUS_PLACE_' + id,
    mapsUri: 'https://maps.google.com/maps?cid=' + id,
    newReviewUri: 'https://search.google.com/local/writereview?placeid=FICTITIOUS_PLACE_' + id,
    duplicateLocation: 'OMIT_DUPLICATE', unselectedSecret: ACCESS }, omitted: ACCESS });

function enrollmentFixture(t, options = {}) {
  const f = fixture(t); let at = Date.now();
  const roles = { read: { id: 'api:test', keyId: 'qa-key', keys: f.keys } };
  for (const name of ['control', 'oauth', 'enroll', 'write']) {
    const keys = generateKeyPairSync('ed25519'); roles[name] = { id: name + ':test', keyId: name + '-key', keys };
    f.policy.principals.push({ id: roles[name].id, keyId: roles[name].keyId, enabled: true,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), maxPerMinute: 600 });
  }
  f.policy.maxBacklog = 1000;
  const binding = { connectionRef: 'connection:test', provider: R.PROVIDER, initialState: 'active',
    secretArn: 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-refresh-abcdef',
    clientSecretArn: 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/fictitious-client-abcdef',
    oauth: { subject: SUBJECT, redirectUri: 'https://example.invalid/oauth/google/callback',
      scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/business.manage'] },
    googleBusinessProfileEnrollmentScopes: [{ assetRef: SCOPE, tenantRef: 'clinic:123', accountIds: [ACCOUNT],
      locationIds: [NEW, NEXT, THIRD], bootstrapPreviousAssetRef: PREVIOUS,
      readPrincipalId: roles.read.id, controlPrincipalId: roles.control.id, readOperations: [...R.OPERATIONS], maxAssets: 20 }],
    googleBusinessProfileWrites: { locations: [{ assetRef: PREVIOUS, tenantRef: 'clinic:123',
      allowReviewReplies: false, allowPhotos: false, allowSpecialHours: true }] } };
  f.policy.connections = [binding];
  const grant = (role, assetRef, operations, tenantRef = 'clinic:123') => ({ principalId: roles[role].id,
    tenantRef, connectionRef: binding.connectionRef, assetRef, operations });
  f.policy.grants = [grant('read', PREVIOUS, [...R.OPERATIONS]), grant('write', PREVIOUS, [W.OPERATIONS.hours]),
    grant('control', PREVIOUS, [R.REVOKE_OPERATION]), grant('oauth', PREVIOUS, Object.values(O.OPERATIONS)),
    grant('enroll', SCOPE, [C.OPERATIONS.discover, C.OPERATIONS.prepare, C.OPERATIONS.activate, C.OPERATIONS.status]),
    grant('control', SCOPE, [C.OPERATIONS.retire, C.OPERATIONS.abort])];
  const config = { cohort: W.COHORT, enabled: true, listenAddress: '127.0.0.1', port: 8456,
    policy: f.policy, stateFile: '/tmp/fictitious/state.sqlite', cursorKeyFile: '/tmp/fictitious/cursor',
    tlsCertFile: '/tmp/fictitious/cert', tlsKeyFile: '/tmp/fictitious/key' };
  validateConfig(config);
  const state = { subject: SUBJECT, accountName: `accounts/${ACCOUNT}`, token: ACCESS,
    pages: [{ locations: [location(NEW), location(NEXT), location(THIRD), location(OLD)] }],
    calls: [], secretReads: 0, writes: 0, onPage: null, onResource: null };
  const http = async request => {
    state.calls.push({ hostname: request.hostname, path: request.path });
    assert.equal(request.token.toString(), state.token);
    if (request.hostname === 'www.googleapis.com') return { id: state.subject, email: 'OMIT_EMAIL', access_token: ACCESS };
    if (request.hostname === 'mybusinessaccountmanagement.googleapis.com') return { name: state.accountName,
      accountName: 'FICTITIOUS_ACCOUNT', organizationInfo: { omitted: ACCESS } };
    if (request.path.startsWith(`/v1/accounts/${ACCOUNT}/locations?`)) {
      const query = new URL('https://example.invalid' + request.path).searchParams;
      assert.equal(query.get('readMask'), C.SUMMARY_READ_MASK); assert.equal(query.get('pageSize'), '100');
      const value = state.pages[Number(query.get('pageToken') || 0)];
      await state.onPage?.(request, value);
      return structuredClone(value);
    }
    const match = /^\/v1\/locations\/([1-9]\d*)\?/.exec(request.path);
    if (match) { await state.onResource?.(request); return location(match[1]); }
    assert.fail('Unexpected provider request: ' + request.path);
  };
  const codec = cursorCodec(randomBytes(32), () => at);
  function make(store = f.store, policy = f.policy) {
    const engine = createBusinessProfileEnrollment({ store, http, cursor: codec, now: () => at });
    const reader = createGoogleBusinessProfileOperations({ http, cursor: codec });
    const operations = { ...reader, ...engine.operations,
      [O.OPERATIONS.status]: { provider: R.PROVIDER, control: 'google_oauth', validate: O.validators.status,
        execute: async () => ({ data: { preserved: true } }) },
      [W.OPERATIONS.hours]: { provider: R.PROVIDER, validate: value => W.validate('hours', value),
        execute: async () => { state.writes++; return { untouched: true }; }, project: value => value } };
    const secrets = { invalidate() {}, async withSecret(_binding, work) { state.secretReads++;
      const token = Buffer.from(state.token); try { return await work(token); } finally { token.fill(0); } } };
    const broker = new Broker({ store, policy, secrets, operations, gbpEnrollment: engine, now: () => at, timeoutMs: 2000 });
    return { broker, engine };
  }
  const { broker, engine } = make();
  function execute(name, payload, changes = {}, instance = broker, role = 'enroll') {
    const command = { requestId: randomUUID(), connectionRef: binding.connectionRef, tenantRef: 'clinic:123',
      assetRef: SCOPE, operation: C.OPERATIONS[name] || name, payload, ...changes };
    const signed = signRequest(command, { keyId: roles[role].keyId, privateKey: roles[role].keys.privateKey,
      audience: f.policy.audience, now: at });
    return instance.execute(signed.raw, signed.headers);
  }
  const intent = (id = NEW, previousAssetRef = PREVIOUS) => ({ enrollmentId: randomUUID(), accountId: ACCOUNT, locationId: id,
    previousAssetRef, clinicCount: 1, clinicSetDigest: 'a'.repeat(64) });
  const read = (id = OLD, instance = broker, extra = {}) => execute(R.PREFIX + 'details.read.v1', {},
    { assetRef: `gbp:${ACCOUNT}:${id}`, ...extra }, instance, 'read');
  const control = (name, p, changes = {}, instance = broker) => execute(name, p, changes, instance, 'control');
  return { ...f, state, binding, config, roles, broker, engine, make, execute, control, read, intent, grant,
    advance(ms = 1000) { at += ms; },
    async prepareAndActivate(p = intent()) { await execute('prepare', p); await execute('activate', p); return p; } };
}

test('GBP discovery has an independent account/location allowlist, typed summaries and no stored provider content', async t => {
  const f = enrollmentFixture(t);
  f.state.pages[0].locations.push(location('99999999999999999999'));
  const result = await f.execute('discover', { pageToken: null });
  assert.deepEqual(result.data.locations.map(row => row.locationId), [NEW, NEXT, THIRD]);
  assert.equal(result.data.locations[0].accountId, ACCOUNT); assert.equal(typeof result.data.locations[0].locationId, 'string');
  assert.equal(result.data.locations[0].metadata.hasVoiceOfMerchant, true);
  assert.equal(result.data.locations[0].metadata.placeId, 'FICTITIOUS_PLACE_' + NEW);
  assert.equal(result.data.locations[0].metadata.mapsUri, 'https://maps.google.com/maps?cid=' + NEW);
  assert.equal(result.data.locations[0].metadata.newReviewUri, 'https://search.google.com/local/writereview?placeid=FICTITIOUS_PLACE_' + NEW);
  assert.equal(result.data.nextPageToken, null);
  assert.doesNotMatch(JSON.stringify(result), /SENTINEL|OMIT_|2059408182723799157|99999999999999999999/);
  const stored = JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all()) + JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all());
  assert.doesNotMatch(stored, /FICTITIOUS_ACCOUNT|FICTITIOUS_ADDRESS|SENTINEL/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_enrollments').get().n, 0);
  assert.deepEqual(f.state.calls.map(v => v.hostname), ['www.googleapis.com', 'mybusinessaccountmanagement.googleapis.com', 'mybusinessbusinessinformation.googleapis.com']);
  assert.match(f.state.calls[2].path, new RegExp('^/v1/accounts/' + ACCOUNT + '/locations\\?'));
  assert.doesNotMatch(f.state.calls[2].path, /accounts\/-|filter=|locations\/[0-9]/);
});

test('preparation permits only exact discovery, activation enables READ and retirement blocks old READ/WRITE while OAuth remains valid', async t => {
  const f = enrollmentFixture(t); const p = f.intent();
  await assert.rejects(f.read(NEW), { code: 'scope_denied' });
  const prepared = await f.execute('prepare', p); assert.equal(prepared.data.state, 'prepared');
  assert.equal(prepared.data.accessBlocked, false, 'valid preparation is distinct from revoked authority');
  await assert.rejects(f.read(NEW), { code: 'scope_denied' });
  const discovery = await f.execute(R.PREFIX + 'discovery.read.v1', {}, { assetRef: `gbp:${ACCOUNT}:${NEW}` }, f.broker, 'read');
  assert.equal(discovery.data.location.name, 'locations/' + NEW);
  const active = await f.execute('activate', p); assert.equal(active.data.state, 'active');
  assert.equal(active.data.previousAssetRetired, false); assert.equal(active.data.accessBlocked, false);
  assert.equal((await f.read(NEW)).data.name, 'locations/' + NEW);
  assert.equal((await f.read()).data.name, 'locations/' + OLD);
  const calls = f.state.calls.length; const secretReads = f.state.secretReads;
  const retired = await f.control('retire', p); assert.equal(retired.data.previousAssetRetired, true);
  assert.equal(f.state.calls.length, calls); assert.equal(f.state.secretReads, secretReads);
  await assert.rejects(f.read(), { code: 'asset_revoked' });
  await assert.rejects(f.execute(W.OPERATIONS.hours, { operationId: randomUUID(), periods: [] }, { assetRef: PREVIOUS }, f.broker, 'write'), { code: 'asset_revoked' });
  assert.equal(f.state.writes, 0);
  const oauth = await f.execute(O.OPERATIONS.status, { flowId: randomUUID() }, { assetRef: PREVIOUS }, f.broker, 'oauth');
  assert.equal(oauth.data.preserved, true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT asset FROM google_business_profile_scope_heads').get().asset, `gbp:${ACCOUNT}:${NEW}`);
  const secondStore = new BrokerStore(f.filename); t.after(() => secondStore.close()); const second = f.make(secondStore);
  assert.equal((await f.read(NEW, second.broker)).data.name, 'locations/' + NEW);
  await assert.rejects(f.read(OLD, second.broker), { code: 'asset_revoked' });
  assert.equal((await f.execute('status', { enrollmentId: p.enrollmentId }, {}, second.broker)).data.previousAssetRetired, true);
});

test('second replacement uses the durable head rather than the bootstrap source and cannot reactivate retired resources', async t => {
  const f = enrollmentFixture(t); const first = await f.prepareAndActivate(); await f.control('retire', first); f.advance();
  const second = f.intent(NEXT, `gbp:${ACCOUNT}:${NEW}`);
  await f.prepareAndActivate(second); await f.control('retire', second);
  assert.equal((await f.read(NEXT)).data.name, 'locations/' + NEXT);
  await assert.rejects(f.read(NEW), { code: 'asset_revoked' });
  const third = f.intent(THIRD, PREVIOUS);
  await assert.rejects(f.execute('prepare', third), { code: 'idempotency_conflict' });
  await assert.rejects(f.execute('prepare', f.intent(NEW, `gbp:${ACCOUNT}:${NEXT}`)), { code: 'asset_revoked' });
  assert.equal((await f.execute('status', { enrollmentId: first.enrollmentId })).data.state, 'retired');
  await assert.rejects(f.control('abort', second), { code: 'scope_denied' });
});

test('cancelled candidates retain history, preserve the old association and support an explicit new UUID for the same owner', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); await f.execute('prepare', p);
  assert.equal((await f.control('abort', p)).data.state, 'cancelled');
  await assert.rejects(f.execute('activate', p), { code: 'asset_revoked' });
  assert.equal((await f.read()).data.name, 'locations/' + OLD);
  f.advance(); const next = f.intent(); await f.prepareAndActivate(next);
  assert.equal((await f.read(NEW)).data.name, 'locations/' + NEW);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_enrollments').get().n, 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_retirements').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations').get().n, 0);
});

test('abort before a delayed prepare tombstones only that attempt without reserving an unverified provider resource', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); const before = f.state.secretReads;
  await f.control('abort', p); assert.equal(f.state.secretReads, before);
  await assert.rejects(f.execute('prepare', p), { code: 'asset_revoked' });
  assert.equal(f.store.db.prepare('SELECT verified FROM google_business_profile_enrollments').get().verified, 0);
  f.advance(); await f.prepareAndActivate(f.intent());
  assert.equal((await f.read(NEW)).data.name, 'locations/' + NEW);
});

test('identity, account membership and long string identifiers are verified through provider-bound reads', async t => {
  const f = enrollmentFixture(t);
  const invalids = [f.intent('999'), { ...f.intent(), accountId: '999' }, { ...f.intent(), locationId: Number(NEW) },
    { ...f.intent(), previousAssetRef: 'gbp:999:123' }, { ...f.intent(), clinicCount: 2 }];
  for (const p of invalids) await assert.rejects(f.execute('prepare', p));
  assert.equal(f.state.secretReads, 0);
  f.state.subject = 'WRONG_IDENTITY'; await assert.rejects(f.execute('prepare', f.intent()), { code: 'oauth_identity_mismatch' });
  f.state.subject = SUBJECT; f.state.accountName = 'accounts/999';
  await assert.rejects(f.execute('prepare', f.intent()), { code: 'scope_denied' });
  f.state.accountName = 'accounts/' + ACCOUNT; f.state.pages = [{ locations: [location(NEXT)] }];
  // locations.get(NEW) would succeed in this fixture. Separate access does not
  // prove membership under ACCOUNT, so preparation must still reject it.
  await assert.rejects(f.execute('prepare', f.intent()), { code: 'scope_denied' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_enrollments').get().n, 0);
});

test('unrelated tenants, principals, resources and broadened payloads reject before accessing secrets', async t => {
  const f = enrollmentFixture(t); const p = f.intent();
  for (const [patch, role] of [[{ tenantRef: 'clinic:999' }, 'enroll'], [{ assetRef: 'gbp-enroll:clinic:999' }, 'enroll'], [{}, 'read'], [{}, 'oauth'], [{}, 'write']]) {
    await assert.rejects(f.execute('prepare', p, patch, f.broker, role), { code: 'scope_denied' });
  }
  await assert.rejects(f.execute('prepare', { ...p, token: ACCESS }), { code: 'invalid_request' });
  await assert.rejects(f.execute('retire', p), { code: 'scope_denied' });
  await assert.rejects(f.execute('abort', p), { code: 'scope_denied' });
  assert.equal(f.state.secretReads, 0);
});

test('provider membership traversal is complete, bounded and rejects duplicate or cyclic pages', async t => {
  const f = enrollmentFixture(t); const p = f.intent();
  f.state.pages = [{ locations: [location(NEXT)], nextPageToken: '1' }, { locations: [location(NEW)] }];
  assert.equal((await f.execute('prepare', p)).data.state, 'prepared');
  await f.control('abort', p); f.advance();
  f.state.pages = [{ locations: [location(NEW)], nextPageToken: '1' }, { locations: [location(NEW)] }];
  await assert.rejects(f.execute('prepare', f.intent()), { code: 'provider_failed' });
  f.state.pages = [{ locations: [location(NEW)], nextPageToken: '0' }];
  await assert.rejects(f.execute('prepare', f.intent()), { code: 'provider_failed' });
  f.state.pages = Array.from({ length: 10 }, (_, index) => ({ locations: [], nextPageToken: String(index + 1) }));
  await assert.rejects(f.execute('prepare', f.intent()), { code: 'provider_failed' });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM google_business_profile_enrollments WHERE state='prepared'").get().n, 0);
});

test('opaque discovery cursors stay bound to identity, scope, policy, credential epoch and expiry', async t => {
  const f = enrollmentFixture(t); f.state.pages = [{ locations: [location(NEW)], nextPageToken: '1' }, { locations: [location(NEXT)] }];
  const first = await f.execute('discover', { pageToken: null }); const token = first.data.nextPageToken;
  assert.equal(typeof token, 'string'); assert.equal((await f.execute('discover', { pageToken: token })).data.locations[0].locationId, NEXT);
  const next = await f.execute('discover', { pageToken: null });
  f.state.token = 'FICTITIOUS_NEW_ACCESS_EPOCH';
  await assert.rejects(f.execute('discover', { pageToken: next.data.nextPageToken }), { code: 'invalid_request' });
  f.state.token = ACCESS; f.advance(600001);
  await assert.rejects(f.execute('discover', { pageToken: token }), { code: 'invalid_request' });
});

test('durable request identity, scope ownership and revocations win over acknowledgements and UUID retries', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); const requestId = randomUUID();
  await f.execute('prepare', p, { requestId }); const calls = f.state.calls.length;
  assert.equal((await f.execute('prepare', p, { requestId })).replayed, true); assert.equal(f.state.calls.length, calls);
  await assert.rejects(f.execute('prepare', { ...p, clinicSetDigest: 'b'.repeat(64) }), { code: 'idempotency_conflict' });
  await assert.rejects(f.execute('prepare', f.intent(NEXT)), { code: 'idempotency_conflict' });
  f.store.db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:123', f.binding.connectionRef, SCOPE, randomUUID(), Date.now());
  await assert.rejects(f.execute('prepare', p, { requestId }), { code: 'asset_revoked' });
  const before = f.state.secretReads;
  const status = await f.execute('status', { enrollmentId: p.enrollmentId }); assert.equal(status.data.accessBlocked, true);
  assert.equal(f.state.secretReads, before); await f.control('abort', p);
});

test('revocation during provider I/O prevents preparation and stores no usable registration', async t => {
  const f = enrollmentFixture(t);
  f.state.onPage = () => f.store.db.prepare('INSERT OR IGNORE INTO asset_revocations VALUES (?,?,?,?,?)')
    .run('clinic:123', f.binding.connectionRef, SCOPE, randomUUID(), Date.now());
  await assert.rejects(f.execute('prepare', f.intent()), { code: 'asset_revoked' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_enrollments').get().n, 0);
});

test('retiring an old resource while its read is in flight rejects the old response without affecting OAuth', async t => {
  const f = enrollmentFixture(t); const p = await f.prepareAndActivate();
  let release; let entered; const reached = new Promise(resolve => { entered = resolve; });
  f.state.onResource = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const pending = f.read(); await reached; await f.control('retire', p); release();
  await assert.rejects(pending, { code: 'asset_revoked' });
  assert.equal((await f.execute(O.OPERATIONS.status, { flowId: randomUUID() }, { assetRef: PREVIOUS }, f.broker, 'oauth')).data.preserved, true);
});

test('connection outage permits receipt/cancellation inspection but grants no new read or activation', async t => {
  const f = enrollmentFixture(t); const p = await f.prepareAndActivate();
  f.store.db.prepare("UPDATE connections SET state='blocked',revision=revision+1 WHERE ref=?").run(f.binding.connectionRef);
  const before = f.state.secretReads;
  assert.equal((await f.execute('status', { enrollmentId: p.enrollmentId })).data.accessBlocked, true);
  await assert.rejects(f.read(NEW), { code: 'connection_blocked' });
  await assert.rejects(f.execute('activate', p), { code: 'connection_blocked' });
  assert.equal((await f.control('abort', p)).data.state, 'cancelled');
  assert.equal(f.state.secretReads, before);
});

test('audit failure rolls back a registration and an unknown command is reconciled instead of re-dispatched', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); const requestId = randomUUID();
  const append = f.store.appendAudit.bind(f.store); let failed = false;
  f.store.appendAudit = event => { if (!failed && event.action === 'integration.completed') { failed = true; throw Error('FICTITIOUS_AUDIT_DOWN'); } return append(event); };
  await assert.rejects(f.execute('prepare', p, { requestId }));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_enrollments').get().n, 0);
  const calls = f.state.calls.length;
  await assert.rejects(f.execute('prepare', p, { requestId }), { code: 'outcome_unknown' });
  assert.equal(f.state.calls.length, calls);
  assert.deepEqual((await f.execute('status', { enrollmentId: p.enrollmentId })).data,
    { enrollmentId: p.enrollmentId, state: 'not_found', accessBlocked: true });
  // Only a deliberate new transport command after that receipt may re-verify
  // the same durable enrollment. The original unknown command is retained.
  await f.execute('prepare', p); await f.execute('activate', p);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_enrollments').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM commands WHERE principal=? AND id=?').get('enroll:test', requestId).state, 'unknown');
});

test('an acknowledged registration survives a lost response and is reconciled after broker restart without repeating provider reads', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); const prepareId = randomUUID();
  await f.execute('prepare', p, { requestId: prepareId });
  const secondStore = new BrokerStore(f.filename); t.after(() => secondStore.close()); const second = f.make(secondStore);
  const calls = f.state.calls.length; const status = await f.execute('status', { enrollmentId: p.enrollmentId }, {}, second.broker);
  assert.equal(status.data.state, 'prepared'); assert.equal(f.state.calls.length, calls);
  assert.equal((await f.execute('prepare', p, { requestId: prepareId }, second.broker)).replayed, true);
  assert.equal(f.state.calls.length, calls);
  const activationId = randomUUID(); await f.execute('activate', p, { requestId: activationId }, second.broker);
  const activatedCalls = f.state.calls.length;
  assert.equal((await f.execute('status', { enrollmentId: p.enrollmentId })).data.state, 'active');
  assert.equal((await f.execute('activate', p, { requestId: activationId })).replayed, true);
  assert.equal(f.state.calls.length, activatedCalls);
  const retireId = randomUUID(); await f.control('retire', p, { requestId: retireId }, second.broker);
  const finalCalls = f.state.calls.length;
  assert.equal((await f.execute('status', { enrollmentId: p.enrollmentId })).data.previousAssetRetired, true);
  assert.equal((await f.control('retire', p, { requestId: retireId })).replayed, true);
  assert.equal(f.state.calls.length, finalCalls);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_retirements').get().n, 1);
});

test('a real process exit after reservation retains the started command and resumes the same enrollment only after not_found', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); const requestId = randomUUID();
  const signed = signRequest({ requestId, connectionRef: f.binding.connectionRef, tenantRef: 'clinic:123', assetRef: SCOPE,
    operation: C.OPERATIONS.prepare, payload: p }, { keyId: f.roles.enroll.keyId, privateKey: f.roles.enroll.keys.privateKey,
    audience: f.policy.audience });
  const child = spawnSync(process.execPath, ['--require', './test/offline-guard.cjs', '-e', `
    const x=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
    const {BrokerStore}=require('./src/store'); const {Broker}=require('./src/broker');
    const {createBusinessProfileEnrollment}=require('./src/google-business-profile-enrollment');
    const {cursorCodec}=require('./src/provider-cursor');
    const store=new BrokerStore(x.filename);
    const engine=createBusinessProfileEnrollment({store,http:async()=>{throw Error('UNEXPECTED_PROVIDER');},cursor:cursorCodec(Buffer.alloc(32,1))});
    const broker=new Broker({store,policy:x.policy,operations:engine.operations,gbpEnrollment:engine,
      secrets:{withSecret(){process.exit(17);},invalidate(){}}});
    broker.execute(Buffer.from(x.raw,'base64'),x.headers).then(()=>process.exit(2),()=>process.exit(3));
  `], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000,
    input: JSON.stringify({ filename: f.filename, policy: f.policy, raw: signed.raw.toString('base64'), headers: signed.headers }) });
  assert.equal(child.status, 17, child.stderr);
  assert.equal(f.store.db.prepare('SELECT state FROM commands WHERE principal=? AND id=?').get('enroll:test', requestId).state, 'started');
  await assert.rejects(f.execute('prepare', p, { requestId }), { code: 'outcome_unknown' });
  assert.equal(f.state.calls.length, 0);
  assert.equal((await f.execute('status', { enrollmentId: p.enrollmentId })).data.state, 'not_found');
  await f.execute('prepare', p); await f.execute('activate', p);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_enrollments').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM commands WHERE principal=? AND id=?').get('enroll:test', requestId).state, 'started');
});

test('a cancellation racing provider preparation wins durably and no late prepare can activate the candidate', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); let release; let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  f.state.onPage = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const pending = f.execute('prepare', p); await reached; await f.control('abort', p); release();
  await assert.rejects(pending, { code: 'asset_revoked' });
  assert.equal((await f.execute('status', { enrollmentId: p.enrollmentId })).data.state, 'cancelled');
  assert.equal((await f.read()).data.name, 'locations/' + OLD);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_retirements').get().n, 0);
});

test('two concurrent intentions cannot reserve different locations for the same scope', async t => {
  const f = enrollmentFixture(t); const first = f.intent(); const second = f.intent(NEXT); const releases = [];
  let entered; const reached = new Promise(resolve => { entered = resolve; });
  f.state.onPage = () => new Promise(resolve => { releases.push(resolve); if (releases.length === 2) entered(); });
  const one = f.execute('prepare', first); const two = f.execute('prepare', second); await reached;
  releases.forEach(resolve => resolve()); const results = await Promise.allSettled([one, two]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected' && row.reason.code === 'idempotency_conflict').length, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM google_business_profile_enrollments WHERE state='prepared'").get().n, 1);
});

test('a static location in another tenant or an alternate account prefix cannot be adopted', async t => {
  const f = enrollmentFixture(t); const policy = structuredClone(f.policy);
  policy.grants.push({ ...f.grant('read', `gbp:999:${NEW}`, [...R.OPERATIONS]), tenantRef: 'clinic:999' });
  const second = f.make(f.store, policy); const before = f.state.secretReads;
  await assert.rejects(f.execute('prepare', f.intent(), {}, second.broker), { code: 'scope_denied' });
  assert.equal(f.state.secretReads, before);
  await f.execute('prepare', f.intent());
  const foreign = structuredClone(f.policy); const s = foreign.connections[0].googleBusinessProfileEnrollmentScopes[0];
  s.assetRef = 'gbp-enroll:clinic:999'; s.tenantRef = 'clinic:999'; s.bootstrapPreviousAssetRef = null;
  foreign.grants.push(...foreign.grants.filter(g => g.assetRef === SCOPE).map(g => ({ ...g, tenantRef: s.tenantRef, assetRef: s.assetRef })));
  const outsider = f.make(f.store, foreign);
  await assert.rejects(f.execute('prepare', { ...f.intent(), previousAssetRef: null }, { tenantRef: s.tenantRef, assetRef: s.assetRef }, outsider.broker), { code: 'scope_denied' });
});

test('an inherited group scope binds the clinic set without granting the candidate to a neighbouring tenant', async t => {
  const f = enrollmentFixture(t); const policy = structuredClone(f.policy); const group = 'gbp-enroll:group:5';
  policy.connections[0].googleBusinessProfileEnrollmentScopes[0].assetRef = group;
  policy.grants = policy.grants.map(g => g.assetRef === SCOPE ? { ...g, assetRef: group } : g);
  validateConfig({ ...f.config, policy }); const second = f.make(f.store, policy);
  const p = { ...f.intent(), clinicCount: 2 };
  await f.execute('prepare', p, { assetRef: group }, second.broker);
  await f.execute('activate', p, { assetRef: group }, second.broker);
  assert.equal((await f.read(NEW, second.broker)).data.name, 'locations/' + NEW);
  await assert.rejects(f.read(NEW, second.broker, { tenantRef: 'clinic:124' }), { code: 'scope_denied' });
  await assert.rejects(f.execute('activate', { ...p, clinicCount: 1 }, { assetRef: group }, second.broker), { code: 'idempotency_conflict' });
});

test('revoking the previous association during preparation invalidates the new candidate too', async t => {
  const f = enrollmentFixture(t);
  f.state.onPage = () => f.store.db.prepare('INSERT OR IGNORE INTO asset_revocations VALUES (?,?,?,?,?)')
    .run('clinic:123', f.binding.connectionRef, PREVIOUS, randomUUID(), Date.now());
  await assert.rejects(f.execute('prepare', f.intent()), { code: 'asset_revoked' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_enrollments').get().n, 0);
});

test('GBP enrollment configuration enforces exact explicit authorities and disjoint cryptographic roles', t => {
  const f = enrollmentFixture(t);
  for (const mutate of [c => { c.policy.connections[0].googleBusinessProfileEnrollmentScopes[0].readPrincipalId = 'enroll:test'; },
    c => { c.policy.principals.find(p => p.id === 'enroll:test').publicKey = c.policy.principals[0].publicKey; },
    c => { delete c.policy.connections[0].oauth; },
    c => { c.policy.connections[0].googleBusinessProfileEnrollmentScopes[0].accountIds = ['-']; },
    c => { c.policy.connections[0].googleBusinessProfileEnrollmentScopes[0].bootstrapPreviousAssetRef = 'gbp:123:999'; },
    c => { c.policy.grants.find(g => g.assetRef === SCOPE).operations.push(W.OPERATIONS.hours); },
    c => { c.cohort = 'google-analytics-read-v1'; }]) {
    const next = structuredClone(f.config); mutate(next); assert.throws(() => validateConfig(next));
  }
});

test('the real application client consumes the signed broker discovery and preparation/activation/retirement contracts', async t => {
  const f = enrollmentFixture(t);
  const longPlaceId = 'FICTITIOUS_NATIVE_' + 'A'.repeat(300);
  const expectedMetadata = { hasVoiceOfMerchant: true, placeId: longPlaceId,
    mapsUri: 'https://maps.google.com/maps?cid=' + NEW,
    newReviewUri: 'https://search.google.com/local/writereview?placeid=' + longPlaceId };
  f.state.pages[0].locations[0].metadata = { ...expectedMetadata, unknownSecret: ACCESS };
  const { createClient } = require('../../../src/services/businessProfileAssociationClient.service');
  const application = require('../../../src/services/businessProfileAssociation.contract');
  const transport = role => ({ async execute(command) {
    const signed = signRequest(command, { keyId: f.roles[role].keyId, privateKey: f.roles[role].keys.privateKey,
      audience: f.policy.audience });
    return f.broker.execute(signed.raw, signed.headers);
  } });
  const client = createClient({ client: transport('enroll'), controlClient: transport('control') });
  const row = { attempt_id: randomUUID(), clinica_id: 123, connection_ref: f.binding.connectionRef, scope_ref: SCOPE,
    account_id: ACCOUNT, location_id: NEW, previous_asset_ref: PREVIOUS,
    prepare_request_id: randomUUID(), activate_request_id: randomUUID(), retire_request_id: randomUUID(), abort_request_id: randomUUID() };
  const before = async () => {};
  const locations = await client.discover({ clinica_id: 123, connection_ref: f.binding.connectionRef, scope_ref: SCOPE,
    account_ids: [ACCOUNT], location_ids: [NEW, NEXT, THIRD] }, before);
  assert.equal(locations[0].locationName, 'locations/' + NEW);
  assert.equal(locations[0].accountName, 'accounts/' + ACCOUNT);
  assert.deepEqual(locations[0].rawLocation.metadata, expectedMetadata);
  assert.equal((await client.command(row, 'status', before)).state, 'not_found');
  const prepared = await client.command(row, 'prepare', before);
  assert.equal(prepared.state, 'prepared'); assert.equal(prepared.accessBlocked, false);
  assert.equal(prepared.clinicSetDigest, application.hash([123]));
  await assert.rejects(f.read(NEW), { code: 'scope_denied' });
  assert.equal((await client.command(row, 'activate', before)).state, 'active');
  assert.equal((await client.command(row, 'retire', before)).previousAssetRetired, true);
  assert.equal((await client.command(row, 'status', before)).previousAssetRetired, true);
  assert.equal((await f.read(NEW)).data.name, 'locations/' + NEW);
});

test('ordinary disconnect uses the existing control key for the exact enrolled resource and preserves the OAuth anchor', async t => {
  const f = enrollmentFixture(t); const p = await f.prepareAndActivate(); await f.control('retire', p);
  const asset = `gbp:${ACCOUNT}:${NEW}`; const before = f.state.secretReads;
  for (const role of ['read', 'enroll', 'oauth', 'write']) {
    await assert.rejects(f.execute(R.REVOKE_OPERATION, {}, { assetRef: asset }, f.broker, role), { code: 'scope_denied' });
  }
  await assert.rejects(f.execute(R.REVOKE_OPERATION, {}, { assetRef: asset, tenantRef: 'clinic:999' }, f.broker, 'control'), { code: 'scope_denied' });
  const requestId = randomUUID();
  assert.equal((await f.control(R.REVOKE_OPERATION, {}, { assetRef: asset, requestId })).data.revoked, true);
  assert.equal((await f.control(R.REVOKE_OPERATION, {}, { assetRef: asset, requestId })).replayed, true);
  assert.equal(f.state.secretReads, before);
  await assert.rejects(f.read(NEW), { code: 'asset_revoked' });
  const rows = f.store.db.prepare('SELECT tenant,connection,asset FROM asset_revocations').all();
  assert.deepEqual(rows.map(row => ({ ...row })), [{ tenant: 'clinic:123', connection: f.binding.connectionRef, asset }]);
  assert.equal((await f.execute('status', { enrollmentId: p.enrollmentId })).data.accessBlocked, true);
  assert.equal((await f.execute(O.OPERATIONS.status, { flowId: randomUUID() }, { assetRef: PREVIOUS }, f.broker, 'oauth')).data.preserved, true);
});

test('ordinary disconnect remains possible for a proved resource after connection blocking and candidate allowlist removal', async t => {
  const f = enrollmentFixture(t); const p = await f.prepareAndActivate(); await f.control('retire', p);
  const policy = structuredClone(f.policy); policy.connections[0].googleBusinessProfileEnrollmentScopes[0].locationIds = [NEXT, THIRD];
  validateConfig({ ...f.config, policy }); const second = f.make(f.store, policy);
  f.store.db.prepare("UPDATE connections SET state='blocked',revision=revision+1 WHERE ref=?").run(f.binding.connectionRef);
  const before = f.state.secretReads; const asset = `gbp:${ACCOUNT}:${NEW}`;
  assert.equal((await f.control(R.REVOKE_OPERATION, {}, { assetRef: asset }, second.broker)).data.revoked, true);
  assert.equal(f.state.secretReads, before);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations WHERE asset=?').get(asset).n, 1);
});

test('knowing an allowlisted location or cancelling an unverified attempt does not grant ordinary resource revocation', async t => {
  const f = enrollmentFixture(t); const p = f.intent(); const asset = `gbp:${ACCOUNT}:${NEW}`;
  await assert.rejects(f.control(R.REVOKE_OPERATION, {}, { assetRef: asset }), { code: 'scope_denied' });
  await f.control('abort', p);
  await assert.rejects(f.control(R.REVOKE_OPERATION, {}, { assetRef: asset }), { code: 'scope_denied' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM asset_revocations').get().n, 0);
  assert.equal(f.state.secretReads, 0);
});

test('public GBP metadata preserves complete Place IDs and Google links while rejecting unsafe or untyped values', () => {
  const longPlaceId = 'FICTITIOUS_' + 'A'.repeat(300);
  const raw = { ...location(NEW), metadata: { hasVoiceOfMerchant: false, placeId: longPlaceId,
    mapsUri: 'https://www.google.com/maps/search/?api=1&query_place_id=' + longPlaceId,
    newReviewUri: 'https://search.google.com/local/writereview?placeid=' + longPlaceId,
    secret: ACCESS, hasPendingEdits: true } };
  const value = C.projectLocation(raw);
  assert.equal(value.metadata.placeId, longPlaceId);
  assert.equal(value.metadata.mapsUri, raw.metadata.mapsUri);
  assert.equal(value.metadata.newReviewUri, raw.metadata.newReviewUri);
  assert.deepEqual(Object.keys(value.metadata).sort(), ['hasVoiceOfMerchant', 'mapsUri', 'newReviewUri', 'placeId']);
  for (const field of ['mapsUri', 'newReviewUri']) for (const bad of ['http://maps.google.com/maps',
    'javascript:alert(1)', 'https://example.invalid/maps', 'https://maps.google.com.evil.invalid/maps',
    'https://user@maps.google.com/maps', 'https://maps.google.com:444/maps', 'https://maps.google.com/maps#secret',
    'https://www.google.com/url?q=https://example.invalid', ' https://maps.google.com/maps', 123]) {
    assert.throws(() => C.projectLocation({ ...raw, metadata: { ...raw.metadata, [field]: bad } }), { code: 'provider_failed' });
  }
  for (const bad of ['', 'places/ChIJ_fixture', 'A B', 123, 'A'.repeat(8193)]) {
    assert.throws(() => C.projectLocation({ ...raw, metadata: { placeId: bad } }), { code: 'provider_failed' });
  }
  assert.equal(C.projectLocation({ name: 'locations/' + NEW, title: 'FICTITIOUS_WITHOUT_METADATA' }).metadata, undefined);
});

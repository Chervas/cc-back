'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
require('./fixtures/campaign_offline_runtime.cjs');
const L = require('../../../services/integrations-broker/src/meta-marketing-leads-contract');
const W = require('../../services/metaMarketingLeadWebhookReader.service');
const { createMetaLeadWebhookHandlers } = require('../../services/metaLeadWebhook.service');
const token = 'FICTITIOUS_WEBHOOK_VERIFY_TOKEN_123456789';
const event = { lead_id: '100', page_id: '200', form_id: '300', ad_id: '400' };
const receiptRef = '11111111-1111-4111-8111-111111111111';
function environment(extra = {}) {
  return { RUNTIME_ROLE: 'gateway', JOB_RUNTIME_NAMESPACE: 'gateway', AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE: 'staging',
    META_APP_ID: '900', META_MARKETING_BROKER_ENABLED: 'false', META_MARKETING_LEADGEN_ENABLED: 'false',
    META_MARKETING_LEADGEN_RECEIVER_ENABLED: 'true', META_MARKETING_LEADS_BROKER_ORIGIN: 'https://broker.example.invalid',
    META_MARKETING_LEADS_BROKER_AUDIENCE: 'fixture-broker', META_MARKETING_LEADS_BROKER_KEY_ID: L.ingressPrincipal('staging'),
    META_MARKETING_LEADS_BROKER_KEY_FILE: '/tmp/fictitious-receiver-key.pem', META_MARKETING_LEADS_BROKER_CA_FILE: '/tmp/fictitious-receiver-ca.pem',
    META_MARKETING_LEADGEN_VERIFY_PAGE_ASSET_ID: '802', META_MARKETING_LEADGEN_VERIFY_AD_ACCOUNT_ASSET_ID: '391', ...extra };
}
function fixture(env = environment()) {
  const state = { calls: [], prepared: [], checks: 0, blocked: false };
  const contexts = new WeakMap();
  const value = id => ({ mappingId: id, kind: id === 802 ? 'facebook_page' : 'ad_account', id: id === 802 ? '200' : '500',
    assetRef: id === 802 ? 'meta-facebook_page:200' : 'meta-ad_account:500', connectionId: 159, connectionRef: 'meta:fixture',
    appId: '900', subjectId: '800', enrollmentHash: 'immutable', scopeKey: 'group:29', tenantRef: 'clinic:66', clinicIds: [66, 72] });
  const scope = { prepare: async id => { state.prepared.push(id); const context = {}; contexts.set(context, id); return context; },
    assertContext: async context => {
      state.checks++; if (state.blocked) throw Object.assign(Error('asset_revoked'), { code: 'asset_revoked' });
      const result = value(contexts.get(context));
      return { ...result, ...(state.changed || {}) };
    } };
  const client = { execute: async command => {
    state.calls.push(command); await state.onCommand?.();
    if (state.error) throw state.error;
    return { requestId: command.requestId, data: state.response || (command.operation === L.OPERATIONS.challenge
      ? { challenge: command.payload.challenge } : { persisted: true, receipts: [{ receiptRef, event }] }) };
  } };
  return { env, state, scope, client, reader: W.createMetaLeadWebhookReader({ scope, client, env }) };
}
function response() {
  const value = { statusCode: 0, headers: {} };
  value.status = code => { value.statusCode = code; return value; };
  value.set = (name, content) => { value.headers[name] = content; return value; };
  value.type = () => value;
  value.send = body => { value.body = body; return value; };
  value.json = body => { value.body = body; return value; };
  return value;
}
test('dedicated receiver requires gate, Gateway role, exact principal, app identity and standard business namespace', () => {
  assert.equal(W.receiverConfiguration(environment()).keyId, 'gateway:staging:meta-marketing-leads');
  for (const patch of [{ META_MARKETING_LEADGEN_RECEIVER_ENABLED: undefined }, { META_MARKETING_LEADGEN_RECEIVER_ENABLED: 'false' },
    { RUNTIME_ROLE: 'api' }, { RUNTIME_ROLE: undefined }, { META_APP_ID: undefined },
    { META_MARKETING_LEADS_BROKER_KEY_ID: 'api:staging:meta-marketing-read' },
    { META_MARKETING_LEADS_BROKER_KEY_ID: 'gateway:staging:meta-marketing-oauth' },
    { AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE: undefined }, { AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE: 'dev' },
    { AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE: 'gateway' }, { META_LEAD_JOB_RUNTIME_NAMESPACE: 'dev' },
    { META_LEAD_JOB_RUNTIME_NAMESPACE: 'foreign' }, { META_MARKETING_LEADS_BROKER_ORIGIN: 'http://broker.invalid' },
    { META_MARKETING_LEADS_BROKER_KEY_FILE: undefined }, { META_MARKETING_LEADS_BROKER_CA_FILE: 'relative.pem' }]) {
    assert.throws(() => W.receiverConfiguration(environment(patch)), error => ['meta_leads_disabled', 'broker_configuration_invalid'].includes(error.code));
  }
});
test('separate key prefix is the only signing configuration; direct Ads/contact/subscription/control calls are denied', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-meta-ingress-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'key.pem'), caFile = path.join(dir, 'ca.pem');
  fs.writeFileSync(keyFile, 'FICTITIOUS_INGRESS_PRIVATE_KEY', { mode: 0o600 }); fs.writeFileSync(caFile, 'FICTITIOUS_INGRESS_CA', { mode: 0o600 });
  const env = environment({ META_MARKETING_LEADS_BROKER_KEY_FILE: keyFile, META_MARKETING_LEADS_BROKER_CA_FILE: caFile,
    META_MARKETING_BROKER_KEY_FILE: '/must-not-read-api-key.pem', META_MARKETING_BROKER_CA_FILE: '/must-not-read-api-ca.pem' });
  const state = { created: 0, calls: [] };
  const client = W.createConfiguredMetaLeadWebhookClient({ env, createClient: options => {
    state.created++; assert.equal(options.keyId, L.ingressPrincipal('staging')); assert.equal(options.transportProfile, 'meta-marketing');
    assert.equal(options.privateKey.toString(), 'FICTITIOUS_INGRESS_PRIVATE_KEY'); assert.equal(options.ca.toString(), 'FICTITIOUS_INGRESS_CA');
    return { execute: async command => { state.calls.push(command); return { ok: true }; } };
  } });
  for (const operation of [...Object.values(L.OPERATIONS).filter(operation => !L.RECEPTION_OPERATIONS.includes(operation)),
    'meta.marketing.ads.insights.read.v1', 'meta.marketing.oauth.begin.v1', 'meta.marketing.enrollment.activate.v1', 'meta.marketing.asset.revoke.v1']) {
    assert.throws(() => client.execute({ operation }), { code: 'operation_denied' });
  }
  assert.equal(state.created, 0);
  for (const operation of L.RECEPTION_OPERATIONS) await client.execute({ operation });
  assert.equal(state.created, 1); assert.equal(state.calls.length, 2);
  env.META_MARKETING_LEADS_BROKER_KEY_FILE = '/changed-key.pem';
  assert.throws(() => client.execute({ operation: L.OPERATIONS.challenge }), { code: 'broker_configuration_invalid' });
  assert.equal(state.calls.length, 2);
});
test('webhook reader works while both API flags remain false, and exposes only paired receipt/challenge methods', async () => {
  const f = fixture(), pair = await f.reader.preparePair(802, 391);
  assert.deepEqual(Object.keys(f.reader).sort(), ['assertPair', 'preparePair', 'read', 'verificationPair']);
  assert.deepEqual(await f.reader.read(pair, 'challenge', { mode: 'subscribe', token, challenge: 'qa-challenge' }), { challenge: 'qa-challenge' });
  assert.deepEqual(await f.reader.read(pair, 'receiptAccept', { rawBase64: Buffer.from('{}').toString('base64'), signature: 'sha256=' + 'a'.repeat(64) }),
    { persisted: true, receipts: [{ receiptRef, event }] });
  assert.equal(f.env.META_MARKETING_BROKER_ENABLED, 'false'); assert.equal(f.env.META_MARKETING_LEADGEN_ENABLED, 'false');
  assert.equal(f.state.calls.length, 2);
  for (const family of ['receiptRead', 'destinations', 'form', 'pageStatus', 'pageEnable', 'ads', 'challenge.v2']) {
    await assert.rejects(f.reader.read(pair, family, {}), { code: 'operation_denied' });
  }
  assert.equal(f.state.calls.length, 2);
});
test('explicit verification pair ignores an earlier Arriaga page and never scans or guesses active bindings', async () => {
  const f = fixture(); let listQueries = 0;
  const handlers = createMetaLeadWebhookHandlers({ reader: f.reader, env: f.env,
    models: { MetaMarketingBrokerBinding: { findAll: async () => { listQueries++; return [{ mapping_id: 361, asset_ref: 'meta-facebook_page:111' }]; } } } });
  const res = response();
  await handlers.verify({ query: { 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': 'qa-challenge' } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body, 'qa-challenge'); assert.equal(listQueries, 0);
  assert.deepEqual(f.state.prepared, [802, 391]);
  assert.equal(f.state.calls[0].assetRef, 'meta-facebook_page:200'); assert.equal(f.state.calls[0].payload.adAccountAssetRef, 'meta-ad_account:500');
});
test('absent or malformed explicit verification mappings fail closed before metadata lookup or owner call', async () => {
  for (const patch of [{ META_MARKETING_LEADGEN_VERIFY_PAGE_ASSET_ID: undefined }, { META_MARKETING_LEADGEN_VERIFY_AD_ACCOUNT_ASSET_ID: undefined },
    { META_MARKETING_LEADGEN_VERIFY_PAGE_ASSET_ID: '0' }, { META_MARKETING_LEADGEN_VERIFY_PAGE_ASSET_ID: '0802' },
    { META_MARKETING_LEADGEN_VERIFY_PAGE_ASSET_ID: '391' }, { META_MARKETING_LEADGEN_VERIFY_PAGE_ASSET_ID: '2147483648' }]) {
    const f = fixture(environment(patch));
    await assert.rejects(f.reader.verificationPair(), { code: 'broker_configuration_invalid' });
    assert.equal(f.state.prepared.length, 0); assert.equal(f.state.calls.length, 0);
  }
});
test('revocation, app mismatch, receiver gate and configuration drift before/after owner I/O deny response', async () => {
  for (const mutate of [f => { f.state.blocked = true; }, f => { f.state.changed = { appId: '901' }; },
    f => { f.env.META_MARKETING_LEADGEN_RECEIVER_ENABLED = 'false'; },
    f => { f.env.META_MARKETING_LEADS_BROKER_ORIGIN = 'https://changed.invalid'; },
    f => { f.env.META_MARKETING_LEADGEN_VERIFY_PAGE_ASSET_ID = '803'; }]) {
    const f = fixture(), pair = await f.reader.preparePair(802, 391); f.state.onCommand = () => mutate(f);
    await assert.rejects(f.reader.read(pair, 'challenge', { mode: 'subscribe', token, challenge: 'qa' }));
    assert.equal(f.state.calls.length, 1);
  }
});
test('caller authority/URL/token extras and owner response credential leakage are rejected', async () => {
  const f = fixture(), pair = await f.reader.preparePair(802, 391);
  for (const extra of [{ adAccountAssetRef: 'meta-ad_account:500' }, { accessToken: 'PRIVATE' }, { url: 'https://evil.invalid' }]) {
    await assert.rejects(f.reader.read(pair, 'challenge', { mode: 'subscribe', token, challenge: 'qa', ...extra }), { code: 'invalid_request' });
  }
  assert.equal(f.state.calls.length, 0);
  f.state.response = { challenge: 'qa', token: 'PRIVATE' };
  await assert.rejects(f.reader.read(pair, 'challenge', { mode: 'subscribe', token, challenge: 'qa' }), { code: 'broker_response_invalid' });
});
test('forWebhookModels builds Scope with receiver gate, never the API broker global gate', async () => {
  const f = fixture(); let options;
  const filename = require.resolve('../../services/metaMarketingLeadWebhookReader.service');
  const loaded = { exports: {} };
  const ownRequire = name => name === './metaMarketingBrokerScope.service'
    ? { createMetaMarketingBrokerScope: value => { options = value; return f.scope; }, createMetaMarketingLeadIngressScopeRepository: () => ({ fixture: true }),
      createMetaMarketingScopeRepository: () => assert.fail('Public ingress must not require a usable reader credential') }
    : require(require.resolve(name, { paths: [path.dirname(filename)] }));
  vm.runInThisContext(ModuleWrapper(fs.readFileSync(filename, 'utf8')), { filename })(loaded.exports, ownRequire, loaded, filename, path.dirname(filename));
  const service = loaded.exports.forWebhookModels({ CampaignWorkspaceSetting: { findOne: async () => null } }, { env: f.env });
  assert.equal(options.fixture, true); assert.equal(options.enabled(), true);
  await service.preparePair(802, 391); assert.equal(f.state.prepared.length, 2);
  f.env.META_MARKETING_LEADGEN_RECEIVER_ENABLED = 'false'; assert.equal(options.enabled(), false);
  await assert.rejects(service.preparePair(802, 391), { code: 'meta_leads_disabled' });
});
function ModuleWrapper(source) { return '(function(exports,require,module,__filename,__dirname){' + source + '\n})'; }
test('unconfigured production aliases return 503 before querying models or loading an API key', async () => {
  let queries = 0;
  const models = new Proxy({}, { get() { queries++; throw Error('MODELS_MUST_NOT_BE_QUERIED'); } });
  const handlers = createMetaLeadWebhookHandlers({ models, env: environment({ META_MARKETING_LEADGEN_RECEIVER_ENABLED: undefined }) });
  const res = response(); await handlers.verify({ query: {} }, res);
  assert.equal(res.statusCode, 503); assert.equal(queries, 0); assert.deepEqual(res.body, { success: false, code: 'meta_lead_receipt_unavailable' });
  const signature = 'sha256=' + 'a'.repeat(64), post = response();
  const rawBody = Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: '200', changes: [{ field: 'leadgen',
    value: { leadgen_id: '100', page_id: '200', form_id: '300', ad_id: '400' } }] }] }));
  await handlers.receive({ rawBody, rawHeaders: ['x-hub-signature-256', signature], headers: {
    'content-type': 'application/json', 'x-hub-signature-256': signature,
  } }, post);
  assert.equal(post.statusCode, 503); assert.equal(queries, 0); assert.deepEqual(post.body, { success: false, code: 'meta_lead_receipt_unavailable' });
});

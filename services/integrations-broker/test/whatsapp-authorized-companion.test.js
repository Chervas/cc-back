'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture: authorizedFixture, textMessage } = require('./whatsapp-authorized-fixture.cjs');
const { fixture: onboardingFixture, TOKEN } = require('./whatsapp-onboarding-fixture.cjs');
const E = require('../src/whatsapp-onboarding-contract');
const A = require('../src/whatsapp-activation-contract');
const { createWhatsappActivation } = require('../src/whatsapp-activation');
const { createWhatsappAuthorizedRegistry } = require('../src/whatsapp-authorized-registry');
const { createWhatsappAuthorizedSecrets } = require('../src/whatsapp-authorized-secrets');
const { ACCOUNT, SECRET_KEY } = require('../src/google-main');

const customer = () => ({ selectionOnly: true, businessId: '501', wabaIds: ['301','302'],
  providerGrantPolicy: E.PROVIDER_GRANT_POLICY });
function companionGrant(request, response) {
  if (request.action !== 'inspect') return response;
  response.data.scopes.push(...E.COMPANION_SCOPES);
  response.data.granular_scopes.push(...E.COMPANION_SCOPES.map(scope => ({ scope,
    ...(scope === 'business_management' ? {} : { target_ids: scope.startsWith('ads_') ? ['801'] : ['901'] }) })));
  return response;
}
const fixture = t => authorizedFixture(t, { customer: customer(), afterGraph: companionGrant, verifyProvider: true });

test('Companion enrollment and reinspection retain the actual token and full grant while exposing only pinned WhatsApp operations', async t => {
  const a = await fixture(t);
  const row = a.f.current.store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(a.definition.authorizationId);
  const metadata = JSON.parse(row.credential_metadata);
  const envelope = JSON.parse(a.f.records.get(a.f.binding.secretArn).get(row.id).body);
  assert.equal(envelope.version, 2);
  assert.equal(envelope.accessToken, TOKEN);
  assert.deepEqual(metadata.scopes, [...a.f.binding.whatsappOnboarding.scopes, ...E.COMPANION_SCOPES].sort());
  assert.deepEqual(envelope.scopes, metadata.scopes);
  assert.deepEqual(envelope.providerGrant, metadata.providerGrant);
  assert.equal(metadata.providerGrant.granularScopes.length, 11);
  assert.deepEqual(metadata.providerGrant.granularScopes.find(g => g.scope === 'business_management').targetIds, null);
  assert.deepEqual(metadata.grantedWabaIds, ['301','302']);
  assert(!Object.hasOwn(metadata, 'accessToken'));
  const initialLedger = a.f.snapshot(), puts = a.f.state.puts;
  const initialCalls = a.f.state.httpCalls.length;
  await a.execute();
  assert.equal(a.sends().length, 1);
  assert.equal(a.sends()[0].id, '401');
  assert.deepEqual(a.f.state.httpCalls.slice(initialCalls), [
    { action: 'inspect', id: '101' }, { action: 'waba_owner', id: '301' },
    { action: 'waba_owner', id: '302' }, { action: 'phones', id: '301' },
  ]);
  assert.equal(a.f.snapshot(), initialLedger);
  assert.equal(a.f.state.puts, puts);
  for (const token of a.f.state.heldTokens) assert(token.every(byte => byte === 0));
  const calls = a.state.calls.length, reads = a.f.state.awsCalls.length;
  for (const change of [
    { tenantRef: 'clinic:73' }, { assetRef: 'wa-phone:999' },
    { payload: { authorizationId: row.id, phoneId: '999', message: textMessage() } },
    { operation: 'meta.ads.read.v1', payload: {} },
  ]) await assert.rejects(a.execute(a.request(textMessage(), change)));
  assert.equal(a.state.calls.length, calls);
  assert.equal(a.f.state.awsCalls.length, reads);
});

test('Ordinary companion sends retain local credential checks without adding provider inspections', async t => {
  const a = await authorizedFixture(t, { customer: customer(), afterGraph: companionGrant });
  const ledger = a.f.snapshot(), puts = a.f.state.puts;
  const inspections = a.f.state.httpCalls.length;
  a.f.state.afterGraph = () => assert.fail('Ordinary sends must not reinspect the provider grant');
  await a.execute();
  assert.deepEqual(a.state.calls.map(c => c.action), ['send']);
  assert.equal(a.f.state.httpCalls.length, inspections);
  assert.equal(a.f.state.puts, puts);
  assert.equal(a.f.snapshot(), ledger);
});

test('A companion token remains private and is wiped after a rejected callback result', async t => {
  const a = await fixture(t); let borrowed;
  await assert.rejects(a.secrets.withSecret(a.binding, token => {
    borrowed = token; assert.equal(token.toString('utf8'), TOKEN);
    return { forbidden: token.toString('utf8') };
  }), { code: 'provider_failed' });
  assert(borrowed.every(byte => byte === 0));
  assert.equal(a.sends().length, 0);
});

for (const scenario of [
  { name: 'unknown scope', code: 'oauth_credentials_incomplete', mutate: (r, v) => {
    if (r.action === 'inspect') v.data.scopes.push('instagram_manage_messages');
  } },
  { name: 'another application', code: 'oauth_identity_mismatch', mutate: (r, v) => {
    if (r.action === 'inspect') v.data.app_id = '999';
  } },
  { name: 'a different enrolled subject', code: 'scope_denied', mutate: (r, v) => {
    if (r.action === 'inspect') v.data.user_id = '999';
  } },
  { name: 'missing selected WhatsApp account', code: 'scope_denied', mutate: (r, v) => {
    if (r.action === 'inspect') for (const g of v.data.granular_scopes) {
      if (g.scope === 'whatsapp_business_messaging') g.target_ids = ['302'];
    }
  } },
  { name: 'another owner on an unselected WhatsApp account', code: 'scope_denied', mutate: (r, v) => {
    if (r.action === 'waba_owner' && r.id === '302') v.owner_business_info.id = '999';
  } },
  { name: 'a different phone', code: 'scope_denied', mutate: (r, v) => {
    if (r.action === 'phones') v.data = [{ id: '999' }];
  } },
  { name: 'provider expiration', code: 'credential_revoked', mutate: (r, v, a) => {
    if (r.action === 'inspect') v.data.expires_at = Math.floor(a.f.now() / 1000) - 1;
  } },
  { name: 'provider data-access expiration', code: 'credential_revoked', mutate: (r, v, a) => {
    if (r.action === 'inspect') v.data.data_access_expires_at = Math.floor(a.f.now() / 1000) - 1;
  } },
]) test('Companion reinspection rejects ' + scenario.name + ' before a send', async t => {
  const a = await fixture(t);
  const ledger = a.f.snapshot(), puts = a.f.state.puts;
  a.state.after = (r, v) => { scenario.mutate(r, v, a); return v; };
  await assert.rejects(a.execute(), { code: scenario.code });
  assert.equal(a.sends().length, 0);
  assert.equal(a.f.snapshot(), ledger);
  assert.equal(a.f.state.puts, puts);
  for (const token of a.f.state.heldTokens) assert(token.every(byte => byte === 0));
});

test('Strict enrollment continues rejecting the same mixed provider grant without storing a candidate', async t => {
  const f = onboardingFixture(t, { customer: { selectionOnly: true },
    scopes: ['whatsapp_business_management','whatsapp_business_messaging','public_profile'] });
  f.state.afterGraph = companionGrant;
  const flow = await f.begin();
  await assert.rejects(f.finish(flow), { code: 'oauth_credentials_incomplete' });
  assert.equal(f.state.puts, 0);
  assert.equal(f.current.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_onboarding_assets').get().n, 0);
});

test('A companion definition in the dynamic inventory preserves an existing strict fingerprint, v1 secret and sender', async t => {
  const a = await authorizedFixture(t);
  const fingerprint = E.fingerprint(a.f.binding);
  const original = a.f.records.get(a.f.binding.secretArn).get(a.definition.authorizationId).body;
  assert.equal(JSON.parse(original).version, 1);
  const companion = structuredClone(a.definition);
  companion.connectionRef = 'connection:companion-inventory-qa';
  companion.authorizationId = randomUUID(); companion.phoneId = '402';
  companion.enrollmentBinding = structuredClone(a.f.binding);
  companion.enrollmentBinding.connectionRef = 'connection:companion-enrollment-qa';
  companion.enrollmentBinding.whatsappOnboarding.customer.providerGrantPolicy = E.PROVIDER_GRANT_POLICY;
  const fixedSeed = { ...a.definition, connectionRef: 'connection:fixed-inventory-qa', authorizationId: randomUUID(), phoneId: '403' };
  const registry = createWhatsappAuthorizedRegistry({ filename: a.f.filename, authorizations: [fixedSeed],
    loadAuthorizations: () => [companion, a.definition], loadEnrollmentBinding: () => a.f.binding, now: a.f.now });
  const secrets = createWhatsappAuthorizedSecrets({ client: a.f.aws, accountId: ACCOUNT,
    prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: SECRET_KEY, registry, http: a.http, now: a.f.now });
  t.after(() => { secrets.close(); registry.close(); });
  const observed = registry.assert(a.binding);
  assert.equal(observed.definition.authorizationId, a.definition.authorizationId);
  assert.equal(Object.hasOwn(observed.metadata, 'providerGrant'), false);
  assert.deepEqual(await secrets.withSecret(a.binding, token => ({ valid: token.toString('utf8') === TOKEN })), { valid: true });
  await a.execute();
  assert.equal(a.sends().length, 1);
  assert.equal(E.fingerprint(a.f.binding), fingerprint);
  assert.equal(a.f.records.get(a.f.binding.secretArn).get(a.definition.authorizationId).body, original);
});

test('Companion coexistence passes enrollment and both activation inspections without registering or changing the raw grant', async t => {
  const f = onboardingFixture(t, { customer: customer(),
    scopes: ['whatsapp_business_management','whatsapp_business_messaging','public_profile','whatsapp_business_manage_events'] });
  f.state.afterGraph = companionGrant;
  const flow = await f.begin(); await f.finish(flow);
  const original = f.records.get(f.binding.secretArn).get(flow.flowId).body;
  const state = { subscribed: false, calls: [], pins: 0 };
  const engine = createWhatsappActivation({ store: f.current.store, filename: f.filename, policy: f.policy,
    client: f.aws, accountId: ACCOUNT, kmsKeyArn: SECRET_KEY, now: f.now,
    pinFactory: () => async () => { state.pins++; assert.fail('Business App coexistence must not register a phone'); },
    http: async request => {
      state.calls.push({ action: request.action, id: request.id });
      if (request.action === 'profile') return { id: '401', status: 'CONNECTED', platform_type: 'CLOUD_API', is_on_biz_app: true,
        code_verification_status: 'VERIFIED', quality_rating: 'GREEN', display_phone_number: '+34000000000', verified_name: 'Fictitious QA' };
      if (request.action === 'subscriptions') return { data: state.subscribed ? [{ whatsapp_business_api_data: { id: '101' } }] : [] };
      if (request.action === 'subscribe') { state.subscribed = true; return { success: true }; }
      assert.notEqual(request.action, 'register_phone');
      return f.http(request);
    } });
  const execute = (operation, changes = {}) => engine.operations[operation].execute({
    request: f.command(operation, { flowId: flow.flowId, scopeDigest: flow.payload.scopeDigest,
      clinicSetDigest: flow.payload.clinicSetDigest, ...changes }),
    principal: f.policy.principals[0], binding: f.binding, policy: f.policy,
  });
  const profile = await execute(A.PROFILE);
  assert.equal(profile.data.profile.isOnBizApp, true);
  const active = await execute(A.ACTIVATE, { assetId: 991 });
  assert.equal(active.data.state, 'active');
  assert.equal(active.data.profile.isOnBizApp, true);
  assert.equal(state.pins, 0);
  assert.equal(state.calls.filter(c => c.action === 'inspect').length, 2);
  assert.equal(f.state.httpCalls.filter(c => c.action === 'inspect').length, 3);
  assert.deepEqual(state.calls.filter(c => ['waba_owner','phones','subscribe','subscriptions','profile'].includes(c.action))
    .filter(c => c.id !== '401' && c.id !== '301' && c.id !== '302'), []);
  assert.equal(f.records.get(f.binding.secretArn).get(flow.flowId).body, original);
  assert.equal(f.state.puts, 1);
  const activation = f.current.store.db.prepare('SELECT definition FROM whatsapp_activations WHERE flow_id=?').get(flow.flowId);
  assert.equal(JSON.parse(activation.definition).enrollmentBinding.whatsappOnboarding.customer.providerGrantPolicy, E.PROVIDER_GRANT_POLICY);
  assert(!JSON.stringify(active).includes(TOKEN));
});

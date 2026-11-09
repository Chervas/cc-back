'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../src/whatsapp-onboarding-contract');
const { inspectCustomerGrant, createWhatsappCustomerVerifier } = require('../src/whatsapp-customer-verifier');
const { fixture: onboarding, TOKEN, APP } = require('./whatsapp-onboarding-fixture.cjs');
const { fixture, broaden, WA_SCOPES } = require('./whatsapp-companion-fixture.cjs');
const at = 1794233446173;
const options = { customer: { selectionOnly: true, wabaIds: ['301','302'], providerGrantPolicy: C.PROVIDER_GRANT_POLICY }, scopes: WA_SCOPES };
function fakeOwners(calls, foreign = false) { return async input => {
  calls.push([input.action, input.id]); assert.equal(input.action, 'waba_owner');
  assert(['301','302'].includes(input.id), 'a Marketing target must never cause a read');
  return { id: input.id, owner_business_info: { id: foreign && input.id === '302' ? '999' : '501' } };
}; }
function metadata(f) {
  const value = inspectCustomerGrant(f.response, f.expected, at), { wabaIds, ...grant } = value;
  return { ...grant, wabaId: '301', phoneId: '401', businessId: '501', grantedWabaIds: wabaIds };
}
test('The f799 structural grant still fails under the unchanged default policy before any owner read', async () => {
  const f = fixture(); delete f.expected.providerGrantPolicy;
  await assert.rejects(createWhatsappCustomerVerifier({ now: () => at, http: () => assert.fail('unexpected read') })(f),
    { code: 'oauth_credentials_incomplete' });
});
test('The explicit companion policy retains every real scope and normalized granular row while proving all WA owners only', async () => {
  const f = fixture(), calls = [];
  const result = await createWhatsappCustomerVerifier({ now: () => at, http: fakeOwners(calls) })(f);
  assert.deepEqual(result.scopes, [...WA_SCOPES, ...C.COMPANION_SCOPES].sort());
  assert.deepEqual(result.wabaIds, ['301','302']); assert.equal(result.businessId, '501');
  assert.deepEqual(calls, [['waba_owner','301'],['waba_owner','302']]);
  assert.equal(result.providerGrant.version, 1); assert.equal(result.providerGrant.granularScopes.length, 11);
  assert.equal(result.providerGrant.granularScopes.find(row => row.scope === 'whatsapp_business_manage_events').targetIds, null);
  for (const scope of C.COMPANION_SCOPES) assert(result.providerGrant.granularScopes.some(row => row.scope === scope));
  f.response.data.granular_scopes.find(row => row.scope === 'whatsapp_business_management').target_ids.push('999');
  assert.deepEqual(result.providerGrant.granularScopes.find(row => row.scope === 'whatsapp_business_management').targetIds, ['301','302']);
  assert(!JSON.stringify(result).includes('FICTITIOUS_COMPANION_TOKEN'));
});
test('The companion opt-in cannot be unknown, implicit, business-wide, or omit required public_profile', t => {
  const f = onboarding(t, options), b = f.binding;
  for (const mutate of [
    v => { delete v.customer.selectionOnly; },
    v => { v.customer.providerGrantPolicy = 'accept_all'; },
    v => { v.scopes = v.scopes.filter(scope => scope !== 'public_profile'); },
  ]) { const changed = structuredClone(b); mutate(changed.whatsappOnboarding); assert.throws(() => C.bindingFor(changed)); }
  const old = structuredClone(b); delete old.whatsappOnboarding.customer.providerGrantPolicy;
  const v = old.whatsappOnboarding;
  const oldFingerprint = C.hash(JSON.stringify([old.connectionRef, old.secretArn, old.clientSecretArn, v.appId, v.configId,
    v.redirectUri, v.appVersionId, v.slotVersionId, v.scopeKey, v.clinicIds, [...v.scopes].sort(), v.customer.businessId || null,
    v.customer.wabaIds || null, 'selected-phone-v1']));
  assert.equal(C.fingerprint(old), oldFingerprint); assert.notEqual(C.fingerprint(b), oldFingerprint);
});
test('Missing WA or selected targets, invalid identity, expiry, unknown scopes, malformed and oversized evidence reject before reads', async () => {
  const mutations = [
    f => { f.response.data.scopes = f.response.data.scopes.filter(scope => scope !== 'whatsapp_business_messaging'); },
    f => { f.response.data.scopes = f.response.data.scopes.filter(scope => scope !== 'public_profile'); },
    f => { f.response.data.granular_scopes.find(row => row.scope === 'whatsapp_business_management').target_ids = ['302']; },
    f => { f.response.data.granular_scopes.find(row => row.scope === 'whatsapp_business_messaging').target_ids = null; },
    f => { f.expected.wabaIds = ['301']; },
    f => { f.response.data.app_id = '999'; },
    f => { f.response.data.user_id = '0'; },
    f => { f.response.data.type = 'USER'; },
    f => { f.response.data.is_valid = false; },
    f => { f.response.data.expires_at = 1; },
    f => { f.response.data.data_access_expires_at = 1; },
    f => { f.response.data.scopes.push('pages_messaging'); },
    f => { f.response.data.scopes.push('ads_read'); },
    f => { f.response.data.granular_scopes.push(f.response.data.granular_scopes[0]); },
    f => { f.response.data.granular_scopes.find(row => row.scope === 'whatsapp_business_management').target_ids.push('301'); },
    f => { f.response.data.granular_scopes.find(row => row.scope === 'whatsapp_business_management').target_ids.push('0'); },
    f => { f.response.data.granular_scopes[0].target_ids = Array.from({ length: 65 }, (_, i) => String(300 + i)); },
    f => { f.response.data.granular_scopes[0].unknown = true; },
    f => { f.response.data.scopes = f.response.data.scopes.filter(scope => scope !== 'ads_read'); },
    f => { f.response.data.granular_scopes.find(row => row.scope === 'whatsapp_business_management').target_ids = undefined; },
    f => { f.response.data.granular_scopes[0].scope = 'pages_messaging'; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    await assert.rejects(createWhatsappCustomerVerifier({ now: () => at, http: () => assert.fail('unexpected read') })(f));
  }
  const f = fixture(); f.response.data.granular_scopes.forEach(row => { row.target_ids = Array.from({ length: 64 }, (_, i) => String(300 + i)); });
  await assert.rejects(createWhatsappCustomerVerifier({ now: () => at, http: () => assert.fail('unexpected read') })(f), { code: 'oauth_credentials_incomplete' });
});
test('A different owner of any unselected WABA still rejects the companion grant', async () => {
  const f = fixture(), calls = [];
  await assert.rejects(createWhatsappCustomerVerifier({ now: () => at, http: fakeOwners(calls, true) })(f), { code: 'scope_denied' });
  assert.deepEqual(calls, [['waba_owner','301'],['waba_owner','302']]);
});
test('Optional events remain optional and complete provider evidence cannot disagree with the committed WA grant', t => {
  const f = fixture(); f.response.data.scopes = f.response.data.scopes.filter(scope => scope !== 'whatsapp_business_manage_events');
  f.response.data.granular_scopes = f.response.data.granular_scopes.filter(row => row.scope !== 'whatsapp_business_manage_events');
  const b = onboarding(t, options).binding, value = metadata(f);
  assert(!value.scopes.includes('whatsapp_business_manage_events')); assert.equal(C.grantMetadata(value, b).providerGrant.version, 1);
  for (const mutate of [
    v => { delete v.providerGrant; }, v => { v.providerGrant.version = 2; },
    v => { v.providerGrant.granularScopes[0].unknown = true; },
    v => { v.grantedWabaIds = ['301']; },
    v => { v.providerGrant.granularScopes.find(row => row.scope === 'whatsapp_business_management').targetIds = ['302']; },
    v => { v.providerGrant.granularScopes.push({ scope: 'pages_messaging', targetIds: null }); },
  ]) { const changed = structuredClone(value); mutate(changed); assert.throws(() => C.grantMetadata(changed, b)); }
});
test('Onboarding stores a v2 candidate with complete evidence and preserves it across restart without writes or duplicate exchange', async t => {
  const f = onboarding(t, options); f.state.afterGraph = (req, value) => req.action === 'inspect' ? broaden(value) : value;
  const flow = await f.begin(), result = await f.finish(flow), row = f.current.store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(flow.flowId);
  assert.equal(result.data.status, 'staged'); assert.equal(result.data.connected, false);
  assert.deepEqual(result.data.candidate.scopes, [...WA_SCOPES, ...C.COMPANION_SCOPES].sort());
  assert.equal(result.data.candidate.providerGrant.granularScopes.length, 11);
  const body = f.records.get(f.binding.secretArn).get(flow.flowId).body, envelope = JSON.parse(body);
  assert.equal(envelope.version, 2); assert.equal(envelope.providerGrant.version, 1);
  assert.deepEqual(JSON.parse(row.credential_metadata).providerGrant, result.data.candidate.providerGrant);
  assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1);
  assert(f.state.httpCalls.every(call => ['inspect','waba_owner','phones','phone_state'].includes(call.action)));
  assert(!f.state.httpCalls.some(call => Number(call.id) >= 801));
  for (const secret of [TOKEN, APP, flow.code, flow.payload.state]) assert(!f.snapshot().includes(secret));
  f.restart(); assert.deepEqual((await f.status(flow)).data.candidate, result.data.candidate);
  assert.equal((await f.finish(flow)).replayed, true); assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1);
  assert.equal(f.records.get(f.binding.secretArn).get(flow.flowId).body, body);
});
test('Companion enrollment requires authenticated coexistence before encoding or any candidate write', async t => {
  const observations = [
    { is_on_biz_app: false, platform_type: 'CLOUD_API' },
    { is_on_biz_app: true, platform_type: 'ON_PREMISE' },
    { is_on_biz_app: true, platform_type: 'NOT_APPLICABLE' },
    { is_on_biz_app: true, platform_type: 'UNKNOWN' },
    { is_on_biz_app: null, platform_type: 'CLOUD_API' },
    { is_on_biz_app: 'true', platform_type: 'CLOUD_API' },
    { platform_type: 'CLOUD_API' },
    { is_on_biz_app: true },
    {},
  ];
  for (const observation of observations) await t.test(JSON.stringify(observation), async t => {
    const f = onboarding(t, options);
    f.state.afterGraph = (req, value) => req.action === 'inspect' ? broaden(value)
      : req.action === 'phone_state' ? { id: req.id, ...observation } : value;
    const flow = await f.begin(); await assert.rejects(f.finish(flow), { code: 'scope_denied' });
    const row = f.current.store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(flow.flowId);
    assert.equal(row.state, 'interrupted'); assert.equal(row.secret_digest, null); assert.equal(row.credential_metadata, null);
    assert.equal(f.current.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_onboarding_phone_observations WHERE flow_id=?').get(flow.flowId).n, 0);
    assert.equal(f.current.store.db.prepare('SELECT COUNT(*) n FROM whatsapp_onboarding_assets').get().n, 0);
    assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 0); assert(!f.records.get(f.binding.secretArn).has(flow.flowId));
    assert(f.state.httpCalls.every(call => ['inspect','waba_owner','phones','phone_state'].includes(call.action)));
    for (const secret of [TOKEN, APP, flow.code, flow.payload.state]) assert(!f.snapshot().includes(secret));
  });
});
test('Default strict enrollment preserves Cloud candidates without the companion coexistence policy', async t => {
  const f = onboarding(t, { customer: { selectionOnly: true }, scopes: WA_SCOPES });
  f.state.afterGraph = (req, value) => req.action === 'phone_state'
    ? { id: req.id, is_on_biz_app: false, platform_type: 'CLOUD_API' } : value;
  const flow = await f.begin(), result = await f.finish(flow);
  assert.equal(result.data.status, 'staged'); assert.equal(result.data.phoneState.isOnBizApp, false);
  assert.equal(result.data.phoneState.coexistenceAvailable, false); assert.equal(f.state.puts, 1);
  assert.equal(JSON.parse(f.records.get(f.binding.secretArn).get(flow.flowId).body).version, 1);
});
test('V1 bytes are unchanged and v2 cannot be downgraded or adopted under a policy-less binding', async t => {
  const legacy = onboarding(t, { customer: { selectionOnly: true }, scopes: WA_SCOPES }), oldFlow = await legacy.begin();
  await legacy.finish(oldFlow); const oldRow = legacy.current.store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(oldFlow.flowId);
  const oldBody = legacy.records.get(legacy.binding.secretArn).get(oldFlow.flowId).body, b = legacy.binding.whatsappOnboarding;
  const expected = { version: 1, provider: 'meta-whatsapp-candidate', flowId: oldRow.id, connectionRef: legacy.binding.connectionRef,
    scopeKey: b.scopeKey, scopeDigest: oldRow.scope_digest, clinicSetDigest: oldRow.clinic_digest, authorizationExpiresAt: oldRow.expires_at,
    configId: b.configId, ...JSON.parse(oldRow.credential_metadata), accessToken: TOKEN };
  assert.equal(oldBody, JSON.stringify(expected)); assert(!oldBody.includes('providerGrant'));
  const f = onboarding(t, options); f.state.afterGraph = (req, value) => req.action === 'inspect' ? broaden(value) : value;
  const flow = await f.begin(); await f.finish(flow);
  const row = f.current.store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(flow.flowId), version = f.records.get(f.binding.secretArn).get(flow.flowId);
  const body = JSON.parse(version.body); body.version = 1; const downgraded = Buffer.from(JSON.stringify(body));
  await assert.rejects(f.secrets.stage(f.binding, row, { body: downgraded, digest: C.hash(downgraded) }), { code: 'secret_unavailable' });
  const changed = structuredClone(f.policy); delete changed.connections[0].whatsappOnboarding.customer.providerGrantPolicy;
  const other = f.make(undefined, changed);
  assert.equal((await f.status(flow, other)).data.configurationChanged, true);
  await assert.rejects(f.finish(flow, {}, other), { code: 'idempotency_conflict' });
  assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1);
});
test('Uncertain v2 candidate writes reconcile without replay and provider-evidence tampering cannot be adopted', async t => {
  const f = onboarding(t, options); f.state.afterGraph = (req, value) => req.action === 'inspect' ? broaden(value) : value;
  const flow = await f.begin(); f.state.losePut = true; await assert.rejects(f.finish(flow), { code: 'secret_unavailable' });
  const version = f.records.get(f.binding.secretArn).get(flow.flowId), original = version.body;
  const tampered = JSON.parse(original); tampered.providerGrant.granularScopes[0].targetIds = ['999']; version.body = JSON.stringify(tampered);
  await assert.rejects(f.status(flow), { code: 'secret_unavailable' }); version.body = original;
  f.restart(); assert.equal((await f.status(flow)).data.status, 'staged');
  assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1); assert.equal(version.body, original);
});

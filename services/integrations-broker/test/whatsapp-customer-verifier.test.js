'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { inspectCustomerGrant, createWhatsappCustomerVerifier } = require('../src/whatsapp-customer-verifier');
const { verifyWhatsappGrant } = require('../src/whatsapp-credential-inspector');
const at = 1789450000000;
function fixture() {
  const expected = { appId: '101', businessId: '201', selectedWabaId: '301', wabaIds: ['301','302'],
    scopes: ['whatsapp_business_management','whatsapp_business_messaging','public_profile'] };
  const response = { data: { is_valid: true, app_id: '101', user_id: '401', type: 'SYSTEM_USER',
    scopes: [...expected.scopes], expires_at: 0, data_access_expires_at: 0,
    granular_scopes: expected.scopes.filter(s => s !== 'public_profile').map(scope => ({ scope, target_ids: ['301','302'] })) } };
  return { expected, response, token: Buffer.from('FICTITIOUS_CUSTOMER_TOKEN'), proof: 'a'.repeat(64) };
}
test('Checks every granted WABA owner against the pinned customer, without activating or returning credentials', async () => {
  const f = fixture(); const calls = [];
  const result = await createWhatsappCustomerVerifier({ now: () => at, http: async input => {
    calls.push(input); return { id: input.id, owner_business_info: { id: '201', name: 'FICTITIOUS_CUSTOMER' } };
  } })(f);
  assert.deepEqual(calls.map(c => [c.action, c.id]), [['waba_owner','301'],['waba_owner','302']]);
  assert.deepEqual(result.wabaIds, ['301','302']); assert.equal(result.businessId, '201');
  assert.equal(result.observedAt, at); assert.equal(result.expiresAt, null);
  assert(!JSON.stringify(result).includes('FICTITIOUS')); assert.equal(result.connected, undefined);
});
test('A granted but unselected WABA owned by another customer rejects the entire proof', async () => {
  const f = fixture(); const calls = [];
  await assert.rejects(createWhatsappCustomerVerifier({ now: () => at, http: async input => {
    calls.push(input.id); return { id: input.id, owner_business_info: { id: input.id === '301' ? '201' : '999' } };
  } })(f), { code: 'scope_denied' });
  assert.deepEqual(calls, ['301','302']);
});
test('Foreign target, missing granular evidence, duplicate, missing selected WABA and cross-product scope cannot cause any read', async () => {
  const mutations = [
    f => f.response.data.granular_scopes[1].target_ids.push('999'),
    f => f.response.data.granular_scopes.pop(),
    f => f.response.data.granular_scopes[0].target_ids.push('301'),
    f => f.response.data.granular_scopes[1].target_ids = ['302'],
    f => f.response.data.granular_scopes.push(f.response.data.granular_scopes[0]),
    f => f.response.data.scopes.push('ads_management'),
    f => f.response.data.scopes.push('business_management'),
    f => f.response.data.app_id = '999',
    f => f.response.data.type = 'USER',
    f => f.response.data.is_valid = false,
    f => f.response.data.data_access_expires_at = 1,
    f => f.expected.wabaIds.push('301'),
    f => f.expected.wabaIds = ['302'],
    f => f.response.data.granular_scopes[0].target_ids = [],
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    await assert.rejects(createWhatsappCustomerVerifier({ now: () => at, http: async () => assert.fail('unexpected provider read') })(f));
  }
});
test('Events permission remains outside customer enrollment even if added to expected configuration', () => {
  const f = fixture(); f.response.data.scopes.push('whatsapp_business_manage_events');
  f.response.data.granular_scopes.push({ scope: 'whatsapp_business_manage_events', target_ids: ['302'] });
  assert.throws(() => inspectCustomerGrant(f.response, f.expected, at));
  f.expected.scopes.push('whatsapp_business_manage_events');
  assert.throws(() => inspectCustomerGrant(f.response, f.expected, at), { code: 'invalid_request' });
});
test('Missing owner, non-owner relationship and mismatched requested WABA do not prove ownership', async () => {
  for (const response of [{ id: '301' }, { id: '301', on_behalf_of_business_info: { id: '201' } },
    { id: '999', owner_business_info: { id: '201' } }, { id: '301', owner_business_info: { id: 201 } }]) {
    await assert.rejects(createWhatsappCustomerVerifier({ now: () => at, http: async () => response })(fixture()), { code: 'scope_denied' });
  }
});
test('Policy and provider objects cannot change the owner check while async reads are in flight', async () => {
  const f = fixture(); let n = 0;
  await assert.rejects(createWhatsappCustomerVerifier({ now: () => at, http: async input => {
    n++; if (n === 1) { f.expected.businessId = '999'; f.expected.wabaIds.splice(1, 1); f.response.data.scopes.length = 0; }
    return { id: input.id, owner_business_info: { id: n === 1 ? '201' : '999' } };
  } })(f), { code: 'scope_denied' });
  assert.equal(n, 2);
});
test('Cancellation and expiry during an owner read reject; provider errors do not leak token or names', async () => {
  for (const mode of ['abort','expiry','error']) {
    const f = fixture(); let time = at; const controller = new AbortController(); f.signal = controller.signal;
    f.response.data.expires_at = Math.floor(at / 1000) + 10;
    await assert.rejects(createWhatsappCustomerVerifier({ now: () => time, http: async input => {
      if (mode === 'abort') controller.abort();
      if (mode === 'expiry') time += 11000;
      if (mode === 'error') throw Error('FICTITIOUS_CUSTOMER_TOKEN FICTITIOUS_CUSTOMER');
      return { id: input.id, owner_business_info: { id: '201' } };
    } })(f), e => {
      assert.equal(e.code, { abort: 'provider_timeout', expiry: 'credential_revoked', error: 'provider_failed' }[mode]);
      assert(!e.stack.includes('FICTITIOUS')); return true;
    });
  }
});
test('The existing operational inspector still rejects multi-WABA grants', () => {
  const f = fixture(); assert.throws(() => verifyWhatsappGrant(f.response,
    { appId: '101', subjectId: '401', wabaId: '301', scopes: f.expected.scopes }, at), { code: 'scope_denied' });
});

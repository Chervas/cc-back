'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createWhatsappPhoneVerifier, inspectWhatsappPhoneState } = require('../src/whatsapp-phone-verifier');
const input = () => ({ wabaId: '301', phoneId: '401', token: Buffer.from('FICTITIOUS_WA_TOKEN'), proof: 'a'.repeat(64) });
test('phone state distinguishes coexistence, API-only and unknown without registering or promising QR-free access', async () => {
  for (const [fields, expected] of [
    [{ is_on_biz_app: true, platform_type: 'CLOUD_API' }, true],
    [{ is_on_biz_app: false, platform_type: 'CLOUD_API' }, false],
    [{ is_on_biz_app: true, platform_type: 'ON_PREMISE' }, false],
    [{}, false], [{ is_on_biz_app: 'true', platform_type: 'UNKNOWN' }, false],
  ]) {
    const calls = [];
    const result = await inspectWhatsappPhoneState({ ...input(), http: async req => { calls.push(req); return { id: '401', ...fields }; } });
    assert.equal(result.coexistenceAvailable, expected); assert.equal(result.registrationAttempted, false);
    assert.deepEqual(calls.map(c => [c.action, c.id]), [['phone_state', '401']]);
  }
  await assert.rejects(inspectWhatsappPhoneState({ ...input(), http: async () => ({ id: '402' }) }), { code: 'oauth_credentials_incomplete' });
  const controller = new AbortController();
  await assert.rejects(inspectWhatsappPhoneState({ ...input(), signal: controller.signal,
    http: async () => { controller.abort(); return { id: '401' }; } }), { code: 'provider_timeout' });
});
test('WABA-only coexistence resolves a unique phone across all pages and rejects ambiguous accounts', async () => {
  const verify = createWhatsappPhoneVerifier({ http: async () => ({ data: [{ id: '401' }] }) });
  assert.deepEqual(await verify({ ...input(), phoneId: null }), { wabaId: '301', phoneId: '401' });
  let calls = 0;
  const ambiguous = createWhatsappPhoneVerifier({ http: async () => ++calls === 1
    ? { data: [{ id: '401' }], paging: { next: 'ignored', cursors: { after: 'more' } } }
    : { data: [{ id: '402' }] } });
  await assert.rejects(ambiguous({ ...input(), phoneId: null }), { code: 'scope_denied' });
  assert.equal(calls, 2);
});
test('Phone verifier checks provider WABA membership and ignores arbitrary pagination URLs', async () => {
  const calls = [];
  const verify = createWhatsappPhoneVerifier({ http: async request => { calls.push(request);
    return request.after ? { data: [{ id: '401' }] } : { data: [{ id: '402' }], paging: { next: 'https://example.invalid/?access_token=FICTITIOUS', cursors: { after: 'safe_cursor' } } };
  } });
  assert.deepEqual(await verify(input()), { wabaId: '301', phoneId: '401' }); assert.equal(calls.length, 2);
  assert(calls.every(c => c.action === 'phones' && c.id === '301')); assert.equal(calls[1].after, 'safe_cursor');
  assert(!JSON.stringify(calls).includes('example.invalid'));
});
for (const [name, response] of [
  ['foreign phone', { data: [{ id: '999' }] }], ['empty WABA', { data: [] }], ['invalid ID', { data: [{ id: 401 }] }],
  ['duplicate ID', { data: [{ id: '401' }, { id: '401' }] }], ['missing data', {}],
  ['oversize page', { data: Array.from({ length: 101 }, (_, i) => ({ id: String(i + 1) })) }],
  ['unsafe cursor', { data: [{ id: '402' }], paging: { next: 'unused', cursors: { after: 'https://example.invalid' } } }],
  ['missing cursor', { data: [{ id: '402' }], paging: { next: 'unused' } }], ['provider error', { error: { message: 'FICTITIOUS_SECRET' } }],
]) test('Phone proof denies ' + name, async () => { await assert.rejects(createWhatsappPhoneVerifier({ http: async () => response })(input())); });
test('Phone verifier bounds pagination, rejects cursor loops and sanitizes failures', async () => {
  let count = 0;
  await assert.rejects(createWhatsappPhoneVerifier({ http: async () => { count++; return { data: [{ id: String(1000 + count) }], paging: { next: 'unused', cursors: { after: 'c' + count } } }; } })(input()), { code: 'oauth_credentials_incomplete' });
  assert.equal(count, 20); count = 0;
  await assert.rejects(createWhatsappPhoneVerifier({ http: async () => { count++; return { data: [{ id: String(1000 + count) }], paging: { next: 'unused', cursors: { after: 'repeat' } } }; } })(input()), { code: 'oauth_credentials_incomplete' });
  assert.equal(count, 2);
  await assert.rejects(createWhatsappPhoneVerifier({ http: async () => { throw Error('FICTITIOUS_SECRET'); } })(input()), e => e.code === 'provider_failed' && !e.stack.includes('FICTITIOUS'));
});
test('Phone verifier denies malformed input and rechecks abort after provider response', async () => {
  let calls = 0; const controller = new AbortController();
  const verify = createWhatsappPhoneVerifier({ http: async () => { calls++; controller.abort(); return { data: [{ id: '401' }] }; } });
  for (const changes of [{ wabaId: '../301' }, { phoneId: 401 }, { token: 'bad' }, { proof: '' }]) await assert.rejects(verify({ ...input(), ...changes }), { code: 'invalid_request' });
  assert.equal(calls, 0); await assert.rejects(verify({ ...input(), signal: controller.signal }), { code: 'provider_timeout' }); assert.equal(calls, 1);
  await assert.rejects(verify({ ...input(), signal: controller.signal }), { code: 'provider_timeout' }); assert.equal(calls, 1);
});

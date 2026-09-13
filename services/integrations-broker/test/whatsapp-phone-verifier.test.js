'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createWhatsappPhoneVerifier } = require('../src/whatsapp-phone-verifier');
const input = () => ({ wabaId: '301', phoneId: '401', token: Buffer.from('FICTITIOUS_WA_TOKEN'), proof: 'a'.repeat(64) });
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

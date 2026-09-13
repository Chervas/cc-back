'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { createHmac } = require('node:crypto');
const { fixture, SEND_TOKEN, READ_TOKEN, APP_SECRET } = require('./whatsapp-fixture.cjs');
test('pinned credentials are callback scoped, proofs bind role and connection, buffers are wiped without cache', async t => {
  const f = fixture(t); const buffers = [];
  for (let i = 0; i < 2; i++) await f.secrets.withSecret(f.binding, async token => {
    buffers.push(token); assert.equal(token.toString(), SEND_TOKEN);
    assert.equal(f.secrets.proof(token, f.binding.connectionRef, 'send'), createHmac('sha256', APP_SECRET).update(SEND_TOKEN).digest('hex'));
    assert.throws(() => f.secrets.proof(token, 'another', 'send'), { code: 'secret_unavailable' });
    assert.throws(() => f.secrets.proof(token, f.binding.connectionRef, 'read'), { code: 'secret_unavailable' });
    await f.secrets.withTemplateReader(f.binding, async reader => { buffers.push(reader); assert.equal(reader.toString(), READ_TOKEN); return {}; }); return {};
  });
  assert.equal(f.calls.filter(c => c.name === 'GetSecretValueCommand').length, 8);
  for (const token of buffers) { assert(token.every(byte => byte === 0)); assert.throws(() => f.secrets.proof(token, f.binding.connectionRef, 'send'), { code: 'secret_unavailable' }); }
});
const mutations = {
  scope: f => { f.values.get(f.binding.secretArn).scopes.push('ads_management'); },
  subject: f => { f.values.get(f.binding.secretArn).subjectId = '999'; },
  waba: f => { f.values.get(f.binding.secretArn).wabaId = '999'; },
  phone: f => { f.values.get(f.binding.secretArn).phoneId = '999'; },
  provider: f => { f.values.get(f.binding.secretArn).provider = 'meta'; },
  expired: f => { f.values.get(f.binding.secretArn).expiresAt = Date.now() - 1; },
  unboundedLocalExpiry: f => { f.binding.expiresAt = null; },
  alias: f => { f.binding.templateReaderSecretArn = f.binding.secretArn; },
  foreignArn: f => { f.binding.secretArn = f.binding.secretArn.replace('eu-west-3', 'us-east-1'); },
  appIdentity: f => { f.values.get(f.binding.clientSecretArn).appId = '999'; },
  kms: f => f.modify(v => ({ ...v, KmsKeyId: 'foreign' })),
  deleted: f => f.modify(v => ({ ...v, DeletedDate: new Date() })),
  returnedArn: f => f.modify(v => ({ ...v, ARN: 'foreign' })),
  version: f => f.modify((v, c) => c.constructor.name === 'GetSecretValueCommand' ? { ...v, VersionId: 'foreign' } : v),
  current: f => { f.pins.set(f.binding.secretArn, 'other'.repeat(8)); },
};
for (const [name, mutate] of Object.entries(mutations)) test('credential ' + name + ' mismatch never reaches provider callback', async t => {
  const f = fixture(t); mutate(f); let touched = false;
  await assert.rejects(f.secrets.withSecret(f.binding, async () => { touched = true; return {}; }),
    e => ['secret_unavailable', 'secret_version_changed', 'connection_blocked'].includes(e.code)); assert.equal(touched, false);
});
test('secret invalidation in flight wipes all roles immediately and rejects their results', async t => {
  const f = fixture(t); let buffer;
  await assert.rejects(f.secrets.withSecret(f.binding, async token => { buffer = token; f.secrets.invalidate(f.binding.connectionRef);
    assert(token.every(byte => byte === 0)); assert.throws(() => f.secrets.proof(token, f.binding.connectionRef, 'send'), { code: 'secret_unavailable' }); return {};
  }), { code: 'connection_blocked' }); assert(buffer.every(byte => byte === 0));
  f.secrets.close(); const before = f.calls.length;
  await assert.rejects(f.secrets.withSecret(f.binding, async () => ({})), { code: 'connection_blocked' }); assert.equal(f.calls.length, before);
});
test('rotation during callback rejects stale completion without reading a replacement', async t => {
  const f = fixture(t); let buffer;
  await assert.rejects(f.secrets.withSecret(f.binding, async token => { buffer = token; f.pins.set(f.binding.secretArn, 'new'.repeat(12)); return {}; }), { code: 'secret_version_changed' });
  assert(buffer.every(byte => byte === 0)); assert.equal(f.calls.filter(c => c.name === 'GetSecretValueCommand').length, 2);
});
test('secret-bearing output and raw AWS errors are redacted and wipe buffers', async t => {
  const f = fixture(t); let buffer;
  await assert.rejects(f.secrets.withSecret(f.binding, async token => { buffer = token; return { echo: SEND_TOKEN }; }), { code: 'provider_failed' });
  assert(buffer.every(byte => byte === 0)); f.modify(() => { throw Error(SEND_TOKEN); });
  await assert.rejects(f.secrets.withSecret(f.binding, async () => ({})), e => e.code === 'secret_unavailable' && !JSON.stringify(e).includes(SEND_TOKEN) && !e.message.includes(SEND_TOKEN));
});

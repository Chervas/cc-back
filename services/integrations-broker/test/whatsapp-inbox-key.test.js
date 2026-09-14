'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createInboxKeyProvider, PAYLOAD_KEY } = require('../src/whatsapp-inbox-key');
test('KMS manifest contains only wrapped key; startup decrypts the pinned key and same nonclinical context', async () => {
  const master = randomBytes(32); const copies = []; let generated;
  const provider = createInboxKeyProvider({ async send(command) {
    const i = command.input; assert.equal(i.KeyId, PAYLOAD_KEY);
    const plaintext = Buffer.from(master); copies.push(plaintext);
    if (command.constructor.name === 'GenerateDataKeyCommand') {
      generated = i; assert.equal(i.KeySpec, 'AES_256');
      return { KeyId: PAYLOAD_KEY, Plaintext: plaintext, CiphertextBlob: Buffer.from('FICTITIOUS_KMS_WRAPPED_KEY') };
    }
    assert.equal(command.constructor.name, 'DecryptCommand'); assert.deepEqual(i.EncryptionContext, generated.EncryptionContext);
    return { KeyId: PAYLOAD_KEY, Plaintext: plaintext, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' };
  } });
  const manifest = await provider.prepare('101');
  assert.equal(JSON.stringify(manifest).includes(master.toString('base64')), false);
  assert(copies[0].every(b => b === 0));
  const first = await provider.open(manifest, '101'); const raw = Buffer.from('SYNTHETIC_INBOX_PAYLOAD');
  const encrypted = first.seal(raw, 'scope'); first.close();
  const second = await provider.open(JSON.parse(JSON.stringify(manifest)), '101');
  assert(second.open(encrypted, 'scope').equals(raw)); second.close();
  assert(copies.every(v => v.every(b => b === 0))); master.fill(0);
});
test('foreign application, key replacement, corrupted wrapping and KMS denial have no fallback', async () => {
  let calls = 0;
  const provider = createInboxKeyProvider({ async send() { calls++; throw Error('FICTITIOUS_KMS_CREDENTIAL_ERROR'); } });
  const input = { version: 1, appId: '101', keyId: '00000000-0000-0000-0000-000000000001',
    kmsKeyArn: PAYLOAD_KEY, encryptedKey: Buffer.from('wrapped').toString('base64') };
  for (const change of [{ appId: '102' }, { kmsKeyArn: PAYLOAD_KEY.replace('be6f', 'be7f') }, { encryptedKey: '%' }, { plaintext: 'unacceptable' }]) {
    await assert.rejects(provider.open({ ...input, ...change }, '101'), { code: 'secret_unavailable' });
  }
  assert.equal(calls, 0);
  await assert.rejects(provider.open(input, '101'), e => e.code === 'secret_unavailable' && !e.stack.includes('FICTITIOUS_KMS_CREDENTIAL_ERROR'));
  assert.equal(calls, 1);
});

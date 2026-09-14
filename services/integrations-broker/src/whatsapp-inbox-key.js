'use strict';
const { randomUUID } = require('node:crypto');
const { GenerateDataKeyCommand, DecryptCommand } = require('@aws-sdk/client-kms');
const { fail } = require('./errors');
const { createInboxCipher } = require('./whatsapp-inbox');
const PAYLOAD_KEY = 'arn:aws:kms:eu-west-3:137819318729:key/be6f7b6d-db19-4f47-842d-71843bbc75f8';
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
function context(appId, keyId) {
  return { service: 'clinicaclick-whatsapp-inbox', environment: 'prod', appId, keyId };
}
function manifest(value, appId) {
  if (!value || Object.keys(value).sort().join(',') !== 'appId,encryptedKey,keyId,kmsKeyArn,version'
    || value.version !== 1 || value.appId !== appId || !id(appId) || value.kmsKeyArn !== PAYLOAD_KEY
    || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.keyId)
    || typeof value.encryptedKey !== 'string' || value.encryptedKey.length > 8192
    || Buffer.from(value.encryptedKey, 'base64').length < 1
    || Buffer.from(value.encryptedKey, 'base64').toString('base64') !== value.encryptedKey) fail('secret_unavailable');
  return value;
}
function createInboxKeyProvider(client) {
  if (typeof client?.send !== 'function') fail('invalid_request');
  return {
    // Explicit bootstrap only, before opening the inbox. The caller must persist
    // this encrypted manifest atomically and fsync it; startup never recreates a
    // lost key or resets an unreadable database.
    async prepare(appId) {
      if (!id(appId)) fail('invalid_request');
      const keyId = randomUUID(); let result;
      try {
        result = await client.send(new GenerateDataKeyCommand({ KeyId: PAYLOAD_KEY, KeySpec: 'AES_256',
          EncryptionContext: context(appId, keyId) }), { abortSignal: AbortSignal.timeout(8000) });
        if (result.KeyId !== PAYLOAD_KEY || !(result.Plaintext instanceof Uint8Array) || result.Plaintext.length !== 32
          || !(result.CiphertextBlob instanceof Uint8Array)) fail('secret_unavailable');
        return manifest({ version: 1, appId, keyId, kmsKeyArn: PAYLOAD_KEY,
          encryptedKey: Buffer.from(result.CiphertextBlob).toString('base64') }, appId);
      } catch { fail('secret_unavailable'); }
      finally { result?.Plaintext?.fill?.(0); }
    },
    async open(input, appId) {
      const value = manifest(input, appId); let result; let key;
      try {
        result = await client.send(new DecryptCommand({ KeyId: PAYLOAD_KEY, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          CiphertextBlob: Buffer.from(value.encryptedKey, 'base64'), EncryptionContext: context(appId, value.keyId) }),
        { abortSignal: AbortSignal.timeout(8000) });
        if (result.KeyId !== PAYLOAD_KEY || result.EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT'
          || !(result.Plaintext instanceof Uint8Array) || result.Plaintext.length !== 32) fail('secret_unavailable');
        key = Buffer.from(result.Plaintext);
        return createInboxCipher({ key, keyId: value.keyId });
      } catch { fail('secret_unavailable'); }
      finally { key?.fill(0); result?.Plaintext?.fill?.(0); }
    },
  };
}
module.exports = { PAYLOAD_KEY, createInboxKeyProvider, manifest };

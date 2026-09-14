'use strict';
const { createHash, createPublicKey, createPrivateKey, randomUUID, sign, verify } = require('node:crypto');
const { UUID } = require('./event');
const batch = require('./batch');
const AUDIENCE = 'clinicaclick-audit-writer-v1';
const PATH = '/v1/audit/write';
const MAX_BYTES = 250000;
const CODES = new Set(['audit_writer_invalid', 'audit_writer_denied', 'audit_writer_replayed', 'audit_writer_limited',
  'audit_writer_unavailable', 'audit_integrity_invalid', 'audit_identity_invalid', 'audit_configuration_invalid']);
function fail(code = 'audit_writer_invalid') { throw Object.assign(Error(code), { code }); }
const safe = error => CODES.has(error?.code) ? error.code : 'audit_writer_unavailable';
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function inputFor(value) {
  exact(value, ['version', 'audience', 'requestId', 'nonce', 'issuedAt', 'batch']);
  if (value.version !== 1 || value.audience !== AUDIENCE || typeof value.requestId !== 'string' || !UUID.test(value.requestId)
    || typeof value.nonce !== 'string' || !UUID.test(value.nonce) || !Number.isSafeInteger(value.issuedAt)) fail();
  try { batch.inputFor(value.batch); } catch { fail(); }
  return value;
}
const signedBytes = raw => Buffer.from(`${AUDIENCE}\nPOST\n${PATH}\n${createHash('sha256').update(raw).digest('hex')}`);
function signRequest(command, { keyId, privateKey, now = Date.now(), requestId = randomUUID() }) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519' || typeof keyId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(keyId)) fail();
  const input = inputFor({ version: 1, audience: AUDIENCE, requestId, nonce: randomUUID(), issuedAt: now, batch: command });
  const raw = Buffer.from(JSON.stringify(input)); if (raw.length > MAX_BYTES) fail();
  return { input, raw, headers: { 'content-type': 'application/json', 'content-length': raw.length,
    'x-audit-key-id': keyId, 'x-audit-signature': sign(null, signedBytes(raw), key).toString('base64url') } };
}
function authenticate(raw, headers, input, principals, now) {
  const principal = principals.find(value => value.enabled === true && value.keyId === headers['x-audit-key-id']);
  if (!principal || Math.abs(now - input.issuedAt) > 60000) fail('audit_writer_denied');
  try {
    const key = createPublicKey(principal.publicKey); const signature = headers['x-audit-signature'];
    if (key.asymmetricKeyType !== 'ed25519' || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)
      || !verify(null, signedBytes(raw), key, Buffer.from(signature, 'base64url'))) fail();
  } catch { fail('audit_writer_denied'); }
  return principal;
}
function resultFor(input, value) {
  inputFor(input); exact(value, ['version', 'requestId', 'batch']);
  if (value.version !== 1 || value.requestId !== input.requestId) fail();
  return { version: 1, requestId: input.requestId, batch: batch.resultFor(input.batch, value.batch) };
}
module.exports = { AUDIENCE, PATH, MAX_BYTES, fail, safe, inputFor, signRequest, authenticate, resultFor };

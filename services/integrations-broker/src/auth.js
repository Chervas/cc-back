'use strict';

const { createHash, createPublicKey, verify, sign, randomUUID } = require('node:crypto');
const { fail } = require('./errors');
const signedBytes = raw => Buffer.from(`clinicaclick-broker-v1\nPOST\n/v1/execute\n${createHash('sha256').update(raw).digest('hex')}`);
function authenticate(raw, headers, request, policy, now) {
  const principal = policy.principals.find(item => item.keyId === headers['x-broker-key-id'] && item.enabled === true);
  if (!principal || Math.abs(now - request.issuedAt) > 60000 || request.audience !== policy.audience) fail('invalid_signature');
  try {
    const key = createPublicKey(principal.publicKey);
    const encoded = headers['x-broker-signature'];
    if (key.asymmetricKeyType !== 'ed25519' || typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(encoded)
      || !verify(null, signedBytes(raw), key, Buffer.from(encoded, 'base64url'))) fail('invalid_signature');
  } catch { fail('invalid_signature'); }
  return principal;
}
function authorize(principal, request, policy) {
  const grant = policy.grants.find(item => item.principalId === principal.id
    && item.tenantRef === request.tenantRef && item.connectionRef === request.connectionRef
    && item.assetRef === request.assetRef && item.operations.includes(request.operation));
  if (!grant) fail('scope_denied');
  return grant;
}
function signRequest(command, { keyId, privateKey, audience, now = Date.now() }) {
  const request = { ...command, version: 1, audience, nonce: randomUUID(), issuedAt: now };
  const raw = Buffer.from(JSON.stringify(request));
  return { raw, headers: { 'content-type': 'application/json', 'x-broker-key-id': keyId,
    'x-broker-signature': sign(null, signedBytes(raw), privateKey).toString('base64url') } };
}
module.exports = { authenticate, authorize, signRequest };

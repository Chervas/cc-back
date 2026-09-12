'use strict';
const { createHash, createPublicKey, createPrivateKey, randomUUID, sign, verify } = require('node:crypto');
const { unpack, keyFor, receiptFor, UUID } = require('./event');
const AUDIENCE = 'clinicaclick-audit-reader-v1'; const PATH = '/v1/audit/read'; const MAX = 25;
const CODES = new Set(['audit_reader_unavailable', 'audit_integrity_invalid', 'audit_reader_denied', 'audit_reader_invalid', 'audit_reader_replayed', 'audit_reader_limited']);
function fail(code = 'audit_reader_invalid') { throw Object.assign(Error(code), { code }); }
const safe = error => CODES.has(error?.code) ? error.code : 'audit_reader_unavailable';
function exact(v, keys) { if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail(); }
function refFor(v, mode) {
  exact(v, ['key', 'digest', 'versionId']);
  const match = typeof v.key === 'string' && /^app\/platform\/v([1234])\/(20\d\d-\d\d-\d\d)\/([a-f0-9-]{36})-([a-f0-9]{64})\.json$/.exec(v.key);
  if (!match || !UUID.test(match[3]) || v.digest !== match[4] || !Number.isFinite(Date.parse(match[2] + 'T00:00:00Z'))
    || new Date(match[2] + 'T00:00:00Z').toISOString().slice(0, 10) !== match[2]) fail();
  if (mode === 'reconcile' ? v.versionId !== null : typeof v.versionId !== 'string' || !/^[A-Za-z0-9_.+/=-]{1,1024}$/.test(v.versionId) || v.versionId === 'null') fail();
  return { key: v.key, digest: v.digest, versionId: v.versionId };
}
function inputFor(v) {
  exact(v, ['version', 'audience', 'requestId', 'nonce', 'issuedAt', 'mode', 'actorId', 'sessionRef', 'refs']);
  if (v.version !== 1 || v.audience !== AUDIENCE || typeof v.requestId !== 'string' || typeof v.nonce !== 'string' || !UUID.test(v.requestId) || !UUID.test(v.nonce)
    || !Number.isSafeInteger(v.issuedAt) || !['confirmed', 'reconcile'].includes(v.mode)
    || !Array.isArray(v.refs) || v.refs.length < 1 || v.refs.length > MAX) fail();
  if (v.mode === 'confirmed' ? !['1', '44'].includes(v.actorId) || typeof v.sessionRef !== 'string' || !UUID.test(v.sessionRef)
    : v.actorId !== 'platform_audit_reconciler' || v.sessionRef !== null) fail('audit_reader_denied');
  const keys = new Set(); for (const ref of v.refs) { refFor(ref, v.mode); if (keys.has(ref.key)) fail(); keys.add(ref.key); }
  return v;
}
const signedBytes = raw => Buffer.from(`clinicaclick-audit-reader-v1\nPOST\n${PATH}\n${createHash('sha256').update(raw).digest('hex')}`);
function signRequest(command, { keyId, privateKey, now = Date.now() }) {
  const key = createPrivateKey(privateKey); if (key.asymmetricKeyType !== 'ed25519' || !/^[A-Za-z0-9_.-]{1,64}$/.test(keyId)) fail();
  const input = inputFor({ ...command, version: 1, audience: AUDIENCE, requestId: command.requestId || randomUUID(), nonce: randomUUID(), issuedAt: now });
  const raw = Buffer.from(JSON.stringify(input));
  return { input, raw, headers: { 'content-type': 'application/json', 'content-length': raw.length,
    'x-audit-key-id': keyId, 'x-audit-signature': sign(null, signedBytes(raw), key).toString('base64url') } };
}
function authenticate(raw, headers, input, principals, now) {
  const principal = principals.find(v => v.enabled === true && v.keyId === headers['x-audit-key-id']);
  if (!principal || Math.abs(now - input.issuedAt) > 60000 || !principal.modes.includes(input.mode)) fail('audit_reader_denied');
  try {
    const key = createPublicKey(principal.publicKey); const signature = headers['x-audit-signature'];
    if (key.asymmetricKeyType !== 'ed25519' || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)
      || !verify(null, signedBytes(raw), key, Buffer.from(signature, 'base64url'))) fail();
  } catch { fail('audit_reader_denied'); }
  return principal;
}
function resultFor(input, value) {
  inputFor(input); exact(value, ['version', 'requestId', 'mode', 'results']);
  if (value.version !== 1 || value.requestId !== input.requestId || value.mode !== input.mode || !Array.isArray(value.results)
    || value.results.length !== input.refs.length) fail();
  const results = value.results.map((v, i) => {
    const ref = input.refs[i];
    if (v?.status === 'error') {
      exact(v, ['status', 'key', 'digest', 'error']);
      if (v.key !== ref.key || v.digest !== ref.digest || !CODES.has(v.error)) fail(); return v;
    }
    exact(v, input.mode === 'confirmed' ? ['status', 'receipt', 'body'] : ['status', 'receipt']);
    exact(v.receipt, ['key', 'digest', 'versionId']);
    if (v.status !== 'verified' || v.receipt.key !== ref.key || v.receipt.digest !== ref.digest
      || typeof v.receipt.versionId !== 'string' || !/^[A-Za-z0-9_.+/=-]{1,1024}$/.test(v.receipt.versionId) || v.receipt.versionId === 'null'
      || input.mode === 'confirmed' && v.receipt.versionId !== ref.versionId) fail('audit_integrity_invalid');
    if (input.mode === 'confirmed') {
      const row = { body: v.body, digest: ref.digest }; unpack(row);
      receiptFor(row, v.receipt); if (keyFor(row) !== ref.key) fail('audit_integrity_invalid');
    }
    return { status: 'verified', receipt: { key: v.receipt.key, digest: v.receipt.digest, versionId: v.receipt.versionId },
      ...(input.mode === 'confirmed' ? { body: v.body } : {}) };
  });
  return { version: 1, requestId: input.requestId, mode: input.mode, results };
}
module.exports = { AUDIENCE, PATH, MAX, fail, safe, exact, refFor, inputFor, resultFor, signRequest, authenticate };

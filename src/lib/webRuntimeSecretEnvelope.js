'use strict';

const crypto = require('node:crypto');
const { bootstrapKey } = require('./webWordpressBootstrapTicket');

class WebRuntimeSecretEnvelopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebRuntimeSecretEnvelopeError';
    this.code = code;
    this.status = 503;
  }
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function keyId(env = process.env) {
  const defaultId = String(env.MARKETING_WEB_RUNTIME_ENVELOPE_KEY || '').trim()
    ? 'runtime-envelope-v1'
    : 'bootstrap-hkdf-v1';
  const value = String(env.MARKETING_WEB_RUNTIME_ENVELOPE_KEY_ID || defaultId).trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new WebRuntimeSecretEnvelopeError(
      'web_runtime_envelope_key_invalid',
      'El identificador de la clave de cifrado del runtime no es válido.'
    );
  }
  return value;
}

function keyBuffer(env = process.env) {
  const raw = String(env.MARKETING_WEB_RUNTIME_ENVELOPE_KEY || '').trim();
  if (raw) {
    let key = null;
    if (/^[a-f0-9]{64}$/i.test(raw)) {
      key = Buffer.from(raw, 'hex');
    } else if (/^[A-Za-z0-9_-]{43}=?$/.test(raw)) {
      const unpadded = raw.replace(/=$/u, '');
      const decoded = Buffer.from(unpadded, 'base64url');
      if (decoded.toString('base64url') === unpadded) key = decoded;
    } else if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.toString('base64') === raw) key = decoded;
    }
    if (key && key.length === 32) return key;
    throw new WebRuntimeSecretEnvelopeError(
      'web_runtime_envelope_key_invalid',
      'La clave dedicada de cifrado del runtime no es válida.'
    );
  }
  try {
    const bootstrapIkm = bootstrapKey(env);
    return Buffer.from(crypto.hkdfSync(
      'sha256',
      bootstrapIkm,
      Buffer.from('clinicaclick:web-intake-runtime-reconciliation:salt:v1', 'utf8'),
      Buffer.from('clinicaclick:web-intake-runtime-reconciliation:v1', 'utf8'),
      32
    ));
  } catch {
    throw new WebRuntimeSecretEnvelopeError(
      'web_runtime_envelope_key_missing',
      'Falta material de clave válido para cifrar el runtime web.'
    );
  }
}

function aad({ id, scopeType, scopeId, generation, slot }) {
  const normalizedId = String(id || '').trim().toLowerCase();
  const normalizedScope = ['clinic', 'group'].includes(scopeType) ? scopeType : null;
  const normalizedScopeId = positiveInteger(scopeId);
  const normalizedGeneration = positiveInteger(generation);
  const normalizedSlot = ['source', 'target'].includes(slot) ? slot : null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalizedId) || !normalizedScope || !normalizedScopeId || !normalizedGeneration || !normalizedSlot) {
    throw new WebRuntimeSecretEnvelopeError(
      'web_runtime_envelope_context_invalid',
      'El contexto de cifrado del runtime no es válido.'
    );
  }
  return Buffer.from(
    `clinicaclick:web-intake-runtime:v1:${normalizedId}:${normalizedScope}:${normalizedScopeId}:${normalizedGeneration}:${normalizedSlot}`,
    'utf8'
  );
}

function canonicalBase64(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buffer = Buffer.from(value, 'base64');
  if (bytes && buffer.length !== bytes) return null;
  return buffer.toString('base64') === value ? buffer : null;
}

function encryptRuntimeSecret(secret, context, { env = process.env } = {}) {
  if (secret === null || secret === undefined || secret === '') return null;
  const plaintext = String(secret);
  if (plaintext.length < 16 || plaintext.length > 512 || /[\x00-\x20\x7f]/.test(plaintext)) {
    throw new WebRuntimeSecretEnvelopeError(
      'web_runtime_envelope_secret_invalid',
      'El secreto del runtime no cumple el contrato de seguridad.'
    );
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(env), iv, { authTagLength: 16 });
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const envelope = {
    schema_version: 1,
    alg: 'A256GCM',
    key_id: keyId(env),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return JSON.stringify(envelope);
}

function decryptRuntimeSecret(serialized, context, { env = process.env } = {}) {
  if (serialized === null || serialized === undefined || serialized === '') return null;
  let envelope;
  try {
    envelope = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  } catch {
    throw new WebRuntimeSecretEnvelopeError(
      'web_runtime_envelope_invalid',
      'El envelope del runtime no es válido.'
    );
  }
  if (
    !envelope
    || typeof envelope !== 'object'
    || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(',') !== 'alg,ciphertext,iv,key_id,schema_version,tag'
    || envelope.schema_version !== 1
    || envelope.alg !== 'A256GCM'
    || typeof envelope.key_id !== 'string'
  ) {
    throw new WebRuntimeSecretEnvelopeError(
      'web_runtime_envelope_invalid',
      'El envelope del runtime no es válido.'
    );
  }
  const expectedKeyId = keyId(env);
  const key = keyBuffer(env);
  if (envelope.key_id !== expectedKeyId) {
    throw new WebRuntimeSecretEnvelopeError(
      'web_runtime_envelope_invalid',
      'El envelope del runtime no es válido.'
    );
  }
  const iv = canonicalBase64(envelope.iv, 12);
  const tag = canonicalBase64(envelope.tag, 16);
  const ciphertext = canonicalBase64(envelope.ciphertext);
  if (!iv || !tag || !ciphertext || ciphertext.length < 1 || ciphertext.length > 1024) {
    throw new WebRuntimeSecretEnvelopeError(
      'web_runtime_envelope_invalid',
      'El envelope del runtime no es válido.'
    );
  }
  const authenticatedContext = aad(context);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(authenticatedContext);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    if (plaintext.length < 16 || plaintext.length > 512 || /[\x00-\x20\x7f]/.test(plaintext)) throw new Error('invalid');
    return plaintext;
  } catch {
    throw new WebRuntimeSecretEnvelopeError(
      'web_runtime_envelope_decrypt_failed',
      'No se pudo autenticar el secreto cifrado del runtime.'
    );
  }
}

module.exports = {
  WebRuntimeSecretEnvelopeError,
  decryptRuntimeSecret,
  encryptRuntimeSecret,
};

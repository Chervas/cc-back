'use strict';

const crypto = require('crypto');

const KEY_ENV = 'EMAIL_DATA_ENCRYPTION_KEY';

function keyBuffer(env = process.env) {
  const raw = String(env[KEY_ENV] || '').trim();
  if (raw.length < 16) {
    const error = new Error('email_data_encryption_key_not_configured');
    error.code = 'email_data_encryption_key_not_configured';
    throw error;
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function aad(context) {
  const value = String(context || '').trim();
  if (!value) {
    const error = new Error('email_envelope_context_required');
    error.code = 'email_envelope_context_required';
    throw error;
  }
  return Buffer.from(`clinicaclick.email.v1:${value}`, 'utf8');
}

function encryptEmailValue(value, context, { env = process.env } = {}) {
  const plaintext = String(value || '').trim();
  if (!plaintext) {
    const error = new Error('email_envelope_plaintext_required');
    error.code = 'email_envelope_plaintext_required';
    throw error;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(env), iv, { authTagLength: 16 });
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({
    schema_version: 1,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

function decryptEmailValue(serialized, context, { env = process.env } = {}) {
  try {
    const envelope = JSON.parse(String(serialized || ''));
    if (
      envelope?.schema_version !== 1
      || envelope?.alg !== 'AES-256-GCM'
      || typeof envelope.iv !== 'string'
      || typeof envelope.tag !== 'string'
      || typeof envelope.ciphertext !== 'string'
    ) {
      throw new Error('invalid_email_envelope');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      keyBuffer(env),
      Buffer.from(envelope.iv, 'base64'),
      { authTagLength: 16 }
    );
    decipher.setAAD(aad(context));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    const wrapped = new Error('email_envelope_decrypt_failed');
    wrapped.code = 'email_envelope_decrypt_failed';
    wrapped.cause = error;
    throw wrapped;
  }
}

module.exports = {
  encryptEmailValue,
  decryptEmailValue,
};

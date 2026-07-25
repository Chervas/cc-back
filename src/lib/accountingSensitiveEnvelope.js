'use strict';

const crypto = require('crypto');

function secret() {
  const value = String(
    process.env.ACCOUNTING_DATA_ENCRYPTION_KEY
    || process.env.JWT_SECRET
    || process.env.JWT_KEY
    || ''
  ).trim();
  if (value.length < 16) {
    const error = new Error('accounting_encryption_key_not_configured');
    error.statusCode = 503;
    error.code = 'accounting_encryption_key_not_configured';
    throw error;
  }
  return crypto.createHash('sha256').update(value).digest();
}

function encrypt(value, context) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret(), iv);
  cipher.setAAD(Buffer.from(String(context), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  });
}

function decrypt(serialized, context) {
  try {
    const envelope = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
    if (envelope?.v !== 1) throw new Error('invalid_version');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      secret(),
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(String(context), 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    const error = new Error('accounting_envelope_decrypt_failed');
    error.statusCode = 500;
    error.code = 'accounting_envelope_decrypt_failed';
    error.cause = cause;
    throw error;
  }
}

module.exports = { encrypt, decrypt };

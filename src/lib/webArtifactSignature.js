'use strict';

const crypto = require('node:crypto');
const { canonicalSerialize } = require('./webDocument');

const SIGNATURE_ALGORITHM = 'Ed25519';
const SIGNATURE_VERSION = 1;

class WebArtifactSignatureError extends Error {
  constructor(code, message, status = 503, details = undefined) {
    super(message);
    this.name = 'WebArtifactSignatureError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function cleanPem(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function keyIdFromPublicKey(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `ed25519-${crypto.createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

function loadPrivateKey(value = process.env.MARKETING_WEB_SIGNING_PRIVATE_KEY_PEM) {
  const pem = cleanPem(value);
  if (!pem) {
    throw new WebArtifactSignatureError(
      'web_artifact_signing_key_missing',
      'Falta configurar la clave privada de firma de publicaciones web.'
    );
  }
  try {
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('unsupported_key_type');
    return key;
  } catch (cause) {
    throw new WebArtifactSignatureError(
      'web_artifact_signing_key_invalid',
      'La clave privada de publicación no es una clave Ed25519 válida.',
      503,
      { cause: String(cause?.message || cause) }
    );
  }
}

function loadPublicKey(value = process.env.MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM) {
  const pem = cleanPem(value);
  if (!pem) {
    throw new WebArtifactSignatureError(
      'web_artifact_verification_key_missing',
      'Falta configurar la clave pública de verificación de publicaciones web.'
    );
  }
  try {
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('unsupported_key_type');
    return key;
  } catch (cause) {
    throw new WebArtifactSignatureError(
      'web_artifact_verification_key_invalid',
      'La clave pública de publicación no es una clave Ed25519 válida.',
      503,
      { cause: String(cause?.message || cause) }
    );
  }
}

function signingPayload(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new WebArtifactSignatureError(
      'web_artifact_manifest_invalid',
      'El manifest que se quiere firmar no es válido.',
      422
    );
  }
  return Buffer.from(canonicalSerialize(manifest), 'utf8');
}

function signWebArtifactManifest(manifest, options = {}) {
  const privateKey = options.privateKey || loadPrivateKey(options.privateKeyPem);
  const publicKey = options.publicKey
    || (options.publicKeyPem ? loadPublicKey(options.publicKeyPem) : crypto.createPublicKey(privateKey));
  const payload = signingPayload(manifest);
  const signature = crypto.sign(null, payload, privateKey);
  return {
    signature_version: SIGNATURE_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    key_id: options.keyId || keyIdFromPublicKey(publicKey),
    manifest_sha256: crypto.createHash('sha256').update(payload).digest('hex'),
    signature: signature.toString('base64'),
  };
}

function verifyWebArtifactManifest(manifest, envelope, options = {}) {
  if (
    !envelope
    || Number(envelope.signature_version) !== SIGNATURE_VERSION
    || envelope.algorithm !== SIGNATURE_ALGORITHM
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(String(envelope.signature || ''))
  ) {
    return false;
  }
  const publicKey = options.publicKey || loadPublicKey(options.publicKeyPem);
  const payload = signingPayload(manifest);
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  if (digest !== envelope.manifest_sha256) return false;
  if (envelope.key_id && envelope.key_id !== (options.keyId || keyIdFromPublicKey(publicKey))) return false;
  try {
    return crypto.verify(null, payload, publicKey, Buffer.from(envelope.signature, 'base64'));
  } catch {
    return false;
  }
}

function publicVerificationKeyDescriptor(options = {}) {
  const publicKey = options.publicKey || loadPublicKey(options.publicKeyPem);
  return {
    signature_version: SIGNATURE_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    key_id: options.keyId || keyIdFromPublicKey(publicKey),
    public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

module.exports = {
  SIGNATURE_ALGORITHM,
  SIGNATURE_VERSION,
  WebArtifactSignatureError,
  keyIdFromPublicKey,
  loadPrivateKey,
  loadPublicKey,
  publicVerificationKeyDescriptor,
  signWebArtifactManifest,
  signingPayload,
  verifyWebArtifactManifest,
};

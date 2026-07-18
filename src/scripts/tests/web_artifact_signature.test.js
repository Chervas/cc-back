'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  keyIdFromPublicKey,
  publicVerificationKeyDescriptor,
  signWebArtifactManifest,
  verifyWebArtifactManifest,
} = require('../../lib/webArtifactSignature');

function keys() {
  return crypto.generateKeyPairSync('ed25519');
}

test('firma y verifica un manifest canónico con Ed25519', () => {
  const { privateKey, publicKey } = keys();
  const manifest = { artifact_hash: 'a'.repeat(64), files: { 'index.html': { size_bytes: 12 } } };
  const envelope = signWebArtifactManifest(manifest, { privateKey, publicKey });
  assert.equal(envelope.algorithm, 'Ed25519');
  assert.equal(envelope.key_id, keyIdFromPublicKey(publicKey));
  assert.equal(verifyWebArtifactManifest(manifest, envelope, { publicKey }), true);
});

test('la firma es determinista y no depende del orden de claves', () => {
  const { privateKey, publicKey } = keys();
  const a = { z: 1, files: { b: 2, a: 1 } };
  const b = { files: { a: 1, b: 2 }, z: 1 };
  assert.deepEqual(
    signWebArtifactManifest(a, { privateKey, publicKey }),
    signWebArtifactManifest(b, { privateKey, publicKey })
  );
});

test('rechaza manifest o envelope alterados y clave distinta', () => {
  const first = keys();
  const second = keys();
  const manifest = { artifact_hash: 'b'.repeat(64), files: {} };
  const envelope = signWebArtifactManifest(manifest, first);
  assert.equal(verifyWebArtifactManifest({ ...manifest, environment: 'production' }, envelope, {
    publicKey: first.publicKey,
  }), false);
  assert.equal(verifyWebArtifactManifest(manifest, { ...envelope, signature: 'AAAA' }, {
    publicKey: first.publicKey,
  }), false);
  assert.equal(verifyWebArtifactManifest(manifest, envelope, { publicKey: second.publicKey }), false);
});

test('descriptor público nunca expone la clave privada', () => {
  const { publicKey } = keys();
  const descriptor = publicVerificationKeyDescriptor({ publicKey });
  assert.match(descriptor.public_key_pem, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(descriptor.public_key_pem, /PRIVATE/);
});

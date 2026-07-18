'use strict';

const crypto = require('node:crypto');
const {
  publicVerificationKeyDescriptor,
  signWebArtifactManifest,
} = require('../../../src/lib/webArtifactSignature');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const descriptor = publicVerificationKeyDescriptor({ publicKeyPem });
const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
const prefix = Buffer.from('302a300506032b6570032100', 'hex');

const manifest = {
  schema_version: 1,
  renderer_version: 'clinicaclick-web-renderer/1.0.0',
  environment: 'production',
  artifact_hash: 'a'.repeat(64),
  page_routes: {
    '33333333-3333-4333-8333-333333333333': { page_path: '/' },
  },
  files: {
    'index.html': {
      sha256: 'b'.repeat(64),
      content_type: 'text/html; charset=utf-8',
      size_bytes: 12,
    },
  },
  headers: {
    'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'sha256-example'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  },
};
const runtime = {
  schema_version: 1,
  installation_id: 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44',
  sequence: 1,
  status: 'active',
  route_prefix: '/cita',
  desired_artifact_hash: manifest.artifact_hash,
  measurement: {
    enabled: true,
    scope_type: 'clinic',
    scope_id: 56,
    loader_path: '/assets/loader.js',
    hmac_key: '0123456789abcdef0123456789abcdef',
    consent_mode_enabled: true,
    consent_provider: 'external_cmp',
  },
};
const signingOptions = { privateKeyPem, publicKeyPem };

process.stdout.write(JSON.stringify({
  descriptor: {
    schema_version: 1,
    algorithm: descriptor.algorithm,
    key_id: descriptor.key_id,
    public_key_base64: der.subarray(prefix.length).toString('base64'),
  },
  manifest,
  manifest_envelope: signWebArtifactManifest(manifest, signingOptions),
  runtime,
  runtime_envelope: signWebArtifactManifest(runtime, signingOptions),
}));

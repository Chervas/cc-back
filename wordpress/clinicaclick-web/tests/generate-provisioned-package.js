'use strict';

const crypto = require('node:crypto');

// Loading the legacy Sequelize registry announces every model on stdout. This
// process must emit only the ZIP bytes consumed by the PHP activation harness.
const originalLog = console.log;
console.log = () => {};
const {
  buildProvisionedPluginPackage,
} = require('../../../src/services/webWordpressPluginPackage.service');
console.log = originalLog;

const {
  publicVerificationKeyDescriptor,
  signWebArtifactManifest,
} = require('../../../src/lib/webArtifactSignature');

const installationId = 'd6d6d9bb-493e-4a40-8465-5ebf9edcde44';
const token = `ccw_${'a'.repeat(43)}`;
const siteClaimToken = 's'.repeat(43);
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const publicDescriptor = publicVerificationKeyDescriptor({ publicKeyPem });
const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

if (der.length !== spkiPrefix.length + 32 || !der.subarray(0, spkiPrefix.length).equals(spkiPrefix)) {
  throw new Error('Generated Ed25519 key is not compatible with the plugin trust descriptor');
}

const runtime = {
  schema_version: 1,
  installation_id: installationId,
  sequence: 7,
  status: 'active',
  route_prefix: '/cita',
  desired_artifact_hash: 'b'.repeat(64),
  measurement: {
    enabled: true,
    scope_type: 'clinic',
    scope_id: 66,
    loader_path: '/assets/loader.js',
    hmac_key: '0123456789abcdef0123456789abcdef',
    consent_mode_enabled: true,
    consent_provider: 'clinicaclick',
  },
};
const signingOptions = { privateKeyPem, publicKeyPem };
const credentials = {
  installation_id: installationId,
  api_base: 'https://crm.clinicaclick.com',
  token,
  site_claim_token: siteClaimToken,
  trust_descriptor: {
    schema_version: 1,
    algorithm: publicDescriptor.algorithm,
    key_id: publicDescriptor.key_id,
    public_key_base64: der.subarray(spkiPrefix.length).toString('base64'),
  },
  bootstrap_runtime_configuration: runtime,
  bootstrap_runtime_envelope: signWebArtifactManifest(runtime, signingOptions),
};

buildProvisionedPluginPackage({ credentials })
  .then((result) => {
    // Guard the server-side packaging boundary before handing the archive to
    // PHP. Only public material and the per-installation opaque token belong
    // in the package; the Ed25519 private key never does.
    if (result.buffer.includes(Buffer.from(privateKeyPem, 'utf8'))) {
      throw new Error('Provisioned package leaked the Ed25519 private key');
    }
    process.stdout.write(result.buffer);
  })
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });

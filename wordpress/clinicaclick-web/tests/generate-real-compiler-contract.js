'use strict';

// The service imports the Sequelize model registry, which announces loaded
// models on stdout in this legacy app. Keep the pipe machine-readable without
// changing application logging.
const originalLog = console.log;
console.log = () => {};
const { createBlankWebDocument } = require('../../../src/services/webProjects.service');
console.log = originalLog;
const { compileWebArtifact } = require('../../../src/lib/webArtifactCompiler');

const installationId = 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44';
const hmacKey = '0123456789abcdef0123456789abcdef';
const document = createBlankWebDocument({ name: 'Implantes dentales', locale: 'es-ES' });
document.consent = {
  provider: 'clinicaclick',
  preview_mode: false,
  privacy_policy_url: 'https://cliente.example.test/privacidad/',
  privacy_policy_version: '2026-07',
  privacy_consent_text: 'Acepto la política de privacidad.',
};
document.integrations.intake_config_id = '12';
const artifact = compileWebArtifact({
  document,
  contentSnapshot: {
    schema_version: 1,
    content_entries: {},
    media_assets: {},
    live_bindings: [],
    intake_config: { id: '12', scope: { type: 'clinic', id: 66, inherited: false } },
  },
  project: {
    id: '9ed2cc0a-31a8-4469-990a-22b279ac81ca',
    name: 'Landing implantes',
    locale: 'es-ES',
  },
  revisionId: '35b08398-0d39-4ca8-b100-7bc9db5c66c0',
  baseUrl: 'https://cliente.example.test/cita',
  environment: 'production',
  clinicSnapshot: {
    clinic_id: 66,
    schema_type: 'Dentist',
    name: 'Clínica Dental Centro',
    address: 'Carrer de la Salut 1, Barcelona',
    phone: '+34930000000',
    website: 'https://cliente.example.test/',
  },
  intakeEndpoint: '/_clinicaclick/intake',
  trustedRuntime: {
    measurement: {
      enabled: true,
      scope_type: 'clinic',
      scope_id: 66,
      api_url: 'https://api.example.test',
      loader_path: '/assets/loader.js',
      hmac_key: hmacKey,
      consent_mode_enabled: true,
      consent_provider: 'clinicaclick',
    },
  },
});

const runtime = {
  schema_version: 1,
  installation_id: installationId,
  sequence: 1,
  status: 'active',
  route_prefix: '/cita',
  desired_artifact_hash: artifact.artifact_hash,
  measurement: {
    enabled: true,
    scope_type: 'clinic',
    scope_id: 66,
    loader_path: '/assets/loader.js',
    hmac_key: hmacKey,
    consent_mode_enabled: true,
    consent_provider: 'clinicaclick',
  },
};

process.stdout.write(JSON.stringify({ artifact, runtime }));

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Op } = require('sequelize');
const {
  PUBLIC_WEB_ARTIFACT_METADATA_ATTRIBUTES,
} = require('../../services/webArtifactMetadata.service');
const {
  runtimeConfigFromArtifactHeader,
} = require('../../services/webArtifactRuntimeHeader.service');
const {
  runtimeHashForRecord,
} = require('../../services/webIntakeRuntimeReconciliation.service');

const IDS = {
  project: '11111111-1111-4111-8111-111111111111',
  revision: '22222222-2222-4222-8222-222222222222',
  publication: '55555555-5555-4555-8555-555555555555',
  artifact: '66666666-6666-4666-8666-666666666666',
};
const ARTIFACT_HASH = 'a'.repeat(64);

function fixture({ cached = false } = {}) {
  const intake = {
    assignment_scope: 'clinic',
    clinic_id: 66,
    hmac_key: '0123456789abcdef0123456789abcdef',
    config: {},
  };
  const runtimeConfigHash = runtimeHashForRecord(intake);
  const artifact = {
    id: IDS.artifact,
    projectId: IDS.project,
    revisionId: IDS.revision,
    environment: 'production',
    status: 'ready',
    artifactHash: ARTIFACT_HASH,
    runtimeConfigHash,
    manifest: {
      project_id: IDS.project,
      revision_id: IDS.revision,
      environment: 'production',
      artifact_hash: ARTIFACT_HASH,
      artifact_input_hash: 'b'.repeat(64),
      runtime_config_hash: runtimeConfigHash,
    },
  };
  Object.defineProperties(artifact, {
    files: { get() { throw new Error('files no debe leerse'); } },
    qaReport: { get() { throw new Error('qaReport no debe leerse'); } },
  });
  const publication = {
    id: IDS.publication,
    projectId: IDS.project,
    activeRevisionId: IDS.revision,
    activeArtifactId: IDS.artifact,
    scopeType: 'clinic',
    clinicaId: 66,
    channel: 'clinicaclick_hosted',
    host: 'landing.example.test',
    path: '/cita/',
    status: 'published',
  };
  let artifactReads = 0;
  const models = {
    Sequelize: { Op },
    WebArtifact: {
      async findOne(options) {
        artifactReads += 1;
        assert.deepEqual(options.attributes, [...PUBLIC_WEB_ARTIFACT_METADATA_ATTRIBUTES]);
        assert.equal(options.raw, true);
        assert.deepEqual(options.where, { artifactHash: ARTIFACT_HASH });
        return artifact;
      },
    },
    WebPublication: { findAll: async () => [publication] },
  };
  const req = {
    body: {
      external_source: 'clinicaclick_web_landing',
      web_form_id: 'form-123',
      page_url: 'https://landing.example.test/cita/',
    },
    headers: { 'x-clinicaclick-web-artifact': ARTIFACT_HASH },
    ...(cached ? { webLandingArtifactMetadata: artifact } : {}),
  };
  return { artifactReads: () => artifactReads, intake, models, req };
}

test('el header runtime consulta por hash con proyección metadata-only', async () => {
  const state = fixture();
  const result = await runtimeConfigFromArtifactHeader(state.req, [state.intake], { models: state.models });
  assert.equal(result.present, true);
  assert.equal(result.config.hmac_key, state.intake.hmac_key);
  assert.equal(state.artifactReads(), 1);
});

test('el header runtime reutiliza el artefacto ya validado por form/event prepare', async () => {
  const state = fixture({ cached: true });
  state.models.WebArtifact.findOne = async () => {
    throw new Error('no debe repetir la consulta de WebArtifact');
  };
  const result = await runtimeConfigFromArtifactHeader(state.req, [state.intake], { models: state.models });
  assert.equal(result.present, true);
  assert.equal(result.config.hmac_key, state.intake.hmac_key);
  assert.equal(state.artifactReads(), 0);
});

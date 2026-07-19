'use strict';

const assert = require('node:assert/strict');
const { Sequelize, DataTypes } = require('sequelize');

async function main() {
  const sequelize = new Sequelize('mysql://test:test@127.0.0.1:3306/clinicaclick_contract_test', { logging: false });
  try {
    const models = {
      WebProject: sequelize.define('WebProject', { id: { type: DataTypes.STRING(36), primaryKey: true } }),
      WebRevision: sequelize.define('WebRevision', { id: { type: DataTypes.STRING(36), primaryKey: true } }),
      Usuario: sequelize.define('Usuario', { id_usuario: { type: DataTypes.INTEGER, primaryKey: true } }),
    };
    models.WebArtifact = require('../../../models/webartifact')(sequelize, DataTypes);
    models.WebArtifact.associate(models);
    const artifact = models.WebArtifact.build({
      id: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      revisionId: '33333333-3333-4333-8333-333333333333',
      rendererVersion: 'clinicaclick-web-renderer/1.1.0',
      environment: 'preview',
      baseUrl: 'https://preview.sites.clinicaclick.com',
      baseUrlHash: 'a'.repeat(64),
      runtimeConfigHash: 'e'.repeat(64),
      artifactHash: 'b'.repeat(64),
      documentHash: 'c'.repeat(64),
      contentSnapshotHash: 'd'.repeat(64),
      clinicSnapshotHash: 'f'.repeat(64),
      manifest: { schema_version: 1 },
      files: { 'index.html': '<!doctype html>' },
      qaReport: { deterministic: true },
      status: 'ready',
    });
    await artifact.validate();
    assert.ok(models.WebArtifact.associations.project);
    assert.ok(models.WebArtifact.associations.revision);
    artifact.set('manifest', { schema_version: 2 });
    await assert.rejects(
      () => models.WebArtifact.runHooks('beforeUpdate', artifact, {}),
      (error) => error.code === 'WEB_ARTIFACT_IMMUTABLE'
    );
    await assert.rejects(
      () => models.WebArtifact.runHooks('beforeBulkUpdate', { fields: ['manifest'] }),
      (error) => error.code === 'WEB_ARTIFACT_IMMUTABLE'
    );
    await assert.doesNotReject(
      () => models.WebArtifact.runHooks('beforeBulkUpdate', { fields: ['status'] })
    );
  } finally {
    await sequelize.close();
  }
  console.log('web artifact model contract: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

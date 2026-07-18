'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  authenticateInstallation,
  getAuthenticatedArtifactResource,
  getDesiredState,
  matchReportedSite,
  measurementFromIntake,
  normalizeReport,
  recordReport,
  safeImmutableStorage,
  tokenHash,
} = require('../../services/webWordpressInstallations.service');
const { authenticatedDbStorageDescriptor, pathToken } = require('../../services/webArtifactStorage.service');
const { verifyWebArtifactManifest } = require('../../lib/webArtifactSignature');

function row(value) {
  return {
    ...value,
    get() { return { ...this }; },
    async update(patch) { Object.assign(this, patch); return this; },
  };
}

function signingOptions() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

test('autenticación liga token, instalación y major compatible', async () => {
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const installation = row({
    id: 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44',
    tokenHash: tokenHash(token),
    status: 'connected',
  });
  const models = { WebWordpressInstallation: { async findOne() { return installation; } } };
  const authenticated = await authenticateInstallation({
    installationId: installation.id,
    headers: { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.1' },
    models,
  });
  assert.equal(authenticated.id, installation.id);
  await assert.rejects(
    authenticateInstallation({
      installationId: 'a6d6d9bb-093e-4a40-8465-5ebf9edcde44',
      headers: { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.1' },
      models,
    }),
    (error) => error.code === 'web_installation_unauthorized'
  );
  await assert.rejects(
    authenticateInstallation({
      installationId: installation.id,
      headers: { authorization: `Bearer ${token}`, pluginVersion: '1.1.7' },
      models,
    }),
    (error) => error.code === 'web_installation_plugin_version_unsupported'
  );
});

test('la medición solo se activa con scope e HMAC válidos', () => {
  assert.deepEqual(measurementFromIntake(null), { enabled: false });
  assert.deepEqual(measurementFromIntake({ assignment_scope: 'clinic', clinic_id: 56, hmac_key: 'short' }), { enabled: false });
  assert.deepEqual(measurementFromIntake({
    assignment_scope: 'group',
    group_id: 3,
    hmac_key: '0123456789abcdef0123456789abcdef',
    config: { features: { consent_mode_enabled: true, consent_provider: 'clinicaclick' } },
  }), {
    enabled: true,
    scope_type: 'group',
    scope_id: 3,
    loader_path: '/assets/loader.js',
    hmac_key: '0123456789abcdef0123456789abcdef',
    consent_mode_enabled: true,
    consent_provider: 'clinicaclick',
    chat_enabled: false,
    whatsapp_enabled: false,
    phone_enabled: false,
  });
});

test('el contrato de reporte rechaza campos desconocidos o sensibles', () => {
  const base = {
    schema_version: 1,
    event: 'heartbeat',
    plugin_version: '2.0.0-alpha.1',
    site_hash: 'a'.repeat(64),
    reported_at: new Date().toISOString(),
  };
  assert.equal(normalizeReport(base).event, 'heartbeat');
  assert.throws(
    () => normalizeReport({ ...base, hmac_key: 'no' }),
    (error) => error.code === 'web_installation_report_invalid'
  );
  assert.throws(
    () => normalizeReport({ ...base, result: 'patient_email' }),
    (error) => error.code === 'web_installation_report_sensitive_data_forbidden'
  );
});

test('el primer handshake canonicaliza de forma auditada el alias www del mismo WordPress', async () => {
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const installation = row({
    id: '9f2b6f84-0180-4dfa-a993-3652a87ae23c',
    scopeType: 'clinic',
    clinicaId: 59,
    grupoClinicaId: null,
    siteUrl: 'https://propdental.example',
    siteUrlHash: crypto.createHash('sha256').update('https://propdental.example').digest('hex'),
    tokenHash: tokenHash(token),
    tokenPrefix: token.slice(0, 12),
    status: 'pending',
    pluginVersion: null,
    lastSeenAt: null,
    version: 1,
  });
  const audits = [];
  const models = {
    WebWordpressInstallation: {
      async findOne() { return installation; },
      async findByPk() { return installation; },
    },
    WebPublication: {
      async findAll() { return []; },
      async count() { return 0; },
    },
    WebAuditEvent: { async create(value) { audits.push(value); } },
  };
  const sequelize = {
    async transaction(callback) { return callback({ LOCK: { UPDATE: 'UPDATE' } }); },
  };
  const pluginVersion = '2.0.0-alpha.4';
  const result = await recordReport({
    installationId: installation.id,
    headers: { authorization: `Bearer ${token}`, pluginVersion },
    body: {
      schema_version: 1,
      event: 'heartbeat',
      plugin_version: pluginVersion,
      wordpress_version: '6.8.3',
      php_version: '8.0.30',
      site_hash: crypto.createHash('sha256').update('https://www.propdental.example/').digest('hex'),
      status: 'empty',
      result: 'activation_handshake',
      duration_ms: 0,
      reported_at: new Date().toISOString(),
    },
    requestId: 'req-first-www-handshake',
    models,
    sequelize,
  });
  assert.equal(result.accepted, true);
  assert.equal(installation.status, 'connected');
  assert.equal(installation.siteUrl, 'https://www.propdental.example');
  assert.equal(
    installation.siteUrlHash,
    crypto.createHash('sha256').update(installation.siteUrl).digest('hex')
  );
  assert.equal(installation.version, 2);
  assert.deepEqual(
    audits.map((audit) => audit.eventType),
    ['web.wordpress_installation.site_canonicalized', 'web.wordpress_installation.heartbeat']
  );
  assert.equal(audits[0].metadata.reason, 'first_handshake_www_alias');
  assert.equal(Object.values(audits[0].metadata).includes(installation.siteUrl), false);
});

test('el alias www no relaja la identidad de una instalación conectada o rotada', async () => {
  const reportHash = crypto.createHash('sha256').update('https://www.cliente.example/').digest('hex');
  assert.equal(matchReportedSite('https://cliente.example', reportHash), null);
  assert.equal(
    matchReportedSite('https://cliente.example', reportHash, { includeWwwAlias: true }).site_url,
    'https://www.cliente.example'
  );

  for (const state of [
    { status: 'connected', pluginVersion: '2.0.0-alpha.4', lastSeenAt: new Date() },
    { status: 'pending', pluginVersion: '2.0.0-alpha.4', lastSeenAt: new Date() },
  ]) {
    const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
    const installation = row({
      id: crypto.randomUUID(),
      scopeType: 'clinic',
      clinicaId: 59,
      grupoClinicaId: null,
      siteUrl: 'https://cliente.example',
      tokenHash: tokenHash(token),
      ...state,
    });
    const models = {
      WebWordpressInstallation: { async findOne() { return installation; } },
    };
    await assert.rejects(
      () => recordReport({
        installationId: installation.id,
        headers: { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.4' },
        body: {
          schema_version: 1,
          event: 'heartbeat',
          plugin_version: '2.0.0-alpha.4',
          site_hash: reportHash,
          status: 'empty',
          reported_at: new Date().toISOString(),
        },
        models,
      }),
      (error) => error.code === 'web_installation_site_mismatch' && error.status === 409
    );
  }
});

test('el estado deseado es firmado, estable y avanza secuencia solo al cambiar', async () => {
  const keys = signingOptions();
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const artifactHash = 'a'.repeat(64);
  const artifact = row({
    id: 'artifact-1',
    projectId: 'project-1',
    environment: 'production',
    artifactHash,
    manifest: {
      schema_version: 1,
      environment: 'production',
      artifact_hash: artifactHash,
      files: { 'index.html': { sha256: 'b'.repeat(64), size_bytes: 12, content_type: 'text/html; charset=utf-8' } },
    },
  });
  const installation = row({
    id: 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44',
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    tokenHash: tokenHash(token),
    status: 'connected',
    desiredSequence: 0,
    desiredStateHash: null,
    publicKeyId: null,
  });
  const descriptorService = require('../../services/webWordpressInstallations.service').pluginKeyDescriptor(keys);
  installation.publicKeyId = descriptorService.key_id;
  const publication = row({
    id: 'publication-1', projectId: 'project-1', wordpressInstallationId: installation.id,
    status: 'publishing', activeArtifactId: null,
  });
  const deployment = row({
    id: 'deployment-1', publicationId: publication.id, artifactId: artifact.id,
    status: 'running', sequence: 1,
    storage: {
      provider: 's3_immutable', artifact_hash: artifactHash,
      manifest_url: `https://assets.example.test/${artifactHash}/manifest.json`,
      signature_url: `https://assets.example.test/${artifactHash}/manifest.sig.json`,
      files: { 'index.html': `https://assets.example.test/${artifactHash}/index.html` },
    },
  });
  const intake = {
    assignment_scope: 'clinic', clinic_id: 56,
    hmac_key: '0123456789abcdef0123456789abcdef',
    config: { features: { consent_mode_enabled: true, consent_provider: 'external_cmp' } },
  };
  const models = {
    WebWordpressInstallation: {
      async findOne() { return installation; },
      async findByPk() { return installation; },
    },
    WebPublication: { async findAll() { return [publication]; } },
    WebPublicationDeployment: { async findOne() { return deployment; } },
    WebArtifact: { async findByPk() { return artifact; } },
    IntakeConfig: { async findOne() { return intake; } },
    Clinica: { async findByPk() { return null; } },
  };
  const sequelize = { async transaction(callback) { return callback({ LOCK: { UPDATE: 'UPDATE' } }); } };
  const headers = { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.1' };
  const first = await getDesiredState({
    installationId: installation.id, headers, requestId: 'req-test-0001', models, sequelize, signingOptions: keys,
  });
  const second = await getDesiredState({
    installationId: installation.id, headers, requestId: 'req-test-0002', models, sequelize, signingOptions: keys,
  });
  assert.equal(first.response.desired_state.status, 'published');
  assert.equal(first.response.desired_state.runtime_configuration.sequence, 1);
  assert.equal(second.response.desired_state.runtime_configuration.sequence, 1);
  assert.equal(first.etag, second.etag);
  assert.match(first.response.desired_state.runtime_configuration_envelope.signature, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(first.response.desired_state.runtime_configuration.measurement.scope_id, 56);
  assert.deepEqual(Object.keys(first.response.desired_state.files), ['index.html']);
});

test('un primer despliegue WordPress fallido termina en retirada firmada y conserva la caché local', async () => {
  const keys = signingOptions();
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const installation = row({
    id: 'a5c41e3a-ece4-42d4-924a-4a5f1bd59b9c',
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    tokenHash: tokenHash(token),
    status: 'connected',
    desiredSequence: 3,
    desiredStateHash: null,
    publicKeyId: null,
  });
  const descriptor = require('../../services/webWordpressInstallations.service').pluginKeyDescriptor(keys);
  installation.publicKeyId = descriptor.key_id;
  const publication = row({
    id: 'failed-publication-1',
    projectId: 'project-1',
    wordpressInstallationId: installation.id,
    status: 'failed',
    activeArtifactId: null,
    lastGoodArtifactId: null,
  });
  const models = {
    WebWordpressInstallation: {
      async findOne() { return installation; },
      async findByPk() { return installation; },
    },
    WebPublication: { async findAll() { return [publication]; } },
    WebPublicationDeployment: {
      async findOne() {
        assert.fail('una primera publicación fallida no debe volver a ofrecer el artefacto sin verificar');
      },
    },
    WebArtifact: {
      async findByPk() {
        assert.fail('una primera publicación fallida no debe cargar el artefacto sin verificar');
      },
    },
    IntakeConfig: { async findOne() { return null; } },
    Clinica: { async findByPk() { return null; } },
  };
  const sequelize = {
    async transaction(callback) { return callback({ LOCK: { UPDATE: 'UPDATE' } }); },
  };
  const result = await getDesiredState({
    installationId: installation.id,
    headers: { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.1' },
    requestId: 'req-failed-first-publication',
    models,
    sequelize,
    signingOptions: keys,
  });
  const desired = result.response.desired_state;
  assert.equal(desired.status, 'retired');
  assert.equal(desired.artifact_hash, undefined);
  assert.equal(desired.runtime_configuration.status, 'retired');
  assert.equal(desired.runtime_configuration.desired_artifact_hash, null);
  assert.equal(desired.runtime_configuration.sequence, 4);
  assert.equal(
    verifyWebArtifactManifest(
      desired.runtime_configuration,
      desired.runtime_configuration_envelope,
      keys
    ),
    true
  );
});

test('el bundle descargable exige mismo origen y set exacto del manifest', () => {
  const hash = 'a'.repeat(64);
  const artifact = { artifactHash: hash, manifest: { artifact_hash: hash, files: { 'index.html': {} } } };
  assert.throws(() => safeImmutableStorage({
    provider: 's3_immutable', artifact_hash: hash,
    manifest_url: 'https://one.example/manifest.json',
    signature_url: 'https://two.example/manifest.sig.json',
    files: { 'index.html': 'https://one.example/index.html' },
  }, artifact), (error) => error.code === 'web_installation_artifact_origin_mismatch');
});

test('fallback autenticado sirve solo el artefacto deseado de esa instalación', async () => {
  const keys = signingOptions();
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const body = '<!doctype html><title>Landing</title>';
  const fileHash = crypto.createHash('sha256').update(body).digest('hex');
  const artifactHash = 'd'.repeat(64);
  const artifact = row({
    id: 'artifact-db-1',
    projectId: 'project-db-1',
    environment: 'production',
    artifactHash,
    manifest: {
      schema_version: 1,
      environment: 'production',
      artifact_hash: artifactHash,
      files: {
        'index.html': {
          sha256: fileHash,
          size_bytes: Buffer.byteLength(body),
          content_type: 'text/html; charset=utf-8',
        },
      },
    },
    files: { 'index.html': body },
  });
  const installation = row({
    id: 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44',
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    tokenHash: tokenHash(token),
    status: 'connected',
  });
  const env = { MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com' };
  const publication = row({
    id: 'publication-db-1', projectId: artifact.projectId,
    wordpressInstallationId: installation.id, status: 'publishing', activeArtifactId: null,
  });
  const deployment = row({
    id: 'deployment-db-1', publicationId: publication.id, artifactId: artifact.id,
    status: 'running', sequence: 1,
    storage: authenticatedDbStorageDescriptor({ artifact, installationId: installation.id, env }),
  });
  const models = {
    WebWordpressInstallation: { async findOne() { return installation; } },
    WebPublication: { async findAll() { return [publication]; } },
    WebPublicationDeployment: { async findOne() { return deployment; } },
    WebArtifact: { async findByPk() { return artifact; } },
  };
  const common = {
    installationId: installation.id,
    artifactHash,
    headers: { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.1' },
    models,
    signingOptions: keys,
    env,
  };
  const manifest = await getAuthenticatedArtifactResource({ ...common, resource: 'manifest' });
  const envelope = await getAuthenticatedArtifactResource({ ...common, resource: 'envelope' });
  const file = await getAuthenticatedArtifactResource({
    ...common, resource: 'file', pathToken: pathToken('index.html'),
  });
  const decodedManifest = JSON.parse(manifest.body.toString('utf8'));
  const decodedEnvelope = JSON.parse(envelope.body.toString('utf8'));
  assert.equal(verifyWebArtifactManifest(decodedManifest, decodedEnvelope, keys), true);
  assert.equal(file.body.toString('utf8'), body);
  assert.equal(file.content_type, 'text/html; charset=utf-8');
  await assert.rejects(
    () => getAuthenticatedArtifactResource({ ...common, artifactHash: 'e'.repeat(64), resource: 'manifest' }),
    (error) => error.code === 'web_installation_artifact_not_found'
  );
});

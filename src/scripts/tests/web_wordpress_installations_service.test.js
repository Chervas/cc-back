'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Op } = require('sequelize');
const {
  AUTHENTICATED_ARTIFACT_CACHE_MAX_BYTES,
  AUTHENTICATED_ARTIFACT_CACHE_MAX_ENTRY_BYTES,
  MAX_WORDPRESS_V2_CONTROL_BYTES,
  MAX_WORDPRESS_V2_DOWNLOAD_REQUESTS,
  MAX_WORDPRESS_V2_UNIQUE_FILES,
  assertV2TransportBudget,
  authorizedArtifactForInstallation,
  authenticateInstallation,
  clearAuthenticatedArtifactCache,
  getAuthenticatedArtifactResource,
  getDesiredState,
  intakeConfigForInstallation,
  matchReportedSite,
  measurementFromIntake,
  listInstallations,
  normalizeReport,
  pluginKeyDescriptor,
  recordReport,
  revokeInstallation,
  rotateInstallationToken,
  safeImmutableStorage,
  serializeInstallation,
  tokenHash,
} = require('../../services/webWordpressInstallations.service');
const { openBootstrapTicket } = require('../../lib/webWordpressBootstrapTicket');
const {
  assertArtifactBundle,
  authenticatedDbStorageDescriptor,
  pathToken,
} = require('../../services/webArtifactStorage.service');
const { verifyWebArtifactManifest } = require('../../lib/webArtifactSignature');
const { canonicalSerialize } = require('../../lib/webDocument');
const { MAX_WEB_ARTIFACT_BUNDLE_BYTES } = require('../../lib/webArtifactBudget');
const {
  filterAuthorizedWordpressPublications,
} = require('../../services/webWordpressScope.service');

function row(value) {
  const normalized = { ...value };
  if (['connected', 'outdated'].includes(String(normalized.status || '')) && !normalized.siteUrl) {
    normalized.siteUrl = 'https://wordpress-fixture.example.test';
  }
  if (
    ['connected', 'outdated'].includes(String(normalized.status || ''))
    && normalized.siteUrl
    && normalized.claimedSiteHash === undefined
  ) {
    normalized.claimedSiteHash = crypto.createHash('sha256').update(normalized.siteUrl).digest('hex');
  }
  return {
    ...normalized,
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

function rotationSigningOptions(current, previous) {
  return {
    ...current,
    previousPrivateKeyPem: previous.privateKeyPem,
    rotationFromKeyId: pluginKeyDescriptor(previous).key_id,
  };
}

function authenticatedArtifactFixture({ id, projectId, body }) {
  const fileHash = crypto.createHash('sha256').update(body).digest('hex');
  const manifestCore = {
    schema_version: 1,
    environment: 'production',
    files: {
      'index.html': {
        sha256: fileHash,
        size_bytes: Buffer.byteLength(body),
        content_type: 'text/html; charset=utf-8',
      },
    },
  };
  const artifactHash = crypto.createHash('sha256').update(canonicalSerialize(manifestCore)).digest('hex');
  return row({
    id,
    projectId,
    environment: 'production',
    status: 'ready',
    artifactHash,
    manifest: { ...manifestCore, artifact_hash: artifactHash },
    files: { 'index.html': body },
  });
}

test('desired-state conserva ETag pero prohíbe almacenar el runtime secreto', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/webWordpressInstallations.controller.js'),
    'utf8'
  );
  assert.match(source, /getDesiredState[\s\S]*?Cache-Control', 'private, no-store, max-age=0'/);
  assert.match(source, /getDesiredState[\s\S]*?Pragma', 'no-cache'/);
  assert.match(source, /getDesiredState[\s\S]*?If-None-Match[\s\S]*?status\(304\)/);
});

test('lista separa capacidad activa del historial de rutas para no reutilizar /cita/', async () => {
  const installationId = crypto.randomUUID();
  const retiredPublicationId = crypto.randomUUID();
  const installation = row({
    id: installationId,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    siteUrl: 'https://cliente.example',
    status: 'connected',
    desiredSequence: 3,
    version: 2,
    reportedState: {
      confirmed_routes: {
        [retiredPublicationId]: {
          status: 'retired',
          route_prefix: '/cita/',
          artifact_hash: null,
        },
      },
    },
  });
  const models = {
    WebWordpressInstallation: {
      async findAll() { return [installation]; },
    },
    WebPublication: {
      async findAll() {
        return [{
          id: retiredPublicationId,
          wordpressInstallationId: installationId,
          scopeType: 'clinic',
          clinicaId: 66,
          grupoClinicaId: null,
          status: 'retired',
          path: '/cita/',
        }];
      },
    },
  };

  const [serialized] = await listInstallations({
    actorId: 77,
    query: { scope_type: 'clinic', clinic_id: 66 },
    models,
    assertAccess: async () => {},
  });
  assert.equal(serialized.publication_count, 0);
  assert.equal(serialized.released_publication_tombstones, 1);
  assert.equal(serialized.route_history_count, 1);
  assert.equal(serialized.requires_additional_route, true);
});

test('la clínica ve su instalación propia y el WordPress compartido de su grupo con procedencia explícita', async () => {
  const direct = row({
    id: crypto.randomUUID(),
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    siteUrl: 'https://clinic.example',
    status: 'connected',
    desiredSequence: 1,
    version: 1,
  });
  const inherited = row({
    id: crypto.randomUUID(),
    scopeType: 'group',
    clinicaId: null,
    grupoClinicaId: 5,
    siteUrl: 'https://group.example',
    status: 'connected',
    desiredSequence: 2,
    version: 3,
  });
  let capturedWhere = null;
  const models = {
    Clinica: {
      async findByPk(id) {
        return Number(id) === 66
          ? { id_clinica: 66, grupoClinicaId: 5, estado_clinica: true }
          : null;
      },
    },
    WebWordpressInstallation: {
      async findAll({ where }) {
        capturedWhere = where;
        return [direct, inherited];
      },
    },
    WebPublication: { async findAll() { return []; } },
  };

  const installations = await listInstallations({
    actorId: 77,
    query: { scope_type: 'clinic', clinic_id: 66 },
    models,
    assertAccess: async () => {},
  });

  assert.ok(Array.isArray(capturedWhere[Op.or]));
  assert.equal(installations.length, 2);
  assert.equal(installations[0].inherited_from_group, false);
  assert.deepEqual(installations[0].source_scope, { type: 'clinic', id: 66 });
  assert.equal(installations[1].inherited_from_group, true);
  assert.deepEqual(installations[1].source_scope, { type: 'group', id: 5 });
});

test('autenticación liga token, instalación y major compatible', async () => {
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const installation = row({
    id: 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44',
    tokenHash: tokenHash(token),
    status: 'connected',
  });
  const models = {
    WebWordpressInstallation: {
      async findByPk(id) { return String(id) === installation.id ? installation : null; },
    },
  };
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

test('desired-state revalida el token bajo lock y no filtra HMAC tras perder una carrera de rotación', async () => {
  const oldToken = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const replacementToken = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const keys = signingOptions();
  const installation = row({
    id: crypto.randomUUID(),
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    siteUrl: 'https://cliente.example',
    tokenHash: tokenHash(oldToken),
    tokenPrefix: oldToken.slice(0, 12),
    status: 'connected',
    pluginVersion: '2.0.0-alpha.8',
    capabilities: { multi_publication_v2: true },
    desiredSequence: 7,
    publicKeyId: require('../../services/webWordpressInstallations.service').pluginKeyDescriptor(keys).key_id,
  });
  let reads = 0;
  const models = {
    WebWordpressInstallation: {
      async findByPk() {
        reads += 1;
        if (reads === 2) {
          installation.tokenHash = tokenHash(replacementToken);
          installation.tokenPrefix = replacementToken.slice(0, 12);
        }
        return installation;
      },
    },
  };
  const sequelize = { transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }) };
  await assert.rejects(
    () => getDesiredState({
      installationId: installation.id,
      headers: { authorization: `Bearer ${oldToken}`, pluginVersion: '2.0.0-alpha.8' },
      requestId: 'req-token-race',
      models,
      sequelize,
      signingOptions: keys,
    }),
    (error) => error.code === 'web_installation_unauthorized'
  );
  assert.equal(installation.desiredSequence, 7);
});

test('la rotación staged conserva el token activo hasta un reporte v2 alpha.8 válido y promueve de forma idempotente', async () => {
  const activeToken = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const installation = row({
    id: crypto.randomUUID(),
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    siteUrl: 'https://cliente.example',
    siteUrlHash: crypto.createHash('sha256').update('https://cliente.example').digest('hex'),
    tokenHash: tokenHash(activeToken),
    tokenPrefix: activeToken.slice(0, 12),
    nextTokenHash: null,
    nextTokenPrefix: null,
    nextTokenIssuedAt: null,
    nextTokenExpiresAt: null,
    status: 'connected',
    pluginVersion: '2.0.0-alpha.8',
    capabilities: { multi_publication_v2: true },
    reportedState: {},
    desiredSequence: 0,
    version: 4,
  });
  const audits = [];
  const models = {
    WebWordpressInstallation: {
      async findByPk(id) { return String(id) === installation.id ? installation : null; },
    },
    WebPublication: {
      async findAll() { return []; },
      async count() { return 0; },
    },
    WebAuditEvent: { async create(value) { audits.push(value); } },
  };
  let transactionTail = Promise.resolve();
  const sequelize = {
    transaction(callback) {
      const result = transactionTail.then(() => callback({ LOCK: { UPDATE: 'UPDATE' } }));
      transactionTail = result.catch(() => {});
      return result;
    },
  };
  const env = {
    MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY: crypto.randomBytes(32).toString('base64url'),
    MARKETING_WEB_WORDPRESS_TOKEN_ROTATION_TTL_SECONDS: '3600',
  };
  const staged = await rotateInstallationToken({
    actorId: 77,
    installationId: installation.id,
    models,
    sequelize,
    env,
    assertAccess: async () => {},
    assertPublishing: () => {},
  });
  const stagedToken = openBootstrapTicket(staged.plugin_package.download_ticket, { env }).token;
  assert.equal(installation.status, 'connected');
  assert.equal(installation.tokenHash, tokenHash(activeToken));
  assert.equal(installation.nextTokenHash, tokenHash(stagedToken));
  assert.equal(staged.installation.token_rotation.pending, true);
  assert.equal(audits.at(-1).eventType, 'web.wordpress_installation.token_rotation_staged');

  assert.equal((await authenticateInstallation({
    installationId: installation.id,
    headers: { authorization: `Bearer ${activeToken}`, pluginVersion: '2.0.0-alpha.8' },
    models,
  })).id, installation.id, 'el token activo sigue funcionando durante staging');
  await assert.rejects(
    () => authenticateInstallation({
      installationId: installation.id,
      headers: { authorization: `Bearer ${stagedToken}`, pluginVersion: '2.0.0-alpha.7' },
      models,
    }),
    (error) => error.code === 'web_installation_unauthorized'
  );

  const schema1 = await recordReport({
    installationId: installation.id,
    headers: { authorization: `Bearer ${stagedToken}`, pluginVersion: '2.0.0-alpha.8' },
    body: {
      schema_version: 1,
      event: 'heartbeat',
      plugin_version: '2.0.0-alpha.8',
      site_hash: crypto.createHash('sha256').update('https://cliente.example/').digest('hex'),
      status: 'empty',
      result: 'activation_handshake',
      reported_at: new Date().toISOString(),
    },
    models,
    sequelize,
  });
  assert.equal(schema1.accepted, true);
  assert.equal(installation.tokenHash, tokenHash(activeToken), 'schema v1 no promueve el token staged');
  assert.equal(installation.nextTokenHash, tokenHash(stagedToken));

  const reportBody = {
    schema_version: 2,
    event: 'heartbeat',
    plugin_version: '2.0.0-alpha.8',
    site_hash: crypto.createHash('sha256').update('https://cliente.example/').digest('hex'),
    status: 'empty',
    result: 'activation_handshake',
    reported_at: new Date().toISOString(),
    capabilities: { multi_publication_v2: true },
    registry_sequence: 0,
    routes: {},
  };
  const [first, concurrent] = await Promise.all([
    recordReport({
      installationId: installation.id,
      headers: { authorization: `Bearer ${stagedToken}`, pluginVersion: '2.0.0-alpha.8' },
      body: reportBody,
      models,
      sequelize,
    }),
    recordReport({
      installationId: installation.id,
      headers: { authorization: `Bearer ${stagedToken}`, pluginVersion: '2.0.0-alpha.8' },
      body: { ...reportBody, reported_at: new Date().toISOString() },
      models,
      sequelize,
    }),
  ]);
  assert.equal(first.accepted, true);
  assert.equal(concurrent.accepted, true);
  assert.equal(installation.tokenHash, tokenHash(stagedToken));
  assert.equal(installation.nextTokenHash, null);
  assert.equal(
    audits.filter((audit) => audit.eventType === 'web.wordpress_installation.token_rotation_promoted').length,
    1
  );
  await assert.rejects(
    () => authenticateInstallation({
      installationId: installation.id,
      headers: { authorization: `Bearer ${activeToken}`, pluginVersion: '2.0.0-alpha.8' },
      models,
    }),
    (error) => error.code === 'web_installation_unauthorized'
  );
});

test('reemitir una instalación pending reemplaza el token primario y anula inmediatamente el ZIP anterior', async () => {
  const previousToken = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const installation = row({
    id: crypto.randomUUID(),
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    siteUrl: 'https://cliente.example',
    tokenHash: tokenHash(previousToken),
    tokenPrefix: previousToken.slice(0, 12),
    status: 'pending',
    version: 1,
  });
  const audits = [];
  const models = {
    WebWordpressInstallation: { async findByPk() { return installation; } },
    WebAuditEvent: { async create(value) { audits.push(value); } },
  };
  const sequelize = { transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }) };
  const env = { MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY: crypto.randomBytes(32).toString('base64url') };
  const rotated = await rotateInstallationToken({
    actorId: 77,
    installationId: installation.id,
    models,
    sequelize,
    env,
    assertAccess: async () => {},
    assertPublishing: () => {},
  });
  const replacementToken = openBootstrapTicket(rotated.plugin_package.download_ticket, { env }).token;
  assert.equal(installation.tokenHash, tokenHash(replacementToken));
  assert.equal(installation.nextTokenHash, null);
  assert.equal(rotated.installation.token_rotation.pending, false);
  assert.equal(audits.at(-1).eventType, 'web.wordpress_installation.token_reissued');
  await assert.rejects(
    () => authenticateInstallation({
      installationId: installation.id,
      headers: { authorization: `Bearer ${previousToken}`, pluginVersion: '2.0.0-alpha.8' },
      models,
    }),
    (error) => error.code === 'web_installation_unauthorized'
  );
  assert.equal((await authenticateInstallation({
    installationId: installation.id,
    headers: { authorization: `Bearer ${replacementToken}`, pluginVersion: '2.0.0-alpha.8' },
    models,
  })).id, installation.id);
});

test('reemitir invalida el staged anterior, la expiración falla cerrada y revocar elimina ambos slots', async () => {
  const activeToken = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const installation = row({
    id: crypto.randomUUID(),
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    siteUrl: 'https://cliente.example',
    tokenHash: tokenHash(activeToken),
    tokenPrefix: activeToken.slice(0, 12),
    status: 'connected',
    version: 1,
  });
  const models = {
    WebWordpressInstallation: { async findByPk() { return installation; } },
    WebPublication: { async findAll() { return []; } },
    WebAuditEvent: { async create() {} },
  };
  const sequelize = { transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }) };
  const env = { MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY: crypto.randomBytes(32).toString('base64url') };
  const rotate = () => rotateInstallationToken({
    actorId: 77,
    installationId: installation.id,
    models,
    sequelize,
    env,
    assertAccess: async () => {},
    assertPublishing: () => {},
  });
  const firstToken = openBootstrapTicket((await rotate()).plugin_package.download_ticket, { env }).token;
  const secondToken = openBootstrapTicket((await rotate()).plugin_package.download_ticket, { env }).token;
  await assert.rejects(
    () => authenticateInstallation({
      installationId: installation.id,
      headers: { authorization: `Bearer ${firstToken}`, pluginVersion: '2.0.0-alpha.8' },
      models,
    }),
    (error) => error.code === 'web_installation_unauthorized'
  );
  assert.equal((await authenticateInstallation({
    installationId: installation.id,
    headers: { authorization: `Bearer ${secondToken}`, pluginVersion: '2.0.0-alpha.8' },
    models,
  })).id, installation.id);

  installation.nextTokenExpiresAt = new Date(Date.now() - 1_000);
  assert.equal(serializeInstallation(installation).token_rotation.expired, true);
  await assert.rejects(
    () => authenticateInstallation({
      installationId: installation.id,
      headers: { authorization: `Bearer ${secondToken}`, pluginVersion: '2.0.0-alpha.8' },
      models,
    }),
    (error) => error.code === 'web_installation_unauthorized'
  );
  assert.equal((await authenticateInstallation({
    installationId: installation.id,
    headers: { authorization: `Bearer ${activeToken}`, pluginVersion: '2.0.0-alpha.8' },
    models,
  })).id, installation.id);

  await revokeInstallation({ actorId: 77, installationId: installation.id, models, sequelize, assertAccess: async () => {} });
  assert.equal(installation.status, 'revoked');
  assert.equal(installation.nextTokenHash, null);
  await assert.rejects(
    () => authenticateInstallation({
      installationId: installation.id,
      headers: { authorization: `Bearer ${activeToken}`, pluginVersion: '2.0.0-alpha.8' },
      models,
    }),
    (error) => error.code === 'web_installation_unauthorized'
  );
});

test('revocar exige retirar y confirmar cada ruta antes de invalidar las credenciales', async () => {
  const installation = row({
    id: crypto.randomUUID(),
    scopeType: 'group',
    clinicaId: null,
    grupoClinicaId: 7,
    siteUrl: 'https://cliente.example',
    tokenHash: tokenHash(`ccw_${crypto.randomBytes(32).toString('base64url')}`),
    tokenPrefix: 'ccw_active',
    status: 'connected',
    reportedState: {},
    version: 1,
  });
  const publication = row({
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    wordpressInstallationId: installation.id,
    path: '/cita/hospitalet/',
    status: 'published',
  });
  const models = {
    WebWordpressInstallation: { async findByPk() { return installation; } },
    WebPublication: { async findAll() { return [publication]; } },
    Clinica: {
      async findByPk(id) {
        return Number(id) === 66
          ? { id_clinica: 66, grupoClinicaId: 7, estado_clinica: true }
          : null;
      },
    },
    WebAuditEvent: { async create() {} },
  };
  const sequelize = { transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }) };
  const revoke = () => revokeInstallation({
    actorId: 77,
    installationId: installation.id,
    models,
    sequelize,
    assertAccess: async () => {},
  });

  await assert.rejects(
    revoke,
    (error) => error.code === 'web_wordpress_installation_retirement_required'
      && error.details.publication_ids[0] === publication.id
  );
  assert.equal(installation.status, 'connected');

  publication.status = 'retired';
  installation.reportedState = {
    confirmed_routes: {
      [publication.id]: {
        status: 'retired',
        route_prefix: publication.path,
        artifact_hash: null,
      },
    },
  };
  await revoke();
  assert.equal(installation.status, 'revoked');
});

test('revocar inspecciona todo el historial legítimo aunque supere las veinte rutas activas', async () => {
  const installation = row({
    id: crypto.randomUUID(),
    scopeType: 'group',
    clinicaId: null,
    grupoClinicaId: 7,
    siteUrl: 'https://cliente.example',
    tokenHash: tokenHash(`ccw_${crypto.randomBytes(32).toString('base64url')}`),
    tokenPrefix: 'ccw_active',
    status: 'connected',
    reportedState: { confirmed_routes: {} },
    version: 1,
  });
  const publications = Array.from({ length: 21 }, (_, index) => row({
    id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
    projectId: `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
    scopeType: 'group',
    clinicaId: null,
    grupoClinicaId: 7,
    wordpressInstallationId: installation.id,
    path: `/cita/historico-${index + 1}/`,
    status: 'retired',
  }));
  publications.slice(0, -1).forEach((publication) => {
    installation.reportedState.confirmed_routes[publication.id] = {
      status: 'retired',
      route_prefix: publication.path,
      artifact_hash: null,
    };
  });
  const models = {
    WebWordpressInstallation: { async findByPk() { return installation; } },
    WebPublication: { async findAll() { return publications; } },
    WebAuditEvent: { async create() {} },
  };
  const sequelize = { transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }) };
  const revoke = () => revokeInstallation({
    actorId: 77,
    installationId: installation.id,
    models,
    sequelize,
    assertAccess: async () => {},
  });

  await assert.rejects(
    revoke,
    (error) => error.code === 'web_wordpress_installation_retirement_required'
      && error.details.publication_ids[0] === publications[20].id
  );
  assert.equal(installation.status, 'connected');

  installation.reportedState.confirmed_routes[publications[20].id] = {
    status: 'retired',
    route_prefix: publications[20].path,
    artifact_hash: null,
  };
  await revoke();
  assert.equal(installation.status, 'revoked');
});

test('un direct histórico sin runtime hereda la medición válida del grupo', async () => {
  const direct = {
    assignment_scope: 'clinic', clinic_id: 66, hmac_key: null,
    config: { campaigns: { mode: 'measure' }, meta: { enabled: true }, chat: { greeting: 'Hola' } },
  };
  const inherited = {
    assignment_scope: 'group', group_id: 7,
    hmac_key: '0123456789abcdef0123456789abcdef',
    config: { locations: [{ id: 66 }], features: { consent_mode_enabled: true } },
  };
  const installation = { scopeType: 'clinic', clinicaId: 66 };
  const models = {
    IntakeConfig: {
      async findOne({ where }) {
        return where.assignment_scope === 'clinic' ? direct : inherited;
      },
    },
    Clinica: { async findByPk() { return { grupoClinicaId: 7 }; } },
  };
  assert.equal(await intakeConfigForInstallation(installation, { models }), inherited);

  direct.config.features = { chat_enabled: false };
  direct.hmac_key = 'abcdef0123456789abcdef0123456789';
  assert.equal(await intakeConfigForInstallation(installation, { models }), direct);
});

test('una clínica materializada sigue el runtime actual del grupo y un marker inválido falla cerrado', async () => {
  const direct = {
    assignment_scope: 'clinic', clinic_id: 66,
    hmac_key: 'old-materialized-hmac-0123456789abcdef',
    config: {
      runtime_inheritance: { schema_version: 1, scope_type: 'group', scope_id: 7 },
      features: { consent_mode_enabled: true, chat_enabled: false },
      campaigns: { mode: 'measure' },
    },
  };
  const inherited = {
    assignment_scope: 'group', group_id: 7,
    hmac_key: 'new-group-hmac-abcdef0123456789',
    config: {
      locations: [{ id: 66 }],
      features: { consent_mode_enabled: true, chat_enabled: true },
    },
  };
  const installation = { scopeType: 'clinic', clinicaId: 66 };
  const models = {
    IntakeConfig: {
      async findOne({ where }) {
        return where.assignment_scope === 'clinic' ? direct : inherited;
      },
    },
    Clinica: { async findByPk() { return { grupoClinicaId: 7 }; } },
  };
  assert.equal(await intakeConfigForInstallation(installation, { models }), inherited);
  inherited.hmac_key = 'later-group-hmac-abcdef0123456789';
  assert.equal((await intakeConfigForInstallation(installation, { models })).hmac_key, inherited.hmac_key);

  direct.config.runtime_inheritance = {
    schema_version: 1, scope_type: 'group', scope_id: 7, unexpected: true,
  };
  assert.equal(await intakeConfigForInstallation(installation, { models }), null);

  direct.config.runtime_inheritance = { schema_version: 1, scope_type: 'group', scope_id: 8 };
  assert.equal(await intakeConfigForInstallation(installation, { models }), null);

  direct.config.runtime_inheritance = { schema_version: 1, scope_type: 'clinic', scope_id: 66 };
  assert.equal(await intakeConfigForInstallation(installation, { models }), null);

  delete direct.config.runtime_inheritance;
  assert.equal(await intakeConfigForInstallation(installation, { models }), direct);
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
  assert.deepEqual(measurementFromIntake({
    assignment_scope: 'clinic',
    clinic_id: 56,
    hmac_key: '0123456789abcdef0123456789abcdef',
    config: {
      runtime_inheritance: { schema_version: 1, scope_type: 'group', scope_id: 5 },
      features: { consent_mode_enabled: true, consent_provider: 'clinicaclick' },
    },
  }), {
    enabled: true,
    scope_type: 'group',
    scope_id: 5,
    loader_path: '/assets/loader.js',
    hmac_key: '0123456789abcdef0123456789abcdef',
    consent_mode_enabled: true,
    consent_provider: 'clinicaclick',
    chat_enabled: false,
    whatsapp_enabled: false,
    phone_enabled: false,
  });
});

test('el presupuesto de transporte v2 acepta los límites exactos y rechaza el primer exceso', () => {
  assert.equal(require('../../services/webWordpressInstallations.service').WORDPRESS_V2_ARTIFACT_RATE_LIMIT, 1100);
  const files = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [
    `asset-${index}.css`, { sha256: 'a'.repeat(64), size_bytes: 1 },
  ]));
  const sharedArtifact = 'b'.repeat(64);
  const routes = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    crypto.randomUUID(),
    { status: 'active', desired_artifact_hash: sharedArtifact, route_prefix: `/cita/${index}/` },
  ]));
  const exactRequests = assertV2TransportBudget({
    routes,
    artifacts: { [sharedArtifact]: { files: files(23) } },
  });
  assert.equal(exactRequests.download_requests, MAX_WORDPRESS_V2_DOWNLOAD_REQUESTS);
  assert.throws(
    () => assertV2TransportBudget({
      routes,
      artifacts: { [sharedArtifact]: { files: files(24) } },
    }),
    (error) => error.code === 'web_installation_transport_budget_exceeded'
  );

  const oneRoute = {
    [crypto.randomUUID()]: { status: 'active', desired_artifact_hash: sharedArtifact, route_prefix: '/cita/' },
  };
  assert.equal(assertV2TransportBudget({
    routes: oneRoute,
    artifacts: { [sharedArtifact]: { files: files(MAX_WORDPRESS_V2_UNIQUE_FILES) } },
  }).unique_files, MAX_WORDPRESS_V2_UNIQUE_FILES);
  assert.throws(
    () => assertV2TransportBudget({
      routes: oneRoute,
      artifacts: { [sharedArtifact]: { files: files(MAX_WORDPRESS_V2_UNIQUE_FILES + 1) } },
    }),
    (error) => error.code === 'web_installation_transport_budget_exceeded'
  );
  assert.throws(
    () => assertV2TransportBudget({ response: { padding: 'x'.repeat(MAX_WORDPRESS_V2_CONTROL_BYTES) } }),
    (error) => error.code === 'web_installation_transport_budget_exceeded'
  );
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
  const siteClaimToken = crypto.randomBytes(32).toString('base64url');
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
    claimedSiteHash: null,
    siteClaimTokenHash: tokenHash(siteClaimToken),
    siteClaimExpiresAt: new Date(Date.now() + 60_000),
    pluginVersion: null,
    lastSeenAt: null,
    version: 1,
  });
  const audits = [];
  const models = {
    WebWordpressInstallation: {
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
    verifySiteClaim: async ({ expectedClaimTokenHash }) => ({
      installation_id: installation.id,
      site_url: 'https://www.propdental.example',
      site_url_hash: crypto.createHash('sha256').update('https://www.propdental.example').digest('hex'),
      claim_token_hash: expectedClaimTokenHash,
    }),
  });
  assert.equal(result.accepted, true);
  assert.equal(installation.status, 'connected');
  assert.equal(installation.siteUrl, 'https://www.propdental.example');
  assert.equal(
    installation.siteUrlHash,
    crypto.createHash('sha256').update(installation.siteUrl).digest('hex')
  );
  assert.equal(installation.version, 2);
  assert.equal(installation.claimedSiteHash, installation.siteUrlHash);
  assert.equal(installation.siteClaimTokenHash, null);
  assert.deepEqual(
    audits.map((audit) => audit.eventType),
    [
      'web.wordpress_installation.site_canonicalized',
      'web.wordpress_installation.site_claimed',
      'web.wordpress_installation.heartbeat',
    ]
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
      WebWordpressInstallation: { async findByPk() { return installation; } },
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
    status: 'ready',
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
    scopeType: 'clinic', clinicaId: 56, grupoClinicaId: null,
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
      async findByPk() { return installation; },
    },
    WebPublication: { async findAll() { return [publication]; } },
    WebPublicationDeployment: { async findOne() { return deployment; } },
    WebArtifact: {
      async findByPk(id, options) {
        assert.equal(id, artifact.id);
        assert.equal(options.attributes.includes('manifest'), true);
        assert.equal(options.attributes.includes('files'), false, 'desired-state v1 loaded artifact bodies');
        return artifact;
      },
    },
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
  assert.equal(first.response.schema_version, 1);
  assert.deepEqual(
    Object.keys(first.response).sort(),
    ['desired_state', 'installation_id', 'request_id', 'schema_version']
  );
  assert.equal(first.response.desired_state.registry_configuration, undefined);
  assert.equal(first.response.desired_state.artifacts, undefined);
  assert.equal(first.response.desired_state.status, 'published');
  assert.equal(first.response.desired_state.runtime_configuration.schema_version, 1);
  assert.equal(first.response.desired_state.runtime_configuration.route_prefix, '/cita');
  assert.equal(first.response.desired_state.runtime_configuration.sequence, 1);
  assert.equal(second.response.desired_state.runtime_configuration.sequence, 1);
  assert.equal(first.etag, second.etag);
  assert.match(first.response.desired_state.runtime_configuration_envelope.signature, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(first.response.desired_state.runtime_configuration.measurement.scope_id, 56);
  assert.deepEqual(Object.keys(first.response.desired_state.files), ['index.html']);
});

test('rotación Ed25519 sirve old y current en paralelo sin self-bootstrap ni transición inversa', async () => {
  const previous = signingOptions();
  const current = signingOptions();
  const keys = rotationSigningOptions(current, previous);
  const previousDescriptor = pluginKeyDescriptor(previous);
  const currentDescriptor = pluginKeyDescriptor(current);
  const env = { MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com' };
  const records = new Map();
  const publications = new Map();
  const deployments = new Map();
  const artifacts = new Map();
  const tokens = new Map();

  for (const [suffix, publicKeyId] of [['old', previousDescriptor.key_id], ['current', currentDescriptor.key_id]]) {
    const id = suffix === 'old'
      ? '11111111-1111-4111-8111-111111111111'
      : '22222222-2222-4222-8222-222222222222';
    const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
    const artifact = authenticatedArtifactFixture({
      id: `artifact-${suffix}`,
      projectId: `project-${suffix}`,
      body: `<h1>${suffix}</h1>`,
    });
    const publication = row({
      id: suffix === 'old'
        ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      projectId: artifact.projectId,
      scopeType: 'clinic',
      clinicaId: 56,
      grupoClinicaId: null,
      path: '/cita/',
      wordpressInstallationId: id,
      status: 'publishing',
      activeArtifactId: null,
    });
    const installation = row({
      id,
      scopeType: 'clinic',
      clinicaId: 56,
      grupoClinicaId: null,
      tokenHash: tokenHash(token),
      status: 'connected',
      pluginVersion: '2.0.0-alpha.8',
      capabilities: { multi_publication_v2: true },
      desiredSequence: 0,
      desiredStateHash: null,
      publicKeyId,
      reportedState: suffix === 'current'
        ? { signing_key_history: [previousDescriptor.key_id] }
        : {},
    });
    records.set(id, installation);
    publications.set(id, publication);
    artifacts.set(artifact.id, artifact);
    deployments.set(publication.id, row({
      id: `deployment-${suffix}`,
      publicationId: publication.id,
      artifactId: artifact.id,
      status: 'running',
      sequence: 1,
      storage: authenticatedDbStorageDescriptor({ artifact, installationId: id, env }),
    }));
    tokens.set(id, token);
  }
  let artifactMetadataReads = 0;
  const models = {
    WebWordpressInstallation: { async findByPk(id) { return records.get(String(id)) || null; } },
    WebPublication: {
      async findAll({ where }) { return [publications.get(String(where.wordpressInstallationId))]; },
    },
    WebPublicationDeployment: {
      async findOne({ where }) { return deployments.get(String(where.publicationId)) || null; },
    },
    WebArtifact: {
      async findByPk(id, options) {
        artifactMetadataReads += 1;
        assert.equal(options.attributes.includes('files'), false);
        return artifacts.get(String(id)) || null;
      },
    },
    IntakeConfig: { async findOne() { return null; } },
    Clinica: { async findByPk() { return null; } },
  };
  const sequelize = { async transaction(callback) { return callback({ LOCK: { UPDATE: 'UPDATE' } }); } };
  const responseFor = (id) => getDesiredState({
    installationId: id,
    headers: {
      authorization: `Bearer ${tokens.get(id)}`,
      pluginVersion: '2.0.0-alpha.8',
    },
    requestId: `req-${id}`,
    models,
    sequelize,
    signingOptions: keys,
    env,
  });

  const oldResponse = await responseFor('11111111-1111-4111-8111-111111111111');
  const currentResponse = await responseFor('22222222-2222-4222-8222-222222222222');
  const oldDesired = oldResponse.response.desired_state;
  const currentDesired = currentResponse.response.desired_state;
  assert.equal(oldDesired.signing_key_descriptor.key_id, currentDescriptor.key_id);
  assert.equal(oldDesired.signing_key_descriptor_envelope.key_id, previousDescriptor.key_id);
  assert.equal(
    verifyWebArtifactManifest(
      oldDesired.signing_key_descriptor,
      oldDesired.signing_key_descriptor_envelope,
      previous
    ),
    true,
    'old installation did not receive a descriptor cross-signed by its trusted key'
  );
  assert.equal(
    verifyWebArtifactManifest(
      oldDesired.registry_configuration,
      oldDesired.registry_configuration_envelope,
      current
    ),
    true,
    'rotated registry was not signed by the current key'
  );
  assert.deepEqual(currentDesired.signing_key_descriptor_envelope, {});
  assert.equal(currentDesired.signing_key_descriptor.key_id, currentDescriptor.key_id);
  assert.equal(artifactMetadataReads, 2);

  const reverseKeys = rotationSigningOptions(previous, current);
  await assert.rejects(
    () => getDesiredState({
      installationId: '22222222-2222-4222-8222-222222222222',
      headers: {
        authorization: `Bearer ${tokens.get('22222222-2222-4222-8222-222222222222')}`,
        pluginVersion: '2.0.0-alpha.8',
      },
      requestId: 'req-reverse',
      models,
      sequelize,
      signingOptions: reverseKeys,
      env,
    }),
    (error) => error.code === 'web_installation_signing_key_downgrade_blocked'
  );
});

test('ACK v2 promueve publicKeyId bajo lock solo tras rutas y secuencia exactas', async () => {
  const previous = signingOptions();
  const current = signingOptions();
  const previousDescriptor = pluginKeyDescriptor(previous);
  const currentDescriptor = pluginKeyDescriptor(current);
  const env = { MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com' };
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const siteUrl = 'https://rotation-ack.example';
  const installation = row({
    id: '33333333-3333-4333-8333-333333333333',
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    siteUrl,
    siteUrlHash: crypto.createHash('sha256').update(siteUrl).digest('hex'),
    tokenHash: tokenHash(token),
    tokenPrefix: token.slice(0, 12),
    status: 'connected',
    pluginVersion: '2.0.0-alpha.8',
    capabilities: { multi_publication_v2: true },
    reportedState: {},
    desiredSequence: 7,
    desiredStateHash: 'signed-state-7',
    publicKeyId: previousDescriptor.key_id,
    version: 3,
  });
  const artifact = authenticatedArtifactFixture({
    id: 'artifact-rotation-ack',
    projectId: 'project-rotation-ack',
    body: '<h1>Rotación ACK</h1>',
  });
  const publication = row({
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    projectId: artifact.projectId,
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    path: '/cita/',
    wordpressInstallationId: installation.id,
    status: 'publishing',
    activeArtifactId: null,
  });
  const deployment = row({
    id: 'deployment-rotation-ack',
    publicationId: publication.id,
    artifactId: artifact.id,
    status: 'running',
    sequence: 1,
    storage: authenticatedDbStorageDescriptor({ artifact, installationId: installation.id, env }),
  });
  const audits = [];
  let lockedReads = 0;
  let artifactMetadataReads = 0;
  const models = {
    WebWordpressInstallation: {
      async findByPk() {
        lockedReads += 1;
        return installation;
      },
    },
    WebPublication: { async findAll() { return [publication]; } },
    WebPublicationDeployment: { async findOne() { return deployment; } },
    WebArtifact: {
      async findByPk(id, options) {
        artifactMetadataReads += 1;
        assert.equal(id, artifact.id);
        assert.equal(options.attributes.includes('files'), false);
        return artifact;
      },
    },
    WebAuditEvent: { async create(value) { audits.push(value); } },
  };
  const sequelize = { async transaction(callback) { return callback({ LOCK: { UPDATE: 'UPDATE' } }); } };
  const route = {
    publication_id: publication.id,
    route_prefix: publication.path,
    status: 'active',
    active_artifact_hash: artifact.artifactHash,
    desired_artifact_hash: artifact.artifactHash,
    result: 'activated',
    error_code: null,
  };
  const report = {
    schema_version: 2,
    event: 'sync_result',
    request_id: 'req-signing-ack',
    plugin_version: '2.0.0-alpha.8',
    site_hash: crypto.createHash('sha256').update(`${siteUrl}/`).digest('hex'),
    status: 'active',
    capabilities: { multi_publication_v2: true },
    registry_sequence: 7,
    configuration_sequence: 7,
    signing_key_id: currentDescriptor.key_id,
    routes: { [publication.id]: route },
    reported_at: new Date().toISOString(),
  };
  const common = {
    installationId: installation.id,
    headers: { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.8' },
    requestId: 'req-signing-ack',
    models,
    sequelize,
    signingOptions: current,
    env,
  };

  const partial = await recordReport({
    ...common,
    body: {
      ...report,
      routes: {
        [publication.id]: { ...route, result: 'failed', error_code: 'ccw_download_failed' },
      },
    },
  });
  assert.equal(partial.confirms_desired, false);
  assert.equal(installation.publicKeyId, previousDescriptor.key_id, 'partial report promoted the key');

  const accepted = await recordReport({ ...common, body: { ...report, reported_at: new Date().toISOString() } });
  assert.equal(accepted.confirms_desired, true);
  assert.equal(installation.publicKeyId, currentDescriptor.key_id);
  assert.equal(installation.version, 4);
  assert.deepEqual(installation.reportedState.signing_key_history, [previousDescriptor.key_id]);
  assert.equal(
    audits.filter((audit) => audit.eventType === 'web.wordpress_installation.signing_key_rotation_promoted').length,
    1
  );
  assert.ok(lockedReads >= 4, 'installation was not revalidated under transaction lock');
  assert.ok(artifactMetadataReads >= 3, 'desired routes were not revalidated under lock');

  await recordReport({ ...common, body: { ...report, reported_at: new Date().toISOString() } });
  assert.equal(
    audits.filter((audit) => audit.eventType === 'web.wordpress_installation.signing_key_rotation_promoted').length,
    1,
    'idempotent ACK emitted a second promotion'
  );
  await assert.rejects(
    () => recordReport({
      ...common,
      body: {
        ...report,
        signing_key_id: previousDescriptor.key_id,
        reported_at: new Date().toISOString(),
      },
    }),
    (error) => error.code === 'web_installation_report_signing_key_mismatch'
  );
  assert.equal(installation.publicKeyId, currentDescriptor.key_id, 'wrong-key replay downgraded the installation');
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
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    wordpressInstallationId: installation.id,
    status: 'failed',
    activeArtifactId: null,
    lastGoodArtifactId: null,
  });
  const models = {
    WebWordpressInstallation: {
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
  clearAuthenticatedArtifactCache();
  const keys = signingOptions();
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const body = '<!doctype html><title>Landing</title>';
  const fileHash = crypto.createHash('sha256').update(body).digest('hex');
  const manifestCore = {
    schema_version: 1,
    environment: 'production',
    files: {
      'index.html': {
        sha256: fileHash,
        size_bytes: Buffer.byteLength(body),
        content_type: 'text/html; charset=utf-8',
      },
    },
  };
  const artifactHash = crypto.createHash('sha256').update(canonicalSerialize(manifestCore)).digest('hex');
  const artifact = row({
    id: 'artifact-db-1',
    projectId: 'project-db-1',
    environment: 'production',
    status: 'ready',
    artifactHash,
    manifest: { ...manifestCore, artifact_hash: artifactHash },
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
    scopeType: 'clinic', clinicaId: 56, grupoClinicaId: null,
    wordpressInstallationId: installation.id, status: 'publishing', activeArtifactId: null,
  });
  const deployment = row({
    id: 'deployment-db-1', publicationId: publication.id, artifactId: artifact.id,
    status: 'running', sequence: 1,
    storage: authenticatedDbStorageDescriptor({ artifact, installationId: installation.id, env }),
  });
  let artifactBundleLoads = 0;
  const artifactReadOrder = [];
  const models = {
    WebWordpressInstallation: { async findByPk() { return installation; } },
    WebPublication: {
      async count() { return 1; },
      async findAll() { artifactReadOrder.push('publication'); return [publication]; },
    },
    WebPublicationDeployment: {
      async findAll() { artifactReadOrder.push('deployments'); return [deployment]; },
      async findOne() { artifactReadOrder.push('desired-deployment'); return deployment; },
    },
    WebArtifact: {
      async findOne({ where, attributes }) {
        artifactReadOrder.push('artifact-metadata');
        assert.equal(attributes.includes('manifest'), true);
        assert.equal(attributes.includes('files'), false);
        return where.artifactHash === artifactHash
          ? row(Object.fromEntries(attributes.map((attribute) => [attribute, artifact[attribute]])))
          : null;
      },
      async findByPk(id, { attributes }) {
        artifactReadOrder.push('artifact-bundle');
        artifactBundleLoads += 1;
        assert.equal(id, artifact.id);
        assert.equal(attributes.includes('manifest'), true);
        assert.equal(attributes.includes('files'), true);
        return artifact;
      },
    },
  };
  const common = {
    installationId: installation.id,
    artifactHash,
    headers: { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.1' },
    models,
    signingOptions: keys,
    env,
  };
  let bundleValidations = 0;
  const artifactBundleValidator = (input) => {
    bundleValidations += 1;
    return assertArtifactBundle(input);
  };
  const manifest = await getAuthenticatedArtifactResource({ ...common, resource: 'manifest', artifactBundleValidator });
  const envelope = await getAuthenticatedArtifactResource({ ...common, resource: 'envelope', artifactBundleValidator });
  const file = await getAuthenticatedArtifactResource({
    ...common, resource: 'file', pathToken: pathToken('index.html'), artifactBundleValidator,
  });
  const decodedManifest = JSON.parse(manifest.body.toString('utf8'));
  const decodedEnvelope = JSON.parse(envelope.body.toString('utf8'));
  assert.equal(verifyWebArtifactManifest(decodedManifest, decodedEnvelope, keys), true);
  assert.equal(file.body.toString('utf8'), body);
  assert.equal(file.content_type, 'text/html; charset=utf-8');
  assert.equal(bundleValidations, 1, 'el bundle completo se verifica una sola vez para N recursos inmutables');
  assert.equal(artifactBundleLoads, 1, 'los recursos posteriores reutilizan solo el bundle normalizado');
  assert.ok(
    artifactReadOrder.indexOf('artifact-bundle') > artifactReadOrder.indexOf('desired-deployment'),
    'manifest/files solo se cargan después de autorizar la publicación y su deployment deseado'
  );
  await assert.rejects(
    () => getAuthenticatedArtifactResource({ ...common, artifactHash: 'e'.repeat(64), resource: 'manifest' }),
    (error) => error.code === 'web_installation_artifact_not_found'
  );
  for (const status of ['failed', 'retired']) {
    artifact.status = status;
    await assert.rejects(
      () => getAuthenticatedArtifactResource({ ...common, resource: 'manifest', artifactBundleValidator }),
      (error) => error.code === 'web_installation_artifact_not_found'
    );
  }
  artifact.status = 'ready';
  clearAuthenticatedArtifactCache();
});

test('un miss concurrente comparte una única carga y validación del bundle autenticado', async () => {
  clearAuthenticatedArtifactCache();
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const installation = row({
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    tokenHash: tokenHash(token),
    status: 'connected',
    capabilities: { multi_publication_v2: true },
  });
  const artifact = authenticatedArtifactFixture({
    id: 'artifact-concurrent-load',
    projectId: 'project-concurrent-load',
    body: '<h1>Concurrente</h1>',
  });
  const env = { MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com' };
  const publication = row({
    id: 'publication-concurrent-load',
    projectId: artifact.projectId,
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    wordpressInstallationId: installation.id,
    status: 'publishing',
    activeArtifactId: null,
  });
  const deployment = row({
    id: 'deployment-concurrent-load',
    publicationId: publication.id,
    artifactId: artifact.id,
    status: 'running',
    sequence: 1,
    storage: authenticatedDbStorageDescriptor({ artifact, installationId: installation.id, env }),
  });
  let releaseBundleLoad;
  const bundleLoadGate = new Promise((resolve) => { releaseBundleLoad = resolve; });
  let fullBundleLoads = 0;
  let validations = 0;
  const models = {
    WebWordpressInstallation: { async findByPk() { return installation; } },
    WebArtifact: {
      async findOne({ attributes }) {
        return row(Object.fromEntries(attributes.map((attribute) => [attribute, artifact[attribute]])));
      },
      async findByPk() {
        fullBundleLoads += 1;
        await bundleLoadGate;
        return artifact;
      },
    },
    WebPublicationDeployment: {
      async findAll() { return [deployment]; },
      async findOne() { return deployment; },
    },
    WebPublication: {
      async findAll() { return [publication]; },
      async count() { assert.fail('alpha.8 no necesita contar rutas'); },
    },
  };
  const request = () => getAuthenticatedArtifactResource({
    installationId: installation.id,
    artifactHash: artifact.artifactHash,
    resource: 'file',
    pathToken: pathToken('index.html'),
    headers: { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.8' },
    models,
    env,
    artifactBundleValidator(input) { validations += 1; return assertArtifactBundle(input); },
  });
  const pending = Array.from({ length: 16 }, request);
  for (let index = 0; index < 10 && fullBundleLoads === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fullBundleLoads, 1);
  releaseBundleLoad();
  const resources = await Promise.all(pending);
  assert.equal(resources.length, 16);
  assert.ok(resources.every((resource) => resource.body.toString('utf8') === '<h1>Concurrente</h1>'));
  assert.equal(fullBundleLoads, 1);
  assert.equal(validations, 1);
  clearAuthenticatedArtifactCache();
});

test('la caché autenticada aplica LRU por bytes sin retener filas y bundles duplicados', async () => {
  clearAuthenticatedArtifactCache();
  const keys = signingOptions();
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const installation = row({
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    tokenHash: tokenHash(token),
    status: 'connected',
    capabilities: { multi_publication_v2: true },
  });
  const env = { MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com' };
  const cachedBodyBytes = 6 * 1024 * 1024;
  assert.ok(cachedBodyBytes * 5 < AUTHENTICATED_ARTIFACT_CACHE_MAX_BYTES);
  assert.ok(cachedBodyBytes < AUTHENTICATED_ARTIFACT_CACHE_MAX_ENTRY_BYTES);
  assert.equal(AUTHENTICATED_ARTIFACT_CACHE_MAX_ENTRY_BYTES, MAX_WEB_ARTIFACT_BUNDLE_BYTES);
  const artifacts = Array.from({ length: 6 }, (_, index) => authenticatedArtifactFixture({
    id: `artifact-cache-${index}`,
    projectId: `project-cache-${index}`,
    body: Buffer.alloc(cachedBodyBytes, index + 1),
  }));
  const publications = new Map(artifacts.map((artifact, index) => [artifact.id, row({
    id: `publication-cache-${index}`,
    projectId: artifact.projectId,
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    wordpressInstallationId: installation.id,
    status: 'publishing',
    activeArtifactId: null,
  })]));
  const deployments = new Map(artifacts.map((artifact, index) => {
    const publication = publications.get(artifact.id);
    return [artifact.id, row({
      id: `deployment-cache-${index}`,
      publicationId: publication.id,
      artifactId: artifact.id,
      status: 'running',
      sequence: 1,
      storage: authenticatedDbStorageDescriptor({ artifact, installationId: installation.id, env }),
    })];
  }));
  const byHash = new Map(artifacts.map((artifact) => [artifact.artifactHash, artifact]));
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const validationCount = new Map();
  const artifactBundleValidator = (input) => {
    validationCount.set(input.artifact_hash, Number(validationCount.get(input.artifact_hash) || 0) + 1);
    return assertArtifactBundle(input);
  };
  const models = {
    WebWordpressInstallation: { async findByPk() { return installation; } },
    WebArtifact: {
      async findOne({ where, attributes }) {
        const artifact = byHash.get(where.artifactHash);
        return artifact
          ? row(Object.fromEntries(attributes.map((attribute) => [attribute, artifact[attribute]])))
          : null;
      },
      async findByPk(id) { return byId.get(id) || null; },
    },
    WebPublicationDeployment: {
      async findAll({ where }) {
        const deployment = deployments.get(where.artifactId);
        return deployment ? [deployment] : [];
      },
      async findOne({ where }) {
        return [...deployments.values()].find((deployment) => deployment.publicationId === where.publicationId) || null;
      },
    },
    WebPublication: {
      async findAll({ where }) {
        const ids = new Set(where.id[Op.in].map(String));
        return [...publications.values()].filter((publication) => ids.has(String(publication.id)));
      },
      async count() { assert.fail('alpha.8 no necesita contar rutas para descargar'); },
    },
  };
  const serve = async (artifact) => getAuthenticatedArtifactResource({
    installationId: installation.id,
    artifactHash: artifact.artifactHash,
    resource: 'file',
    pathToken: pathToken('index.html'),
    headers: { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.8' },
    models,
    signingOptions: keys,
    env,
    artifactBundleValidator,
  });

  for (const artifact of artifacts.slice(0, 5)) await serve(artifact);
  await serve(artifacts[0]); // La primera pasa a ser la más reciente.
  await serve(artifacts[5]); // Seis entradas de 6 MiB exceden el presupuesto total.
  await serve(artifacts[0]);
  assert.equal(validationCount.get(artifacts[0].artifactHash), 1, 'el hit reciente permanece en caché');
  await serve(artifacts[1]);
  assert.equal(validationCount.get(artifacts[1].artifactHash), 2, 'se expulsa la entrada LRU por presupuesto total');

  clearAuthenticatedArtifactCache();
});

test('un legacy sobredimensionado se rechaza desde manifest sin cargar files ni amplificar N requests', async () => {
  clearAuthenticatedArtifactCache();
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const installation = row({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    tokenHash: tokenHash(token),
    status: 'connected',
    capabilities: { multi_publication_v2: true },
  });
  const artifact = authenticatedArtifactFixture({
    id: 'artifact-cache-legacy-large',
    projectId: 'project-cache-legacy-large',
    body: Buffer.alloc(MAX_WEB_ARTIFACT_BUNDLE_BYTES, 7),
  });
  let metadataLoads = 0;
  let fullBundleLoads = 0;
  let validations = 0;
  const models = {
    WebWordpressInstallation: { async findByPk() { return installation; } },
    WebArtifact: {
      async findOne({ attributes }) {
        metadataLoads += 1;
        assert.equal(attributes.includes('manifest'), true);
        assert.equal(attributes.includes('files'), false);
        return row(Object.fromEntries(attributes.map((attribute) => [attribute, artifact[attribute]])));
      },
      async findByPk() { fullBundleLoads += 1; return artifact; },
    },
    WebPublicationDeployment: {
      async findAll() { assert.fail('un manifest sobredimensionado se rechaza antes de consultar deployments'); },
    },
    WebPublication: {
      async count() { assert.fail('alpha.8 no necesita contar rutas'); },
      async findAll() { assert.fail('un manifest sobredimensionado se rechaza antes de consultar publicaciones'); },
    },
  };
  const request = () => getAuthenticatedArtifactResource({
    installationId: installation.id,
    artifactHash: artifact.artifactHash,
    resource: 'manifest',
    headers: { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.8' },
    models,
    artifactBundleValidator(input) { validations += 1; return assertArtifactBundle(input); },
  });
  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(request, (error) => error.code === 'web_installation_artifact_not_found');
  }
  assert.equal(metadataLoads, 4);
  assert.equal(fullBundleLoads, 0);
  assert.equal(validations, 0);
  clearAuthenticatedArtifactCache();
});

test('autorización de artefacto v2 consulta solo el hash solicitado y revalida el deployment deseado', async () => {
  const env = { MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com' };
  const installation = row({
    id: 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44',
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    status: 'connected',
  });
  const artifact = authenticatedArtifactFixture({
    id: 'artifact-directed',
    projectId: 'project-directed',
    body: '<h1>Dirigido</h1>',
  });
  const publication = row({
    id: 'publication-directed',
    projectId: artifact.projectId,
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    wordpressInstallationId: installation.id,
    status: 'publishing',
    activeArtifactId: null,
    lastGoodArtifactId: null,
  });
  const deployment = row({
    id: 'deployment-directed',
    publicationId: publication.id,
    artifactId: artifact.id,
    status: 'running',
    sequence: 9,
    storage: authenticatedDbStorageDescriptor({ artifact, installationId: installation.id, env }),
  });
  const calls = { artifact: 0, deployments: 0, publications: 0, latest: 0 };
  const models = {
    WebArtifact: {
      async findOne({ where, attributes }) {
        calls.artifact += 1;
        assert.equal(where.artifactHash, artifact.artifactHash);
        assert.equal(attributes.includes('manifest'), true);
        assert.equal(attributes.includes('files'), false);
        return artifact;
      },
      async findByPk() { assert.fail('no debe recorrer artefactos por publicación'); },
    },
    WebPublicationDeployment: {
      async findAll({ where }) {
        calls.deployments += 1;
        assert.equal(where.artifactId, artifact.id);
        return [deployment];
      },
      async findOne({ where }) {
        calls.latest += 1;
        assert.equal(where.publicationId, publication.id);
        return deployment;
      },
    },
    WebPublication: {
      async findAll({ where }) {
        calls.publications += 1;
        assert.equal(where.wordpressInstallationId, installation.id);
        return [publication];
      },
      async count() { assert.fail('v2 no necesita contar todas las rutas'); },
    },
  };
  const authorized = await authorizedArtifactForInstallation({
    installation,
    requestedHash: artifact.artifactHash,
    callerSupportsMulti: true,
    models,
    env,
  });
  assert.equal(authorized.artifact.id, artifact.id);
  assert.equal(authorized.publication.id, publication.id);
  assert.deepEqual(calls, { artifact: 1, deployments: 1, publications: 1, latest: 1 });

  models.WebPublicationDeployment.findOne = async () => row({ ...deployment, artifactId: 'newer-artifact' });
  assert.equal(await authorizedArtifactForInstallation({
    installation,
    requestedHash: artifact.artifactHash,
    callerSupportsMulti: true,
    models,
    env,
  }), null, 'un artefacto preparado deja de ser descargable cuando otro deployment es el deseado');
});

test('el registro mixto bloquea clínicas por id efectivo estable y no por tipo de scope', async () => {
  const installation = row({
    id: '55555555-5555-4555-8555-555555555555',
    scopeType: 'group',
    clinicaId: null,
    grupoClinicaId: 5,
  });
  const publications = [
    row({ id: 'group-50', scopeType: 'group', grupoClinicaId: 5, configuration: { clinic_id: 50 } }),
    row({ id: 'clinic-10', scopeType: 'clinic', clinicaId: 10, grupoClinicaId: null }),
    row({ id: 'clinic-50', scopeType: 'clinic', clinicaId: 50, grupoClinicaId: null }),
    row({ id: 'group-10', scopeType: 'group', grupoClinicaId: 5, configuration: { clinic_id: 10 } }),
  ];
  const clinicReads = [];
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const authorized = await filterAuthorizedWordpressPublications(installation, publications, {
    models: {
      Clinica: {
        async findByPk(id, options) {
          clinicReads.push({ id: Number(id), options });
          return { id_clinica: Number(id), grupoClinicaId: 5, estado_clinica: true };
        },
      },
    },
    transaction,
    lockClinics: true,
  });

  assert.deepEqual(authorized.map((publication) => publication.id), [
    'clinic-10', 'group-10', 'clinic-50', 'group-50',
  ]);
  assert.deepEqual(clinicReads.map((entry) => entry.id), [10, 10, 50, 50]);
  assert.ok(clinicReads.every((entry) => (
    entry.options.transaction === transaction && entry.options.lock === transaction.LOCK.UPDATE
  )));
});

test('WordPress de grupo revalida la clínica materializada en publicaciones de clínica y de grupo', async () => {
  clearAuthenticatedArtifactCache();
  const keys = signingOptions();
  const descriptor = pluginKeyDescriptor(keys);
  const env = { MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com' };
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const siteUrl = 'https://wordpress-grupo.example';
  const installation = row({
    id: '55555555-5555-4555-8555-555555555555',
    scopeType: 'group',
    clinicaId: null,
    grupoClinicaId: 5,
    siteUrl,
    siteUrlHash: crypto.createHash('sha256').update(siteUrl).digest('hex'),
    tokenHash: tokenHash(token),
    tokenPrefix: token.slice(0, 12),
    status: 'connected',
    pluginVersion: '2.0.0-alpha.8',
    capabilities: { multi_publication_v2: true },
    reportedState: {},
    desiredSequence: 0,
    desiredStateHash: null,
    publicKeyId: descriptor.key_id,
    version: 1,
  });
  const artifact = authenticatedArtifactFixture({
    id: 'artifact-group-inherited',
    projectId: 'project-clinic-inherited',
    body: '<h1>Landing heredada</h1>',
  });
  const publication = row({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    projectId: artifact.projectId,
    scopeType: 'clinic',
    clinicaId: 59,
    grupoClinicaId: null,
    path: '/cita/hospitalet/',
    wordpressInstallationId: installation.id,
    status: 'publishing',
    activeArtifactId: null,
    lastGoodArtifactId: null,
  });
  const deployment = row({
    id: 'deployment-group-inherited',
    publicationId: publication.id,
    artifactId: artifact.id,
    status: 'running',
    sequence: 1,
    storage: authenticatedDbStorageDescriptor({ artifact, installationId: installation.id, env }),
  });
  const clinic = {
    id_clinica: 59,
    grupoClinicaId: 5,
    estado_clinica: true,
  };
  const audits = [];
  const models = {
    Clinica: {
      async findByPk(id) { return Number(id) === clinic.id_clinica ? { ...clinic } : null; },
    },
    WebWordpressInstallation: {
      async findByPk(id) { return String(id) === installation.id ? installation : null; },
    },
    WebPublication: {
      async findAll() { return [publication]; },
      async count() { assert.fail('alpha.8 no necesita contar rutas heredadas'); },
    },
    WebPublicationDeployment: {
      async findAll() { return [deployment]; },
      async findOne() { return deployment; },
    },
    WebArtifact: {
      async findByPk(id) { return String(id) === artifact.id ? artifact : null; },
      async findOne({ where }) {
        return where.artifactHash === artifact.artifactHash ? artifact : null;
      },
    },
    IntakeConfig: { async findOne() { return null; } },
    WebAuditEvent: { async create(value) { audits.push(value); } },
  };
  const sequelize = {
    async transaction(callback) { return callback({ LOCK: { UPDATE: 'UPDATE' } }); },
  };
  const headers = {
    authorization: `Bearer ${token}`,
    pluginVersion: '2.0.0-alpha.8',
  };

  const desired = await getDesiredState({
    installationId: installation.id,
    headers,
    requestId: 'req-group-inherited-desired',
    models,
    sequelize,
    signingOptions: keys,
    env,
  });
  const registry = desired.response.desired_state.registry_configuration;
  assert.deepEqual(Object.keys(registry.routes), [publication.id]);
  assert.equal(registry.routes[publication.id].route_prefix, publication.path);
  assert.equal(registry.routes[publication.id].desired_artifact_hash, artifact.artifactHash);

  const authorized = await authorizedArtifactForInstallation({
    installation,
    requestedHash: artifact.artifactHash,
    callerSupportsMulti: true,
    models,
    env,
  });
  assert.equal(authorized.artifact.id, artifact.id);
  assert.equal(authorized.publication.id, publication.id);

  Object.assign(publication, {
    scopeType: 'group',
    clinicaId: null,
    grupoClinicaId: 5,
    configuration: { clinic_id: 59 },
  });
  const materializedDesired = await getDesiredState({
    installationId: installation.id,
    headers,
    requestId: 'req-group-materialized-desired',
    models,
    sequelize,
    signingOptions: keys,
    env,
  });
  const materializedRegistry = materializedDesired.response.desired_state.registry_configuration;
  assert.deepEqual(Object.keys(materializedRegistry.routes), [publication.id]);
  assert.equal((await authorizedArtifactForInstallation({
    installation,
    requestedHash: artifact.artifactHash,
    callerSupportsMulti: true,
    models,
    env,
  })).publication.id, publication.id);

  const route = {
    publication_id: publication.id,
    route_prefix: publication.path,
    status: 'active',
    active_artifact_hash: artifact.artifactHash,
    desired_artifact_hash: artifact.artifactHash,
    result: 'activated',
    error_code: null,
  };
  const report = {
    schema_version: 2,
    event: 'sync_result',
    request_id: 'req-group-inherited-ack',
    plugin_version: '2.0.0-alpha.8',
    site_hash: crypto.createHash('sha256').update(`${siteUrl}/`).digest('hex'),
    status: 'active',
    capabilities: { multi_publication_v2: true },
    registry_sequence: materializedRegistry.sequence,
    routes: { [publication.id]: route },
    reported_at: new Date().toISOString(),
  };
  const accepted = await recordReport({
    installationId: installation.id,
    headers,
    body: report,
    requestId: 'req-group-inherited-ack',
    models,
    sequelize,
    signingOptions: keys,
    env,
  });
  assert.equal(accepted.confirms_desired, true);
  assert.deepEqual(accepted.route_confirmations, { [publication.id]: true });
  assert.equal(audits.length, 1);

  clinic.grupoClinicaId = 8;
  const revokedDesired = await getDesiredState({
    installationId: installation.id,
    headers,
    requestId: 'req-group-inherited-revoked',
    models,
    sequelize,
    signingOptions: keys,
    env,
  });
  assert.deepEqual(revokedDesired.response.desired_state.registry_configuration.routes, {});
  assert.equal(await authorizedArtifactForInstallation({
    installation,
    requestedHash: artifact.artifactHash,
    callerSupportsMulti: true,
    models,
    env,
  }), null);
  await assert.rejects(
    () => recordReport({
      installationId: installation.id,
      headers,
      body: { ...report, reported_at: new Date().toISOString() },
      requestId: 'req-group-inherited-stale-ack',
      models,
      sequelize,
      signingOptions: keys,
      env,
    }),
    (error) => error.code === 'web_installation_report_route_set_mismatch'
  );
  clinic.grupoClinicaId = 5;
  clinic.estado_clinica = false;
  const inactiveDesired = await getDesiredState({
    installationId: installation.id,
    headers,
    requestId: 'req-group-materialized-inactive',
    models,
    sequelize,
    signingOptions: keys,
    env,
  });
  assert.deepEqual(inactiveDesired.response.desired_state.registry_configuration.routes, {});
  assert.equal(await authorizedArtifactForInstallation({
    installation,
    requestedHash: artifact.artifactHash,
    callerSupportsMulti: true,
    models,
    env,
  }), null);
  clearAuthenticatedArtifactCache();
});

test('el registro v2 es determinista y autoriza todos sus artefactos sin relajar la instalación', async () => {
  const keys = signingOptions();
  const env = { MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com' };
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const installation = row({
    id: '11111111-1111-4111-8111-111111111111',
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    tokenHash: tokenHash(token),
    status: 'connected',
    pluginVersion: '2.0.0-alpha.8',
    capabilities: { multi_publication_v2: true },
    desiredSequence: 0,
    desiredStateHash: null,
    publicKeyId: null,
  });
  installation.publicKeyId = require('../../services/webWordpressInstallations.service')
    .pluginKeyDescriptor(keys).key_id;

  const pilotId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const childId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const pilotArtifact = authenticatedArtifactFixture({
    id: 'artifact-pilot', projectId: 'project-pilot', body: '<h1>Piloto</h1>',
  });
  const childArtifact = authenticatedArtifactFixture({
    id: 'artifact-child', projectId: 'project-child', body: '<h1>Implantes</h1>',
  });
  const publications = [
    row({
      id: pilotId, projectId: pilotArtifact.projectId, path: '/cita/',
      scopeType: 'clinic', clinicaId: 56, grupoClinicaId: null,
      wordpressInstallationId: installation.id, status: 'publishing', activeArtifactId: null,
    }),
    row({
      id: childId, projectId: childArtifact.projectId, path: '/cita/implantes/',
      scopeType: 'clinic', clinicaId: 56, grupoClinicaId: null,
      wordpressInstallationId: installation.id, status: 'publishing', activeArtifactId: null,
    }),
  ];
  const artifacts = new Map([
    [pilotArtifact.id, pilotArtifact],
    [childArtifact.id, childArtifact],
  ]);
  const deployments = new Map(publications.map((publication) => {
    const artifact = publication.id === pilotId ? pilotArtifact : childArtifact;
    return [publication.id, row({
      id: `deployment-${publication.id}`,
      publicationId: publication.id,
      artifactId: artifact.id,
      status: 'running',
      sequence: 1,
      storage: authenticatedDbStorageDescriptor({ artifact, installationId: installation.id, env }),
    })];
  }));
  let publicationRead = 0;
  const models = {
    WebWordpressInstallation: {
      async findByPk() { return installation; },
    },
    WebPublication: {
      async findAll() {
        publicationRead += 1;
        return publicationRead % 2 === 1 ? [...publications] : [...publications].reverse();
      },
    },
    WebPublicationDeployment: {
      async findOne({ where }) { return deployments.get(where.publicationId) || null; },
      async findAll({ where }) {
        return [...deployments.values()].filter((deployment) => deployment.artifactId === where.artifactId);
      },
    },
    WebArtifact: {
      async findByPk(id) { return artifacts.get(id) || null; },
      async findOne({ where }) {
        return [...artifacts.values()].find((artifact) => artifact.artifactHash === where.artifactHash) || null;
      },
    },
    IntakeConfig: { async findOne() { return null; } },
    Clinica: { async findByPk() { return null; } },
  };
  const sequelize = {
    async transaction(callback) { return callback({ LOCK: { UPDATE: 'UPDATE' } }); },
  };
  const headers = { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.8' };
  const first = await getDesiredState({
    installationId: installation.id,
    headers,
    requestId: 'req-v2-first',
    models,
    sequelize,
    signingOptions: keys,
    env,
  });
  const second = await getDesiredState({
    installationId: installation.id,
    headers,
    requestId: 'req-v2-second',
    models,
    sequelize,
    signingOptions: keys,
    env,
  });

  const desired = first.response.desired_state;
  assert.equal(first.response.schema_version, 2);
  assert.equal(desired.status, 'multi');
  assert.equal(desired.runtime_configuration, undefined);
  assert.deepEqual(Object.keys(desired.registry_configuration.routes), [childId, pilotId]);
  assert.equal(desired.registry_configuration.routes[pilotId].route_prefix, '/cita/');
  assert.equal(desired.registry_configuration.routes[childId].route_prefix, '/cita/implantes/');
  assert.equal(desired.registry_configuration.sequence, 1);
  assert.equal(second.response.desired_state.registry_configuration.sequence, 1);
  assert.equal(first.etag, second.etag);
  assert.equal(
    verifyWebArtifactManifest(
      desired.registry_configuration,
      desired.registry_configuration_envelope,
      keys
    ),
    true
  );
  assert.deepEqual(
    Object.keys(desired.artifacts).sort(),
    [pilotArtifact.artifactHash, childArtifact.artifactHash].sort()
  );

  for (const artifact of [pilotArtifact, childArtifact]) {
    const resource = await getAuthenticatedArtifactResource({
      installationId: installation.id,
      artifactHash: artifact.artifactHash,
      resource: 'file',
      pathToken: pathToken('index.html'),
      headers,
      models,
      signingOptions: keys,
      env,
    });
    assert.equal(resource.body.toString('utf8'), artifact.files['index.html']);
  }
  await assert.rejects(
    () => getAuthenticatedArtifactResource({
      installationId: installation.id,
      artifactHash: 'f'.repeat(64),
      resource: 'manifest',
      headers,
      models,
      signingOptions: keys,
      env,
    }),
    (error) => error.code === 'web_installation_artifact_not_found'
  );
});

test('poll v2 de 20 rutas carga solo metadata y nunca los bodies de WebArtifact', async () => {
  const keys = signingOptions();
  const descriptor = pluginKeyDescriptor(keys);
  const env = { MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com' };
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const installation = row({
    id: '44444444-4444-4444-8444-444444444444',
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    tokenHash: tokenHash(token),
    status: 'connected',
    pluginVersion: '2.0.0-alpha.8',
    capabilities: { multi_publication_v2: true },
    reportedState: {},
    desiredSequence: 0,
    desiredStateHash: null,
    publicKeyId: descriptor.key_id,
  });
  const publications = [];
  const deployments = new Map();
  const metadata = new Map();
  for (let index = 0; index < 20; index += 1) {
    const suffix = String(index + 1).padStart(12, '0');
    const artifact = authenticatedArtifactFixture({
      id: `artifact-poll-${index}`,
      projectId: `project-poll-${index}`,
      body: `<h1>Ruta ${index}</h1>`,
    });
    const publication = row({
      id: `00000000-0000-4000-8000-${suffix}`,
      projectId: artifact.projectId,
      scopeType: 'clinic',
      clinicaId: 56,
      grupoClinicaId: null,
      path: index === 0 ? '/cita/' : `/cita/ruta-${index}/`,
      wordpressInstallationId: installation.id,
      status: 'publishing',
      activeArtifactId: null,
    });
    publications.push(publication);
    deployments.set(publication.id, row({
      id: `deployment-poll-${index}`,
      publicationId: publication.id,
      artifactId: artifact.id,
      status: 'running',
      sequence: 1,
      storage: authenticatedDbStorageDescriptor({ artifact, installationId: installation.id, env }),
    }));
    metadata.set(artifact.id, row({
      id: artifact.id,
      projectId: artifact.projectId,
      environment: artifact.environment,
      status: artifact.status,
      artifactHash: artifact.artifactHash,
      manifest: artifact.manifest,
    }));
  }
  let artifactReads = 0;
  const models = {
    WebWordpressInstallation: { async findByPk() { return installation; } },
    WebPublication: { async findAll() { return [...publications].reverse(); } },
    WebPublicationDeployment: {
      async findOne({ where }) { return deployments.get(where.publicationId) || null; },
    },
    WebArtifact: {
      async findByPk(id, options) {
        artifactReads += 1;
        assert.equal(options.attributes.includes('manifest'), true);
        assert.equal(options.attributes.includes('files'), false, 'poll v2 requested artifact bodies');
        return metadata.get(id) || null;
      },
    },
    IntakeConfig: { async findOne() { return null; } },
    Clinica: { async findByPk() { return null; } },
  };
  const sequelize = { async transaction(callback) { return callback({ LOCK: { UPDATE: 'UPDATE' } }); } };
  const result = await getDesiredState({
    installationId: installation.id,
    headers: { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.8' },
    requestId: 'req-20-route-metadata-poll',
    models,
    sequelize,
    signingOptions: keys,
    env,
  });
  assert.equal(Object.keys(result.response.desired_state.registry_configuration.routes).length, 20);
  assert.equal(Object.keys(result.response.desired_state.artifacts).length, 20);
  assert.equal(artifactReads, 20);
});

test('el reporte v2 aplica allowlist estricta a la secuencia y a cada ruta', () => {
  const publicationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const base = {
    schema_version: 2,
    event: 'sync_result',
    plugin_version: '2.0.0-alpha.8',
    site_hash: 'a'.repeat(64),
    status: 'active',
    capabilities: { multi_publication_v2: true },
    registry_sequence: 7,
    routes: {
      [publicationId]: {
        publication_id: publicationId,
        route_prefix: '/cita/implantes/',
        status: 'active',
        active_artifact_hash: 'b'.repeat(64),
        desired_artifact_hash: 'b'.repeat(64),
        result: 'activated',
        error_code: null,
      },
    },
    reported_at: new Date().toISOString(),
  };
  const normalized = normalizeReport(base);
  assert.equal(normalized.registry_sequence, 7);
  assert.equal(normalized.routes[publicationId].route_prefix, '/cita/implantes/');
  assert.deepEqual(normalized.capabilities, { multi_publication_v2: true });
  const signingKeyId = pluginKeyDescriptor(signingOptions()).key_id;
  const acknowledged = normalizeReport({
    ...base,
    signing_key_id: signingKeyId,
    configuration_sequence: 7,
  });
  assert.equal(acknowledged.signing_key_id, signingKeyId);
  assert.equal(acknowledged.configuration_sequence, 7);
  assert.throws(
    () => normalizeReport({ ...base, signing_key_id: signingKeyId }),
    (error) => error.code === 'web_installation_report_invalid'
  );
  assert.throws(
    () => normalizeReport({
      ...base,
      signing_key_id: signingKeyId,
      configuration_sequence: 6,
    }),
    (error) => error.code === 'web_installation_report_invalid'
  );
  assert.throws(
    () => normalizeReport({
      ...base,
      routes: {
        [publicationId]: { ...base.routes[publicationId], debug_trace: 'not-allowed' },
      },
    }),
    (error) => error.code === 'web_installation_report_invalid'
  );
  assert.throws(
    () => normalizeReport({ ...base, registry_sequence: -1 }),
    (error) => error.code === 'web_installation_report_invalid'
  );
  assert.throws(
    () => normalizeReport({
      ...base,
      routes: {
        [publicationId]: {
          ...base.routes[publicationId],
          publication_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      },
    }),
    (error) => error.code === 'web_installation_report_invalid'
  );
  assert.throws(
    () => normalizeReport({
      ...base,
      routes: {
        [publicationId]: {
          ...base.routes[publicationId],
          status: 'retired',
          desired_artifact_hash: null,
        },
      },
    }),
    (error) => error.code === 'web_installation_report_invalid'
  );
  assert.throws(
    () => normalizeReport({
      ...base,
      routes: {
        [publicationId]: {
          ...base.routes[publicationId],
          active_artifact_hash: null,
        },
      },
    }),
    (error) => error.code === 'web_installation_report_invalid'
  );
});

test('el reporte v2 normaliza solo la lista PHP vacía como mapa de rutas compatible', () => {
  const base = {
    schema_version: 2,
    event: 'heartbeat',
    plugin_version: '2.0.0-alpha.8',
    site_hash: 'a'.repeat(64),
    capabilities: { multi_publication_v2: true },
    registry_sequence: 0,
    reported_at: new Date().toISOString(),
  };
  assert.deepEqual(normalizeReport({ ...base, routes: [] }).routes, {});
  assert.throws(
    () => normalizeReport({ ...base, routes: [{ publication_id: crypto.randomUUID() }] }),
    (error) => error.code === 'web_installation_report_invalid'
  );
});

test('el heartbeat v2 registra capacidad sin exigir publicaciones ni confirmar un despliegue', async () => {
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const siteUrl = 'https://wordpress-heartbeat.example';
  const installation = row({
    id: '22222222-2222-4222-8222-222222222222',
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    siteUrl,
    siteUrlHash: crypto.createHash('sha256').update(siteUrl).digest('hex'),
    tokenHash: tokenHash(token),
    tokenPrefix: token.slice(0, 12),
    status: 'connected',
    pluginVersion: '2.0.0-alpha.7',
    capabilities: {},
    desiredSequence: 0,
    desiredStateHash: null,
    lastArtifactHash: null,
    version: 1,
  });
  const audits = [];
  const models = {
    WebWordpressInstallation: {
      async findByPk() { return installation; },
    },
    WebPublication: { async findAll() { return []; } },
    WebAuditEvent: { async create(value) { audits.push(value); } },
  };
  const sequelize = {
    async transaction(callback) { return callback({ LOCK: { UPDATE: 'UPDATE' } }); },
  };
  const result = await recordReport({
    installationId: installation.id,
    headers: { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.8' },
    body: {
      schema_version: 2,
      event: 'heartbeat',
      plugin_version: '2.0.0-alpha.8',
      site_hash: installation.siteUrlHash,
      status: 'empty',
      capabilities: { multi_publication_v2: true },
      registry_sequence: 0,
      routes: {},
      reported_at: new Date().toISOString(),
    },
    requestId: 'req-v2-heartbeat',
    models,
    sequelize,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.confirms_desired, false);
  assert.deepEqual(result.route_confirmations, {});
  assert.deepEqual(installation.capabilities, { multi_publication_v2: true });
  assert.equal(installation.pluginVersion, '2.0.0-alpha.8');
  assert.deepEqual(installation.reportedState.routes, {});
  assert.equal(audits.length, 1);
  assert.equal(audits[0].metadata.confirms_desired, false);
});

test('un downgrade alpha.7 con varias rutas queda outdated sin fallar por ambigüedad ni borrar capacidades en alpha.8', async () => {
  const execute = async (pluginVersion) => {
    const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
    const installation = row({
      id: crypto.randomUUID(),
      scopeType: 'clinic',
      clinicaId: 56,
      grupoClinicaId: null,
      siteUrl: 'https://cliente.example',
      tokenHash: tokenHash(token),
      tokenPrefix: token.slice(0, 12),
      status: 'connected',
      pluginVersion: '2.0.0-alpha.8',
      capabilities: { multi_publication_v2: true },
      reportedState: {},
      desiredSequence: 3,
      version: 2,
    });
    const models = {
      WebWordpressInstallation: { async findByPk() { return installation; } },
      WebPublication: {
        async findAll() {
          return [
            row({
              id: crypto.randomUUID(),
              scopeType: 'clinic',
              clinicaId: 56,
              grupoClinicaId: null,
              path: '/cita/',
              status: 'published',
            }),
            row({
              id: crypto.randomUUID(),
              scopeType: 'clinic',
              clinicaId: 56,
              grupoClinicaId: null,
              path: '/cita/implantes/',
              status: 'published',
            }),
          ];
        },
      },
      WebAuditEvent: { async create() {} },
    };
    const sequelize = { transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }) };
    const result = await recordReport({
      installationId: installation.id,
      headers: { authorization: `Bearer ${token}`, pluginVersion },
      body: {
        schema_version: 1,
        event: 'heartbeat',
        plugin_version: pluginVersion,
        site_hash: crypto.createHash('sha256').update('https://cliente.example/').digest('hex'),
        status: 'empty',
        result: 'activation_handshake',
        reported_at: new Date().toISOString(),
      },
      models,
      sequelize,
    });
    return { installation, result };
  };

  const downgraded = await execute('2.0.0-alpha.7');
  assert.equal(downgraded.result.accepted, true);
  assert.equal(downgraded.installation.status, 'outdated');
  assert.deepEqual(downgraded.installation.capabilities, {});

  const compatible = await execute('2.0.0-alpha.8');
  assert.equal(compatible.result.accepted, true);
  assert.equal(compatible.installation.status, 'connected');
  assert.deepEqual(compatible.installation.capabilities, { multi_publication_v2: true });
});

test('un sync_result v2 antiguo no confirma ni sobrescribe el registro vigente', async () => {
  const env = { MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com' };
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const siteUrl = 'https://wordpress-replay.example';
  const installation = row({
    id: '33333333-3333-4333-8333-333333333333',
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    siteUrl,
    siteUrlHash: crypto.createHash('sha256').update(siteUrl).digest('hex'),
    tokenHash: tokenHash(token),
    tokenPrefix: token.slice(0, 12),
    status: 'connected',
    pluginVersion: '2.0.0-alpha.8',
    capabilities: { multi_publication_v2: true },
    desiredSequence: 4,
    desiredStateHash: 'state-v4',
    lastArtifactHash: null,
    version: 1,
  });
  const artifact = authenticatedArtifactFixture({
    id: 'artifact-replay', projectId: 'project-replay', body: '<h1>Vigente</h1>',
  });
  const publication = row({
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    projectId: artifact.projectId,
    scopeType: 'clinic',
    clinicaId: 56,
    grupoClinicaId: null,
    path: '/cita/',
    wordpressInstallationId: installation.id,
    status: 'publishing',
    activeArtifactId: null,
  });
  const deployment = row({
    id: 'deployment-replay',
    publicationId: publication.id,
    artifactId: artifact.id,
    status: 'running',
    sequence: 1,
    storage: authenticatedDbStorageDescriptor({ artifact, installationId: installation.id, env }),
  });
  const audits = [];
  const models = {
    WebWordpressInstallation: {
      async findByPk() { return installation; },
    },
    WebPublication: { async findAll() { return [publication]; } },
    WebPublicationDeployment: { async findOne() { return deployment; } },
    WebArtifact: { async findByPk() { return artifact; } },
    WebAuditEvent: { async create(value) { audits.push(value); } },
  };
  const sequelize = {
    async transaction(callback) { return callback({ LOCK: { UPDATE: 'UPDATE' } }); },
  };
  const report = {
    schema_version: 2,
    event: 'sync_result',
    plugin_version: '2.0.0-alpha.8',
    site_hash: installation.siteUrlHash,
    status: 'active',
    capabilities: { multi_publication_v2: true },
    registry_sequence: 3,
    routes: {
      [publication.id]: {
        publication_id: publication.id,
        route_prefix: publication.path,
        status: 'active',
        active_artifact_hash: artifact.artifactHash,
        desired_artifact_hash: artifact.artifactHash,
        result: 'activated',
        error_code: null,
      },
    },
    reported_at: new Date().toISOString(),
  };
  const common = {
    installationId: installation.id,
    headers: { authorization: `Bearer ${token}`, pluginVersion: '2.0.0-alpha.8' },
    requestId: 'req-v2-replay',
    models,
    sequelize,
    env,
  };
  await assert.rejects(
    () => recordReport({ ...common, body: report }),
    (error) => error.code === 'web_installation_report_sequence_mismatch' && error.status === 409
  );
  assert.equal(installation.reportedState, undefined);
  assert.equal(installation.lastArtifactHash, null);
  assert.equal(audits.length, 0);

  const accepted = await recordReport({
    ...common,
    requestId: 'req-v2-current',
    body: { ...report, registry_sequence: 4, reported_at: new Date().toISOString() },
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.confirms_desired, true);
  assert.deepEqual(accepted.route_confirmations, { [publication.id]: true });
  assert.equal(installation.lastArtifactHash, artifact.artifactHash);
  assert.equal(installation.reportedState.registry_sequence, 4);
  assert.equal(audits.length, 1);

  const stableAck = installation.reportedState.confirmed_routes[publication.id];
  assert.equal(stableAck.registry_sequence, 4);
  assert.equal(stableAck.artifact_hash, artifact.artifactHash);
  await recordReport({
    ...common,
    requestId: 'req-v2-heartbeat-after-success',
    body: {
      schema_version: 2,
      event: 'heartbeat',
      plugin_version: '2.0.0-alpha.8',
      site_hash: installation.siteUrlHash,
      capabilities: { multi_publication_v2: true },
      registry_sequence: 4,
      routes: {
        [publication.id]: {
          publication_id: publication.id,
          route_prefix: publication.path,
          status: 'active',
          active_artifact_hash: artifact.artifactHash,
        },
      },
      reported_at: new Date().toISOString(),
    },
  });
  assert.deepEqual(installation.reportedState.confirmed_routes[publication.id], stableAck);
  assert.equal(installation.reportedState.event, 'heartbeat');

  const contradicted = await recordReport({
    ...common,
    requestId: 'req-v2-contradictory-result',
    body: {
      ...report,
      registry_sequence: 4,
      routes: {
        [publication.id]: {
          ...report.routes[publication.id],
          result: 'failed',
          error_code: 'ccw_post_promote_failure',
        },
      },
      reported_at: new Date().toISOString(),
    },
  });
  assert.equal(contradicted.route_confirmations[publication.id], false);
  assert.equal(installation.reportedState.confirmed_routes[publication.id], undefined);
});

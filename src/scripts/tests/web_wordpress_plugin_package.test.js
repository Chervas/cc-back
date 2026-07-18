'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  issueBootstrapTicket,
  openBootstrapTicket,
} = require('../../lib/webWordpressBootstrapTicket');
const {
  buildProvisionedPluginPackage,
  crc32,
  provisionWordpressPluginPackage,
} = require('../../services/webWordpressPluginPackage.service');
const {
  pluginKeyDescriptor,
  recordReport,
  tokenHash,
} = require('../../services/webWordpressInstallations.service');

const env = { MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY: crypto.randomBytes(32).toString('base64url') };

function credentials() {
  return {
    installation_id: 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44',
    api_base: 'https://crm.clinicaclick.com',
    token: `ccw_${'a'.repeat(43)}`,
    trust_descriptor: {
      schema_version: 1,
      algorithm: 'Ed25519',
      key_id: 'ed25519-0123456789abcdef',
      public_key_base64: 'A'.repeat(43) + '=',
    },
    bootstrap_runtime_configuration: {
      schema_version: 1,
      installation_id: 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44',
      sequence: 1,
      status: 'active',
      route_prefix: '/cita',
      desired_artifact_hash: 'b'.repeat(64),
      measurement: { enabled: false },
    },
    bootstrap_runtime_envelope: {
      signature_version: 1,
      algorithm: 'Ed25519',
      key_id: 'ed25519-0123456789abcdef',
      manifest_sha256: 'c'.repeat(64),
      signature: 'Z'.repeat(86) + '==',
    },
  };
}

test('ticket opaco liga instalación y actor, caduca y detecta manipulación', () => {
  const now = Date.UTC(2026, 6, 17, 12, 0, 0);
  const issued = issueBootstrapTicket({
    installationId: credentials().installation_id,
    actorId: 77,
    token: credentials().token,
    env,
    now,
  });
  assert.doesNotMatch(issued.ticket, new RegExp(credentials().token));
  const opened = openBootstrapTicket(issued.ticket, { env, now: now + 60_000 });
  assert.equal(opened.installation_id, credentials().installation_id);
  assert.equal(opened.actor_id, 77);
  assert.equal(opened.token, credentials().token);
  // Changing the final base64url character can alter only unused padding bits
  // and occasionally decode to the same bytes. Mutate authenticated payload
  // bytes in the middle so this security assertion is deterministic.
  const tamperIndex = Math.floor(issued.ticket.length / 2);
  const originalCharacter = issued.ticket[tamperIndex];
  const tamperedTicket = `${issued.ticket.slice(0, tamperIndex)}${originalCharacter === 'A' ? 'B' : 'A'}${issued.ticket.slice(tamperIndex + 1)}`;
  assert.throws(
    () => openBootstrapTicket(tamperedTicket, { env, now: now + 60_000 }),
    (error) => error.code === 'web_wordpress_bootstrap_ticket_invalid'
  );
  assert.throws(
    () => openBootstrapTicket(issued.ticket, { env, now: now + 16 * 60_000 }),
    (error) => error.code === 'web_wordpress_bootstrap_ticket_invalid'
  );
});

test('genera un ZIP provisionado mantenido, acotado y sin fuentes de test', async () => {
  const first = await buildProvisionedPluginPackage({ credentials: credentials() });
  const second = await buildProvisionedPluginPackage({ credentials: credentials() });
  assert.equal(first.filename, 'clinicaclick-web.zip');
  assert.equal(first.plugin_version, '2.0.0-alpha.3');
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.buffer, second.buffer);
  assert.equal(first.buffer.readUInt32LE(0), 0x04034b50);
  assert.equal(first.buffer.readUInt32LE(first.buffer.length - 22), 0x06054b50);
  assert.ok(first.entries.includes('clinicaclick-web/config/installation.php'));
  assert.ok(first.entries.includes('clinicaclick-web/clinicaclick.php'));
  assert.equal(first.entries.every((name) => name.startsWith('clinicaclick-web/')), true);
  assert.equal(first.entries.some((name) => name.startsWith('clinicaclick/')), false);
  assert.equal(first.buffer.includes(Buffer.from('Plugin Name: ClinicaClick Web Publisher')), true);
  assert.ok(first.entries.some((name) => name.endsWith('class-ccw-intake-bridge.php')));
  assert.equal(first.entries.some((name) => /(?:tests|fixtures|dist|tools)\//.test(name)), false);
  assert.equal(first.buffer.includes(Buffer.from(credentials().token)), true);
  assert.equal(first.size_bytes < 4 * 1024 * 1024, true);
});

test('CRC32 coincide con el vector estándar de ZIP', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('un hash de instalación malformado falla cerrado sin excepción criptográfica', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signingOptions = {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const bootstrapEnv = {
    MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY: crypto.randomBytes(32).toString('base64url'),
    MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com',
  };
  const ticket = issueBootstrapTicket({
    installationId: credentials().installation_id,
    actorId: 77,
    token,
    env: bootstrapEnv,
  });
  await assert.rejects(
    () => provisionWordpressPluginPackage({
      actorId: 77,
      installationId: credentials().installation_id,
      bootstrapTicket: ticket.ticket,
      env: bootstrapEnv,
      models: { WebAuditEvent: { create: async () => {} } },
      signingOptions,
      getInstallation: async () => ({
        installation: {
          id: credentials().installation_id,
          status: 'pending',
          tokenHash: 'invalid-short-hash',
          publicKeyId: pluginKeyDescriptor(signingOptions).key_id,
        },
        scope: { type: 'clinic', id: 66 },
      }),
    }),
    (error) => error.code === 'web_wordpress_bootstrap_ticket_invalid' && error.status === 410
  );
});

test('una instalación pending completa el handshake y una retirada confirmada invalida su hash activo', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signingOptions = {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  const token = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  const installation = {
    id: 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    siteUrl: 'https://cliente.example.test',
    tokenHash: tokenHash(token),
    tokenPrefix: token.slice(0, 12),
    status: 'pending',
    publicKeyId: pluginKeyDescriptor(signingOptions).key_id,
    version: 1,
    async update(patch) { Object.assign(this, patch); return this; },
    get() { return { ...this }; },
  };
  const bootstrapEnv = {
    MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY: crypto.randomBytes(32).toString('base64url'),
    MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com',
  };
  const ticket = issueBootstrapTicket({
    installationId: installation.id,
    actorId: 77,
    token,
    env: bootstrapEnv,
  });
  const audits = [];
  const packageModels = { WebAuditEvent: { create: async (value) => audits.push(value) } };
  const archive = await provisionWordpressPluginPackage({
    actorId: 77,
    installationId: installation.id,
    bootstrapTicket: ticket.ticket,
    env: bootstrapEnv,
    models: packageModels,
    signingOptions,
    getInstallation: async () => ({ installation, scope: { type: 'clinic', id: 66 } }),
  });
  assert.equal(archive.filename, 'clinicaclick-web.zip');
  assert.equal(installation.status, 'pending');
  assert.equal(audits[0].metadata.bootstrap_status, 'pending');

  const handshakeModels = {
    WebWordpressInstallation: {
      findOne: async () => installation,
      findByPk: async () => installation,
    },
    WebPublication: { findAll: async () => [] },
    WebAuditEvent: { create: async (value) => audits.push(value) },
  };
  const sequelize = {
    transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }),
  };
  const report = await recordReport({
    installationId: installation.id,
    headers: { authorization: `Bearer ${token}`, pluginVersion: archive.plugin_version },
    body: {
      schema_version: 1,
      event: 'heartbeat',
      plugin_version: archive.plugin_version,
      wordpress_version: '6.6',
      php_version: '8.2.0',
      site_hash: crypto.createHash('sha256').update(`${installation.siteUrl}/`).digest('hex'),
      status: 'empty',
      result: 'activation_handshake',
      duration_ms: 0,
      reported_at: new Date().toISOString(),
    },
    models: handshakeModels,
    sequelize,
  });
  assert.equal(report.accepted, true);
  assert.equal(installation.status, 'connected');
  assert.equal(installation.pluginVersion, archive.plugin_version);

  installation.lastArtifactHash = 'a'.repeat(64);
  handshakeModels.WebPublication.findAll = async () => [{
    id: 'failed-publication-1',
    projectId: 'failed-project-1',
    wordpressInstallationId: installation.id,
    status: 'failed',
    activeArtifactId: null,
    lastGoodArtifactId: null,
  }];
  const retired = await recordReport({
    installationId: installation.id,
    headers: { authorization: `Bearer ${token}`, pluginVersion: archive.plugin_version },
    body: {
      schema_version: 1,
      event: 'sync_result',
      plugin_version: archive.plugin_version,
      wordpress_version: '6.6',
      php_version: '8.2.0',
      site_hash: crypto.createHash('sha256').update(`${installation.siteUrl}/`).digest('hex'),
      status: 'retired',
      active_artifact_hash: 'a'.repeat(64),
      result: 'retired',
      duration_ms: 3,
      reported_at: new Date().toISOString(),
    },
    models: handshakeModels,
    sequelize,
  });
  assert.equal(retired.confirms_desired, true);
  assert.equal(installation.lastArtifactHash, null, 'retirar debe invalidar el hash activo del handshake');
});

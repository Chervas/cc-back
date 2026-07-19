'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260719100000-claim-wordpress-site-ownership');
const { resolveSafeHttpTarget } = require('../../lib/safeHttpTarget');
const {
  createInstallation,
  getDesiredState,
  pluginKeyDescriptor,
  recordReport,
  revokeInstallation,
  tokenHash,
} = require('../../services/webWordpressInstallations.service');
const {
  SITE_CLAIM_PATH,
  verifyWordpressSiteClaim,
} = require('../../services/webWordpressSiteClaim.service');

function signingOptions() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function modelRow(value, rows = []) {
  return {
    ...value,
    get() { return { ...this }; },
    async update(patch) {
      if (patch.claimedSiteHash) {
        const conflict = rows.find((candidate) => (
          candidate !== this
          && ['connected', 'outdated'].includes(candidate.status)
          && candidate.claimedSiteHash === patch.claimedSiteHash
        ));
        if (conflict) {
          const error = new Error('duplicate claimed_site_hash');
          error.name = 'SequelizeUniqueConstraintError';
          throw error;
        }
      }
      Object.assign(this, patch);
      return this;
    },
  };
}

function pendingInstallation({ id = crypto.randomUUID(), siteUrl, clinicId = 66, groupId = null } = {}) {
  const rawClaim = crypto.randomBytes(32).toString('base64url');
  const bearer = `ccw_${crypto.randomBytes(32).toString('base64url')}`;
  return {
    rawClaim,
    bearer,
    value: {
      id,
      scopeType: groupId ? 'group' : 'clinic',
      clinicaId: groupId ? null : clinicId,
      grupoClinicaId: groupId || null,
      siteUrl,
      siteUrlHash: tokenHash(siteUrl),
      claimedSiteHash: null,
      siteClaimTokenHash: tokenHash(rawClaim),
      siteClaimIssuedAt: new Date(),
      siteClaimExpiresAt: new Date(Date.now() + 60_000),
      siteClaimedAt: null,
      tokenHash: tokenHash(bearer),
      tokenPrefix: bearer.slice(0, 12),
      nextTokenHash: null,
      nextTokenPrefix: null,
      nextTokenIssuedAt: null,
      nextTokenExpiresAt: null,
      status: 'pending',
      pluginVersion: null,
      capabilities: {},
      reportedState: {},
      publicKeyId: null,
      desiredSequence: 0,
      desiredStateHash: null,
      version: 1,
    },
  };
}

function reportBody(installation, pluginVersion = '2.0.0-alpha.8') {
  return {
    schema_version: 2,
    event: 'heartbeat',
    plugin_version: pluginVersion,
    wordpress_version: '6.8.3',
    php_version: '8.2.0',
    site_hash: tokenHash(`${installation.siteUrl}/`),
    status: 'empty',
    result: 'activation_handshake',
    capabilities: { multi_publication_v2: true },
    registry_sequence: 0,
    routes: {},
    duration_ms: 0,
    reported_at: new Date().toISOString(),
  };
}

function installationModels(rows) {
  const audits = [];
  const model = {
    async findByPk(id) { return rows.find((candidate) => candidate.id === String(id)) || null; },
    async findOne({ where }) {
      return rows.find((candidate) => Object.entries(where).every(([key, value]) => candidate[key] === value)) || null;
    },
    async create(value) {
      const created = modelRow(value, rows);
      rows.push(created);
      return created;
    },
  };
  return {
    models: {
      WebWordpressInstallation: model,
      Clinica: { async findByPk() { return { id_clinica: 66 }; } },
      GrupoClinica: { async findByPk() { return { id_grupo: 9 }; } },
      WebPublication: {
        async findAll() { return []; },
        async count() { return 0; },
      },
      WebAuditEvent: { async create(value) { audits.push(value); return value; } },
    },
    audits,
  };
}

function serialSequelize() {
  let tail = Promise.resolve();
  return {
    transaction(callback) {
      const result = tail.then(() => callback({ LOCK: { UPDATE: 'UPDATE' } }));
      tail = result.catch(() => {});
      return result;
    },
  };
}

function successfulClaimVerifier() {
  return async ({ installationId, siteUrl, expectedClaimTokenHash }) => ({
    installation_id: installationId,
    site_url: siteUrl,
    site_url_hash: tokenHash(siteUrl),
    claim_token_hash: expectedClaimTokenHash,
  });
}

test('el verifier hace GET real fijado a DNS público y exige identidad, digest y home exactos', async () => {
  const installationId = crypto.randomUUID();
  const digest = tokenHash('challenge');
  const addresses = [{ address: '93.184.216.34', family: 4 }];
  const destroyed = [];
  const resolveTarget = async (url) => ({
    url,
    hostname: 'cliente.example',
    addresses,
    httpAgent: { destroy() { destroyed.push('http'); } },
    httpsAgent: { destroy() { destroyed.push('https'); } },
  });
  let requested = null;
  const httpClient = {
    async get(url, options) {
      requested = { url, options };
      return {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        data: JSON.stringify({
          installation_id: installationId,
          claim_token_sha256: digest,
          canonical_home_url: 'https://cliente.example',
        }),
      };
    },
  };
  const proof = await verifyWordpressSiteClaim({
    installationId,
    siteUrl: 'https://cliente.example',
    expectedClaimTokenHash: digest,
    httpClient,
    resolveTarget,
    resolveAddresses: async () => addresses,
  });
  assert.equal(requested.url, `https://cliente.example${SITE_CLAIM_PATH}`);
  assert.equal(requested.options.maxRedirects, 0);
  assert.equal(requested.options.proxy, false);
  assert.equal(requested.options.decompress, false);
  assert.equal(requested.options.maxContentLength, 4096);
  assert.equal(proof.site_url_hash, tokenHash('https://cliente.example'));
  assert.deepEqual(destroyed.sort(), ['http', 'https']);
});

test('el verifier bloquea IP privada, rebinding, redirects, MIME y documentos de otra instalación', async () => {
  const installationId = crypto.randomUUID();
  const digest = tokenHash('challenge');
  const publicAddresses = [{ address: '93.184.216.34', family: 4 }];
  const baseTarget = async (url) => ({
    url,
    hostname: 'cliente.example',
    addresses: publicAddresses,
    httpAgent: { destroy() {} },
    httpsAgent: { destroy() {} },
  });
  const document = {
    installation_id: installationId,
    claim_token_sha256: digest,
    canonical_home_url: 'https://cliente.example',
  };
  const response = (patch = {}) => ({
    get: async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify(document),
      ...patch,
    }),
  });
  const common = {
    installationId,
    siteUrl: 'https://cliente.example',
    expectedClaimTokenHash: digest,
    resolveTarget: baseTarget,
    resolveAddresses: async () => publicAddresses,
  };
  await assert.rejects(
    verifyWordpressSiteClaim({
      ...common,
      resolveTarget: (url) => resolveSafeHttpTarget(url, {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
      httpClient: response(),
    }),
    (error) => error.code === 'web_wordpress_site_claim_target_blocked'
  );
  await assert.rejects(
    verifyWordpressSiteClaim({
      ...common,
      httpClient: response(),
      resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
    }),
    (error) => error.code === 'web_wordpress_site_claim_dns_changed'
  );
  await assert.rejects(
    verifyWordpressSiteClaim({ ...common, httpClient: response({ status: 302, headers: { location: 'https://cliente.example/elsewhere' } }) }),
    (error) => error.code === 'web_wordpress_site_claim_redirect_blocked'
  );
  await assert.rejects(
    verifyWordpressSiteClaim({ ...common, httpClient: response({ headers: { 'content-type': 'text/html' } }) }),
    (error) => error.code === 'web_wordpress_site_claim_invalid'
  );
  await assert.rejects(
    verifyWordpressSiteClaim({
      ...common,
      httpClient: response({ data: JSON.stringify({ ...document, installation_id: crypto.randomUUID() }) }),
    }),
    (error) => error.code === 'web_wordpress_site_claim_mismatch'
  );
});

test('pending de scopes distintos no reserva la URL y reemitir el mismo scope conserva el id', async () => {
  const rows = [];
  const { models } = installationModels(rows);
  const sequelize = serialSequelize();
  const env = {
    MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY: crypto.randomBytes(32).toString('base64url'),
    MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com',
  };
  const keys = signingOptions();
  const common = {
    actorId: 77,
    requestId: 'req-site-claim-create',
    models,
    sequelize,
    assertAccess: async () => {},
    assertPublishing: () => {},
    signingOptions: keys,
    env,
  };
  const clinic = await createInstallation({
    ...common,
    body: { scope_type: 'clinic', clinic_id: 66, site_url: 'https://cliente.example' },
  });
  const group = await createInstallation({
    ...common,
    body: { scope_type: 'group', group_id: 9, site_url: 'https://cliente.example' },
  });
  assert.notEqual(clinic.installation.id, group.installation.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.every((candidate) => candidate.status === 'pending' && candidate.claimedSiteHash === null), true);
  const reissued = await createInstallation({
    ...common,
    body: { scope_type: 'clinic', clinic_id: 66, site_url: 'https://cliente.example' },
  });
  assert.equal(reissued.installation.id, clinic.installation.id);
  assert.equal(rows.length, 2);
});

test('un bearer sin controlar la web no reclama; claim válido gana la carrera y revoke libera para un nuevo challenge', async () => {
  const first = pendingInstallation({ siteUrl: 'https://victim.example', clinicId: 66 });
  const second = pendingInstallation({ siteUrl: 'https://victim.example', clinicId: 67 });
  const rows = [];
  rows.push(modelRow(first.value, rows), modelRow(second.value, rows));
  const { models } = installationModels(rows);
  const sequelize = serialSequelize();
  const report = (candidate, verifySiteClaim) => recordReport({
    installationId: candidate.id,
    headers: { authorization: `Bearer ${candidate.tokenHash === tokenHash(first.bearer) ? first.bearer : second.bearer}`, pluginVersion: '2.0.0-alpha.8' },
    body: reportBody(candidate),
    requestId: `req-${candidate.id}`,
    models,
    sequelize,
    verifySiteClaim,
  });

  await assert.rejects(
    report(rows[0], async () => {
      const error = new Error('victim endpoint missing');
      error.code = 'web_wordpress_site_claim_mismatch';
      throw error;
    }),
    (error) => error.code === 'web_wordpress_site_claim_mismatch'
  );
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].claimedSiteHash, null);

  const race = await Promise.allSettled([
    report(rows[0], successfulClaimVerifier()),
    report(rows[1], successfulClaimVerifier()),
  ]);
  assert.equal(race.filter((item) => item.status === 'fulfilled').length, 1);
  const loser = race.find((item) => item.status === 'rejected');
  assert.equal(loser.reason.code, 'web_wordpress_site_claim_conflict');
  const winnerRow = rows.find((candidate) => candidate.status === 'connected');
  const loserRow = rows.find((candidate) => candidate.status === 'pending');
  assert.equal(winnerRow.claimedSiteHash, tokenHash('https://victim.example'));
  assert.equal(winnerRow.siteClaimTokenHash, null);

  await revokeInstallation({
    actorId: 77,
    installationId: winnerRow.id,
    requestId: 'req-revoke-claim',
    models,
    sequelize,
    assertAccess: async () => {},
  });
  assert.equal(winnerRow.status, 'revoked');
  assert.equal(winnerRow.claimedSiteHash, null);
  const reused = await report(loserRow, successfulClaimVerifier());
  assert.equal(reused.site_claim_acknowledged, true);
  assert.equal(loserRow.status, 'connected');
});

test('pending no puede leer desired-state antes del GET de control', async () => {
  const pending = pendingInstallation({ siteUrl: 'https://cliente.example' });
  const rows = [];
  rows.push(modelRow(pending.value, rows));
  const { models } = installationModels(rows);
  await assert.rejects(
    getDesiredState({
      installationId: rows[0].id,
      headers: { authorization: `Bearer ${pending.bearer}`, pluginVersion: '2.0.0-alpha.8' },
      requestId: 'req-pending-desired',
      models,
      sequelize: serialSequelize(),
      signingOptions: signingOptions(),
    }),
    (error) => error.code === 'web_wordpress_site_claim_required'
  );
});

function fakeMigrationInterface({ duplicateConnected = false, rowCount = 0, failClaimIndexOnce = false } = {}) {
  const columns = {
    site_url_hash: {}, status: {}, last_seen_at: {}, updated_at: {}, created_at: {},
  };
  const indexes = [{
    name: 'uniq_web_wordpress_site_url_hash', unique: true,
    fields: [{ attribute: 'site_url_hash' }],
  }];
  const calls = [];
  let remainingClaimIndexFailures = failClaimIndexOnce ? 1 : 0;
  const queryInterface = {
    calls,
    columns,
    indexes,
    queryGenerator: {
      quoteTable: (value) => `\`${value}\``,
      quoteIdentifier: (value) => `\`${value}\``,
    },
    sequelize: {
      async query(sql) {
        calls.push(['query', sql]);
        if (/GROUP BY/.test(sql)) {
          return duplicateConnected ? [{ site_url_hash: 'a'.repeat(64), installation_count: 2 }] : [];
        }
        if (/SELECT COUNT\(\*\)/.test(sql)) return [{ installation_count: rowCount }];
        return [];
      },
    },
    async describeTable() { return { ...columns }; },
    async showIndex() { return indexes.map((entry) => ({ ...entry, fields: entry.fields.map((field) => ({ ...field })) })); },
    async addColumn(_table, name, definition) { calls.push(['addColumn', name]); columns[name] = definition; },
    async removeColumn(_table, name) { calls.push(['removeColumn', name]); delete columns[name]; },
    async addIndex(_table, fields, options) {
      calls.push(['addIndex', options.name]);
      if (options.name === 'uniq_web_wordpress_claimed_site_hash' && remainingClaimIndexFailures > 0) {
        remainingClaimIndexFailures -= 1;
        throw new Error('simulated UNIQUE DDL failure');
      }
      indexes.push({ name: options.name, unique: Boolean(options.unique), fields: fields.map((attribute) => ({ attribute })) });
    },
    async removeIndex(_table, name) {
      calls.push(['removeIndex', name]);
      const position = indexes.findIndex((entry) => entry.name === name);
      if (position >= 0) indexes.splice(position, 1);
    },
  };
  return queryInterface;
}

test('migración hace preflight/backfill y crea UNIQUE claimed antes de liberar pending', async () => {
  const duplicate = fakeMigrationInterface({ duplicateConnected: true });
  await assert.rejects(
    migration.up(duplicate, Sequelize),
    (error) => error.code === 'web_wordpress_site_claim_connected_duplicates'
  );
  assert.equal(duplicate.calls.some(([operation]) => operation === 'addColumn'), false);

  const queryInterface = fakeMigrationInterface();
  await migration.up(queryInterface, Sequelize);
  const addClaim = queryInterface.calls.findIndex((call) => call[0] === 'addIndex' && call[1] === 'uniq_web_wordpress_claimed_site_hash');
  const removeLegacy = queryInterface.calls.findIndex((call) => call[0] === 'removeIndex' && call[1] === 'uniq_web_wordpress_site_url_hash');
  assert.ok(addClaim >= 0 && removeLegacy > addClaim);
  assert.ok(queryInterface.calls.some((call) => call[0] === 'query' && /status.*connected.*outdated/i.test(call[1])));
  assert.ok(queryInterface.indexes.some((entry) => entry.name === 'uniq_web_wordpress_claimed_site_hash' && entry.unique));
  assert.ok(queryInterface.indexes.some((entry) => entry.name === 'idx_web_wordpress_site_url_hash' && !entry.unique));
});

test('fallo DDL conserva legacy y un rerun completa la migración sin ventana insegura', async () => {
  const queryInterface = fakeMigrationInterface({ failClaimIndexOnce: true });
  await assert.rejects(migration.up(queryInterface, Sequelize), /simulated UNIQUE DDL failure/);
  assert.ok(queryInterface.indexes.some((entry) => entry.name === 'uniq_web_wordpress_site_url_hash' && entry.unique));
  assert.equal(queryInterface.indexes.some((entry) => entry.name === 'uniq_web_wordpress_claimed_site_hash'), false);
  await migration.up(queryInterface, Sequelize);
  assert.equal(queryInterface.indexes.some((entry) => entry.name === 'uniq_web_wordpress_site_url_hash'), false);
  assert.ok(queryInterface.indexes.some((entry) => entry.name === 'uniq_web_wordpress_claimed_site_hash' && entry.unique));
  const mutations = queryInterface.calls.length;
  await migration.up(queryInterface, Sequelize);
  assert.equal(
    queryInterface.calls.slice(mutations).some(([operation]) => ['addColumn', 'addIndex', 'removeIndex'].includes(operation)),
    false
  );
});

test('down falla cerrado con filas y, vacío, restaura legacy antes de retirar claim', async () => {
  const blocked = fakeMigrationInterface({ rowCount: 1 });
  await assert.rejects(
    migration.down(blocked, Sequelize),
    (error) => error.code === 'web_wordpress_site_claim_down_blocked'
  );
  assert.equal(blocked.calls.some(([operation]) => ['addIndex', 'removeIndex', 'removeColumn'].includes(operation)), false);

  const empty = fakeMigrationInterface({ rowCount: 0 });
  empty.indexes.splice(0, 1,
    { name: 'idx_web_wordpress_site_url_hash', unique: false, fields: [{ attribute: 'site_url_hash' }] },
    { name: 'uniq_web_wordpress_claimed_site_hash', unique: true, fields: [{ attribute: 'claimed_site_hash' }] });
  for (const name of ['claimed_site_hash', 'site_claim_token_hash', 'site_claim_issued_at', 'site_claim_expires_at', 'site_claimed_at']) {
    empty.columns[name] = {};
  }
  await migration.down(empty, Sequelize);
  const addLegacy = empty.calls.findIndex((call) => call[0] === 'addIndex' && call[1] === 'uniq_web_wordpress_site_url_hash');
  const removeClaim = empty.calls.findIndex((call) => call[0] === 'removeIndex' && call[1] === 'uniq_web_wordpress_claimed_site_hash');
  assert.ok(addLegacy >= 0 && removeClaim > addLegacy);
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Op } = require('sequelize');

const {
  DEFAULT_BATCH_SIZE,
  runWebPublicationHealthMonitor,
} = require('../../services/webPublicationHealthMonitor.service');

class Row {
  constructor(value, updateImpl = null) {
    Object.assign(this, value);
    this._updateImpl = updateImpl;
  }

  get() {
    const value = { ...this };
    delete value._updateImpl;
    return value;
  }

  async update(patch) {
    if (this._updateImpl) return this._updateImpl(patch, this);
    Object.assign(this, patch);
    return this;
  }
}

function publication(id, overrides = {}) {
  return new Row({
    id,
    projectId: `project-${id}`,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    channel: 'wordpress',
    host: 'clinic.example.test',
    path: `/${id}/`,
    status: 'published',
    activeArtifactId: `artifact-${id}`,
    health: { status: 'healthy' },
    lastHealthyAt: new Date('2026-07-17T10:00:00.000Z'),
    ...overrides,
  });
}

function artifact(id, overrides = {}) {
  return new Row({
    id,
    artifactHash: 'a'.repeat(64),
    manifest: { artifact_input_hash: 'b'.repeat(64) },
    ...overrides,
  });
}

function fixture({ publications, artifacts = {}, verify = async () => true } = {}) {
  const rows = publications || [publication('one')];
  const current = new Map(rows.map((row) => [row.id, row]));
  const artifactRows = new Map(Object.entries(artifacts));
  for (const row of rows) {
    if (!artifactRows.has(row.activeArtifactId)) {
      artifactRows.set(row.activeArtifactId, artifact(row.activeArtifactId));
    }
  }
  const audits = [];
  let query = null;
  let verifyCalls = 0;
  const verifyOptions = [];
  const models = {
    WebPublication: {
      async findAll(options) {
        query = options;
        return rows.slice(0, options.limit);
      },
      async findByPk(id) { return current.get(id) || null; },
    },
    WebArtifact: {
      async findByPk(id) { return artifactRows.get(id) || null; },
    },
    WebAuditEvent: {
      async create(value) { audits.push(value); return value; },
    },
  };
  const sequelize = {
    async transaction(callback) {
      return callback({ LOCK: { UPDATE: 'UPDATE' } });
    },
  };
  const dependencies = {
    models,
    sequelize,
    now: () => new Date('2026-07-18T12:00:00.000Z'),
    verifyPublicArtifact: async (options) => {
      verifyCalls += 1;
      verifyOptions.push(options);
      return verify(options);
    },
    verifyHostedPointer: async () => true,
    env: {},
  };
  return {
    rows, current, artifactRows, audits, models, dependencies,
    query: () => query,
    verifyCalls: () => verifyCalls,
    verifyOptions,
  };
}

test('selecciona únicamente publicaciones publicadas con artefacto activo y limita el lote', async () => {
  const state = fixture();
  const result = await runWebPublicationHealthMonitor({}, state.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(result.result.batch_size, DEFAULT_BATCH_SIZE);
  assert.equal(result.result.selected, 1);
  assert.equal(state.query().where.status, 'published');
  assert.equal(state.query().where.activeArtifactId[Op.ne], null);
  assert.equal(state.query().limit, DEFAULT_BATCH_SIZE);
  assert.deepEqual(state.query().order, [['updated_at', 'ASC'], ['id', 'ASC']]);
  assert.equal(state.verifyOptions[0].publicUrl, 'https://clinic.example.test/one/');
  assert.equal(state.verifyOptions[0].inputHash, 'b'.repeat(64));
  assert.equal(state.verifyOptions[0].attempts, 1);
});

test('actualiza lastHealthyAt sin auditar comprobaciones saludables repetidas', async () => {
  const state = fixture();
  const result = await runWebPublicationHealthMonitor({ jobRequestId: 401 }, state.dependencies);
  assert.equal(result.result.healthy, 1);
  assert.equal(result.result.unchanged, 1);
  assert.equal(result.result.failures, 0);
  assert.equal(state.rows[0].health.status, 'healthy');
  assert.equal(state.rows[0].health.monitor, 'scheduled_public_readback');
  assert.equal(state.rows[0].lastHealthyAt.toISOString(), '2026-07-18T12:00:00.000Z');
  assert.equal(state.audits.length, 0);
});

test('audita una sola degradación y una sola recuperación, no estados repetidos', async () => {
  const row = publication('transition');
  let providerHealthy = false;
  const state = fixture({ publications: [row], verify: async () => providerHealthy });

  const degraded = await runWebPublicationHealthMonitor({ jobRequestId: 402 }, state.dependencies);
  assert.equal(degraded.result.degraded, 1);
  assert.equal(row.health.status, 'unhealthy');
  assert.equal(row.health.reason, 'public_readback_failed');
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].eventType, 'web.publication.health_unhealthy');
  assert.equal(state.audits[0].requestId, 'job:402');

  const repeated = await runWebPublicationHealthMonitor({ jobRequestId: 403 }, state.dependencies);
  assert.equal(repeated.result.unchanged, 1);
  assert.equal(state.audits.length, 1);

  providerHealthy = true;
  const recovered = await runWebPublicationHealthMonitor({ jobRequestId: 404 }, state.dependencies);
  assert.equal(recovered.result.recovered, 1);
  assert.equal(row.health.status, 'healthy');
  assert.equal(state.audits.length, 2);
  assert.equal(state.audits[1].eventType, 'web.publication.health_recovered');
});

test('falla cerrado si falta el marcador y no llama a red ni fabrica una transición inicial', async () => {
  const row = publication('invalid', { health: {} });
  const state = fixture({ publications: [row] });
  state.artifactRows.set(row.activeArtifactId, artifact(row.activeArtifactId, {
    manifest: { artifact_input_hash: 'invalid' },
  }));

  const result = await runWebPublicationHealthMonitor({}, state.dependencies);
  assert.equal(result.result.unhealthy, 1);
  assert.equal(row.health.status, 'unhealthy');
  assert.equal(row.health.reason, 'active_artifact_marker_invalid');
  assert.equal(state.verifyCalls(), 0);
  assert.equal(state.audits.length, 0);
});

test('falla cerrado si el verificador lanza y conserva el fallo como resultado de salud', async () => {
  const row = publication('provider-error');
  const state = fixture({
    publications: [row],
    verify: async () => { throw new Error('simulated readback failure'); },
  });
  const result = await runWebPublicationHealthMonitor({}, state.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(result.result.unhealthy, 1);
  assert.equal(result.result.degraded, 1);
  assert.equal(result.result.failures, 0);
  assert.equal(row.health.reason, 'public_readback_failed');
});

test('valida todo el artefacto alojado antes del readback público', async () => {
  const row = publication('hosted-integrity', { channel: 'clinicaclick_hosted' });
  const state = fixture({ publications: [row] });
  let received = null;
  state.dependencies.verifyHostedPointer = async (options) => {
    received = options;
    return false;
  };

  const result = await runWebPublicationHealthMonitor({}, state.dependencies);
  assert.equal(result.result.unhealthy, 1);
  assert.equal(row.health.reason, 'hosted_artifact_integrity_failed');
  assert.equal(state.verifyCalls(), 0);
  assert.equal(received.artifactHash, 'a'.repeat(64));
  assert.equal(received.artifact.manifest.artifact_input_hash, 'b'.repeat(64));
});

test('no sobrescribe salud si el puntero activo cambia durante el readback', async () => {
  const snapshot = publication('stale');
  const state = fixture({ publications: [snapshot] });
  state.models.WebPublication.findByPk = async () => publication('stale', {
    activeArtifactId: 'artifact-new',
    health: { status: 'healthy', sentinel: true },
  });

  const result = await runWebPublicationHealthMonitor({}, state.dependencies);
  assert.equal(result.result.checked, 1);
  assert.equal(result.result.persisted, 0);
  assert.equal(result.result.skipped, 1);
  assert.equal(state.audits.length, 0);
});

test('un fallo individual se contabiliza y el JobRequest completa el resto sin retry de lote', async () => {
  const broken = publication('broken');
  broken._updateImpl = async () => {
    const error = new Error('write failed');
    error.code = 'TEST_WRITE_FAILED';
    throw error;
  };
  const good = publication('good');
  const state = fixture({ publications: [broken, good] });

  const result = await runWebPublicationHealthMonitor({ batchSize: 2 }, state.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(result.result.selected, 2);
  assert.equal(result.result.checked, 2);
  assert.equal(result.result.persisted, 1);
  assert.equal(result.result.failures, 1);
  assert.deepEqual(result.result.failure_codes, ['TEST_WRITE_FAILED']);
});

'use strict';

process.env.MARKETING_WEB_RUNTIME_ENVELOPE_KEY = Buffer.alloc(32, 11).toString('base64');
process.env.MARKETING_WEB_RUNTIME_ENVELOPE_KEY_ID = 'runtime-recovery-test-v1';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runtimeService = require('../../services/webIntakeRuntimeReconciliation.service');
const { decryptRuntimeSecret, encryptRuntimeSecret } = require('../../lib/webRuntimeSecretEnvelope');

const SOURCE_KEY = 'source-recovery-hmac-key-123456789';
const TARGET_KEY = 'target-recovery-hmac-key-987654321';

function intake(hmac, chatEnabled) {
  return {
    id: 77,
    assignment_scope: 'clinic',
    clinic_id: 55,
    group_id: null,
    hmac_key: hmac,
    config: {
      features: {
        consent_mode_enabled: true,
        consent_provider: 'clinicaclick',
        chat_enabled: chatEnabled,
        whatsapp_enabled: chatEnabled,
        tel_modal_enabled: false,
      },
    },
  };
}

function mutableRow(value) {
  return {
    ...value,
    get() { return { ...this }; },
    async update(patch) { Object.assign(this, patch); return this; },
  };
}

function sealFailed(value) {
  const row = { ...value };
  for (const slot of ['source', 'target']) {
    const key = slot === 'source' ? SOURCE_KEY : TARGET_KEY;
    row[`${slot}HmacEnvelope`] = encryptRuntimeSecret(key, {
      id: row.id,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      generation: row.generation,
      slot,
    });
  }
  return mutableRow(row);
}

function readEnvelope(row, slot) {
  return decryptRuntimeSecret(row[`${slot}HmacEnvelope`], {
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    generation: row.generation,
    slot,
  });
}

function artifact(id, runtimeConfigHash, marker) {
  return {
    id,
    projectId: 'project-1',
    revisionId: `revision-${id}`,
    artifactHash: marker.repeat(64),
    runtimeConfigHash,
    status: 'ready',
    environment: 'production',
  };
}

function baseState({ active = 'source' } = {}) {
  const source = intake(SOURCE_KEY, false);
  const target = intake(TARGET_KEY, true);
  const sourceArtifact = artifact(
    'artifact-source', runtimeService.runtimeHashForRecord(source), 'a'
  );
  const targetArtifact = artifact(
    'artifact-target', runtimeService.runtimeHashForRecord(target), 'b'
  );
  const publication = mutableRow({
    id: 'publication-1',
    projectId: 'project-1',
    scopeType: 'clinic',
    clinicaId: 55,
    channel: 'clinicaclick_hosted',
    status: 'published',
    activeArtifactId: active === 'target' ? targetArtifact.id : sourceArtifact.id,
    lastGoodArtifactId: sourceArtifact.id,
    version: 3,
    updatedByUserId: 44,
    createdByUserId: 44,
  });
  const targetDeployment = mutableRow({
    id: 'deployment-target',
    publicationId: publication.id,
    projectId: publication.projectId,
    revisionId: targetArtifact.revisionId,
    artifactId: targetArtifact.id,
    previousArtifactId: sourceArtifact.id,
    action: 'publish',
    actorUserId: 44,
    sequence: 2,
    status: active === 'target' ? 'verified' : 'failed',
    storage: {
      runtime_reconciliation: {
        reconciliation_id: '77777777-7777-4777-8777-777777777777',
        generation: 4,
      },
    },
    result: {
      runtime_reconciliation: {
        reconciliation_id: '77777777-7777-4777-8777-777777777777',
        generation: 4,
      },
    },
  });
  const failed = sealFailed({
    id: '77777777-7777-4777-8777-777777777777',
    scopeType: 'clinic',
    scopeId: 55,
    generation: 4,
    status: 'failed',
    sourceRuntimeHash: runtimeService.runtimeHashForRecord(source),
    sourceRuntimeFingerprint: runtimeService.runtimeFingerprintForRecord(source),
    targetRuntimeHash: runtimeService.runtimeHashForRecord(target),
    targetRuntimeFingerprint: runtimeService.runtimeFingerprintForRecord(target),
    sourceConfigPatch: runtimeService.runtimeConfigPatch(source),
    targetConfigPatch: runtimeService.runtimeConfigPatch(target),
    expectedDeployments: {
      [publication.id]: {
        publication_id: publication.id,
        deployment_id: targetDeployment.id,
        artifact_id: targetArtifact.id,
        artifact_hash: targetArtifact.artifactHash,
        runtime_config_hash: targetArtifact.runtimeConfigHash,
      },
    },
    lastErrorCode: 'web_intake_runtime_rollback_failed',
    lastErrorMessage: 'failed before explicit recovery',
  });
  const intakeRow = mutableRow(active === 'target' ? target : source);
  const audits = [];
  const rollbackDeployments = [];
  const models = {
    WebIntakeRuntimeReconciliation: { findByPk: async () => failed },
    IntakeConfig: {
      findOne: async () => intakeRow,
      findAll: async () => [],
    },
    WebPublication: {
      findAll: async () => [publication],
    },
    WebPublicationDeployment: {
      findAll: async () => [targetDeployment, ...rollbackDeployments],
      findOne: async () => rollbackDeployments.at(-1) || targetDeployment,
      findByPk: async (id) => (
        id === targetDeployment.id
          ? targetDeployment
          : rollbackDeployments.find((item) => item.id === id) || null
      ),
      create: async (values) => {
        const created = mutableRow(values);
        rollbackDeployments.push(created);
        return created;
      },
    },
    WebArtifact: {
      findAll: async () => [sourceArtifact, targetArtifact],
      findByPk: async (id) => (
        id === sourceArtifact.id ? sourceArtifact : id === targetArtifact.id ? targetArtifact : null
      ),
    },
    WebAuditEvent: {
      findOne: async (query) => audits.find((item) => (
        item.eventType === query.where.eventType
        && item.entityId === query.where.entityId
        && item.requestId === query.where.requestId
      )) || null,
      create: async (values) => {
        const created = mutableRow(values);
        audits.push(created);
        return created;
      },
    },
    JobRequest: {},
  };
  const sequelize = {
    async transaction(callback) {
      return callback({ LOCK: { UPDATE: 'UPDATE' } });
    },
  };
  return {
    source,
    target,
    sourceArtifact,
    targetArtifact,
    publication,
    targetDeployment,
    failed,
    intakeRow,
    audits,
    rollbackDeployments,
    models,
    sequelize,
  };
}

async function testExplicitRetryCreatesFreshGenerationAndIsIdempotent() {
  const state = baseState();
  const queuedJobs = [];
  const input = {
    reconciliationId: state.failed.id,
    action: 'retry_target',
    reason: 'Operador confirma que el target debe volver a desplegarse.',
    confirmed: true,
    actorId: 44,
    requestId: 'recovery-request-0001',
    models: state.models,
    sequelize: state.sequelize,
    enqueueUniqueJobRequest: async (job) => {
      queuedJobs.push(job);
      return { job: { id: 'job-retry-1', status: 'pending' }, created: true };
    },
  };
  const result = await runtimeService.recoverFailedReconciliation(input);
  assert.equal(result.idempotent, false);
  assert.equal(result.generation, 5);
  assert.equal(result.status, 'pending');
  assert.equal(state.failed.status, 'pending');
  assert.equal(
    state.failed.expectedDeployments['publication-1'].carried_from_generation,
    4
  );
  assert.equal(readEnvelope(state.failed, 'source'), SOURCE_KEY);
  assert.equal(readEnvelope(state.failed, 'target'), TARGET_KEY);
  assert.equal(queuedJobs.length, 1);
  assert.equal(queuedJobs[0].payload.recovery_action, 'retry_target');
  assert.equal(JSON.stringify(queuedJobs).includes(SOURCE_KEY), false);
  assert.equal(JSON.stringify(queuedJobs).includes(TARGET_KEY), false);
  assert.equal(state.audits.filter((item) => item.eventType === runtimeService.ADMIN_RECOVERY_EVENT).length, 1);

  const replay = await runtimeService.recoverFailedReconciliation(input);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.generation, 5);
  assert.equal(queuedJobs.length, 1);
  assert.equal(state.audits.filter((item) => item.eventType === runtimeService.ADMIN_RECOVERY_EVENT).length, 1);

  await assert.rejects(
    runtimeService.recoverFailedReconciliation({
      ...input,
      action: 'rollback_source',
    }),
    (error) => error.code === 'web_intake_runtime_recovery_idempotency_conflict'
  );
  assert.equal(queuedJobs.length, 1);
}

async function testExplicitRollbackCreatesFreshVerifiedLineage() {
  const state = baseState({ active: 'target' });
  const jobs = [];
  const result = await runtimeService.recoverFailedReconciliation({
    reconciliationId: state.failed.id,
    action: 'rollback_source',
    reason: 'Operador confirma restaurar el runtime source acreditado.',
    confirmed: true,
    actorId: 44,
    requestId: 'recovery-request-0002',
    models: state.models,
    sequelize: state.sequelize,
    enqueueJobRequest: async (job) => {
      const created = { id: `job-rollback-${jobs.length + 1}`, status: 'pending' };
      jobs.push({ input: job, created });
      return created;
    },
  });
  assert.equal(result.generation, 5);
  assert.equal(result.status, 'rolling_back');
  assert.equal(state.failed.status, 'rolling_back');
  assert.equal(state.rollbackDeployments.length, 1);
  assert.equal(state.rollbackDeployments[0].artifactId, state.sourceArtifact.id);
  assert.equal(
    state.rollbackDeployments[0].storage.runtime_reconciliation.role,
    'source_rollback'
  );
  assert.equal(state.rollbackDeployments[0].storage.runtime_reconciliation.generation, 5);
  assert.equal(state.intakeRow.hmac_key, SOURCE_KEY);
  assert.equal(readEnvelope(state.failed, 'source'), SOURCE_KEY);
  assert.equal(readEnvelope(state.failed, 'target'), TARGET_KEY);
  assert.equal(jobs.length, 1);
  assert.equal(JSON.stringify(jobs).includes(SOURCE_KEY), false);
  assert.equal(JSON.stringify(jobs).includes(TARGET_KEY), false);
  const audit = state.audits.find((item) => item.eventType === runtimeService.ADMIN_RECOVERY_EVENT);
  assert.equal(audit.actorUserId, 44);
  assert.equal(audit.metadata.action, 'rollback_source');
  assert.deepEqual(audit.metadata.job_request_ids, ['job-rollback-1']);
}

async function testConcurrentReplaySerializesOnDurableMarker() {
  const state = baseState();
  let tail = Promise.resolve();
  state.sequelize.transaction = async (callback) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback({ LOCK: { UPDATE: 'UPDATE' } });
    } finally {
      release();
    }
  };
  let enqueueCount = 0;
  const input = {
    reconciliationId: state.failed.id,
    action: 'retry_target',
    reason: 'Dos operadores reenvían exactamente la misma recuperación.',
    confirmed: true,
    actorId: 44,
    requestId: 'recovery-concurrent-0001',
    models: state.models,
    sequelize: state.sequelize,
    enqueueUniqueJobRequest: async () => {
      enqueueCount += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return { job: { id: 'job-concurrent', status: 'pending' }, created: true };
    },
  };
  const results = await Promise.all([
    runtimeService.recoverFailedReconciliation(input),
    runtimeService.recoverFailedReconciliation(input),
  ]);
  assert.equal(enqueueCount, 1);
  assert.deepEqual(results.map((item) => item.idempotent).sort(), [false, true]);
  assert.equal(state.failed.lastRecoveryRequestId, input.requestId);
  assert.match(state.failed.lastRecoveryRequestHash, /^[a-f0-9]{64}$/);
}

async function testOldRecoveryKeyCannotReplayAfterOrdinaryGeneration() {
  const state = baseState();
  const recoveryInput = {
    reconciliationId: state.failed.id,
    action: 'retry_target',
    reason: 'Recovery original que no debe sobrevivir a otra rotación.',
    confirmed: true,
    actorId: 44,
    requestId: 'recovery-stale-generation-0001',
    models: state.models,
    sequelize: state.sequelize,
    enqueueUniqueJobRequest: async () => ({ job: { id: 'job-recovery' }, created: true }),
  };
  await runtimeService.recoverFailedReconciliation(recoveryInput);
  assert.equal(state.failed.generation, 5);
  state.failed.status = 'completed';
  state.failed.sourceHmacEnvelope = null;
  state.failed.targetHmacEnvelope = null;
  Object.assign(state.intakeRow, state.target);
  const nextTarget = intake('next-ordinary-hmac-key-1122334455', false);
  await runtimeService.persistReconciliation({
    scope: { type: 'clinic', id: 55 },
    sourceRecord: state.target,
    targetRecord: nextTarget,
    models: {
      WebIntakeRuntimeReconciliation: { findOne: async () => state.failed },
      JobRequest: {},
    },
    sequelize: state.sequelize,
    transaction: { LOCK: { UPDATE: 'UPDATE' } },
    enqueueUniqueJobRequest: async () => ({ job: { id: 'job-ordinary' }, created: true }),
  });
  assert.equal(state.failed.generation, 6);
  assert.equal(state.failed.lastRecoveryRequestId, null);
  state.failed.status = 'failed';
  await assert.rejects(
    runtimeService.recoverFailedReconciliation(recoveryInput),
    (error) => error.code === 'web_intake_runtime_recovery_idempotency_stale'
  );
}

async function testUnsafeArtifactFailsClosedWithoutMutation() {
  const state = baseState();
  state.targetArtifact.runtimeConfigHash = 'f'.repeat(64);
  let enqueued = false;
  await assert.rejects(
    runtimeService.recoverFailedReconciliation({
      reconciliationId: state.failed.id,
      action: 'retry_target',
      reason: 'Operador solicita retry pero el artefacto fue alterado.',
      confirmed: true,
      actorId: 44,
      requestId: 'recovery-request-0003',
      models: state.models,
      sequelize: state.sequelize,
      enqueueUniqueJobRequest: async () => { enqueued = true; },
    }),
    (error) => error.code === 'web_intake_runtime_recovery_lineage_untrusted'
  );
  assert.equal(state.failed.generation, 4);
  assert.equal(state.failed.status, 'failed');
  assert.equal(enqueued, false);
  assert.equal(state.audits.length, 0);
}

async function testCurrentRuntimeDriftFailsWithoutMutationOrEnqueue() {
  const state = baseState();
  state.intakeRow.hmac_key = 'runtime-changed-outside-reconciler';
  let enqueued = false;
  await assert.rejects(
    runtimeService.recoverFailedReconciliation({
      reconciliationId: state.failed.id,
      action: 'retry_target',
      reason: 'El operador intenta recuperar después de un cambio externo.',
      confirmed: true,
      actorId: 44,
      requestId: 'recovery-current-drift-0001',
      models: state.models,
      sequelize: state.sequelize,
      enqueueUniqueJobRequest: async () => { enqueued = true; },
    }),
    (error) => error.code === 'web_intake_runtime_recovery_current_changed'
  );
  assert.equal(state.failed.generation, 4);
  assert.equal(state.failed.status, 'failed');
  assert.equal(enqueued, false);
  assert.equal(state.audits.length, 0);
}

async function testSameRuntimeArtifactFromAnotherProjectIsRejected() {
  const state = baseState();
  state.sourceArtifact.projectId = 'project-foreign';
  await assert.rejects(
    runtimeService.recoverFailedReconciliation({
      reconciliationId: state.failed.id,
      action: 'retry_target',
      reason: 'El artefacto tiene igual runtime pero pertenece a otro proyecto.',
      confirmed: true,
      actorId: 44,
      requestId: 'recovery-request-foreign-project',
      models: state.models,
      sequelize: state.sequelize,
      enqueueUniqueJobRequest: async () => ({ job: { id: 'must-not-exist' } }),
    }),
    // El artefacto fuente es también el puntero activo de este fixture. La
    // validación de identidad lo rechaza en el gate más temprano, antes de
    // entrar en el linaje target -> source del deployment.
    (error) => error.code === 'web_intake_runtime_recovery_active_artifact_untrusted'
  );
  assert.equal(state.failed.generation, 4);
  assert.equal(state.audits.length, 0);
}

async function testBothRecoveryActionsRejectTargetRouteWithoutSourceLineage() {
  for (const [index, action] of ['retry_target', 'rollback_source'].entries()) {
    const state = baseState({ active: 'target' });
    state.failed.expectedDeployments = {};
    await assert.rejects(
      runtimeService.recoverFailedReconciliation({
        reconciliationId: state.failed.id,
        action,
        reason: 'No debe recuperarse una ruta target cuyo source es desconocido.',
        confirmed: true,
        actorId: 44,
        requestId: `recovery-missing-lineage-000${index + 1}`,
        models: state.models,
        sequelize: state.sequelize,
        enqueueUniqueJobRequest: async () => ({ job: { id: 'must-not-exist' } }),
      }),
      (error) => error.code === 'web_intake_runtime_recovery_rollback_lineage_incomplete'
    );
    assert.equal(state.failed.generation, 4);
    assert.equal(state.audits.length, 0);
  }
}

async function testPartialRetryFailureRollsBackCarriedAndFreshTargets() {
  const source = intake(SOURCE_KEY, false);
  const target = intake(TARGET_KEY, true);
  const sourceHash = runtimeService.runtimeHashForRecord(source);
  const targetHash = runtimeService.runtimeHashForRecord(target);
  const artifacts = new Map([
    ['s1', artifact('s1', sourceHash, 'a')],
    ['t1', artifact('t1', targetHash, 'b')],
    ['s2', artifact('s2', sourceHash, 'c')],
    ['t2', artifact('t2', targetHash, 'd')],
  ]);
  const publications = [
    mutableRow({
      id: 'p1', projectId: 'project-1', scopeType: 'clinic', clinicaId: 55,
      channel: 'clinicaclick_hosted', status: 'published', activeArtifactId: 't1',
      lastGoodArtifactId: 's1', version: 3, updatedByUserId: 44, createdByUserId: 44,
    }),
    mutableRow({
      id: 'p2', projectId: 'project-1', scopeType: 'clinic', clinicaId: 55,
      channel: 'clinicaclick_hosted', status: 'published', activeArtifactId: 's2',
      lastGoodArtifactId: 's2', version: 3, updatedByUserId: 44, createdByUserId: 44,
    }),
  ];
  const deployments = [
    mutableRow({
      id: 'd1', publicationId: 'p1', projectId: 'project-1',
      revisionId: artifacts.get('t1').revisionId,
      artifactId: 't1', previousArtifactId: 's1',
      action: 'publish', actorUserId: 44, sequence: 2, status: 'verified',
      storage: { runtime_reconciliation: {
        reconciliation_id: '88888888-8888-4888-8888-888888888888', generation: 4,
      } },
      result: { runtime_reconciliation: {
        reconciliation_id: '88888888-8888-4888-8888-888888888888', generation: 4,
      } },
    }),
    mutableRow({
      id: 'd2', publicationId: 'p2', projectId: 'project-1',
      revisionId: artifacts.get('t2').revisionId,
      artifactId: 't2', previousArtifactId: 's2',
      action: 'publish', actorUserId: 44, sequence: 2, status: 'failed',
      storage: { runtime_reconciliation: {
        reconciliation_id: '88888888-8888-4888-8888-888888888888', generation: 4,
      } },
      result: { runtime_reconciliation: {
        reconciliation_id: '88888888-8888-4888-8888-888888888888', generation: 4,
      } },
    }),
  ];
  const failed = sealFailed({
    id: '88888888-8888-4888-8888-888888888888',
    scopeType: 'clinic', scopeId: 55, generation: 4, status: 'failed',
    sourceRuntimeHash: sourceHash,
    sourceRuntimeFingerprint: runtimeService.runtimeFingerprintForRecord(source),
    targetRuntimeHash: targetHash,
    targetRuntimeFingerprint: runtimeService.runtimeFingerprintForRecord(target),
    sourceConfigPatch: runtimeService.runtimeConfigPatch(source),
    targetConfigPatch: runtimeService.runtimeConfigPatch(target),
    expectedDeployments: {
      p1: {
        publication_id: 'p1', deployment_id: 'd1', artifact_id: 't1',
        artifact_hash: artifacts.get('t1').artifactHash, runtime_config_hash: targetHash,
      },
      p2: {
        publication_id: 'p2', deployment_id: 'd2', artifact_id: 't2',
        artifact_hash: artifacts.get('t2').artifactHash, runtime_config_hash: targetHash,
      },
    },
  });
  const intakeRow = mutableRow(source);
  const audits = [];
  const jobs = [];
  const models = {
    WebIntakeRuntimeReconciliation: { findByPk: async () => failed },
    IntakeConfig: { findOne: async () => intakeRow, findAll: async () => [] },
    WebPublication: { findAll: async () => publications },
    WebPublicationDeployment: {
      findAll: async () => (
        failed.generation === 4
          ? deployments.filter((item) => ['d1', 'd2'].includes(item.id))
          : deployments.filter((item) => ['d1', 'd3'].includes(item.id))
      ),
      findByPk: async (id) => deployments.find((item) => item.id === id) || null,
      findOne: async (query) => {
        const publicationId = query.where.publicationId;
        return deployments.filter((item) => item.publicationId === publicationId).at(-1) || null;
      },
      create: async (values) => {
        const created = mutableRow(values);
        // ID determinista para poder simular el ACK fallido del retry.
        if (values.action === 'publish') created.id = 'd3';
        deployments.push(created);
        return created;
      },
    },
    WebArtifact: {
      findAll: async () => [...artifacts.values()],
      findByPk: async (id) => artifacts.get(String(id)) || null,
    },
    WebAuditEvent: {
      findOne: async (query) => audits.find((item) => (
        item.eventType === query.where.eventType
        && item.entityId === query.where.entityId
        && item.requestId === query.where.requestId
      )) || null,
      create: async (values) => {
        const created = mutableRow(values);
        audits.push(created);
        return created;
      },
    },
    JobRequest: {},
  };
  const sequelize = {
    async transaction(callback) { return callback({ LOCK: { UPDATE: 'UPDATE' } }); },
  };
  await runtimeService.recoverFailedReconciliation({
    reconciliationId: failed.id,
    action: 'retry_target',
    reason: 'Reintentar el target preservando la ruta que ya quedó publicada.',
    confirmed: true,
    actorId: 44,
    requestId: 'recovery-request-0004',
    models,
    sequelize,
    enqueueUniqueJobRequest: async () => ({ job: { id: 'job-reconcile', status: 'pending' } }),
  });
  assert.equal(failed.expectedDeployments.p1.carried_from_generation, 4);
  assert.equal(failed.expectedDeployments.p2.carried_from_generation, 4);

  const committed = await runtimeService.commitPreparedRuntime({
    reconciliationId: failed.id,
    generation: 5,
    prepared: [{
      publication_id: 'p2',
      installation_id: null,
      revision_id: artifacts.get('t2').revisionId,
      previous_artifact_id: 's2',
      publication_version: 3,
      actor_id: 44,
      artifact_id: 't2',
      artifact_hash: artifacts.get('t2').artifactHash,
      runtime_config_hash: targetHash,
      storage: {
        runtime_reconciliation: {
          reconciliation_id: failed.id,
          generation: 5,
          suppress_landing_published: true,
        },
      },
    }],
    models,
    sequelize,
    enqueueJobRequest: async () => {
      const job = { id: `job-${jobs.length + 1}`, status: 'pending' };
      jobs.push(job);
      return job;
    },
  });
  assert.equal(committed.deployments.length, 1);
  assert.equal(failed.expectedDeployments.p1.deployment_id, 'd1');
  assert.equal(failed.expectedDeployments.p2.deployment_id, 'd3');
  assert.equal(failed.expectedDeployments.p1.source_artifact_id, 's1');

  const retried = deployments.find((item) => item.id === 'd3');
  retried.status = 'failed';
  publications[1].status = 'error';
  const rolledBack = await runtimeService.finalizeReconciliation({
    reconciliationId: failed.id,
    generation: 5,
    models,
    sequelize,
    enqueueJobRequest: async () => {
      const job = { id: `job-${jobs.length + 1}`, status: 'pending' };
      jobs.push(job);
      return job;
    },
  });
  assert.equal(rolledBack.rolling_back, true);
  const rollbackDeployments = deployments.filter((item) => item.action === 'rollback');
  assert.equal(rollbackDeployments.length, 2);
  assert.deepEqual(
    rollbackDeployments.map((item) => item.artifactId).sort(),
    ['s1', 's2']
  );
  assert.equal(failed.status, 'rolling_back');
}

async function testCrossedRollbackDeploymentIdIsNeverReused() {
  const state = baseState();
  state.failed.status = 'deploying';
  state.failed.expectedDeployments['publication-1'].rollback_deployment_id = 'foreign-rollback';
  const originalFindByPk = state.models.WebPublicationDeployment.findByPk;
  state.models.WebPublicationDeployment.findByPk = async (id) => {
    if (id === 'foreign-rollback') {
      return mutableRow({
        id,
        publicationId: 'publication-foreign',
        projectId: 'project-foreign',
        action: 'rollback',
        artifactId: state.sourceArtifact.id,
        storage: {
          runtime_reconciliation: {
            reconciliation_id: state.failed.id,
            generation: 4,
            role: 'source_rollback',
          },
        },
      });
    }
    return originalFindByPk(id);
  };
  let enqueued = false;
  const result = await runtimeService.finalizeReconciliation({
    reconciliationId: state.failed.id,
    generation: 4,
    models: state.models,
    sequelize: state.sequelize,
    enqueueJobRequest: async () => { enqueued = true; },
  });
  assert.equal(result.failed, true);
  assert.equal(result.manual_recovery_required, true);
  assert.equal(state.failed.lastErrorCode, 'web_intake_runtime_rollback_deployment_invalid');
  assert.equal(enqueued, false);
}

async function testExistingRollbackRequiresCompleteIdentityAndBothMarkers() {
  const state = baseState();
  state.failed.status = 'deploying';
  state.failed.expectedDeployments['publication-1'].rollback_deployment_id = 'rollback-incomplete';
  const originalFindByPk = state.models.WebPublicationDeployment.findByPk;
  state.models.WebPublicationDeployment.findByPk = async (id) => {
    if (id === 'rollback-incomplete') {
      return mutableRow({
        id,
        publicationId: state.publication.id,
        projectId: state.publication.projectId,
        revisionId: state.sourceArtifact.revisionId,
        action: 'rollback',
        artifactId: state.sourceArtifact.id,
        previousArtifactId: state.targetArtifact.id,
        storage: {
          runtime_reconciliation: {
            reconciliation_id: state.failed.id,
            generation: 4,
            role: 'source_rollback',
          },
        },
        // A storage marker alone is not sufficient evidence. The deployment
        // result must carry the exact same reconciliation identity.
        result: {},
      });
    }
    return originalFindByPk(id);
  };
  let enqueued = false;
  const result = await runtimeService.finalizeReconciliation({
    reconciliationId: state.failed.id,
    generation: 4,
    models: state.models,
    sequelize: state.sequelize,
    enqueueJobRequest: async () => { enqueued = true; },
  });
  assert.equal(result.failed, true);
  assert.equal(result.manual_recovery_required, true);
  assert.equal(state.failed.lastErrorCode, 'web_intake_runtime_rollback_deployment_invalid');
  assert.equal(enqueued, false);
}

async function testAdminEndpointContractIsExplicitAndGlobalOnly() {
  const root = path.resolve(__dirname, '../..');
  const route = fs.readFileSync(
    path.join(root, 'routes/adminWebRuntimeReconciliations.routes.js'), 'utf8'
  );
  const controller = fs.readFileSync(
    path.join(root, 'controllers/adminWebRuntimeReconciliations.controller.js'), 'utf8'
  );
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(route, /router\.use\(authMiddleware\)/);
  assert.match(route, /:\w+\/recover/);
  assert.match(controller, /isGlobalAdmin\(actorId\)/);
  assert.match(controller, /confirmed: req\.body\?\.confirmed === true/);
  assert.doesNotMatch(controller, /actorId:\s*req\.body/);
  assert.match(app, /\/api\/admin\/web-runtime-reconciliations/);

  const endpoint = require('../../controllers/adminWebRuntimeReconciliations.controller');
  const response = {
    statusCode: 200,
    body: null,
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await endpoint.recoverFailedReconciliation({
    get: () => null,
    params: { reconciliationId: '77777777-7777-4777-8777-777777777777' },
    userData: { userId: 2 },
    body: {
      actorId: 1,
      actor_id: 1,
      confirmed: true,
      action: 'retry_target',
      reason: 'Intento de spoofing desde un usuario de clínica.',
    },
  }, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error.code, 'admin_only');
}

async function run() {
  const tests = [
    testExplicitRetryCreatesFreshGenerationAndIsIdempotent,
    testExplicitRollbackCreatesFreshVerifiedLineage,
    testConcurrentReplaySerializesOnDurableMarker,
    testOldRecoveryKeyCannotReplayAfterOrdinaryGeneration,
    testUnsafeArtifactFailsClosedWithoutMutation,
    testCurrentRuntimeDriftFailsWithoutMutationOrEnqueue,
    testSameRuntimeArtifactFromAnotherProjectIsRejected,
    testBothRecoveryActionsRejectTargetRouteWithoutSourceLineage,
    testPartialRetryFailureRollsBackCarriedAndFreshTargets,
    testCrossedRollbackDeploymentIdIsNeverReused,
    testExistingRollbackRequiresCompleteIdentityAndBothMarkers,
    testAdminEndpointContractIsExplicitAndGlobalOnly,
  ];
  for (const test of tests) {
    await test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} failed reconciliation recovery tests passed`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

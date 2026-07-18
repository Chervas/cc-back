'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { publicationBaseUrl } = require('./webPublications.service');
const { verifyPublicArtifact } = require('./webPublicationDeployment.service');
const { verifyHostedPointer } = require('./webHostedPublisher.service');

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const PUBLIC_READBACK_TIMEOUT_MS = 8000;

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function resolveBatchSize(value, env = process.env) {
  const parsed = Number(value ?? env.MARKETING_WEB_PUBLICATION_HEALTH_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, parsed);
}

function normalizedHealthStatus(health) {
  const status = String(health?.status || '').trim().toLowerCase();
  if (status === 'healthy' || status === 'recovered') return 'healthy';
  if (status === 'unhealthy') return 'unhealthy';
  return 'unknown';
}

function artifactContract(artifact) {
  const value = plain(artifact);
  const inputHash = String(value?.manifest?.artifact_input_hash || '').trim().toLowerCase();
  const artifactHash = String(value?.artifactHash || value?.artifact_hash || '').trim().toLowerCase();
  return {
    valid: /^[a-f0-9]{64}$/.test(inputHash) && /^[a-f0-9]{64}$/.test(artifactHash),
    inputHash: /^[a-f0-9]{64}$/.test(inputHash) ? inputHash : null,
    artifactHash: /^[a-f0-9]{64}$/.test(artifactHash) ? artifactHash : null,
  };
}

function safeFailureCode(error, fallback = 'publication_health_persist_failed') {
  return String(error?.code || fallback).trim().slice(0, 128) || fallback;
}

async function inspectPublication(publication, {
  models,
  env,
  verifyHosted,
  verifyPublic,
  timeoutMs = PUBLIC_READBACK_TIMEOUT_MS,
}) {
  let artifact = null;
  try {
    artifact = await models.WebArtifact.findByPk(publication.activeArtifactId);
  } catch {
    return {
      healthy: false,
      reason: 'active_artifact_lookup_failed',
      artifactHash: null,
      inputHash: null,
    };
  }

  if (!artifact) {
    return {
      healthy: false,
      reason: 'active_artifact_missing',
      artifactHash: null,
      inputHash: null,
    };
  }

  const contract = artifactContract(artifact);
  if (!contract.valid) {
    return {
      healthy: false,
      reason: 'active_artifact_marker_invalid',
      artifactHash: contract.artifactHash,
      inputHash: contract.inputHash,
    };
  }

  if (publication.channel !== 'wordpress') {
    let localHealthy = false;
    try {
      localHealthy = await verifyHosted({
        artifactHash: contract.artifactHash,
        artifact: {
          artifact_hash: contract.artifactHash,
          manifest: plain(artifact).manifest,
          files: plain(artifact).files,
        },
        host: publication.host,
        routePath: publication.path,
        hostingRoot: env.MARKETING_WEB_HOSTING_ROOT,
      }) === true;
    } catch {
      localHealthy = false;
    }
    if (!localHealthy) {
      return {
        healthy: false,
        reason: 'hosted_artifact_integrity_failed',
        artifactHash: contract.artifactHash,
        inputHash: contract.inputHash,
      };
    }
  }

  let publicUrl;
  try {
    publicUrl = `${publicationBaseUrl(publication)}/`;
  } catch {
    return {
      healthy: false,
      reason: 'public_url_invalid',
      artifactHash: contract.artifactHash,
      inputHash: contract.inputHash,
    };
  }

  let healthy = false;
  try {
    healthy = await verifyPublic({
      publicUrl,
      inputHash: contract.inputHash,
      attempts: 1,
      timeoutMs,
    }) === true;
  } catch {
    healthy = false;
  }

  return {
    healthy,
    reason: healthy ? null : 'public_readback_failed',
    artifactHash: contract.artifactHash,
    inputHash: contract.inputHash,
  };
}

function transitionFor(previousStatus, nextStatus) {
  if (previousStatus === 'healthy' && nextStatus === 'unhealthy') return 'unhealthy';
  if (previousStatus === 'unhealthy' && nextStatus === 'healthy') return 'recovered';
  return null;
}

async function persistInspection({
  publication,
  inspection,
  checkedAt,
  jobRequestId,
  models,
  sequelize,
}) {
  return sequelize.transaction(async (transaction) => {
    const current = await models.WebPublication.findByPk(publication.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const value = plain(current);
    if (
      !current
      || value.status !== 'published'
      || !value.activeArtifactId
      || String(value.activeArtifactId) !== String(publication.activeArtifactId)
    ) {
      return { persisted: false, skipped: 'publication_pointer_changed', transition: null };
    }

    const previousStatus = normalizedHealthStatus(value.health);
    const nextStatus = inspection.healthy ? 'healthy' : 'unhealthy';
    const transition = transitionFor(previousStatus, nextStatus);
    const health = {
      status: nextStatus,
      artifact_hash: inspection.artifactHash,
      artifact_input_hash: inspection.inputHash,
      checked_at: checkedAt.toISOString(),
      channel: value.channel,
      monitor: 'scheduled_public_readback',
      ...(inspection.reason ? { reason: inspection.reason } : {}),
    };
    const patch = { health };
    if (inspection.healthy) patch.lastHealthyAt = checkedAt;
    await current.update(patch, { transaction });

    if (transition) {
      await models.WebAuditEvent.create({
        projectId: value.projectId,
        scopeType: value.scopeType,
        clinicaId: value.scopeType === 'clinic' ? value.clinicaId : null,
        grupoClinicaId: value.scopeType === 'group' ? value.grupoClinicaId : null,
        actorUserId: null,
        eventType: transition === 'recovered'
          ? 'web.publication.health_recovered'
          : 'web.publication.health_unhealthy',
        entityType: 'web_publication',
        entityId: value.id,
        requestId: jobRequestId ? `job:${jobRequestId}`.slice(0, 80) : null,
        previousHash: null,
        nextHash: null,
        metadata: {
          publication_id: value.id,
          active_artifact_id: value.activeArtifactId,
          artifact_hash: inspection.artifactHash,
          previous_status: previousStatus,
          status: nextStatus,
          reason: inspection.reason,
          checked_at: checkedAt.toISOString(),
        },
      }, { transaction });
    }

    return { persisted: true, skipped: null, transition, status: nextStatus };
  });
}

async function runWebPublicationHealthMonitor(options = {}, dependencies = {}) {
  const models = dependencies.models || db;
  const sequelize = dependencies.sequelize || db.sequelize;
  const verifyPublic = dependencies.verifyPublicArtifact || verifyPublicArtifact;
  const verifyHosted = dependencies.verifyHostedPointer || verifyHostedPointer;
  const env = dependencies.env || process.env;
  const now = dependencies.now || (() => new Date());
  const batchSize = resolveBatchSize(options.batchSize ?? options.batch_size, env);
  const timeoutMs = Math.max(
    500,
    Math.min(30000, Number(options.timeoutMs || PUBLIC_READBACK_TIMEOUT_MS) || PUBLIC_READBACK_TIMEOUT_MS)
  );

  const publications = await models.WebPublication.findAll({
    where: {
      status: 'published',
      activeArtifactId: { [Op.ne]: null },
    },
    order: [['updated_at', 'ASC'], ['id', 'ASC']],
    limit: batchSize,
  });

  const report = {
    batch_size: batchSize,
    selected: publications.length,
    checked: 0,
    persisted: 0,
    healthy: 0,
    unhealthy: 0,
    degraded: 0,
    recovered: 0,
    unchanged: 0,
    skipped: 0,
    failures: 0,
    failure_codes: [],
    batch_exhausted: publications.length === batchSize,
  };

  for (const row of publications) {
    const publication = plain(row);
    let inspection;
    try {
      inspection = await inspectPublication(publication, {
        models,
        env,
        verifyHosted,
        verifyPublic,
        timeoutMs,
      });
      report.checked += 1;
      const persisted = await persistInspection({
        publication,
        inspection,
        checkedAt: now(),
        jobRequestId: options.jobRequestId || options.job_request_id || null,
        models,
        sequelize,
      });
      if (!persisted.persisted) {
        report.skipped += 1;
        continue;
      }
      report.persisted += 1;
      report[persisted.status] += 1;
      if (persisted.transition === 'unhealthy') report.degraded += 1;
      else if (persisted.transition === 'recovered') report.recovered += 1;
      else report.unchanged += 1;
    } catch (error) {
      report.failures += 1;
      if (report.failure_codes.length < 10) {
        report.failure_codes.push(safeFailureCode(error));
      }
    }
  }

  // A failed public readback is a health result, not a job failure. Likewise,
  // an isolated persistence failure is reported but does not trigger rapid
  // retries of the whole batch; the next durable schedule will revisit it.
  return { status: 'completed', result: report };
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  artifactContract,
  inspectPublication,
  normalizedHealthStatus,
  persistInspection,
  resolveBatchSize,
  runWebPublicationHealthMonitor,
  transitionFor,
};

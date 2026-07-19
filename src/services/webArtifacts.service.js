'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const {
  RENDERER_VERSION,
  compileWebArtifact,
  normalizeClinicSnapshot,
  safeAbsoluteBaseUrl,
  sha256,
} = require('../lib/webArtifactCompiler');
const {
  assertProjectAccess,
  positiveInteger,
  scopeColumns,
  scopeFromProject,
} = require('./webProjects.service');
const { assertWebPublishingEnabled } = require('../lib/marketingWebFeatureFlags');
const { trustedRuntime: normalizeTrustedRuntime } = require('../lib/webMeasurementRuntime');

class WebArtifactServiceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'WebArtifactServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function serializeArtifact(row, { includeFiles = false } = {}) {
  const value = plain(row);
  return {
    id: value.id,
    project_id: value.projectId,
    revision_id: value.revisionId,
    renderer_version: value.rendererVersion,
    environment: value.environment,
    base_url: value.baseUrl,
    artifact_hash: value.artifactHash,
    document_hash: value.documentHash,
    content_snapshot_hash: value.contentSnapshotHash,
    runtime_config_hash: value.runtimeConfigHash,
    manifest: value.manifest,
    qa: value.qaReport,
    status: value.status,
    created_by_user_id: value.createdByUserId || null,
    created_at: value.created_at,
    ...(includeFiles ? { files: value.files } : {}),
  };
}

function clinicProjection(row) {
  const value = plain(row) || {};
  return normalizeClinicSnapshot({
    clinic_id: value.id_clinica,
    schema_type: 'Dentist',
    name: value.nombre_clinica,
    address: {
      street_address: value.direccion,
      postal_code: value.codigo_postal,
      locality: value.ciudad,
      region: value.provincia,
      country: value.pais,
    },
    phone: value.telefono_movil || value.telefono_fijo || value.telefono,
    email: value.email,
    website: value.url_web,
    hours: value.horario_atencion,
  });
}

function isActiveClinic(row) {
  return [true, 1, '1'].includes(plain(row)?.estado_clinica);
}

async function resolveClinicForProject(project, requestedClinicId, {
  models,
  transaction,
  document = null,
  runtimeReconciliation = null,
  runtimeConfigHash = null,
} = {}) {
  const scope = scopeFromProject(plain(project));
  const clinicId = scope.type === 'clinic' ? scope.id : positiveInteger(requestedClinicId);
  if (!clinicId) {
    throw new WebArtifactServiceError(
      'web_artifact_clinic_required',
      'Los proyectos de grupo necesitan seleccionar una clínica concreta para compilar.',
      422
    );
  }
  const clinic = await models.Clinica.findByPk(clinicId, {
    attributes: [
      'id_clinica', 'grupoClinicaId', 'nombre_clinica', 'direccion', 'codigo_postal',
      'ciudad', 'provincia', 'pais', 'telefono', 'telefono_fijo', 'telefono_movil',
      'email', 'url_web', 'horario_atencion', 'estado_clinica',
    ],
    transaction,
  });
  if (!clinic) throw new WebArtifactServiceError('web_artifact_clinic_not_found', 'La clínica no existe.', 404);
  if (!isActiveClinic(clinic)) {
    throw new WebArtifactServiceError(
      'web_artifact_clinic_inactive',
      'La clínica elegida no está activa y no se puede publicar.',
      409
    );
  }
  if (scope.type === 'group' && Number(clinic.grupoClinicaId) !== Number(scope.id)) {
    throw new WebArtifactServiceError('web_artifact_clinic_not_found', 'La clínica no existe.', 404);
  }
  if (scope.type === 'group') {
    const intakeConfigId = positiveInteger(document?.integrations?.intake_config_id);
    const intake = intakeConfigId && models.IntakeConfig?.findByPk
      ? plain(await models.IntakeConfig.findByPk(intakeConfigId, { transaction }))
      : null;
    let locations = Array.isArray(intake?.config?.locations) ? intake.config.locations : [];
    if (runtimeReconciliation) {
      const reconciliationId = String(runtimeReconciliation.id || '').trim();
      const generation = positiveInteger(runtimeReconciliation.generation);
      const staged = reconciliationId && generation && models.WebIntakeRuntimeReconciliation?.findByPk
        ? plain(await models.WebIntakeRuntimeReconciliation.findByPk(reconciliationId, { transaction }))
        : null;
      const stagedLocations = staged?.targetConfigPatch?.locations;
      if (
        !staged
        || Number(staged.generation) !== generation
        || !['pending', 'preparing'].includes(String(staged.status || ''))
        || staged.scopeType !== 'group'
        || positiveInteger(staged.scopeId) !== scope.id
        || String(staged.targetRuntimeHash || '') !== String(runtimeConfigHash || '')
        || stagedLocations?.present !== true
        || !Array.isArray(stagedLocations.value)
      ) {
        throw new WebArtifactServiceError(
          'web_artifact_runtime_reconciliation_invalid',
          'La configuración staged de captación ya no es válida para compilar.',
          409
        );
      }
      locations = stagedLocations.value;
    }
    const included = locations.some((location) => (
      positiveInteger(location?.id ?? location?.clinic_id) === clinicId
    ));
    if (
      !intake
      || intake.assignment_scope !== 'group'
      || positiveInteger(intake.group_id) !== scope.id
      || !included
    ) {
      throw new WebArtifactServiceError(
        'web_artifact_group_clinic_not_configured',
        'La clínica debe estar incluida explícitamente en la configuración de captación del grupo.',
        409
      );
    }
  }
  return clinic;
}

async function auditCompile({ models, transaction, project, actorId, requestId, artifact }) {
  const scope = scopeFromProject(plain(project));
  await models.WebAuditEvent.create({
    projectId: project.id,
    ...scopeColumns(scope),
    actorUserId: positiveInteger(actorId),
    eventType: 'web.artifact.compiled',
    entityType: 'web_artifact',
    entityId: artifact.id,
    requestId: requestId || null,
    previousHash: null,
    nextHash: artifact.artifactHash,
    metadata: {
      revision_id: artifact.revisionId,
      renderer_version: artifact.rendererVersion,
      environment: artifact.environment,
      base_url_hash: artifact.baseUrlHash,
      runtime_config_hash: artifact.runtimeConfigHash,
    },
  }, { transaction });
}

async function isVerifiedRollbackSource({
  rollbackSource,
  revision,
  project,
  environment,
  models,
  transaction,
}) {
  if (environment !== 'production' || !rollbackSource || typeof rollbackSource !== 'object') return false;
  const publicationId = String(rollbackSource.publicationId || '').trim();
  const artifactId = String(rollbackSource.artifactId || '').trim();
  if (!publicationId || !artifactId) return false;

  const sourceArtifact = await models.WebArtifact.findByPk(artifactId, { transaction });
  if (
    !sourceArtifact
    || String(sourceArtifact.projectId) !== String(project.id)
    || String(sourceArtifact.revisionId) !== String(revision.id)
    || sourceArtifact.environment !== 'production'
  ) return false;

  const verifiedDeployment = await models.WebPublicationDeployment.findOne({
    where: {
      publicationId,
      artifactId: sourceArtifact.id,
      status: 'verified',
    },
    transaction,
  });
  return Boolean(
    verifiedDeployment
    && String(verifiedDeployment.projectId) === String(project.id)
    && String(verifiedDeployment.revisionId) === String(revision.id)
  );
}

async function compileRevision({
  actorId,
  revisionId,
  body = {},
  requestId = null,
  trustedRuntime: internalTrustedRuntime = {},
  runtimeReconciliation = null,
  rollbackSource = null,
  models = db,
  sequelize = db.sequelize,
} = {}) {
  const environment = String(body.environment || 'preview').trim().toLowerCase();
  if (!['preview', 'production'].includes(environment)) {
    throw new WebArtifactServiceError('web_artifact_environment_invalid', 'El entorno debe ser preview o production.');
  }
  const baseUrl = safeAbsoluteBaseUrl(body.base_url);
  const rendererVersion = RENDERER_VERSION;
  const baseUrlHash = sha256(baseUrl);
  const normalizedRuntime = normalizeTrustedRuntime(internalTrustedRuntime, { environment });
  const runtimeConfigHash = normalizedRuntime.runtime_config_hash;

  return sequelize.transaction(async (transaction) => {
    const revisionPointer = await models.WebRevision.findByPk(String(revisionId || ''), {
      attributes: ['id', 'projectId'],
      transaction,
    });
    if (!revisionPointer) throw new WebArtifactServiceError('web_revision_not_found', 'La revisión no existe.', 404);
    const project = await models.WebProject.findByPk(revisionPointer.projectId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!project) throw new WebArtifactServiceError('web_project_not_found', 'El proyecto no existe.', 404);
    await assertProjectAccess(actorId, project, 'marketing.web.review', { models, transaction });
    const revision = await models.WebRevision.findByPk(revisionPointer.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!revision || String(revision.projectId) !== String(project.id)) {
      throw new WebArtifactServiceError('web_revision_not_found', 'La revisión no existe.', 404);
    }
    const verifiedRollback = revision.status === 'superseded'
      && await isVerifiedRollbackSource({
        rollbackSource,
        revision,
        project,
        environment,
        models,
        transaction,
      });
    if (revision.status !== 'approved' && !verifiedRollback) {
      throw new WebArtifactServiceError(
        'web_revision_not_approved',
        'Solo se puede compilar una revisión aprobada.',
        409,
        { current_status: revision.status }
      );
    }
    if (environment === 'production') {
      assertWebPublishingEnabled(scopeFromProject(plain(project)));
      const hasIntakeForm = Object.values(revision.document?.nodes || {})
        .some((node) => node?.type === 'intake_form');
      if (hasIntakeForm && normalizedRuntime.measurement.enabled !== true) {
        throw new WebArtifactServiceError(
          'web_artifact_measurement_required',
          'Antes de publicar, configura la medición y recepción segura de contactos para esta clínica.',
          409
        );
      }
    }
    // La elegibilidad de la clínica (incluido un target staged durable) se
    // revalida antes de reutilizar un artefacto ya compilado.
    const clinic = await resolveClinicForProject(project, body.clinic_id, {
      models,
      transaction,
      document: revision.document,
      runtimeReconciliation,
      runtimeConfigHash,
    });
    const existing = await models.WebArtifact.findOne({
      where: {
        revisionId: revision.id,
        rendererVersion,
        environment,
        baseUrlHash,
        runtimeConfigHash,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existing) return serializeArtifact(existing, { includeFiles: true });

    const compiled = compileWebArtifact({
      document: revision.document,
      contentSnapshot: revision.contentSnapshot,
      project: { id: project.id, name: project.name, locale: project.locale },
      revisionId: revision.id,
      baseUrl,
      environment,
      clinicSnapshot: clinicProjection(clinic),
      intakeEndpoint: body.intake_endpoint
        || (environment === 'production' ? '/_clinicaclick/intake' : '/api/intake/web'),
      rendererVersion,
      trustedRuntime: normalizedRuntime,
    });
    const artifact = await models.WebArtifact.create({
      id: crypto.randomUUID(),
      projectId: project.id,
      revisionId: revision.id,
      rendererVersion,
      environment,
      baseUrl,
      baseUrlHash,
      runtimeConfigHash,
      artifactHash: compiled.artifact_hash,
      documentHash: revision.documentHash,
      contentSnapshotHash: compiled.manifest.content_snapshot_hash,
      manifest: compiled.manifest,
      files: compiled.files,
      qaReport: compiled.qa,
      status: 'ready',
      createdByUserId: positiveInteger(actorId),
    }, { transaction });
    await auditCompile({ models, transaction, project, actorId, requestId, artifact });
    return serializeArtifact(artifact, { includeFiles: true });
  });
}

async function getArtifact({ actorId, artifactId, includeFiles = true, models = db } = {}) {
  const artifact = await models.WebArtifact.findByPk(String(artifactId || ''));
  if (!artifact) throw new WebArtifactServiceError('web_artifact_not_found', 'El artefacto no existe.', 404);
  const project = await models.WebProject.findByPk(artifact.projectId);
  if (!project) throw new WebArtifactServiceError('web_artifact_not_found', 'El artefacto no existe.', 404);
  try {
    await assertProjectAccess(actorId, project, 'marketing.web.view', { models });
  } catch (error) {
    if (Number(error?.status) === 403) {
      throw new WebArtifactServiceError('web_artifact_not_found', 'El artefacto no existe.', 404);
    }
    throw error;
  }
  return serializeArtifact(artifact, { includeFiles });
}

async function listProjectArtifacts({ actorId, projectId, query = {}, models = db } = {}) {
  const project = await models.WebProject.findByPk(String(projectId || ''));
  if (!project) throw new WebArtifactServiceError('web_project_not_found', 'El proyecto no existe.', 404);
  await assertProjectAccess(actorId, project, 'marketing.web.view', { models });
  const limit = Math.min(Math.max(1, Number.parseInt(String(query.limit || '20'), 10) || 20), 50);
  const before = query.before ? new Date(query.before) : null;
  if (before && !Number.isFinite(before.getTime())) {
    throw new WebArtifactServiceError('web_artifact_cursor_invalid', 'El cursor before no es válido.');
  }
  const rows = await models.WebArtifact.findAll({
    where: {
      projectId: project.id,
      ...(before ? { created_at: { [Op.lt]: before } } : {}),
    },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return {
    items: items.map((row) => serializeArtifact(row)),
    pagination: {
      limit,
      has_more: hasMore,
      next_before: hasMore ? plain(items[items.length - 1]).created_at : null,
    },
  };
}

module.exports = {
  WebArtifactServiceError,
  clinicProjection,
  compileRevision,
  getArtifact,
  listProjectArtifacts,
  resolveClinicForProject,
  serializeArtifact,
};

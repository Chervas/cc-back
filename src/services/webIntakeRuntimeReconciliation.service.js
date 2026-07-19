'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const { canonicalSerialize } = require('../lib/webDocument');
const { trustedRuntime } = require('../lib/webMeasurementRuntime');
const { compileRevision } = require('./webArtifacts.service');
const { storeArtifactBundle } = require('./webArtifactStorage.service');
const jobRequestsService = require('./jobRequests.service');
const {
  installationApiBase,
  measurementFromIntake,
} = require('./webWordpressInstallations.service');
const {
  assertWordpressPilotManifestCompatible,
  publicationBaseUrl,
} = require('./webPublications.service');
const { supportsMultiPublication } = require('../lib/webWordpressCompatibility');
const { isGlobalAdmin } = require('../lib/role-helpers');
const {
  RUNTIME_FEATURE_KEYS,
  parseRuntimeInheritance,
  recordDeclaresRuntime,
} = require('../lib/webRuntimeInheritance');
const {
  decryptRuntimeSecret,
  encryptRuntimeSecret,
} = require('../lib/webRuntimeSecretEnvelope');
const {
  effectiveIntakeConfigForScope,
} = require('./webEffectiveIntakeConfig.service');
const {
  findWebArtifactMetadataByPk,
} = require('./webArtifactMetadata.service');

const JOB_TYPE = 'web_intake_runtime_reconcile';
const ADMIN_RECOVERY_EVENT = 'web.intake_runtime_reconciliation.recovery_requested';
const ADMIN_RECOVERY_ACTIONS = new Set(['retry_target', 'rollback_source']);
const DEFAULT_HMAC_GRACE_MS = 24 * 60 * 60 * 1000;
const BUSY_STATUSES = new Set(['pending', 'publishing', 'rolling_back']);

class WebIntakeRuntimeReconciliationError extends Error {
  constructor(code, message, status = 409, details = undefined) {
    super(message);
    this.name = 'WebIntakeRuntimeReconciliationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function reconciliationSecretContext(reconciliation, slot) {
  const value = plain(reconciliation) || {};
  return {
    id: value.id,
    scopeType: value.scopeType || value.scope_type,
    scopeId: value.scopeId || value.scope_id,
    generation: value.generation,
    slot,
  };
}

function reconciliationSecret(reconciliation, slot, { env = process.env } = {}) {
  const value = plain(reconciliation) || {};
  const serialized = slot === 'source'
    ? (value.sourceHmacEnvelope ?? value.source_hmac_envelope)
    : (value.targetHmacEnvelope ?? value.target_hmac_envelope);
  return decryptRuntimeSecret(serialized, reconciliationSecretContext(value, slot), { env });
}

function sealReconciliationSecret(secret, reconciliation, slot, { env = process.env } = {}) {
  return encryptRuntimeSecret(secret, reconciliationSecretContext(reconciliation, slot), { env });
}

function scopeFromRecord(record) {
  const value = plain(record) || {};
  const type = value.assignment_scope === 'group' ? 'group' : 'clinic';
  const id = positiveInteger(type === 'group' ? value.group_id : value.clinic_id);
  if (!id) return null;
  return { type, id };
}

function inheritedRuntimeScope(record) {
  return parseRuntimeInheritance(plain(record)?.config?.runtime_inheritance);
}

function runtimeScopeFromRecord(record) {
  return inheritedRuntimeScope(record) || scopeFromRecord(record);
}

function scopeWhere(scope) {
  return scope.type === 'group'
    ? { assignment_scope: 'group', group_id: scope.id }
    : { assignment_scope: 'clinic', clinic_id: scope.id };
}

function recordWithScope(record, scope) {
  const value = { ...(plain(record) || {}) };
  if (!scope?.type || !positiveInteger(scope.id)) return value;
  value.assignment_scope = scope.type === 'group' ? 'group' : 'clinic';
  value.clinic_id = scope.type === 'clinic' ? positiveInteger(scope.id) : null;
  value.group_id = scope.type === 'group' ? positiveInteger(scope.id) : null;
  return value;
}

function patchScope(patch, fallback = null) {
  const type = patch?.scope?.type === 'group'
    ? 'group'
    : (patch?.scope?.type === 'clinic' ? 'clinic' : fallback?.type);
  const id = positiveInteger(patch?.scope?.id) || positiveInteger(fallback?.id);
  return type && id ? { type, id } : null;
}

function runtimeConfigPatch(record) {
  const config = objectValue(plain(record)?.config);
  const features = objectValue(config.features);
  const scope = runtimeScopeFromRecord(record);
  return {
    schema_version: 2,
    // The scope is part of the immutable runtime identity. It is especially
    // important when a clinic materializes a direct override while its live
    // pages still use the inherited group runtime.
    scope: scope ? { type: scope.type, id: scope.id } : null,
    features: Object.fromEntries(RUNTIME_FEATURE_KEYS.map((key) => [key, {
      present: Object.prototype.hasOwnProperty.call(features, key),
      value: Object.prototype.hasOwnProperty.call(features, key) ? cloneJson(features[key]) : null,
    }])),
    locations: {
      present: Object.prototype.hasOwnProperty.call(config, 'locations'),
      value: Object.prototype.hasOwnProperty.call(config, 'locations') ? cloneJson(config.locations) : null,
    },
    snippet_verification: {
      present: Object.prototype.hasOwnProperty.call(config, 'snippet_verification'),
      value: Object.prototype.hasOwnProperty.call(config, 'snippet_verification')
        ? cloneJson(config.snippet_verification)
        : null,
    },
  };
}

function applyPresence(target, key, descriptor) {
  if (descriptor?.present === true) target[key] = cloneJson(descriptor.value);
  else delete target[key];
}

function applyRuntimePatch(record, patch, hmacKey) {
  const source = plain(record) || {};
  const config = cloneJson(objectValue(source.config));
  const features = cloneJson(objectValue(config.features));
  for (const key of RUNTIME_FEATURE_KEYS) applyPresence(features, key, patch?.features?.[key]);
  if (Object.keys(features).length) config.features = features;
  else delete config.features;
  applyPresence(config, 'locations', patch?.locations);
  applyPresence(config, 'snippet_verification', patch?.snippet_verification);
  return {
    ...source,
    config,
    hmac_key: hmacKey === undefined ? null : hmacKey,
  };
}

function sourceRecordForReconciliation(current, reconciliation, { env = process.env } = {}) {
  const targetScope = {
    type: reconciliation.scopeType,
    id: positiveInteger(reconciliation.scopeId),
  };
  const sourceScope = patchScope(reconciliation.sourceConfigPatch, targetScope);
  return recordWithScope(
    withoutRuntimeInheritance(
      applyRuntimePatch(current, reconciliation.sourceConfigPatch, reconciliationSecret(reconciliation, 'source', { env }))
    ),
    sourceScope
  );
}

function targetRecordForReconciliation(current, reconciliation, { env = process.env } = {}) {
  const targetScope = {
    type: reconciliation.scopeType,
    id: positiveInteger(reconciliation.scopeId),
  };
  return recordWithScope(
    withoutRuntimeInheritance(
      applyRuntimePatch(
        current,
        reconciliation.targetConfigPatch,
        ['grace', 'completed'].includes(String(reconciliation.status || ''))
          && !String(reconciliation.targetHmacEnvelope || reconciliation.target_hmac_envelope || '')
          ? plain(current)?.hmac_key
          : reconciliationSecret(reconciliation, 'target', { env })
      )
    ),
    patchScope(reconciliation.targetConfigPatch, targetScope) || targetScope
  );
}

function disabledSourceRecord(scope, candidate) {
  return recordWithScope(
    withoutRuntimeInheritance(applyRuntimePatch(candidate, runtimeConfigPatch(null), null)),
    scope
  );
}

function withRuntimeInheritance(record, sourceRecord) {
  const sourceScope = runtimeScopeFromRecord(sourceRecord);
  const restored = applyRuntimePatch(record, runtimeConfigPatch(sourceRecord), plain(sourceRecord)?.hmac_key || null);
  const config = cloneJson(objectValue(restored.config));
  if (sourceScope) {
    config.runtime_inheritance = {
      schema_version: 1,
      scope_type: sourceScope.type,
      scope_id: sourceScope.id,
    };
  }
  return { ...restored, config };
}

function withoutRuntimeInheritance(record) {
  const value = { ...(plain(record) || {}) };
  const config = cloneJson(objectValue(value.config));
  delete config.runtime_inheritance;
  return { ...value, config };
}

function materializeRuntimeForOwnership(runtimeRecord, ownershipScope) {
  const runtimeScope = runtimeScopeFromRecord(runtimeRecord);
  const owned = recordWithScope(runtimeRecord, ownershipScope);
  if (
    runtimeScope?.type === ownershipScope?.type
    && runtimeScope?.id === positiveInteger(ownershipScope?.id)
  ) return recordWithScope(withoutRuntimeInheritance(owned), ownershipScope);
  return recordWithScope(withRuntimeInheritance(owned, runtimeRecord), ownershipScope);
}

function candidateDeclaresRuntime(candidate) {
  return recordDeclaresRuntime(candidate);
}

function runtimeForRecord(record, { env = process.env } = {}) {
  const measurement = measurementFromIntake(recordWithScope(record, runtimeScopeFromRecord(record)));
  return trustedRuntime({
    measurement: measurement.enabled
      ? { ...measurement, api_url: installationApiBase(env) }
      : measurement,
  }, { environment: 'production' });
}

function runtimeHashForRecord(record, options = {}) {
  return runtimeForRecord(record, options).runtime_config_hash;
}

function runtimeFingerprintForRecord(record) {
  return sha256(canonicalSerialize({
    hmac_key: String(plain(record)?.hmac_key || ''),
    patch: runtimeConfigPatch(record),
  }));
}

function locationIds(record) {
  const values = Array.isArray(plain(record)?.config?.locations)
    ? plain(record).config.locations
    : [];
  return new Set(values.map((item) => positiveInteger(item?.id ?? item?.clinic_id)).filter(Boolean));
}

function publicationIsServed(publication) {
  const value = plain(publication) || {};
  if (value.status === 'retired' || value.status === 'draft') return false;
  return Boolean(
    value.activeArtifactId
    || value.lastGoodArtifactId
    || BUSY_STATUSES.has(String(value.status || ''))
  );
}

async function candidatePublications(scope, { models = db, transaction = null, lock = false } = {}) {
  let clinicIds = [];
  if (scope.type === 'clinic') {
    clinicIds = [scope.id];
  } else {
    const clinics = await models.Clinica.findAll({
      where: { grupoClinicaId: scope.id },
      attributes: ['id_clinica'],
      raw: true,
      ...(transaction ? { transaction } : {}),
    });
    clinicIds = clinics.map((clinic) => positiveInteger(clinic.id_clinica)).filter(Boolean);
  }
  const clauses = scope.type === 'group'
    ? [
        { scopeType: 'group', grupoClinicaId: scope.id },
        ...(clinicIds.length ? [{ scopeType: 'clinic', clinicaId: { [Op.in]: clinicIds } }] : []),
      ]
    : [{ scopeType: 'clinic', clinicaId: scope.id }];
  const rows = await models.WebPublication.findAll({
    where: {
      status: { [Op.ne]: 'retired' },
      [Op.or]: clauses,
    },
    order: [['wordpressInstallationId', 'ASC'], ['path', 'ASC'], ['id', 'ASC']],
    ...(transaction ? { transaction } : {}),
    ...(transaction && lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  return rows.filter(publicationIsServed);
}

async function inheritedRuntimeRecord(scope, {
  models = db,
  transaction = null,
  lock = false,
} = {}) {
  if (scope?.type !== 'clinic' || !positiveInteger(scope.id)) return null;
  const clinic = await models.Clinica.findByPk(scope.id, {
    attributes: ['grupoClinicaId'],
    raw: true,
    ...(transaction ? { transaction } : {}),
  });
  const groupId = positiveInteger(clinic?.grupoClinicaId);
  if (!groupId) return null;
  const inherited = await models.IntakeConfig.findOne({
    where: { assignment_scope: 'group', group_id: groupId },
    raw: true,
    ...(transaction ? { transaction } : {}),
    ...(transaction && lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  return locationIds(inherited).has(scope.id) ? inherited : null;
}

async function lockRuntimeOverlap(scope, { models = db, transaction = null } = {}) {
  if (!transaction || !models.GrupoClinica?.findByPk) return null;
  let groupId = scope.type === 'group' ? positiveInteger(scope.id) : null;
  if (!groupId) {
    const clinic = await models.Clinica.findByPk(scope.id, {
      attributes: ['grupoClinicaId'], raw: true, transaction,
    });
    groupId = positiveInteger(clinic?.grupoClinicaId);
  }
  if (!groupId) return null;
  await models.GrupoClinica.findByPk(groupId, {
    attributes: ['id_grupo'],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const clinics = await models.Clinica.findAll({
    where: { grupoClinicaId: groupId },
    attributes: ['id_clinica'],
    raw: true,
    transaction,
  });
  return {
    group_id: groupId,
    clinic_ids: clinics.map((clinic) => positiveInteger(clinic.id_clinica)).filter(Boolean),
  };
}

async function assertNoOverlappingRuntimeTransition(scope, overlap, {
  models = db,
  transaction = null,
} = {}) {
  if (!overlap || !models.WebIntakeRuntimeReconciliation?.findOne) return;
  const clauses = [];
  if (scope.type === 'clinic') {
    clauses.push({ scopeType: 'group', scopeId: overlap.group_id });
    const siblings = overlap.clinic_ids.filter((id) => id !== scope.id);
    if (siblings.length) clauses.push({ scopeType: 'clinic', scopeId: { [Op.in]: siblings } });
  } else if (overlap.clinic_ids.length) {
    clauses.push({ scopeType: 'clinic', scopeId: { [Op.in]: overlap.clinic_ids } });
  }
  if (!clauses.length) return;
  const row = await models.WebIntakeRuntimeReconciliation.findOne({
    where: {
      status: { [Op.in]: ['pending', 'preparing', 'deploying', 'rolling_back', 'grace', 'failed'] },
      [Op.or]: clauses,
    },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (row) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_overlapping_transition',
      'Ya hay un cambio de medición en curso que afecta a este grupo de clínicas.',
      409,
      { reconciliation_id: row.id, group_id: overlap.group_id }
    );
  }
}

async function effectiveSourceRecord(scope, sourceRecord, candidate, options = {}) {
  if (sourceRecord && inheritedRuntimeScope(sourceRecord)) {
    // A materialized clinic row is only a cache of the group's runtime. Group
    // A may already have rotated to B while this row still contains A. Resolve
    // and overlay the current group before staging a clinic override B -> C.
    return effectiveIntakeConfigForScope({
      scopeType: 'clinic',
      clinicId: scope.id,
      directRecord: plain(sourceRecord),
      preserveClinicConfig: true,
      rejectInvalidInheritance: true,
      models: options.models || db,
      transaction: options.transaction || null,
    });
  }
  if (sourceRecord && candidateDeclaresRuntime(sourceRecord)) {
    return sourceRecord;
  }
  return (await inheritedRuntimeRecord(scope, options))
    || sourceRecord
    || disabledSourceRecord(scope, candidate);
}

async function effectiveRuntimePlans({
  scope,
  sourceRecord,
  targetRecord,
  publications,
  models = db,
  transaction = null,
  env = process.env,
} = {}) {
  const rows = publications.map(plain);
  const clinicIds = [...new Set(rows
    .filter((publication) => publication.scopeType === 'clinic')
    .map((publication) => positiveInteger(publication.clinicaId))
    .filter(Boolean))];
  const directRows = clinicIds.length
    ? await models.IntakeConfig.findAll({
        where: { assignment_scope: 'clinic', clinic_id: { [Op.in]: clinicIds } },
        raw: true,
        ...(transaction ? { transaction } : {}),
      })
    : [];
  const directByClinic = new Map(directRows.map((row) => [positiveInteger(row.clinic_id), row]));
  let inheritedGroup = null;
  if (scope.type === 'clinic' && !sourceRecord) {
    const clinic = await models.Clinica.findByPk(scope.id, {
      attributes: ['grupoClinicaId'], raw: true, ...(transaction ? { transaction } : {}),
    });
    const groupId = positiveInteger(clinic?.grupoClinicaId);
    if (groupId) {
      inheritedGroup = await models.IntakeConfig.findOne({
        where: { assignment_scope: 'group', group_id: groupId },
        raw: true,
        ...(transaction ? { transaction } : {}),
      });
    }
  }
  const sourceLocations = locationIds(sourceRecord);
  const targetLocations = locationIds(targetRecord);
  return rows.map((publication) => {
    let sourceEffective = null;
    let targetEffective = null;
    if (publication.scopeType === 'group') {
      sourceEffective = sourceRecord;
      targetEffective = targetRecord;
    } else {
      const clinicId = positiveInteger(publication.clinicaId);
      const direct = directByClinic.get(clinicId) || null;
      const directInheritance = inheritedRuntimeScope(direct);
      const inheritancePresent = Boolean(
        direct?.config
        && Object.prototype.hasOwnProperty.call(direct.config, 'runtime_inheritance')
      );
      const malformedInheritance = inheritancePresent && !directInheritance;
      const inheritsChangedGroup = directInheritance?.type === 'group'
        && directInheritance.id === positiveInteger(scope.id);
      const explicitDirectRuntime = direct
        && !inheritancePresent
        && recordDeclaresRuntime(direct);
      if (scope.type === 'clinic' && clinicId === scope.id) {
        sourceEffective = sourceRecord || (
          inheritedGroup && locationIds(inheritedGroup).has(clinicId) ? inheritedGroup : null
        );
        targetEffective = targetRecord;
      } else if (malformedInheritance || (directInheritance && !inheritsChangedGroup)) {
        // Un marker roto/cruzado no puede convertirse en override silencioso.
        // Mantener disabled provoca source mismatch y bloquea el rollout.
        sourceEffective = null;
        targetEffective = null;
      } else if (explicitDirectRuntime) {
        sourceEffective = direct;
        targetEffective = direct;
      } else {
        sourceEffective = sourceLocations.has(clinicId) ? sourceRecord : null;
        targetEffective = targetLocations.has(clinicId) ? targetRecord : null;
      }
    }
    const sourceRuntime = runtimeForRecord(sourceEffective, { env });
    const targetRuntime = runtimeForRecord(targetEffective, { env });
    return {
      publication,
      source_effective: sourceEffective,
      target_effective: targetEffective,
      source_runtime: sourceRuntime,
      target_runtime: targetRuntime,
    };
  });
}

async function artifactMapForPlans(plans, { models = db, transaction = null } = {}) {
  const ids = [...new Set(plans
    .map(({ publication }) => publication.activeArtifactId || publication.lastGoodArtifactId)
    .filter(Boolean))];
  if (!ids.length) return new Map();
  const artifacts = await models.WebArtifact.findAll({
    where: { id: { [Op.in]: ids } },
    ...(transaction ? { transaction } : {}),
  });
  return new Map(artifacts.map((row) => [String(plain(row).id), plain(row)]));
}

async function runtimeGatePlan({ scope, sourceRecord, targetRecord, models = db, transaction = null, env = process.env } = {}) {
  const publications = await candidatePublications(scope, { models, transaction });
  const plans = await effectiveRuntimePlans({
    scope, sourceRecord, targetRecord, publications, models, transaction, env,
  });
  const artifacts = await artifactMapForPlans(plans, { models, transaction });
  const mismatches = plans.filter(({ publication, target_runtime: targetRuntime }) => {
    if (BUSY_STATUSES.has(String(publication.status || ''))) return true;
    const artifactId = publication.activeArtifactId || publication.lastGoodArtifactId;
    const artifact = artifacts.get(String(artifactId || ''));
    return !artifact || String(artifact.runtimeConfigHash || '') !== targetRuntime.runtime_config_hash;
  });
  const sourceMismatches = plans.filter(({ publication, source_runtime: sourceRuntime }) => {
    if (BUSY_STATUSES.has(String(publication.status || ''))) return false;
    const artifactId = publication.activeArtifactId || publication.lastGoodArtifactId;
    const artifact = artifacts.get(String(artifactId || ''));
    return artifact && String(artifact.runtimeConfigHash || '') !== sourceRuntime.runtime_config_hash;
  });
  return {
    publications,
    plans,
    artifacts,
    mismatches,
    source_mismatches: sourceMismatches,
    requires_gate: mismatches.length > 0,
  };
}

async function persistReconciliation({
  scope,
  sourceRecord,
  targetRecord,
  models = db,
  sequelize = db.sequelize,
  transaction,
  env = process.env,
  enqueueUniqueJobRequest = jobRequestsService.enqueueUniqueJobRequest,
} = {}) {
  if (!transaction) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_transaction_required',
      'Los cambios de medición con publicaciones WordPress activas requieren una transacción durable.',
      503
    );
  }
  const Model = models.WebIntakeRuntimeReconciliation;
  if (!Model) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_reconciliation_model_missing',
      'Falta aplicar la migración del reconciliador de medición web.',
      503
    );
  }
  const patch = runtimeConfigPatch(targetRecord);
  const sourceHash = runtimeHashForRecord(sourceRecord);
  const targetHash = runtimeHashForRecord(targetRecord);
  const sourceFingerprint = runtimeFingerprintForRecord(sourceRecord);
  const targetFingerprint = runtimeFingerprintForRecord(targetRecord);
  let row = await Model.findOne({
    where: { scopeType: scope.type, scopeId: scope.id },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const current = plain(row);
  const graceExpiry = current?.graceExpiresAt || current?.grace_expires_at;
  const transitionInProgress = current
    && ['pending', 'preparing', 'deploying', 'rolling_back', 'grace', 'failed'].includes(String(current.status || ''))
    && !(current.status === 'grace' && graceExpiry && new Date(graceExpiry).getTime() <= Date.now());
  const patchMatches = current
    && canonicalSerialize(current.targetConfigPatch || {}) === canonicalSerialize(patch)
    && String(reconciliationSecret(current, 'target', { env }) || '')
      === String(plain(targetRecord)?.hmac_key || '');
  const sameTarget = current
    && !['completed', 'failed'].includes(String(current.status || ''))
    && current.targetRuntimeHash === targetHash
    && current.targetRuntimeFingerprint === targetFingerprint
    && patchMatches;
  let generation;
  if (row && sameTarget) {
    generation = Number(row.generation || 1);
  } else if (row) {
    if (transitionInProgress) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_reconciliation_in_progress',
        'Ya hay una rotación de medición WordPress en curso para este ámbito.',
        409,
        { reconciliation_id: row.id, generation: Number(row.generation || 1) }
      );
    }
    generation = Number(row.generation || 0) + 1;
    const envelopeIdentity = {
      id: row.id, scopeType: scope.type, scopeId: scope.id, generation,
    };
    await row.update({
      generation,
      sourceRuntimeHash: sourceHash,
      sourceRuntimeFingerprint: sourceFingerprint,
      targetRuntimeHash: targetHash,
      targetRuntimeFingerprint: targetFingerprint,
      targetHmacEnvelope: sealReconciliationSecret(
        plain(targetRecord)?.hmac_key || null, envelopeIdentity, 'target', { env }
      ),
      sourceHmacEnvelope: sealReconciliationSecret(
        plain(sourceRecord)?.hmac_key || null, envelopeIdentity, 'source', { env }
      ),
      sourceConfigPatch: runtimeConfigPatch(sourceRecord),
      targetConfigPatch: patch,
      status: 'pending',
      expectedDeployments: {},
      lastErrorCode: null,
      lastErrorMessage: null,
      committedAt: null,
      graceExpiresAt: null,
      // Una rotación ordinaria posterior abre otra generación semántica. No
      // puede heredar la key idempotente de una recovery administrativa vieja.
      lastRecoveryRequestId: null,
      lastRecoveryRequestHash: null,
      lastRecoveryAction: null,
      lastRecoveryGeneration: null,
    }, { transaction });
  } else {
    generation = 1;
    const id = crypto.randomUUID();
    const envelopeIdentity = { id, scopeType: scope.type, scopeId: scope.id, generation };
    row = await Model.create({
      id,
      scopeType: scope.type,
      scopeId: scope.id,
      generation,
      sourceRuntimeHash: sourceHash,
      sourceRuntimeFingerprint: sourceFingerprint,
      targetRuntimeHash: targetHash,
      targetRuntimeFingerprint: targetFingerprint,
      targetHmacEnvelope: sealReconciliationSecret(
        plain(targetRecord)?.hmac_key || null, envelopeIdentity, 'target', { env }
      ),
      sourceHmacEnvelope: sealReconciliationSecret(
        plain(sourceRecord)?.hmac_key || null, envelopeIdentity, 'source', { env }
      ),
      sourceConfigPatch: runtimeConfigPatch(sourceRecord),
      targetConfigPatch: patch,
      status: 'pending',
      expectedDeployments: {},
    }, { transaction });
  }
  const queued = await enqueueUniqueJobRequest({
    type: JOB_TYPE,
    priority: 'high',
    status: 'pending',
    origin: 'marketing_web:intake_runtime',
    maxAttempts: 20,
    dedupeScope: `${row.id}:${generation}`,
    // Deliberadamente no incluye config, features ni HMAC.
    payload: {
      reconciliation_id: row.id,
      generation,
      scope_type: scope.type,
      scope_id: scope.id,
    },
  }, {
    transaction,
    JobRequestModel: models.JobRequest,
    sequelizeInstance: sequelize,
  });
  return { row, generation, job: queued.job, created: queued.created !== false };
}

function restoreCommittedRuntime(target, sourceRecord) {
  const restored = applyRuntimePatch(target, runtimeConfigPatch(sourceRecord), plain(sourceRecord)?.hmac_key || null);
  target.config = restored.config;
  target.hmac_key = restored.hmac_key;
  return target;
}

async function stageCandidateWrite({
  candidate,
  sourceRecord,
  setCandidate,
  options = {},
  models = db,
  sequelize = db.sequelize,
} = {}) {
  const env = options.env || process.env;
  const scope = scopeFromRecord(candidate);
  if (!scope) return { gated: false, reason: 'scope_incomplete' };
  const overlap = await lockRuntimeOverlap(scope, {
    models,
    transaction: options.transaction || null,
  });
  const effectiveSource = await effectiveSourceRecord(scope, sourceRecord, candidate, {
    models,
    transaction: options.transaction || null,
    lock: true,
  });
  const inheritedSource = scope.type === 'clinic'
    && runtimeScopeFromRecord(effectiveSource)?.type === 'group';
  const rawTarget = recordWithScope({ ...(plain(sourceRecord) || {}), ...plain(candidate) }, scope);
  if (
    sourceRecord
    && candidateDeclaresRuntime(sourceRecord)
    && runtimeFingerprintForRecord(rawTarget) === runtimeFingerprintForRecord(sourceRecord)
  ) {
    const unchangedTarget = inheritedRuntimeScope(sourceRecord)
      ? recordWithScope(withRuntimeInheritance(rawTarget, effectiveSource), scope)
      : rawTarget;
    setCandidate(unchangedTarget);
    return {
      gated: false,
      reason: inheritedRuntimeScope(sourceRecord)
        ? 'inherited_runtime_refreshed'
        : 'runtime_unchanged',
    };
  }
  const targetRecord = inheritedSource && !candidateDeclaresRuntime(candidate)
    ? recordWithScope(withRuntimeInheritance(rawTarget, effectiveSource), scope)
    : recordWithScope(withoutRuntimeInheritance(rawTarget), scope);
  const materializedSource = inheritedSource
    ? recordWithScope(withRuntimeInheritance(rawTarget, effectiveSource), scope)
    : recordWithScope(restoreCommittedRuntime({ ...rawTarget }, effectiveSource), scope);

  // A write that changes only campaign/Meta/diagnostic fields must never be
  // blocked by a rollout nor cause a second generation. This also materializes
  // an inherited group runtime into a new direct clinic row without silently
  // disabling measurement or recompiling identical artifacts.
  if (runtimeFingerprintForRecord(targetRecord) === runtimeFingerprintForRecord(effectiveSource)) {
    setCandidate(targetRecord);
    return { gated: false, reason: inheritedSource ? 'inherited_runtime_materialized' : 'runtime_unchanged' };
  }
  await assertNoOverlappingRuntimeTransition(scope, overlap, {
    models,
    transaction: options.transaction || null,
  });
  const gate = await runtimeGatePlan({
    scope,
    sourceRecord: effectiveSource,
    targetRecord,
    models,
    transaction: options.transaction || null,
    env,
  });
  if (!gate.requires_gate) {
    setCandidate(targetRecord);
    return { gated: false, reason: 'artifacts_already_compatible' };
  }
  if (gate.source_mismatches.length) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_source_unrecoverable',
      'La publicación activa no coincide con la configuración efectiva que debe conservarse durante la transición.',
      409,
      { publication_ids: gate.source_mismatches.map(({ publication }) => publication.id) }
    );
  }
  const persisted = await persistReconciliation({
    scope,
    sourceRecord: effectiveSource,
    targetRecord,
    models,
    sequelize,
    transaction: options.transaction,
    env,
    enqueueUniqueJobRequest: options.enqueueUniqueJobRequest || jobRequestsService.enqueueUniqueJobRequest,
  });
  // A direct clinic override created from a group inheritance remains a
  // clinic-owned row, but materializes the effective source runtime until all
  // publications ACK the target. The source scope itself lives in the durable
  // reconciliation snapshot and is reconstructed for hashing/authentication.
  setCandidate(materializedSource);
  return { gated: true, gate, ...persisted };
}

async function stageIntakeConfigInstanceWrite(instance, options = {}) {
  const models = options.models || db;
  const candidate = plain(instance);
  let sourceRecord = null;
  if (!instance.isNewRecord) {
    sourceRecord = await models.IntakeConfig.findByPk(instance.id, {
      raw: true,
      ...(options.transaction ? { transaction: options.transaction, lock: options.transaction.LOCK.UPDATE } : {}),
    });
  }
  return stageCandidateWrite({
    candidate,
    sourceRecord,
    options,
    models,
    sequelize: options.sequelize || db.sequelize,
    setCandidate: (restored) => {
      instance.setDataValue('config', restored.config);
      instance.setDataValue('hmac_key', restored.hmac_key);
      if (Array.isArray(options.fields)) {
        if (!options.fields.includes('config')) options.fields.push('config');
        if (!options.fields.includes('hmac_key')) options.fields.push('hmac_key');
      }
    },
  });
}

async function stageIntakeConfigUpsert(values, options = {}) {
  const models = options.models || db;
  const scope = scopeFromRecord(values);
  if (!scope) return { gated: false, reason: 'scope_incomplete' };
  const sourceRecord = await models.IntakeConfig.findOne({
    where: scopeWhere(scope),
    raw: true,
    ...(options.transaction ? { transaction: options.transaction, lock: options.transaction.LOCK.UPDATE } : {}),
  });
  return stageCandidateWrite({
    candidate: values,
    sourceRecord,
    options,
    models,
    sequelize: options.sequelize || db.sequelize,
    setCandidate: (restored) => {
      values.config = restored.config;
      values.hmac_key = restored.hmac_key;
    },
  });
}

async function assertIntakeConfigDestroyAllowed(instance, options = {}) {
  const models = options.models || db;
  const scope = scopeFromRecord(instance);
  if (!scope) return { allowed: true, reason: 'scope_incomplete' };
  const publications = await candidatePublications(scope, {
    models,
    transaction: options.transaction || null,
    lock: Boolean(options.transaction),
  });
  if (publications.length) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_destroy_requires_reconciliation',
      'No se puede eliminar la medición mientras existan publicaciones activas; despublícalas o reconcilia primero el runtime.',
      409,
      { publication_ids: publications.map((publication) => plain(publication).id) }
    );
  }
  return { allowed: true, reason: 'no_served_publications' };
}

function actorIdFor({ publication, artifact, project }) {
  return positiveInteger(publication.updatedByUserId)
    || positiveInteger(publication.createdByUserId)
    || positiveInteger(artifact?.createdByUserId)
    || positiveInteger(project?.updatedByUserId)
    || positiveInteger(project?.createdByUserId);
}

function preparedRuntimeMarker(reconciliation, generation) {
  return {
    reconciliation_id: reconciliation.id,
    generation: Number(generation),
    suppress_landing_published: true,
  };
}

function hmacGraceMs(env = process.env) {
  const configured = Number(env.MARKETING_WEB_RUNTIME_HMAC_GRACE_MS || DEFAULT_HMAC_GRACE_MS);
  return Number.isFinite(configured) && configured >= 60_000
    ? Math.min(configured, 7 * 24 * 60 * 60 * 1000)
    : DEFAULT_HMAC_GRACE_MS;
}

async function prepareArtifacts({
  reconciliation,
  generation,
  plans,
  artifacts,
  models = db,
  env = process.env,
  compileRevisionFn = compileRevision,
  storeArtifactBundleFn = storeArtifactBundle,
} = {}) {
  const prepared = [];
  for (const plan of plans) {
    const publication = plan.publication;
    if (BUSY_STATUSES.has(String(publication.status || ''))) {
      return {
        waiting: true,
        reason: 'publication_busy',
        publication_id: publication.id,
      };
    }
    const previousArtifactId = publication.activeArtifactId || publication.lastGoodArtifactId;
    const previousArtifact = artifacts.get(String(previousArtifactId || ''));
    if (!previousArtifact) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_active_artifact_missing',
        'Una publicación activa no conserva un artefacto verificado.',
        409,
        { publication_id: publication.id }
      );
    }
    if (previousArtifact.runtimeConfigHash === plan.target_runtime.runtime_config_hash) continue;
    const sourceHmac = String(plan.source_effective?.hmac_key || '').trim();
    const targetHmac = String(plan.target_effective?.hmac_key || '').trim();
    if (
      publication.channel === 'wordpress'
      && sourceHmac.length >= 16
      && sourceHmac === targetHmac
    ) {
      const installation = plain(await models.WebWordpressInstallation.findByPk(
        publication.wordpressInstallationId
      ));
      if (!supportsMultiPublication(installation)) {
        throw new WebIntakeRuntimeReconciliationError(
          'web_intake_runtime_exact_artifact_plugin_update_required',
          'Actualiza el plugin de WordPress antes de cambiar la medición sin rotar su clave.',
          409,
          { publication_id: publication.id, installation_id: publication.wordpressInstallationId }
        );
      }
    }
    const project = plain(await models.WebProject.findByPk(publication.projectId));
    const actorId = actorIdFor({ publication, artifact: previousArtifact, project });
    if (!actorId) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_actor_missing',
        'No existe un actor interno válido para recompilar la publicación.',
        409,
        { publication_id: publication.id }
      );
    }
    const revisionId = publication.activeRevisionId || previousArtifact.revisionId;
    const compiled = await compileRevisionFn({
      actorId,
      revisionId,
      body: {
        environment: 'production',
        base_url: publicationBaseUrl(publication),
        clinic_id: positiveInteger(publication.configuration?.clinic_id),
        intake_endpoint: '/_clinicaclick/intake',
      },
      trustedRuntime: plan.target_runtime,
      runtimeReconciliation: {
        id: reconciliation.id,
        generation: Number(generation),
      },
      rollbackSource: { publicationId: publication.id, artifactId: previousArtifact.id },
      models,
      sequelize: models.sequelize || db.sequelize,
    });
    if (compiled.runtime_config_hash !== plan.target_runtime.runtime_config_hash) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_compiler_hash_mismatch',
        'El compilador no produjo el runtime de medición solicitado.',
        500,
        { publication_id: publication.id }
      );
    }
    const compiledRow = plain(await models.WebArtifact.findByPk(compiled.id));
    if (!compiledRow || compiledRow.runtimeConfigHash !== plan.target_runtime.runtime_config_hash) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_compiled_artifact_missing',
        'El artefacto reconciliado no quedó persistido de forma íntegra.',
        500,
        { publication_id: publication.id }
      );
    }
    if (publication.channel === 'wordpress') {
      const siblings = await models.WebPublication.findAll({
        where: { wordpressInstallationId: publication.wordpressInstallationId },
        order: [['path', 'ASC'], ['id', 'ASC']],
      });
      assertWordpressPilotManifestCompatible(publication, siblings, compiled.manifest);
    }
    // El descriptor authenticated_db exige installation_id y por tanto solo
    // se preconstruye aquí para WordPress. Hosted/custom conservan el bundle
    // inmutable en WebArtifact y su deploy normal publica/verifica el canal.
    const descriptor = publication.channel === 'wordpress'
      ? await storeArtifactBundleFn({
          artifact: compiled,
          installationId: publication.wordpressInstallationId,
          env,
        })
      : {};
    prepared.push({
      publication_id: publication.id,
      installation_id: publication.wordpressInstallationId,
      project_id: publication.projectId,
      revision_id: revisionId,
      previous_artifact_id: previousArtifactId,
      publication_version: Number(publication.version),
      actor_id: actorId,
      artifact_id: compiled.id,
      artifact_hash: compiled.artifact_hash,
      runtime_config_hash: compiled.runtime_config_hash,
      storage: {
        ...descriptor,
        runtime_reconciliation: preparedRuntimeMarker(reconciliation, generation),
      },
    });
  }
  return { waiting: false, prepared };
}

function exactStringSet(values) {
  return [...new Set(values.map(String))].sort();
}

async function commitPreparedRuntime({
  reconciliationId,
  generation,
  prepared,
  models = db,
  sequelize = db.sequelize,
  env = process.env,
  enqueueJobRequest = jobRequestsService.enqueueJobRequest,
} = {}) {
  return sequelize.transaction(async (transaction) => {
    // Global lock order: IntakeConfig -> WebIntakeRuntimeReconciliation ->
    // installations -> publications -> deployments. Hooks already own/lock the
    // IntakeConfig before persistReconciliation; workers must use the same
    // order to avoid Intake→Recon / Recon→Intake deadlocks.
    const probe = plain(await models.WebIntakeRuntimeReconciliation.findByPk(reconciliationId, { transaction }));
    if (!probe) {
      return { stale: true, reason: 'reconciliation_not_found' };
    }
    if (Number(probe.generation) !== Number(generation)) {
      return { stale: true, reason: 'newer_generation' };
    }
    const scope = { type: probe.scopeType, id: positiveInteger(probe.scopeId) };
    const intake = await models.IntakeConfig.findOne({
      where: scopeWhere(scope),
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!intake) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_config_missing',
        'La configuración de medición ya no existe.',
        409
      );
    }
    const reconciliation = await models.WebIntakeRuntimeReconciliation.findByPk(reconciliationId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!reconciliation || Number(reconciliation.generation) !== Number(generation)) {
      return { stale: true, reason: reconciliation ? 'newer_generation' : 'reconciliation_not_found' };
    }
    if (['deploying', 'rolling_back', 'grace', 'completed', 'failed'].includes(reconciliation.status)) {
      return { activated: true, idempotent: true, deployments: [] };
    }
    const current = plain(intake);
    const sourceSnapshot = sourceRecordForReconciliation(current, plain(reconciliation), { env });
    const targetSnapshot = targetRecordForReconciliation(current, plain(reconciliation), { env });
    const currentFingerprint = runtimeFingerprintForRecord(current);
    const sourceMatches = runtimeHashForRecord(sourceSnapshot, { env }) === reconciliation.sourceRuntimeHash
      && runtimeFingerprintForRecord(sourceSnapshot) === reconciliation.sourceRuntimeFingerprint
      && currentFingerprint === runtimeFingerprintForRecord(materializeRuntimeForOwnership(sourceSnapshot, scope));
    const targetMatches = runtimeHashForRecord(targetSnapshot, { env }) === reconciliation.targetRuntimeHash
      && runtimeFingerprintForRecord(targetSnapshot) === reconciliation.targetRuntimeFingerprint
      && currentFingerprint === runtimeFingerprintForRecord(materializeRuntimeForOwnership(targetSnapshot, scope));
    if (!sourceMatches && !targetMatches) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_source_changed',
        'La configuración vigente cambió durante la reconciliación.',
        409
      );
    }
    const targetRecord = targetSnapshot;
    const initialPublications = await candidatePublications(scope, { models, transaction });
    const installationIds = exactStringSet(initialPublications
      .map((publication) => publication.wordpressInstallationId)
      .filter(Boolean));
    if (installationIds.length) {
      await models.WebWordpressInstallation.findAll({
        where: { id: { [Op.in]: installationIds } },
        order: [['id', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
    }
    const publications = await candidatePublications(scope, { models, transaction, lock: true });
    const plans = await effectiveRuntimePlans({
      scope,
      sourceRecord: sourceSnapshot,
      targetRecord,
      publications,
      models,
      transaction,
      env,
    });
    const currentArtifacts = await artifactMapForPlans(plans, { models, transaction });
    const mismatches = plans.filter(({ publication, target_runtime: runtime }) => {
      if (BUSY_STATUSES.has(String(publication.status || ''))) return true;
      const artifact = currentArtifacts.get(String(publication.activeArtifactId || publication.lastGoodArtifactId || ''));
      return !artifact || artifact.runtimeConfigHash !== runtime.runtime_config_hash;
    });
    if (mismatches.some(({ publication }) => BUSY_STATUSES.has(String(publication.status || '')))) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_publication_busy',
        'Una publicación cambió mientras se preparaba la reconciliación.',
        409
      );
    }
    const expectedIds = exactStringSet(mismatches.map(({ publication }) => publication.id));
    const preparedIds = exactStringSet(prepared.map((item) => item.publication_id));
    if (canonicalSerialize(expectedIds) !== canonicalSerialize(preparedIds)) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_publication_set_changed',
        'El conjunto de publicaciones activas cambió durante la reconciliación.',
        409
      );
    }
    const lockedPublicationById = new Map(publications.map((publication) => [
      String(plain(publication)?.id || ''),
      publication,
    ]));
    const writableMismatches = mismatches.map((plan) => {
      const publicationId = String(plan.publication.id);
      const lockedPublication = lockedPublicationById.get(publicationId);
      if (!lockedPublication || typeof lockedPublication.update !== 'function') {
        throw new WebIntakeRuntimeReconciliationError(
          'web_intake_runtime_publication_lock_invalid',
          'No se pudo bloquear una publicación durante la reconciliación.',
          409,
          { publication_id: plan.publication.id }
        );
      }
      return { ...plan, locked_publication: lockedPublication };
    });
    const planByPublication = new Map(plans.map((plan) => [String(plan.publication.id), plan]));
    const mismatchIds = new Set(expectedIds);
    const carriedLineage = objectValue(plain(reconciliation).expectedDeployments);
    const validatedCarriedLineage = {};
    for (const [publicationId, entry] of Object.entries(carriedLineage)) {
      if (!positiveInteger(entry?.carried_from_generation)) continue;
      const plan = planByPublication.get(String(publicationId));
      if (!plan) {
        throw new WebIntakeRuntimeReconciliationError(
          'web_intake_runtime_recovery_publication_set_changed',
          'Una publicación del linaje de recuperación ya no existe en el ámbito.',
          409,
          { publication_id: publicationId }
        );
      }
      // Una ruta source se sustituirá por el deployment fresco creado abajo.
      if (mismatchIds.has(String(publicationId))) continue;
      const publication = plain(plan.publication);
      const activeArtifactId = String(publication.activeArtifactId || publication.lastGoodArtifactId || '');
      const activeArtifact = currentArtifacts.get(activeArtifactId);
      const deployment = plain(await models.WebPublicationDeployment.findByPk(entry.deployment_id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      }));
      const deploymentStorageMarker = objectValue(deployment?.storage).runtime_reconciliation;
      const deploymentResultMarker = objectValue(deployment?.result).runtime_reconciliation;
      const sourceArtifactId = String(entry.source_artifact_id || deployment?.previousArtifactId || '');
      const sourceArtifact = plain(await models.WebArtifact.findByPk(sourceArtifactId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      }));
      if (
        !deployment
        || deployment.status !== 'verified'
        || deployment.action !== 'publish'
        || String(deployment.publicationId || '') !== String(publicationId)
        || String(deployment.projectId || '') !== String(publication.projectId || '')
        || String(deployment.artifactId || '') !== activeArtifactId
        || String(deployment.previousArtifactId || '') !== sourceArtifactId
        || String(entry.artifact_id || '') !== activeArtifactId
        || String(deploymentStorageMarker?.reconciliation_id || '') !== String(reconciliation.id)
        || Number(deploymentStorageMarker?.generation) !== Number(entry.carried_from_generation)
        || String(deploymentResultMarker?.reconciliation_id || '') !== String(reconciliation.id)
        || Number(deploymentResultMarker?.generation) !== Number(entry.carried_from_generation)
        || !activeArtifact
        || activeArtifact.status !== 'ready'
        || activeArtifact.environment !== 'production'
        || String(activeArtifact.projectId || '') !== String(publication.projectId || '')
        || String(deployment.revisionId || '') !== String(activeArtifact.revisionId || '')
        || String(activeArtifact.runtimeConfigHash || '') !== plan.target_runtime.runtime_config_hash
        || (entry.artifact_hash && String(activeArtifact.artifactHash || '') !== String(entry.artifact_hash))
        || !sourceArtifact
        || sourceArtifact.status !== 'ready'
        || sourceArtifact.environment !== 'production'
        || String(sourceArtifact.projectId || '') !== String(publication.projectId || '')
        || String(sourceArtifact.runtimeConfigHash || '') !== plan.source_runtime.runtime_config_hash
      ) {
        throw new WebIntakeRuntimeReconciliationError(
          'web_intake_runtime_recovery_lineage_untrusted',
          'El linaje conservado dejó de acreditar una ruta target verificada.',
          409,
          { publication_id: publicationId }
        );
      }
      validatedCarriedLineage[publicationId] = {
        ...entry,
        source_artifact_id: sourceArtifactId,
      };
    }
    const preparedById = new Map(prepared.map((item) => [String(item.publication_id), item]));
    const deployments = [];
    for (const { publication, target_runtime: runtime, locked_publication: lockedPublication } of writableMismatches) {
      const item = preparedById.get(String(publication.id));
      if (
        Number(publication.version) !== Number(item.publication_version)
        || String(publication.activeArtifactId || publication.lastGoodArtifactId || '')
          !== String(item.previous_artifact_id || '')
        || runtime.runtime_config_hash !== item.runtime_config_hash
      ) {
        throw new WebIntakeRuntimeReconciliationError(
          'web_intake_runtime_publication_changed',
          'Una publicación cambió durante la reconciliación.',
          409,
          { publication_id: publication.id }
        );
      }
      const artifact = await models.WebArtifact.findByPk(item.artifact_id, { transaction });
      const artifactValue = plain(artifact);
      const preparedMarker = objectValue(item.storage).runtime_reconciliation;
      if (
        !artifact
        || artifactValue.runtimeConfigHash !== runtime.runtime_config_hash
        || artifactValue.status !== 'ready'
        || artifactValue.environment !== 'production'
        || String(artifactValue.projectId || '') !== String(publication.projectId || '')
        || String(artifactValue.revisionId || '') !== String(item.revision_id || '')
        || String(artifactValue.artifactHash || '') !== String(item.artifact_hash || '')
        || String(preparedMarker?.reconciliation_id || '') !== String(reconciliation.id)
        || Number(preparedMarker?.generation) !== Number(generation)
      ) {
        throw new WebIntakeRuntimeReconciliationError(
          'web_intake_runtime_artifact_changed',
          'El artefacto preparado ya no es publicable.',
          409,
          { publication_id: publication.id }
        );
      }
      if (publication.channel === 'wordpress') {
        const siblings = publications.filter((row) => (
          String(row.wordpressInstallationId) === String(publication.wordpressInstallationId)
        ));
        assertWordpressPilotManifestCompatible(publication, siblings, plain(artifact).manifest);
      }
      const latest = await models.WebPublicationDeployment.findOne({
        where: { publicationId: publication.id },
        order: [['sequence', 'DESC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const sequence = Number(latest?.sequence || 0) + 1;
      const expectedVersion = Number(publication.version) + 1;
      const deployment = await models.WebPublicationDeployment.create({
        id: crypto.randomUUID(),
        publicationId: publication.id,
        projectId: publication.projectId,
        revisionId: item.revision_id,
        artifactId: item.artifact_id,
        previousArtifactId: item.previous_artifact_id,
        sequence,
        action: 'publish',
        status: 'queued',
        expectedPublicationVersion: expectedVersion,
        storage: item.storage,
        result: {
          runtime_reconciliation: {
            reconciliation_id: reconciliation.id,
            generation: Number(generation),
          },
        },
        requestId: `runtime:${reconciliation.id}:${generation}`,
        actorUserId: item.actor_id,
      }, { transaction });
      await lockedPublication.update({
        desiredRevisionId: item.revision_id,
        status: 'pending',
        version: expectedVersion,
        updatedByUserId: item.actor_id,
        lastErrorCode: null,
        lastErrorMessage: null,
      }, { transaction });
      const job = await enqueueJobRequest({
        type: 'web_publication_deploy',
        priority: 'high',
        status: 'pending',
        origin: 'marketing_web:intake_runtime',
        maxAttempts: 180,
        requestedBy: item.actor_id,
        requestedByName: 'Clinicaclick',
        requestedByRole: 'system',
        payload: {
          publication_id: publication.id,
          deployment_id: deployment.id,
          scope_type: publication.scopeType,
          ...(publication.scopeType === 'clinic'
            ? { clinicId: publication.clinicaId }
            : { groupId: publication.grupoClinicaId }),
        },
      }, { transaction, JobRequestModel: models.JobRequest });
      await Promise.all([
        deployment.update({ jobRequestId: job.id }, { transaction }),
        lockedPublication.update({ jobRequestId: job.id }, { transaction }),
        models.WebAuditEvent.create({
          projectId: publication.projectId,
          scopeType: publication.scopeType,
          clinicaId: publication.scopeType === 'clinic' ? publication.clinicaId : null,
          grupoClinicaId: publication.scopeType === 'group' ? publication.grupoClinicaId : null,
          actorUserId: item.actor_id,
          eventType: 'web.publication.runtime_reconciliation_requested',
          entityType: 'web_publication_deployment',
          entityId: deployment.id,
          requestId: `runtime:${reconciliation.id}:${generation}`,
          previousHash: currentArtifacts.get(String(item.previous_artifact_id))?.artifactHash || null,
          nextHash: item.artifact_hash,
          metadata: {
            publication_id: publication.id,
            sequence,
            job_request_id: job.id,
            reconciliation_id: reconciliation.id,
            generation: Number(generation),
          },
        }, { transaction }),
      ]);
      deployments.push({ publication_id: publication.id, deployment_id: deployment.id, job_request_id: job.id });
    }
    if (!deployments.length) {
      const sourceHmacKey = String(sourceSnapshot.hmac_key || '') || null;
      const targetHmacKey = String(targetRecord.hmac_key || '') || null;
      const needsGrace = Object.keys(validatedCarriedLineage).length > 0
        || Boolean(sourceHmacKey && sourceHmacKey !== targetHmacKey);
      const graceExpiresAt = needsGrace
        ? new Date(Date.now() + hmacGraceMs(env))
        : null;
      await intake.update({
        config: targetRecord.config,
        hmac_key: targetRecord.hmac_key,
      }, { transaction, skipWebRuntimeReconciliation: true });
      await reconciliation.update({
        status: needsGrace ? 'grace' : 'completed',
        sourceHmacEnvelope: needsGrace
          ? sealReconciliationSecret(sourceHmacKey, reconciliation, 'source', { env })
          : null,
        targetHmacEnvelope: null,
        expectedDeployments: validatedCarriedLineage,
        committedAt: new Date(),
        graceExpiresAt,
        lastErrorCode: null,
        lastErrorMessage: null,
      }, { transaction });
      return {
        activated: true,
        promoted: true,
        idempotent: false,
        deployments: [],
        grace_expires_at: graceExpiresAt,
      };
    }
    const expectedDeployments = {
      ...validatedCarriedLineage,
      ...Object.fromEntries(deployments.map((deployment) => {
        const item = preparedById.get(String(deployment.publication_id));
        return [deployment.publication_id, {
          publication_id: deployment.publication_id,
          deployment_id: deployment.deployment_id,
          artifact_id: item.artifact_id,
          artifact_hash: item.artifact_hash,
          runtime_config_hash: item.runtime_config_hash,
          installation_id: item.installation_id || null,
        }];
      })),
    };
    await reconciliation.update({
      status: 'deploying',
      sourceHmacEnvelope: sealReconciliationSecret(
        String(sourceSnapshot.hmac_key || '') || null, reconciliation, 'source', { env }
      ),
      expectedDeployments,
      committedAt: null,
      graceExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    }, { transaction });
    return { activated: true, promoted: false, idempotent: false, deployments };
  });
}

function retryableError(error) {
  if ([
    'web_intake_runtime_config_missing',
    'web_intake_runtime_expected_deployments_missing',
    'web_intake_runtime_deployment_missing',
    'web_intake_runtime_source_changed',
    'web_intake_runtime_target_changed',
  ].includes(String(error?.code || ''))) return false;
  return Number(error?.status || 500) >= 500
    || [
      'web_intake_runtime_publication_busy',
      'web_intake_runtime_publication_set_changed',
      'web_intake_runtime_publication_changed',
    ].includes(String(error?.code || ''));
}

async function noteReconciliationError(row, error) {
  if (!row?.update) return;
  const retryable = retryableError(error);
  const deployed = Object.keys(objectValue(plain(row).expectedDeployments)).length > 0
    || ['deploying', 'rolling_back', 'grace', 'failed'].includes(String(row.status || ''));
  await row.update({
    status: retryable
      ? (deployed ? row.status : 'pending')
      : (deployed ? 'failed' : 'completed'),
    ...(!retryable && !deployed ? {
      sourceHmacEnvelope: null,
      targetHmacEnvelope: null,
      graceExpiresAt: null,
    } : {}),
    lastErrorCode: String(error?.code || 'web_intake_runtime_reconciliation_failed').slice(0, 128),
    lastErrorMessage: String(error?.message || 'No se pudo reconciliar la medición web.').slice(0, 2000),
  }).catch(() => undefined);
}

async function startSourceRollback({
  reconciliation,
  intake,
  expectedRows,
  targetDeployments,
  models,
  transaction,
  enqueueJobRequest = jobRequestsService.enqueueJobRequest,
  env = process.env,
} = {}) {
  const publicationIds = expectedRows.map((entry) => entry.publication_id);
  const pointers = await models.WebPublication.findAll({
    where: { id: { [Op.in]: publicationIds } },
    order: [['wordpressInstallationId', 'ASC'], ['path', 'ASC'], ['id', 'ASC']],
    transaction,
  });
  const installationIds = exactStringSet(pointers
    .map((publication) => plain(publication).wordpressInstallationId)
    .filter(Boolean));
  if (installationIds.length) {
    await models.WebWordpressInstallation.findAll({
      where: { id: { [Op.in]: installationIds } },
      order: [['id', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }
  const publications = await models.WebPublication.findAll({
    where: { id: { [Op.in]: publicationIds } },
    order: [['wordpressInstallationId', 'ASC'], ['path', 'ASC'], ['id', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const byPublication = new Map(publications.map((row) => [String(plain(row).id), row]));
  const sourceRecord = sourceRecordForReconciliation(plain(intake), plain(reconciliation), { env });
  const targetRecord = targetRecordForReconciliation(plain(intake), plain(reconciliation), { env });
  const plans = await effectiveRuntimePlans({
    scope: { type: reconciliation.scopeType, id: positiveInteger(reconciliation.scopeId) },
    sourceRecord,
    targetRecord,
    publications,
    models,
    transaction,
    env,
  });
  const planByPublication = new Map(plans.map((plan) => [String(plan.publication.id), plan]));
  const nextExpected = { ...objectValue(reconciliation.expectedDeployments) };
  const rollbacks = [];
  for (const entry of expectedRows) {
    const publication = byPublication.get(String(entry.publication_id));
    const targetDeployment = targetDeployments.get(String(entry.deployment_id));
    const sourceArtifactId = String(targetDeployment?.previousArtifactId || '').trim();
    const plan = planByPublication.get(String(entry.publication_id));
    const expectedDeploymentGeneration = Number(
      entry.carried_from_generation || reconciliation.generation
    );
    const targetStorageMarker = objectValue(targetDeployment?.storage).runtime_reconciliation;
    const targetResultMarker = objectValue(targetDeployment?.result).runtime_reconciliation;
    if (
      !publication
      || !sourceArtifactId
      || !plan
      || String(targetDeployment?.publicationId || '') !== String(entry.publication_id)
      || String(targetDeployment?.projectId || '') !== String(publication?.projectId || '')
      || targetDeployment?.action !== 'publish'
      || String(targetDeployment?.artifactId || '') !== String(entry.artifact_id || '')
      || String(targetStorageMarker?.reconciliation_id || '') !== String(reconciliation.id)
      || Number(targetStorageMarker?.generation) !== expectedDeploymentGeneration
      || String(targetResultMarker?.reconciliation_id || '') !== String(reconciliation.id)
      || Number(targetResultMarker?.generation) !== expectedDeploymentGeneration
    ) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_rollback_source_missing',
        'No se puede acreditar el artefacto fuente para recuperar la publicación.',
        500,
        { publication_id: entry.publication_id }
      );
    }
    // Validate the complete target -> source lineage before accepting either
    // a new rollback or an existing idempotent one. Otherwise a persisted
    // rollback id could bypass artifact/project/revision checks via `continue`.
    const sourceArtifact = plain(await models.WebArtifact.findByPk(sourceArtifactId, { transaction }));
    const targetArtifact = plain(await models.WebArtifact.findByPk(entry.artifact_id, { transaction }));
    if (
      !sourceArtifact
      || sourceArtifact.status !== 'ready'
      || sourceArtifact.environment !== 'production'
      || String(sourceArtifact.projectId || '') !== String(publication.projectId || '')
      || String(sourceArtifact.runtimeConfigHash || '') !== plan.source_runtime.runtime_config_hash
      || !targetArtifact
      || targetArtifact.status !== 'ready'
      || targetArtifact.environment !== 'production'
      || String(targetArtifact.projectId || '') !== String(publication.projectId || '')
      || String(targetArtifact.runtimeConfigHash || '') !== plan.target_runtime.runtime_config_hash
      || String(targetDeployment.revisionId || '') !== String(targetArtifact.revisionId || '')
      || (entry.artifact_hash && String(targetArtifact.artifactHash || '') !== String(entry.artifact_hash))
    ) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_rollback_artifact_invalid',
        'El artefacto fuente ya no es recuperable de forma verificable.',
        500,
        { publication_id: publication.id, artifact_id: sourceArtifactId }
      );
    }
    const existingRollbackId = String(entry.rollback_deployment_id || '').trim();
    if (existingRollbackId) {
      const existing = await models.WebPublicationDeployment.findByPk(existingRollbackId, { transaction });
      if (existing) {
        const existingValue = plain(existing);
        const storageMarker = objectValue(existingValue.storage).runtime_reconciliation;
        const resultMarker = objectValue(existingValue.result).runtime_reconciliation;
        if (
          String(existingValue.publicationId || '') !== String(publication.id)
          || String(existingValue.projectId || '') !== String(publication.projectId || '')
          || String(existingValue.revisionId || '') !== String(sourceArtifact.revisionId || '')
          || existingValue.action !== 'rollback'
          || String(existingValue.artifactId || '') !== sourceArtifactId
          || String(existingValue.previousArtifactId || '') !== String(entry.artifact_id || '')
          || String(storageMarker?.reconciliation_id || '') !== String(reconciliation.id)
          || Number(storageMarker?.generation) !== Number(reconciliation.generation)
          || storageMarker?.role !== 'source_rollback'
          || String(resultMarker?.reconciliation_id || '') !== String(reconciliation.id)
          || Number(resultMarker?.generation) !== Number(reconciliation.generation)
          || resultMarker?.role !== 'source_rollback'
        ) {
          throw new WebIntakeRuntimeReconciliationError(
            'web_intake_runtime_rollback_deployment_invalid',
            'El deployment de rollback guardado no pertenece a esta recuperación.',
            409,
            { publication_id: publication.id, deployment_id: existingRollbackId }
          );
        }
        rollbacks.push({ publication_id: publication.id, deployment_id: existingRollbackId });
        continue;
      }
    }
    const latest = await models.WebPublicationDeployment.findOne({
      where: { publicationId: publication.id },
      order: [['sequence', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const sequence = Number(latest?.sequence || 0) + 1;
    const expectedVersion = Number(publication.version) + 1;
    const actorId = positiveInteger(targetDeployment?.actorUserId)
      || positiveInteger(publication.updatedByUserId)
      || positiveInteger(publication.createdByUserId);
    if (!actorId) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_actor_missing',
        'No existe un actor interno para recuperar la publicación.',
        500,
        { publication_id: publication.id }
      );
    }
    const rollback = await models.WebPublicationDeployment.create({
      id: crypto.randomUUID(),
      publicationId: publication.id,
      projectId: publication.projectId,
      revisionId: sourceArtifact.revisionId,
      artifactId: sourceArtifact.id,
      previousArtifactId: entry.artifact_id,
      sequence,
      action: 'rollback',
      status: 'queued',
      expectedPublicationVersion: expectedVersion,
      storage: {
        runtime_reconciliation: {
          ...preparedRuntimeMarker(plain(reconciliation), reconciliation.generation),
          role: 'source_rollback',
        },
      },
      result: {
        runtime_reconciliation: {
          reconciliation_id: reconciliation.id,
          generation: Number(reconciliation.generation),
          role: 'source_rollback',
        },
      },
      requestId: `runtime:${reconciliation.id}:${reconciliation.generation}:rollback`,
      actorUserId: actorId,
    }, { transaction });
    await publication.update({
      desiredRevisionId: sourceArtifact.revisionId,
      status: 'rolling_back',
      version: expectedVersion,
      updatedByUserId: actorId,
      lastErrorCode: null,
      lastErrorMessage: null,
    }, { transaction });
    const job = await enqueueJobRequest({
      type: 'web_publication_deploy',
      priority: 'high',
      status: 'pending',
      origin: 'marketing_web:intake_runtime_rollback',
      maxAttempts: 180,
      requestedBy: actorId,
      requestedByName: 'Clinicaclick',
      requestedByRole: 'system',
      payload: {
        publication_id: publication.id,
        deployment_id: rollback.id,
        scope_type: publication.scopeType,
        ...(publication.scopeType === 'clinic'
          ? { clinicId: publication.clinicaId }
          : { groupId: publication.grupoClinicaId }),
      },
    }, { transaction, JobRequestModel: models.JobRequest });
    await Promise.all([
      rollback.update({ jobRequestId: job.id }, { transaction }),
      publication.update({ jobRequestId: job.id }, { transaction }),
      ...(models.WebAuditEvent?.create ? [models.WebAuditEvent.create({
        projectId: publication.projectId,
        scopeType: publication.scopeType,
        clinicaId: publication.scopeType === 'clinic' ? publication.clinicaId : null,
        grupoClinicaId: publication.scopeType === 'group' ? publication.grupoClinicaId : null,
        actorUserId: actorId,
        eventType: 'web.publication.runtime_reconciliation_rollback_requested',
        entityType: 'web_publication_deployment',
        entityId: rollback.id,
        requestId: `runtime:${reconciliation.id}:${reconciliation.generation}:rollback`,
        previousHash: entry.artifact_hash || null,
        nextHash: sourceArtifact.artifactHash || null,
        metadata: {
          publication_id: publication.id,
          sequence,
          job_request_id: job.id,
          reconciliation_id: reconciliation.id,
          generation: Number(reconciliation.generation),
        },
      }, { transaction })] : []),
    ]);
    nextExpected[publication.id] = {
      ...entry,
      source_artifact_id: sourceArtifact.id,
      source_runtime_config_hash: plan.source_runtime.runtime_config_hash,
      rollback_deployment_id: rollback.id,
      rollback_job_request_id: job.id,
    };
    rollbacks.push({ publication_id: publication.id, deployment_id: rollback.id, job_request_id: job.id });
  }
  await reconciliation.update({
    status: 'rolling_back',
    expectedDeployments: nextExpected,
    graceExpiresAt: null,
    lastErrorCode: 'web_intake_runtime_target_deployment_failed',
    lastErrorMessage: 'Se está restaurando y verificando el runtime fuente en todas las publicaciones.',
  }, { transaction });
  return { rolling_back: true, rollbacks };
}

async function lockExpectedPublicationGraph({
  expectedRows,
  deploymentIds,
  models,
  transaction,
} = {}) {
  const publicationIds = exactStringSet((expectedRows || [])
    .map((entry) => entry.publication_id)
    .filter(Boolean));
  // Probe sin lock: solo descubre las instalaciones que deben preceder a las
  // publicaciones en la jerarquía global de locks.
  const pointers = publicationIds.length
    ? await models.WebPublication.findAll({
        where: { id: { [Op.in]: publicationIds } },
        order: [['wordpressInstallationId', 'ASC'], ['path', 'ASC'], ['id', 'ASC']],
        transaction,
      })
    : [];
  const installationIds = exactStringSet([
    ...(expectedRows || []).map((entry) => entry.installation_id).filter(Boolean),
    ...pointers.map((publication) => plain(publication).wordpressInstallationId).filter(Boolean),
  ]);
  if (installationIds.length && models.WebWordpressInstallation?.findAll) {
    await models.WebWordpressInstallation.findAll({
      where: { id: { [Op.in]: installationIds } },
      order: [['id', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }
  const publications = publicationIds.length
    ? await models.WebPublication.findAll({
        where: { id: { [Op.in]: publicationIds } },
        order: [['wordpressInstallationId', 'ASC'], ['path', 'ASC'], ['id', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
      })
    : [];
  const normalizedDeploymentIds = exactStringSet((deploymentIds || []).filter(Boolean));
  const deployments = normalizedDeploymentIds.length
    ? await models.WebPublicationDeployment.findAll({
        where: { id: { [Op.in]: normalizedDeploymentIds } },
        order: [['publicationId', 'ASC'], ['sequence', 'ASC'], ['id', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
      })
    : [];
  return { publications, deployments };
}

function recoveryRequestId(value) {
  const requestId = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/.test(requestId) ? requestId : null;
}

function recoveryReason(value) {
  const reason = String(value || '').trim();
  return reason.length >= 10 && reason.length <= 500 ? reason : null;
}

function assertRecoverySnapshot(record, expectedHash, expectedFingerprint, code, env) {
  if (
    runtimeHashForRecord(record, { env }) !== String(expectedHash || '')
    || runtimeFingerprintForRecord(record) !== String(expectedFingerprint || '')
  ) {
    throw new WebIntakeRuntimeReconciliationError(
      code,
      'El snapshot cifrado de la reconciliación ya no coincide con su identidad guardada.',
      409
    );
  }
}

function runtimeRoleForRecovery(current, sourceRecord, targetRecord, scope) {
  const currentFingerprint = runtimeFingerprintForRecord(current);
  const sourceMatches = currentFingerprint
    === runtimeFingerprintForRecord(materializeRuntimeForOwnership(sourceRecord, scope));
  const targetMatches = currentFingerprint
    === runtimeFingerprintForRecord(materializeRuntimeForOwnership(targetRecord, scope));
  if (!sourceMatches && !targetMatches) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_recovery_current_changed',
      'La configuración vigente ya no coincide con el source ni con el target fallido.',
      409
    );
  }
  if (sourceMatches && targetMatches) return 'source_and_target';
  return sourceMatches ? 'source' : 'target';
}

async function lockRecoveryGraph({
  scope,
  expectedRows,
  sourceRecord,
  targetRecord,
  reconciliationId,
  generation,
  models,
  transaction,
  env,
} = {}) {
  const probedPublications = await candidatePublications(scope, { models, transaction });
  const installationIds = exactStringSet(probedPublications
    .map((publication) => plain(publication).wordpressInstallationId)
    .filter(Boolean));
  if (installationIds.length && models.WebWordpressInstallation?.findAll) {
    await models.WebWordpressInstallation.findAll({
      where: { id: { [Op.in]: installationIds } },
      order: [['id', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }
  const publications = await candidatePublications(scope, {
    models, transaction, lock: true,
  });
  if (
    canonicalSerialize(exactStringSet(probedPublications.map((item) => plain(item).id)))
    !== canonicalSerialize(exactStringSet(publications.map((item) => plain(item).id)))
  ) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_recovery_publication_set_changed',
      'Las publicaciones cambiaron mientras se evaluaba la recuperación.',
      409
    );
  }
  if (publications.some((publication) => BUSY_STATUSES.has(String(plain(publication).status || '')))) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_recovery_publication_busy',
      'Hay publicaciones ocupadas; no es seguro iniciar una recuperación administrativa.',
      409
    );
  }
  // Los rollbacks de la generación fallida no se reutilizan: la recuperación
  // crea deployments nuevos. Solo el deployment target acredita el linaje.
  const deploymentIds = exactStringSet((expectedRows || [])
    .map((entry) => entry.deployment_id)
    .filter(Boolean));
  const deployments = deploymentIds.length
    ? await models.WebPublicationDeployment.findAll({
        where: { id: { [Op.in]: deploymentIds } },
        order: [['publicationId', 'ASC'], ['sequence', 'ASC'], ['id', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
      })
    : [];
  const deploymentById = new Map(deployments.map((item) => [String(plain(item).id), plain(item)]));
  if (deploymentById.size !== deploymentIds.length) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_recovery_deployment_missing',
      'Falta un deployment necesario para acreditar la recuperación.',
      409
    );
  }
  const artifactIds = exactStringSet([
    ...publications.flatMap((publication) => {
      const value = plain(publication);
      return [value.activeArtifactId, value.lastGoodArtifactId];
    }),
    ...(expectedRows || []).flatMap((entry) => {
      const targetDeployment = deploymentById.get(String(entry.deployment_id || ''));
      return [
        entry.artifact_id,
        entry.source_artifact_id,
        targetDeployment?.artifactId,
        targetDeployment?.previousArtifactId,
      ];
    }),
  ].filter(Boolean));
  const artifacts = artifactIds.length
    ? await models.WebArtifact.findAll({
        where: { id: { [Op.in]: artifactIds } },
        order: [['id', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
      })
    : [];
  const artifactById = new Map(artifacts.map((item) => [String(plain(item).id), plain(item)]));
  if (artifactById.size !== artifactIds.length) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_recovery_artifact_missing',
      'Falta un artefacto necesario para acreditar la recuperación.',
      409
    );
  }
  const plans = await effectiveRuntimePlans({
    scope, sourceRecord, targetRecord, publications, models, transaction, env,
  });
  const planByPublication = new Map(plans.map((plan) => [String(plan.publication.id), plan]));
  for (const publicationRow of publications) {
    const publication = plain(publicationRow);
    const plan = planByPublication.get(String(publication.id));
    const activeArtifactId = String(publication.activeArtifactId || publication.lastGoodArtifactId || '');
    const activeArtifact = artifactById.get(activeArtifactId);
    const activeRuntimeHash = String(activeArtifact?.runtimeConfigHash || '');
    if (
      !plan
      || !activeArtifact
      || activeArtifact.status !== 'ready'
      || activeArtifact.environment !== 'production'
      || String(activeArtifact.projectId || '') !== String(publication.projectId || '')
      || ![
        plan.source_runtime.runtime_config_hash,
        plan.target_runtime.runtime_config_hash,
      ].includes(activeRuntimeHash)
    ) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_recovery_active_artifact_untrusted',
        'Una publicación no conserva un artefacto activo source/target verificable.',
        409,
        { publication_id: publication.id, artifact_id: activeArtifactId || null }
      );
    }
  }
  for (const entry of expectedRows || []) {
    const publicationId = String(entry.publication_id || '');
    const plan = planByPublication.get(publicationId);
    const targetDeployment = deploymentById.get(String(entry.deployment_id || ''));
    const sourceArtifactId = String(
      entry.source_artifact_id || targetDeployment?.previousArtifactId || ''
    );
    const targetArtifactId = String(entry.artifact_id || targetDeployment?.artifactId || '');
    const sourceArtifact = artifactById.get(sourceArtifactId);
    const targetArtifact = artifactById.get(targetArtifactId);
    const publication = publications.find((item) => String(plain(item).id) === publicationId);
    const activeArtifactId = String(
      plain(publication)?.activeArtifactId || plain(publication)?.lastGoodArtifactId || ''
    );
    const activeAlreadyTarget = activeArtifactId === targetArtifactId;
    const expectedDeploymentGeneration = Number(entry.carried_from_generation || generation);
    const storageMarker = objectValue(targetDeployment?.storage).runtime_reconciliation;
    const resultMarker = objectValue(targetDeployment?.result).runtime_reconciliation;
    if (
      !plan
      || !targetDeployment
      || String(targetDeployment.publicationId || '') !== publicationId
      || String(targetDeployment.projectId || '') !== String(plain(publication)?.projectId || '')
      || targetDeployment.action !== 'publish'
      || String(targetDeployment.artifactId || '') !== targetArtifactId
      || String(targetDeployment.previousArtifactId || '') !== sourceArtifactId
      || String(targetDeployment.revisionId || '') !== String(targetArtifact?.revisionId || '')
      || String(storageMarker?.reconciliation_id || '') !== String(reconciliationId || '')
      || Number(storageMarker?.generation) !== expectedDeploymentGeneration
      || String(resultMarker?.reconciliation_id || '') !== String(reconciliationId || '')
      || Number(resultMarker?.generation) !== expectedDeploymentGeneration
      || (activeAlreadyTarget && targetDeployment.status !== 'verified')
      || !sourceArtifact
      || sourceArtifact.status !== 'ready'
      || sourceArtifact.environment !== 'production'
      || String(sourceArtifact.projectId || '') !== String(plain(publication)?.projectId || '')
      || String(sourceArtifact.runtimeConfigHash || '') !== plan.source_runtime.runtime_config_hash
      || !targetArtifact
      || targetArtifact.status !== 'ready'
      || targetArtifact.environment !== 'production'
      || String(targetArtifact.projectId || '') !== String(plain(publication)?.projectId || '')
      || String(targetArtifact.runtimeConfigHash || '') !== plan.target_runtime.runtime_config_hash
      || (entry.artifact_hash && String(targetArtifact.artifactHash || '') !== String(entry.artifact_hash))
    ) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_recovery_lineage_untrusted',
        'No se puede acreditar de forma exacta el linaje source/target de una publicación.',
        409,
        { publication_id: publicationId || null }
      );
    }
  }
  return {
    publications,
    deploymentById,
    artifactById,
    planByPublication,
  };
}

/**
 * Recuperación exclusivamente administrativa de una generación failed.
 * No se invoca desde workers ni diagnósticos: exige acción, motivo, actor y
 * request id explícitos, revalida bajo locks y deja un evento append-only.
 */
async function recoverFailedReconciliation({
  reconciliationId,
  action,
  reason,
  actorId,
  requestId,
  confirmed = false,
  models = db,
  sequelize = db.sequelize,
  env = process.env,
  enqueueUniqueJobRequest = jobRequestsService.enqueueUniqueJobRequest,
  enqueueJobRequest = jobRequestsService.enqueueJobRequest,
} = {}) {
  const id = String(reconciliationId || '').trim();
  const normalizedAction = String(action || '').trim();
  const normalizedReason = recoveryReason(reason);
  const normalizedActorId = positiveInteger(actorId);
  const normalizedRequestId = recoveryRequestId(requestId);
  const requestHash = normalizedReason && ADMIN_RECOVERY_ACTIONS.has(normalizedAction)
    ? sha256(canonicalSerialize({ action: normalizedAction, reason: normalizedReason }))
    : null;
  if (!id) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_recovery_id_required', 'Falta la reconciliación a recuperar.', 422
    );
  }
  if (!ADMIN_RECOVERY_ACTIONS.has(normalizedAction)) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_recovery_action_invalid',
      'Indica retry_target o rollback_source.',
      422
    );
  }
  if (!normalizedReason || !normalizedActorId || !normalizedRequestId || confirmed !== true) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_recovery_confirmation_required',
      'La recuperación requiere confirmación, actor, motivo y request id explícitos.',
      422
    );
  }
  if (!isGlobalAdmin(normalizedActorId)) {
    throw new WebIntakeRuntimeReconciliationError(
      'admin_only', 'Esta recuperación está reservada a administradores globales.', 403
    );
  }
  if (!models.WebAuditEvent?.findOne || !models.WebAuditEvent?.create) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_recovery_audit_unavailable',
      'No está disponible el registro de auditoría requerido para recuperar.',
      503
    );
  }
  return sequelize.transaction(async (transaction) => {
    const probe = plain(await models.WebIntakeRuntimeReconciliation.findByPk(id, { transaction }));
    if (!probe) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_reconciliation_not_found', 'La reconciliación no existe.', 404
      );
    }
    const scope = { type: probe.scopeType, id: positiveInteger(probe.scopeId) };
    const intake = await models.IntakeConfig.findOne({
      where: scopeWhere(scope),
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!intake) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_config_missing', 'La configuración de medición ya no existe.', 409
      );
    }
    const reconciliation = await models.WebIntakeRuntimeReconciliation.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!reconciliation) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_reconciliation_not_found', 'La reconciliación no existe.', 404
      );
    }
    const lockedValue = plain(reconciliation);
    const lastRequestId = String(
      lockedValue.lastRecoveryRequestId || lockedValue.last_recovery_request_id || ''
    );
    const lastRequestHash = String(
      lockedValue.lastRecoveryRequestHash || lockedValue.last_recovery_request_hash || ''
    );
    if (lastRequestId === normalizedRequestId) {
      if (lastRequestHash !== requestHash) {
        throw new WebIntakeRuntimeReconciliationError(
          'web_intake_runtime_recovery_idempotency_conflict',
          'El request id ya fue usado con otra acción o motivo.',
          409
        );
      }
      return {
        idempotent: true,
        reconciliation_id: id,
        generation: Number(
          lockedValue.lastRecoveryGeneration || lockedValue.last_recovery_generation
          || reconciliation.generation
        ),
        status: reconciliation.status,
        action: lockedValue.lastRecoveryAction || lockedValue.last_recovery_action || normalizedAction,
      };
    }
    // Lectura locking/current: en MySQL REPEATABLE READ no puede depender del
    // snapshot abierto por el probe anterior. El lock de reconciliación
    // serializa además dos intentos con el mismo request id.
    const previousRecovery = await models.WebAuditEvent.findOne({
      where: {
        eventType: ADMIN_RECOVERY_EVENT,
        entityType: 'web_intake_runtime_reconciliation',
        entityId: id,
        requestId: normalizedRequestId,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (previousRecovery) {
      const previousMetadata = objectValue(plain(previousRecovery)?.metadata);
      if (String(previousMetadata.request_hash || '') !== requestHash) {
        throw new WebIntakeRuntimeReconciliationError(
          'web_intake_runtime_recovery_idempotency_conflict',
          'El request id ya fue usado con otra acción o motivo.',
          409
        );
      }
      if (Number(previousMetadata.generation) !== Number(reconciliation.generation)) {
        throw new WebIntakeRuntimeReconciliationError(
          'web_intake_runtime_recovery_idempotency_stale',
          'El request id pertenece a una generación anterior y no puede reutilizarse.',
          409
        );
      }
      return {
        idempotent: true,
        reconciliation_id: id,
        generation: Number(previousMetadata.generation || reconciliation.generation),
        status: reconciliation.status,
        action: previousMetadata.action || normalizedAction,
      };
    }
    if (reconciliation.status !== 'failed') {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_recovery_not_failed',
        'Solo se puede recuperar explícitamente una reconciliación en estado failed.',
        409,
        { status: reconciliation.status, generation: Number(reconciliation.generation) }
      );
    }
    const current = plain(intake);
    const previous = plain(reconciliation);
    const sourceRecord = sourceRecordForReconciliation(current, previous, { env });
    const targetRecord = targetRecordForReconciliation(current, previous, { env });
    assertRecoverySnapshot(
      sourceRecord, previous.sourceRuntimeHash, previous.sourceRuntimeFingerprint,
      'web_intake_runtime_recovery_source_snapshot_invalid', env
    );
    assertRecoverySnapshot(
      targetRecord, previous.targetRuntimeHash, previous.targetRuntimeFingerprint,
      'web_intake_runtime_recovery_target_snapshot_invalid', env
    );
    const currentRole = runtimeRoleForRecovery(current, sourceRecord, targetRecord, scope);
    const expectedRows = Object.values(objectValue(previous.expectedDeployments));
    const graph = await lockRecoveryGraph({
      scope,
      expectedRows,
      sourceRecord,
      targetRecord,
      reconciliationId: previous.id,
      generation: previous.generation,
      models,
      transaction,
      env,
    });
    const expectedByPublication = new Map(expectedRows.map((entry) => [String(entry.publication_id), entry]));
    const targetWithoutLineage = graph.publications.find((publicationRow) => {
      const publication = plain(publicationRow);
      const plan = graph.planByPublication.get(String(publication.id));
      const activeArtifact = graph.artifactById.get(String(
        publication.activeArtifactId || publication.lastGoodArtifactId || ''
      ));
      return activeArtifact?.runtimeConfigHash === plan?.target_runtime?.runtime_config_hash
        && activeArtifact?.runtimeConfigHash !== plan?.source_runtime?.runtime_config_hash
        && !expectedByPublication.has(String(publication.id));
    });
    if (targetWithoutLineage) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_recovery_rollback_lineage_incomplete',
        'Una publicación target carece de linaje verificable para restaurarla.',
        409,
        { publication_id: plain(targetWithoutLineage).id }
      );
    }
    const previousGeneration = Number(previous.generation || 0);
    if (!Number.isSafeInteger(previousGeneration) || previousGeneration < 1 || previousGeneration >= 4294967295) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_recovery_generation_exhausted',
        'No se puede crear otra generación para esta reconciliación.',
        409
      );
    }
    const generation = previousGeneration + 1;
    const envelopeIdentity = {
      id: reconciliation.id,
      scopeType: scope.type,
      scopeId: scope.id,
      generation,
    };
    const basePatch = {
      generation,
      sourceHmacEnvelope: sealReconciliationSecret(
        String(sourceRecord.hmac_key || '') || null, envelopeIdentity, 'source', { env }
      ),
      targetHmacEnvelope: sealReconciliationSecret(
        String(targetRecord.hmac_key || '') || null, envelopeIdentity, 'target', { env }
      ),
      committedAt: null,
      graceExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastRecoveryRequestId: normalizedRequestId,
      lastRecoveryRequestHash: requestHash,
      lastRecoveryAction: normalizedAction,
      lastRecoveryGeneration: generation,
    };
    let recoveryResult;
    if (normalizedAction === 'retry_target') {
      const carriedLineage = Object.fromEntries(expectedRows.map((entry) => [entry.publication_id, {
        publication_id: entry.publication_id,
        deployment_id: entry.deployment_id,
        artifact_id: entry.artifact_id,
        artifact_hash: entry.artifact_hash,
        runtime_config_hash: entry.runtime_config_hash,
        installation_id: entry.installation_id || null,
        source_artifact_id: entry.source_artifact_id
          || graph.deploymentById.get(String(entry.deployment_id))?.previousArtifactId
          || null,
        carried_from_generation: entry.carried_from_generation || previousGeneration,
      }]));
      await reconciliation.update({
        ...basePatch,
        status: 'pending',
        // No es el conjunto final de ACK: commitPreparedRuntime sustituye las
        // rutas reintentadas y conserva solo las ya target+verified. Mantener
        // este linaje permite un rollback total si el retry vuelve a fallar.
        expectedDeployments: carriedLineage,
      }, { transaction });
      const queued = await enqueueUniqueJobRequest({
        type: JOB_TYPE,
        priority: 'high',
        status: 'pending',
        origin: 'marketing_web:intake_runtime_admin_recovery',
        maxAttempts: 20,
        requestedBy: normalizedActorId,
        requestedByName: 'Clinicaclick',
        requestedByRole: 'system',
        dedupeScope: `${reconciliation.id}:${generation}:admin:${normalizedRequestId}`,
        payload: {
          reconciliation_id: reconciliation.id,
          generation,
          scope_type: scope.type,
          scope_id: scope.id,
          trigger: 'admin_recovery',
          recovery_action: normalizedAction,
          recovery_request_id: normalizedRequestId,
        },
      }, {
        transaction,
        JobRequestModel: models.JobRequest,
        sequelizeInstance: sequelize,
      });
      recoveryResult = {
        job_request_ids: [queued.job.id],
        deployment_ids: [],
        status: 'pending',
      };
    } else {
      if (!expectedRows.length) {
        throw new WebIntakeRuntimeReconciliationError(
          'web_intake_runtime_recovery_rollback_lineage_missing',
          'No existe linaje de deployments suficiente para restaurar el source.',
          409
        );
      }
      const expectedByPublication = new Map(expectedRows.map((entry) => [
        String(entry.publication_id), entry,
      ]));
      const unsafePublication = graph.publications.find((publicationRow) => {
        const publication = plain(publicationRow);
        const plan = graph.planByPublication.get(String(publication.id));
        const activeArtifact = graph.artifactById.get(String(
          publication.activeArtifactId || publication.lastGoodArtifactId || ''
        ));
        return activeArtifact?.runtimeConfigHash !== plan?.source_runtime?.runtime_config_hash
          && !expectedByPublication.has(String(publication.id));
      });
      if (unsafePublication) {
        throw new WebIntakeRuntimeReconciliationError(
          'web_intake_runtime_recovery_rollback_lineage_incomplete',
          'Una publicación no-source carece de linaje verificable para restaurarla.',
          409,
          { publication_id: plain(unsafePublication).id }
        );
      }
      const sanitizedExpected = Object.fromEntries(expectedRows.map((entry) => [entry.publication_id, {
        publication_id: entry.publication_id,
        deployment_id: entry.deployment_id,
        artifact_id: entry.artifact_id,
        artifact_hash: entry.artifact_hash,
        runtime_config_hash: entry.runtime_config_hash,
        installation_id: entry.installation_id || null,
        source_artifact_id: entry.source_artifact_id
          || graph.deploymentById.get(String(entry.deployment_id))?.previousArtifactId
          || null,
        carried_from_generation: entry.carried_from_generation || previousGeneration,
      }]));
      await reconciliation.update({
        ...basePatch,
        status: 'failed',
        expectedDeployments: sanitizedExpected,
      }, { transaction });
      const targetDeployments = new Map(expectedRows.map((entry) => [
        String(entry.deployment_id),
        graph.deploymentById.get(String(entry.deployment_id)),
      ]));
      const rolledBack = await startSourceRollback({
        reconciliation,
        intake,
        expectedRows: Object.values(sanitizedExpected),
        targetDeployments,
        models,
        transaction,
        enqueueJobRequest,
        env,
      });
      await intake.update({
        config: sourceRecord.config,
        hmac_key: sourceRecord.hmac_key,
      }, { transaction, skipWebRuntimeReconciliation: true });
      recoveryResult = {
        job_request_ids: rolledBack.rollbacks.map((item) => item.job_request_id).filter(Boolean),
        deployment_ids: rolledBack.rollbacks.map((item) => item.deployment_id),
        status: 'rolling_back',
      };
    }
    await models.WebAuditEvent.create({
      projectId: null,
      scopeType: scope.type,
      clinicaId: scope.type === 'clinic' ? scope.id : null,
      grupoClinicaId: scope.type === 'group' ? scope.id : null,
      actorUserId: normalizedActorId,
      eventType: ADMIN_RECOVERY_EVENT,
      entityType: 'web_intake_runtime_reconciliation',
      entityId: reconciliation.id,
      requestId: normalizedRequestId,
      previousHash: null,
      nextHash: null,
      metadata: {
        action: normalizedAction,
        reason: normalizedReason,
        request_hash: requestHash,
        previous_generation: previousGeneration,
        generation,
        previous_status: previous.status,
        previous_error_code: previous.lastErrorCode || null,
        current_runtime_role: currentRole,
        publication_count: graph.publications.length,
        job_request_ids: recoveryResult.job_request_ids,
        deployment_ids: recoveryResult.deployment_ids,
      },
    }, { transaction });
    return {
      idempotent: false,
      reconciliation_id: reconciliation.id,
      generation,
      action: normalizedAction,
      ...recoveryResult,
    };
  });
}

async function finalizeReconciliation({
  reconciliationId,
  generation,
  models = db,
  sequelize = db.sequelize,
  env = process.env,
  enqueueJobRequest = jobRequestsService.enqueueJobRequest,
} = {}) {
  return sequelize.transaction(async (transaction) => {
    const probe = plain(await models.WebIntakeRuntimeReconciliation.findByPk(reconciliationId, { transaction }));
    if (!probe || Number(probe.generation) !== Number(generation)) {
      return { stale: true, reason: probe ? 'newer_generation' : 'reconciliation_not_found' };
    }
    const scope = { type: probe.scopeType, id: positiveInteger(probe.scopeId) };
    const intake = await models.IntakeConfig.findOne({
      where: scopeWhere(scope),
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!intake) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_config_missing',
        'La configuración de medición ya no existe.',
        409
      );
    }
    const reconciliation = await models.WebIntakeRuntimeReconciliation.findByPk(reconciliationId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!reconciliation || Number(reconciliation.generation) !== Number(generation)) {
      return { stale: true, reason: reconciliation ? 'newer_generation' : 'reconciliation_not_found' };
    }
    if (reconciliation.status === 'completed') return { completed: true, idempotent: true };
    if (reconciliation.status === 'failed') {
      // Puede haber rutas target ya promovidas antes de que otra ruta falle.
      // Nunca expirar su HMAC ni permitir B→C hasta acreditar rollback/ACK
      // source de todas ellas; un operador puede reintentar los deployments.
      return {
        failed: true,
        source_preserved: true,
        target_hmac_preserved: true,
        manual_recovery_required: true,
      };
    }
    if (reconciliation.status === 'rolling_back') {
      const expectedRows = Object.values(objectValue(reconciliation.expectedDeployments));
      const rollbackIds = expectedRows.map((item) => String(item.rollback_deployment_id || '')).filter(Boolean);
      if (rollbackIds.length !== expectedRows.length || !rollbackIds.length) {
        await reconciliation.update({
          status: 'failed',
          lastErrorCode: 'web_intake_runtime_rollback_set_incomplete',
          lastErrorMessage: 'No se conserva el conjunto completo de rollbacks verificables.',
        }, { transaction });
        return { failed: true, manual_recovery_required: true, target_hmac_preserved: true };
      }
      const locked = await lockExpectedPublicationGraph({
        expectedRows,
        deploymentIds: rollbackIds,
        models,
        transaction,
      });
      const rollbacks = locked.deployments;
      const rollbackById = new Map(rollbacks.map((row) => [String(plain(row).id), plain(row)]));
      const terminalFailure = expectedRows.find((item) => (
        ['failed', 'superseded'].includes(String(rollbackById.get(String(item.rollback_deployment_id))?.status || ''))
      ));
      if (terminalFailure) {
        await reconciliation.update({
          status: 'failed',
          lastErrorCode: 'web_intake_runtime_rollback_failed',
          lastErrorMessage: 'La recuperación automática no confirmó todas las rutas fuente.',
        }, { transaction });
        return {
          failed: true,
          manual_recovery_required: true,
          target_hmac_preserved: true,
          failed_publication_id: terminalFailure.publication_id,
        };
      }
      const waitingRollback = expectedRows.find((item) => {
        const deployment = rollbackById.get(String(item.rollback_deployment_id));
        return deployment?.status !== 'verified'
          || String(deployment.artifactId || '') !== String(item.source_artifact_id || '');
      });
      if (waitingRollback) return { waiting: true, reason: 'source_rollbacks_not_verified' };
      const publications = locked.publications;
      const byPublication = new Map(publications.map((row) => [String(plain(row).id), plain(row)]));
      const sourceNotActive = expectedRows.find((item) => {
        const publication = byPublication.get(String(item.publication_id));
        return !publication
          || publication.status !== 'published'
          || String(publication.activeArtifactId || '') !== String(item.source_artifact_id || '');
      });
      if (sourceNotActive) return { waiting: true, reason: 'source_pointer_not_confirmed' };
      await reconciliation.update({
        status: 'completed',
        sourceHmacEnvelope: null,
        targetHmacEnvelope: null,
        graceExpiresAt: null,
        committedAt: null,
        lastErrorCode: 'web_intake_runtime_rolled_back',
        lastErrorMessage: 'El runtime fuente quedó restaurado y verificado en todas las publicaciones.',
      }, { transaction });
      return { completed: true, rolled_back: true, rollback_count: expectedRows.length };
    }
    if (reconciliation.status === 'grace') {
      const expiresAt = new Date(reconciliation.graceExpiresAt || 0);
      if (Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > Date.now()) {
        return {
          grace: true,
          failed: reconciliation.status === 'failed',
          source_preserved: reconciliation.status === 'failed',
          next_allowed_at: expiresAt,
        };
      }
      await reconciliation.update({
        status: 'completed',
        sourceHmacEnvelope: null,
        targetHmacEnvelope: null,
        graceExpiresAt: null,
      }, { transaction });
      return { completed: true, grace_cleared: true };
    }
    if (reconciliation.status !== 'deploying') {
      return { waiting: true, reason: `status_${reconciliation.status}` };
    }
    const expected = objectValue(reconciliation.expectedDeployments);
    const expectedRows = Object.values(expected);
    if (!expectedRows.length) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_expected_deployments_missing',
        'La reconciliación no conserva sus deployments esperados.',
        500
      );
    }
    const deploymentIds = expectedRows.map((item) => String(item.deployment_id || '')).filter(Boolean);
    const locked = await lockExpectedPublicationGraph({
      expectedRows,
      deploymentIds,
      models,
      transaction,
    });
    const deployments = locked.deployments;
    const byId = new Map(deployments.map((row) => [String(plain(row).id), plain(row)]));
    if (byId.size !== deploymentIds.length) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_deployment_missing',
        'Falta un deployment de la reconciliación.',
        500
      );
    }
    const failed = expectedRows.find((item) => {
      const deployment = byId.get(String(item.deployment_id));
      return ['failed', 'superseded'].includes(String(deployment?.status || ''));
    });
    if (failed) {
      try {
        const recovery = await startSourceRollback({
          reconciliation,
          intake,
          expectedRows,
          targetDeployments: byId,
          models,
          transaction,
          enqueueJobRequest,
          env,
        });
        return { ...recovery, source_preserved: true, failed_publication_id: failed.publication_id };
      } catch (error) {
        await reconciliation.update({
          status: 'failed',
          graceExpiresAt: null,
          lastErrorCode: String(error?.code || 'web_intake_runtime_rollback_enqueue_failed').slice(0, 128),
          lastErrorMessage: String(error?.message || 'No se pudo iniciar la recuperación automática.').slice(0, 2000),
        }, { transaction });
        return {
          failed: true,
          source_preserved: true,
          failed_publication_id: failed.publication_id,
          target_hmac_preserved: true,
          manual_recovery_required: true,
        };
      }
    }
    const unconfirmed = expectedRows.find((item) => {
      const deployment = byId.get(String(item.deployment_id));
      return deployment?.status !== 'verified'
        || String(deployment.artifactId || '') !== String(item.artifact_id || '');
    });
    if (unconfirmed) {
      return { waiting: true, reason: 'deployments_not_verified' };
    }
    const publications = locked.publications;
    const publicationById = new Map(publications.map((row) => [String(plain(row).id), plain(row)]));
    const inactive = expectedRows.find((item) => {
      const publication = publicationById.get(String(item.publication_id));
      return !publication
        || publication.status !== 'published'
        || String(publication.activeArtifactId || '') !== String(item.artifact_id || '');
    });
    if (inactive) return { waiting: true, reason: 'publication_pointer_not_confirmed' };
    const current = plain(intake);
    const sourceRecord = sourceRecordForReconciliation(current, plain(reconciliation), { env });
    if (
      runtimeHashForRecord(sourceRecord, { env }) !== reconciliation.sourceRuntimeHash
      || runtimeFingerprintForRecord(sourceRecord) !== reconciliation.sourceRuntimeFingerprint
      || runtimeFingerprintForRecord(current)
        !== runtimeFingerprintForRecord(materializeRuntimeForOwnership(sourceRecord, scope))
    ) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_source_changed',
        'El runtime fuente cambió antes de recibir todos los ACK.',
        409
      );
    }
    const targetRecord = targetRecordForReconciliation(current, plain(reconciliation), { env });
    if (
      runtimeHashForRecord(targetRecord, { env }) !== reconciliation.targetRuntimeHash
      || runtimeFingerprintForRecord(targetRecord) !== reconciliation.targetRuntimeFingerprint
    ) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_target_changed',
        'El runtime objetivo ya no coincide con el target preparado.',
        409
      );
    }
    const sourceHmacKey = String(sourceRecord.hmac_key || '') || null;
    const targetHmacKey = String(targetRecord.hmac_key || '') || null;
    // La identidad exacta del artefacto también necesita gracia aunque el
    // secreto no cambie: una pestaña abierta justo antes del último ACK puede
    // seguir enviando el source legítimo durante unos minutos/horas.
    const needsGrace = expectedRows.length > 0
      || Boolean(sourceHmacKey && sourceHmacKey !== targetHmacKey);
    const graceExpiresAt = needsGrace ? new Date(Date.now() + hmacGraceMs(env)) : null;
    await intake.update({
      config: targetRecord.config,
      hmac_key: targetRecord.hmac_key,
    }, { transaction, skipWebRuntimeReconciliation: true });
    await reconciliation.update({
      status: needsGrace ? 'grace' : 'completed',
      sourceHmacEnvelope: needsGrace
        ? sealReconciliationSecret(sourceHmacKey, reconciliation, 'source', { env })
        : null,
      targetHmacEnvelope: null,
      committedAt: new Date(),
      graceExpiresAt,
      lastErrorCode: null,
      lastErrorMessage: null,
    }, { transaction });
    return {
      promoted: true,
      grace: Boolean(graceExpiresAt),
      grace_expires_at: graceExpiresAt,
      deployment_count: expectedRows.length,
    };
  });
}

async function enqueueRuntimeFinalization({
  reconciliationId,
  generation,
  deploymentId,
  models = db,
  sequelize = db.sequelize,
  transaction = null,
  enqueueUniqueJobRequest = jobRequestsService.enqueueUniqueJobRequest,
} = {}) {
  const row = await models.WebIntakeRuntimeReconciliation.findByPk(reconciliationId, {
    ...(transaction ? { transaction } : {}),
  });
  if (!row || Number(row.generation) !== Number(generation)) return null;
  return enqueueUniqueJobRequest({
    type: JOB_TYPE,
    priority: 'high',
    status: 'pending',
    origin: 'marketing_web:intake_runtime_ack',
    maxAttempts: 20,
    dedupeScope: `${row.id}:${generation}:ack:${String(deploymentId || 'unknown')}`,
    payload: {
      reconciliation_id: row.id,
      generation: Number(generation),
      trigger: 'deployment_ack',
      deployment_id: String(deploymentId || ''),
    },
  }, {
    ...(transaction ? { transaction } : {}),
    JobRequestModel: models.JobRequest,
    sequelizeInstance: sequelize,
  });
}

async function authenticationCandidatesForConfig(config, {
  models = db,
  now = new Date(),
  env = process.env,
} = {}) {
  const value = plain(config);
  // A clinic row with runtime_inheritance is only the narrow public owner of
  // the group's credential. Its transition is stored against the group scope,
  // so authentication must follow the exact inherited runtime marker instead
  // of consulting a stale/non-existent clinic reconciliation.
  const scope = runtimeScopeFromRecord(value);
  if (!scope || !models.WebIntakeRuntimeReconciliation) return value ? [value] : [];
  const reconciliation = plain(await models.WebIntakeRuntimeReconciliation.findOne({
    where: { scopeType: scope.type, scopeId: scope.id },
  }));
  let candidates = value ? [value] : [];
  if (!reconciliation) return candidates;
  const expiry = reconciliation.graceExpiresAt || reconciliation.grace_expires_at;
  const graceValid = !expiry || new Date(expiry).getTime() > new Date(now).getTime();
  const source = sourceRecordForReconciliation(value, reconciliation, { env });
  const target = targetRecordForReconciliation(value, reconciliation, { env });
  if (['pending', 'preparing', 'deploying', 'rolling_back', 'failed'].includes(reconciliation.status)) {
    candidates = [source, target];
  } else if (reconciliation.status === 'grace') {
    candidates = graceValid ? [target, source] : [target];
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!String(candidate?.hmac_key || '').trim()) return false;
    const fingerprint = runtimeFingerprintForRecord(candidate);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

async function acceptedHmacKeysForConfig(config, options = {}) {
  const candidates = await authenticationCandidatesForConfig(config, options);
  return [...new Set(candidates.map((candidate) => String(candidate?.hmac_key || '').trim()).filter(Boolean))];
}

async function runtimeForMarkedDeployment({
  publication,
  deployment,
  models = db,
  env = process.env,
} = {}) {
  const marker = plain(deployment)?.storage?.runtime_reconciliation;
  const reconciliationId = String(marker?.reconciliation_id || '').trim();
  const generation = positiveInteger(marker?.generation);
  if (!reconciliationId || !generation) return null;
  const reconciliation = plain(await models.WebIntakeRuntimeReconciliation.findByPk(reconciliationId));
  if (
    !reconciliation
    || Number(reconciliation.generation) !== generation
    || !['preparing', 'deploying', 'rolling_back'].includes(reconciliation.status)
  ) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_deployment_marker_stale',
      'El deployment referencia una reconciliación de runtime no activa.',
      409
    );
  }
  const expected = objectValue(reconciliation.expectedDeployments)?.[publication.id];
  if (
    reconciliation.status === 'deploying'
    && (!expected || String(expected.deployment_id) !== String(plain(deployment).id))
  ) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_deployment_not_expected',
      'El deployment no pertenece al conjunto atómico esperado.',
      409
    );
  }
  if (
    reconciliation.status === 'rolling_back'
    && (
      marker?.role !== 'source_rollback'
      || !expected
      || String(expected.rollback_deployment_id || '') !== String(plain(deployment).id)
    )
  ) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_rollback_deployment_not_expected',
      'El rollback no pertenece al conjunto de recuperación esperado.',
      409
    );
  }
  const scope = { type: reconciliation.scopeType, id: positiveInteger(reconciliation.scopeId) };
  const current = await models.IntakeConfig.findOne({ where: scopeWhere(scope), raw: true });
  if (!current) throw new WebIntakeRuntimeReconciliationError('web_intake_runtime_config_missing', 'IntakeConfig no existe.', 409);
  const source = sourceRecordForReconciliation(current, reconciliation, { env });
  const target = targetRecordForReconciliation(current, reconciliation, { env });
  const plans = await effectiveRuntimePlans({
    scope, sourceRecord: source, targetRecord: target, publications: [publication], models, env,
  });
  return reconciliation.status === 'rolling_back'
    ? (plans[0]?.source_runtime || null)
    : (plans[0]?.target_runtime || null);
}

async function desiredRuntimeForInstallation({
  installation,
  models = db,
  transaction = null,
  env = process.env,
} = {}) {
  const currentInstallation = plain(installation) || {};
  const installationId = String(currentInstallation.id || '');
  if (!installationId) return null;
  const reconciliations = models.WebIntakeRuntimeReconciliation.findAll
    ? await models.WebIntakeRuntimeReconciliation.findAll({
        where: { status: { [Op.in]: ['deploying', 'rolling_back'] } },
        order: [['updated_at', 'ASC']],
        ...(transaction ? { transaction } : {}),
      })
    : [];
  const matches = [];
  for (const rawReconciliation of reconciliations) {
    const reconciliation = plain(rawReconciliation);
    if (!reconciliation) continue;
    const expected = Object.values(objectValue(reconciliation.expectedDeployments));
    const installationEntries = expected.filter((entry) => (
      String(entry.installation_id || '') === installationId
    ));
    if (!installationEntries.length) continue;
    const publication = plain(await models.WebPublication.findByPk(
      installationEntries[0].publication_id,
      transaction ? { transaction } : undefined
    ));
    if (!publication) continue;
    const scope = { type: reconciliation.scopeType, id: positiveInteger(reconciliation.scopeId) };
    const current = await models.IntakeConfig.findOne({
      where: scopeWhere(scope), raw: true, ...(transaction ? { transaction } : {}),
    });
    if (!current) continue;
    const source = sourceRecordForReconciliation(current, reconciliation, { env });
    const target = targetRecordForReconciliation(current, reconciliation, { env });
    const plans = await effectiveRuntimePlans({
      scope, sourceRecord: source, targetRecord: target, publications: [publication], models, transaction, env,
    });
    const runtime = reconciliation.status === 'rolling_back'
      ? plans[0]?.source_runtime
      : plans[0]?.target_runtime;
    if (!runtime) continue;
    matches.push({
      runtime,
      measurement: runtime.measurement,
      reconciliation_id: reconciliation.id,
      generation: Number(reconciliation.generation),
    });
  }
  if (!matches.length) return null;
  const hashes = new Set(matches.map(({ runtime }) => runtime.runtime_config_hash));
  if (hashes.size !== 1) {
    throw new WebIntakeRuntimeReconciliationError(
      'web_intake_runtime_shared_installation_conflict',
      'Dos reconciliaciones intentan publicar runtimes distintos en la misma instalación WordPress.',
      409,
      { installation_id: installationId, reconciliation_ids: matches.map((item) => item.reconciliation_id) }
    );
  }
  return matches[0];
}

async function transitionContextForPublication({
  publication,
  models = db,
  now = new Date(),
} = {}) {
  const currentPublication = plain(publication);
  if (!currentPublication?.id || !models.WebIntakeRuntimeReconciliation) return null;
  const rows = await models.WebIntakeRuntimeReconciliation.findAll({
    where: { status: { [Op.in]: ['deploying', 'rolling_back', 'grace', 'failed'] } },
    order: [['updated_at', 'DESC']],
  });
  for (const row of rows.map(plain)) {
    const expected = objectValue(row.expectedDeployments)?.[currentPublication.id];
    if (!expected) continue;
    const deployment = plain(await models.WebPublicationDeployment.findByPk(expected.deployment_id));
    if (!deployment || String(deployment.artifactId || '') !== String(expected.artifact_id || '')) continue;
    const graceExpiry = row.graceExpiresAt || row.grace_expires_at;
    const graceValid = !graceExpiry || new Date(graceExpiry).getTime() > new Date(now).getTime();
    let targetConfirmed = deployment.status === 'verified';
    if (!targetConfirmed && currentPublication.channel === 'wordpress') {
      const installation = plain(await models.WebWordpressInstallation.findByPk(
        currentPublication.wordpressInstallationId
      ));
      if (supportsMultiPublication(installation)) {
        const ack = objectValue(installation?.reportedState?.confirmed_routes)?.[currentPublication.id];
        targetConfirmed = installation?.status === 'connected'
          && ack?.status === 'active'
          && ack?.route_prefix === currentPublication.path
          && Number(ack?.registry_sequence) === Number(installation?.desiredSequence || 0)
          && String(ack?.artifact_hash || '') === String(expected.artifact_hash || '');
      } else {
        targetConfirmed = installation?.status === 'connected'
          && String(installation?.lastArtifactHash || '') === String(expected.artifact_hash || '');
      }
    }
    if (['rolling_back', 'failed'].includes(row.status)) {
      // Once recovery starts (or stalls), some channels may already serve the
      // prepared target even though their terminal deployment did not reach
      // `verified`. Keep both exact artifacts authorized until source ACK is
      // complete; artifact/runtime integrity still gates every request.
      targetConfirmed = true;
    }
    const sourceArtifactId = deployment.previousArtifactId || null;
    const targetArtifactId = expected.artifact_id;
    const acceptedArtifactIds = [];
    if (row.status === 'deploying') {
      if (sourceArtifactId) acceptedArtifactIds.push(sourceArtifactId);
      if (targetConfirmed) acceptedArtifactIds.push(targetArtifactId);
    } else if (row.status === 'grace') {
      acceptedArtifactIds.push(targetArtifactId);
      if (graceValid && sourceArtifactId) acceptedArtifactIds.push(sourceArtifactId);
    } else if (['rolling_back', 'failed'].includes(row.status) && graceValid) {
      if (sourceArtifactId) acceptedArtifactIds.push(sourceArtifactId);
      if (targetConfirmed) acceptedArtifactIds.push(targetArtifactId);
    }
    return {
      reconciliation: row,
      deployment,
      expected,
      source_artifact_id: sourceArtifactId,
      target_artifact_id: targetArtifactId,
      target_confirmed: targetConfirmed,
      accepted_artifact_ids: [...new Set(acceptedArtifactIds.map(String))],
      grace_valid: graceValid,
    };
  }
  return null;
}

async function hmacForPublicationArtifact({
  intake,
  publication,
  artifactId,
  models = db,
  now = new Date(),
} = {}) {
  const artifact = artifactId && models.WebArtifact?.findByPk
    ? await findWebArtifactMetadataByPk(models, artifactId)
    : null;
  const selected = await runtimeCandidateForPublicationArtifact({
    intake,
    publication,
    artifact: artifact || { id: artifactId },
    models,
    now,
    requireArtifactIntegrity: Boolean(artifact),
  });
  return String(selected?.intake?.hmac_key || '').trim() || null;
}

async function runtimeCandidateForPublicationArtifact({
  intake,
  publication,
  artifact,
  models = db,
  now = new Date(),
  requireArtifactIntegrity = true,
  env = process.env,
} = {}) {
  const currentIntake = plain(intake);
  const currentPublication = plain(publication);
  const currentArtifact = plain(artifact);
  const artifactId = String(currentArtifact?.id || '').trim();
  if (!currentIntake || !currentPublication?.id || !artifactId) return null;
  if (requireArtifactIntegrity) {
    const manifest = objectValue(currentArtifact.manifest);
    if (
      String(currentArtifact.projectId || currentArtifact.project_id || '') !== String(currentPublication.projectId || '')
      || String(currentArtifact.revisionId || currentArtifact.revision_id || '') !== String(manifest.revision_id || '')
      || String(currentArtifact.artifactHash || currentArtifact.artifact_hash || '') !== String(manifest.artifact_hash || '')
      || currentArtifact.environment !== 'production'
      || currentArtifact.status !== 'ready'
      || !/^[a-f0-9]{64}$/.test(String(manifest.artifact_input_hash || ''))
    ) return null;
  }
  const context = await transitionContextForPublication({ publication: currentPublication, models, now });
  let candidate = currentIntake;
  let role = 'current';
  if (context) {
    if (!context.accepted_artifact_ids.includes(artifactId)) return null;
    if (artifactId === String(context.target_artifact_id || '')) {
      if (
        requireArtifactIntegrity
        && String(currentArtifact.artifactHash || currentArtifact.artifact_hash || '')
          !== String(context.expected.artifact_hash || '')
      ) return null;
      candidate = targetRecordForReconciliation(currentIntake, context.reconciliation, { env });
      role = 'target';
    } else if (artifactId === String(context.source_artifact_id || '')) {
      candidate = sourceRecordForReconciliation(currentIntake, context.reconciliation, { env });
      role = 'source';
    } else {
      return null;
    }
  } else if (String(currentPublication.activeArtifactId || '') !== artifactId) {
    // A content-only publication can briefly serve the freshly uploaded
    // artifact before the publication pointer is promoted. The immutable
    // artifact marker is therefore allowed for hosted/custom channels only
    // when the exact artifact is owned by the current in-flight deployment.
    // Its runtime hash is still checked against the committed IntakeConfig
    // below, so this path cannot bypass a runtime reconciliation.
    if (
      !['clinicaclick_hosted', 'custom_domain'].includes(String(currentPublication.channel || ''))
      || !BUSY_STATUSES.has(String(currentPublication.status || ''))
      || !models.WebPublicationDeployment?.findOne
    ) return null;
    const deployment = plain(await models.WebPublicationDeployment.findOne({
      where: {
        publicationId: currentPublication.id,
        action: { [Op.in]: ['publish', 'rollback'] },
        status: { [Op.in]: ['queued', 'running', 'verified'] },
      },
      order: [['sequence', 'DESC']],
    }));
    if (
      !deployment
      || String(deployment.publicationId || deployment.publication_id || '') !== String(currentPublication.id)
      || String(deployment.artifactId || deployment.artifact_id || '') !== artifactId
      || !['publish', 'rollback'].includes(String(deployment.action || ''))
      || !['queued', 'running', 'verified'].includes(String(deployment.status || ''))
      || (
        requireArtifactIntegrity
        && String(deployment.revisionId || deployment.revision_id || '')
          !== String(currentArtifact.revisionId || currentArtifact.revision_id || '')
      )
    ) return null;
    role = 'deployment_target';
  }
  if (requireArtifactIntegrity) {
    const declaredRuntimeHash = String(
      currentArtifact.runtimeConfigHash
      || currentArtifact.runtime_config_hash
      || currentArtifact.manifest?.runtime_config_hash
      || ''
    );
    if (!declaredRuntimeHash || runtimeHashForRecord(candidate, { env }) !== declaredRuntimeHash) return null;
  }
  return {
    intake: candidate,
    runtime: runtimeForRecord(candidate, { env }),
    role,
    context,
    artifact_id: artifactId,
  };
}

async function runIntakeRuntimeReconciliationJob(payload = {}, jobRequest = null, dependencies = {}) {
  const models = dependencies.models || db;
  const sequelize = dependencies.sequelize || db.sequelize;
  const env = dependencies.env || process.env;
  const reconciliationId = String(payload.reconciliation_id || '').trim();
  const generation = positiveInteger(payload.generation);
  if (!reconciliationId || !generation) {
    return {
      status: 'failed', retryable: false,
      error: new Error(`${JOB_TYPE} requires reconciliation_id and generation`),
    };
  }
  let reconciliation = await models.WebIntakeRuntimeReconciliation.findByPk(reconciliationId);
  if (!reconciliation) {
    return { status: 'completed', result: { skipped: true, reason: 'reconciliation_not_found' } };
  }
  if (Number(reconciliation.generation) !== generation) {
    return { status: 'completed', result: { skipped: true, reason: 'newer_generation' } };
  }
  try {
    if (['deploying', 'rolling_back', 'grace', 'completed', 'failed'].includes(reconciliation.status)) {
      const finalized = await finalizeReconciliation({
        reconciliationId, generation, models, sequelize, env,
        enqueueJobRequest: dependencies.enqueueJobRequest || jobRequestsService.enqueueJobRequest,
      });
      const graceWakeAt = finalized.next_allowed_at || finalized.grace_expires_at;
      if (finalized.grace && graceWakeAt) {
        return {
          status: 'waiting',
          nextAllowedAt: graceWakeAt,
          result: finalized,
        };
      }
      if (finalized.waiting) {
        return {
          status: 'waiting',
          nextAllowedAt: new Date(Date.now() + 60 * 1000),
          result: finalized,
        };
      }
      return { status: 'completed', result: finalized };
    }
    const scope = { type: reconciliation.scopeType, id: positiveInteger(reconciliation.scopeId) };
    const currentRecord = await models.IntakeConfig.findOne({ where: scopeWhere(scope), raw: true });
    if (!currentRecord) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_config_missing',
        'La configuración de medición ya no existe.',
        409
      );
    }
    const sourceRecord = sourceRecordForReconciliation(currentRecord, plain(reconciliation), { env });
    const targetRecord = targetRecordForReconciliation(currentRecord, plain(reconciliation), { env });
    const currentFingerprint = runtimeFingerprintForRecord(currentRecord);
    const sourceMatches = runtimeHashForRecord(sourceRecord, { env }) === reconciliation.sourceRuntimeHash
      && runtimeFingerprintForRecord(sourceRecord) === reconciliation.sourceRuntimeFingerprint
      && currentFingerprint === runtimeFingerprintForRecord(materializeRuntimeForOwnership(sourceRecord, scope));
    const targetMatches = runtimeHashForRecord(targetRecord, { env }) === reconciliation.targetRuntimeHash
      && runtimeFingerprintForRecord(targetRecord) === reconciliation.targetRuntimeFingerprint
      && currentFingerprint === runtimeFingerprintForRecord(materializeRuntimeForOwnership(targetRecord, scope));
    if (!sourceMatches && !targetMatches) {
      throw new WebIntakeRuntimeReconciliationError(
        'web_intake_runtime_source_changed',
        'La configuración vigente cambió fuera del reconciliador.',
        409
      );
    }
    const gate = await runtimeGatePlan({ scope, sourceRecord, targetRecord, models, env });
    if (gate.mismatches.some(({ publication }) => BUSY_STATUSES.has(String(publication.status || '')))) {
      return {
        status: 'waiting',
        nextAllowedAt: new Date(Date.now() + 60 * 1000),
        result: { reason: 'publication_busy', generation },
      };
    }
    await reconciliation.update({ status: 'preparing', lastErrorCode: null, lastErrorMessage: null });
    const preparation = await prepareArtifacts({
      reconciliation: plain(reconciliation),
      generation,
      plans: gate.mismatches,
      artifacts: gate.artifacts,
      models,
      env,
      compileRevisionFn: dependencies.compileRevision || compileRevision,
      storeArtifactBundleFn: dependencies.storeArtifactBundle || storeArtifactBundle,
    });
    if (preparation.waiting) {
      await reconciliation.update({ status: 'pending' });
      return {
        status: 'waiting',
        nextAllowedAt: new Date(Date.now() + 60 * 1000),
        result: { reason: preparation.reason, publication_id: preparation.publication_id, generation },
      };
    }
    const committed = await commitPreparedRuntime({
      reconciliationId,
      generation,
      prepared: preparation.prepared,
      models,
      sequelize,
      env,
      enqueueJobRequest: dependencies.enqueueJobRequest || jobRequestsService.enqueueJobRequest,
    });
    if (committed.promoted && committed.grace_expires_at) {
      return {
        status: 'waiting',
        nextAllowedAt: committed.grace_expires_at,
        result: committed,
      };
    }
    return { status: 'completed', result: committed };
  } catch (error) {
    reconciliation = await models.WebIntakeRuntimeReconciliation.findByPk(reconciliationId).catch(() => reconciliation);
    await noteReconciliationError(reconciliation, error);
    return {
      status: 'failed',
      retryable: retryableError(error),
      error,
      result: { reconciliation_id: reconciliationId, generation, switched: false },
    };
  }
}

module.exports = {
  ADMIN_RECOVERY_ACTIONS,
  ADMIN_RECOVERY_EVENT,
  BUSY_STATUSES,
  JOB_TYPE,
  RUNTIME_FEATURE_KEYS,
  WebIntakeRuntimeReconciliationError,
  applyRuntimePatch,
  assertIntakeConfigDestroyAllowed,
  candidateDeclaresRuntime,
  candidatePublications,
  commitPreparedRuntime,
  effectiveRuntimePlans,
  desiredRuntimeForInstallation,
  hmacForPublicationArtifact,
  enqueueRuntimeFinalization,
  acceptedHmacKeysForConfig,
  authenticationCandidatesForConfig,
  finalizeReconciliation,
  locationIds,
  persistReconciliation,
  prepareArtifacts,
  preparedRuntimeMarker,
  recoverFailedReconciliation,
  runIntakeRuntimeReconciliationJob,
  runtimeConfigPatch,
  recordDeclaresRuntime: candidateDeclaresRuntime,
  runtimeForRecord,
  runtimeCandidateForPublicationArtifact,
  runtimeForMarkedDeployment,
  runtimeFingerprintForRecord,
  runtimeGatePlan,
  runtimeHashForRecord,
  scopeFromRecord,
  stageCandidateWrite,
  stageIntakeConfigInstanceWrite,
  stageIntakeConfigUpsert,
  transitionContextForPublication,
};

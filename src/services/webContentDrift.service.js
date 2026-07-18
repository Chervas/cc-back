'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const { canonicalSerialize } = require('../lib/webDocument');
const { resolveWebDocumentResources } = require('./webResourceResolver.service');
const {
  WebProjectServiceError,
  assertProjectAccess,
  getProjectOrThrow,
} = require('./webProjects.service');

const FROZEN_RESOURCE_KINDS = Object.freeze([
  'content_entry',
  'media',
  'treatment',
  'professional',
]);

const SNAPSHOT_COLLECTIONS = Object.freeze({
  content_entry: 'content_entries',
  media: 'media_assets',
  treatment: 'treatments',
  professional: 'professionals',
});

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function sha256(value) {
  return crypto.createHash('sha256').update(canonicalSerialize(value), 'utf8').digest('hex');
}

function normalizedCollection(snapshot, kind) {
  const collection = snapshot?.[SNAPSHOT_COLLECTIONS[kind]];
  if (!collection || typeof collection !== 'object' || Array.isArray(collection)) return {};
  return collection;
}

function compareFrozenResourceSnapshots(approvedSnapshot, currentResolution) {
  const currentSnapshot = currentResolution?.snapshot || {};
  const unresolved = new Map();
  for (const reference of currentResolution?.unresolved || []) {
    if (!FROZEN_RESOURCE_KINDS.includes(reference.kind) || !reference.id) continue;
    const key = `${reference.kind}:${reference.id}`;
    if (!unresolved.has(key)) unresolved.set(key, reference.reason || 'unavailable');
  }

  const changes = [];
  const counts = { total: 0, changed: 0, unavailable: 0 };
  for (const kind of FROZEN_RESOURCE_KINDS) {
    const approved = normalizedCollection(approvedSnapshot, kind);
    const current = normalizedCollection(currentSnapshot, kind);
    const ids = [...new Set([...Object.keys(approved), ...Object.keys(current)])].sort();
    counts.total += ids.length;
    for (const id of ids) {
      const unresolvedReason = unresolved.get(`${kind}:${id}`);
      if (unresolvedReason || !Object.hasOwn(current, id)) {
        changes.push({
          kind,
          id,
          change: 'unavailable',
          reason: unresolvedReason || 'not_accessible_or_unavailable',
        });
        counts.unavailable += 1;
        continue;
      }
      if (!Object.hasOwn(approved, id) || sha256(approved[id]) !== sha256(current[id])) {
        changes.push({ kind, id, change: 'updated' });
        counts.changed += 1;
      }
    }
  }

  changes.sort((left, right) => (
    FROZEN_RESOURCE_KINDS.indexOf(left.kind) - FROZEN_RESOURCE_KINDS.indexOf(right.kind)
    || left.id.localeCompare(right.id)
  ));
  return {
    status: counts.unavailable > 0 ? 'unavailable' : (counts.changed > 0 ? 'changed' : 'current'),
    has_changes: changes.length > 0,
    counts,
    changes,
    approved_snapshot_hash: sha256(Object.fromEntries(
      FROZEN_RESOURCE_KINDS.map((kind) => [SNAPSHOT_COLLECTIONS[kind], normalizedCollection(approvedSnapshot, kind)])
    )),
    current_snapshot_hash: sha256(Object.fromEntries(
      FROZEN_RESOURCE_KINDS.map((kind) => [SNAPSHOT_COLLECTIONS[kind], normalizedCollection(currentSnapshot, kind)])
    )),
  };
}

async function publishedRevision(projectId, models) {
  if (!models.WebPublication?.findOne) return null;
  const publication = await models.WebPublication.findOne({
    where: {
      projectId,
      status: { [Op.ne]: 'retired' },
      activeRevisionId: { [Op.ne]: null },
    },
    attributes: ['activeRevisionId'],
    order: [['lastHealthyAt', 'DESC'], ['publishedAt', 'DESC'], ['id', 'ASC']],
    raw: true,
  });
  return publication?.activeRevisionId
    ? models.WebRevision.findByPk(String(publication.activeRevisionId))
    : null;
}

async function activePublicationForRevision(projectId, revisionId, models) {
  if (!models.WebPublication?.findOne) return null;
  return models.WebPublication.findOne({
    where: { projectId, status: { [Op.ne]: 'retired' }, activeRevisionId: revisionId },
    attributes: ['id', 'activeRevisionId'],
    raw: true,
  });
}

async function resolveTargetRevision(projectId, revisionId, models) {
  const requestedId = String(revisionId || '').trim();
  if (requestedId) return models.WebRevision.findByPk(requestedId);
  const approved = await models.WebRevision.findOne({
    where: { projectId, status: 'approved' },
    order: [['revisionNumber', 'DESC']],
  });
  return approved || publishedRevision(projectId, models);
}

async function getWebProjectContentDrift({
  actorId,
  projectId,
  revisionId = null,
  models = db,
  assertFeatureAccess,
} = {}) {
  const project = await getProjectOrThrow(projectId, { models });
  const scope = await assertProjectAccess(actorId, project, 'marketing.web.view', { models, assertFeatureAccess });
  const revision = await resolveTargetRevision(project.id, revisionId, models);
  if (!revision) {
    return {
      status: 'not_applicable',
      has_changes: false,
      revision_id: null,
      revision_number: null,
      basis: null,
      checked_at: new Date().toISOString(),
      counts: { total: 0, changed: 0, unavailable: 0 },
      changes: [],
      approved_snapshot_hash: null,
      current_snapshot_hash: null,
    };
  }
  const value = plain(revision);
  if (String(value.projectId) !== String(project.id)) {
    throw new WebProjectServiceError('revision_not_found', 'La revisión no pertenece a este proyecto.', 404);
  }
  const activePublication = await activePublicationForRevision(project.id, value.id, models);
  if (value.status !== 'approved' && !activePublication) {
    throw new WebProjectServiceError(
      'revision_not_approved_or_published',
      'Solo se puede comprobar una revisión aprobada o publicada.',
      409
    );
  }

  const currentResolution = await resolveWebDocumentResources({
    document: value.document,
    scope,
    models,
    allowGroupInheritance: true,
    referenceKinds: FROZEN_RESOURCE_KINDS,
  });
  const comparison = compareFrozenResourceSnapshots(value.contentSnapshot || {}, currentResolution);
  return {
    ...comparison,
    revision_id: value.id,
    revision_number: Number(value.revisionNumber),
    basis: activePublication ? 'published' : 'approved',
    checked_at: new Date().toISOString(),
  };
}

module.exports = {
  FROZEN_RESOURCE_KINDS,
  SNAPSHOT_COLLECTIONS,
  compareFrozenResourceSnapshots,
  getWebProjectContentDrift,
};

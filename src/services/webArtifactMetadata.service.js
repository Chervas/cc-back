'use strict';

// Public landing requests only need this immutable identity contract. Keeping
// it in one place prevents a future caller from accidentally hydrating the
// (potentially multi-megabyte) files or qaReport JSON columns on an unauthenticated
// request path.
const PUBLIC_WEB_ARTIFACT_METADATA_ATTRIBUTES = Object.freeze([
  'id',
  'projectId',
  'revisionId',
  'environment',
  'status',
  'artifactHash',
  'manifest',
  'runtimeConfigHash',
]);

const WEB_LANDING_INTERNAL_CONTEXT = Symbol('webLandingInternalContext');

function metadataQueryOptions(options = {}) {
  return {
    ...options,
    attributes: [...PUBLIC_WEB_ARTIFACT_METADATA_ATTRIBUTES],
    raw: true,
  };
}

async function findWebArtifactMetadataByPk(models, artifactId, options = {}) {
  if (!models?.WebArtifact?.findByPk || !artifactId) return null;
  return models.WebArtifact.findByPk(artifactId, metadataQueryOptions(options));
}

async function findWebArtifactMetadataByHash(models, artifactHash, options = {}) {
  if (!models?.WebArtifact?.findOne || !artifactHash) return null;
  return models.WebArtifact.findOne(metadataQueryOptions({
    ...options,
    where: {
      ...(options.where || {}),
      artifactHash,
    },
  }));
}

function attachWebLandingInternalContext(target, context = {}) {
  if (!target || typeof target !== 'object') return target;
  Object.defineProperty(target, WEB_LANDING_INTERNAL_CONTEXT, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      artifact: context.artifact || null,
      publication: context.publication || null,
    }),
  });
  return target;
}

function webLandingInternalContext(target) {
  return target?.[WEB_LANDING_INTERNAL_CONTEXT] || null;
}

module.exports = {
  PUBLIC_WEB_ARTIFACT_METADATA_ATTRIBUTES,
  attachWebLandingInternalContext,
  findWebArtifactMetadataByHash,
  findWebArtifactMetadataByPk,
  metadataQueryOptions,
  webLandingInternalContext,
};

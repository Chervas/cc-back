'use strict';

const db = require('../../models');
const {
  longestPublicationMatch,
  safePageUrl,
} = require('./webLandingAttribution.service');
const {
  findWebArtifactMetadataByHash,
} = require('./webArtifactMetadata.service');
const {
  runtimeCandidateForPublicationArtifact,
} = require('./webIntakeRuntimeReconciliation.service');

const ARTIFACT_HASH = /^[a-f0-9]{64}$/;

function cachedArtifactForRequest(req, suppliedHash) {
  const artifact = req?.webLandingArtifactMetadata;
  return artifact && String(artifact.artifactHash || artifact.artifact_hash || '').toLowerCase() === suppliedHash
    ? artifact
    : null;
}

async function runtimeConfigFromArtifactHeader(req, configs = [], { models = db } = {}) {
  const supplied = String(req?.headers?.['x-clinicaclick-web-artifact'] || '').trim().toLowerCase();
  if (!supplied) return { present: false, config: null };
  if (!ARTIFACT_HASH.test(supplied)) return { present: true, config: null };
  const artifact = cachedArtifactForRequest(req, supplied)
    || await findWebArtifactMetadataByHash(models, supplied);
  if (!artifact) return { present: true, config: null };
  let pageUrl;
  try {
    pageUrl = safePageUrl(
      req.body?.page_url
      || req.body?.pageUrl
      || req.body?.event_source_url
      || req.body?.eventSourceUrl
      || req.body?.landing_url
      || req.body?.landingUrl
    );
  } catch {
    return { present: true, config: null };
  }
  const publications = await models.WebPublication.findAll({
    where: {
      projectId: artifact.projectId,
      host: pageUrl.hostname.toLowerCase(),
      status: { [models.Sequelize.Op.ne]: 'retired' },
    },
    order: [['path', 'DESC'], ['id', 'ASC']],
  });
  const strictLandingIdentity = String(req.body?.external_source || '').trim().toLowerCase()
    === 'clinicaclick_web_landing'
    || Boolean(req.body?.web_form_id);
  const pathPublication = longestPublicationMatch(publications, pageUrl);
  if (strictLandingIdentity && !pathPublication) return { present: true, config: null };
  const candidates = strictLandingIdentity
    ? [pathPublication]
    : (pathPublication
        ? [pathPublication, ...publications.filter((row) => String(row.id) !== String(pathPublication.id))]
        : publications);
  const matches = [];
  for (const publication of candidates) {
    for (const config of configs.filter(Boolean)) {
      const selected = await runtimeCandidateForPublicationArtifact({
        intake: config,
        publication,
        artifact,
        models,
      });
      if (selected?.intake) {
        matches.push({ publication_id: publication.id, config: selected.intake });
        break;
      }
    }
  }
  const publicationIds = new Set(matches.map((match) => String(match.publication_id)));
  return publicationIds.size === 1
    ? { present: true, config: matches[0].config }
    : { present: true, config: null };
}

module.exports = {
  ARTIFACT_HASH,
  cachedArtifactForRequest,
  runtimeConfigFromArtifactHeader,
};

'use strict';

const webPublicationsService = require('../services/webPublications.service');
const { publicVerificationKeyDescriptor } = require('../lib/webArtifactSignature');
const { withRequestContext } = require('./webProjects.controller');

const createPublication = withRequestContext(async (req, res, requestId) => {
  const publication = await webPublicationsService.createPublication({
    actorId: req.userData?.userId,
    body: { ...(req.body || {}), request_id: requestId },
  });
  return res.status(201).json({ success: true, publication, request_id: requestId });
}, 'No se ha podido crear la publicación web.');

const getPublication = withRequestContext(async (req, res, requestId) => {
  const { publication } = await webPublicationsService.getPublicationForActor({
    actorId: req.userData?.userId,
    publicationId: req.params.publicationId,
  });
  return res.json({
    success: true,
    publication: webPublicationsService.serializePublication(publication),
    request_id: requestId,
  });
}, 'No se ha podido cargar la publicación web.');

const listProjectPublications = withRequestContext(async (req, res, requestId) => {
  const result = await webPublicationsService.listProjectPublications({
    actorId: req.userData?.userId,
    projectId: req.params.projectId,
    query: req.query || {},
  });
  return res.json({
    success: true,
    publications: result.items,
    pagination: result.pagination,
    request_id: requestId,
  });
}, 'No se han podido cargar las publicaciones web.');

const requestPublish = withRequestContext(async (req, res, requestId) => {
  const result = await webPublicationsService.enqueueDeployment({
    actorId: req.userData?.userId,
    publicationId: req.params.publicationId,
    revisionId: req.body?.revision_id,
    action: 'publish',
    requestId,
  });
  return res.status(202).json({ success: true, ...result, request_id: requestId });
}, 'No se ha podido iniciar la publicación web.');

const requestRollback = withRequestContext(async (req, res, requestId) => {
  const result = await webPublicationsService.enqueueDeployment({
    actorId: req.userData?.userId,
    publicationId: req.params.publicationId,
    artifactId: req.body?.artifact_id,
    action: 'rollback',
    requestId,
  });
  return res.status(202).json({ success: true, ...result, request_id: requestId });
}, 'No se ha podido iniciar la restauración web.');

const listDeployments = withRequestContext(async (req, res, requestId) => {
  const result = await webPublicationsService.listDeployments({
    actorId: req.userData?.userId,
    publicationId: req.params.publicationId,
    query: req.query || {},
  });
  return res.json({
    success: true,
    deployments: result.items,
    pagination: result.pagination,
    request_id: requestId,
  });
}, 'No se ha podido cargar el historial de publicación.');

const getVerificationKey = withRequestContext(async (req, res, requestId) => {
  const descriptor = publicVerificationKeyDescriptor();
  return res.json({ success: true, verification_key: descriptor, request_id: requestId });
}, 'No se ha podido cargar la clave pública de verificación.');

module.exports = {
  createPublication,
  getPublication,
  getVerificationKey,
  listDeployments,
  listProjectPublications,
  requestPublish,
  requestRollback,
};

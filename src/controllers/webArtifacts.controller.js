'use strict';

const webArtifactsService = require('../services/webArtifacts.service');
const { withRequestContext } = require('./webProjects.controller');

const compileRevision = withRequestContext(async (req, res, requestId) => {
  const artifact = await webArtifactsService.compileRevision({
    actorId: req.userData?.userId,
    revisionId: req.params.revisionId,
    body: req.body || {},
    requestId,
  });
  return res.status(201).json({ success: true, artifact, request_id: requestId });
}, 'No se ha podido compilar la revisión web.');

const getArtifact = withRequestContext(async (req, res, requestId) => {
  const artifact = await webArtifactsService.getArtifact({
    actorId: req.userData?.userId,
    artifactId: req.params.artifactId,
    includeFiles: String(req.query?.include_files ?? 'true').toLowerCase() !== 'false',
  });
  return res.json({ success: true, artifact, request_id: requestId });
}, 'No se ha podido cargar el artefacto web.');

const listProjectArtifacts = withRequestContext(async (req, res, requestId) => {
  const result = await webArtifactsService.listProjectArtifacts({
    actorId: req.userData?.userId,
    projectId: req.params.projectId,
    query: req.query || {},
  });
  return res.json({ success: true, artifacts: result.items, pagination: result.pagination, request_id: requestId });
}, 'No se han podido cargar los artefactos web.');

module.exports = { compileRevision, getArtifact, listProjectArtifacts };

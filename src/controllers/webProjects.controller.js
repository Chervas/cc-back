'use strict';

const crypto = require('node:crypto');
const webProjectsService = require('../services/webProjects.service');
const webContentDriftService = require('../services/webContentDrift.service');

function requestIdFor(req) {
  const supplied = String(req.get('X-Request-Id') || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

function sendError(res, error, requestId, fallbackMessage) {
  const isDocumentError = error?.name === 'WebDocumentValidationError';
  const sequelizeContracts = {
    SequelizeValidationError: { status: 422, code: 'validation_failed' },
    SequelizeUniqueConstraintError: { status: 409, code: 'resource_conflict' },
    SequelizeOptimisticLockError: { status: 409, code: 'resource_conflict' },
    OptimisticLockError: { status: 409, code: 'resource_conflict' },
  };
  const sequelizeContract = sequelizeContracts[error?.name];
  const status = Number(error?.status)
    || (isDocumentError ? 422 : sequelizeContract?.status)
    || 500;
  const code = isDocumentError
    ? 'web_document_invalid'
    : (error?.code || sequelizeContract?.code
      || (status === 401 ? 'unauthenticated' : status === 403 ? 'access_policy_forbidden' : 'internal_error'));
  if (status >= 500) {
    console.error('[marketing-web]', { request_id: requestId, code, message: error?.message });
  }
  const details = error?.details
    || (isDocumentError ? { issues: error.errors || [] } : undefined);
  return res.status(status).json({
    success: false,
    error: {
      code,
      message: status >= 500 ? fallbackMessage : (error?.message || fallbackMessage),
      ...(details === undefined ? {} : { details }),
    },
    request_id: requestId,
  });
}

function withRequestContext(handler, fallbackMessage) {
  return async (req, res) => {
    const requestId = requestIdFor(req);
    res.set('X-Request-Id', requestId);
    res.set('Cache-Control', 'no-store');
    try {
      return await handler(req, res, requestId);
    } catch (error) {
      return sendError(res, error, requestId, fallbackMessage);
    }
  };
}

const listProjects = withRequestContext(async (req, res, requestId) => {
  const result = await webProjectsService.listProjects({
    actorId: req.userData?.userId,
    query: req.query || {},
  });
  return res.json({ success: true, ...result, request_id: requestId });
}, 'No se han podido cargar los proyectos web.');

const createProject = withRequestContext(async (req, res, requestId) => {
  const project = await webProjectsService.createProject({
    actorId: req.userData?.userId,
    body: req.body || {},
    requestId,
  });
  return res.status(201).json({ success: true, project, request_id: requestId });
}, 'No se ha podido crear el proyecto web.');

const getProject = withRequestContext(async (req, res, requestId) => {
  const project = await webProjectsService.getProject({
    actorId: req.userData?.userId,
    projectId: req.params.projectId,
  });
  return res.json({ success: true, project, request_id: requestId });
}, 'No se ha podido cargar el proyecto web.');

const updateProject = withRequestContext(async (req, res, requestId) => {
  const project = await webProjectsService.updateProject({
    actorId: req.userData?.userId,
    projectId: req.params.projectId,
    body: req.body || {},
    requestId,
  });
  return res.json({ success: true, project, request_id: requestId });
}, 'No se ha podido actualizar el proyecto web.');

const getDraft = withRequestContext(async (req, res, requestId) => {
  const draft = await webProjectsService.getDraft({
    actorId: req.userData?.userId,
    projectId: req.params.projectId,
  });
  return res.json({ success: true, draft, request_id: requestId });
}, 'No se ha podido cargar el borrador.');

const saveDraft = withRequestContext(async (req, res, requestId) => {
  const draft = await webProjectsService.saveDraft({
    actorId: req.userData?.userId,
    projectId: req.params.projectId,
    body: req.body || {},
    requestId,
  });
  return res.json({ success: true, draft, request_id: requestId });
}, 'No se ha podido guardar el borrador.');

const listRevisions = withRequestContext(async (req, res, requestId) => {
  const result = await webProjectsService.listRevisions({
    actorId: req.userData?.userId,
    projectId: req.params.projectId,
    query: req.query || {},
  });
  return res.json({
    success: true,
    revisions: result.items,
    pagination: result.pagination,
    request_id: requestId,
  });
}, 'No se han podido cargar las revisiones.');

const getContentDrift = withRequestContext(async (req, res, requestId) => {
  const contentDrift = await webContentDriftService.getWebProjectContentDrift({
    actorId: req.userData?.userId,
    projectId: req.params.projectId,
    revisionId: req.query?.revision_id,
  });
  return res.json({ success: true, content_drift: contentDrift, request_id: requestId });
}, 'No se ha podido comprobar si el contenido ha cambiado.');

const createRevision = withRequestContext(async (req, res, requestId) => {
  const result = await webProjectsService.createRevision({
    actorId: req.userData?.userId,
    projectId: req.params.projectId,
    body: req.body || {},
    requestId,
  });
  return res.status(201).json({ success: true, ...result, request_id: requestId });
}, 'No se ha podido crear la revisión.');

const submitRevision = withRequestContext(async (req, res, requestId) => {
  const revision = await webProjectsService.transitionRevision({
    actorId: req.userData?.userId,
    revisionId: req.params.revisionId,
    action: 'submit',
    requestId,
  });
  return res.json({ success: true, revision, request_id: requestId });
}, 'No se ha podido enviar la revisión.');

const approveRevision = withRequestContext(async (req, res, requestId) => {
  const revision = await webProjectsService.transitionRevision({
    actorId: req.userData?.userId,
    revisionId: req.params.revisionId,
    action: 'approve',
    requestId,
  });
  return res.json({ success: true, revision, request_id: requestId });
}, 'No se ha podido aprobar la revisión.');

const listTemplates = withRequestContext(async (req, res, requestId) => {
  const result = await webProjectsService.listTemplates({
    actorId: req.userData?.userId,
    query: req.query || {},
  });
  return res.json({
    success: true,
    templates: result.items,
    pagination: result.pagination,
    request_id: requestId,
  });
}, 'No se han podido cargar las plantillas web.');

const createTemplateFromProject = withRequestContext(async (req, res, requestId) => {
  const template = await webProjectsService.createTemplateFromProject({
    actorId: req.userData?.userId,
    projectId: req.params.projectId,
    body: req.body || {},
    requestId,
  });
  return res.status(201).json({ success: true, template, request_id: requestId });
}, 'No se ha podido guardar el proyecto como plantilla.');

const updateTemplate = withRequestContext(async (req, res, requestId) => {
  const template = await webProjectsService.updateTemplate({
    actorId: req.userData?.userId,
    templateId: req.params.templateId,
    body: req.body || {},
    requestId,
  });
  return res.json({ success: true, template, request_id: requestId });
}, 'No se ha podido actualizar la plantilla web.');

const archiveTemplate = withRequestContext(async (req, res, requestId) => {
  const template = await webProjectsService.archiveTemplate({
    actorId: req.userData?.userId,
    templateId: req.params.templateId,
    requestId,
  });
  return res.json({ success: true, template, request_id: requestId });
}, 'No se ha podido archivar la plantilla web.');

module.exports = {
  createProject,
  createTemplateFromProject,
  createRevision,
  getDraft,
  getContentDrift,
  getProject,
  listRevisions,
  listProjects,
  listTemplates,
  archiveTemplate,
  approveRevision,
  requestIdFor,
  saveDraft,
  sendError,
  submitRevision,
  updateProject,
  updateTemplate,
  withRequestContext,
};

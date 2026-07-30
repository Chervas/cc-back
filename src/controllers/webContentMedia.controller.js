'use strict';

const webContentMediaService = require('../services/webContentMedia.service');
const { withRequestContext } = require('./webProjects.controller');

const listContent = withRequestContext(async (req, res, requestId) => {
  const result = await webContentMediaService.listContent({
    actorId: req.userData?.userId,
    query: req.query || {},
  });
  return res.json({ success: true, ...result, request_id: requestId });
}, 'No se ha podido cargar el contenido web.');

const createContent = withRequestContext(async (req, res, requestId) => {
  const content = await webContentMediaService.createContent({
    actorId: req.userData?.userId,
    body: req.body || {},
    requestId,
  });
  return res.status(201).json({ success: true, content, request_id: requestId });
}, 'No se ha podido crear el contenido web.');

const getContent = withRequestContext(async (req, res, requestId) => {
  const content = await webContentMediaService.getContent({
    actorId: req.userData?.userId,
    contentId: req.params.contentId,
  });
  return res.json({ success: true, content, request_id: requestId });
}, 'No se ha podido cargar el contenido web.');

const updateContent = withRequestContext(async (req, res, requestId) => {
  const content = await webContentMediaService.updateContent({
    actorId: req.userData?.userId,
    contentId: req.params.contentId,
    body: req.body || {},
    requestId,
  });
  return res.json({ success: true, content, request_id: requestId });
}, 'No se ha podido actualizar el contenido web.');

const listContentVersions = withRequestContext(async (req, res, requestId) => {
  const result = await webContentMediaService.listContentVersions({
    actorId: req.userData?.userId,
    contentId: req.params.contentId,
    query: req.query || {},
  });
  return res.json({
    success: true,
    versions: result.items,
    pagination: result.pagination,
    request_id: requestId,
  });
}, 'No se han podido cargar las versiones del contenido.');

const listMedia = withRequestContext(async (req, res, requestId) => {
  const result = await webContentMediaService.listMedia({
    actorId: req.userData?.userId,
    query: req.query || {},
  });
  return res.json({ success: true, ...result, request_id: requestId });
}, 'No se ha podido cargar la biblioteca de medios.');

const registerMedia = withRequestContext(async (req, res, requestId) => {
  const media = await webContentMediaService.registerMedia({
    actorId: req.userData?.userId,
    body: req.body || {},
    requestId,
  });
  return res.status(201).json({ success: true, media, request_id: requestId });
}, 'No se ha podido registrar el medio.');

const updateMedia = withRequestContext(async (req, res, requestId) => {
  const media = await webContentMediaService.updateMedia({
    actorId: req.userData?.userId,
    mediaId: req.params.mediaId,
    body: req.body || {},
    requestId,
  });
  return res.json({ success: true, media, request_id: requestId });
}, 'No se ha podido actualizar el medio.');

module.exports = {
  createContent,
  getContent,
  listContent,
  listContentVersions,
  listMedia,
  registerMedia,
  updateContent,
  updateMedia,
};

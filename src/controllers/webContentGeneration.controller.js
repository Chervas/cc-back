'use strict';

const webContentGenerationService = require('../services/webContentGeneration.service');
const { withRequestContext } = require('./webProjects.controller');

const getConfiguration = withRequestContext(async (req, res, requestId) => (
  res.json({
    success: true,
    configuration: webContentGenerationService.providerConfiguration(),
    request_id: requestId,
  })
), 'No se ha podido cargar la configuración del asistente de contenido.');

const createGeneration = withRequestContext(async (req, res, requestId) => {
  const result = await webContentGenerationService.createGeneration({
    actorId: req.userData?.userId,
    requestedByName: req.userData?.nombre || req.userData?.name || null,
    requestedByRole: req.userData?.rol || req.userData?.role || null,
    body: req.body || {},
    idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotency_key || null,
  });
  return res.status(result.created ? 202 : 200).json({
    success: true,
    generation: result.generation,
    idempotent_replay: !result.created,
    request_id: requestId,
  });
}, 'No se ha podido preparar el borrador con IA.');

const getGeneration = withRequestContext(async (req, res, requestId) => {
  const generation = await webContentGenerationService.getGeneration({
    actorId: req.userData?.userId,
    generationId: req.params.generationId,
  });
  return res.json({ success: true, generation, request_id: requestId });
}, 'No se ha podido cargar el borrador generado.');

const acceptGeneration = withRequestContext(async (req, res, requestId) => {
  const result = await webContentGenerationService.acceptGeneration({
    actorId: req.userData?.userId,
    generationId: req.params.generationId,
    requestId,
  });
  const status = result.created ? 201 : 200;
  const { created, ...response } = result;
  return res.status(status).json({ success: true, ...response, request_id: requestId });
}, 'No se ha podido aceptar el borrador generado.');

module.exports = {
  acceptGeneration,
  createGeneration,
  getConfiguration,
  getGeneration,
};

'use strict';

const crypto = require('node:crypto');
const service = require('../services/webWordpressInstallations.service');
const pluginPackageService = require('../services/webWordpressPluginPackage.service');
const { sendError, withRequestContext } = require('./webProjects.controller');

function requestIdFor(req) {
  const supplied = String(req.get?.('X-Request-Id') || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/.test(supplied) ? supplied : crypto.randomUUID();
}

function pluginHeaders(req) {
  return {
    authorization: req.get?.('Authorization') || '',
    pluginVersion: req.get?.('X-Clinicaclick-Plugin-Version') || '',
  };
}

const createInstallation = withRequestContext(async (req, res, requestId) => {
  const result = await service.createInstallation({
    actorId: req.userData?.userId,
    body: req.body || {},
    requestId,
  });
  return res.status(201).json({ success: true, ...result, request_id: requestId });
}, 'No se ha podido preparar la conexión con WordPress.');

const listInstallations = withRequestContext(async (req, res, requestId) => {
  const installations = await service.listInstallations({
    actorId: req.userData?.userId,
    query: req.query || {},
  });
  return res.json({ success: true, installations, request_id: requestId });
}, 'No se han podido cargar las conexiones de WordPress.');

const rotateToken = withRequestContext(async (req, res, requestId) => {
  const result = await service.rotateInstallationToken({
    actorId: req.userData?.userId,
    installationId: req.params.installationId,
    requestId,
  });
  return res.json({ success: true, ...result, request_id: requestId });
}, 'No se ha podido rotar la credencial de WordPress.');

const revokeInstallation = withRequestContext(async (req, res, requestId) => {
  const installation = await service.revokeInstallation({
    actorId: req.userData?.userId,
    installationId: req.params.installationId,
    requestId,
  });
  return res.json({ success: true, installation, request_id: requestId });
}, 'No se ha podido revocar la conexión de WordPress.');

const downloadPluginPackage = withRequestContext(async (req, res, requestId) => {
  const result = await pluginPackageService.provisionWordpressPluginPackage({
    actorId: req.userData?.userId,
    installationId: req.params.installationId,
    bootstrapTicket: req.body?.download_ticket,
    requestId,
  });
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Content-Type', result.content_type);
  res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.set('Content-Length', String(result.size_bytes));
  res.set('Digest', `sha-256=${Buffer.from(result.sha256, 'hex').toString('base64')}`);
  res.set('X-Clinicaclick-Plugin-Version', result.plugin_version);
  return res.status(200).send(result.buffer);
}, 'No se ha podido preparar el plugin de WordPress.');

async function getDesiredState(req, res) {
  const requestId = requestIdFor(req);
  res.set('X-Request-Id', requestId);
  // The signed response contains the installation runtime (including its HMAC
  // key). ETag/304 is an application-level validator, never permission for a
  // browser or intermediary to retain the response body.
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Vary', 'Authorization, If-None-Match');
  try {
    const result = await service.getDesiredState({
      installationId: req.params.installationId,
      headers: pluginHeaders(req),
      requestId,
    });
    res.set('ETag', result.etag);
    if (String(req.get?.('If-None-Match') || '').trim() === result.etag) return res.status(304).end();
    return res.json(result.response);
  } catch (error) {
    return sendError(res, error, requestId, 'No se ha podido cargar el estado de publicación.');
  }
}

async function reportInstallation(req, res) {
  const requestId = requestIdFor(req);
  res.set('X-Request-Id', requestId);
  res.set('Cache-Control', 'no-store');
  try {
    const result = await service.recordReport({
      installationId: req.params.installationId,
      headers: pluginHeaders(req),
      body: req.body || {},
      requestId,
    });
    return res.status(202).json({
      success: true,
      accepted: result.accepted,
      confirms_desired: result.confirms_desired,
      site_claim_acknowledged: result.site_claim_acknowledged === true,
      request_id: requestId,
    });
  } catch (error) {
    return sendError(res, error, requestId, 'No se ha podido registrar el estado de WordPress.');
  }
}

function artifactResourceHandler(resource) {
  return async (req, res) => {
    const requestId = requestIdFor(req);
    res.set('X-Request-Id', requestId);
    res.set('Cache-Control', 'private, no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Vary', 'Authorization, X-Clinicaclick-Plugin-Version');
    try {
      const result = await service.getAuthenticatedArtifactResource({
        installationId: req.params.installationId,
        artifactHash: req.params.artifactHash,
        resource,
        pathToken: req.params.pathToken || null,
        headers: pluginHeaders(req),
      });
      res.set('Content-Type', result.content_type);
      res.set('Content-Length', String(result.body.length));
      res.set('Digest', `sha-256=${Buffer.from(result.sha256, 'hex').toString('base64')}`);
      res.set('X-Clinicaclick-Artifact', result.artifact_hash);
      return res.status(200).send(result.body);
    } catch (error) {
      return sendError(res, error, requestId, 'No se ha podido descargar el artefacto.');
    }
  };
}

const downloadArtifactManifest = artifactResourceHandler('manifest');
const downloadArtifactEnvelope = artifactResourceHandler('envelope');
const downloadArtifactFile = artifactResourceHandler('file');

module.exports = {
  createInstallation,
  downloadPluginPackage,
  downloadArtifactEnvelope,
  downloadArtifactFile,
  downloadArtifactManifest,
  getDesiredState,
  listInstallations,
  reportInstallation,
  revokeInstallation,
  rotateToken,
};

'use strict';

const asyncHandler = require('express-async-handler');
const patientClinicalAttachmentsService = require('../services/patientClinicalAttachments.service');

function actorIdFromRequest(req) {
  const actorId = Number(req.userData?.userId);
  if (!Number.isFinite(actorId)) {
    const error = new Error('auth_failed');
    error.status = 401;
    throw error;
  }
  return actorId;
}

function sendClinicalAttachmentError(error, res) {
  if (error.status === 401 || error.message === 'auth_failed') {
    return res.status(401).json({ message: 'Auth failed!' });
  }
  if (error.status === 403 || error.message === 'access_policy_forbidden') {
    return res.status(403).json({
      message: 'No tienes permiso para acceder a este adjunto clinico',
      details: error.details || null,
    });
  }
  if (error.status === 404 || ['patient_not_found', 'clinical_attachment_not_found'].includes(error.message)) {
    return res.status(404).json({ message: 'Adjunto clinico no encontrado' });
  }
  if (error.status === 400 || error.status === 413) {
    return res.status(error.status).json({
      message: 'No se pudo guardar el adjunto clinico',
      code: error.message,
      details: error.details || null,
    });
  }
  return null;
}

function setClinicalReadHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

// Do not let a failed private binary/list read reach Express's HTML final
// handler: filesystem paths, SQL diagnostics and stacks are not public data.
// This affects presentation only; the service still enforces the same ACL and
// resolves exactly one configured storage root (no filesystem fallback).
function sendClinicalAttachmentReadError(error, res) {
  setClinicalReadHeaders(res);
  // A header/filename failure may occur after the binary type was selected.
  // The error response must still be JSON, without stale binary headers.
  res.removeHeader('Content-Disposition');
  res.removeHeader('Content-Length');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (error?.status === 401 || error?.statusCode === 401 || error?.message === 'auth_failed') {
    return res.status(401).json({ message: 'Auth failed!', code: 'auth_failed' });
  }
  if (error?.status === 403 || error?.statusCode === 403 || error?.message === 'access_policy_forbidden') {
    return res.status(403).json({ message: 'No tienes permiso para acceder a este adjunto clinico', code: 'access_policy_forbidden' });
  }
  if (error?.status === 404 || error?.statusCode === 404 || error?.code === 'ENOENT'
    || ['patient_not_found', 'clinical_attachment_not_found', 'clinical_private_asset_not_found', 'clinical_private_asset_not_active'].includes(error?.message)) {
    return res.status(404).json({ message: 'Adjunto clinico no encontrado', code: 'clinical_attachment_not_found' });
  }
  const status = error?.status === 503 || error?.statusCode === 503 ? 503 : 500;
  return res.status(status).json({ message: 'No se pudo acceder al adjunto clinico. Intentalo de nuevo mas tarde.', code: 'clinical_attachment_unavailable' });
}

exports.listPatientClinicalAttachments = asyncHandler(async (req, res) => {
  setClinicalReadHeaders(res);
  try {
    const actorId = actorIdFromRequest(req);
    const data = await patientClinicalAttachmentsService.listPatientClinicalAttachments(req.params.id, actorId);
    return res.json(data);
  } catch (error) {
    return sendClinicalAttachmentReadError(error, res);
  }
});

exports.getPatientClinicalAttachment = asyncHandler(async (req, res) => {
  setClinicalReadHeaders(res);
  try {
    const actorId = actorIdFromRequest(req);
    const { asset, buffer, contentType, filename } = await patientClinicalAttachmentsService.readPatientClinicalAttachment(
      req.params.id,
      req.params.attachmentId,
      actorId,
    );
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${String(filename || `adjunto-clinico-${asset.id}`).replace(/"/g, '')}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (error) {
    return sendClinicalAttachmentReadError(error, res);
  }
});

exports.createPatientClinicalAttachment = asyncHandler(async (req, res) => {
  try {
    const actorId = actorIdFromRequest(req);
    const item = await patientClinicalAttachmentsService.createPatientClinicalAttachment(
      req.params.id,
      actorId,
      req.body || {},
    );
    return res.status(201).json({ item });
  } catch (error) {
    const handled = sendClinicalAttachmentError(error, res);
    if (handled) return handled;
    throw error;
  }
});

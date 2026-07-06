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
  return null;
}

exports.listPatientClinicalAttachments = asyncHandler(async (req, res) => {
  try {
    const actorId = actorIdFromRequest(req);
    const data = await patientClinicalAttachmentsService.listPatientClinicalAttachments(req.params.id, actorId);
    return res.json(data);
  } catch (error) {
    const handled = sendClinicalAttachmentError(error, res);
    if (handled) return handled;
    throw error;
  }
});

exports.getPatientClinicalAttachment = asyncHandler(async (req, res) => {
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
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(buffer);
  } catch (error) {
    const handled = sendClinicalAttachmentError(error, res);
    if (handled) return handled;
    throw error;
  }
});

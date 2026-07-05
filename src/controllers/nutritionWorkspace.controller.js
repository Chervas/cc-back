'use strict';

const asyncHandler = require('express-async-handler');
const nutritionWorkspaceService = require('../services/nutritionWorkspace.service');
const { assertUserCanAccessFeature } = require('../lib/access-policy');

async function assertNutritionAccess(req, featureKey) {
  const actorId = Number(req.userData?.userId);
  if (!Number.isFinite(actorId)) {
    const error = new Error('auth_failed');
    error.status = 401;
    throw error;
  }

  const context = await nutritionWorkspaceService.getPatientNutritionAccessContext(req.params.id);
  await assertUserCanAccessFeature({
    actorId,
    featureKey,
    clinicId: context.clinic_id,
  });
  return context;
}

function sendNutritionError(error, res) {
  if (error.status === 401 || error.message === 'auth_failed') {
    return res.status(401).json({ message: 'Auth failed!' });
  }
  if (error.status === 403 || error.message === 'access_policy_forbidden') {
    return res.status(403).json({
      message: 'No tienes permiso para acceder a esta función',
      details: error.details || null,
    });
  }
  return null;
}

exports.getPatientNutritionWorkspace = asyncHandler(async (req, res) => {
  try {
    await assertNutritionAccess(req, 'nutrition.workspace.view');
    const data = await nutritionWorkspaceService.getPatientNutritionWorkspace(req.params.id);
    res.json(data);
  } catch (error) {
    const handled = sendNutritionError(error, res);
    if (handled) return handled;
    if (error.status === 404 || error.message === 'patient_not_found') {
      return res.status(404).json({ message: 'Paciente no encontrado' });
    }
    throw error;
  }
});

exports.createPatientNutritionMeasurement = asyncHandler(async (req, res) => {
  try {
    const actorUserId = req.userData?.userId || null;
    await assertNutritionAccess(req, 'nutrition.workspace.view');
    await assertNutritionAccess(req, 'nutrition.measurements.create');
    const measurement = await nutritionWorkspaceService.createNutritionMeasurement(
      req.params.id,
      req.body || {},
      actorUserId,
    );
    res.status(201).json(measurement);
  } catch (error) {
    const handled = sendNutritionError(error, res);
    if (handled) return handled;
    if (error.status === 404 || error.message === 'patient_not_found') {
      return res.status(404).json({ message: 'Paciente no encontrado' });
    }
    if (error.status === 400) {
      return res.status(400).json({
        message: error.message,
        details: error.details || null,
      });
    }
    throw error;
  }
});

exports.listPatientNutritionMeasurementPhotos = asyncHandler(async (req, res) => {
  try {
    await assertNutritionAccess(req, 'nutrition.workspace.view');
    const photos = await nutritionWorkspaceService.listNutritionMeasurementClinicalPhotos(
      req.params.id,
      req.params.measurementId,
    );
    return res.json({ items: photos });
  } catch (error) {
    const handled = sendNutritionError(error, res);
    if (handled) return handled;
    if (error.status === 404 || ['patient_not_found', 'measurement_not_found'].includes(error.message)) {
      return res.status(404).json({ message: 'Medición no encontrada' });
    }
    throw error;
  }
});

exports.createPatientNutritionMeasurementPhoto = asyncHandler(async (req, res) => {
  try {
    const actorUserId = req.userData?.userId || null;
    await assertNutritionAccess(req, 'nutrition.workspace.view');
    await assertNutritionAccess(req, 'nutrition.measurements.create');
    const photo = await nutritionWorkspaceService.addNutritionMeasurementClinicalPhoto(
      req.params.id,
      req.params.measurementId,
      req.body || {},
      actorUserId,
    );
    return res.status(201).json(photo);
  } catch (error) {
    const handled = sendNutritionError(error, res);
    if (handled) return handled;
    if (error.status === 404 || ['patient_not_found', 'measurement_not_found'].includes(error.message)) {
      return res.status(404).json({ message: 'Medición no encontrada' });
    }
    if (error.status === 400 || error.status === 413) {
      return res.status(error.status).json({
        message: error.message,
        details: error.details || null,
      });
    }
    throw error;
  }
});

exports.getPatientNutritionMeasurementPhoto = asyncHandler(async (req, res) => {
  try {
    await assertNutritionAccess(req, 'nutrition.workspace.view');
    const { asset, buffer, contentType, filename } = await nutritionWorkspaceService.readNutritionMeasurementClinicalPhoto(
      req.params.id,
      req.params.measurementId,
      req.params.photoId,
    );
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${String(filename || `foto-nutricion-${asset.id}`).replace(/"/g, '')}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(buffer);
  } catch (error) {
    const handled = sendNutritionError(error, res);
    if (handled) return handled;
    if (error.status === 404 || ['patient_not_found', 'measurement_not_found', 'clinical_photo_not_found'].includes(error.message)) {
      return res.status(404).json({ message: 'Foto no encontrada' });
    }
    throw error;
  }
});

exports.renderPatientNutritionMeasurementReport = asyncHandler(async (req, res) => {
  try {
    await assertNutritionAccess(req, 'nutrition.workspace.view');
    const html = await nutritionWorkspaceService.renderNutritionMeasurementReport(
      req.params.id,
      req.params.measurementId,
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (error) {
    const handled = sendNutritionError(error, res);
    if (handled) return handled;
    if (error.status === 404 || ['patient_not_found', 'measurement_not_found', 'report_not_available'].includes(error.message)) {
      return res.status(404).json({ message: 'Informe no encontrado' });
    }
    throw error;
  }
});

exports.createPatientNutritionMeasurementReportSnapshot = asyncHandler(async (req, res) => {
  try {
    const actorUserId = req.userData?.userId || null;
    await assertNutritionAccess(req, 'nutrition.workspace.view');
    await assertNutritionAccess(req, 'nutrition.measurements.create');
    const snapshot = await nutritionWorkspaceService.createNutritionMeasurementReportSnapshot(
      req.params.id,
      req.params.measurementId,
      actorUserId,
    );
    if (!snapshot) {
      return res.status(202).json({
        message: 'report_snapshot_not_persisted',
        details: { reason: 'storage_table_unavailable' },
      });
    }
    return res.status(201).json(snapshot);
  } catch (error) {
    const handled = sendNutritionError(error, res);
    if (handled) return handled;
    if (error.status === 404 || ['patient_not_found', 'measurement_not_found', 'report_not_available'].includes(error.message)) {
      return res.status(404).json({ message: 'Informe no encontrado' });
    }
    throw error;
  }
});

exports.finalizePatientNutritionMeasurementReport = asyncHandler(async (req, res) => {
  try {
    const actorUserId = req.userData?.userId || null;
    await assertNutritionAccess(req, 'nutrition.workspace.view');
    await assertNutritionAccess(req, 'nutrition.reports.finalize');
    const snapshot = await nutritionWorkspaceService.finalizeNutritionMeasurementReportSnapshot(
      req.params.id,
      req.params.measurementId,
      actorUserId,
    );
    if (!snapshot) {
      return res.status(202).json({
        message: 'report_snapshot_not_finalized',
        details: { reason: 'storage_table_unavailable' },
      });
    }
    return res.status(201).json(snapshot);
  } catch (error) {
    const handled = sendNutritionError(error, res);
    if (handled) return handled;
    if (error.status === 404 || ['patient_not_found', 'measurement_not_found', 'report_not_available'].includes(error.message)) {
      return res.status(404).json({ message: 'Informe no encontrado' });
    }
    throw error;
  }
});

exports.getPatientNutritionMeasurementReportPdf = asyncHandler(async (req, res) => {
  try {
    const actorUserId = req.userData?.userId || null;
    await assertNutritionAccess(req, 'nutrition.workspace.view');
    const { buffer, filename } = await nutritionWorkspaceService.generateNutritionMeasurementReportPdf(
      req.params.id,
      req.params.measurementId,
      actorUserId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (error) {
    const handled = sendNutritionError(error, res);
    if (handled) return handled;
    if (error.status === 404 || ['patient_not_found', 'measurement_not_found', 'report_not_available'].includes(error.message)) {
      return res.status(404).json({ message: 'Informe no encontrado' });
    }
    throw error;
  }
});

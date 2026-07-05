'use strict';

const asyncHandler = require('express-async-handler');
const nutritionWorkspaceService = require('../services/nutritionWorkspace.service');

exports.getPatientNutritionWorkspace = asyncHandler(async (req, res) => {
  try {
    const data = await nutritionWorkspaceService.getPatientNutritionWorkspace(req.params.id);
    res.json(data);
  } catch (error) {
    if (error.status === 404 || error.message === 'patient_not_found') {
      return res.status(404).json({ message: 'Paciente no encontrado' });
    }
    throw error;
  }
});

exports.createPatientNutritionMeasurement = asyncHandler(async (req, res) => {
  try {
    const actorUserId = req.userData?.userId || null;
    const measurement = await nutritionWorkspaceService.createNutritionMeasurement(
      req.params.id,
      req.body || {},
      actorUserId,
    );
    res.status(201).json(measurement);
  } catch (error) {
    if (error.status === 404 || error.message === 'patient_not_found') {
      return res.status(404).json({ message: 'Paciente no encontrado' });
    }
    if (error.status === 400) {
      return res.status(400).json({ message: error.message });
    }
    throw error;
  }
});

exports.renderPatientNutritionMeasurementReport = asyncHandler(async (req, res) => {
  try {
    const html = await nutritionWorkspaceService.renderNutritionMeasurementReport(
      req.params.id,
      req.params.measurementId,
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (error) {
    if (error.status === 404 || ['patient_not_found', 'measurement_not_found', 'report_not_available'].includes(error.message)) {
      return res.status(404).json({ message: 'Informe no encontrado' });
    }
    throw error;
  }
});

exports.getPatientNutritionMeasurementReportPdf = asyncHandler(async (req, res) => {
  try {
    const { buffer, filename } = await nutritionWorkspaceService.generateNutritionMeasurementReportPdf(
      req.params.id,
      req.params.measurementId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (error) {
    if (error.status === 404 || ['patient_not_found', 'measurement_not_found', 'report_not_available'].includes(error.message)) {
      return res.status(404).json({ message: 'Informe no encontrado' });
    }
    throw error;
  }
});

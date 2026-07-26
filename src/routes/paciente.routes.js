const express = require('express');
const router = express.Router();
const pacienteController = require('../controllers/paciente.controller');
const consentimientosController = require('../controllers/consentimientos.controller');
const nutritionWorkspaceController = require('../controllers/nutritionWorkspace.controller');
const patientClinicalAttachmentsController = require('../controllers/patientClinicalAttachments.controller');
const authMiddleware = require('./auth.middleware');

router.use(authMiddleware);

router.get('/', pacienteController.getAllPacientes);
router.get('/search', pacienteController.searchPacientes); // Ruta de búsqueda
router.get('/check-duplicates', pacienteController.checkDuplicates);
router.get('/:id/consents', pacienteController.getConsents);
router.get('/:id/consentimientos', consentimientosController.listPatientDocuments);
router.get('/:id/activity', pacienteController.getPacienteActivity);
router.get('/:id/clinical-attachments', patientClinicalAttachmentsController.listPatientClinicalAttachments);
router.post('/:id/clinical-attachments', patientClinicalAttachmentsController.createPatientClinicalAttachment);
router.get('/:id/clinical-attachments/:attachmentId', patientClinicalAttachmentsController.getPatientClinicalAttachment);
router.get('/:id/nutrition-workspace', nutritionWorkspaceController.getPatientNutritionWorkspace);
router.post('/:id/nutrition-measurements', nutritionWorkspaceController.createPatientNutritionMeasurement);
router.get('/:id/nutrition-measurements/:measurementId/photos', nutritionWorkspaceController.listPatientNutritionMeasurementPhotos);
router.post('/:id/nutrition-measurements/:measurementId/photos', nutritionWorkspaceController.createPatientNutritionMeasurementPhoto);
router.get('/:id/nutrition-measurements/:measurementId/photos/:photoId', nutritionWorkspaceController.getPatientNutritionMeasurementPhoto);
router.post('/:id/nutrition-measurements/:measurementId/report/snapshot', nutritionWorkspaceController.createPatientNutritionMeasurementReportSnapshot);
router.post('/:id/nutrition-measurements/:measurementId/report/finalize', nutritionWorkspaceController.finalizePatientNutritionMeasurementReport);
router.get('/:id/nutrition-measurements/:measurementId/report/render', nutritionWorkspaceController.renderPatientNutritionMeasurementReport);
router.get('/:id/nutrition-measurements/:measurementId/report/pdf', nutritionWorkspaceController.getPatientNutritionMeasurementReportPdf);
router.get('/:id', pacienteController.getPacienteById);
router.post('/', pacienteController.createPaciente);
router.patch('/:id', pacienteController.updatePaciente);
router.post('/:id/transferir-contacto', pacienteController.transferirContacto);
router.post('/:id/vincular-clinica', pacienteController.vincularPacienteAClinica);
router.delete('/:id', pacienteController.deletePaciente);

module.exports = router;

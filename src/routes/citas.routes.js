const express = require('express');
const router = express.Router();
const citasController = require('../controllers/citas.controller');
const clinicalReportsController = require('../controllers/appointmentClinicalReports.controller');
const authMiddleware = require('./auth.middleware');

// Protegemos rutas con auth si middleware está disponible
router.post('/', authMiddleware, citasController.createCita);
router.get('/next', authMiddleware, citasController.getNextCita);
router.get('/manual-attribution-preview', authMiddleware, citasController.getManualAttributionPreview);
router.get('/clinical-reports/patient/:patientId', authMiddleware, clinicalReportsController.listForPatient);
router.get('/calendar', authMiddleware, citasController.getCitasCalendar);
router.get('/:id/clinical-report', authMiddleware, clinicalReportsController.getByAppointment);
router.put('/:id/clinical-report', authMiddleware, clinicalReportsController.save);
router.post('/:id/clinical-report/finalize', authMiddleware, clinicalReportsController.finalize);
router.patch('/:id/estado', authMiddleware, citasController.updateCitaEstado);
router.patch('/:id/cambio-solicitado/resolver', authMiddleware, citasController.resolveRequestedAppointmentChange);
router.patch('/:id/nota', authMiddleware, citasController.updateCitaNota);
router.patch('/:id/reagendar', authMiddleware, citasController.reagendarCita);
router.delete('/:id', authMiddleware, citasController.deleteCita);
router.get('/:id', authMiddleware, citasController.getCitaById);
router.get('/', authMiddleware, citasController.getCitas);

module.exports = router;

'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const consentimientosController = require('../controllers/consentimientos.controller');

router.get('/public/:token', consentimientosController.getPublicPackage);
router.post('/public/:token/sign', consentimientosController.signPublicPackage);
router.post('/tablet/login', consentimientosController.loginTabletKiosk);
router.get('/tablet/session', consentimientosController.getTabletKioskSession);
router.get('/tablet/packages', consentimientosController.listTabletKioskPackages);
router.post('/tablet/packages/:id/session', consentimientosController.createTabletKioskPackageSession);
router.post('/tablet/budget-signatures/:id/session', consentimientosController.createTabletBudgetSignatureSession);

router.use(authMiddleware);

router.get('/admin/templates', consentimientosController.listAdminTemplates);
router.post('/admin/templates', consentimientosController.createAdminTemplate);
router.put('/admin/templates/:id', consentimientosController.updateAdminTemplate);
router.post('/admin/templates/:id/propagate', consentimientosController.propagateAdminTemplate);

router.get('/clinic/templates', consentimientosController.listClinicTemplates);
router.post('/clinic/templates', consentimientosController.createClinicTemplate);
router.put('/clinic/templates/:id', consentimientosController.updateClinicTemplate);
router.post('/clinic/:clinicId/sync-admin', consentimientosController.syncClinicTemplates);
router.get('/clinic/:clinicId/tablet-kiosk', consentimientosController.getClinicKioskAccess);
router.post('/clinic/:clinicId/tablet-kiosk', consentimientosController.createClinicKioskAccess);
router.post('/clinic/:clinicId/tablet-kiosk/reset', consentimientosController.resetClinicKioskAccess);
router.post('/clinic/:clinicId/tablet-kiosk/:kioskId/reset', consentimientosController.regenerateClinicKioskAccess);

router.get('/treatments/:id/requirements', consentimientosController.getTreatmentRequirements);
router.put('/treatments/:id/requirements', consentimientosController.saveTreatmentRequirements);

router.get('/patients/:id/documents', consentimientosController.listPatientDocuments);
router.get('/patients/:id/treatments-without-consent', consentimientosController.listPatientTreatmentsWithoutConsentRequirements);
router.get('/patients/:id/audit', consentimientosController.exportPatientAudit);
router.get('/clinic/pending-documents', consentimientosController.listClinicPendingPatientDocuments);
router.get('/professional/pending', consentimientosController.listProfessionalPendingDocuments);
router.get('/appointments/:id/summary', consentimientosController.getAppointmentSummary);
router.post('/appointments/:id/package', consentimientosController.createAppointmentPackage);
router.post('/packages/:id/send-mock', consentimientosController.sendPackageMock);
router.post('/packages/:id/tablet-session', consentimientosController.createTabletSession);
router.get('/documents/:id', consentimientosController.getDocument);
router.get('/documents/:id/render', consentimientosController.renderDocument);
router.get('/documents/:id/pdf', consentimientosController.getDocumentPdf);
router.post('/documents/:id/sign', consentimientosController.signDocument);
router.post('/documents/:id/sign-professional', consentimientosController.signProfessionalDocument);
router.post('/documents/:id/revoke', consentimientosController.revokeDocument);

module.exports = router;

const express = require('express');
const router = express.Router();
const intakeController = require('../controllers/intake.controller');
const protect = require('./auth.middleware');
const { landingIntakeHandlers } = require('./webLandingIntake.handlers');

// Ingesta pública: siempre exige HMAC del scope o autenticación server-to-server.
router.post('/leads', intakeController.ingestLead);
router.post(
  '/landing-leads',
  ...landingIntakeHandlers
);
router.get('/leads/webhook', intakeController.verifyMetaWebhook);
router.post('/leads/webhook', intakeController.receiveMetaWebhook);
router.get('/config', intakeController.getIntakeConfig);
router.post('/events', intakeController.receiveIntakeEvent);
router.post('/whatsapp-origin', intakeController.registerWhatsappOrigin);

// Rutas protegidas
router.use(protect);
router.get('/config/admin', intakeController.getIntakeConfigAdmin);
router.get('/verify-snippet', intakeController.verifySnippetInstalled);
router.get('/config/:clinicId/secret', intakeController.getIntakeConfigSecretClinic);
router.get('/config/group/:groupId/secret', intakeController.getIntakeConfigSecretGroup);
router.get('/leads/search', intakeController.searchLeads);
router.get('/leads', intakeController.listLeads);
router.get('/leads/stats', intakeController.getLeadStats);
router.post('/leads/import/preview', intakeController.previewLeadImport);
router.post('/leads/import/execute', intakeController.executeLeadImport);
router.get('/leads/auto-reply/status', intakeController.getLeadAutoReplyStatus);
router.get('/leads/auto-reply/pending', intakeController.getLeadAutoReplyPendingPreview);
router.post('/leads/auto-reply/pending/send', intakeController.startLeadAutoReplyPendingSend);
router.get('/leads/auto-reply/pending/:jobId', intakeController.getLeadAutoReplyPendingProgress);
router.patch('/leads/auto-reply', intakeController.updateLeadAutoReply);
router.get('/leads/:id', intakeController.getLeadById);
router.get('/leads/:id/activity', intakeController.getLeadActivity);
router.get('/leads/:id/candidate-appointments', intakeController.getCandidateAppointments);
router.patch('/leads/:id', intakeController.updateLeadStatus);
router.post('/leads/:id/contacto', intakeController.registrarContacto);
router.put('/leads/:id/call-outcome', intakeController.saveCallOutcome);
router.delete('/leads/:id', intakeController.deleteLead);
router.put('/config/:clinicId', intakeController.upsertIntakeConfig);

module.exports = router;

const express = require('express');
const router = express.Router();
const intakeController = require('../controllers/intake.controller');
const protect = require('./auth.middleware');

// Ingesta pública (protegida por firma HMAC si se configura)
router.post('/leads', intakeController.ingestLead);
router.get('/leads/webhook', intakeController.verifyMetaWebhook);
router.post('/leads/webhook', intakeController.receiveMetaWebhook);
router.get('/config', intakeController.getIntakeConfig);
router.post('/events', intakeController.receiveIntakeEvent);
router.post('/whatsapp-origin', intakeController.createWhatsAppWebOrigin);

// Rutas protegidas
router.use(protect);
router.get('/verify-snippet', intakeController.verifySnippet);
router.get('/config/:clinicId/secret', intakeController.getIntakeConfigSecretClinic);
router.get('/config/group/:groupId/secret', intakeController.getIntakeConfigSecretGroup);
router.get('/leads', intakeController.listLeads);
router.get('/leads/:id/audits', intakeController.getLeadAudits);
router.get('/leads/:id/candidate-appointments', intakeController.getLeadCandidateAppointments);
router.get('/leads/stats', intakeController.getLeadStats);
router.get('/leads/:id', intakeController.getLeadById);
router.patch('/leads/:id', intakeController.updateLeadStatus);
router.put('/leads/:id/call-outcome', intakeController.updateLeadCallOutcome);
router.post('/leads/:id/contacto', intakeController.registrarContacto);
router.delete('/leads/:id', intakeController.deleteLead);
router.put('/config/:clinicId', intakeController.upsertIntakeConfig);

module.exports = router;

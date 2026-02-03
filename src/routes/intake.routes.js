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

// Rutas protegidas
router.use(protect);
router.get('/leads', intakeController.listLeads);
router.get('/leads/stats', intakeController.getLeadStats);
router.patch('/leads/:id', intakeController.updateLeadStatus);
router.post('/leads/:id/contacto', intakeController.registrarContacto);
router.delete('/leads/:id', intakeController.deleteLead);
router.put('/config/:clinicId', intakeController.upsertIntakeConfig);

module.exports = router;

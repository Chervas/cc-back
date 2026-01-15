const express = require('express');
const router = express.Router();
const intakeController = require('../controllers/intake.controller');
const protect = require('./auth.middleware');

// Ingesta pública (protegida por firma HMAC si se configura)
router.post('/leads', intakeController.ingestLead);

// Rutas protegidas
router.use(protect);
router.get('/leads', intakeController.listLeads);
router.patch('/leads/:id', intakeController.updateLeadStatus);

module.exports = router;

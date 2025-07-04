const express = require('express');
const router = express.Router();
const leadController = require('../controllers/lead.controller');
const protect = require('./auth.middleware');

// Ruta pública para webhook de Facebook
router.post('/webhook', leadController.receiveFacebookWebhook);

// Rutas protegidas que requieren autenticación
router.use(protect);

// Rutas para leads
router.route('/')
  .get(leadController.getAllLeads)
  .post(leadController.createLead);

router.route('/:id')
  .get(leadController.getLeadById)
  .put(leadController.updateLead)
  .delete(leadController.deleteLead);

module.exports = router;

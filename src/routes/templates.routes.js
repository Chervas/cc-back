const express = require('express');
const router = express.Router();
const protect = require('./auth.middleware');
const templatesController = require('../controllers/templates.controller');

// IMPORTANTE: no usar router.use(protect) aquí porque este router se monta en "/api"
// y bloquearía cualquier otro endpoint "/api/*" aunque no pertenezca a templates.
router.get('/templates', protect, templatesController.listTemplates);
router.post('/templates', protect, templatesController.upsertTemplate);

router.get('/flows', protect, templatesController.listFlows);
router.post('/flows', protect, templatesController.upsertFlow);

router.get('/message-log', protect, templatesController.listMessageLogs);

module.exports = router;

const express = require('express');
const router = express.Router();
const protect = require('./auth.middleware');
const templatesController = require('../controllers/templates.controller');

router.use(protect);

router.get('/templates', templatesController.listTemplates);
router.post('/templates', templatesController.upsertTemplate);

router.get('/flows', templatesController.listFlows);
router.post('/flows', templatesController.upsertFlow);

router.get('/message-log', templatesController.listMessageLogs);

module.exports = router;

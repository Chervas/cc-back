const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const automationsController = require('../controllers/automations.controller');
const automationCatalogController = require('../controllers/automationCatalog.controller');
const automationsV2Controller = require('../controllers/automationsV2.controller');

router.use(authMiddleware);

// Catálogo de automatizaciones (solo admin)
router.get('/catalog', automationCatalogController.listCatalog);
router.post('/catalog', automationCatalogController.createCatalog);
router.put('/catalog/:id', automationCatalogController.updateCatalog);
router.delete('/catalog/:id', automationCatalogController.deleteCatalog);
router.put('/catalog/:id/toggle', automationCatalogController.toggleCatalog);

// Motor de flujos v2 (draft/publish/versiones/ejecuciones)
router.get('/v2/templates', automationsV2Controller.listTemplates);
router.post('/v2/templates', automationsV2Controller.createTemplateDraft);
router.get('/v2/templates/:template_key', automationsV2Controller.getTemplateLatestPublished);
router.get('/v2/templates/:template_key/versions', automationsV2Controller.listTemplateVersions);
router.get('/v2/templates/:template_key/versions/:version', automationsV2Controller.getTemplateVersion);
router.put('/v2/templates/:template_key/versions/:version', automationsV2Controller.updateTemplateDraft);
router.post('/v2/templates/:template_key/versions/:version/publish', automationsV2Controller.publishTemplateVersion);
router.post('/v2/templates/:template_key/versions/:version/execute', automationsV2Controller.executeTemplateVersion);
router.get('/v2/executions/:id', automationsV2Controller.getExecution);
router.get('/v2/executions/:id/logs', automationsV2Controller.getExecutionLogs);

// Activación con validación de canales
router.post('/:id/activate', automationsController.activateAutomation);

module.exports = router;

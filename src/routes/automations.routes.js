const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const automationsController = require('../controllers/automations.controller');
const automationCatalogController = require('../controllers/automationCatalog.controller');

router.use(authMiddleware);

// Catálogo de automatizaciones (solo admin)
router.get('/catalog', automationCatalogController.listCatalog);
router.post('/catalog', automationCatalogController.createCatalog);
router.put('/catalog/:id', automationCatalogController.updateCatalog);
router.delete('/catalog/:id', automationCatalogController.deleteCatalog);
router.put('/catalog/:id/toggle', automationCatalogController.toggleCatalog);

// Activación con validación de canales
router.post('/:id/activate', automationsController.activateAutomation);

module.exports = router;

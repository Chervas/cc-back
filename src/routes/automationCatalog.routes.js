const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const automationCatalogController = require('../controllers/automationCatalog.controller');

router.use(authMiddleware);

// Catálogo de automatizaciones (alias para frontend)
router.get('/', automationCatalogController.listCatalog);
router.get('/:id', automationCatalogController.getCatalogById);
router.post('/', automationCatalogController.createCatalog);
router.put('/:id', automationCatalogController.updateCatalog);
router.delete('/:id', automationCatalogController.deleteCatalog);
router.put('/:id/toggle', automationCatalogController.toggleCatalog);
router.patch('/:id/toggle', automationCatalogController.toggleCatalog);

module.exports = router;

'use strict';
const express = require('express');
const router = express.Router();
const tratamientosController = require('../controllers/tratamientos.controller');
const auth = require('./auth.middleware');
const catalogAccess = require('../lib/treatment-catalog-access').createTreatmentCatalogAccess();
router.use(auth);

router.get('/', catalogAccess, tratamientosController.getTratamientos);
router.get('/:id', catalogAccess, tratamientosController.getTratamientoById);
router.post('/', catalogAccess, tratamientosController.createTratamiento);
router.patch('/:id', catalogAccess, tratamientosController.updateTratamiento);
router.delete('/:id', catalogAccess, tratamientosController.deleteTratamiento);
router.post('/:id/ocultar', catalogAccess, tratamientosController.ocultarTratamiento);
router.post('/:id/restaurar', catalogAccess, tratamientosController.restaurarTratamiento);
router.post('/:id/personalizar', catalogAccess, tratamientosController.personalizarTratamiento);
router.get('/:id/automation-template', catalogAccess, tratamientosController.getTratamientoAutomationTemplate);
router.put('/:id/automation-template', catalogAccess, tratamientosController.setTratamientoAutomationTemplate);

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const candidate = Number(error.statusCode || error.status);
  const status = candidate >= 400 && candidate <= 599 ? candidate : 500;
  res.status(status).json({ message: status === 500 ? 'No se pudo procesar el catálogo.' : error.message, code: status === 500 ? 'treatment_catalog_failed' : error.code || 'treatment_catalog_request_failed' });
});
module.exports = router;

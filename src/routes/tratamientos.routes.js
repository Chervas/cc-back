'use strict';
const express = require('express');
const router = express.Router();
const tratamientosController = require('../controllers/tratamientos.controller');

router.get('/', tratamientosController.getTratamientos);
router.get('/:id', tratamientosController.getTratamientoById);
router.post('/', tratamientosController.createTratamiento);
router.patch('/:id', tratamientosController.updateTratamiento);
router.delete('/:id', tratamientosController.deleteTratamiento);
router.post('/:id/ocultar', tratamientosController.ocultarTratamiento);
router.post('/:id/restaurar', tratamientosController.restaurarTratamiento);
router.post('/:id/personalizar', tratamientosController.personalizarTratamiento);

module.exports = router;

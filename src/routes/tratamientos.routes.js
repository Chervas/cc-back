'use strict';
const express = require('express');
const router = express.Router();
const tratamientosController = require('../controllers/tratamientos.controller');

router.get('/', tratamientosController.getTratamientos);
router.post('/', tratamientosController.createTratamiento);
router.patch('/:id', tratamientosController.updateTratamiento);
router.delete('/:id', tratamientosController.deleteTratamiento);

module.exports = router;

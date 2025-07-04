const express = require('express');
const router = express.Router();
const servicioController = require('../controllers/servicio.controller');

// Ruta para obtener servicios con paginación
router.get('/products', servicioController.getProducts);

// Ruta para obtener todos los servicios
router.get('/', servicioController.getAllServicios);

// Ruta para obtener un servicio por ID
router.get('/:id', servicioController.getServicioById);

// Ruta para crear un nuevo servicio
router.post('/', servicioController.createServicio);

// Ruta para actualizar un servicio por ID
router.patch('/:id', servicioController.updateServicio);

// Ruta para eliminar un servicio por ID
router.delete('/:id', servicioController.deleteServicio);

module.exports = router;

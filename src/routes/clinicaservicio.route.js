const express = require('express');
const router = express.Router();
const clinicaServicioController = require('../controllers/clinicaservicio.controller');

// Ruta para verificar si el mes está cerrado
router.get('/is-month-closed', clinicaServicioController.isMonthClosed);

// Ruta para obtener el resumen del mes
router.get('/month-summary', clinicaServicioController.getMonthSummary);

// Ruta para obtener servicios asignados con paginación
router.get('/products', clinicaServicioController.getProducts);

// Ruta para obtener todos los servicios asignados
router.get('/', clinicaServicioController.getAllClinicaServicios);

// Ruta para obtener un servicio asignado por ID
router.get('/:id', clinicaServicioController.getClinicaServicioById);

// Ruta para crear un nuevo servicio asignado
router.post('/', clinicaServicioController.createClinicaServicio);

// Ruta para actualizar un servicio asignado por ID
router.patch('/:id', clinicaServicioController.updateClinicaServicio);

// Ruta para eliminar un servicio asignado por ID
router.delete('/:id', clinicaServicioController.deleteClinicaServicio);

// Ruta para cerrar el mes
router.post('/close-month', clinicaServicioController.closeMonth);



console.log("Routes registered successfully");

module.exports = router;

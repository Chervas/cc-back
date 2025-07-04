const express = require('express');
const router = express.Router();
const clinicaController = require('../controllers/clinica.controller');

// Ruta para obtener todas las clínicas
router.get('/', clinicaController.getAllClinicas);

// Ruta para buscar una clínica
router.get('/search', clinicaController.searchClinicas);

// Ruta para obtener una clínica por ID
router.get('/:id', clinicaController.getClinicaById);

// Ruta para crear una nueva clínica
router.post('/', clinicaController.createClinica);

// Ruta para actualizar una clínica
router.patch('/:id', clinicaController.updateClinica);

// Ruta para eliminar una clínica
router.delete('/:id', clinicaController.deleteClinica);

// Ruta para asignar un servicio a una clínica
router.post('/addServicio', clinicaController.addServicioToClinica);

// Ruta para obtener servicios de una clínica
router.get('/:id_clinica/servicios', clinicaController.getServiciosByClinica);

module.exports = router;

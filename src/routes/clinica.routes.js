const express = require('express');
const router = express.Router();
const clinicaController = require('../controllers/clinica.controller');
const authMiddleware = require('./auth.middleware');

// La ficha/listado interno contiene configuración y datos de contacto: siempre
// requiere sesión y el controller recorta por scope/capacidad.
router.get('/', authMiddleware, clinicaController.getAllClinicas);

// Ruta para buscar una clínica
router.get('/search', authMiddleware, clinicaController.searchClinicas);

// Horarios estructurados de clínica (requiere autenticación)
router.get('/:id/horarios', authMiddleware, clinicaController.getHorarios);
router.put('/:id/horarios', authMiddleware, clinicaController.putHorarios);
router.get('/:id/patient-intake-settings', authMiddleware, require('../controllers/patientIntakeSettings.controller').get);
router.put('/:id/patient-intake-settings', authMiddleware, require('../controllers/patientIntakeSettings.controller').put);
router.post('/:id/patient-intake-settings/standard-template', authMiddleware, require('../controllers/patientIntakeSettings.controller').standard);
router.get('/:id/patient-intake-settings/standard-template-draft', authMiddleware, require('../controllers/patientIntakeSettings.controller').standardDraft);

// Ruta para obtener una clínica por ID
router.get('/:id', authMiddleware, clinicaController.getClinicaById);

// Ruta para crear una nueva clínica
router.post('/', authMiddleware, clinicaController.createClinica);

// Ruta para actualizar una clínica
router.patch('/:id', authMiddleware, clinicaController.updateClinica);

// Ruta para eliminar una clínica
router.delete('/:id', authMiddleware, clinicaController.deleteClinica);

// Ruta para asignar un servicio a una clínica
router.post('/addServicio', authMiddleware, clinicaController.addServicioToClinica);

// Catálogo público legacy consumido fuera de la ficha interna. Mantener
// explícitamente separado de GET /:id, que sí exige autorización por clínica.
router.get('/:id_clinica/servicios', clinicaController.getServiciosByClinica);

module.exports = router;

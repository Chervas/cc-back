const express = require('express');
const router = express.Router();

const authMiddleware = require('./auth.middleware');
const personalController = require('../controllers/personal.controller');

// Todas las rutas requieren JWT
router.use(authMiddleware);

// Listado filtrable por clinica/grupo (no hace dump global salvo admin/all)
router.get('/', personalController.getPersonal);

// Bloqueos del personal (alias canónico sobre DoctorBloqueos)
router.get('/:id/bloqueos', personalController.getPersonalBloqueos);
router.post('/:id/bloqueos', personalController.createPersonalBloqueo);
router.delete('/:id/bloqueos/:bloqueoId', personalController.deletePersonalBloqueo);

// Detalle de miembro (filtrado por accesos del usuario)
router.get('/:id', personalController.getPersonalById);

// Update (admin o propietario con interseccion de clinica)
router.patch('/:id', personalController.updatePersonalMember);

module.exports = router;

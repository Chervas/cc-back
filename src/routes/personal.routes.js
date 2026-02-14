const express = require('express');
const router = express.Router();

const authMiddleware = require('./auth.middleware');
const personalController = require('../controllers/personal.controller');

// Todas las rutas requieren JWT
router.use(authMiddleware);

// Listado filtrable por clinica/grupo (no hace dump global salvo admin/all)
router.get('/', personalController.getPersonal);

// Schedule/Horarios (canónico para todo el personal)
router.get('/me/schedule', personalController.getScheduleForCurrent);
router.get('/:id/schedule', personalController.getScheduleForPersonal);

// Horarios por clínica (compat con /api/doctors/*)
router.get('/me/clinicas/:clinicaId/horarios', personalController.getHorariosClinicaForCurrent);
router.put('/me/clinicas/:clinicaId/horarios', personalController.updateHorariosClinicaForCurrent);
router.patch('/me/clinicas/:clinicaId/modo-disponibilidad', personalController.updateModoDisponibilidadClinicaForCurrent);
router.get('/:id/clinicas/:clinicaId/horarios', personalController.getHorariosClinica);
router.put('/:id/clinicas/:clinicaId/horarios', personalController.updateHorariosClinica);
router.patch('/:id/clinicas/:clinicaId/modo-disponibilidad', personalController.updateModoDisponibilidadClinica);

// Convenience wrapper (compat con front que usa query param clinica_id)
router.get('/:id/horarios', personalController.getHorarios);
router.put('/:id/horarios', personalController.updateHorarios);

// Bloqueos del personal (alias canónico sobre DoctorBloqueos)
router.get('/me/bloqueos', personalController.getPersonalBloqueosForCurrent);
router.post('/me/bloqueos', personalController.createPersonalBloqueoForCurrent);
router.patch('/me/bloqueos/:bloqueoId', personalController.updatePersonalBloqueoForCurrent);
router.delete('/me/bloqueos/:bloqueoId', personalController.deletePersonalBloqueoForCurrent);
router.get('/:id/bloqueos', personalController.getPersonalBloqueos);
router.post('/:id/bloqueos', personalController.createPersonalBloqueo);
router.patch('/:id/bloqueos/:bloqueoId', personalController.updatePersonalBloqueo);
router.delete('/:id/bloqueos/:bloqueoId', personalController.deletePersonalBloqueo);

// Detalle de miembro (filtrado por accesos del usuario)
router.get('/:id', personalController.getPersonalById);

// Update (admin o propietario con interseccion de clinica)
router.patch('/:id', personalController.updatePersonalMember);

module.exports = router;

const express = require('express');
const router = express.Router();

const authMiddleware = require('./auth.middleware');
const personalController = require('../controllers/personal.controller');

// Reclamación de cuenta provisional (flujo onboarding por email)
router.post('/reclamar', personalController.claimProvisionalAccount);

// El resto de rutas requieren JWT
router.use(authMiddleware);

// Listado filtrable por clinica/grupo (no hace dump global salvo admin/all)
router.get('/', personalController.getPersonal);

// Onboarding de personal
// Canónico v6.1 (usado por front onboarding actual)
router.post('/buscar', personalController.buscarPersonal);
router.post('/invitar', personalController.invitarPersonal);
router.get('/invitaciones', personalController.getInvitaciones);
router.post('/:id/invitacion/responder', personalController.responderInvitacion);

// Compat legacy / transición
router.post('/search', personalController.searchPersonal);
router.post('/invite', personalController.invitePersonal);
router.post('/fusionar', personalController.mergePersonalAccounts);
router.get('/me/invitaciones', personalController.getMyInvitations);
router.post('/me/invitaciones/:clinicaId/aceptar', personalController.acceptMyInvitation);
router.post('/me/invitaciones/:clinicaId/rechazar', personalController.rejectMyInvitation);
router.post('/:id/invitaciones/:clinicaId/cancelar', personalController.cancelInvitation);
router.delete('/:id/clinicas/:clinicaId', personalController.removeClinicCollaboration);

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
router.get('/me/bloqueos/permissions', personalController.getPersonalBloqueosPermissionsForCurrent);
router.get('/:id/bloqueos/permissions', personalController.getPersonalBloqueosPermissions);
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

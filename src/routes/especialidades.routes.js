'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/especialidades.controller');
const authMiddleware = require('./auth.middleware');

// Contratos de areas medicas consumidos por catalogo/agenda/workspaces
router.get('/area-contracts', authMiddleware, ctrl.getMedicalAreaContracts);
router.get('/area-contracts/:code', authMiddleware, ctrl.getMedicalAreaContract);
router.put('/area-contracts/:code', authMiddleware, ctrl.updateMedicalAreaContract);

// Especialidades de sistema (solo lectura)
router.get('/sistema', ctrl.getEspecialidadesSistema);
router.post('/sistema', authMiddleware, ctrl.createEspecialidadSistema);
router.patch('/sistema/:id', authMiddleware, ctrl.updateEspecialidadSistema);
router.delete('/sistema/:id', authMiddleware, ctrl.deleteEspecialidadSistema);

// Especialidades de clínica (sistema + personalizadas)
router.get('/clinica/:id/en-uso', authMiddleware, ctrl.checkEspecialidadClinicaEnUso);
router.get('/clinica/:clinicaId', authMiddleware, ctrl.getEspecialidadesClinica); // vía path param
router.get('/clinica', authMiddleware, ctrl.getEspecialidadesClinica);
router.post('/clinica', authMiddleware, ctrl.createEspecialidadClinica);
router.patch('/clinica/:id', authMiddleware, ctrl.updateEspecialidadClinica);
router.delete('/clinica/:id', authMiddleware, ctrl.deleteEspecialidadClinica);

// Relaciones de especialidades del sistema con clínica
router.post('/clinica/sistema', authMiddleware, ctrl.addEspecialidadSistemaAClinica);
router.delete('/clinica/sistema/:clinicaId/:especialidadId', authMiddleware, ctrl.removeEspecialidadSistemaDeClinica);

// Usuario-Especialidades
router.get('/usuario/:id_usuario', authMiddleware, ctrl.getEspecialidadesUsuario);
router.post('/usuario', authMiddleware, ctrl.addEspecialidadUsuario);
router.delete('/usuario/:id', authMiddleware, ctrl.removeEspecialidadUsuario);

module.exports = router;

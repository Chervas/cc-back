'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/especialidades.controller');

// Especialidades de sistema (solo lectura)
router.get('/sistema', ctrl.getEspecialidadesSistema);

// Especialidades de clínica (sistema + personalizadas)
router.get('/clinica/:id/en-uso', ctrl.checkEspecialidadClinicaEnUso);
router.get('/clinica/:clinicaId', ctrl.getEspecialidadesClinica); // vía path param
router.get('/clinica', ctrl.getEspecialidadesClinica);
router.post('/clinica', ctrl.createEspecialidadClinica);
router.patch('/clinica/:id', ctrl.updateEspecialidadClinica);
router.delete('/clinica/:id', ctrl.deleteEspecialidadClinica);

// Relaciones de especialidades del sistema con clínica
router.post('/clinica/sistema', ctrl.addEspecialidadSistemaAClinica);
router.delete('/clinica/sistema/:clinicaId/:especialidadId', ctrl.removeEspecialidadSistemaDeClinica);

// Usuario-Especialidades
router.get('/usuario/:id_usuario', ctrl.getEspecialidadesUsuario);
router.post('/usuario', ctrl.addEspecialidadUsuario);
router.delete('/usuario/:id', ctrl.removeEspecialidadUsuario);

module.exports = router;

'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/especialidades.controller');

// Especialidades de sistema (solo lectura)
router.get('/sistema', ctrl.getEspecialidadesSistema);

// Especialidades de clínica (sistema + personalizadas)
router.get('/clinica', ctrl.getEspecialidadesClinica);
router.post('/clinica', ctrl.createEspecialidadClinica);
router.patch('/clinica/:id', ctrl.updateEspecialidadClinica);
router.delete('/clinica/:id', ctrl.deleteEspecialidadClinica);

// Usuario-Especialidades
router.get('/usuario/:id_usuario', ctrl.getEspecialidadesUsuario);
router.post('/usuario', ctrl.addEspecialidadUsuario);
router.delete('/usuario/:id', ctrl.removeEspecialidadUsuario);

module.exports = router;

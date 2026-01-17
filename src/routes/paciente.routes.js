const express = require('express');
const router = express.Router();
const pacienteController = require('../controllers/paciente.controller');

router.get('/', pacienteController.getAllPacientes);
router.get('/search', pacienteController.searchPacientes); // Ruta de búsqueda
router.get('/check-duplicates', pacienteController.checkDuplicates);
router.get('/:id', pacienteController.getPacienteById);
router.post('/', pacienteController.createPaciente);
router.patch('/:id', pacienteController.updatePaciente);
router.post('/:id/transferir-contacto', pacienteController.transferirContacto);
router.delete('/:id', pacienteController.deletePaciente);

module.exports = router;

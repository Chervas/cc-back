const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/doctores.controller');

router.use(authMiddleware);
router.get('/', controller.list);
router.get('/:doctorClinicaId/horarios', controller.getHorarios);
router.put('/:doctorClinicaId/horarios', controller.updateHorarios);
router.get('/:doctorId/bloqueos', controller.listBloqueos);
router.post('/:doctorId/bloqueos', controller.createBloqueo);
router.delete('/bloqueos/:id', controller.deleteBloqueo);
router.get('/disponibilidad', controller.disponibilidad);

module.exports = router;

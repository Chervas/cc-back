const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/instalaciones.controller');

router.use(authMiddleware);
router.get('/', controller.list);
router.get('/disponibilidad', controller.disponibilidad);
router.post('/', controller.create);
router.get('/:id', controller.getById);
router.put('/:id', controller.update);
router.delete('/:id', controller.remove);

// Horarios
router.get('/:id/horarios', controller.getHorarios);
router.put('/:id/horarios', controller.putHorarios);

// Bloqueos
router.get('/:id/bloqueos', controller.getBloqueos);
router.post('/bloqueos', controller.createBloqueo);
router.delete('/bloqueos/:id', controller.deleteBloqueo);

module.exports = router;

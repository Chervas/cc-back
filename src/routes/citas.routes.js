const express = require('express');
const router = express.Router();
const citasController = require('../controllers/citas.controller');
const authMiddleware = require('./auth.middleware');

// Protegemos rutas con auth si middleware está disponible
router.post('/', authMiddleware, citasController.createCita);
router.patch('/:id/estado', authMiddleware, citasController.updateCitaEstado);
router.patch('/:id/reagendar', authMiddleware, citasController.reagendarCita);
router.get('/next', authMiddleware, citasController.getNextCita);
router.get('/', authMiddleware, citasController.getCitas);

module.exports = router;

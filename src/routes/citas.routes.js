const express = require('express');
const router = express.Router();
const citasController = require('../controllers/citas.controller');
const authMiddleware = require('./auth.middleware');

// Protegemos rutas con auth si middleware está disponible
router.post('/', authMiddleware, citasController.createCita);
router.get('/', authMiddleware, citasController.getCitas);

module.exports = router;

const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/instalaciones.controller');

router.use(authMiddleware);
router.get('/', controller.list);
router.get('/disponibilidad', controller.disponibilidad);

module.exports = router;

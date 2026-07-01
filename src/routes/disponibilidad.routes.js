const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/disponibilidad.controller');

router.use(authMiddleware);
router.get('/check', controller.check);
router.get('/grid', controller.grid);
router.get('/slots', controller.slots);
router.get('/summary', controller.summary);

module.exports = router;

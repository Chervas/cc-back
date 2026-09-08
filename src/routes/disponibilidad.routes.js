const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/disponibilidad.controller');

router.use(authMiddleware);
router.get('/treatment-slots', controller.treatmentSlots);
router.get('/booking-capabilities', controller.bookingCapabilities);
router.get('/check', controller.check);
router.get('/grid', controller.grid);
router.get('/slots', controller.slots);
router.get('/summary', controller.summary);
router.use(require('../services/treatmentBookingProfile.service').bookingErrorMiddleware);

module.exports = router;

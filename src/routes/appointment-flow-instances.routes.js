'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/appointmentFlowInstances.controller');

router.use(authMiddleware);

router.get('/by-appointment/:citaId', controller.getByAppointment);
router.post('/by-appointment/:citaId/sync', controller.syncByAppointment);
router.get('/:id/logs', controller.getLogs);

module.exports = router;

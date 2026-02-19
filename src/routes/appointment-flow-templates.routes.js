'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/appointmentFlowTemplates.controller');

router.use(authMiddleware);

router.get('/', controller.listAppointmentFlowTemplates);
router.get('/:id', controller.getAppointmentFlowTemplate);
router.post('/', controller.createAppointmentFlowTemplate);
router.put('/:id', controller.updateAppointmentFlowTemplate);
router.delete('/:id', controller.deleteAppointmentFlowTemplate);
router.post('/:id/duplicate', controller.duplicateAppointmentFlowTemplate);

module.exports = router;

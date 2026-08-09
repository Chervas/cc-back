'use strict';

const express = require('express');
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/patientDirection.controller');

const router = express.Router();
router.use(authMiddleware);

router.get('/settings', controller.getSetting);
router.put('/settings/:clinicId', controller.saveSetting);
router.post('/settings/:clinicId/enable', controller.enableSetting);
router.post('/settings/:clinicId/disable', controller.disableSetting);
router.get('/dashboard', controller.getDashboard);
router.get('/conversations/:conversationId/assignment', controller.getAssignmentForConversation);
router.post('/assignments/:assignmentId/take', controller.takeConversation);
router.post('/assignments/:assignmentId/retry-handoff', controller.retryHandoff);
router.post('/assignments/:assignmentId/assign-clinic', controller.assignUnassigned);

module.exports = router;

'use strict';

const express = require('express');
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/systemMonitoring.controller');

const router = express.Router();

router.use(authMiddleware);

router.get('/audit/health', require('../controllers/platformAudit.controller').health);
router.get('/notifications/overview', controller.notificationsOverview);
router.patch('/notifications/settings', controller.updateNotificationSettings);
router.post('/notifications/whatsapp-template/prepare', controller.prepareWhatsappTemplate);
router.post('/notifications/test', controller.sendTestNotification);
router.post('/notifications/check', controller.runNotificationCheck);

module.exports = router;

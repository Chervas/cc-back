'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const notificationsController = require('../controllers/notifications.controller');
const preferencesController = require('../controllers/notificationPreferences.controller');

router.use(authMiddleware);

router.get('/', notificationsController.list);
router.post('/', notificationsController.create);
router.patch('/', notificationsController.update);
router.delete('/', notificationsController.remove);
router.get('/mark-all-as-read', notificationsController.markAllAsRead);

router.get('/preferences/meta', preferencesController.getMeta);
router.get('/preferences', preferencesController.getPreferences);
router.patch('/preferences', preferencesController.updatePreferences);

module.exports = router;

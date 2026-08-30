'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/email.controller');

router.get('/events/provider/health', controller.providerHealth);
router.post('/events/provider', controller.receiveProviderEvent);

router.use('/admin', authMiddleware);
router.get('/admin/overview', controller.overview);
router.get('/admin/messages', controller.messages);
router.get('/admin/events', controller.events);
router.get('/admin/suppressions', controller.suppressions);
router.post('/admin/test-message', controller.queueTestMessage);

module.exports = router;

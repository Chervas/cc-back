'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/email.controller');
const marketingEmailController = require('../controllers/marketingEmail.controller');
const { createPublicMarketingWebRateLimiter } = require('../lib/marketingWebRequestGuards');

const publicRateLimit = createPublicMarketingWebRateLimiter();
const limitUnsubscribe = publicRateLimit({
  operation: 'marketing_email_unsubscribe',
  limit: 30,
  globalIpLimit: 300,
  windowMs: 60 * 60 * 1000,
  identity: () => 'email-unsubscribe',
});

router.get('/events/provider/health', controller.providerHealth);
router.post('/events/provider', controller.receiveProviderEvent);
router.post('/unsubscribe', limitUnsubscribe, marketingEmailController.unsubscribe);

router.use('/admin', authMiddleware);
router.get('/admin/overview', controller.overview);
router.get('/admin/messages', controller.messages);
router.get('/admin/events', controller.events);
router.get('/admin/suppressions', controller.suppressions);
router.post('/admin/test-message', controller.queueTestMessage);

module.exports = router;

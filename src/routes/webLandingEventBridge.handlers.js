'use strict';

const controller = require('../controllers/webLandingEventBridge.controller');
const { createPublicMarketingWebRateLimiter } = require('../lib/marketingWebRequestGuards');

const publicWebRateLimit = createPublicMarketingWebRateLimiter();

const landingEventBridgeHandlers = [
  publicWebRateLimit({
    operation: 'landing_event_bridge_prepare',
    limit: 300,
    windowMs: 10 * 60 * 1000,
    identity: () => '00000000-0000-4000-8000-000000000000',
  }),
  controller.prepare,
  publicWebRateLimit({
    operation: 'landing_event_bridge',
    limit: 1000,
    windowMs: 10 * 60 * 1000,
    identity: (req) => req.webLandingRateLimitIdentity,
  }),
  controller.dispatch,
];

module.exports = { landingEventBridgeHandlers };

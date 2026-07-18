'use strict';

const controller = require('../controllers/webLandingEventBridge.controller');
const { createPublicMarketingWebRateLimiter } = require('../lib/marketingWebRequestGuards');
const { landingEventBridgeRateLimitOptions } = require('../lib/webLandingEventRateLimit');

function createLandingEventBridgeHandlers({
  publicWebRateLimit = createPublicMarketingWebRateLimiter(),
} = {}) {
  const limits = landingEventBridgeRateLimitOptions();
  return [
    publicWebRateLimit(limits.preliminary),
    controller.prepare,
    publicWebRateLimit(limits.canonical),
    controller.dispatch,
  ];
}

const landingEventBridgeHandlers = createLandingEventBridgeHandlers();

module.exports = {
  createLandingEventBridgeHandlers,
  landingEventBridgeHandlers,
};

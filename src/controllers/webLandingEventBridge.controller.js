'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../models');
const intakeController = require('./intake.controller');
const {
  WebLandingEventBridgeError,
  prepareWebLandingEventBridge,
} = require('../services/webLandingEventBridge.service');

function noStore(res) {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Content-Type-Options', 'nosniff');
}

const prepare = asyncHandler(async (req, res, next) => {
  let prepared;
  try {
    prepared = await prepareWebLandingEventBridge({
      body: req.body,
      headers: req.headers,
      models: db,
    });
  } catch (error) {
    noStore(res);
    const status = error instanceof WebLandingEventBridgeError || error?.name === 'WebLandingAttributionError'
      ? Number(error.status || 422)
      : 503;
    return res.status(status).json({
      success: false,
      error: {
        code: String(error?.code || 'web_event_bridge_failed'),
        message: status >= 500 ? 'No se ha podido registrar la medición.' : String(error?.message || 'La medición no es válida.'),
      },
    });
  }
  noStore(res);
  req.body = prepared.payload;
  req.rawBody = prepared.raw_body;
  req.headers['content-type'] = 'application/json';
  req.headers['x-cc-signature'] = prepared.signature;
  req.headers['x-clinicaclick-web-artifact'] = prepared.artifact_hash;
  req.webLandingEventEndpoint = prepared.endpoint;
  req.webLandingRateLimitIdentity = prepared.publication_id;
  req.webLandingEventAttribution = prepared.attribution;
  return next();
});

function dispatch(req, res, next) {
  if (req.webLandingEventEndpoint === 'leads') return intakeController.ingestLead(req, res, next);
  if (req.webLandingEventEndpoint === 'events') return intakeController.receiveIntakeEvent(req, res, next);
  if (req.webLandingEventEndpoint === 'whatsapp-origin') return intakeController.registerWhatsappOrigin(req, res, next);
  return res.status(422).json({ success: false, error: { code: 'web_event_bridge_endpoint_invalid' } });
}

module.exports = { dispatch, prepare };

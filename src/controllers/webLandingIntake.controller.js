'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../models');
const {
  WebLandingSubmissionError,
  prepareWebLandingSubmission,
} = require('../services/webLandingSubmission.service');
const {
  webLandingInternalContext,
} = require('../services/webArtifactMetadata.service');

function noStore(res) {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Content-Type-Options', 'nosniff');
}

const prepare = asyncHandler(async (req, res, next) => {
  let prepared;
  try {
    prepared = await prepareWebLandingSubmission({
      body: req.body,
      headers: req.headers,
      remoteAddress: req.ip || req.socket?.remoteAddress,
      models: db,
    });
  } catch (error) {
    noStore(res);
    const status = error instanceof WebLandingSubmissionError || error?.name === 'WebLandingAttributionError'
      ? Number(error.status || 422)
      : 503;
    return res.status(status).json({
      success: false,
      error: {
        code: String(error?.code || 'web_landing_submission_failed'),
        message: status >= 500
          ? 'No hemos podido enviar el formulario. Inténtalo de nuevo en unos minutos.'
          : String(error?.message || 'El formulario no es válido.'),
      },
    });
  }
  noStore(res);
  if (prepared.spam) return res.redirect(303, prepared.success_url);
  req.body = prepared.payload;
  req.rawBody = prepared.raw_body;
  req.headers['content-type'] = 'application/json';
  req.headers['x-cc-signature'] = prepared.signature;
  req.headers['x-cc-event-id'] = prepared.event_id;
  req.headers['x-clinicaclick-web-artifact'] = prepared.attribution.artifact_hash;
  req.webLandingEventAttribution = prepared.attribution;
  req.webLandingArtifactMetadata = webLandingInternalContext(prepared.attribution)?.artifact || null;
  req.webLandingRateLimitIdentity = prepared.attribution.publication_id;
  req.webLandingRedirect = {
    success: prepared.success_url,
    error: prepared.error_url,
  };
  return next();
});

function redirectResponse(req, res, next) {
  const redirects = req.webLandingRedirect;
  if (!redirects) return next();
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    const status = Number(res.statusCode || 200);
    const accepted = (
      (status === 200 || status === 201 || status === 409)
      && Number(payload?.id) > 0
    );
    res.json = originalJson;
    return res.redirect(303, accepted ? redirects.success : redirects.error);
  };
  return next();
}

function redirectError(error, req, res, next) {
  if (!req.webLandingRedirect || res.headersSent) return next(error);
  noStore(res);
  return res.redirect(303, req.webLandingRedirect.error);
}

module.exports = {
  prepare,
  redirectError,
  redirectResponse,
};

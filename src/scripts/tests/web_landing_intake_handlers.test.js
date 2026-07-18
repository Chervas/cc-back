'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const controller = require('../../controllers/webLandingIntake.controller');

const handlersSource = fs.readFileSync(
  path.join(__dirname, '../../routes/webLandingIntake.handlers.js'),
  'utf8'
);
const prepareIndex = handlersSource.indexOf('webLandingIntakeController.prepare,');
const redirectIndex = handlersSource.indexOf('webLandingIntakeController.redirectResponse,');
const verifiedLimiterIndex = handlersSource.indexOf("operation: 'landing_intake',", prepareIndex);
assert.ok(prepareIndex >= 0 && redirectIndex > prepareIndex && verifiedLimiterIndex > redirectIndex,
  'el redirect debe envolver también el rate limit de la publicación validada');

const req = { webLandingRedirect: { success: 'https://example.test/#ok', error: 'https://example.test/#error' } };
const res = {
  statusCode: 200,
  redirected: null,
  json() { throw new Error('no debe renderizar JSON'); },
  status(code) { this.statusCode = code; return this; },
  redirect(code, url) { this.statusCode = code; this.redirected = url; return this; },
};
controller.redirectResponse(req, res, () => {});
res.status(429).json({ success: false, error: { code: 'rate_limit_exceeded' } });
assert.equal(res.statusCode, 303);
assert.equal(res.redirected, req.webLandingRedirect.error);

console.log('web landing intake handlers: ok');

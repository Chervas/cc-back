'use strict';

const crypto = require('node:crypto');

const INTAKE_SIGNATURE_HEADERS = Object.freeze([
  'x-cc-signature',
  'x-cc-signature-sha256',
]);

function rawBodyBuffer(req) {
  if (Buffer.isBuffer(req?.rawBody)) return req.rawBody;
  if (typeof req?.rawBody === 'string') return Buffer.from(req.rawBody, 'utf8');
  return null;
}

function normalizeHexSignature(value, { allowSha256Prefix = true } = {}) {
  if (typeof value !== 'string') return null;
  let normalized = value.trim().toLowerCase();
  if (allowSha256Prefix && normalized.startsWith('sha256=')) {
    normalized = normalized.slice('sha256='.length);
  }
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function secureHexEqual(left, right) {
  const actual = Buffer.from(String(left || ''), 'ascii');
  const expected = Buffer.from(String(right || ''), 'ascii');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function intakeSignature(req) {
  for (const header of INTAKE_SIGNATURE_HEADERS) {
    const value = req?.headers?.[header];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function validateHmacRequest(req, secret, providedSignature = intakeSignature(req)) {
  const key = String(secret || '').trim();
  const signature = normalizeHexSignature(providedSignature);
  const body = rawBodyBuffer(req);
  if (!key || !signature || !body) return false;
  const expected = crypto.createHmac('sha256', key).update(body).digest('hex');
  return secureHexEqual(signature, expected);
}

/**
 * Resolve the applicable IntakeConfig without allowing a broader credential to
 * shadow a narrower one. A correctly signed candidate always wins. If no
 * candidate verifies, return the first candidate that owns an HMAC so the
 * authentication gate rejects the request instead of falling through to an
 * unsigned clinic record or the global server credential.
 */
function pickMatchingIntakeConfig({
  req,
  providedSignature = intakeSignature(req),
  clinicCfg = null,
  groupCfg = null,
  domainCfg = null,
} = {}) {
  const candidates = [clinicCfg, groupCfg, domainCfg].filter(Boolean);
  if (!candidates.length) return null;

  if (providedSignature) {
    const matched = candidates.find((config) => (
      String(config?.hmac_key || '').trim()
      && validateHmacRequest(req, config.hmac_key, providedSignature)
    ));
    if (matched) return matched;
  }

  return candidates.find((config) => String(config?.hmac_key || '').trim())
    || clinicCfg
    || groupCfg
    || domainCfg
    || null;
}

/**
 * Public intake has two supported authentication sources:
 *  - the HMAC belonging to the resolved IntakeConfig scope; or
 *  - the explicit server-to-server fallback INTAKE_WEB_SECRET when that
 *    scope has no HMAC (including integrations without an IntakeConfig).
 *
 * A global fallback never overrides an existing scope HMAC. This prevents a
 * shared server credential from bypassing the narrower clinic/group secret.
 */
function authenticatePublicIntakeRequest({
  req,
  config = null,
  fallbackSecret = '',
} = {}) {
  const scopedSecret = String(config?.hmac_key || '').trim();
  const serverSecret = String(fallbackSecret || '').trim();

  if (scopedSecret) {
    return validateHmacRequest(req, scopedSecret)
      ? { ok: true, source: 'intake_config_hmac' }
      : {
          ok: false,
          status: 401,
          code: 'intake_signature_invalid',
          message: 'Firma HMAC inválida o ausente',
        };
  }

  if (serverSecret) {
    return validateHmacRequest(req, serverSecret)
      ? { ok: true, source: 'server_hmac' }
      : {
          ok: false,
          status: 401,
          code: 'intake_signature_invalid',
          message: 'Firma HMAC inválida o ausente',
        };
  }

  return {
    ok: false,
    status: 503,
    code: 'intake_authentication_not_configured',
    message: 'La recepción pública no tiene configurada una autenticación server-side.',
  };
}

/**
 * Meta signs the exact raw request body with the app secret. Production uses
 * the default strict validator. Unit/integration tests may opt out only by
 * constructing a validator with `allowUnsignedForTests: true`; no environment
 * name and no missing configuration can enable that path implicitly.
 */
function createMetaSignatureValidator({
  appSecret = '',
  allowUnsignedForTests = false,
} = {}) {
  const secret = String(appSecret || '').trim();
  const explicitTestBypass = allowUnsignedForTests === true;

  return function validateMetaSignature(req) {
    if (explicitTestBypass) return true;
    if (!secret) return false;
    const signatureHeader = req?.headers?.['x-hub-signature-256'];
    if (typeof signatureHeader !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signatureHeader.trim())) {
      return false;
    }
    const body = rawBodyBuffer(req);
    if (!body) return false;
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    return secureHexEqual(signatureHeader.trim().toLowerCase(), expected);
  };
}

module.exports = {
  INTAKE_SIGNATURE_HEADERS,
  authenticatePublicIntakeRequest,
  createMetaSignatureValidator,
  intakeSignature,
  normalizeHexSignature,
  pickMatchingIntakeConfig,
  rawBodyBuffer,
  validateHmacRequest,
};

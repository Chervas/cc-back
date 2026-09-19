'use strict';

const STATUS = Object.freeze({
  invalid_request: 400, invalid_signature: 401, scope_denied: 403,
  operation_denied: 403, whatsapp_template_not_authorized: 403, connection_blocked: 423, asset_revoked: 423, request_replayed: 409,
  action_plan_conflict: 409, action_plan_expired: 409, action_plan_busy: 409,
  idempotency_conflict: 409, outcome_unknown: 409, rate_limited: 429,
  provider_disabled: 503, provider_failed: 502, provider_timeout: 504,
  provider_unauthorized: 502, credential_revoked: 423,
  secret_unavailable: 503, audit_unavailable: 503, internal_error: 500,
  ...Object.fromEntries(Object.values(require('./bedrock-errors').PROVIDER_ERRORS).map(code=>[code,502])),
  secret_version_changed: 409, oauth_state_invalid: 409, oauth_identity_mismatch: 409,
  oauth_credentials_incomplete: 409, oauth_flow_busy: 409, oauth_flow_interrupted: 409,
});
class BrokerError extends Error {
  constructor(code) { super(code); this.code = Object.hasOwn(STATUS, code) ? code : 'internal_error'; }
}
const fail = code => { throw new BrokerError(code); };
function publicError(error) {
  const code = error instanceof BrokerError ? error.code : 'internal_error';
  return { status: STATUS[code], body: { error: { code } } };
}
module.exports = { BrokerError, fail, publicError };

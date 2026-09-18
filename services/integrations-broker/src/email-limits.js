'use strict';

module.exports = Object.freeze({
  OPERATION: 'email.ses.send.v1',
  PROVIDER: 'aws_ses',
  REGION: 'eu-west-3',
  MAX_REQUEST_BYTES: 256 * 1024,
  MAX_RESPONSE_BYTES: 8192,
  MAX_CONCURRENT_REQUESTS: 2,
  MAX_PENDING_REQUEST_BYTES: 512 * 1024,
  MAX_TIMEOUT_MS: 30000,
  MAX_PROVIDER_TIMEOUT_MS: 20000,
  TEMPLATES: Object.freeze(['auth.email_verification', 'auth.password_reset', 'ops.email_test', 'ops.system_alert', 'automation.generic']),
  AUTH_TEMPLATES: Object.freeze(['auth.email_verification', 'auth.password_reset']),
});

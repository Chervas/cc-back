'use strict';

const OPERATIONS = Object.freeze({
  SEND: 'email.ses.send.v1',
  IDENTITY_ENSURE: 'email.ses.identity.ensure.v1',
  IDENTITY_GET: 'email.ses.identity.get.v1',
});

module.exports = Object.freeze({
  OPERATION: OPERATIONS.SEND,
  OPERATIONS,
  isEmailOperation: operation => Object.values(OPERATIONS).includes(operation),
  PROVIDER: 'aws_ses',
  REGION: 'eu-west-3',
  MAX_REQUEST_BYTES: 256 * 1024,
  MAX_RESPONSE_BYTES: 8192,
  MAX_CONCURRENT_REQUESTS: 2,
  MAX_PENDING_REQUEST_BYTES: 512 * 1024,
  MAX_TIMEOUT_MS: 30000,
  MAX_PROVIDER_TIMEOUT_MS: 20000,
  TEMPLATES: Object.freeze(['auth.email_verification', 'auth.password_reset', 'ops.email_test', 'ops.system_alert', 'automation.generic', 'marketing.campaign']),
  AUTH_TEMPLATES: Object.freeze(['auth.email_verification', 'auth.password_reset']),
});

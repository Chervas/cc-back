'use strict';

// Signing identity only. This module never reads SES credentials or uses an
// ambient AWS credential chain. The durable outbox remains the retry owner.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const L = require('../../services/integrations-broker/src/email-limits');
const { validate } = require('../../services/integrations-broker/src/email-contract');
const REJECTION_CODES = new Set(['email_ses_account_suspended', 'email_ses_bad_request', 'email_ses_limit_exceeded',
  'email_ses_mail_from_unverified', 'email_ses_message_rejected', 'email_ses_resource_not_found', 'email_ses_sending_paused', 'email_ses_throttled']);
const fail = (code, retryable = false) => { throw Object.assign(new Error(code), { code, retryable }); };
function privateFile(filename) {
  try {
    if (!filename || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) throw Error();
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) throw Error();
    return fs.readFileSync(filename);
  } catch { fail('email_broker_configuration_invalid'); }
}
function requestId(outboxId, attempt) {
  const hex = createHash('sha256').update(`clinicaclick-email-attempt-v1\n${outboxId}\n${attempt}`).digest('hex');
  // The transport contract uses UUIDv4-shaped opaque IDs; the digest makes a
  // persisted outbox attempt stable across process restarts.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function isConfigured(env = process.env) {
  const environment = env.EMAIL_BROKER_ENVIRONMENT;
  try {
    const origin = new URL(env.EMAIL_BROKER_ORIGIN);
    return ['dev', 'staging', 'prod'].includes(environment)
      && env.EMAIL_BROKER_CONNECTION_REF === `email:${environment}`
      && env.EMAIL_BROKER_AUDIENCE === `clinicaclick:email:${environment}:v1`
      && (env.EMAIL_AWS_REGION || env.AWS_REGION || L.REGION) === L.REGION
      && origin.protocol === 'https:' && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash
      && typeof env.EMAIL_BROKER_KEY_ID === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(env.EMAIL_BROKER_KEY_ID)
      && [env.EMAIL_BROKER_KEY_FILE, env.EMAIL_BROKER_CA_FILE].every(file => typeof file === 'string' && path.isAbsolute(file));
  } catch { return false; }
}
function createEmailBroker({ env = process.env, readFile = privateFile, clientFactory = createIntegrationsBrokerClient } = {}) {
  return {
    async send(payload) {
      if (env.EMAIL_BROKER_ENABLED !== 'true') fail('email_broker_disabled');
      const environment = env.EMAIL_BROKER_ENVIRONMENT;
      if (!isConfigured(env)) fail('email_broker_configuration_invalid');
      try { validate(payload); } catch { fail('email_broker_request_invalid'); }
      const client = clientFactory({ origin: env.EMAIL_BROKER_ORIGIN, audience: env.EMAIL_BROKER_AUDIENCE,
        keyId: env.EMAIL_BROKER_KEY_ID, privateKey: readFile(env.EMAIL_BROKER_KEY_FILE), ca: readFile(env.EMAIL_BROKER_CA_FILE),
        transportProfile: 'email', timeoutMs: L.MAX_TIMEOUT_MS });
      let response;
      try {
        response = await client.execute({ requestId: requestId(payload.outboxId, payload.attempt), operation: L.OPERATION,
          tenantRef: `platform:${environment}`, connectionRef: env.EMAIL_BROKER_CONNECTION_REF,
          assetRef: `email:${payload.templateKey}`, payload }, { timeoutMs: L.MAX_TIMEOUT_MS });
      } catch {
        // A broker 429/500 is not an explicit SES rejection. Lost responses,
        // uncertain commands and admission failures never cause a second send.
        fail('email_provider_broker_unknown_outcome');
      }
      const data = response?.data;
      if (data?.accepted === true && data.provider === 'ses' && typeof data.providerMessageId === 'string'
        && /^[A-Za-z0-9_-]{1,200}$/.test(data.providerMessageId)) {
        return { provider: 'ses', providerMessageId: data.providerMessageId, accepted: true, configurationSet: payload.configurationSet };
      }
      if (data?.accepted === false && REJECTION_CODES.has(data.code) && data.retryable === (data.code === 'email_ses_throttled')) fail(data.code, data.retryable);
      fail('email_provider_broker_unknown_outcome');
    },
  };
}
module.exports = { createEmailBroker, requestId, isConfigured };

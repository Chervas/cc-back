'use strict';

// No models, .env loading, AWS SDK, bootstrap or provider tokens in this consumer adapter.
const https = require('node:https');
const { createHash, createPrivateKey, randomUUID, sign } = require('node:crypto');
const aiLimits = require('../../services/integrations-broker/src/ai-limits');
const emailLimits = require('../../services/integrations-broker/src/email-limits');
const SAFE_CODES = new Set(['invalid_request', 'invalid_signature', 'scope_denied', 'operation_denied', 'whatsapp_template_not_authorized', 'connection_blocked', 'asset_revoked',
  'request_replayed', 'idempotency_conflict', 'outcome_unknown', 'rate_limited', 'provider_disabled', 'provider_failed',
  'provider_timeout', 'provider_unauthorized', 'credential_revoked', 'secret_unavailable', 'audit_unavailable', 'internal_error',
  'secret_version_changed', 'oauth_state_invalid', 'oauth_identity_mismatch', 'oauth_credentials_incomplete',
  'oauth_flow_busy', 'oauth_flow_interrupted',
  ...Object.values(require('../../services/integrations-broker/src/bedrock-errors').PROVIDER_ERRORS)]);
const error = code => Object.assign(new Error(code), { code });
function createIntegrationsBrokerClient({ origin, keyId, privateKey, audience, ca, timeoutMs = 15000, transportProfile = 'default' }) {
  const ai = transportProfile === 'ai';
  const email = transportProfile === 'email';
  const maxTimeout = ai ? aiLimits.MAX_TIMEOUT_MS : 30000;
  let base; let key;
  try {
    base = new URL(origin); key = createPrivateKey(privateKey);
    if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash
      || key.asymmetricKeyType !== 'ed25519' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(keyId)
      || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(audience) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeout
      || !['default', 'ai', 'email'].includes(transportProfile)) throw Error();
  } catch { throw error('broker_configuration_invalid'); }
  return {
    execute(command, options = {}) {
      const budget = options.timeoutMs === undefined ? timeoutMs : options.timeoutMs;
      if (!Number.isInteger(budget) || budget < 1 || budget > maxTimeout
        || ai && !aiLimits.isAiOperation(command.operation)
        || email && command.operation !== emailLimits.OPERATION) return Promise.reject(error('invalid_request'));
      const requestId = command.requestId || randomUUID();
      const body = Buffer.from(JSON.stringify({ ...command, requestId, version: 1, audience, issuedAt: Date.now(), nonce: randomUUID() }));
      if (body.length > (ai ? aiLimits.MAX_REQUEST_BYTES : email ? emailLimits.MAX_REQUEST_BYTES : 32768)) return Promise.reject(error('invalid_request'));
      const message = Buffer.from(`clinicaclick-broker-v1\nPOST\n/v1/execute\n${createHash('sha256').update(body).digest('hex')}`);
      return new Promise((resolve, reject) => {
        let settled = false; let timer;
        const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(value); };
        const req = https.request(new URL('/v1/execute', base), { method: 'POST', ca, rejectUnauthorized: true,
          minVersion: 'TLSv1.2', agent: false, headers: { 'content-type': 'application/json', 'content-length': body.length,
            'x-broker-key-id': keyId, 'x-broker-signature': sign(null, message, key).toString('base64url') } }, res => {
          const chunks = []; let size = 0;
          const maxResponse=ai?aiLimits.MAX_RESPONSE_BYTES:email?emailLimits.MAX_RESPONSE_BYTES:command.operation==='meta.whatsapp.authorized.media.read.v1'?Math.ceil(32*1024*1024/3)*4+4096:1048576;
          res.on('data', chunk => { size += chunk.length; if (size > maxResponse) req.destroy(error('broker_response_invalid')); else chunks.push(chunk); });
          res.on('error', () => finish(error('broker_unavailable')));
          res.on('aborted', () => finish(error('broker_unavailable')));
          res.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (res.statusCode !== 200) return finish(error(SAFE_CODES.has(value?.error?.code) ? value.error.code : 'broker_unavailable'));
              if (value.requestId !== requestId || typeof value.replayed !== 'boolean' || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw Error();
              finish(null, value);
            } catch { finish(error('broker_response_invalid')); }
          });
        });
        timer = setTimeout(() => { finish(error('broker_timeout')); req.destroy(); }, Math.min(timeoutMs, budget));
        req.on('error', () => finish(error('broker_unavailable')));
        req.end(body);
      });
    },
  };
}
module.exports = { createIntegrationsBrokerClient };

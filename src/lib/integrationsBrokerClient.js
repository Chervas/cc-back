'use strict';

// No models, .env loading, AWS SDK, bootstrap or provider tokens in this consumer adapter.
const https = require('node:https');
const { createHash, createPrivateKey, randomUUID, sign } = require('node:crypto');
const SAFE_CODES = new Set(['invalid_request', 'invalid_signature', 'scope_denied', 'operation_denied', 'connection_blocked',
  'request_replayed', 'idempotency_conflict', 'outcome_unknown', 'rate_limited', 'provider_disabled', 'provider_failed',
  'provider_timeout', 'secret_unavailable', 'audit_unavailable', 'internal_error']);
const error = code => Object.assign(new Error(code), { code });
function createIntegrationsBrokerClient({ origin, keyId, privateKey, audience, ca, timeoutMs = 15000 }) {
  let base; let key;
  try {
    base = new URL(origin); key = createPrivateKey(privateKey);
    if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash
      || key.asymmetricKeyType !== 'ed25519' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(keyId)
      || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(audience)) throw Error();
  } catch { throw error('broker_configuration_invalid'); }
  return {
    execute(command) {
      const requestId = command.requestId || randomUUID();
      const body = Buffer.from(JSON.stringify({ ...command, requestId, version: 1, audience, issuedAt: Date.now(), nonce: randomUUID() }));
      if (body.length > 32768) return Promise.reject(error('invalid_request'));
      const message = Buffer.from(`clinicaclick-broker-v1\nPOST\n/v1/execute\n${createHash('sha256').update(body).digest('hex')}`);
      return new Promise((resolve, reject) => {
        const req = https.request(new URL('/v1/execute', base), { method: 'POST', ca, rejectUnauthorized: true,
          minVersion: 'TLSv1.2', agent: false, headers: { 'content-type': 'application/json', 'content-length': body.length,
            'x-broker-key-id': keyId, 'x-broker-signature': sign(null, message, key).toString('base64url') } }, res => {
          const chunks = []; let size = 0;
          res.on('data', chunk => { size += chunk.length; if (size > 1048576) req.destroy(error('broker_response_invalid')); else chunks.push(chunk); });
          res.on('error', () => reject(error('broker_unavailable')));
          res.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (res.statusCode !== 200) return reject(error(SAFE_CODES.has(value?.error?.code) ? value.error.code : 'broker_unavailable'));
              if (value.requestId !== requestId || typeof value.replayed !== 'boolean' || !value.data || typeof value.data !== 'object') throw Error();
              resolve(value);
            } catch { reject(error('broker_response_invalid')); }
          });
        });
        req.setTimeout(Math.min(30000, Math.max(1, timeoutMs)), () => req.destroy(error('broker_timeout')));
        req.on('error', () => reject(error('broker_unavailable')));
        req.end(body);
      });
    },
  };
}
module.exports = { createIntegrationsBrokerClient };

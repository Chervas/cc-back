'use strict';
const https = require('node:https');
const { BrokerError, fail } = require('./errors');
const { tokenText } = require('./whatsapp-secrets');
const C = require('./meta-marketing-contract');
const FIELDS = Object.freeze({ ad_account: 'id,account_id,name,account_status,currency,timezone_name',
  facebook_page: 'id,name', instagram_business: 'id,name,username', instagram_parent: 'id,instagram_business_account' });
function createMetaMarketingHttp({ request = https.request, timeoutMs = 8000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) fail('invalid_request');
  // Reuse only the fixed inspection protocol; no WhatsApp send action is exposed.
  const inspect = require('./whatsapp-http').createWhatsappHttp({ request, timeoutMs });
  return async input => {
    if (!input || Object.keys(input).some(key => !['action', 'id', 'token', 'proof', 'candidate', 'signal'].includes(key))) fail('invalid_request');
    if (input.action === 'inspect') return inspect(input);
    const { action, id, token, proof, signal } = input;
    if (!Object.hasOwn(FIELDS, action) || !C.graphId(id) || input.candidate !== undefined || !Buffer.isBuffer(token)
      || !tokenText(token.toString('utf8')) || typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) fail('invalid_request');
    if (signal?.aborted) fail('provider_timeout');
    const query = new URLSearchParams({ fields: FIELDS[action], appsecret_proof: proof });
    return new Promise((resolve, reject) => {
      let req, timer, settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      const abort = () => { finish(new BrokerError('provider_timeout')); req?.destroy(); };
      timer = setTimeout(abort, timeoutMs); timer.unref?.();
      try {
        req = request({ protocol: 'https:', hostname: 'graph.facebook.com', port: 443, method: 'GET',
          path: `/${C.GRAPH_VERSION}/${action === 'ad_account' ? 'act_' : ''}${id}?${query}`, agent: false,
          rejectUnauthorized: true, minVersion: 'TLSv1.2', headers: { authorization: 'Bearer ' + token.toString('utf8'),
            accept: 'application/json', 'accept-encoding': 'identity' } }, res => {
          if (String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json'
            || !['', 'identity'].includes(String(res.headers['content-encoding'] || '').toLowerCase())
            || res.statusCode >= 300 && res.statusCode < 400) { finish(new BrokerError('provider_failed')); res.destroy(); req?.destroy(); return; }
          const chunks = []; let bytes = 0;
          res.on('data', chunk => { bytes += chunk.length;
            if (bytes > 131072) { finish(new BrokerError('provider_failed')); res.destroy(); req?.destroy(); }
            else if (!settled) chunks.push(chunk);
          });
          res.on('aborted', () => finish(new BrokerError('provider_failed'))); res.on('error', () => finish(new BrokerError('provider_failed')));
          res.on('end', () => {
            if (settled) return;
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!value || typeof value !== 'object' || Array.isArray(value)) fail('provider_failed');
              if ([190, 102].includes(value.error?.code)) fail('credential_revoked');
              if ([401, 403].includes(res.statusCode) || [10, 200].includes(value.error?.code)) fail('provider_unauthorized');
              if (res.statusCode === 429 || [4, 17, 32, 613].includes(value.error?.code)) fail('rate_limited');
              if (res.statusCode !== 200 || value.error) fail('provider_failed');
              finish(null, value);
            } catch (error) { finish(error instanceof BrokerError ? error : new BrokerError('provider_failed')); }
          });
        });
        req.on('error', () => finish(new BrokerError('provider_failed')));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted || settled) abort(); else req.end();
      } catch { finish(new BrokerError('provider_failed')); req?.destroy(); }
    });
  };
}
module.exports = { createMetaMarketingHttp };

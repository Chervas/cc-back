'use strict';
const https = require('node:https'); const { BrokerError, fail } = require('./errors');
const { tokenText } = require('./whatsapp-secrets'); const { GRAPH_VERSION } = require('./whatsapp-contract');
function createWhatsappHttp({ request = https.request, timeoutMs = 8000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) fail('invalid_request');
  return async input => {
    if (!input || Object.keys(input).some(key => !['action', 'id', 'token', 'proof', 'candidate', 'json', 'signal', 'after'].includes(key))) fail('invalid_request');
    const { action, id, token, proof, candidate, json, signal, after } = input;
    if (!['send', 'template', 'inspect', 'phones', 'phone_state'].includes(action) || typeof id !== 'string' || !/^[1-9][0-9]{0,29}$/.test(id)
      || !Buffer.isBuffer(token) || !tokenText(token.toString('utf8'))
      || action !== 'inspect' && (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof) || candidate !== undefined)
      || action === 'inspect' && (proof !== undefined || json !== undefined || !Buffer.isBuffer(candidate) || !tokenText(candidate.toString('utf8'))
        || !new RegExp('^' + id + '\\|[a-f0-9]{32}$').test(token.toString('utf8')))
      || ['template', 'phones', 'phone_state'].includes(action) && json !== undefined
      || after !== undefined && (action !== 'phones' || typeof after !== 'string' || !/^[A-Za-z0-9_+=/-]{1,2048}$/.test(after))
      || action === 'send' && (json?.messaging_product !== 'whatsapp' || !['text', 'template'].includes(json.type))) fail('invalid_request');
    const body = action === 'send' ? Buffer.from(JSON.stringify(json)) : null;
    if (body?.length > 32768) fail('invalid_request');
    if (signal?.aborted) fail('provider_timeout');
    // Meta's documented debug_token protocol places input_token in the query
    // sent over TLS to Meta. This internal URL must never be logged or returned
    // to callers. Other operations keep their token solely in the bearer header.
    const query = new URLSearchParams(action === 'inspect' ? { input_token: candidate.toString('utf8') } : { appsecret_proof: proof });
    if (action === 'template') query.set('fields', 'id,name,language,status,components');
    if (action === 'phones') { query.set('fields', 'id'); query.set('limit', '100'); if (after !== undefined) query.set('after', after); }
    if (action === 'phone_state') query.set('fields', 'id,is_on_biz_app,platform_type');
    return new Promise((resolve, reject) => {
      let req; let timer; let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      const abort = () => { finish(new BrokerError('provider_timeout')); req?.destroy(); };
      timer = setTimeout(abort, timeoutMs); timer.unref?.();
      try {
        req = request({ protocol: 'https:', hostname: 'graph.facebook.com', port: 443,
          method: action === 'send' ? 'POST' : 'GET', path: `/${GRAPH_VERSION}/${action === 'inspect' ? 'debug_token' : id}${action === 'send' ? '/messages' : action === 'phones' ? '/phone_numbers' : ''}?${query}`,
          agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2', headers: { authorization: 'Bearer ' + token.toString('utf8'),
            accept: 'application/json', 'accept-encoding': 'identity', ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } }, res => {
          const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          if (contentType !== 'application/json' || !['', 'identity'].includes(String(res.headers['content-encoding'] || '').toLowerCase())
            || res.statusCode >= 300 && res.statusCode < 400) { finish(new BrokerError('provider_failed')); res.destroy(); req?.destroy(); return; }
          const chunks = []; let bytes = 0;
          res.on('data', chunk => {
            bytes += chunk.length;
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
              if (res.statusCode !== 200 || value.error) fail('provider_failed');
              finish(null, value);
            } catch (error) { finish(error instanceof BrokerError ? error : new BrokerError('provider_failed')); }
          });
        });
        req.on('error', () => finish(new BrokerError('provider_failed')));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted || settled) abort(); else req.end(body || undefined);
      } catch { finish(new BrokerError('provider_failed')); req?.destroy(); }
    });
  };
}
module.exports = { createWhatsappHttp };

'use strict';

const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { BrokerError, fail } = require('./errors');
const { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } = require('./ai-limits');
const { canonicalBase64, validate } = require('./ai-contract');
const ENDPOINTS = Object.freeze({
  openai: ['api.openai.com', '/v1/responses'],
  gemini: ['generativelanguage.googleapis.com', '/v1beta/interactions'],
  groq: ['api.groq.com', '/openai/v1/audio/transcriptions'],
});
function encodeBody(provider, body) {
  if (provider !== 'groq') return { bytes: Buffer.from(JSON.stringify(body)), contentType: 'application/json' };
  const boundary = `clinicaclick-${randomUUID()}`;
  const file = canonicalBase64(body.fileBase64);
  // Only metadata supplied by the application; no external URLs or arbitrary headers.
  const filename = body.fileName.replace(/["\\]/g, '_');
  const bytes = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${body.model}\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${body.mimeType}\r\n\r\n`),
    file, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  file.fill(0);
  return { bytes, contentType: `multipart/form-data; boundary=${boundary}` };
}
function createAiHttp({ request = https.request } = {}) {
  return async function aiHttp({ provider, payload, token, binding, signal }) {
    validate(provider, payload);
    if (!Buffer.isBuffer(token) || !token.length || token.length > 16384 || /[\r\n]/.test(token.toString('utf8'))) fail('secret_unavailable');
    if (signal?.aborted) fail('provider_timeout');
    const [hostname, path] = ENDPOINTS[provider];
    const { bytes, contentType } = encodeBody(provider, payload.body);
    if (bytes.length > MAX_REQUEST_BYTES) { bytes.fill(0); fail('invalid_request'); }
    try {
      return await new Promise((resolve, reject) => {
        let settled = false, timer, req;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer);
          signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
        const abort = () => { finish(new BrokerError('provider_timeout')); req?.destroy(); };
        const headers = { 'content-type': contentType, 'content-length': bytes.length,
          accept: 'application/json', 'accept-encoding': 'identity',
          ...(provider === 'gemini' ? { 'x-goog-api-key': token.toString('utf8') } : { authorization: `Bearer ${token.toString('utf8')}` }),
          ...(provider === 'openai' && binding.ai.organization ? { 'OpenAI-Organization': binding.ai.organization } : {}),
          ...(provider === 'openai' && binding.ai.project ? { 'OpenAI-Project': binding.ai.project } : {}) };
        req = request({ protocol: 'https:', hostname, port: 443, path, method: 'POST', headers,
          agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, res => {
          const chunks = []; let size = 0;
          if (res.statusCode !== 200) {
            const code = [401, 403].includes(res.statusCode) ? 'provider_unauthorized'
              : res.statusCode === 429 ? 'rate_limited' : 'provider_failed';
            res.destroy(); finish(new BrokerError(code)); return;
          }
          if (!/^application\/json(?:\s*;.*)?$/i.test(res.headers['content-type'] || '')
            || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
            res.destroy(); finish(new BrokerError('provider_failed')); return;
          }
          res.on('data', chunk => { size += chunk.length;
            if (size > MAX_RESPONSE_BYTES - 4096) { res.destroy(); finish(new BrokerError('provider_failed')); } else chunks.push(chunk); });
          res.on('aborted', () => finish(new BrokerError('provider_failed')));
          res.on('error', () => finish(new BrokerError('provider_failed')));
          res.on('end', () => {
            try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!value || typeof value !== 'object' || Array.isArray(value)) fail('provider_failed');
              finish(null, value);
            } catch { finish(new BrokerError('provider_failed')); }
          });
        });
        req.on('error', () => finish(new BrokerError('provider_failed')));
        timer = setTimeout(abort, payload.timeoutMs); timer.unref?.(); signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort(); else req.end(bytes);
      });
    } finally { bytes.fill(0); }
  };
}
module.exports = { createAiHttp };

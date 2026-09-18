'use strict';
const https = require('node:https');
const { schema } = require('./contracts');
const { MODEL_CHECK_OPERATION } = require('./ai-limits');
const { BrokerError, fail } = require('./errors');
const validate = schema({ useCase: { const: 'provider_health' },
  timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
  body: { type: 'object', additionalProperties: false, required: ['model'], properties: {
    model: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' },
  } },
});
function authorize({ request, binding }) {
  if (request.operation !== MODEL_CHECK_OPERATION || request.assetRef !== 'ai:provider_health'
    || binding.provider !== 'ai_groq' || !binding.ai.models.includes(request.payload.body.model)) fail('scope_denied');
}
function createModelHealthHttp({ request = https.request } = {}) {
  return async ({ payload, token, signal }) => {
    validate(payload);
    if (!Buffer.isBuffer(token) || !token.length || token.length > 16384 || /[\r\n]/.test(token.toString('utf8'))) fail('secret_unavailable');
    if (signal?.aborted) fail('provider_timeout');
    return new Promise((resolve, reject) => {
      let req, timer, settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer);
        signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      const abort = () => { finish(new BrokerError('provider_timeout')); req?.destroy(); };
      req = request({ protocol: 'https:', hostname: 'api.groq.com', port: 443,
        path: '/openai/v1/models/' + encodeURIComponent(payload.body.model), method: 'GET', agent: false,
        rejectUnauthorized: true, minVersion: 'TLSv1.2', headers: { authorization: `Bearer ${token.toString('utf8')}`,
          accept: 'application/json', 'accept-encoding': 'identity' } }, res => {
        const chunks = []; let size = 0;
        if (res.statusCode === 404) { res.destroy(); finish(null, { model: payload.body.model, available: false }); return; }
        if (res.statusCode !== 200) {
          const code = [401, 403].includes(res.statusCode) ? 'provider_unauthorized' : res.statusCode === 429 ? 'rate_limited' : 'provider_failed';
          res.destroy(); finish(new BrokerError(code)); return;
        }
        if (!/^application\/json(?:\s*;.*)?$/i.test(res.headers['content-type'] || '')
          || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
          res.destroy(); finish(new BrokerError('provider_failed')); return;
        }
        res.on('data', chunk => { size += chunk.length;
          if (size > 16384) { res.destroy(); finish(new BrokerError('provider_failed')); } else chunks.push(chunk); });
        res.on('error', () => finish(new BrokerError('provider_failed')));
        res.on('aborted', () => finish(new BrokerError('provider_failed')));
        res.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks));
            if (value?.object !== 'model' || value.id !== payload.body.model
              || value.active !== undefined && typeof value.active !== 'boolean') fail('provider_failed');
            finish(null, { model: payload.body.model, available: value.active !== false });
          } catch { finish(new BrokerError('provider_failed')); }
        });
      });
      req.on('error', () => finish(new BrokerError('provider_failed')));
      timer = setTimeout(abort, payload.timeoutMs); timer.unref?.(); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else req.end();
    });
  };
}
function createModelHealthOperation({ http = createModelHealthHttp() } = {}) {
  return { provider: 'ai_groq', persistResult: false, validate, authorize,
    async execute({ payload, secret, signal, assertActive }) { assertActive(); return http({ payload, token: secret, signal }); },
    project: schema({ model: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' }, available: { type: 'boolean' } }),
  };
}
module.exports = { validate, authorize, createModelHealthHttp, createModelHealthOperation };

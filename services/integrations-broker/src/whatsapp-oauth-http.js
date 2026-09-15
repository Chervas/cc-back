'use strict';
// Broker-internal transport, deliberately not registered as a public operation.
// Only the callback borrows the exchanged token; the result is metadata only.
const https = require('node:https');
const { BrokerError, fail } = require('./errors');
const { tokenText } = require('./whatsapp-secrets');
const { GRAPH_VERSION } = require('./whatsapp-contract');
const id = v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v);
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
function metadata(v, appId) {
  const customer = Object.hasOwn(v || {}, 'businessId') || Object.hasOwn(v || {}, 'grantedWabaIds');
  if (!exact(v, ['appId', 'subjectId', 'wabaId', 'phoneId', 'tokenType', 'scopes', 'expiresAt', 'dataAccessExpiresAt',
    ...(customer ? ['businessId','grantedWabaIds'] : [])])
    || v.appId !== appId || ![v.subjectId, v.wabaId, v.phoneId].every(id) || !['USER', 'SYSTEM_USER'].includes(v.tokenType)
    || !Array.isArray(v.scopes) || !v.scopes.length || v.scopes.length > (customer ? 4 : 3) || new Set(v.scopes).size !== v.scopes.length
    || v.scopes.some(s => !['whatsapp_business_messaging', 'whatsapp_business_management', 'public_profile',
      ...(customer ? ['whatsapp_business_manage_events'] : [])].includes(s))
    || !v.scopes.some(s => s !== 'public_profile')
    || ![v.expiresAt, v.dataAccessExpiresAt].every(t => t === null || Number.isSafeInteger(t) && t > 0)) fail('oauth_credentials_incomplete');
  if (customer && (!id(v.businessId) || v.tokenType !== 'SYSTEM_USER'
    || !Array.isArray(v.grantedWabaIds) || !v.grantedWabaIds.length || v.grantedWabaIds.length > 64
    || !v.grantedWabaIds.includes(v.wabaId) || v.grantedWabaIds.some((value, i, all) => !id(value) || i > 0 && value <= all[i - 1]))) fail('oauth_credentials_incomplete');
  return structuredClone(v);
}
function createWhatsappOAuthHttp({ appId, redirectUri, request = https.request, timeoutMs = 8000, now = () => Date.now() }) {
  let redirect;
  try { redirect = new URL(redirectUri); } catch { fail('invalid_request'); }
  if (!id(appId) || typeof redirectUri !== 'string' || redirectUri.length > 2048 || redirect.href !== redirectUri
    || redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.hash || redirect.search || redirect.port
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) fail('invalid_request');
  // redirectUri pins the configured launch page. This transport accepts codes
  // from FB.login only: the JavaScript SDK owns the OAuth return channel, so its
  // code exchange uses the empty redirect URI (Facebook's JS helper contract).
  // Never retry with the launch page, a browser-supplied URI or another flow.
  async function exchange({ code, appSecret, signal }) {
    if (signal?.aborted) fail('provider_timeout');
    const query = new URLSearchParams({ client_id: appId, client_secret: appSecret.toString('ascii'),
      code: code.toString('ascii'), redirect_uri: '' });
    return new Promise((resolve, reject) => {
      let req; let response; let timer; let settled = false; const chunks = []; let bytes = 0;
      const finish = (error, result) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        for (const chunk of chunks) chunk.fill(0); chunks.length = 0;
        error ? reject(error) : resolve(result);
      };
      const abort = () => { finish(new BrokerError('provider_timeout')); response?.destroy(); req?.destroy(); };
      timer = setTimeout(abort, timeoutMs); timer.unref?.();
      try {
        req = request({ protocol: 'https:', hostname: 'graph.facebook.com', port: 443, method: 'GET',
          path: `/${GRAPH_VERSION}/oauth/access_token?${query}`, agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2',
          headers: { accept: 'application/json', 'accept-encoding': 'identity' } }, res => {
          response = res;
          if (settled) { res.destroy(); return; }
          if (res.statusCode !== 200 || String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json'
            || !['', 'identity'].includes(String(res.headers['content-encoding'] || '').toLowerCase())) {
            finish(new BrokerError('provider_failed')); res.destroy(); req?.destroy(); return;
          }
          res.on('data', chunk => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > 32768) { finish(new BrokerError('provider_failed')); res.destroy(); req?.destroy(); }
            else chunks.push(Buffer.from(chunk));
          });
          res.on('aborted', () => finish(new BrokerError('provider_failed')));
          res.on('error', () => finish(new BrokerError('provider_failed')));
          res.on('end', () => {
            if (settled) return;
            let raw; let value;
            try {
              raw = Buffer.concat(chunks); value = JSON.parse(raw.toString('utf8'));
              if (!value || typeof value !== 'object' || Array.isArray(value) || value.error
                // Embedded Signup can omit this OAuth hint. Identity, validity,
                // exact grants and expiry still require independent inspection.
                || !tokenText(value.access_token) || value.token_type !== undefined && (typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer')
                || value.expires_in !== undefined && (!Number.isSafeInteger(value.expires_in) || value.expires_in < 1
                  || value.expires_in > Math.floor((Number.MAX_SAFE_INTEGER - now()) / 1000))) fail('oauth_credentials_incomplete');
              const token = Buffer.from(value.access_token); const expiresAt = value.expires_in === undefined ? null : now() + value.expires_in * 1000;
              delete value.access_token; finish(null, { token, expiresAt });
            } catch { finish(new BrokerError('oauth_credentials_incomplete')); }
            finally { raw?.fill(0); if (value && typeof value === 'object') delete value.access_token; }
          });
        });
        req.on('error', () => finish(new BrokerError('provider_failed')));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted || settled) abort(); else req.end();
      } catch { finish(new BrokerError('provider_failed')); response?.destroy(); req?.destroy(); }
    });
  }
  return {
    async withExchangedToken(input, work) {
      if (!exact(input, Object.hasOwn(input || {}, 'signal') ? ['code', 'appSecret', 'signal'] : ['code', 'appSecret'])
        || !Buffer.isBuffer(input.code) || !/^[\x21-\x7e]{1,4096}$/.test(input.code.toString('latin1'))
        || !Buffer.isBuffer(input.appSecret) || !/^[a-f0-9]{32}$/.test(input.appSecret.toString('latin1'))
        || input.signal !== undefined && !(input.signal instanceof AbortSignal) || typeof work !== 'function') fail('invalid_request');
      // Copy caller buffers before the first await. Erase only our own copies.
      const code = Buffer.from(input.code); const appSecret = Buffer.from(input.appSecret);
      const signal = AbortSignal.any([AbortSignal.timeout(25000), ...(input.signal ? [input.signal] : [])]);
      let borrowed; let callbackToken; let abortWork;
      try {
        borrowed = await exchange({ code, appSecret, signal });
        if (signal?.aborted) fail('provider_timeout');
        callbackToken = Buffer.from(borrowed.token);
        const result = metadata(await Promise.race([
          Promise.resolve().then(() => { if (signal.aborted) fail('provider_timeout'); return work(callbackToken, { expiresAt: borrowed.expiresAt, signal }); }),
          new Promise((resolve, reject) => { abortWork = () => reject(new BrokerError('provider_timeout')); signal.addEventListener('abort', abortWork, { once: true }); if (signal.aborted) abortWork(); }),
        ]), appId);
        if (signal?.aborted) fail('provider_timeout');
        if (borrowed.expiresAt !== null && (borrowed.expiresAt <= now() || result.expiresAt === null || result.expiresAt > borrowed.expiresAt)) fail('credential_revoked');
        if ([result.expiresAt, result.dataAccessExpiresAt].some(t => t !== null && t <= now())) fail('credential_revoked');
        const serialized = JSON.stringify(result);
        if ([code, appSecret, borrowed.token].some(b => serialized.includes(b.toString('utf8')))) fail('provider_failed');
        return result;
      } catch (error) { throw new BrokerError(error instanceof BrokerError ? new BrokerError(error.code).code : 'provider_failed'); }
      finally { if (abortWork) signal.removeEventListener('abort', abortWork); code.fill(0); appSecret.fill(0); borrowed?.token.fill(0); callbackToken?.fill(0); }
    },
  };
}
module.exports = { createWhatsappOAuthHttp };

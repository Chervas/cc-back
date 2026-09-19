'use strict';
const https = require('node:https');
const { BrokerError, fail } = require('./errors'), { tokenText } = require('./whatsapp-secrets');
const C = require('./meta-marketing-oauth-contract'), M = require('./meta-marketing-contract');
function createMetaMarketingOAuthHttp({ request = https.request, timeoutMs = 8000, now = () => Date.now() } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) fail('invalid_request');
  const inspect = require('./meta-marketing-http').createMetaMarketingHttp({ request, timeoutMs });
  async function exchange(params, signal) {
    if (signal.aborted) fail('provider_timeout');
    return new Promise((resolve, reject) => {
      let req, response, timer, settled = false, bytes = 0; const chunks = [];
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        for (const chunk of chunks) chunk.fill(0); chunks.length = 0; error ? reject(error) : resolve(value);
      };
      const abort = () => { finish(new BrokerError('provider_timeout')); response?.destroy(); req?.destroy(); };
      timer = setTimeout(abort, timeoutMs); timer.unref?.();
      try {
        req = request({ protocol: 'https:', hostname: 'graph.facebook.com', port: 443, method: 'GET',
          path: `/${M.GRAPH_VERSION}/oauth/access_token?${new URLSearchParams(params)}`, agent: false,
          rejectUnauthorized: true, minVersion: 'TLSv1.2', headers: { accept: 'application/json', 'accept-encoding': 'identity' } }, res => {
          response = res;
          if (settled) { res.destroy(); return; }
          if (res.statusCode !== 200 || String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json'
            || !['', 'identity'].includes(String(res.headers['content-encoding'] || '').toLowerCase())) {
            finish(new BrokerError(res.statusCode === 429 ? 'rate_limited' : 'provider_failed')); res.destroy(); req?.destroy(); return;
          }
          res.on('data', chunk => { bytes += chunk.length;
            if (bytes > 32768) { finish(new BrokerError('provider_failed')); chunk.fill(0); res.destroy(); req?.destroy(); }
            else if (!settled) chunks.push(chunk);
          });
          res.on('aborted', () => finish(new BrokerError('provider_failed'))); res.on('error', () => finish(new BrokerError('provider_failed')));
          res.on('end', () => {
            if (settled) return; let raw;
            try {
              raw = Buffer.concat(chunks); const value = JSON.parse(raw.toString('utf8'));
              if (!value || value.error || !tokenText(value.access_token) || value.token_type !== undefined && value.token_type.toLowerCase?.() !== 'bearer') fail('oauth_credentials_incomplete');
              const expiries = [value.expires_in, value.expires].filter(v => v !== undefined);
              if (expiries.some(v => !Number.isSafeInteger(v) || v <= 0 || v > 366 * 86400)) fail('oauth_credentials_incomplete');
              finish(null, { token: Buffer.from(value.access_token), expiresAt: expiries.length ? now() + Math.min(...expiries) * 1000 : null });
              delete value.access_token;
            } catch (e) { finish(new BrokerError(e instanceof BrokerError ? e.code : 'provider_failed')); }
            finally { raw?.fill(0); }
          });
        });
        req.on('error', () => finish(new BrokerError('provider_failed'))); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted || settled) abort(); else req.end();
      } catch { finish(new BrokerError('provider_failed')); req?.destroy(); }
    });
  }
  return {
    async withExchangedToken({ binding, code, appSecret, signal: callerSignal }, work) {
      const b = C.bindingFor(binding);
      if (!Buffer.isBuffer(code) || !/^[\x21-\x7e]{1,4096}$/.test(code.toString('latin1'))
        || !Buffer.isBuffer(appSecret) || !/^[a-f0-9]{32}$/.test(appSecret.toString('latin1'))
        || callerSignal !== undefined && !(callerSignal instanceof AbortSignal) || typeof work !== 'function') fail('invalid_request');
      const ownCode = Buffer.from(code), ownApp = Buffer.from(appSecret);
      const signal = AbortSignal.any([AbortSignal.timeout(25000), ...(callerSignal ? [callerSignal] : [])]);
      let short, long, applicationToken, borrowed, abortWork;
      const wipe = () => { ownCode.fill(0); ownApp.fill(0); short?.token.fill(0); long?.token.fill(0); applicationToken?.fill(0); borrowed?.fill(0); };
      signal.addEventListener('abort', wipe, { once: true });
      try {
        short = await exchange({ client_id: b.appId, client_secret: ownApp.toString('ascii'), redirect_uri: b.redirectUri, code: ownCode.toString('ascii') }, signal);
        if (signal.aborted) fail('provider_timeout');
        long = await exchange({ client_id: b.appId, client_secret: ownApp.toString('ascii'), grant_type: 'fb_exchange_token', fb_exchange_token: short.token.toString('utf8') }, signal);
        if (signal.aborted) fail('provider_timeout');
        applicationToken = Buffer.concat([Buffer.from(b.appId + '|'), ownApp]);
        let inspected;
        try { inspected = await inspect({ action: 'inspect', id: b.appId, token: applicationToken, candidate: long.token, signal }); }
        catch (error) { if (error?.code === 'credential_revoked') fail('secret_unavailable'); throw error; }
        if (signal.aborted) fail('provider_timeout');
        const metadata = C.inspected(inspected, binding, now());
        if (long.expiresAt !== null) metadata.expiresAt = Math.min(metadata.expiresAt ?? long.expiresAt, long.expiresAt);
        const assertFresh = () => { if (signal.aborted) fail('provider_timeout');
          if ([metadata.expiresAt, metadata.dataAccessExpiresAt].some(v => v !== null && v <= now())) fail('credential_revoked'); };
        assertFresh(); borrowed = Buffer.from(long.token);
        const result = await Promise.race([Promise.resolve().then(() => { assertFresh(); return work(borrowed, metadata, signal); }),
          new Promise((resolve, reject) => { abortWork = () => reject(new BrokerError('provider_timeout')); signal.addEventListener('abort', abortWork, { once: true }); if (signal.aborted) abortWork(); })]);
        assertFresh(); const encoded = JSON.stringify(result);
        if (typeof encoded !== 'string' || [ownCode, ownApp, short.token, long.token].some(v => encoded.includes(v.toString('utf8')))) fail('provider_failed');
        return result;
      } catch (e) { throw new BrokerError(e instanceof BrokerError ? new BrokerError(e.code).code : 'provider_failed'); }
      finally { if (abortWork) signal.removeEventListener('abort', abortWork); signal.removeEventListener('abort', wipe); wipe(); }
    },
  };
}
module.exports = { createMetaMarketingOAuthHttp };

'use strict';
const https = require('node:https');
const { BrokerError, fail } = require('./errors');
const HOSTS = new Set(['mybusiness.googleapis.com', 'businessprofileperformance.googleapis.com',
  'mybusinessbusinessinformation.googleapis.com', 'mybusinessverifications.googleapis.com', 'mybusinessaccountmanagement.googleapis.com']);
// This transport is private to reviewed operations. It never accepts consumer headers or URLs.
function createGoogleHttp({ request = https.request, timeoutMs = 8000 } = {}) {
  return async function googleHttp({ hostname, path, token, form, json, signal, developerToken, loginCustomerId }) {
    const oauth = hostname === 'oauth2.googleapis.com' && path === '/token';
    const userinfo = hostname === 'www.googleapis.com' && path === '/oauth2/v2/userinfo';
    const searchConsole = hostname === 'searchconsole.googleapis.com' && path === '/v1/urlInspection/index:inspect'
      || hostname === 'www.googleapis.com' && /^\/webmasters\/v3\/sites\/[^/?#]+\/searchAnalytics\/query$/.test(path);
    const analytics = hostname === 'analyticsdata.googleapis.com' && /^\/v1beta\/properties\/[1-9]\d{0,19}:runReport$/.test(path);
    const discovery = hostname === 'analyticsadmin.googleapis.com' && /^\/v1beta\/properties\/[1-9]\d{0,19}$/.test(path)
      || hostname === 'www.googleapis.com' && /^\/webmasters\/v3\/sites\/[^/?#]+$/.test(path);
    const ads = hostname === 'googleads.googleapis.com' && /^\/v24\/customers\/[0-9]{10}\/googleAds:search$/.test(path);
    const jsonRead = searchConsole || analytics || ads;
    if (ads ? !Buffer.isBuffer(developerToken) || !/^[A-Za-z0-9_-]{16,256}$/.test(developerToken.toString('utf8'))
      || loginCustomerId !== null && (typeof loginCustomerId !== 'string' || !/^[0-9]{10}$/.test(loginCustomerId))
      : developerToken !== undefined || loginCustomerId !== undefined) fail('invalid_request');
    if (!(oauth || userinfo || jsonRead || discovery || HOSTS.has(hostname)) || typeof path !== 'string' || !/^\/v[14]\//.test(path) && !oauth && !userinfo && !jsonRead && !discovery
      || path.length > 16384 || /[\r\n#]/.test(path) || signal?.aborted) fail('invalid_request');
    if (oauth ? !form || typeof form !== 'string' || form.length > 32768 || token !== undefined
      : !Buffer.isBuffer(token) || !token.length || token.length > 16384 || /[\r\n]/.test(token.toString('utf8')) || form !== undefined) fail('invalid_request');
    if (jsonRead ? !json || Object.getPrototypeOf(json) !== Object.prototype : json !== undefined) fail('invalid_request');
    const body = jsonRead ? JSON.stringify(json) : form;
    if (jsonRead && Buffer.byteLength(body) > 32768) fail('invalid_request');
    return new Promise((resolve, reject) => {
      let settled = false; let timer; let req;
      const abort = () => { finish(new BrokerError('provider_timeout')); req?.destroy(); };
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      req = request({ protocol: 'https:', hostname, port: 443, path, method: oauth || jsonRead ? 'POST' : 'GET',
        agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2',
        headers: { accept: 'application/json', 'accept-encoding': 'identity',
          ...(oauth ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) } : { authorization: `Bearer ${token.toString('utf8')}` }),
          ...(jsonRead ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
          ...(ads ? { 'developer-token': developerToken.toString('utf8'), ...(loginCustomerId ? { 'login-customer-id': loginCustomerId } : {}) } : {}) } }, res => {
        const chunks = []; let size = 0; const limit = oauth || userinfo ? 32768 : ads ? 16 * 1024 * 1024 : 2097152;
        if (res.statusCode >= 300 && res.statusCode < 400 || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity'
          || !/^application\/json(?:\s*;.*)?$/i.test(res.headers['content-type'] || '')) {
          res.destroy(); finish(new BrokerError('provider_failed')); return;
        }
        res.on('data', chunk => { size += chunk.length; if (size > limit) { res.destroy(); finish(new BrokerError('provider_failed')); } else chunks.push(chunk); });
        res.on('aborted', () => finish(new BrokerError('provider_failed')));
        res.on('error', () => finish(new BrokerError('provider_failed')));
        res.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value)) fail('provider_failed');
            if (oauth && res.statusCode === 400 && value.error === 'invalid_grant') fail('credential_revoked');
            if ([401, 403].includes(res.statusCode)) fail('provider_unauthorized');
            if (res.statusCode !== 200) fail('provider_failed');
            finish(null, value);
          } catch (error) { finish(error instanceof BrokerError ? error : new BrokerError('provider_failed')); }
        });
      });
      req.on('error', () => finish(new BrokerError('provider_failed')));
      timer = setTimeout(abort, timeoutMs); timer.unref?.(); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else req.end(body);
    });
  };
}
module.exports = { createGoogleHttp };

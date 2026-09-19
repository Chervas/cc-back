'use strict';
const https = require('node:https');
const { BrokerError, fail } = require('./errors');
const HOSTS = new Set(['mybusiness.googleapis.com', 'businessprofileperformance.googleapis.com',
  'mybusinessbusinessinformation.googleapis.com', 'mybusinessverifications.googleapis.com', 'mybusinessaccountmanagement.googleapis.com']);
// This transport is private to reviewed operations. It never accepts consumer headers or URLs.
function createGoogleHttp({ request = https.request, timeoutMs = 8000, dataManagerEnabled = false, actionManagementEnabled = false, businessProfileWritesEnabled = false } = {}) {
  return async function googleHttp({ hostname, path, token, form, json, signal, developerToken, loginCustomerId, quotaProjectId, businessProfileMutation }) {
    // A private operation selector, never a consumer-controlled HTTP method.
    const gbpMethods = { replyUpdate: 'PUT', replyDelete: 'DELETE', photo: 'POST', hours: 'PATCH' };
    const gbpWrite = businessProfileMutation !== undefined;
    if (gbpWrite && (businessProfileWritesEnabled !== true || !Object.hasOwn(gbpMethods, businessProfileMutation)
      || typeof path !== 'string'
      || (businessProfileMutation === 'hours'
        ? hostname !== 'mybusinessbusinessinformation.googleapis.com' || !/^\/v1\/locations\/[1-9]\d{0,29}\?updateMask=specialHours$/.test(path)
        : hostname !== 'mybusiness.googleapis.com' || !(businessProfileMutation === 'photo'
          ? /^\/v4\/accounts\/[1-9]\d{0,29}\/locations\/[1-9]\d{0,29}\/media$/
          : /^\/v4\/accounts\/[1-9]\d{0,29}\/locations\/[1-9]\d{0,29}\/reviews\/[A-Za-z0-9_-]{1,256}\/reply$/).test(path)))) fail('invalid_request');
    const oauth = hostname === 'oauth2.googleapis.com' && path === '/token';
    const userinfo = hostname === 'www.googleapis.com' && path === '/oauth2/v2/userinfo';
    const searchConsole = hostname === 'searchconsole.googleapis.com' && path === '/v1/urlInspection/index:inspect'
      || hostname === 'www.googleapis.com' && /^\/webmasters\/v3\/sites\/[^/?#]+\/searchAnalytics\/query$/.test(path);
    const analytics = hostname === 'analyticsdata.googleapis.com' && /^\/v1beta\/properties\/[1-9]\d{0,19}:runReport$/.test(path);
    const discovery = hostname === 'analyticsadmin.googleapis.com' && /^\/v1beta\/properties\/[1-9]\d{0,19}$/.test(path)
      || hostname === 'www.googleapis.com' && /^\/webmasters\/v3\/sites\/[^/?#]+$/.test(path);
    const adsWrite = actionManagementEnabled === true && hostname === 'googleads.googleapis.com'
      && /^\/v24\/customers\/[0-9]{10}\/conversionActions:mutate$/.test(path);
    const ads = adsWrite || hostname === 'googleads.googleapis.com' && /^\/v24\/customers\/[0-9]{10}\/googleAds:search$/.test(path);
    const dmWrite = dataManagerEnabled === true && hostname === 'datamanager.googleapis.com' && path === '/v1/events:ingest';
    let dmStatus = false;
    if (dataManagerEnabled === true && hostname === 'datamanager.googleapis.com' && typeof path === 'string'
      && path.startsWith('/v1/requestStatus:retrieve?requestId=')) {
      const value = new URL('https://datamanager.googleapis.com' + path).searchParams.get('requestId');
      dmStatus = require('./google-data-manager-contract').providerId(value)
        && path === '/v1/requestStatus:retrieve?requestId=' + encodeURIComponent(value);
    }
    const dm = dmWrite || dmStatus;
    if (dm ? typeof quotaProjectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(quotaProjectId)
      : quotaProjectId !== undefined) fail('invalid_request');
    const jsonRead = searchConsole || analytics || ads || dmWrite;
    const jsonBody = jsonRead || gbpWrite && businessProfileMutation !== 'replyDelete';
    if (ads ? !Buffer.isBuffer(developerToken) || !/^[A-Za-z0-9_-]{16,256}$/.test(developerToken.toString('utf8'))
      || loginCustomerId !== null && (typeof loginCustomerId !== 'string' || !/^[0-9]{10}$/.test(loginCustomerId))
      : developerToken !== undefined || loginCustomerId !== undefined) fail('invalid_request');
    if (!(oauth || userinfo || jsonRead || discovery || dmStatus || HOSTS.has(hostname)) || typeof path !== 'string' || !/^\/v[14]\//.test(path) && !oauth && !userinfo && !jsonRead && !discovery
      || path.length > 16384 || /[\r\n#]/.test(path) || signal?.aborted) fail('invalid_request');
    if (oauth ? !form || typeof form !== 'string' || form.length > 32768 || token !== undefined
      : !Buffer.isBuffer(token) || !token.length || token.length > 16384 || /[\r\n]/.test(token.toString('utf8')) || form !== undefined) fail('invalid_request');
    if (jsonBody ? !json || Object.getPrototypeOf(json) !== Object.prototype : json !== undefined) fail('invalid_request');
    if (gbpWrite && jsonBody) {
      const keys = Object.keys(json).sort().join(',');
      if (businessProfileMutation === 'replyUpdate' && (keys !== 'comment' || typeof json.comment !== 'string' || !json.comment.trim() || json.comment.length > 4096)
        || businessProfileMutation === 'photo' && (!['locationAssociation,mediaFormat,sourceUrl', 'description,locationAssociation,mediaFormat,sourceUrl'].includes(keys)
          || json.mediaFormat !== 'PHOTO' || Object.keys(json.locationAssociation || {}).join(',') !== 'category'
          || !require('./google-business-profile-write-contract').CATEGORIES.includes(json.locationAssociation.category))
        || businessProfileMutation === 'hours' && (keys !== 'name,specialHours' || json.name !== path.slice(4).split('?')[0]
          || Object.keys(json.specialHours || {}).join(',') !== 'specialHourPeriods'
          || !Array.isArray(json.specialHours.specialHourPeriods) || json.specialHours.specialHourPeriods.length > 730)) fail('invalid_request');
    }
    const body = jsonBody ? JSON.stringify(json) : form;
    if (jsonBody && Buffer.byteLength(body) > (gbpWrite && businessProfileMutation === 'hours' ? 196608 : 32768)) fail('invalid_request');
    return new Promise((resolve, reject) => {
      let settled = false; let timer; let req;
      const abort = () => { finish(new BrokerError('provider_timeout')); req?.destroy(); };
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      req = request({ protocol: 'https:', hostname, port: 443, path, method: gbpWrite ? gbpMethods[businessProfileMutation] : oauth || jsonRead ? 'POST' : 'GET',
        agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2',
        headers: { accept: 'application/json', 'accept-encoding': 'identity',
          ...(oauth ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) } : { authorization: `Bearer ${token.toString('utf8')}` }),
          ...(jsonBody ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
          ...(dm ? { 'x-goog-user-project': quotaProjectId } : {}),
          ...(ads ? { 'developer-token': developerToken.toString('utf8'), ...(loginCustomerId ? { 'login-customer-id': loginCustomerId } : {}) } : {}) } }, res => {
        const chunks = []; let size = 0; const limit = oauth || userinfo ? 32768 : gbpWrite ? 196608 : dm || adsWrite ? 131072 : ads ? 16 * 1024 * 1024 : 2097152;
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

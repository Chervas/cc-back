'use strict';
// Private candidate only. No dispatcher, policy grant, storage or resource map.
const C = require('./google-oauth-contract');
const { token, subject } = require('./google-oauth-secrets');
const { BrokerError, fail } = require('./errors');
const SERVICES = Object.freeze(['business_profile', 'search_console', 'analytics', 'ads']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const safeCodes = new Set(['invalid_request', 'oauth_credentials_incomplete', 'oauth_flow_interrupted',
  'provider_failed', 'provider_timeout', 'provider_unauthorized', 'credential_revoked', 'secret_unavailable']);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const safe = error => new BrokerError(error instanceof BrokerError && safeCodes.has(error.code) ? error.code : 'provider_failed');
function requiredScopesFor(service) {
  if (!SERVICES.includes(service)) fail('invalid_request');
  return Object.freeze([...C.SCOPES.slice(0, 3), C.PROVIDERS['google_' + service].scope].sort());
}
function redirect(value) {
  try {
    const uri = new URL(value);
    if (typeof value !== 'string' || value.length > 512 || uri.protocol !== 'https:' || uri.username || uri.password
      || uri.search || uri.hash || uri.port || uri.pathname !== '/oauth/google/callback' || uri.href !== value) fail('invalid_request');
  } catch { fail('invalid_request'); }
}
function privateBytes(value, max = 16384) {
  return Buffer.isBuffer(value) && value.length > 0 && value.length <= max && token(value.toString('utf8'));
}
function createFirstGoogleProvider({ http, now = Date.now } = {}) {
  if (typeof http !== 'function' || typeof now !== 'function') fail('invalid_request');
  const contexts = new WeakMap(), candidates = new WeakMap();
  const clock = () => { const value = now();if (!Number.isSafeInteger(value) || value <= 0) fail('invalid_request');return value; };
  const check = (value, signal) => {
    if (signal?.aborted) fail('provider_timeout');
    if (value.expiresAt <= clock()) fail('oauth_flow_interrupted');
  };
  function prepareContext(attempt, application) {
    if (!exact(attempt, 'attemptId,bindingDigest,service,expiresAt') || !UUID.test(attempt.attemptId)
      || !HASH.test(attempt.bindingDigest) || !Number.isSafeInteger(attempt.expiresAt)
      || attempt.expiresAt <= clock() || attempt.expiresAt > clock() + 600000
      || !exact(application, 'clientId,clientSecret,redirectUri,verifier')
      || !token(application.clientId) || application.clientId.length > 1024
      || !privateBytes(application.clientSecret) || !Buffer.isBuffer(application.verifier)
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(application.verifier.toString('utf8'))) fail('invalid_request');
    redirect(application.redirectUri);
    const scopes = requiredScopesFor(attempt.service), handle = Object.freeze({});
    contexts.set(handle, { ...attempt, scopes, clientId: application.clientId, redirectUri: application.redirectUri,
      clientSecret: Buffer.from(application.clientSecret), verifier: Buffer.from(application.verifier) });
    return handle;
  }
  async function exchange(handle, input) {
    const context = contexts.get(handle);
    if (!context) fail('oauth_flow_interrupted');
    // A failed/uncertain exchange consumes this process-local capability too.
    // Durable one-use admission must be committed by the Owner before calling.
    contexts.delete(handle);
    let access, refresh, code;
    try {
      if (!(exact(input, 'code') || exact(input, 'code,signal')) || !privateBytes(input.code, 4096)
        || input.signal !== undefined && !(input.signal instanceof AbortSignal)) fail('invalid_request');
      const signal = input.signal;
      check(context, signal);const exchangeStartedAt = clock();code = Buffer.from(input.code);
      const form = new URLSearchParams({ grant_type: 'authorization_code', code: code.toString('utf8'), client_id: context.clientId,
        client_secret: context.clientSecret.toString('utf8'), redirect_uri: context.redirectUri, code_verifier: context.verifier.toString('utf8') }).toString();
      const response = await http({ hostname: 'oauth2.googleapis.com', path: '/token', form, signal });
      check(context, signal);
      if (!response || Object.getPrototypeOf(response) !== Object.prototype || !token(response.access_token)
        || typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer'
        || !Number.isInteger(response.expires_in) || response.expires_in < 120 || response.expires_in > 86400
        || typeof response.scope !== 'string' || response.scope.length > 8192 || /[\r\n\t]/.test(response.scope)
        || !token(response.refresh_token)) fail('oauth_credentials_incomplete');
      const scopes = C.normalizeScopes(response.scope.split(' ').filter(Boolean));
      if (JSON.stringify(scopes) !== JSON.stringify(context.scopes)) fail('oauth_credentials_incomplete');
      const observedAt = clock(), accessExpiresAt = exchangeStartedAt + response.expires_in * 1000;
      if (!Number.isSafeInteger(accessExpiresAt)) fail('oauth_credentials_incomplete');
      let refreshTokenExpiresAt = null;
      if (Object.hasOwn(response, 'refresh_token_expires_in')) {
        if (!Number.isSafeInteger(response.refresh_token_expires_in) || response.refresh_token_expires_in <= 0
          || !Number.isSafeInteger(exchangeStartedAt + response.refresh_token_expires_in * 1000)) fail('oauth_credentials_incomplete');
        refreshTokenExpiresAt = exchangeStartedAt + response.refresh_token_expires_in * 1000;
      }
      if (accessExpiresAt <= clock()) fail('oauth_credentials_incomplete');
      access = Buffer.from(response.access_token);
      const identity = await http({ hostname: 'www.googleapis.com', path: '/oauth2/v2/userinfo', token: access, signal });
      check(context, signal);
      if (!identity || Object.getPrototypeOf(identity) !== Object.prototype || !subject(identity.id)) fail('oauth_credentials_incomplete');
      const candidateExpiresAt = Math.min(context.expiresAt, accessExpiresAt, refreshTokenExpiresAt ?? Infinity);
      if (candidateExpiresAt <= clock()) fail('oauth_credentials_incomplete');
      refresh = Buffer.from(response.refresh_token);
      const candidate = Object.freeze({});
      candidates.set(candidate, { expiresAt: candidateExpiresAt, refresh,
        metadata: Object.freeze({ version: 1, attemptId: context.attemptId, bindingDigest: context.bindingDigest,
          service: context.service, provider: 'google_' + context.service, googleUserId: identity.id, clientId: context.clientId,
          scopes, observedAt, accessExpiresAt, refreshTokenExpiresAt, connected: false, authorizationConfirmed: false }) });
      refresh = null;
      return candidate;
    } catch (error) { throw safe(error); }
    finally { access?.fill(0);refresh?.fill(0);code?.fill(0);context.clientSecret.fill(0);context.verifier.fill(0); }
  }
  function describe(handle) {
    const candidate = candidates.get(handle);
    if (!candidate) fail('oauth_flow_interrupted');
    if (candidate.expiresAt <= clock()) { discard(handle);fail('oauth_flow_interrupted'); }
    return structuredClone(candidate.metadata);
  }
  async function consume(handle, writer) {
    const metadata = describe(handle), candidate = candidates.get(handle);
    if (typeof writer !== 'function') fail('invalid_request');
    candidates.delete(handle);
    try {
      // Only a private Owner writer receives the buffer; its return value never
      // crosses this interface. No resource selection is implied by identity.
      await writer(Object.freeze({ metadata, refreshToken: candidate.refresh }));
    } catch { throw new BrokerError('secret_unavailable'); }
    finally { candidate.refresh.fill(0); }
  }
  function discard(handle) {
    const context = contexts.get(handle), candidate = candidates.get(handle);
    context?.clientSecret.fill(0);context?.verifier.fill(0);candidate?.refresh.fill(0);
    contexts.delete(handle);candidates.delete(handle);
  }
  return Object.freeze({ prepareContext, exchange, describe, consume, discard });
}
module.exports = { createFirstGoogleProvider, requiredScopesFor, SERVICES };

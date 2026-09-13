'use strict';
const { fail, BrokerError } = require('./errors');
const { PROVIDER } = require('./google-business-profile-contract');
const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const text = value => typeof value === 'string' && /^[\x21-\x7e]{1,16384}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
function containsSecret(value, secrets) {
  if (typeof value === 'string') return secrets.some(secret => secret && value.includes(secret));
  return value && typeof value === 'object' && Object.entries(value).some(([key, child]) => containsSecret(key, secrets) || containsSecret(child, secrets));
}
// Refresh is confined to this broker. No OAuth authorization flow, secret writes,
// provider revocation endpoint, environment credentials or clinical database.
function createGoogleSecretStore({ client, http, accountId, prefix, kmsKeyArn, now = () => Date.now(), maxEntries = 64, provider = PROVIDER }) {
  const sc = require('./google-search-console-contract');
  if (![PROVIDER, sc.PROVIDER].includes(provider)) fail('invalid_request');
  const scopes = provider === sc.PROVIDER ? sc.SCOPES : [SCOPE];
  const { DescribeSecretCommand, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  if (!/^\d{12}$/.test(accountId) || !/^\/clinicaclick\/integrations\/(dev|staging|prod)\/$/.test(prefix)
    || !new RegExp(`^arn:aws:kms:eu-west-3:${accountId}:key/[a-f0-9-]+$`).test(kmsKeyArn)
    || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 128) fail('invalid_request');
  const arnPrefix = `arn:aws:secretsmanager:eu-west-3:${accountId}:secret:${prefix}`;
  const entries = new Map(); const flights = new Map();
  async function read(arn, signal) {
    try {
      if (typeof arn !== 'string' || !arn.startsWith(arnPrefix) || arn.length > 2048
        || !/^[A-Za-z0-9/_+=.@-]+$/.test(arn.slice(arnPrefix.length))) fail('secret_unavailable');
      const metadata = await client.send(new DescribeSecretCommand({ SecretId: arn }), { abortSignal: signal });
      if (metadata.ARN !== arn || metadata.KmsKeyId !== kmsKeyArn || metadata.DeletedDate) fail('secret_unavailable');
      const result = await client.send(new GetSecretValueCommand({ SecretId: arn, VersionStage: 'AWSCURRENT' }), { abortSignal: signal });
      if (result.ARN !== arn || !result.VersionId || !result.VersionStages?.includes('AWSCURRENT')
        || typeof result.SecretString !== 'string' || Buffer.byteLength(result.SecretString) > 32768) fail('secret_unavailable');
      return { version: result.VersionId, value: JSON.parse(result.SecretString) };
    } catch { fail('secret_unavailable'); }
  }
  function invalidate(ref) {
    const entry = entries.get(ref); entry?.token.fill(0); entries.delete(ref);
    const flight = flights.get(ref); if (flight) { flight.controller.abort(); flights.delete(ref); }
  }
  async function refresh(binding, connection, app, fingerprint, onRevoked) {
    const ref = binding.connectionRef;
    if (flights.has(ref) && flights.get(ref).fingerprint === fingerprint) return flights.get(ref).promise;
    if (flights.has(ref)) invalidate(ref);
    if (flights.size >= maxEntries) fail('rate_limited');
    const flight = { fingerprint, controller: new AbortController() }; flights.set(ref, flight);
    flight.promise = (async () => {
      let token;
      try {
        const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: connection.refreshToken,
          client_id: app.clientId, client_secret: app.clientSecret }).toString();
        const result = await http({ hostname: 'oauth2.googleapis.com', path: '/token', form, signal: flight.controller.signal });
        if (!text(result.access_token) || result.token_type?.toLowerCase() !== 'bearer'
          || !Number.isSafeInteger(result.expires_in) || result.expires_in < 120 || result.expires_in > 86400
          || result.scope !== undefined && (typeof result.scope !== 'string' || !scopes.some(scope => result.scope.split(' ').includes(scope)))) fail('secret_unavailable');
        if (flight.controller.signal.aborted || flights.get(ref) !== flight) fail('connection_blocked');
        token = Buffer.from(result.access_token);
        if (entries.size >= maxEntries && !entries.has(ref)) invalidate(entries.keys().next().value);
        entries.get(ref)?.token.fill(0);
        const entry = { fingerprint, token, expiresAt: now() + (Math.min(result.expires_in, 3600) - 60) * 1000 };
        entries.set(ref, entry); return entry;
      } catch (error) {
        token?.fill(0);
        if (error instanceof BrokerError && error.code === 'credential_revoked') onRevoked?.();
        throw error instanceof BrokerError ? error : new BrokerError('secret_unavailable');
      }
      finally { if (flights.get(ref) === flight) flights.delete(ref); }
    })();
    return flight.promise;
  }
  return {
    invalidate,
    close() { for (const ref of new Set([...entries.keys(), ...flights.keys()])) invalidate(ref); },
    async withSecret(binding, work, { signal, onRevoked } = {}) {
      if (binding.provider !== provider || signal?.aborted) fail('secret_unavailable');
      // Metadata/version is rechecked even while an access token is cached.
      const connection = await read(binding.secretArn, signal); const app = await read(binding.clientSecretArn, signal);
      if (signal?.aborted) fail('connection_blocked');
      const c = connection.value; const a = app.value;
      const v2 = provider === PROVIDER && c.version === 2 && exact(c, 'version,provider,connectionRef,refreshToken,scopes');
      const v3 = c.version === 3 && exact(c, 'version,provider,connectionRef,googleUserId,clientId,refreshToken,scopes')
        && require('./google-oauth-secrets').subject(c.googleUserId) && c.clientId === a.clientId
        && (!binding.oauth || c.googleUserId === binding.oauth.subject)
        && (provider !== sc.PROVIDER || c.googleUserId === binding.googleSubject);
      if (!(v2 || v3) || c.provider !== provider
        || c.connectionRef !== binding.connectionRef || !text(c.refreshToken) || !Array.isArray(c.scopes)
        || c.scopes.length > 100 || !c.scopes.every(v => typeof v === 'string' && v.length < 256) || !scopes.some(scope => c.scopes.includes(scope))
        || !exact(a, 'version,provider,clientId,clientSecret') || a.version !== 1 || a.provider !== 'google-oauth-client'
        || !text(a.clientId) || !text(a.clientSecret)) fail('secret_unavailable');
      const fingerprint = JSON.stringify([binding.secretArn, connection.version, binding.clientSecretArn, app.version]);
      let entry = entries.get(binding.connectionRef);
      if (!entry || entry.fingerprint !== fingerprint || entry.expiresAt <= now()) {
        if (entry) invalidate(binding.connectionRef);
        entry = await refresh(binding, c, a, fingerprint, onRevoked);
      }
      if (signal?.aborted || entry.expiresAt <= now() || entries.get(binding.connectionRef) !== entry) fail('connection_blocked');
      const token = Buffer.from(entry.token);
      try {
        const result = await work(token);
        if (containsSecret(result, [token.toString('utf8'), c.refreshToken, a.clientSecret])) fail('provider_failed');
        return result;
      } finally { token.fill(0); }
    },
  };
}
module.exports = { createGoogleSecretStore, SCOPE };

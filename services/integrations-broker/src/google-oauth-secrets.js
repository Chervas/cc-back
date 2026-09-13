'use strict';
const { createHash } = require('node:crypto'); const { fail } = require('./errors');
const { PROVIDER } = require('./google-business-profile-contract');
const { DescribeSecretCommand, GetSecretValueCommand, PutSecretValueCommand, UpdateSecretVersionStageCommand } = require('@aws-sdk/client-secrets-manager');
const digest = text => createHash('sha256').update(text).digest('hex');
const token = v => typeof v === 'string' && /^[\x21-\x7e]{1,16384}$/.test(v);
const subject = v => typeof v === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(v) && v !== 'unknown';
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
function credential(value, binding, clientId) {
  if (!exact(value, 'version,provider,connectionRef,googleUserId,clientId,refreshToken,scopes')
    || value.version !== 3 || value.provider !== PROVIDER || value.connectionRef !== binding.connectionRef
    || value.googleUserId !== binding.oauth.subject || value.clientId !== clientId || !token(value.refreshToken)
    || !Array.isArray(value.scopes) || value.scopes.length > 32 || new Set(value.scopes).size !== value.scopes.length
    || !value.scopes.every(s => typeof s === 'string' && s.length <= 256 && !/\s/.test(s))
    || binding.oauth.scopes.some(s => !value.scopes.includes(s))) fail('secret_unavailable');
  return { version: 3, provider: PROVIDER, connectionRef: binding.connectionRef, googleUserId: value.googleUserId,
    clientId, refreshToken: value.refreshToken, scopes: [...value.scopes].sort() };
}
// Only preallocated, exactly bound secrets may be written. No CreateSecret,
// delete, generic ARN/URL supplied by a caller, or credentials returned to API.
function createGoogleOAuthSecrets({ client, accountId, prefix, kmsKeyArn }) {
  if (!/^\d{12}$/.test(accountId) || !/^\/clinicaclick\/integrations\/(dev|staging|prod)\/$/.test(prefix)
    || !new RegExp(`^arn:aws:kms:eu-west-3:${accountId}:key/[a-f0-9-]+$`).test(kmsKeyArn)) fail('invalid_request');
  const arnPrefix = `arn:aws:secretsmanager:eu-west-3:${accountId}:secret:${prefix}`;
  function arn(value) {
    if (typeof value !== 'string' || !value.startsWith(arnPrefix) || value.length > 2048
      || !/^[A-Za-z0-9/_+=.@-]+$/.test(value.slice(arnPrefix.length))) fail('secret_unavailable');
    return value;
  }
  async function metadata(id, signal) {
    try {
      id = arn(id); const value = await client.send(new DescribeSecretCommand({ SecretId: id }), { abortSignal: signal });
      if (value.ARN !== id || value.KmsKeyId !== kmsKeyArn || value.DeletedDate || signal?.aborted) fail('secret_unavailable');
      return value;
    } catch { fail('secret_unavailable'); }
  }
  async function read(id, selector, signal) {
    try {
      await metadata(id, signal); const result = await client.send(new GetSecretValueCommand({ SecretId: id, ...selector }), { abortSignal: signal });
      if (result.ARN !== id || typeof result.VersionId !== 'string' || !result.VersionId || !Array.isArray(result.VersionStages)
        || selector.VersionId && result.VersionId !== selector.VersionId || selector.VersionStage && !result.VersionStages.includes(selector.VersionStage)
        || typeof result.SecretString !== 'string' || Buffer.byteLength(result.SecretString) > 32768 || signal?.aborted) fail('secret_unavailable');
      return { version: result.VersionId, stages: result.VersionStages, body: result.SecretString, value: JSON.parse(result.SecretString) };
    } catch { fail('secret_unavailable'); }
  }
  return {
    async application(binding, signal) {
      const r = await read(binding.clientSecretArn, { VersionStage: 'AWSCURRENT' }, signal); const a = r.value;
      if (!exact(a, 'version,provider,clientId,clientSecret') || a.version !== 1 || a.provider !== 'google-oauth-client'
        || !token(a.clientId) || !token(a.clientSecret) || a.clientId === a.clientSecret) fail('secret_unavailable');
      return { ...a, secretVersion: r.version };
    },
    async baseline(binding, clientId, signal) {
      const r = await read(binding.secretArn, { VersionStage: 'AWSCURRENT' }, signal);
      // v2 is accepted solely as a baseline version, never as a fallback refresh
      // token: it does not bind the Google subject and OAuth client identity.
      if (r.value.version === 2 && exact(r.value, 'version,provider,connectionRef,refreshToken,scopes')
        && r.value.provider === PROVIDER && r.value.connectionRef === binding.connectionRef && token(r.value.refreshToken)) {
        return { version: r.version, reusable: null };
      }
      return { version: r.version, reusable: credential(r.value, binding, clientId) };
    },
    encode(binding, clientId, value) {
      const body = JSON.stringify(credential(value, binding, clientId)); return { body, digest: digest(body) };
    },
    async stage(binding, version, body, signal) {
      if (!/^[a-f0-9-]{36}$/.test(version) || typeof body !== 'string' || Buffer.byteLength(body) > 32768) fail('invalid_request');
      try {
        const parsed = JSON.parse(body);
        if (JSON.stringify(credential(parsed, binding, parsed.clientId)) !== body) fail('invalid_request');
      } catch { fail('invalid_request'); }
      await metadata(binding.secretArn, signal);
      try {
        const result = await client.send(new PutSecretValueCommand({ SecretId: binding.secretArn, ClientRequestToken: version,
          SecretString: body, VersionStages: ['AWSPENDING'] }), { abortSignal: signal });
        if (result.ARN !== binding.secretArn || result.VersionId !== version || !result.VersionStages?.includes('AWSPENDING') || signal?.aborted) fail('secret_unavailable');
      } catch { fail('secret_unavailable'); }
    },
    async candidate(binding, version, expectedDigest, signal) {
      if (!/^[a-f0-9]{64}$/.test(expectedDigest)) fail('invalid_request');
      const r = await read(binding.secretArn, { VersionId: version }, signal);
      if (digest(r.body) !== expectedDigest) fail('secret_unavailable');
      return r;
    },
    async activate(binding, version, baseline, expectedDigest, signal) {
      const candidate = await this.candidate(binding, version, expectedDigest, signal);
      const current = await read(binding.secretArn, { VersionStage: 'AWSCURRENT' }, signal);
      if (current.version === version) return { version, digest: expectedDigest };
      if (current.version !== baseline || !candidate.stages.includes('AWSPENDING')) fail('secret_version_changed');
      try {
        const result = await client.send(new UpdateSecretVersionStageCommand({ SecretId: binding.secretArn, VersionStage: 'AWSCURRENT',
          MoveToVersionId: version, RemoveFromVersionId: baseline }), { abortSignal: signal });
        if (result.ARN !== binding.secretArn || signal?.aborted) fail('secret_unavailable');
      } catch { fail('secret_unavailable'); }
      // A response from UpdateSecretVersionStage alone is not a verified receipt.
      const confirmed = await read(binding.secretArn, { VersionStage: 'AWSCURRENT' }, signal);
      if (confirmed.version !== version || digest(confirmed.body) !== expectedDigest) fail('secret_version_changed');
      return { version, digest: expectedDigest };
    },
  };
}
module.exports = { createGoogleOAuthSecrets, credential, subject, token, digest };

'use strict';
const { DescribeSecretCommand, GetSecretValueCommand, PutSecretValueCommand, ListSecretVersionIdsCommand } = require('@aws-sdk/client-secrets-manager');
const { BrokerError, fail } = require('./errors'); const C = require('./meta-marketing-oauth-contract');
const { tokenText } = require('./whatsapp-secrets');
function createMetaMarketingOAuthSecrets({ client, accountId, prefix, kmsKeyArn }) {
  if (!/^\d{12}$/.test(accountId) || !/^\/clinicaclick\/integrations\/prod\/meta-marketing\/(dev|staging)\/$/.test(prefix)
    || !new RegExp(`^arn:aws:kms:eu-west-3:${accountId}:key/[a-f0-9-]+$`).test(kmsKeyArn)) fail('invalid_request');
  const base = `arn:aws:secretsmanager:eu-west-3:${accountId}:secret:${prefix}`;
  const cleanError = e => new BrokerError(e instanceof BrokerError ? new BrokerError(e.code).code : 'secret_unavailable');
  const check = signal => { if (signal?.aborted) fail('provider_timeout'); };
  function arn(value) {
    if (typeof value !== 'string' || !value.startsWith(base) || value.length > 2048 || !/^[A-Za-z0-9/_+=.@-]+$/.test(value.slice(base.length))) fail('secret_unavailable');
    return value;
  }
  async function describe(id, signal) {
    check(signal); const value = await client.send(new DescribeSecretCommand({ SecretId: arn(id) }), { abortSignal: signal }); check(signal);
    if (value.ARN !== id || value.KmsKeyId !== kmsKeyArn || value.DeletedDate || !value.VersionIdsToStages) fail('secret_unavailable');
    return value;
  }
  async function read(id, version, stage, signal) {
    const info = await describe(id, signal);
    if (stage && !info.VersionIdsToStages[version]?.includes(stage)) fail('secret_version_changed');
    const value = await client.send(new GetSecretValueCommand({ SecretId: id, VersionId: version, ...(stage ? { VersionStage: stage } : {}) }), { abortSignal: signal }); check(signal);
    const stages = value.VersionStages === undefined ? [] : value.VersionStages;
    if (value.ARN !== id || value.VersionId !== version || !Array.isArray(stages) || stage && !stages.includes(stage)
      || typeof value.SecretString !== 'string' || Buffer.byteLength(value.SecretString) > 65536) fail('secret_unavailable');
    return { ...value, VersionStages: stages };
  }
  async function slot(binding, signal) {
    const b = C.bindingFor(binding); arn(binding.clientSecretArn); const r = await read(binding.secretArn, b.slotVersionId, 'AWSCURRENT', signal);
    const v = JSON.parse(r.SecretString);
    if (!C.exact(v, 'version,provider,connectionRef,scopeKey,clinicSetDigest,appId') || v.version !== 1 || v.provider !== 'meta-marketing-oauth-slot'
      || v.connectionRef !== binding.connectionRef || v.scopeKey !== b.scopeKey || v.clinicSetDigest !== C.clinicDigest(b) || v.appId !== b.appId) fail('secret_unavailable');
    return b;
  }
  async function capacity(binding, signal) {
    const r = await client.send(new ListSecretVersionIdsCommand({ SecretId: arn(binding.secretArn), IncludeDeprecated: true, MaxResults: 100 }), { abortSignal: signal }); check(signal);
    if (r.ARN !== binding.secretArn || !Array.isArray(r.Versions) || r.NextToken || r.Versions.length >= 90) fail('rate_limited');
  }
  function envelope(binding, flow, value, token) {
    const b = C.bindingFor(binding), metadata = C.metadata(value, binding);
    if (!C.uuid(flow.id) || !/^[a-f0-9]{64}$/.test(flow.scope_digest) || flow.clinic_digest !== C.clinicDigest(b)
      || !Number.isSafeInteger(flow.expires_at) || flow.expires_at <= 0
      || !Buffer.isBuffer(token) || !tokenText(token.toString('utf8'))) fail('invalid_request');
    const v = { version: 1, provider: 'meta-marketing-oauth-candidate', flowId: flow.id, connectionRef: binding.connectionRef,
      scopeKey: b.scopeKey, scopeDigest: flow.scope_digest, clinicSetDigest: flow.clinic_digest, authorizationExpiresAt: flow.expires_at,
      ...metadata, accessToken: token.toString('utf8') };
    const body = Buffer.from(JSON.stringify(v)); if (body.length > 65536) { body.fill(0); fail('invalid_request'); }
    return { body, digest: C.hash(body), metadata };
  }
  function validateEnvelope(body, binding, flow) {
    let parsed, token;
    try {
      parsed = JSON.parse(body.toString('utf8')); token = Buffer.from(parsed.accessToken || '');
      const metadata = Object.fromEntries(['appId','subjectId','tokenType','scopes','expiresAt','dataAccessExpiresAt','granularScopes'].map(k => [k, parsed[k]]));
      const encoded = envelope(binding, flow, metadata, token);
      try { if (!body.equals(encoded.body)) fail('secret_unavailable'); return encoded.metadata; } finally { encoded.body.fill(0); }
    } finally { token?.fill(0); if (parsed && typeof parsed === 'object') delete parsed.accessToken; }
  }
  async function candidate(binding, flow, expectedDigest, signal, work) {
    const b = await slot(binding, signal);
    const app = await describe(binding.clientSecretArn, signal);
    if (!app.VersionIdsToStages[b.appVersionId]?.includes('AWSCURRENT')) fail('secret_version_changed');
    const r = await read(binding.secretArn, flow.id, null, signal);
    // AWSPENDING is a convenience label, never the candidate identity: another
    // attempt may move it. Only the immutable version, digest and flow count.
    if (r.VersionStages.includes('AWSCURRENT') || r.VersionStages.includes('AWSPREVIOUS')) fail('secret_version_changed');
    const body = Buffer.from(r.SecretString); let borrowed, abort;
    try {
      if (!/^[a-f0-9]{64}$/.test(expectedDigest) || C.hash(body) !== expectedDigest) fail('secret_unavailable');
      const metadata = validateEnvelope(body, binding, flow); let result;
      if (work) {
        const parsed = JSON.parse(body.toString('utf8')); borrowed = Buffer.from(parsed.accessToken); delete parsed.accessToken;
        abort = () => borrowed.fill(0); signal?.addEventListener('abort', abort, { once: true }); check(signal);
        result = await work(borrowed, metadata); check(signal);
        const text = JSON.stringify(result); if (typeof text !== 'string' || text.includes(borrowed.toString('utf8'))) fail('secret_unavailable');
      }
      await slot(binding, signal);
      const currentApp = await describe(binding.clientSecretArn, signal);
      if (!currentApp.VersionIdsToStages[b.appVersionId]?.includes('AWSCURRENT')) fail('secret_version_changed');
      return work ? result : { versionId: flow.id, digest: expectedDigest, metadata };
    } finally { if (abort) signal?.removeEventListener('abort', abort); borrowed?.fill(0); body.fill(0); }
  }
  async function application(binding, work, signal, checkCapacity) {
      let secret; let borrowed; let abort;
      try {
        const b = await slot(binding, signal); if (checkCapacity) await capacity(binding, signal);
        const r = await read(binding.clientSecretArn, b.appVersionId, 'AWSCURRENT', signal);
        const value = JSON.parse(r.SecretString);
        if (!C.exact(value, 'version,provider,appId,appSecret') || value.version !== 1 || value.provider !== 'meta-app'
          || value.appId !== b.appId || typeof value.appSecret !== 'string' || !/^[a-f0-9]{32}$/.test(value.appSecret)) fail('secret_unavailable');
        secret = Buffer.from(value.appSecret); borrowed = Buffer.from(secret); delete value.appSecret;
        abort = () => { secret.fill(0); borrowed.fill(0); }; signal?.addEventListener('abort', abort, { once: true }); check(signal);
        const result = await work(borrowed); check(signal);
        const info = await describe(binding.clientSecretArn, signal);
        if (!info.VersionIdsToStages[b.appVersionId]?.includes('AWSCURRENT')) fail('secret_version_changed');
        await slot(binding, signal);
        if (JSON.stringify(result)?.includes(secret.toString('utf8'))) fail('secret_unavailable'); return result;
      } catch (e) { throw cleanError(e); } finally { if (abort) signal?.removeEventListener('abort', abort); secret?.fill(0); borrowed?.fill(0); }
  }
  return {
    encode: envelope,
    withApplication: (binding, work, signal) => application(binding, work, signal, true),
    async withCandidate(binding, flow, digest, work, signal) {
      try { return await application(binding, appSecret => candidate(binding, flow, digest, signal,
        (token, metadata) => work({ token, appSecret, metadata })), signal, false); }
      catch (e) { throw cleanError(e); }
    },
    async preflight(binding, signal) {
      try { await slot(binding, signal); await capacity(binding, signal); const b = C.bindingFor(binding);
        const r = await describe(binding.clientSecretArn, signal); if (!r.VersionIdsToStages[b.appVersionId]?.includes('AWSCURRENT')) fail('secret_version_changed');
      } catch (e) { throw cleanError(e); }
    },
    async stage(binding, flow, encoded, signal) {
      let body;
      try {
        if (!Buffer.isBuffer(encoded?.body) || encoded.body.length > 65536 || C.hash(encoded.body) !== encoded.digest) fail('invalid_request');
        body = Buffer.from(encoded.body); validateEnvelope(body, binding, flow); await slot(binding, signal); await capacity(binding, signal);
        const result = await client.send(new PutSecretValueCommand({ SecretId: binding.secretArn, ClientRequestToken: flow.id,
          SecretString: body.toString('utf8'), VersionStages: ['AWSPENDING'] }), { abortSignal: signal }); check(signal);
        if (result.ARN !== binding.secretArn || result.VersionId !== flow.id || !result.VersionStages?.includes('AWSPENDING')
          || result.VersionStages.includes('AWSCURRENT')) fail('secret_unavailable');
        return await candidate(binding, flow, encoded.digest, signal);
      } catch (e) { throw cleanError(e); } finally { body?.fill(0); }
    },
    async candidate(binding, flow, digest, signal) { try { return await candidate(binding, flow, digest, signal); } catch (e) { throw cleanError(e); } },
    invalidate() {}, // No cache, alternate version, promotion, creation or deletion.
  };
}
module.exports = { createMetaMarketingOAuthSecrets };

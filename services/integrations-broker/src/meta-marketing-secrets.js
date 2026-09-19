'use strict';
const { createHmac } = require('node:crypto');
const { BrokerError, fail } = require('./errors');
const { tokenText } = require('./whatsapp-secrets');
const C = require('./meta-marketing-contract');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
function createMetaMarketingSecrets({ client, http, accountId, prefix, kmsKeyArn, now = () => Date.now() }) {
  const { DescribeSecretCommand, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  if (typeof http !== 'function' || !/^\d{12}$/.test(accountId)
    || !/^\/clinicaclick\/integrations\/prod\/meta-marketing\/(dev|staging)\/$/.test(prefix)
    || !new RegExp(`^arn:aws:kms:eu-west-3:${accountId}:key/[a-f0-9-]+$`).test(kmsKeyArn)) fail('invalid_request');
  const base = `arn:aws:secretsmanager:eu-west-3:${accountId}:secret:${prefix}`;
  const generations = new Map(), active = new Map(), capabilities = new WeakMap(); let closed = false;
  function checkArn(arn) {
    if (typeof arn !== 'string' || !arn.startsWith(base) || arn.length > 2048 || !/^[A-Za-z0-9/_+=.@-]+$/.test(arn.slice(base.length))) fail('secret_unavailable');
  }
  async function describe(arn, version, signal) {
    const value = await client.send(new DescribeSecretCommand({ SecretId: arn }), { abortSignal: signal });
    if (value.ARN !== arn || value.KmsKeyId !== kmsKeyArn || value.DeletedDate) fail('secret_unavailable');
    if (!value.VersionIdsToStages?.[version]?.includes('AWSCURRENT')) fail('secret_version_changed');
  }
  async function read(arn, version, signal) {
    await describe(arn, version, signal);
    const value = await client.send(new GetSecretValueCommand({ SecretId: arn, VersionId: version, VersionStage: 'AWSCURRENT' }), { abortSignal: signal });
    if (value.ARN !== arn || value.VersionId !== version || !value.VersionStages?.includes('AWSCURRENT')
      || typeof value.SecretString !== 'string' || Buffer.byteLength(value.SecretString) > 32768) fail('secret_unavailable');
    return JSON.parse(value.SecretString);
  }
  function invalidate(ref) {
    generations.set(ref, (generations.get(ref) || 0) + 1);
    for (const token of active.get(ref) || []) { token.fill(0); capabilities.delete(token); }
  }
  function capability(token, ref) {
    const value = capabilities.get(token);
    if (!value || value.ref !== ref) fail('secret_unavailable');
    value.check(); return value;
  }
  return {
    invalidate,
    close() { closed = true; for (const ref of active.keys()) invalidate(ref); },
    capability,
    async withSecret(binding, work, { signal } = {}) {
      let token, appSecret, applicationToken, metadata, localExpiry;
      const ref = binding.connectionRef, generation = generations.get(ref) || 0;
      const check = () => {
        if (closed || signal?.aborted || generation !== (generations.get(ref) || 0)
          || !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= now()) fail('connection_blocked');
        if ([localExpiry, metadata?.expiresAt, metadata?.dataAccessExpiresAt].some(expiry => expiry != null && expiry <= now())) fail('credential_revoked');
      };
      try {
        check(); const meta = C.bindingFor(binding);
        checkArn(binding.secretArn); checkArn(binding.clientSecretArn);
        if (binding.secretArn === binding.clientSecretArn) fail('secret_unavailable');
        const value = await read(binding.secretArn, meta.tokenVersionId, signal); check();
        const app = await read(binding.clientSecretArn, meta.appVersionId, signal); check();
        if (!exact(value, 'version,provider,connectionRef,appId,subjectId,accessToken,expiresAt,scopes')
          || value.version !== 1 || value.provider !== C.PROVIDER || value.connectionRef !== ref || value.appId !== meta.appId
          || value.subjectId !== meta.subjectId || !tokenText(value.accessToken)
          || value.expiresAt !== null && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now())
          || !Array.isArray(value.scopes) || value.scopes.length !== meta.scopes.length || new Set(value.scopes).size !== value.scopes.length
          || value.scopes.some(scope => !meta.scopes.includes(scope))
          || !exact(app, 'version,provider,appId,appSecret') || app.version !== 1 || app.provider !== 'meta-app'
          || app.appId !== meta.appId || typeof app.appSecret !== 'string' || !/^[a-f0-9]{32}$/.test(app.appSecret)) fail('secret_unavailable');
        localExpiry = value.expiresAt; token = Buffer.from(value.accessToken); appSecret = Buffer.from(app.appSecret);
        const proof = createHmac('sha256', appSecret).update(token).digest('hex');
        applicationToken = Buffer.concat([Buffer.from(meta.appId + '|'), appSecret]); appSecret.fill(0);
        const tokens = active.get(ref) || new Set(); tokens.add(token); active.set(ref, tokens);
        let inspected;
        try { inspected = await http({ action: 'inspect', id: meta.appId, token: applicationToken, candidate: token, signal }); }
        catch (error) {
          // debug_token authenticates with the application credential. A 190
          // at that boundary does not prove that the inspected user was revoked.
          if (error?.code === 'credential_revoked') fail('secret_unavailable');
          throw error;
        }
        metadata = C.verifyCredential(inspected, binding, now());
        applicationToken.fill(0); check(); capabilities.set(token, { ref, proof, metadata, check });
        const result = await work(token); check();
        const serialized = JSON.stringify(result);
        if (typeof serialized !== 'string' || [value.accessToken, app.appSecret, proof].some(secret => serialized.includes(secret))) fail('provider_failed');
        await describe(binding.secretArn, meta.tokenVersionId, signal); check();
        await describe(binding.clientSecretArn, meta.appVersionId, signal); check();
        return result;
      } catch (error) { throw error instanceof BrokerError ? error : new BrokerError('secret_unavailable'); }
      finally {
        token?.fill(0); appSecret?.fill(0); applicationToken?.fill(0); if (token) capabilities.delete(token);
        const tokens = active.get(ref); tokens?.delete(token); if (!tokens?.size) active.delete(ref);
      }
    },
  };
}
module.exports = { createMetaMarketingSecrets };

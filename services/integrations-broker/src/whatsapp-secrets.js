'use strict';
const { createHmac } = require('node:crypto');
const { BrokerError, fail } = require('./errors'); const C = require('./whatsapp-contract');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const tokenText = value => typeof value === 'string' && /^[A-Za-z0-9_.|\-]{16,16384}$/.test(value);
function createWhatsappSecrets({ client, accountId, prefix, kmsKeyArn, inspectCredential, now = () => Date.now() }) {
  const { DescribeSecretCommand, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  if (typeof inspectCredential !== 'function' || !/^\d{12}$/.test(accountId) || !/^\/clinicaclick\/integrations\/(dev|staging|prod)\/$/.test(prefix)
    || !new RegExp(`^arn:aws:kms:eu-west-3:${accountId}:key/[a-f0-9-]+$`).test(kmsKeyArn)) fail('invalid_request');
  const base = `arn:aws:secretsmanager:eu-west-3:${accountId}:secret:${prefix}`;
  const generations = new Map(); const active = new Map(); const proofs = new WeakMap(); let closed = false;
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
    for (const token of active.get(ref) || []) { token.fill(0); proofs.delete(token); }
  }
  async function withToken(binding, kind, work, { signal } = {}) {
    let token; let appSecret; let applicationToken; let remote; const ref = binding.connectionRef; const generation = generations.get(ref) || 0;
    const check = () => {
      if (closed || signal?.aborted || generation !== (generations.get(ref) || 0)) fail('connection_blocked');
      if (!Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= now()) fail('connection_blocked');
      if (remote && [remote.expiresAt, remote.dataAccessExpiresAt].some(expiry => expiry !== null && expiry <= now())) fail('credential_revoked');
    };
    try {
      check(); const meta = C.bindingFor(binding);
      const arn = kind === 'send' ? binding.secretArn : binding.templateReaderSecretArn;
      const pin = kind === 'send' ? meta.tokenVersionId : meta.readerVersionId;
      for (const value of [binding.secretArn, binding.templateReaderSecretArn, binding.clientSecretArn]) checkArn(value);
      if (new Set([binding.secretArn, binding.templateReaderSecretArn, binding.clientSecretArn]).size !== 3) fail('secret_unavailable');
      const value = await read(arn, pin, signal); check();
      const app = await read(binding.clientSecretArn, meta.appVersionId, signal); check();
      const scope = kind === 'send' ? 'whatsapp_business_messaging' : 'whatsapp_business_management';
      const provider = kind === 'send' ? C.PROVIDER : 'meta_whatsapp_template_reader';
      if (!exact(value, 'version,provider,connectionRef,appId,subjectId,wabaId,phoneId,accessToken,expiresAt,scopes')
        || value.version !== 1 || value.provider !== provider || value.connectionRef !== ref || value.appId !== meta.appId
        || value.subjectId !== (kind === 'send' ? meta.subjectId : meta.readerSubjectId) || value.wabaId !== meta.wabaId || value.phoneId !== meta.phoneId
        || !tokenText(value.accessToken) || !Array.isArray(value.scopes) || value.scopes.length !== 1 || value.scopes[0] !== scope
        || value.expiresAt !== null && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now())
        || !exact(app, 'version,provider,appId,appSecret') || app.version !== 1 || app.provider !== 'meta-app' || app.appId !== meta.appId
        || typeof app.appSecret !== 'string' || !/^[a-f0-9]{32}$/.test(app.appSecret)) fail('secret_unavailable');
      token = Buffer.from(value.accessToken); appSecret = Buffer.from(app.appSecret);
      const proof = createHmac('sha256', appSecret).update(token).digest('hex');
      applicationToken = Buffer.concat([Buffer.from(meta.appId + '|'), appSecret]); appSecret.fill(0);
      proofs.set(token, { ref, kind, proof });
      const tokens = active.get(ref) || new Set(); tokens.add(token); active.set(ref, tokens);
      try {
        remote = await inspectCredential({ candidate: token, applicationToken, signal,
          expected: { appId: meta.appId, subjectId: value.subjectId, wabaId: meta.wabaId, scopes: [scope] } });
      } finally { applicationToken.fill(0); }
      check();
      const result = await work(token); check();
      if (value.expiresAt !== null && value.expiresAt <= now()) fail('credential_revoked');
      const serialized = JSON.stringify(result);
      if (typeof serialized !== 'string' || [value.accessToken, app.appSecret].some(secret => serialized.includes(secret))) fail('provider_failed');
      // A pin changed while the request was in flight: never accept a stale
      // result or fetch a replacement credential automatically.
      await describe(arn, pin, signal); await describe(binding.clientSecretArn, meta.appVersionId, signal); check();
      return result;
    } catch (error) { throw error instanceof BrokerError ? error : new BrokerError('secret_unavailable'); }
    finally {
      token?.fill(0); appSecret?.fill(0); applicationToken?.fill(0); if (token) proofs.delete(token);
      const tokens = active.get(ref); tokens?.delete(token); if (!tokens?.size) active.delete(ref);
    }
  }
  return {
    withSecret: (binding, work, options) => withToken(binding, 'send', work, options),
    withTemplateReader: (binding, work, options) => withToken(binding, 'read', work, options),
    proof(token, ref, kind) { const value = proofs.get(token); if (!value || value.ref !== ref || value.kind !== kind) fail('secret_unavailable'); return value.proof; },
    invalidate,
    close() { closed = true; for (const ref of active.keys()) invalidate(ref); },
  };
}
module.exports = { createWhatsappSecrets, tokenText };

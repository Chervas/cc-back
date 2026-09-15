'use strict';
const { DescribeSecretCommand, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { BrokerError, fail } = require('./errors');
const { ACCOUNT, SECRET_KEY } = require('./google-main');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys;
function validateApplication(value) {
  if (!exact(value, 'appId,secretArn,versionId') || !/^[1-9][0-9]{0,29}$/.test(value.appId)
    || typeof value.secretArn !== 'string' || !value.secretArn.startsWith(`arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:/clinicaclick/integrations/prod/`)
    || !/^[A-Za-z0-9/_+=.@:-]{1,2048}$/.test(value.secretArn)
    || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.versionId)) fail('invalid_request');
  return structuredClone(value);
}
function createInboxApplicationSecret(client, input) {
  const application = validateApplication(input); let closed = false;
  if (typeof client?.send !== 'function') fail('invalid_request');
  async function describe(signal) {
    if (closed || signal.aborted) fail('secret_unavailable');
    const r = await client.send(new DescribeSecretCommand({ SecretId: application.secretArn }), { abortSignal: signal });
    if (r.ARN !== application.secretArn || r.KmsKeyId !== SECRET_KEY || r.DeletedDate
      || !r.VersionIdsToStages?.[application.versionId]?.includes('AWSCURRENT')) fail('secret_unavailable');
  }
  return {
    async withSecret(work) {
      let secret; const signal = AbortSignal.timeout(8000);
      try {
        await describe(signal);
        const r = await client.send(new GetSecretValueCommand({ SecretId: application.secretArn,
          VersionId: application.versionId, VersionStage: 'AWSCURRENT' }), { abortSignal: signal });
        if (r.ARN !== application.secretArn || r.VersionId !== application.versionId || !r.VersionStages?.includes('AWSCURRENT')
          || typeof r.SecretString !== 'string' || Buffer.byteLength(r.SecretString) > 1024) fail('secret_unavailable');
        const value = JSON.parse(r.SecretString);
        if (!exact(value, 'appId,appSecret,provider,version') || value.version !== 1 || value.provider !== 'meta-app'
          || value.appId !== application.appId || typeof value.appSecret !== 'string' || !/^[a-f0-9]{32}$/.test(value.appSecret)) fail('secret_unavailable');
        secret = Buffer.from(value.appSecret); delete value.appSecret;
        // Check the current pin immediately before handing the secret to the
        // synchronous signature/storage operation. A placeholder cannot open ingress.
        await describe(signal);
        const result = work(secret);
        if (result && typeof result.then === 'function') fail('invalid_request');
        return result;
      } catch (error) { if (error instanceof BrokerError) throw error; fail('secret_unavailable'); }
      finally { secret?.fill(0); }
    },
    close() { closed = true; },
  };
}
module.exports = { validateApplication, createInboxApplicationSecret };

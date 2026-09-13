'use strict';
const { fail } = require('./errors');
// A callback boundary private to Ads operations. Never expose this secret to a
// caller, arbitrary URL/header, environment variable, result or audit event.
function createGoogleAdsDeveloperSecret({ client, accountId, prefix, kmsKeyArn }) {
  if (!/^\d{12}$/.test(accountId) || !/^\/clinicaclick\/integrations\/(dev|staging|prod)\/$/.test(prefix)
    || !new RegExp(`^arn:aws:kms:eu-west-3:${accountId}:key/[a-f0-9-]+$`).test(kmsKeyArn)) fail('invalid_request');
  const { DescribeSecretCommand, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const arnPrefix = `arn:aws:secretsmanager:eu-west-3:${accountId}:secret:${prefix}`;
  return async function withDeveloperSecret(binding, work, { signal } = {}) {
    let token;
    try {
      const arn = binding.developerSecretArn;
      if (binding.provider !== 'google_ads' || signal?.aborted || typeof arn !== 'string' || !arn.startsWith(arnPrefix)
        || arn.length > 2048 || !/^[A-Za-z0-9/_+=.@-]+$/.test(arn.slice(arnPrefix.length))) fail('secret_unavailable');
      let metadata; let response;
      try {
        metadata = await client.send(new DescribeSecretCommand({ SecretId: arn }), { abortSignal: signal });
        if (metadata.ARN !== arn || metadata.KmsKeyId !== kmsKeyArn || metadata.DeletedDate) fail('secret_unavailable');
        response = await client.send(new GetSecretValueCommand({ SecretId: arn, VersionStage: 'AWSCURRENT' }), { abortSignal: signal });
      } catch { fail('secret_unavailable'); }
      if (signal?.aborted || response.ARN !== arn || !response.VersionId || !response.VersionStages?.includes('AWSCURRENT')
        || typeof response.SecretString !== 'string' || Buffer.byteLength(response.SecretString) > 2048) fail('secret_unavailable');
      let value; try { value = JSON.parse(response.SecretString); } catch { fail('secret_unavailable'); }
      if (!value || Object.keys(value).sort().join(',') !== 'developerToken,provider,version' || value.version !== 1
        || value.provider !== 'google-ads-developer' || typeof value.developerToken !== 'string'
        || !/^[A-Za-z0-9_-]{16,256}$/.test(value.developerToken)) fail('secret_unavailable');
      token = Buffer.from(value.developerToken);
      const result = await work(token);
      if (signal?.aborted || JSON.stringify(result).includes(value.developerToken)) fail('provider_failed');
      return result;
    } finally { token?.fill(0); }
  };
}
module.exports = { createGoogleAdsDeveloperSecret };

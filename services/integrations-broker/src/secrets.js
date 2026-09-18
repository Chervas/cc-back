'use strict';

const { fail } = require('./errors');

// Construct only inside the isolated host. No module-level AWS calls or default credential chain.
function createAwsSecretStore({ client, accountId, prefix, kmsKeyArn }) {
  const { DescribeSecretCommand, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  if (!/^\d{12}$/.test(accountId) || !/^\/clinicaclick\/integrations\/(dev|staging|prod)\/$/.test(prefix)
    || !new RegExp(`^arn:aws:kms:eu-west-3:${accountId}:key/[a-f0-9-]+$`).test(kmsKeyArn)) fail('invalid_request');
  const arnPrefix = `arn:aws:secretsmanager:eu-west-3:${accountId}:secret:${prefix}`;
  return {
    async withSecret(binding, work) {
      if (typeof binding.secretArn !== 'string' || !binding.secretArn.startsWith(arnPrefix)
        || binding.secretArn.length > 2048 || !/^[A-Za-z0-9/_+=.@-]+$/.test(binding.secretArn.slice(arnPrefix.length))) fail('secret_unavailable');
      let token;
      try {
        const metadata = await client.send(new DescribeSecretCommand({ SecretId: binding.secretArn }));
        if (metadata.ARN !== binding.secretArn || metadata.KmsKeyId !== kmsKeyArn || metadata.DeletedDate) fail('secret_unavailable');
        const result = await client.send(new GetSecretValueCommand({ SecretId: binding.secretArn, VersionStage: 'AWSCURRENT' }));
        if (result.ARN !== binding.secretArn || !result.VersionId || !result.VersionStages?.includes('AWSCURRENT')) fail('secret_unavailable');
        const value = JSON.parse(result.SecretString);
        if (value.version !== 1 || value.connectionRef !== binding.connectionRef || value.provider !== binding.provider) fail('secret_unavailable');
        if (binding.provider === 'aws_bedrock') {
          if (Object.keys(value).sort().join(',') !== 'connectionRef,credentials,provider,version') fail('secret_unavailable');
          token = Buffer.from(JSON.stringify(require('./bedrock-contract').credentials(value.credentials)));
        } else {
          if (Object.keys(value).sort().join(',') !== 'accessToken,connectionRef,provider,version'
            || typeof value.accessToken !== 'string' || !value.accessToken || value.accessToken.length > 16384) fail('secret_unavailable');
          token = Buffer.from(value.accessToken);
        }
      } catch { fail('secret_unavailable'); }
      try { return await work(token); }
      finally { token.fill(0); }
    },
    invalidate() { /* No credential cache: block/revoke is checked for every operation. */ },
  };
}
function createFictitiousSecretStore() {
  return {
    async withSecret(binding, work) {
      if (binding.provider !== 'fictitious') fail('provider_disabled');
      const token = Buffer.from('FICTITIOUS_SENTINEL_NEVER_SEND_TO_ANY_PROVIDER');
      try { return await work(token); } finally { token.fill(0); }
    },
    invalidate() {},
  };
}
module.exports = { createAwsSecretStore, createFictitiousSecretStore };

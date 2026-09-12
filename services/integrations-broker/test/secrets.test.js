'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAwsSecretStore } = require('../src/secrets');
const config = { accountId: '123456789012', prefix: '/clinicaclick/integrations/prod/',
  kmsKeyArn: 'arn:aws:kms:eu-west-3:123456789012:key/11111111-1111-4111-8111-111111111111' };
const binding = { connectionRef: 'connection:test', provider: 'meta',
  secretArn: 'arn:aws:secretsmanager:eu-west-3:123456789012:secret:/clinicaclick/integrations/prod/fixture-AbCd12' };
function mockClient(patch = {}) {
  const calls = [];
  return { calls, async send(command) {
    calls.push(command.input);
    return command.constructor.name === 'DescribeSecretCommand'
      ? { ARN: binding.secretArn, KmsKeyId: config.kmsKeyArn, ...patch.metadata }
      : { ARN: binding.secretArn, VersionId: 'fixture-version', VersionStages: ['AWSCURRENT'],
        SecretString: JSON.stringify({ version: 1, connectionRef: binding.connectionRef, provider: 'meta', accessToken: 'FICTITIOUS_ONLY' }), ...patch.value };
  } };
}
test('AWS secret adapter checks account/prefix/KMS/binding; scopes calls and clears its buffer', async () => {
  const client = mockClient(); const store = createAwsSecretStore({ ...config, client }); let observed;
  const result = await store.withSecret(binding, async bytes => { observed = bytes; assert.equal(bytes.toString(), 'FICTITIOUS_ONLY'); return 123; });
  assert.equal(result, 123); assert.equal(observed.every(value => value === 0), true);
  assert.deepEqual(client.calls, [{ SecretId: binding.secretArn }, { SecretId: binding.secretArn, VersionStage: 'AWSCURRENT' }]);
});
test('foreign ARN never reaches AWS, metadata or payload mismatches fail without exposing errors', async () => {
  const client = mockClient(); const store = createAwsSecretStore({ ...config, client });
  await assert.rejects(store.withSecret({ ...binding, secretArn: binding.secretArn.replace('123456789012', '999999999999') }, () => {}), { code: 'secret_unavailable' });
  assert.equal(client.calls.length, 0);
  for (const patch of [{ metadata: { KmsKeyId: 'foreign-key' } }, { metadata: { DeletedDate: new Date() } },
    { value: { SecretString: '{"accessToken":"SECRET","connectionRef":"foreign"}' } }, { value: { VersionStages: ['AWSPREVIOUS'] } }]) {
    await assert.rejects(createAwsSecretStore({ ...config, client: mockClient(patch) }).withSecret(binding, () => {}), { code: 'secret_unavailable' });
  }
});

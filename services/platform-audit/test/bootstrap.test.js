'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm');
const fs = require('node:fs'); const path = require('node:path'); const { createRequire } = require('node:module');
const { spawn } = require('node:child_process'); const { pack } = require('../src/event'); const { fixture } = require('./fixture.cjs');
const { WRITER_ROLE } = require('../src/batch'); const { ACCOUNT, KEY_ARN } = require('../src/s3');
const sourceRoleArn = `arn:aws:iam::${ACCOUNT}:role/fictitious-audit-source`;
const env = { PATH: '/usr/bin:/bin', TZ: 'UTC', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://169.254.169.254', AWS_EC2_METADATA_V1_DISABLED: 'true' };
test('SDK bootstrap validates source then target, uses IMDSv2 and fixed TLS endpoints without shared profiles', async () => {
  const row = pack(fixture()); const calls = []; const clients = []; let stsCount = 0; let destroyed = 0;
  const master = async () => assert.fail('fake clients never need actual credentials');
  const targetCredentials = async () => assert.fail('fake clients never need actual credentials');
  const identity = role => ({ Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${role.split('/').at(-1)}/fixture` });
  class STSClient {
    constructor(config) { this.number = stsCount++; clients.push(config); }
    async send(command, options) { assert.equal(command.constructor.name, 'GetCallerIdentityCommand'); assert(options.abortSignal);
      calls.push(this.number === 0 ? 'source_identity' : 'target_identity'); return identity(this.number === 0 ? sourceRoleArn : WRITER_ROLE); }
    destroy() { destroyed++; }
  }
  class GetCallerIdentityCommand {}
  class S3Client {
    constructor(config) { clients.push(config); }
    async send(command, options) { calls.push('put'); assert(options.abortSignal); assert.equal(command.constructor.name, 'PutObjectCommand');
      return { VersionId: 'fixture-version', SSEKMSKeyId: KEY_ARN, ServerSideEncryption: 'aws:kms', ChecksumSHA256: command.input.ChecksumSHA256 }; }
    destroy() { destroyed++; }
  }
  class NodeHttpHandler { constructor(options) { assert.equal(options.connectionTimeout, 2000); assert.equal(options.requestTimeout, 5000); assert.equal(options.throwOnRequestTimeout, true); } }
  const providers = {
    fromInstanceMetadata: options => { assert.equal(options.ec2MetadataV1Disabled, true); assert.equal(options.timeout, 1500); return master; },
    fromTemporaryCredentials: options => { calls.push('assume_writer'); assert.equal(options.masterCredentials, master);
      assert.equal(options.params.RoleArn, WRITER_ROLE); assert.equal(options.params.DurationSeconds, 900);
      assert.equal(options.clientConfig.endpoint, 'https://sts.eu-west-3.amazonaws.com'); return targetCredentials; },
  };
  const filename = path.resolve(__dirname, '../src/writer-main.js'); const localRequire = createRequire(filename); const module = { exports: {} };
  const overrides = { '@aws-sdk/credential-providers': providers, '@aws-sdk/client-sts': { STSClient, GetCallerIdentityCommand },
    '@aws-sdk/client-s3': { S3Client }, '@smithy/node-http-handler': { NodeHttpHandler } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, AbortSignal,
    process: { versions: { node: '24.21.0' }, env }, require: name => overrides[name] || localRequire(name) });
  const result = await module.exports.run({ version: 1, sourceRoleArn, records: [{ body: row.body, digest: row.digest }] });
  assert.equal(result.results[0].status, 'delivered'); assert.deepEqual(calls, ['source_identity', 'assume_writer', 'target_identity', 'put']);
  assert.equal(clients[0].credentials, master); assert.equal(clients[1].credentials, targetCredentials); assert.equal(clients[2].credentials, targetCredentials);
  assert.equal(clients[2].endpoint, 'https://s3.eu-west-3.amazonaws.com'); assert.equal(clients[2].followRegionRedirects, false);
  assert(clients.every(client => client.region === 'eu-west-3' && client.maxAttempts === 1)); assert.equal(destroyed, 3);
});
test('real guarded CLI process rejects foreign input with closed stdout before any credential provider', async () => {
  const run = input => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', path.resolve(__dirname, 'offline-guard.cjs'), path.resolve(__dirname, '../src/writer-main.js')],
      { env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
    let stdout = ''; let stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(input));
  });
  const row = pack(fixture());
  const result = await run({ version: 1, sourceRoleArn: 'arn:aws:iam::000000000000:role/SENTINEL_SECRET', records: [{ body: row.body, digest: row.digest }] });
  assert.equal(result.code, 1); assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: 'audit_configuration_invalid' });
  assert.equal(result.stderr, '');
});

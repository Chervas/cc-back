'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm');
const fs = require('node:fs'); const path = require('node:path'); const { createRequire } = require('node:module');
const { pack, keyFor } = require('../src/event');
const { randomUUID, generateKeyPairSync } = require('node:crypto'); const { Readable } = require('node:stream');
const { signRequest } = require('../src/reader-protocol'); const { fixture } = require('./fixture.cjs');
const { READER_ROLE } = require('../src/reader'); const { ACCOUNT, KEY_ARN } = require('../src/s3');
const sourceRoleArn = `arn:aws:iam::${ACCOUNT}:role/fictitious-audit-source`;
const env = { PATH: '/usr/bin:/bin', TZ: 'UTC', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://169.254.169.254', AWS_EC2_METADATA_V1_DISABLED: 'true' };
test('reader SDK bootstrap validates distinct source then reader target, uses IMDSv2, fixed TLS endpoints and only versioned Gets', async () => {
  const row = pack(fixture()); const calls = []; const clients = []; let stsCount = 0; let destroyed = 0;
  const master = async () => assert.fail('fake clients never need actual credentials');
  const targetCredentials = async () => assert.fail('fake clients never need actual credentials');
  const identity = role => ({ Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${role.split('/').at(-1)}/fixture` });
  class STSClient {
    constructor(config) { this.number = stsCount++; clients.push(config); }
    async send(command, options) { assert.equal(command.constructor.name, 'GetCallerIdentityCommand'); assert(options.abortSignal);
      calls.push(this.number === 0 ? 'source_identity' : 'target_identity'); return identity(this.number === 0 ? sourceRoleArn : READER_ROLE); }
    destroy() { destroyed++; }
  }
  class GetCallerIdentityCommand {}
  class S3Client {
    constructor(config) { clients.push(config); }
    async send(command, options) { calls.push('get'); assert(options.abortSignal); assert.equal(command.constructor.name, 'GetObjectCommand');
      assert.equal(command.input.VersionId, 'fixture-version');
      return { Body: Readable.from([row.body]), ContentLength: Buffer.byteLength(row.body), ContentType: 'application/json', VersionId: 'fixture-version', SSEKMSKeyId: KEY_ARN, ServerSideEncryption: 'aws:kms', ChecksumSHA256: Buffer.from(row.digest, 'hex').toString('base64') }; }
    destroy() { destroyed++; }
  }
  class NodeHttpHandler { constructor(options) { assert.equal(options.connectionTimeout, 1500); assert.equal(options.requestTimeout, 3000); assert.equal(options.throwOnRequestTimeout, true); } }
  const providers = {
    fromInstanceMetadata: options => { assert.equal(options.ec2MetadataV1Disabled, true); assert.equal(options.timeout, 1000); return master; },
    fromTemporaryCredentials: options => { calls.push('assume_reader'); assert.equal(options.masterCredentials, master);
      assert.equal(options.params.RoleArn, READER_ROLE); assert.equal(options.params.DurationSeconds, 900);
      assert.equal(options.clientConfig.endpoint, 'https://sts.eu-west-3.amazonaws.com'); return targetCredentials; },
  };
  const filename = path.resolve(__dirname, '../src/reader-main.js'); const localRequire = createRequire(filename); const module = { exports: {} };
  const overrides = { '@aws-sdk/credential-providers': providers, '@aws-sdk/client-sts': { STSClient, GetCallerIdentityCommand },
    '@aws-sdk/client-s3': { S3Client }, '@smithy/node-http-handler': { NodeHttpHandler } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, AbortSignal,
    process: { versions: { node: '24.21.0' }, env }, require: name => overrides[name] || localRequire(name) });
  const { privateKey } = generateKeyPairSync('ed25519');
  const input = signRequest({ mode: 'confirmed', actorId: '1', sessionRef: randomUUID(), refs: [{ key: keyFor(row), digest: row.digest, versionId: 'fixture-version' }] }, { keyId: 'fixture', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }).input;
  const settings = { readerSourceRoleArn: sourceRoleArn, writerSourceRoleArn: `arn:aws:iam::${ACCOUNT}:role/another-writer-source` };
  const result = await module.exports.awsRead(input, settings);
  assert.equal(result.results[0].status, 'verified'); assert.deepEqual(calls, ['source_identity', 'assume_reader', 'target_identity', 'get']);
  assert.equal(clients[0].credentials, master); assert.equal(clients[1].credentials, targetCredentials); assert.equal(clients[2].credentials, targetCredentials);
  assert.equal(clients[2].endpoint, 'https://s3.eu-west-3.amazonaws.com'); assert.equal(clients[2].followRegionRedirects, false);
  assert(clients.every(client => client.region === 'eu-west-3' && client.maxAttempts === 1)); assert.equal(destroyed, 3);
});
